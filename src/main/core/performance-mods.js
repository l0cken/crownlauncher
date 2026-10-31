const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const instances = require('./instances');
const modrinth = require('./modrinth');
const modCheck = require('./mod-check');

/**
 * Pakiet CrownClient: zestaw modów (optymalizacje + wygoda), który launcher dokłada do instancji Fabric
 * z Modrinth - osobno rozwiązywany dla każdej wersji Minecrafta, w najnowszych zgodnych wydaniach
 * (release, a gdy go brak - beta/alpha, dokładnie tak, jak je podaje Modrinth). Mod bez wydania dla danej
 * wersji jest pomijany.
 *
 * Renderer:
 *  - od Minecrafta 26.2 Vulkan jest w opcjach samej gry, więc tam jest Sodium (+ Sodium Extra, Iris,
 *    ImmediatelyFast);
 *  - poniżej 26.2: VulkanMod + Not Enough Vulkan, a Sodium i mody od niego zależne są usuwane - o ile VulkanMod
 *    ma wydanie dla danej wersji i komputer ma sterownik Vulkan; w pozostałych przypadkach Sodium.
 */

const PROFILE_VERSION = 3;

// Mody z pakietu. Tablica = „pierwszy, który ma wydanie dla tej wersji” (np. ModernFix ma osobne projekty).
const PACK = [
  'auto-sprint-fix',
  'badoptimizations',
  'better-render-distance',
  'c2me-fabric',
  'clumps',
  'cubes-without-borders',
  'e4mc',
  'entityculling',
  'ferrite-core',
  'gamma-utils',
  'just-zoom',
  'ksyxis',
  'lithium',
  ['modernfix-mvus', 'modernfix'],
  'modmenu',
  'moreculling',
  'noisiumforked',
  'particle-core',
  'resourcify',
  'rrls',
  'scalablelux',
  'servercore',
  'shulkerboxtooltip',
  'simple-resource-loader',
  'simple-voice-chat',
  'skyboxify',
  'sprint-after-death',
  'ukus-armor-hud',
  'vmp-fabric',
];

// Biblioteki z pakietu (większość i tak dociągają mody jako zależności).
const LIBS = [
  'fabric-api',
  'architectury-api',
  'cloth-config',
  'craterlib',
  'creativecore',
  'fabric-language-kotlin',
  'forge-config-api-port',
  'konkrete',
  'libjf',
  'midnightlib',
  'placeholder-api',
  'fzzy-config',
  'ukulib',
  'walksylib',
  'yacl',
  'malilib',
];

const OPENGL_FAMILY = ['sodium', 'sodium-extra', 'iris', 'immediatelyfast']; // OpenGL: renderer + dodatki
const VULKAN_FAMILY = ['vulkanmod', 'not-enough-vulkan'];
// mody, które znikają przy przejściu na VulkanMod (wymagają Sodium albo optymalizują OpenGL)
const OPENGL_REMOVE = [...OPENGL_FAMILY, 'reeses-sodium-options', 'sodium-options', 'indium'];

// mody z pakietu, które nie działają z VulkanMod (Fabric zgłasza „incompatible mods” i gra nie startuje)
const VULKAN_INCOMPATIBLE = ['resourcify', 'cubes-without-borders']; // Resourcify: breaks; CWB: konflikt mixina okna z VulkanMod
// pierwsza wersja Minecrafta na Javie 25 (wcześniejsze 1.21.x działają na Javie 21)
const JAVA25_FROM = '26.1';

// inne mody robiące to samo co renderer - gdy któryś jest w instancji, renderera nie zmieniamy
const FOREIGN_RENDERERS = ['rubidium', 'embeddium', 'optifine', 'canvas'];
// odpowiedniki z pakietu, które gracz mógł mieć pod inną nazwą
const ALTERNATIVES = {
  lithium: ['radium', 'canary'],
  'ferrite-core': ['ferritecore'],
};

const VULKAN_BUILTIN_FROM = '26.2'; // od tej wersji Vulkan jest w opcjach samego Minecrafta
const SUPPORTED = new Set(['fabric']);
const TIMEOUT_MS = 300_000;
const inflight = new Map(); // id instancji -> Promise

// ---- wersje i środowisko ---------------------------------------------------------------------

function versionParts(v) {
  return String(v).split('.').map((n) => parseInt(n, 10) || 0);
}

function atLeast(version, min) {
  const a = versionParts(version);
  const b = versionParts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

/** Czy komputer ma sterownik Vulkana (biblioteka ładowana przez VulkanMod). */
function vulkanAvailable() {
  try {
    if (process.platform === 'linux') {
      // loader Vulkana (libvulkan.so.1) z pakietu systemowego; sterownik (ICD) zgłasza się osobno w /usr/share/vulkan/icd.d
      const dirs = ['/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib/x86_64-linux-gnu', '/lib64', '/usr/lib/aarch64-linux-gnu', '/run/opengl-driver/lib'];
      return dirs.some((d) => fs.existsSync(path.join(d, 'libvulkan.so.1')));
    }
    if (process.platform !== 'win32') return false;
    return fs.existsSync(path.join(process.env.windir || 'C:\\Windows', 'System32', 'vulkan-1.dll'));
  } catch {
    return false;
  }
}

/** Najlepsze wydanie moda dla gry: najnowsze z kanałów w podanej kolejności preferencji. */
async function bestVersion(projectId, mcVersion, channels = ['release', 'beta', 'alpha']) {
  const list = await modrinth.listVersions(projectId, { loader: 'fabric', mcVersion, type: 'mod' });
  for (const channel of channels) {
    const hit = list.find((v) => v.type === channel);
    if (hit) return hit;
  }
  return null;
}

/** Wybór renderera dla wersji gry: 'vulkanmod' albo 'sodium'. */
function chooseRenderer({ mcVersion, setting = 'auto', vulkan = vulkanAvailable(), vulkanModBuild = false }) {
  if (setting === 'sodium') return 'sodium';
  if (atLeast(mcVersion, VULKAN_BUILTIN_FROM)) return 'sodium'; // Vulkan jest w opcjach Minecrafta
  if (!vulkan || !vulkanModBuild) return 'sodium';
  return 'vulkanmod';
}

/**
 * Czy mod z pakietu nie może być w tej konfiguracji (wykryte na prawdziwych startach gry). Zwraca powód albo ''.
 *  - Resourcify jest zadeklarowany jako niezgodny z VulkanMod, a Cubes Without Borders ma mixin okna (WindowMixin)
 *    kolidujący z VulkanMod (MixinApplyError przy starcie),
 *  - C2ME wymaga Javy 22+, a wersje 1.21.x działają na Javie 21.
 */
function excludedReason(slug, { mcVersion, vulkan }) {
  if (vulkan && VULKAN_INCOMPATIBLE.includes(slug)) return 'niezgodny z VulkanMod';
  if (slug === 'c2me-fabric' && !atLeast(mcVersion, JAVA25_FROM)) return 'wymaga Javy 22+ (ta wersja gry działa na Javie 21)';
  return '';
}
// ---- stan instancji ----------------------------------------------------------------------------

async function present(instance) {
  const index = await instances.readIndex(instance.id);
  const tokens = new Set();
  for (const [file, meta] of Object.entries(index)) {
    tokens.add(String(meta.slug || '').toLowerCase());
    tokens.add(file.toLowerCase());
  }
  try {
    for (const f of await fsp.readdir(instances.contentDir(instance.id, 'mod'))) tokens.add(f.toLowerCase());
  } catch {
    /* brak katalogu modów */
  }
  return [...tokens];
}

const hasAny = (have, alts) => alts.some((a) => have.some((t) => t.includes(a)));

async function modFiles(instance) {
  try {
    return (await fsp.readdir(instances.contentDir(instance.id, 'mod'))).filter((f) => /\.jar(\.disabled)?$/i.test(f));
  } catch {
    return [];
  }
}

/** Usuwa z instancji mody o podanych slugach (po indeksie i po nazwie pliku). Zwraca ich nazwy. */
async function removeMods(instance, slugs) {
  const index = await instances.readIndex(instance.id);
  const removed = [];
  for (const file of await modFiles(instance)) {
    const base = file.replace(/\.disabled$/i, '');
    const meta = index[base] || {};
    const slug = String(meta.slug || '').toLowerCase();
    const lower = file.toLowerCase();
    const byName = slugs.some((s) => lower.startsWith(s) || lower.startsWith(s.replace(/-/g, '')));
    if (slugs.includes(slug) || byName) {
      await instances.deleteContent(instance.id, 'mod', file);
      removed.push(meta.title || base);
    }
  }
  return removed;
}

/** Który renderer jest w instancji: 'vulkanmod' | 'sodium' | 'other' | null. */
function currentRenderer(have) {
  if (hasAny(have, ['vulkanmod'])) return 'vulkanmod';
  if (hasAny(have, ['sodium'])) return 'sodium';
  if (hasAny(have, FOREIGN_RENDERERS)) return 'other';
  return null;
}

// ---- zgodność: to, co sprawdziłby Fabric Loader przy starcie gry -----------------------------------------

const KEEP = new Set(['sodium', 'vulkanmod', 'fabric-api']); // renderer i Fabric API: przy konflikcie schodzi druga strona
const MAX_DOWNGRADES = 6;

/**
 * Sprawdza dołożone mody (wersja gry, Java, zależności z wersjami, `breaks`, moduły zagnieżdżone) i naprawia:
 * mod z problemem jest cofany do starszej, zgodnej wersji (jak najnowszej z działających), a gdy takiej nie ma
 * - usuwany. Przy konflikcie z rendererem/Fabric API schodzi druga strona. Zwraca { downgraded, removed }.
 */
async function settleCompatibility(instance, ours) {
  const dir = instances.contentDir(instance.id, 'mod');
  const env = {
    minecraft: instance.mcVersion,
    java: String(atLeast(instance.mcVersion, JAVA25_FROM) ? 25 : 21),
    fabricloader: instance.loaderVersion || '',
  };
  const downgraded = [];
  const removed = [];

  for (let round = 0; round < 5; round++) {
    const { bad, all } = await modCheck.validate(dir, [...ours], env);
    if (!bad.size) break;
    const index = await instances.readIndex(instance.id);
    const fileOfId = (id) => {
      for (const [file, info] of all) {
        if (info.id === id || info.provides.includes(id) || info.nested.some((n) => n.id === id)) return file;
      }
      return '';
    };
    const slugOf = (file) => String(index[file]?.slug || '').toLowerCase();

    // pliki do poprawienia: sam mod z problemem albo - gdy to renderer/Fabric API - druga strona konfliktu
    const targets = new Map(); // plik -> powody
    for (const [file, problems] of bad) {
      const protectedMod = KEEP.has(slugOf(file));
      for (const p of problems) {
        let target = file;
        if (protectedMod) {
          if (p.kind !== 'breaks') continue; // nie umiemy naprawić (np. wersja Fabric API) - zostawiamy
          target = fileOfId(p.other);
          if (!target || !ours.has(target)) continue;
        }
        if (!targets.has(target)) targets.set(target, []);
        targets.get(target).push(p.text);
      }
    }
    if (!targets.size) break;

    for (const [file, reasons] of targets) {
      const meta = index[file] || {};
      const title = meta.title || file;
      let fixed = false;
      let current = file; // plik, który aktualnie sprawdzamy (zmienia się przy kolejnych próbach)
      // zależności, których po prostu brakuje, lub konflikt z modem: starsza wersja nic nie zmieni - od razu usuwamy
      const tryOlder = reasons.some((t) => /wymaga .* \(jest /.test(t)) && meta.projectId;
      if (tryOlder) {
        let list = [];
        try {
          list = await modrinth.listVersions(meta.projectId, { loader: 'fabric', mcVersion: instance.mcVersion, type: 'mod' });
        } catch {
          /* bez sieci: zostaje usunięcie */
        }
        const at = list.findIndex((v) => v.id === meta.versionId);
        const older = at >= 0 ? list.slice(at + 1) : list;
        for (const cand of older.slice(0, MAX_DOWNGRADES)) {
          try {
            await modrinth.installContent({
              instanceId: instance.id,
              projectId: meta.projectId,
              versionId: cand.id,
              type: 'mod',
              title: meta.title,
              slug: meta.slug,
              icon: meta.icon,
            });
          } catch {
            continue;
          }
          const idx = await instances.readIndex(instance.id);
          const newFile = Object.entries(idx).find(([, m]) => m.projectId === meta.projectId)?.[0];
          if (!newFile) continue;
          ours.delete(current);
          ours.add(newFile);
          const check = await modCheck.validate(dir, [newFile], env);
          if (!check.bad.has(newFile)) {
            downgraded.push(`${title}: ${meta.versionNumber || '?'} → ${cand.number}`);
            fixed = true;
            break;
          }
          current = newFile; // następna próba sprząta poprzednią wersję tego projektu
        }
      }
      if (!fixed) {
        try {
          await instances.deleteContent(instance.id, 'mod', current);
        } catch {
          /* już usunięty */
        }
        ours.delete(current);
        removed.push(`${title} (${reasons[0]})`);
      }
    }
  }
  return { downgraded, removed };
}
// ---- instalacja --------------------------------------------------------------------------------

/**
 * Instaluje mod (pierwszy slug z listy, który ma wydanie dla tej wersji). Zwraca
 * { added, skipped, failed }. Brak wydania to „skipped”, a nie błąd.
 */
async function installFirst(instance, slugs, projectsBySlug, owned, ours = new Set()) {
  for (const slug of [].concat(slugs)) {
    const p = projectsBySlug[slug];
    if (!p) continue; // projekt nie istnieje / nie znaleziony
    if (owned.has(p.id)) return { present: p.title };
    let version;
    try {
      version = await bestVersion(p.id, instance.mcVersion);
    } catch (e) {
      return { failed: { title: p.title, error: e.message, network: true } };
    }
    if (!version) continue; // brak wydania dla tej wersji - próbujemy kolejny projekt z grupy
    try {
      const res = await modrinth.installContent({
        instanceId: instance.id,
        projectId: p.id,
        versionId: version.id,
        type: 'mod',
        title: p.title,
        slug: p.slug,
        icon: p.icon,
      });
      owned.add(p.id);
      for (const i of res.installed || []) if (i.file) ours.add(i.file);
      return res.already ? { present: p.title } : { added: p.title, version: version.number, type: version.type };
    } catch (e) {
      return { failed: { title: p.title, error: e.message } };
    }
  }
  return { skipped: [].concat(slugs)[0] };
}

/**
 * Stosuje pakiet dla instancji. `swapRenderer` - czy wolno zamienić Sodium <-> VulkanMod (tylko na wyraźne
 * życzenie gracza); bez tego istniejący renderer zostaje, a dokładane są tylko brakujące mody.
 */
async function apply(instance, { swapRenderer = false } = {}) {
  const added = [];
  const removed = [];
  const failed = [];
  const skipped = [];
  const ours = new Set(); // pliki dołożone w tym przebiegu (mod + zależności)
  let networkIssue = false;
  const settings = config.get();
  const mc = instance.mcVersion;

  // co już jest w instancji (po sumie SHA-1 rozpoznajemy też pliki wrzucone ręcznie)
  try {
    await modrinth.identifyInstance(instance.id);
  } catch {
    /* offline */
  }
  let have = await present(instance);
  const index = await instances.readIndex(instance.id);
  const owned = new Set(Object.values(index).map((m) => m.projectId).filter(Boolean));

  const allSlugs = [...new Set([...PACK.flat(), ...LIBS, ...OPENGL_FAMILY, ...VULKAN_FAMILY])];
  let projectsBySlug = {};
  try {
    projectsBySlug = await modrinth.projects(allSlugs);
  } catch {
    networkIssue = true;
  }

  // ---- renderer ----
  let vulkanModBuild = false;
  if (projectsBySlug.vulkanmod) {
    try {
      vulkanModBuild = Boolean(await bestVersion(projectsBySlug.vulkanmod.id, mc, ['release', 'beta']));
    } catch {
      networkIssue = true;
    }
  }
  const failedBefore = Boolean((await instances.get(instance.id).catch(() => instance)).perfVulkanFailed);
  const wanted = chooseRenderer({ mcVersion: mc, setting: failedBefore ? 'sodium' : settings.renderer || 'auto', vulkanModBuild });

  let renderer = currentRenderer(have);
  if (swapRenderer && (renderer === 'sodium' || renderer === 'vulkanmod') && renderer !== wanted) {
    removed.push(...(await removeMods(instance, renderer === 'sodium' ? [...OPENGL_REMOVE, ...VULKAN_INCOMPATIBLE] : VULKAN_FAMILY)));
    have = await present(instance);
    const idx = await instances.readIndex(instance.id);
    owned.clear();
    for (const m of Object.values(idx)) if (m.projectId) owned.add(m.projectId);
    renderer = null;
  }
  const family = [];
  if (!renderer) {
    // nowy renderer; Vulkan: VulkanMod + Not Enough Vulkan, OpenGL: Sodium + Sodium Extra + Iris + ImmediatelyFast
    family.push(...(wanted === 'vulkanmod' ? VULKAN_FAMILY : OPENGL_FAMILY));
  } else if (renderer === 'sodium') {
    family.push(...OPENGL_FAMILY);
  } else if (renderer === 'vulkanmod') {
    family.push(...VULKAN_FAMILY);
  }
  for (const slug of family) {
    const r = await installFirst(instance, slug, projectsBySlug, owned, ours);
    if (r.added) added.push(r.added);
    if (r.failed) {
      failed.push(r.failed);
      if (r.failed.network) networkIssue = true;
    }
    if (r.skipped) skipped.push(r.skipped);
  }
  // gdy Sodium (wymagany do reszty rodziny) nie zainstalował się, a miało być Sodium - nie ma sensu jechać dalej
  have = await present(instance);
  renderer = currentRenderer(have);
  const usingVulkan = renderer === 'vulkanmod';

  // ---- pakiet + biblioteki ----
  for (const entry of [...PACK, ...LIBS]) {
    const slugs = [].concat(entry);
    const blocked = slugs.map((s) => excludedReason(s, { mcVersion: mc, vulkan: usingVulkan })).find(Boolean);
    if (blocked) {
      skipped.push(`${slugs[0]} (${blocked})`);
      continue;
    }
    const alts = slugs.flatMap((s) => ALTERNATIVES[s] || []);
    if (alts.length && hasAny(have, alts)) continue;
    const r = await installFirst(instance, entry, projectsBySlug, owned, ours);
    if (r.added) added.push(r.added);
    if (r.failed) {
      failed.push(r.failed);
      if (r.failed.network) networkIssue = true;
    }
    if (r.skipped) skipped.push(r.skipped);
  }

  // zgodność: Fabric nie może się „zbuntować” przy starcie (wersja gry/Java/zależności/breaks)
  let compat = { downgraded: [], removed: [] };
  try {
    compat = await settleCompatibility(instance, ours);
  } catch {
    /* kontrola jest dodatkowa - błąd nie przerywa instalacji */
  }
  skipped.push(...compat.removed);
  for (const d of compat.downgraded) added.push(`${d} (starsza zgodna wersja)`);
  have = await present(instance);
  renderer = currentRenderer(have);

  if (!networkIssue) {
    await instances
      .update(instance.id, {
        perfModsApplied: true,
        perfProfile: PROFILE_VERSION,
        perfRenderer: usingVulkan ? 'vulkanmod' : renderer === 'other' ? 'other' : 'sodium',
      })
      .catch(() => {});
  }
  return { added, removed, failed, skipped, downgraded: compat.downgraded, renderer: renderer || 'sodium', networkIssue };
}

function run(instance, options) {
  if (!inflight.has(instance.id)) {
    const job = Promise.race([
      apply(instance, options),
      new Promise((resolve) => {
        const t = setTimeout(
          () => resolve({ added: [], removed: [], failed: [], skipped: [], renderer: null, timedOut: true }),
          TIMEOUT_MS,
        );
        t.unref?.();
      }),
    ]).finally(() => inflight.delete(instance.id));
    inflight.set(instance.id, job);
  }
  return inflight.get(instance.id);
}

/**
 * Przy starcie gry: NOWA instancja (bez zastosowanego pakietu) dostaje cały pakiet dla swojej wersji.
 * Starsze instancje, paczki i instancje z ręcznie dobranymi modami zostają nietknięte - pakiet można do nich
 * dołożyć przyciskiem „Optymalizuj” na stronie instancji. Zwraca listę dodanych. Nie rzuca.
 */
async function ensure(instance) {
  try {
    if (!config.get().optimizeMods || !SUPPORTED.has(instance.loader)) return [];
    const fresh = await instances.get(instance.id);
    if (fresh.perfProfile || fresh.perfModsApplied) return [];
    const res = await run(fresh, { swapRenderer: false });
    return res.added || [];
  } catch {
    return [];
  }
}

/** Na życzenie gracza: pełny pakiet, łącznie ze zmianą renderera. Zwraca { added, removed, failed, renderer }. */
async function optimize(instanceId) {
  const instance = await instances.get(instanceId);
  if (!SUPPORTED.has(instance.loader)) throw new Error('Optymalizacja działa tylko dla instancji Fabric.');
  const res = await run(instance, { swapRenderer: true });
  if (res.timedOut) throw new Error('Instalacja pakietu trwa zbyt długo - sprawdź połączenie i spróbuj ponownie.');
  if (res.networkIssue && !res.added.length && !res.removed.length) {
    throw new Error('Nie udało się połączyć z Modrinth - spróbuj ponownie.');
  }
  return res;
}

/**
 * Po nieudanym starcie z VulkanMod (gra zamknęła się sama zaraz po uruchomieniu): wraca do Sodium
 * i zapamiętuje, że tej instancji nie próbujemy już z Vulkanem. Zwraca true, gdy coś zmieniono.
 */
async function fallbackFromVulkan(instanceId) {
  try {
    const instance = await instances.get(instanceId);
    const have = await present(instance);
    if (!hasAny(have, ['vulkanmod'])) return false;
    await removeMods(instance, VULKAN_FAMILY);
    await instances.update(instanceId, { perfRenderer: 'sodium', perfVulkanFailed: true });
    const projects = await modrinth.projects(OPENGL_FAMILY).catch(() => ({}));
    const owned = new Set();
    for (const slug of OPENGL_FAMILY) await installFirst(instance, slug, projects, owned).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ensure,
  optimize,
  fallbackFromVulkan,
  chooseRenderer,
  excludedReason,
  vulkanAvailable,
  PROFILE_VERSION,
  PACK,
  LIBS,
  PERFORMANCE_MODS: [...PACK.flat(), ...LIBS],
};
