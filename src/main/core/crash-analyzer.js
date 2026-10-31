const fsp = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const instances = require('./instances');
const modCheck = require('./mod-check');

/**
 * Analiza awarii: który mod (albo co innego) zabił grę.
 *
 * Źródła, od najpewniejszego:
 *  1. komunikaty Fabric Loadera o niezgodności („Mod 'X' (id) … requires … / is incompatible with …”),
 *  2. błędy mixinów („Mixin [… from mod ID] … FAILED during APPLY”, „merged by pakiet.Klasa”),
 *  3. wyjątki w punktach wejścia („provided by 'ID'”),
 *  4. raport awarii Minecrafta/Fabrica („Suspected Mods”),
 *  5. ślady stosu - pakiet klasy przypisany do jara moda,
 *  6. przyczyny spoza modów: brak pamięci, zła Java, sterownik grafiki.
 */

const MAX_LINES = 6000;
// pakiety, które nigdy nie są „winą moda” (gra, biblioteki, loader)
const NEUTRAL_PREFIX = [
  'java.', 'javax.', 'jdk.', 'sun.', 'net.minecraft.', 'com.mojang.', 'net.fabricmc.loader.', 'net.fabricmc.api.',
  'org.spongepowered.', 'io.netty.', 'org.lwjgl.', 'com.google.', 'org.apache.', 'org.slf4j.', 'it.unimi.', 'com.sun.',
];

const clean = (s) => String(s || '').replace(/<log4j:Message><!\[CDATA\[|\]\]><\/log4j:Message>/g, '').trim();

// ---- mapa pakiet -> mod ------------------------------------------------------------------------

/** Mapa pakietów klas z jarów w katalogu mods: `pakiet.kropkami` -> Set plików. */
async function packageMap(dir, files) {
  const map = new Map();
  for (const file of files) {
    let zip;
    try {
      zip = new AdmZip(path.join(dir, file));
    } catch {
      continue;
    }
    for (const e of zip.getEntries()) {
      const n = e.entryName;
      if (!n.endsWith('.class') || n.startsWith('META-INF/')) continue;
      const slash = n.lastIndexOf('/');
      if (slash < 0) continue;
      const pkg = n.slice(0, slash).replace(/\//g, '.');
      if (!map.has(pkg)) map.set(pkg, new Set());
      map.get(pkg).add(file);
    }
  }
  return map;
}

function fileForClass(className, pkgMap) {
  const base = className.replace(/^knot\/\//, '').replace(/\$.*$/, '');
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  let pkg = base.slice(0, dot);
  for (let i = 0; i < 3 && pkg; i++) {
    const hit = pkgMap.get(pkg);
    if (hit && hit.size === 1) return [...hit][0];
    if (hit && hit.size > 1) return ''; // biblioteka współdzielona - nie wiadomo, który
    const cut = pkg.lastIndexOf('.');
    if (cut < 0) break;
    pkg = pkg.slice(0, cut);
  }
  return '';
}

// ---- wykrywanie ------------------------------------------------------------------------------------

/** Dodaje podejrzanego (zachowuje najwyższy wynik i pierwszy powód). */
function bump(suspects, id, score, reason, extra = {}) {
  if (!id) return;
  const cur = suspects.get(id);
  if (!cur) {
    suspects.set(id, { id, score, reason, ...extra, kinds: new Set(extra.kind ? [extra.kind] : []) });
    return;
  }
  if (extra.kind) cur.kinds.add(extra.kind);
  if (score > cur.score) Object.assign(cur, { score, reason }, extra);
}

function parseFabricConflicts(text, suspects) {
  // „Mod 'X' (id) 1.0 requires version 22 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 21!”
  const re = /Mod '([^']+)' \(([^)]+)\) (\S+) (requires|is incompatible with|breaks)([^\n]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, name, id, version, kind, rest] = m;
    let reason;
    // rodzaj problemu (do automatycznej naprawy): java | minecraft | loader | dependency | dependency-version |
    // incompatible | requires; dep/other - o jaką zależność / jaki drugi mod chodzi
    let problem = 'incompatible';
    let dep = null;
    let other = null;
    if (kind === 'requires') {
      problem = 'requires';
      const found = /(?:version (.+?) of|any version of)\s+(?:mod\s+)?'([^']+)' \(([^)]+)\)(?:, but only the wrong version is present: ([^!\s]+)|, which is missing)?/.exec(rest);
      if (found) {
        const [, wanted, depTitle, depId, have] = found;
        const label = depId === 'java' ? 'Javy' : depId === 'minecraft' ? 'Minecrafta' : depId === 'fabricloader' ? 'Fabric Loadera' : depTitle;
        const need = wanted
          ? ` ${wanted.replace(/\s*or later$/i, ' lub nowszej').replace(/\s*or earlier$/i, ' lub starszej')}`
          : '';
        const missing = /which is missing/.test(rest);
        reason = have
          ? `wymaga ${label}${need}, a jest ${have}`
          : missing
            ? `wymaga moda ${depTitle}, którego nie ma`
            : `wymaga ${label}${need}`;
        problem = depId === 'java' ? 'java' : depId === 'minecraft' ? 'minecraft' : depId === 'fabricloader' ? 'loader' : have ? 'dependency-version' : missing ? 'dependency' : 'requires';
        // „or later”: zależność jest za stara (aktualizacja pomaga); inaczej mod chce starszej wersji
        dep = { id: depId, title: depTitle, wanted: wanted || '', have: have || '', tooOld: /or later$/i.test(wanted || '') };
      } else {
        reason = clean(`${kind} ${rest}`);
      }
    } else {
      const partner = /'([^']+)' \(([^)]+)\)/.exec(rest);
      reason = partner ? `jest niezgodny z modem ${partner[1]}` : 'jest niezgodny z innym modem';
      if (partner) other = { id: partner[2], title: partner[1] };
    }
    bump(suspects, id, 100, reason, { name, version, kind: problem, dep, other });
  }
}

function parseMixinErrors(text, suspects, pkgMap, dirFiles, infoByFile) {
  // „Mixin [cubes-without-borders.mixins.json:WindowMixin from mod cubes-without-borders] from phase [DEFAULT] … FAILED during APPLY”
  // konflikt z drugim modem: „… merged by net.vulkanmod.mixin.window.WindowMixin”
  const merged = /merged by ([\w.$]+)/.exec(text);
  const partnerFile = merged ? fileForClass(merged[1], pkgMap) : '';
  const partner = partnerFile ? infoByFile.get(partnerFile) : null;
  const re = /Mixin \[([^\]]*?) from mod ([\w.\-]+)\][^\n]*?(?:FAILED|failed)[^\n]*/g;
  let m;
  while ((m = re.exec(text))) {
    const [, mixin, id] = m;
    bump(suspects, id, 90, `jego mixin ${mixin.split(':').pop()} nie daje się zastosować${merged ? ' (konflikt z innym modem)' : ''}`, {
      kind: 'mixin',
      other: partner?.id && partner.id !== id ? { id: partner.id, title: partner.id } : null,
    });
  }
  if (partner?.id) bump(suspects, partner.id, 70, 'jego mixin koliduje z innym modem przy tym samym kodzie gry', { kind: 'mixin-conflict' });
  void dirFiles;
}

function parseEntrypoints(text, suspects) {
  // „Could not execute entrypoint stage 'main' due to errors, provided by 'sodium'!”
  const re = /due to errors, provided by '([\w.\-]+)'/g;
  let m;
  while ((m = re.exec(text))) bump(suspects, m[1], 95, 'błąd przy uruchamianiu moda (punkt wejścia)', { kind: 'entrypoint' });
}

async function parseCrashReport(text, gameDir, suspects, startedAt) {
  const file = /(?:Crash report saved to|Saved to):?\s*(?:#@!@#\s*)?(.+?crash-[^\s]+\.txt)/i.exec(text)?.[1];
  const candidates = [];
  if (file) candidates.push(file.trim());
  try {
    const dir = path.join(gameDir, 'crash-reports');
    for (const f of await fsp.readdir(dir)) {
      if (!/^crash-.*\.txt$/.test(f)) continue;
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs >= startedAt - 60_000) candidates.push(path.join(dir, f));
    }
  } catch {
    /* brak katalogu raportów */
  }
  for (const c of candidates) {
    let body;
    try {
      body = await fsp.readFile(c, 'utf8');
    } catch {
      continue;
    }
    const block = /Suspected Mods?:\s*([^\n]*(?:\n[ \t]+[^\n]+)*)/.exec(body)?.[1] || '';
    if (/^\s*None\b/.test(block)) continue;
    const entry = /([^,()\n]+?)\s*\(([\w.\-]+)\)/g;
    let m;
    while ((m = entry.exec(block))) bump(suspects, m[2], 85, 'wskazany w raporcie awarii jako podejrzany', { name: m[1].trim(), kind: 'report' });
    return c;
  }
  return '';
}

function parseStackTrace(text, suspects, pkgMap, infoByFile) {
  // pierwszy wyjątek i jego „Caused by” - klasy z ramek, które należą do jara moda
  const frames = [];
  const re = /^\s*at\s+(?:knot\/\/)?([\w.$]+)\.[\w$<>]+\(/gm;
  let m;
  while ((m = re.exec(text)) && frames.length < 400) frames.push(m[1]);
  const seen = new Map();
  for (const cls of frames) {
    if (NEUTRAL_PREFIX.some((p) => `${cls}.`.startsWith(p) || cls.startsWith(p))) continue;
    const file = fileForClass(cls, pkgMap);
    if (!file) continue;
    seen.set(file, (seen.get(file) || 0) + 1);
  }
  const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [file, count] of ranked) {
    const info = infoByFile.get(file);
    if (info?.id) bump(suspects, info.id, 40 + Math.min(count, 10), `jego kod jest w śladzie stosu błędu (${count} ramek)`, { kind: 'stack' });
  }
  // brakująca klasa moda
  const missing = /(?:ClassNotFoundException|NoClassDefFoundError):\s*([\w./$]+)/.exec(text);
  if (missing) {
    const cls = missing[1].replace(/\//g, '.');
    const file = fileForClass(cls, pkgMap);
    const info = file ? infoByFile.get(file) : null;
    if (info?.id) bump(suspects, info.id, 55, `szuka klasy ${cls}, której nie ma (zła wersja zależności?)`, { kind: 'class' });
  }
}

function nonModCause(text) {
  if (/java\.lang\.OutOfMemoryError|Out of memory|There is insufficient memory for the Java Runtime/i.test(text)) {
    return 'Za mało pamięci RAM dla gry. Zwiększ pamięć w ustawieniach instancji (np. do 6–8 GB).';
  }
  if (/UnsupportedClassVersionError|class file version \d+/i.test(text)) {
    return 'Zła wersja Javy (mod zbudowany pod nowszą Javę niż ta, na której działa gra).';
  }
  if (/GLFW error|Failed to create (?:the )?window|OpenGL|GL_INVALID|WGL|Pixel format not accelerated|vkCreate|Vulkan/i.test(text) && /(?:ERROR|FATAL|Exception)/.test(text)) {
    return 'Problem ze sterownikiem karty graficznej (OpenGL/Vulkan). Zaktualizuj sterownik albo w Ustawieniach wybierz „Zawsze Sodium”.';
  }
  return '';
}

// ---- API ----------------------------------------------------------------------------------------

/**
 * Analizuje awarię instancji. `lines` - ostatnie linie logu gry (konsola launchera).
 * Zwraca { suspects: [{ id, name, file, version, reason, score }], cause, report } - suspects posortowani od
 * najbardziej prawdopodobnego; `cause` to przyczyna spoza modów (jeśli rozpoznana).
 */
async function analyze({ instanceId, lines, startedAt = Date.now() - 10 * 60_000 }) {
  const text = lines.slice(-MAX_LINES).map(clean).join('\n');
  const modsDir = instances.contentDir(instanceId, 'mod');
  const gameDir = paths.gameDir(instanceId);

  const all = await modCheck.scanDirectory(modsDir);
  const infoByFile = new Map([...all].map(([f, i]) => [f, i]));
  const fileById = new Map();
  for (const [file, info] of all) {
    fileById.set(info.id, file);
    for (const n of info.nested) if (!fileById.has(n.id)) fileById.set(n.id, file);
    for (const p of info.provides) if (!fileById.has(p)) fileById.set(p, file);
  }
  const index = await instances.readIndex(instanceId).catch(() => ({}));
  const pkgMap = await packageMap(modsDir, [...all.keys()]);

  const suspects = new Map();
  parseFabricConflicts(text, suspects);
  parseMixinErrors(text, suspects, pkgMap, [...all.keys()], infoByFile);
  parseEntrypoints(text, suspects);
  const report = await parseCrashReport(text, gameDir, suspects, startedAt);
  parseStackTrace(text, suspects, pkgMap, infoByFile);

  const list = [];
  for (const s of suspects.values()) {
    const file = fileById.get(s.id) || '';
    // „java”, „minecraft”, „fabricloader” to nie mody do wyłączenia
    if (['java', 'minecraft', 'fabricloader', 'mixinextras'].includes(s.id)) continue;
    const withFile = (x) => (x ? { ...x, file: fileById.get(x.id) || '' } : null);
    list.push({
      id: s.id,
      name: s.name || index[file]?.title || all.get(file)?.id || s.id,
      file,
      version: s.version || all.get(file)?.version || '',
      reason: s.reason,
      score: s.score,
      // do automatycznej naprawy (crash-fixer.js): rodzaj problemu, zależność, drugi mod konfliktu
      kind: s.kind || '',
      kinds: [...s.kinds],
      dep: withFile(s.dep),
      other: withFile(s.other),
    });
  }
  list.sort((a, b) => b.score - a.score);
  return { suspects: list.slice(0, 6), cause: list.length ? '' : nonModCause(text), report };
}

/** Krótki opis dla konsoli i okna: „Sodium (sodium) — wymaga …”. */
function describe(analysis) {
  if (analysis.suspects.length) {
    const top = analysis.suspects[0];
    const rest = analysis.suspects.slice(1).map((s) => `${s.name}`).join(', ');
    return `Prawdopodobna przyczyna awarii: ${top.name} (${top.id}) — ${top.reason}.${rest ? ` Inne podejrzane: ${rest}.` : ''}`;
  }
  if (analysis.cause) return `Przyczyna awarii: ${analysis.cause}`;
  return '';
}

module.exports = { analyze, describe, nonModCause, fileForClass };
