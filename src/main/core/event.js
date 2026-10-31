const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const config = require('./config');
const paths = require('./paths');
const invite = require('./invite');
const instances = require('./instances');
const { seal } = require('./auth');
const { USER_AGENT } = require('./util');
const { hideDirs, setAccess } = require('./hidden');

/**
 * Wydarzenie (np. „Igrzyska śmierci”): zamknięty zestaw modów i texturepacków z serwera launchera.
 *
 * Dostęp daje klucz z profilem wydarzenia („kod”):
 *  - gracz z pełnym dostępem wpisuje kod w zakładce wydarzenia - nic mu nie blokuje (kod trzymamy obok głównego klucza),
 *  - osoba, której jedynym kluczem jest kod, dostaje launcher ograniczony do wydarzenia (restrictions.js).
 * Instancja wydarzenia jest zablokowana i synchronizowana z listą z serwera przy każdym starcie gry:
 *  - mods/, resourcepacks/, shaderpacks/ - dokładnie pliki z listy (brakujące pobierane z weryfikacją SHA-1, reszta usuwana),
 *  - config/ i pliki gry (options.txt, servers.dat…) - nakładka: pliki z listy są wgrywane, reszta zostaje. Plik
 *    „wymuszany” (`enforce`) wraca do wersji z serwera przy każdym starcie; pozostałe są ustawieniem domyślnym -
 *    wgrywane przy pierwszej synchronizacji i po zmianie przez organizatora, a gracz może je w międzyczasie zmieniać.
 *  - foldery wydarzenia są ukryte w Eksploratorze (hidden.js), także przy włączonym „Pokaż ukryte elementy”.
 */

const EVENT_ID = 'igrzyska'; // na razie jedyne wydarzenie
const STRICT_KINDS = ['mods', 'resourcepacks', 'shaderpacks']; // katalog = rodzaj; zawartość dokładnie z listy
const OVERLAY_DIRS = { config: ['config'], root: [] }; // katalog względem folderu gry; pliki spoza listy zostają
const ALL_KINDS = [...STRICT_KINDS, ...Object.keys(OVERLAY_DIRS)];
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ +()[\]-]{0,118}$/;
// foldery ukryte w Eksploratorze (atrybuty Ukryty + Systemowy) i zamykane poza grą (hidden.js). Oprócz plików wydarzenia
// zdradzają je też foldery robocze: .fabric (kopie modów po zmapowaniu), logs (lista modów przy starcie) i crash-reports;
// downloads tworzy sama gra (paczki z serwerów)
const HIDDEN_DIRS = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports'];
const TIMEOUT_MS = 15_000;

const instanceId = (id = EVENT_ID) => `event-${id}`;

let syncing = null; // trwająca synchronizacja (jedna naraz)

function base() {
  const b = invite.builtinServer();
  if (!b) throw new Error('Wydarzenia wymagają własnego serwera launchera.');
  return b;
}

function profile() {
  return config.get().inviteProfile || '';
}

/** Czy ten gracz ma dostęp do plików wydarzenia: głównym kluczem (kod jako jedyny klucz) albo wpisanym kodem. */
function access(id = EVENT_ID) {
  const cfg = config.get();
  if ((cfg.inviteProfile || '') === id) return { hasAccess: true, via: 'primary' };
  if (cfg.eventKeys && cfg.eventKeys[id]) return { hasAccess: true, via: 'code' };
  return { hasAccess: false, via: null };
}

async function request(pathname, { id = EVENT_ID, headers = null, raw = false } = {}) {
  const url = `${base()}${pathname}`;
  const h = headers || invite.eventHeaders(id, url);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...h }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (raw) return res;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Serwer odpowiedział błędem (HTTP ${res.status}).`), { status: res.status });
  return body;
}

/** Publiczne informacje o wydarzeniu (każdy z ważnym kluczem zaproszenia): tytuł i czy jest przygotowane. */
async function info(id = EVENT_ID) {
  try {
    const headers = invite.headersFor(base());
    if (!headers['X-Crown-Invite']) return { available: false };
    const r = await request(`/v1/event/${id}/info`, { headers });
    return { available: true, id, title: r.title, ready: Boolean(r.ready) };
  } catch {
    return { available: false };
  }
}

/** Kod wydarzenia wpisany przez gracza z pełnym dostępem: sprawdzamy go na serwerze i zapisujemy zaszyfrowany. */
async function redeem(code, id = EVENT_ID) {
  const norm = invite.normalize(code);
  if (norm.length < 12) throw new Error('Wpisz kod wydarzenia w formacie CROWN-XXXX-XXXX-XXXX-XXXX.');
  const result = await invite.ask(base(), norm, undefined, { entry: true }); // jawne wpisanie kodu - przyłącza też zwolniony komputer
  if (result.usedElsewhere) throw new Error(result.message || 'Ten kod został już użyty na maksymalnej liczbie komputerów.');
  if (!result.ok) throw new Error(result.message || 'Nieprawidłowy, unieważniony lub wygasły kod.');
  if ((result.profile || '') !== id) throw new Error('To nie jest kod Igrzysk śmierci. Wpisz kod od organizatora wydarzenia.');
  const keys = { ...(config.get().eventKeys || {}), [id]: seal(norm) };
  config.set({ eventKeys: keys });
  return access(id);
}

function forget(id = EVENT_ID) {
  const keys = { ...(config.get().eventKeys || {}) };
  delete keys[id];
  config.set({ eventKeys: keys });
}

async function manifest(id = EVENT_ID) {
  try {
    return await request(`/v1/event/${id}`, { id });
  } catch (e) {
    if (e.status === 401 || e.status === 409 || e.status === 403) {
      // kod przestał działać (unieważniony, wygasł, zajęty) - zapominamy go, żeby gracz wpisał nowy
      if ((config.get().inviteProfile || '') !== id) forget(id);
      throw Object.assign(new Error(e.message), { status: e.status, lost: true });
    }
    throw e;
  }
}

async function localInstance(id = EVENT_ID) {
  try {
    return await instances.get(instanceId(id));
  } catch {
    return null;
  }
}

/** Stan do interfejsu: dostęp, pliki z serwera, lokalna instancja. */
async function state(id = EVENT_ID) {
  const acc = access(id);
  const out = { id, restricted: Boolean(profile()), ...acc, instanceId: instanceId(id) };
  const pub = await info(id);
  out.available = pub.available;
  out.title = pub.title || 'IGRZYSKA ŚMIERCI';
  out.ready = pub.ready || false;
  if (!acc.hasAccess || !pub.available) return out;
  try {
    const m = await manifest(id);
    out.title = m.title || out.title;
    out.mcVersion = m.mcVersion;
    // do interfejsu idzie tylko liczba plików - nazw modów, paczek i configów gracz w launcherze nie widzi
    out.files = ALL_KINDS.reduce((n, kind) => n + (Array.isArray(m[kind]) ? m[kind].length : 0), 0);
    out.crownClient = m.crownClient;
  } catch (e) {
    out.error = e.message;
    if (e.lost) out.hasAccess = access(id).hasAccess;
  }
  const inst = await localInstance(id);
  out.installed = Boolean(inst);
  return out;
}

async function sha1Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

async function download(id, kind, entry, dest, onBytes) {
  const res = await request(`/v1/event/${id}/file/${kind}?path=${encodeURIComponent(entry.name)}`, { id, raw: true });
  // komunikaty błędów nie zdradzają nazw plików wydarzenia (gracz widzi je w interfejsie)
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku wydarzenia (HTTP ${res.status}).`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const got = await sha1Of(tmp);
  if (got !== entry.sha1) {
    await fsp.rm(tmp, { force: true });
    throw new Error('Plik wydarzenia jest uszkodzony (niezgodna suma SHA-1). Spróbuj ponownie.');
  }
  await fsp.rename(tmp, dest);
  onBytes?.(entry.size);
}

/** Włącza texturepacki wydarzenia w options.txt (resourcePacks:["vanilla","file/pack.zip",…]); reszta ustawień zostaje. */
async function enablePacks(gameDir, packNames) {
  const file = path.join(gameDir, 'options.txt');
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    /* gra utworzy plik przy pierwszym starcie */
  }
  const lines = text ? text.split(/\r?\n/) : [];
  let current = ['vanilla'];
  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(lines[idx].slice('resourcePacks:'.length));
      if (Array.isArray(parsed)) current = parsed;
    } catch {
      /* uszkodzona linia - zaczynamy od vanilla */
    }
  }
  // paczki spoza wydarzenia (file/…) usuwamy, wydarzeniowe dokładamy na koniec (najwyższy priorytet)
  const wanted = packNames.map((n) => `file/${n}`);
  const kept = current.filter((p) => !String(p).startsWith('file/') || wanted.includes(p));
  const next = [...kept, ...wanted.filter((p) => !kept.includes(p))];
  const line = `resourcePacks:${JSON.stringify(next)}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  await fsp.writeFile(file, `${lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n')}\n`, 'utf8');
}

/** Ścieżka pliku wydarzenia w folderze gry; rzuca, gdy nazwa z serwera wychodziłaby poza katalog rodzaju. */
function localPath(gameDir, kind, name) {
  const segs = String(name).split('/');
  if (segs.length > 4 || !segs.every((p) => SEGMENT_RE.test(p))) throw new Error('Niepoprawna nazwa pliku wydarzenia.');
  const base = STRICT_KINDS.includes(kind) ? path.join(gameDir, kind) : path.join(gameDir, ...OVERLAY_DIRS[kind]);
  const dest = path.join(base, ...segs);
  const rel = path.relative(base, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Niepoprawna ścieżka pliku wydarzenia.');
  return dest;
}

// które pliki-nakładki zostały już wgrane (sha1 z serwera) - dla ustawień domyślnych (`enforce: false`).
// Klucze to skróty „rodzaj/nazwa”, żeby plik w folderze instancji (niezamykany) nie zdradzał nazw configów.
const appliedKey = (kind, name) => crypto.createHash('sha1').update(`${kind}/${name}`).digest('hex');
const appliedFile = (instanceId) => path.join(paths.instanceDir(instanceId), 'event-applied.json');
async function readApplied(instanceId) {
  try {
    const v = JSON.parse(await fsp.readFile(appliedFile(instanceId), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const fileExists = (file) => fsp.stat(file).then((st) => st.isFile(), () => false);

// ---- blokada wejścia do folderów wydarzenia (Windows; patrz hidden.js) ----
// Ukrycie atrybutami nie wystarcza (po wpisaniu ścieżki w pasku adresu folder się otwiera), więc poza grą foldery mają
// odmowę NTFS dla użytkownika. Cykl: synchronizacja zdejmuje blokadę (open) -> start gry zakłada „tylko odczyt” dla
// mods i resourcepacks (protectRunning) -> po zamknięciu gry i przy starcie launchera pełna blokada (lockDirs).
const READONLY_DIRS = ['mods', 'resourcepacks']; // gra ich nie zapisuje; reszta (config, downloads, .fabric, logs…) jest zapisywana
const dirsOf = (instanceId, names = HIDDEN_DIRS) => names.map((d) => path.join(paths.gameDir(instanceId), d));

/** Zdejmuje blokady (na czas synchronizacji, usuwania instancji, czyszczenia). */
const unlockDirs = (instanceId) => setAccess(dirsOf(instanceId), 'open');

/** Gra nie działa: foldery wydarzenia nie dają się otworzyć ani po wpisaniu ścieżki. */
const lockDirs = (instanceId) => setAccess(dirsOf(instanceId), 'sealed');

/** W trakcie gry: mods i resourcepacks tylko do odczytu (nikt nie podmieni paczki w locie), reszta otwarta. */
async function protectRunning(instanceId) {
  await setAccess(dirsOf(instanceId, HIDDEN_DIRS.filter((d) => !READONLY_DIRS.includes(d))), 'open');
  await setAccess(dirsOf(instanceId, READONLY_DIRS), 'readonly');
}

/** Po zamknięciu gry: usuwa raporty awarii JVM z katalogu głównego instancji (zawierają listy bibliotek i modułów). */
async function cleanAfterGame(instanceId) {
  const dir = paths.gameDir(instanceId);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => /^(hs_err_pid|replay_pid)\d+\.log$/.test(n)).map((n) => fsp.rm(path.join(dir, n), { force: true })));
}

/** Przy starcie launchera: wszystkie instancje wydarzeń są zamknięte (gra nie może jeszcze działać). */
async function lockAll() {
  let names = [];
  try {
    names = await fsp.readdir(paths.instances());
  } catch {
    return; // brak katalogu instancji
  }
  await Promise.all(names.filter((n) => n.startsWith('event-')).map((n) => lockDirs(n)));
}

/**
 * Synchronizuje instancję wydarzenia z serwerem: tworzy ją (albo odtwarza przy zmianie wersji gry), dociąga
 * brakujące pliki, usuwa mody/texturepacki/shaderpacki spoza listy, wgrywa configi i pliki gry (zależnie od
 * `enforce`), ukrywa foldery i włącza texturepacki. `onProgress({stage, current, total, name})`.
 *
 * Zdejmuje blokadę folderów i **zostawia je otwarte** - wywołujący odpowiada za późniejsze `lockDirs` (gdy gra nie
 * startuje) albo `protectRunning` (tuż przed startem gry; robi to game.launch).
 */
async function sync(onProgress = () => {}, id = EVENT_ID) {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!access(id).hasAccess) throw new Error('Wpisz kod Igrzysk śmierci, aby odblokować wydarzenie.');
    onProgress({ stage: 'manifest', current: 0, total: 1 });
    const m = await manifest(id);
    const list = (kind) => (Array.isArray(m[kind]) ? m[kind] : []);
    if (!m.mcVersion || !ALL_KINDS.some((kind) => list(kind).length)) {
      throw new Error('Wydarzenie nie zostało jeszcze przygotowane przez organizatora (brak plików lub wersji gry).');
    }

    let inst = await localInstance(id);
    if (inst) await unlockDirs(inst.id); // blokada z poprzedniego uruchomienia przeszkadzałaby w synchronizacji i usuwaniu
    if (inst && inst.mcVersion !== m.mcVersion) {
      await instances.remove(inst.id); // zmiana wersji gry - instancja wydarzenia nie ma danych do zachowania
      inst = null;
    }
    if (!inst) {
      inst = await instances.createEvent({ id: instanceId(id), event: id, name: m.title, mcVersion: m.mcVersion, crownClient: m.crownClient });
    } else if (inst.name !== m.title || Boolean(inst.noCrownClient) !== (m.crownClient === false)) {
      inst = await instances.setEventMeta(inst.id, { name: m.title, noCrownClient: m.crownClient === false });
    }

    const gameDir = paths.gameDir(inst.id);
    const total = ALL_KINDS.reduce((n, kind) => n + list(kind).reduce((k, e) => k + e.size, 0), 0);
    let done = 0;
    const fetchFile = async (kind, entry, dest) => {
      onProgress({ stage: 'download', current: done, total, name: entry.name });
      await download(id, kind, entry, dest, (bytes) => { done += bytes; });
    };
    const matches = async (dest, entry) => {
      try {
        const st = await fsp.stat(dest);
        return st.isFile() && st.size === entry.size && (await sha1Of(dest)) === entry.sha1;
      } catch {
        return false; // brak pliku
      }
    };

    // mody, texturepacki, shaderpacki: dokładnie to, co na liście
    for (const kind of STRICT_KINDS) {
      const dir = path.join(gameDir, kind);
      await fsp.mkdir(dir, { recursive: true });
      const names = new Set(list(kind).map((e) => e.name));
      // wszystko, czego nie ma na liście (też .disabled, foldery, pliki tymczasowe) znika
      for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!names.has(ent.name)) await fsp.rm(path.join(dir, ent.name), { recursive: true, force: true });
      }
      for (const entry of list(kind)) {
        const dest = localPath(gameDir, kind, entry.name);
        if (await matches(dest, entry)) done += entry.size;
        else await fetchFile(kind, entry, dest);
      }
    }

    // configi i pliki gry: nakładka (wymuszana albo ustawienie domyślne), pliki spoza listy zostają
    const applied = await readApplied(inst.id);
    const nextApplied = {};
    for (const kind of Object.keys(OVERLAY_DIRS)) {
      for (const entry of list(kind)) {
        const dest = localPath(gameDir, kind, entry.name);
        const key = appliedKey(kind, entry.name);
        let need;
        if (entry.enforce === false) need = !(await fileExists(dest)) || applied[key] !== entry.sha1;
        else need = !(await matches(dest, entry));
        if (need) await fetchFile(kind, entry, dest);
        else done += entry.size;
        nextApplied[key] = entry.sha1;
      }
    }
    await fsp.mkdir(path.dirname(appliedFile(inst.id)), { recursive: true });
    await fsp.writeFile(appliedFile(inst.id), JSON.stringify(nextApplied, null, 2), 'utf8');

    // także sam folder instancji i jego „game” - w Eksploratorze (po otwarciu folderu danych launchera) nie ma tropu
    await hideDirs([paths.instanceDir(inst.id), gameDir, ...HIDDEN_DIRS.map((d) => path.join(gameDir, d))]);
    await enablePacks(gameDir, list('resourcepacks').map((p) => p.name));
    onProgress({ stage: 'done', current: total, total });
    return { instance: inst, mods: list('mods').length, resourcepacks: list('resourcepacks').length, shaderpacks: list('shaderpacks').length, config: list('config').length, root: list('root').length };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Wywoływane przez game.launch dla instancji wydarzenia: pliki muszą zgadzać się z serwerem. */
async function beforeLaunch(instance) {
  const id = instance.event || EVENT_ID;
  try {
    await sync(() => {}, id);
  } catch (e) {
    throw new Error(`Igrzyska: ${e.message}`);
  }
}

module.exports = { EVENT_ID, instanceId, access, info, redeem, forget, state, sync, beforeLaunch, enablePacks, profile, unlockDirs, lockDirs, protectRunning, lockAll, cleanAfterGame };
