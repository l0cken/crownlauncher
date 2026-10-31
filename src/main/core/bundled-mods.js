const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const instances = require('./instances');

/**
 * Mody wbudowane w launcher (assets/mods + manifest.json), np. Account Switcher.
 *
 * Nie trafiają do folderu `mods` instancji: launcher rozpakowuje jar do własnego katalogu danych
 * (`<dane>/builtin-mods`) i przy starcie gry wskazuje go loaderowi (`-Dfabric.addMods` / `-Dloader.addMods`).
 * Dzięki temu mod jest zawsze aktualny z launcherem, nie da się go usunąć ani wyłączyć z poziomu instancji
 * i nie ma kopii w każdej instancji.
 */
const MOD_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'mods');
const SUPPORTED_LOADERS = new Set(['fabric']);

// ---- zgodność wersji (podzbiór składni zakresów Fabric Loadera) -----------------------------

function parseVersion(v) {
  return String(v)
    .replace(/[-+].*$/, '')
    .split('.')
    .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
}

function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function matchesOne(version, token) {
  token = token.trim();
  if (!token || token === '*') return true;
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(token);
  const op = m[1] || '=';
  // „26.1-” (końcowy myślnik = z wydaniami przedpremierowymi) i „1.21.x” sprowadzamy do samej liczby
  const ref = m[2].replace(/\.x$/i, '').replace(/[-+].*$/, '');
  const c = compare(version, ref);
  switch (op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '~':
    case '^':
      return c >= 0 && version.startsWith(ref.split('.').slice(0, 2).join('.'));
    default:
      return token.endsWith('.x') ? version === ref || version.startsWith(`${ref}.`) : c === 0;
  }
}

/** spec: "1.21.11", ">=26.1 <=26.1.2", albo tablica takich zapisów (alternatywa). */
function satisfies(version, spec) {
  const alternatives = Array.isArray(spec) ? spec : [spec];
  return alternatives.some((alt) => String(alt).split(/\s+/).filter(Boolean).every((t) => matchesOne(version, t)));
}

// ---- manifest ------------------------------------------------------------------------------------

let manifestCache = null;

async function manifest() {
  if (!manifestCache) {
    try {
      manifestCache = JSON.parse(await fsp.readFile(path.join(MOD_DIR, 'manifest.json'), 'utf8')).mods || [];
    } catch {
      manifestCache = [];
    }
  }
  return manifestCache;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const builtinDir = () => path.join(paths.root(), 'builtin-mods');

/** Wpisy manifestu pasujące do instancji (loader Fabric + wersja Minecrafta). */
async function compatible(instance) {
  if (!SUPPORTED_LOADERS.has(instance.loader)) return [];
  const entries = await manifest();
  const byId = new Map();
  for (const e of entries) {
    if (byId.has(e.id)) continue;
    if (e.loaders.includes(instance.loader) && satisfies(instance.mcVersion, e.minecraft)) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** Wskazówka dla gracza, który sam wgrał ten mod do instancji: wtedy nie dokładamy drugiej kopii. */
async function userHasOwnCopy(instance, entry) {
  const id = entry.id.toLowerCase();
  try {
    const dir = instances.contentDir(instance.id, 'mod');
    for (const f of await fsp.readdir(dir)) {
      const low = f.toLowerCase();
      if (!low.endsWith('.jar')) continue;
      // własne pliki launchera z poprzednich wersji też są sprzątane osobno (patrz cleanupLegacy)
      if (low.includes(id.replace(/-/g, '')) && !isLegacyBundledName(low, id)) return true;
      if (low.includes('account-switcher') || low.includes('account_switcher')) return true;
    }
  } catch {
    /* brak katalogu modów */
  }
  return false;
}

const isLegacyBundledName = (low, id) => new RegExp(`^${id}-\\d.*\\.jar(\\.disabled)?$`).test(low);

/**
 * Poprzednie wersje launchera kopiowały mody do `mods` instancji. Teraz ładujemy je z katalogu launchera,
 * więc stare kopie trzeba usunąć - inaczej loader zgłosi zduplikowany mod.
 *
 * `ids` to mody, które launcher nadal dokłada. Tylko je sprzątamy po samej nazwie pliku: jar wgrany przez gracza
 * (np. Account Switcher, którego launcher już nie dokłada) ma taką samą nazwę jak dawna kopia launchera,
 * a nic go nie dubluje, więc zostaje.
 */
async function cleanupLegacy(instance, ids) {
  let removed = 0;
  try {
    const dir = instances.contentDir(instance.id, 'mod');
    const index = await instances.readIndex(instance.id);
    let changed = false;
    for (const [name, meta] of Object.entries(index)) {
      if (meta.bundledId) {
        await fsp.rm(path.join(dir, name), { force: true });
        await fsp.rm(path.join(dir, `${name}.disabled`), { force: true });
        delete index[name];
        changed = true;
        removed++;
      }
    }
    if (changed) await instances.writeIndex(instance.id, index);

    // gdy indeks zaginął: pliki o nazwach nadawanych przez launcher (<id>-<wersja>.jar)
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      const low = f.toLowerCase();
      if (ids.some((id) => isLegacyBundledName(low, id))) {
        await fsp.rm(path.join(dir, f), { force: true });
        removed++;
      }
    }
  } catch {
    /* sprzątanie nie może blokować gry */
  }
  return removed;
}

/** Rozpakowuje jar do katalogu launchera (jeśli trzeba) i zwraca jego ścieżkę. */
async function materialize(entry) {
  const dest = path.join(builtinDir(), entry.file);
  if (await exists(dest)) {
    try {
      if (sha1Of(await fsp.readFile(dest)) === entry.sha1) return dest;
    } catch {
      /* zepsuty plik - nadpiszemy */
    }
  }
  const bytes = await fsp.readFile(path.join(MOD_DIR, entry.file));
  if (sha1Of(bytes) !== entry.sha1) throw new Error(`Wbudowany mod ${entry.file} jest uszkodzony.`);
  await fsp.mkdir(builtinDir(), { recursive: true });
  const tmp = `${dest}.tmp`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, dest);
  // sprzątanie starszych wersji tego samego moda
  for (const f of await fsp.readdir(builtinDir()).catch(() => [])) {
    if (f !== entry.file && f.startsWith(`${entry.id}-`) && f.endsWith('.jar')) {
      await fsp.rm(path.join(builtinDir(), f), { force: true });
    }
  }
  return dest;
}

/**
 * Przygotowuje wbudowane mody dla instancji: sprząta stare kopie z `mods` i rozpakowuje jary.
 * Zwraca listę nazw jarów, które właśnie zostały rozpakowane. Nie rzuca - brak moda nie blokuje gry.
 */
async function ensureBundledMods(instance) {
  const done = [];
  try {
    const entries = await manifest();
    // Kopie oznaczone w indeksie (bundledId, np. dawny Account Switcher) znikają zawsze; po nazwie tylko mody z manifestu.
    await cleanupLegacy(instance, [...new Set(entries.map((e) => e.id))]);
    if (!entries.length) {
      await fsp.rm(builtinDir(), { recursive: true, force: true }).catch(() => {});
      return done;
    }
    for (const entry of await compatible(instance)) {
      if (await userHasOwnCopy(instance, entry)) continue;
      const dest = path.join(builtinDir(), entry.file);
      const had = await exists(dest);
      await materialize(entry);
      if (!had) done.push(entry.file);
    }
  } catch {
    /* mod wbudowany jest dodatkiem - błąd nie może zatrzymać uruchomienia */
  }
  return done;
}

/**
 * Argumenty JVM, którymi loader dołącza wbudowane mody (poza folderem `mods`).
 * Fabric: -Dfabric.addMods (kilka ścieżek rozdziela separator systemowy).
 */
async function jvmArgs(instance) {
  try {
    const files = [];
    for (const entry of await compatible(instance)) {
      if (await userHasOwnCopy(instance, entry)) continue;
      const file = path.join(builtinDir(), entry.file);
      if (await exists(file)) files.push(file);
    }
    if (!files.length) return [];
    return [`-Dfabric.addMods=${files.join(path.delimiter)}`];
  } catch {
    return [];
  }
}

/** Czy w instancji jest już zwykły mod o tym id (np. wgrany przez gracza) - do testów i diagnostyki. */
function modIdOf(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const e = zip.getEntry('fabric.mod.json');
    return e ? JSON.parse(e.getData().toString('utf8')).id || null : null;
  } catch {
    return null;
  }
}

module.exports = { ensureBundledMods, jvmArgs, satisfies, manifest, compatible, materialize, modIdOf, builtinDir };
