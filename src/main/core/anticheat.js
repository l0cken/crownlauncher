const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const appConfig = require('./app-config');
const paths = require('./paths');
const { USER_AGENT, exists, hashFile } = require('./util');

/**
 * Ochrona przed cheatami po stronie launchera. Uczciwie: to warstwa, która zatrzymuje typowe sposoby
 * (instalacja hakowanego klienta jako moda, agenty Javy, dopisane argumenty JVM, wstrzyknięcie DLL w trakcie
 * gry) - NIE zastępuje antycheata po stronie serwera. Ktoś, kto zmodyfikuje sam launcher albo uruchomi grę
 * poza nim, tych zabezpieczeń nie ma, a serwer to jedyne miejsce, któremu można w pełni ufać.
 *
 * Lista blokowanych modów jest wbudowana i można ją uzupełniać bez wydawania nowej wersji launchera:
 * plik blocklist.json w repozytorium GitHub (patrz README).
 */

const GITHUB_RAW = process.env.CROWN_GITHUB_RAW || 'https://raw.githubusercontent.com';
const RULES_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_NESTED_BYTES = 40 * 1024 * 1024;

// ---- mody ------------------------------------------------------------------------------

// dokładne identyfikatory modów (fabric.mod.json / quilt.mod.json / mods.toml)
const BUILTIN_IDS = [
  'meteor-client', 'wurst', 'liquidbounce', 'aristois', 'rusherhack', 'thunderhack', 'bleachhack', 'kamiblue',
  'salhack', '3arthh4ck', 'earthhack', 'futureclient', 'impact', 'huzuni', 'konas', 'gamesense', 'phobos',
  'nodus', 'xray', 'advancedxray', 'cheatutils', 'baritone', 'autoclicker',
];

// nazwa pliku albo nazwa moda z metadanych
const BUILTIN_NAME_RE = new RegExp(
  '(?:^|[^a-z0-9])(' +
    [
      'meteor[-_. ]?client', 'wurst(?:[-_. ]?client)?', 'liquid[-_. ]?bounce', 'aristois', 'rusher[-_. ]?hack',
      'thunder[-_. ]?hack', 'bleach[-_. ]?hack', 'kami[-_. ]?blue', 'salhack', '3arthh4ck', 'future[-_. ]?client',
      'huzuni', 'konas', 'gamesense', 'cheat[-_. ]?utils', 'x-?ray', 'baritone', 'kill[-_. ]?aura', 'aimbot',
      'trigger[-_. ]?bot', 'auto[-_. ]?clicker',
    ].join('|') +
    ')(?:[^a-z0-9]|$)',
  'i',
);

// nazwa klasy albo pakietu równa dokładnie jednemu z tych słów (heurystyka dla przemianowanych klientów)
const BUILTIN_MARKERS = [
  'killaura', 'kill_aura', 'aimbot', 'triggerbot', 'autoclicker', 'crystalaura', 'autocrystal', 'clickaura',
  'antiknockback', 'antikb', 'nofall', 'bhop', 'flyhack', 'speedhack',
];

// ---- reguły (wbudowane + zdalne) -------------------------------------------------------------------

let rulesCache = null; // { at, rules }

function emptyRules() {
  return {
    ids: new Set(BUILTIN_IDS),
    nameRes: [BUILTIN_NAME_RE],
    markers: new Set(BUILTIN_MARKERS),
    sha1: new Set(),
    allowIds: new Set(),
    allowSha1: new Set(),
    allowModules: new Set(),
  };
}

const lowerList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()) : []);

function mergeRemote(rules, data) {
  if (!data || typeof data !== 'object') return rules;
  for (const id of lowerList(data.modIds)) rules.ids.add(id);
  for (const m of lowerList(data.markers)) rules.markers.add(m);
  for (const h of lowerList(data.sha1)) rules.sha1.add(h);
  for (const id of lowerList(data.allowIds)) rules.allowIds.add(id);
  for (const h of lowerList(data.allowSha1)) rules.allowSha1.add(h);
  for (const m of lowerList(data.allowModules)) rules.allowModules.add(m);
  for (const src of Array.isArray(data.namePatterns) ? data.namePatterns : []) {
    if (typeof src !== 'string' || src.length > 200) continue;
    try {
      rules.nameRes.push(new RegExp(src, 'i'));
    } catch {
      /* niepoprawny wzorzec - pomijamy */
    }
  }
  return rules;
}

async function fetchRemote() {
  // tryb własnego serwera: lista leży na serwerze (DATA_DIR/blocklist.json), a nie w repozytorium GitHub
  const server = require('./invite').builtinServer();
  if (server) {
    const res = await fetch(`${server}/blocklist.json`, {
      headers: { 'User-Agent': USER_AGENT, ...require('./invite').headersFor(server) },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 512 * 1024) throw new Error('za duży plik');
    return JSON.parse(text);
  }
  const repo = String(appConfig.GITHUB_REPO || '').trim();
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  const minute = Math.floor(Date.now() / 60_000);
  const res = await fetch(`${GITHUB_RAW}/${repo}/HEAD/blocklist.json?t=${minute}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(4000),
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 512 * 1024) throw new Error('za duży plik');
  return JSON.parse(text);
}

/** Reguły: wbudowane + blocklist.json z GitHuba (cache 6 h; brak sieci nigdy nie blokuje gry). */
async function loadRules({ force = false } = {}) {
  if (!force && rulesCache && Date.now() - rulesCache.at < 10 * 60 * 1000) return rulesCache.rules;

  const file = path.join(paths.cache(), 'blocklist.json');
  let remote = null;
  let cached = null;
  try {
    cached = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    /* brak cache */
  }
  if (cached && Date.now() - (cached.fetchedAt || 0) < RULES_TTL_MS) {
    remote = cached.data;
  } else {
    try {
      remote = await fetchRemote();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data: remote }));
    } catch {
      remote = cached?.data || null; // sieć niedostępna: ostatnia znana lista albo same reguły wbudowane
    }
  }
  const rules = mergeRemote(emptyRules(), remote);
  rulesCache = { at: Date.now(), rules };
  return rules;
}

function resetRulesCache() {
  rulesCache = null;
}

// ---- skan jara -------------------------------------------------------------------------------

function parseMeta(zip) {
  const ids = [];
  const names = [];
  const read = (n) => {
    const e = zip.getEntry(n);
    return e && e.header.size < 1024 * 1024 ? e.getData().toString('utf8') : null;
  };
  for (const n of ['fabric.mod.json', 'quilt.mod.json']) {
    const text = read(n);
    if (!text) continue;
    try {
      const j = JSON.parse(text.replace(/^﻿/, ''));
      const q = j.quilt_loader || {};
      for (const v of [j.id, q.id]) if (typeof v === 'string') ids.push(v);
      for (const p of [...(j.provides || []), ...(q.provides || [])]) {
        const id = typeof p === 'string' ? p : p?.id;
        if (typeof id === 'string') ids.push(id);
      }
      for (const v of [j.name, q.metadata?.name]) if (typeof v === 'string') names.push(v);
    } catch {
      /* uszkodzone metadane - zostają heurystyki */
    }
  }
  for (const n of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const text = read(n);
    if (!text) continue;
    for (const m of text.matchAll(/modId\s*=\s*["']([^"']+)["']/g)) ids.push(m[1]);
    for (const m of text.matchAll(/displayName\s*=\s*["']([^"']+)["']/g)) names.push(m[1]);
  }
  const info = read('mcmod.info');
  if (info) {
    try {
      const j = JSON.parse(info);
      for (const m of Array.isArray(j) ? j : j.modList || []) {
        if (typeof m.modid === 'string') ids.push(m.modid);
        if (typeof m.name === 'string') names.push(m.name);
      }
    } catch {
      /* ignoruj */
    }
  }
  return { ids: ids.map((s) => s.toLowerCase()), names };
}

function inspectZip(zip, rules, depth = 0) {
  const reasons = [];
  const { ids, names } = parseMeta(zip);

  const allowed = ids.some((id) => rules.allowIds.has(id));
  if (!allowed) {
    for (const id of ids) if (rules.ids.has(id)) reasons.push(`znany cheat (id moda: ${id})`);
    for (const n of names) if (rules.nameRes.some((re) => re.test(n))) reasons.push(`znany cheat (nazwa: ${n})`);
  }

  let marker = '';
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (name.endsWith('.class')) {
      if (marker || allowed) continue;
      for (const seg of name.slice(0, -6).split('/')) {
        const s = seg.split('$')[0].toLowerCase();
        if (rules.markers.has(s)) {
          marker = name;
          break;
        }
      }
    } else if (depth === 0 && /^META-INF\/jars\/.+\.jar$/i.test(name) && e.header.size < MAX_NESTED_BYTES) {
      try {
        const nested = inspectZip(new AdmZip(e.getData()), rules, 1);
        for (const r of nested) reasons.push(`w dołączonym ${path.posix.basename(name)}: ${r}`);
      } catch {
        /* uszkodzony zagnieżdżony jar - pomijamy */
      }
    }
  }
  if (marker) reasons.push(`klasa typowa dla cheatów: ${marker}`);
  return reasons;
}

/** Zwraca listę powodów, dla których jar jest niedozwolony (pusta = w porządku). */
async function inspectFile(file, rules) {
  const reasons = [];
  const base = path.basename(file).replace(/\.disabled$/i, '');
  const sha = rules.sha1.size || rules.allowSha1.size ? await hashFile(file, 'sha1') : '';
  if (sha && rules.allowSha1.has(sha)) return reasons;

  let zip = null;
  try {
    zip = new AdmZip(file);
  } catch {
    /* nie jest poprawnym zipem - gra i tak go nie wczyta */
  }
  // wyjątek z listy (np. fałszywy alarm) zwalnia z wszystkich dopasowań, także po nazwie pliku
  if (zip && parseMeta(zip).ids.some((id) => rules.allowIds.has(id))) return reasons;

  if (sha && rules.sha1.has(sha)) reasons.push('plik z listy zablokowanych (suma SHA-1)');
  if (rules.nameRes.some((re) => re.test(base))) reasons.push(`nazwa pliku wskazuje na cheat (${base})`);
  if (zip) reasons.push(...inspectZip(zip, rules));
  return [...new Set(reasons)];
}

async function listJars(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /\.jar$/i.test(e.name)) out.push(full);
    // Fabric ładuje też mody z podkatalogów wersji (mods/1.21.11/)
    else if (e.isDirectory()) {
      try {
        for (const s of await fsp.readdir(full, { withFileTypes: true })) {
          if (s.isFile() && /\.jar$/i.test(s.name)) out.push(path.join(full, s.name));
        }
      } catch {
        /* ignoruj */
      }
    }
  }
  return out;
}

/** Skanuje katalog modów; wyniki dla niezmienionych plików są pamiętane. */
const fileCache = new Map(); // klucz: ścieżka|rozmiar|mtime|wersja reguł -> powody
async function scanDir(dir, rules) {
  const findings = [];
  for (const file of await listJars(dir)) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    const key = `${file}|${st.size}|${st.mtimeMs}|${rulesCache?.at || 0}`;
    let reasons = fileCache.get(key);
    if (!reasons) {
      reasons = await inspectFile(file, rules);
      fileCache.set(key, reasons);
    }
    if (reasons.length) findings.push({ file, name: path.basename(file), reasons });
  }
  return findings;
}

async function scanInstance(instanceId) {
  const instances = require('./instances');
  const rules = await loadRules();
  return scanDir(instances.contentDir(instanceId, 'mod'), rules);
}

function describe(findings) {
  return findings.map((f) => `• ${f.name} — ${f.reasons[0]}`).join('\n');
}

/** Rzuca błąd z listą plików, jeśli w instancji są niedozwolone mody. */
async function assertInstanceClean(instanceId) {
  const findings = await scanInstance(instanceId);
  if (findings.length) {
    throw new Error(
      `Wykryto niedozwolone mody (cheaty). Usuń je z instancji, aby uruchomić grę:\n${describe(findings)}`,
    );
  }
}

// ---- JVM: agenty, atach, classpath ----------------------------------------------------------------

// flagi, które wyłączają możliwość podpięcia się pod uruchomioną grę
const HARDENING_FLAGS = [
  '-XX:+IgnoreUnrecognizedVMOptions',
  '-XX:+DisableAttachMechanism', // brak dynamicznego "attach" (jattach, narzędzia typu Java injector)
  '-XX:-EnableDynamicAgentLoading', // brak ładowania agentów w trakcie działania
  '-Djdk.attach.allowAttachSelf=false',
  // bez hsperfdata: jps/jstat/VisualVM z innego procesu czytają stamtąd pełną linię poleceń gry (z tokenem)
  '-XX:-UsePerfData',
];

const DENY_FLAG = [
  /^-javaagent(?::|$)/i,
  /^-agentlib(?::|$)/i,
  /^-agentpath(?::|$)/i,
  /^-Xrun/i,
  /^-Xdebug$/i,
  /^-Xnoagent$/i,
  /^-Xbootclasspath/i,
  /^-XX:\+EnableDynamicAgentLoading/i,
  /^-XX:-DisableAttachMechanism/i,
  /^-XX:\+?AllowAttachSelf/i,
  /^-Djdk\.attach\.allowAttachSelf/i,
  /^-Djava\.system\.class\.loader/i,
  /^-Djava\.library\.path/i,
  /^-Dfabric\.addMods/i,
  /^-Dfabric\.gameJarPath/i,
  /^-Dfabric\.classPathGroups/i,
  // zdalne zarządzanie (JMX) i dane perf pozwalają innym procesom czytać właściwości JVM, w tym token w argumentach
  /^-Dcom\.sun\.management\./i,
  /^-XX:\+UsePerfData/i,
  /^-XX:-PerfDisableSharedMem/i,
  /^-XX:\+PerfDataSaveToFile/i,
  // zrzut sterty to cała pamięć gry na dysku - razem z tokenem
  /^-XX:\+HeapDumpOn/i,
  /^-XX:HeapDumpPath/i,
  /^--patch-module=/i,
  /^--upgrade-module-path=/i,
  /^--class-path=/i,
  /^--module-path=/i,
];
// flagi z osobnym argumentem: usuwamy też następny element
const DENY_WITH_VALUE = /^(?:-cp|-classpath|--class-path|--patch-module|--upgrade-module-path|-p|--module-path)$/i;

/** Usuwa z argumentów JVM podanych przez gracza wszystko, co służy do wstrzykiwania kodu. */
function sanitizeJvmArgs(tokens) {
  const args = [];
  const removed = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i]);
    if (DENY_WITH_VALUE.test(t)) {
      removed.push([t, tokens[i + 1]].filter(Boolean).join(' '));
      i += 1;
    } else if (DENY_FLAG.some((re) => re.test(t))) {
      removed.push(t);
    } else {
      args.push(t);
    }
  }
  return { args, removed };
}

// zmienne środowiskowe, którymi Java ładuje agenty/opcje bez wiedzy launchera
// (Linux: LD_PRELOAD i LD_AUDIT ładują bibliotekę do każdego procesu potomnego - to klasyczne wstrzyknięcie bez żadnego uchwytu)
const DENY_ENV = ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS', 'CLASSPATH', 'LD_PRELOAD', 'LD_AUDIT'];

// Zmienne ustawiane przez AppImage (AppRun): wskazują na zamontowany obraz launchera, a nie na środowisko gry. Zmienne ścieżek
// czyścimy tylko z wpisów z katalogu obrazu - reszta (PATH, XDG_DATA_DIRS…) musi zostać taka, jak ją ustawił użytkownik.
const APPIMAGE_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'];
const APPIMAGE_PATH_VARS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

// Zmienne z sekretami użytkownika (tokeny CI i GitHuba, klucze API i chmur, hasła, agent SSH). Gra i jej mody
// dziedziczą środowisko launchera, a Minecraft żadnej z nich nie potrzebuje - mod z internetu nie ma ich czytać.
const SECRET_ENV_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH)(?:_|$)|^(?:GH|GITHUB|GITLAB|NPM|AWS|AZURE|GOOGLE|ANTHROPIC|OPENAI|CLAUDE|DOCKER|KUBE)_/i;

function scrubEnv(env = process.env, platform = process.platform) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (DENY_ENV.includes(key.toUpperCase()) || SECRET_ENV_RE.test(key)) delete out[key];
  }
  if (platform === 'linux' && out.APPDIR) {
    // gra uruchomiona z AppImage dziedziczyłaby biblioteki i ścieżki obrazu launchera (Java ładowałaby cudze libGL, libstdc++…)
    const posix = path.posix;
    const appDir = posix.resolve('/', out.APPDIR);
    for (const key of APPIMAGE_PATH_VARS) {
      if (!out[key]) continue;
      const kept = out[key]
        .split(':')
        .filter((p) => p && posix.resolve('/', p) !== appDir && !posix.resolve('/', p).startsWith(appDir + '/'));
      if (kept.length) out[key] = kept.join(':');
      else delete out[key];
    }
    for (const key of APPIMAGE_VARS) delete out[key];
  }
  return out;
}

// ---- wstrzykiwanie bibliotek DLL do procesu gry (Windows) --------------------------------------------

/**
 * Katalogi, z których nowa biblioteka nie budzi podejrzeń: system, Program Files, środowisko Javy i (podane przez wołającego)
 * katalog natywnych bibliotek instancji. Celowo NIE ma tu ProgramData ani całego folderu danych launchera - użytkownik (a więc
 * i cheat) może tam pisać, więc położenie niczego nie dowodzi; tam liczy się podpis cyfrowy.
 */
// Linux: katalogi systemowe, do których zwykły użytkownik nie może pisać (pakiety dystrybucji, sterowniki GPU, Nix, Flatpak, Snap)
const LINUX_TRUSTED = ['/usr', '/lib', '/lib32', '/lib64', '/opt', '/nix/store', '/run/opengl-driver', '/run/opengl-driver-32', '/snap', '/app', '/var/lib/flatpak'];

function trustedRoots(javaPath, extra = [], platform = process.platform) {
  const env = process.env;
  const linux = platform === 'linux';
  const api = linux ? path.posix : path;
  const roots = linux
    ? [...LINUX_TRUSTED, ...extra]
    : [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, ...extra];
  if (javaPath) roots.push(api.dirname(api.dirname(javaPath)));
  return roots.filter(Boolean).map((r) => api.resolve(r).toLowerCase() + api.sep);
}

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) =>
      resolve(err ? '' : String(stdout)),
    );
  });

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * Linux: kod załadowany do procesu = pliki zmapowane z prawem wykonania (/proc/<pid>/maps). Nie patrzymy na rozszerzenie
 * (.so), bo wstrzyknięta biblioteka może nazywać się dowolnie - liczy się, że system mapuje ją jako kod.
 * Kod JIT-a Javy jest anonimowy (bez pliku), więc tu nie trafia.
 */
function parseMaps(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    const m = /^\S+\s+(\S{4})\s+\S+\s+\S+\s+(\d+)\s+(\/.+?)(?: \(deleted\))?$/.exec(line);
    if (!m || m[2] === '0' || !m[1].includes('x')) continue;
    out.add(m[3]);
  }
  return [...out];
}

/** Pełne ścieżki bibliotek załadowanych w procesie. Pusta lista = nie udało się odczytać. */
async function modulesOf(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (platform === 'linux') {
    try {
      return parseMaps(await fsp.readFile(`/proc/${pid}/maps`, 'utf8'));
    } catch {
      return [];
    }
  }
  if (platform !== 'win32') return [];
  const script = `$ErrorActionPreference='SilentlyContinue'; (Get-Process -Id ${pid}).Modules | ForEach-Object { $_.FileName }`;
  return (await run('powershell.exe', [...PS, script])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Linux nie ma podpisów cyfrowych bibliotek. Najbliższy odpowiednik „zaufanego wydawcy”: plik należy do roota i nie jest
 * zapisywalny dla grupy ani innych - czyli dostarczył go administrator systemu (pakiet), a nie użytkownik albo program
 * uruchomiony przez użytkownika.
 */
async function rootOwnedModules(files) {
  const ok = new Set();
  await Promise.all(
    files.map(async (f) => {
      try {
        const st = await fsp.stat(f);
        if (st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0) ok.add(f.toLowerCase());
      } catch {
        /* plik zniknął albo brak dostępu - nie jest zaufany */
      }
    }),
  );
  return ok;
}

/** Zwraca zbiór ścieżek z prawidłowym, zaufanym podpisem cyfrowym (Linux: z plikami należącymi do roota). */
async function signedModules(files, platform = process.platform) {
  if (platform === 'linux') return files.length ? rootOwnedModules(files) : new Set();
  if (platform !== 'win32' || !files.length) return new Set();
  const script =
    "$ErrorActionPreference='SilentlyContinue'; $p = $env:CROWN_PATHS | ConvertFrom-Json; " +
    'foreach ($f in $p) { $s = Get-AuthenticodeSignature -LiteralPath $f; "$($s.Status)`t$f" }';
  const out = await run('powershell.exe', [...PS, script], { env: { ...process.env, CROWN_PATHS: JSON.stringify(files) } });
  const ok = new Set();
  for (const line of out.split(/\r?\n/)) {
    const [status, ...rest] = line.split('\t');
    if (status === 'Valid' && rest.length) ok.add(rest.join('\t').toLowerCase());
  }
  return ok;
}

// (Linux: LWJGL rozpakowuje się do /tmp/lwjgl_<użytkownik>/…, JNA do /tmp/jna-…/jna….tmp, Netty i sqlite-jdbc wprost do /tmp jako lib….so)
const TEMP_NATIVE_RE =
  /[\\/](?:lwjgl_[^\\/]+|jna[^\\/]*|[^\\/]*netty[^\\/]*|sqlite-[^\\/]+|\.?jffi[^\\/]*)[\\/]|[\\/]jna\d+\.dll$|[\\/]lib[^\\/]*netty[^\\/]*\.so$|[\\/]sqlite-[^\\/]*\.so$/i;
// natywne biblioteki znanych modów, rozpakowywane do Temp pod stałym, dokładnym wzorem: imgui-java (Flashback/Axiom Moulberry'ego)
// i Simple Voice Chat (opus/lame/rnnoise/speex, katalog z sumą MD5). Dopasowanie obejmuje nazwę pliku, nie samego katalogu.
// Windows: .dll; Linux: lib….so
const TEMP_MOD_NATIVE_RE =
  /[\\/]imgui-java-natives[\\/][\d.]+[\\/](?:lib)?imgui-[\w-]*java64\.(?:dll|so)$|[\\/]lib(?:lame|opus|rnnoise|speex)4j-[0-9a-f]{32}[\\/]lib(?:lame|opus|rnnoise|speex)4j\.(?:dll|so)$/i;

/**
 * Ocenia nowe moduły. Zwraca { kill: [...], warn: [...] }:
 *  - kill: niepodpisana biblioteka spoza zaufanych katalogów i poza folderem tymczasowym,
 *  - warn: taka sama, ale leży w folderze tymczasowym (tam Java rozpakowuje własne natywne biblioteki).
 */
async function classifyModules(
  newModules,
  { javaPath, signed = signedModules, rules, trustedDirs = [], platform = process.platform, tmpDir = os.tmpdir() } = {},
) {
  const api = platform === 'linux' ? path.posix : path;
  const roots = trustedRoots(javaPath, trustedDirs, platform);
  const tmp = api.resolve(tmpDir).toLowerCase() + api.sep;
  const candidates = newModules.filter((m) => {
    const low = api.resolve(m).toLowerCase();
    if (rules?.allowModules?.has(api.basename(low))) return false;
    return !roots.some((r) => low.startsWith(r));
  });
  if (!candidates.length) return { kill: [], warn: [] };

  const trusted = await signed(candidates);
  const kill = [];
  const warn = [];
  for (const m of candidates) {
    const low = api.resolve(m).toLowerCase();
    if (trusted.has(low) || trusted.has(m.toLowerCase())) continue;
    // Linux: kod zmapowany z pliku w pamięci (memfd) nie ma ścieżki na dysku - może być legalny (sterowniki), więc tylko ostrzegamy
    if (platform === 'linux' && /^\/memfd:/.test(m)) {
      warn.push(m);
      continue;
    }
    if (low.startsWith(tmp) || (platform === 'linux' && /^\/(?:tmp|var\/tmp|dev\/shm)\//.test(low))) {
      if (!TEMP_NATIVE_RE.test(m) && !TEMP_MOD_NATIVE_RE.test(m)) warn.push(m);
    } else {
      kill.push(m);
    }
  }
  return { kill, warn };
}

/** Czy w `now` jest nazwa (lub kolejna kopia nazwy), której nie było w `before`. */
function hasNewName(now, before) {
  const count = new Map();
  for (const n of before) count.set(n, (count.get(n) || 0) + 1);
  for (const n of now) {
    const left = count.get(n) || 0;
    if (left === 0) return true;
    count.set(n, left - 1);
  }
  return false;
}

/**
 * Nadzór bibliotek procesu gry. Pierwszy przegląd (po `firstDelayMs`) ocenia WSZYSTKIE załadowane biblioteki - wstrzyknięcie
 * tuż po starcie nie może trafić do „stanu wyjściowego”. Potem co `fastMs` czyta tanio same nazwy bibliotek (`getNames`) i
 * przy każdej NOWEJ robi od razu pełny przegląd (ścieżki + podpisy); pełny przegląd odbywa się też co `intervalMs`. Dzięki temu
 * biblioteka wstrzyknięta hakiem okna (SetWindowsHookEx celowanym w wątek gry - jedyna droga, której nie zamyka dostęp do
 * procesu) kończy grę po sekundzie-dwóch, a nie po pół minuty. Źródłem nazw i ścieżek jest pomocnik natywnego startu
 * (child.getNames / child.getModules - ma pełny uchwyt do gry mimo zablokowanego dostępu, którego nie przejdzie np. tasklist);
 * bez niego (start zapasowy) działa tylko przegląd co `intervalMs`. Niepodpisana biblioteka spoza zaufanych miejsc = próba
 * wstrzyknięcia. To druga linia obrony: pierwszą jest zamknięty dostęp do procesu (native-spawn.js / hardenProcess).
 */
function watchProcess({
  pid,
  javaPath,
  onViolation,
  trustedDirs = [],
  intervalMs = 20_000,
  firstDelayMs = 15_000,
  fastMs = 1_000,
  getModules = modulesOf,
  // bez źródła nazw zostaje przegląd co intervalMs; Linux: odczyt /proc/<pid>/maps jest tani (bez uruchamiania procesów), więc
  // nazwy pochodzą z niego i nowa biblioteka trafia do przeglądu od razu
  getNames = process.platform === 'linux' ? async (p) => (await modulesOf(p)).map((m) => path.posix.basename(m)) : async () => [],
  signed = signedModules,
}) {
  let baseline = null;
  let stopped = false;
  let timer = null;
  let busy = false;
  let lastCheck = 0;
  let knownNames = [];
  const seen = new Set();

  async function check() {
    const names = await getNames(pid).catch(() => []); // zrzut PRZED przeglądem: co załaduje się w trakcie, wyjdzie przy następnym
    const mods = await getModules(pid);
    if (!mods.length) return;
    const rules = await loadRules().catch(() => null);
    lastCheck = Date.now();
    knownNames = names;
    if (!baseline) {
      baseline = new Set(mods.map((m) => m.toLowerCase()));
      // do pierwszego przeglądu natywne biblioteki gry i sterowniki już się załadowały; ostrzeżeń (warn) nie zgłaszamy,
      // bo tu są też legalne biblioteki z folderu tymczasowego (głos, imgui), ale niepodpisany obcy plik kończy grę
      const { kill } = await classifyModules(mods, { javaPath, signed, rules, trustedDirs });
      if (kill.length && !stopped) onViolation({ kill, warn: [] });
      return;
    }
    const fresh = mods.filter((m) => !baseline.has(m.toLowerCase()) && !seen.has(m.toLowerCase()));
    for (const m of fresh) seen.add(m.toLowerCase());
    if (fresh.length) {
      const { kill, warn } = await classifyModules(fresh, { javaPath, signed, rules, trustedDirs });
      if ((kill.length || warn.length) && !stopped) onViolation({ kill, warn });
    }
  }

  async function loop() {
    if (stopped) return;
    if (!busy) {
      busy = true;
      try {
        let due = Date.now() - lastCheck >= intervalMs;
        if (!due && baseline) {
          const names = await getNames(pid).catch(() => []);
          due = names.length > 0 && hasNewName(names, knownNames);
        }
        if (due && !stopped) await check();
      } catch {
        /* nadzór nie może zatrzymać gry */
      } finally {
        busy = false;
      }
    }
    if (!stopped) {
      timer = setTimeout(loop, fastMs);
      timer.unref?.();
    }
  }

  timer = setTimeout(loop, firstDelayMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// ---- blokada wstrzykiwania: prawa dostępu do procesu gry (Windows) -----------------------------------------

/*
 * Każde wstrzyknięcie kodu z zewnątrz (CreateRemoteThread + LoadLibrary, ręczne mapowanie DLL, przejęcie wątku, APC,
 * podpięcie debuggera, edytor pamięci piszący do gry) zaczyna się od OpenProcess z prawem do tworzenia wątku, zapisu pamięci
 * albo duplikowania uchwytów. Proces gry dostaje więc DACL, który tych praw nie daje NIKOMU - ani temu samemu użytkownikowi,
 * ani administratorowi, ani SYSTEM-owi - bez względu na to, jaki to program i co wstrzykuje (cheat, nakładka, nagrywarka).
 * Zostają: zapytanie o proces, odczyt pamięci, zakończenie i oczekiwanie (Menedżer zadań, nadzór launchera, kill).
 * Prawo WRITE_DAC jest odebrane razem z niejawnymi prawami właściciela (ACE „OWNER RIGHTS”), więc injector nie cofnie blokady.
 *
 * Granice (uczciwie): proces z przywilejem SeDebugPrivilege (administrator uruchamiający injector „jako administrator”, sterownik
 * jądra) omija każdy DACL; blokada wchodzi ~0,5 s po starcie procesu (do tego czasu gra nie ma jeszcze okna). Instalowanie
 * haków systemowych (SetWindowsHookEx) nie wymaga uchwytu do procesu - tę drogę łapie nadzór bibliotek (watchProcess).
 */
const PROC_DENY_MASK = '0xc08ea'; // CREATE_THREAD | VM_OPERATION | VM_WRITE | DUP_HANDLE | CREATE_PROCESS | SUSPEND_RESUME | WRITE_DAC | WRITE_OWNER

const HARDEN_CS =
  'using System; using System.Runtime.InteropServices; public static class CrownProc { ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid); ' +
  '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); ' +
  '[DllImport("advapi32.dll", SetLastError=true)] public static extern bool SetKernelObjectSecurity(IntPtr h, uint info, byte[] sd); }';

const HARDEN_PS =
  "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:CROWN_CS; " +
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
  `$sddl = "D:P(D;;${PROC_DENY_MASK};;;WD)(A;;RC;;;OW)(A;;0x1fffff;;;$sid)(A;;0x1fffff;;;SY)(A;;0x1fffff;;;BA)"; ` +
  '$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl); ' +
  '$bin = New-Object byte[] $sd.BinaryLength; $sd.GetBinaryForm($bin, 0); ' +
  '$h = [CrownProc]::OpenProcess(0x60000, $false, [uint32]$env:CROWN_PID); ' + // READ_CONTROL | WRITE_DAC
  'if ($h -eq [IntPtr]::Zero) { "ERR OpenProcess " + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit 3 } ' +
  'if (-not [CrownProc]::SetKernelObjectSecurity($h, 4, $bin)) { "ERR SetKernelObjectSecurity " + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit 4 } ' +
  '[CrownProc]::CloseHandle($h) | Out-Null; "OK"';

function hardenOnce(pid) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [...PS, HARDEN_PS],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, CROWN_CS: HARDEN_CS, CROWN_PID: String(pid) } },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!err && /^OK\b/.test(out)) return resolve({ ok: true });
        resolve({ ok: false, message: (out || String(stderr || err?.message || '').trim() || 'nieznany błąd').split(/\r?\n/)[0].slice(0, 200) });
      },
    );
  });
}

/**
 * Zamyka dostęp do procesu gry (patrz wyżej). Nigdy nie rzuca: { ok: true } albo { ok: false, message } (nie Windows: skipped).
 * Wołać zaraz po starcie procesu - im wcześniej, tym mniejszy wyścig z injectorem uruchamianym automatycznie.
 */
async function hardenProcess(pid) {
  if (process.platform !== 'win32') return { ok: false, skipped: true }; // Linux: patrz linuxPtraceNote
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: 'brak identyfikatora procesu' };
  let res = await hardenOnce(pid);
  if (!res.ok) res = await hardenOnce(pid); // jedna powtórka (np. chwilowe obciążenie przy starcie gry)
  return res;
}

/**
 * Linux: dostęp do pamięci cudzego procesu (ptrace, /proc/<pid>/mem) ogranicza moduł Yama. `ptrace_scope=0` pozwala KAŻDEMU
 * procesowi tego samego użytkownika wstrzyknąć kod do gry, a launcher nie ma jak tego zmienić (to ustawienie całego systemu);
 * wartość 1 (domyślna w Ubuntu, Debianie, Fedorze, Arch) dopuszcza tylko rodzica procesu, 2-3 jeszcze mniej. Zwraca tekst
 * ostrzeżenia do konsoli gry albo '' (poza Linuksem, przy bezpiecznej wartości albo gdy nie da się odczytać).
 */
async function linuxPtraceNote(platform = process.platform, readFile = (f) => fsp.readFile(f, 'utf8')) {
  if (platform !== 'linux') return '';
  try {
    if (String(await readFile('/proc/sys/kernel/yama/ptrace_scope')).trim() === '0') {
      return 'Uwaga: system pozwala każdemu programowi tego samego użytkownika zaglądać do pamięci innych procesów (kernel.yama.ptrace_scope=0), więc launcher nie zamknie dostępu do procesu gry. Ustaw 1: sudo sysctl kernel.yama.ptrace_scope=1';
    }
  } catch {
    /* brak Yamy w jądrze albo brak dostępu - nic do powiedzenia */
  }
  return '';
}

module.exports = {
  linuxPtraceNote,
  parseMaps,
  hardenProcess,
  PROC_DENY_MASK,
  loadRules,
  resetRulesCache,
  inspectFile,
  scanDir,
  scanInstance,
  assertInstanceClean,
  describe,
  sanitizeJvmArgs,
  scrubEnv,
  HARDENING_FLAGS,
  classifyModules,
  watchProcess,
  modulesOf,
  hasNewName,
  signedModules,
  trustedRoots,
  mergeRemote,
  emptyRules,
  exists,
};
