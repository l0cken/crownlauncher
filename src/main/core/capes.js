const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const paths = require('./paths');
const auth = require('./auth');
const appConfig = require('./app-config');
const announcements = require('./announcements');
const capeArt = require('./cape-art');
const instances = require('./instances');
const { readJson, writeJson, exists, USER_AGENT } = require('./util');

/**
 * Peleryny CrownClient.
 *
 * - Biblioteka: wbudowane projekty (cape-art.js) + własne PNG gracza.
 * - W grze rysuje je CustomSkinLoader (mod klienta z Modrinth), który launcher dokłada sam i konfiguruje.
 *   Launcher NIE podmienia skinów - skin zostaje taki, jaki daje gra (konto Microsoft albo serwer).
 *   Źródła peleryny, w kolejności:
 *     1. pliki lokalne  (CustomSkinLoader/LocalSkin/capes/<nick>.png) - wybór gracza, widoczny u niego,
 *     2. źródło wspólne - peleryny, które widzą wszyscy gracze launchera: z własnego serwera (CAPES_URL; każdy
 *        udostępnia swoją pelerynę sam i automatycznie) albo z repozytorium GitHub (capes/players/<nick>.png
 *        nadane przez administrację),
 *     3. profil gry (GameProfile) - skin i oficjalna peleryna dokładnie takie, jakie przysłała sesja/serwer.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 2 * 1024 * 1024; // gotowa (znormalizowana) peleryna w bibliotece
const MAX_SOURCE_BYTES = 8 * 1024 * 1024; // plik wybrany przez gracza, zanim interfejs dopasuje go do formatu
const MAX_CAPE_WIDTH = 2048;
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const GITHUB_RAW = process.env.CROWN_GITHUB_RAW || 'https://raw.githubusercontent.com';
const PLAYERS_DIR = 'capes/players';
const CSL_SLUG = 'customskinloader';
const MARKER = '.crown.json';

// ---- walidacja ---------------------------------------------------------------------------------

/**
 * Peleryna w formacie, który rozumie gra: 64×32 (albo wielokrotność 2:1, HD), 22×17 (stary format)
 * lub 46×22 (OptiFine). Inne układy interfejs dopasowuje do 64×32 przy dodawaniu (renderer/js/cape-import.js).
 * Zwraca { width, height }.
 */
function validateCapePng(buf) {
  if (buf.length > MAX_PNG_BYTES) {
    throw new Error(`Plik peleryny jest za duży po dopasowaniu (maks. ${MAX_PNG_BYTES / 1024 / 1024} MB).`);
  }
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('To nie jest plik PNG.');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const hd = width >= 64 && width <= MAX_CAPE_WIDTH && width % 64 === 0 && height === width / 2;
  const legacy = (width === 22 && height === 17) || (width === 46 && height === 22);
  if (!hd && !legacy) {
    throw new Error(
      `Peleryna musi mieć proporcje 2:1 (np. 64×32, 128×64) albo 22×17 / 46×22 px. Ten plik ma ${width}×${height}.`,
    );
  }
  return { width, height };
}

const toDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

function fromDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!m) throw new Error('Niepoprawne dane obrazu.');
  const buf = Buffer.from(m[1], 'base64');
  validateCapePng(buf);
  return buf;
}

/**
 * Wczytuje plik wybrany przez gracza. Nie wymaga jeszcze „idealnego” formatu - sprawdza tylko, że to PNG
 * i podaje wymiary; dopasowanie do 64×32 robi interfejs (canvas), a biblioteka przyjmuje gotowy wynik.
 */
async function readCapeFile(filePath) {
  if (!/\.png$/i.test(filePath)) throw new Error('Wybierz plik PNG.');
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('Nie znaleziono pliku.');
  if (st.size > MAX_SOURCE_BYTES) throw new Error(`Plik jest za duży (maks. ${MAX_SOURCE_BYTES / 1024 / 1024} MB).`);
  const buf = await fsp.readFile(filePath);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('To nie jest plik PNG.');
  return {
    fileName: path.basename(filePath),
    dataUrl: toDataUrl(buf),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

// ---- biblioteka ----------------------------------------------------------------------------------

async function loadLibrary() {
  try {
    const data = await readJson(paths.capeLibrary());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const saveLibrary = (entries) => writeJson(paths.capeLibrary(), entries);
const cleanName = (name, fallback = 'Peleryna') => String(name || '').trim().slice(0, 32) || fallback;

async function list() {
  const out = capeArt.DESIGNS.map((d) => ({
    id: `builtin-${d.id}`,
    name: d.name,
    builtin: true,
    dataUrl: toDataUrl(capeArt.render(d.id)),
  }));
  const mine = [];
  for (const e of await loadLibrary()) {
    try {
      mine.push({ ...e, builtin: false, dataUrl: toDataUrl(await fsp.readFile(paths.capeFile(e.id))) });
    } catch {
      /* brak pliku - pomijamy wpis */
    }
  }
  return [...out, ...mine.sort((a, b) => b.createdAt - a.createdAt)];
}

async function add({ name, dataUrl }) {
  requireAccess();
  const buf = fromDataUrl(dataUrl);
  const entry = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(name), createdAt: Date.now() };
  await fsp.mkdir(paths.capes(), { recursive: true });
  await fsp.writeFile(paths.capeFile(entry.id), buf);
  const library = await loadLibrary();
  library.push(entry);
  await saveLibrary(library);
  return { ...entry, builtin: false, dataUrl: toDataUrl(buf) };
}

async function remove(id) {
  const library = await loadLibrary();
  if (!library.some((e) => e.id === id)) return;
  await saveLibrary(library.filter((e) => e.id !== id));
  await fsp.rm(paths.capeFile(id), { force: true });
  // zdejmij z kont, które jej używały
  const map = { ...(config.get().capeByName || {}) };
  let changed = false;
  for (const [nick, capeId] of Object.entries(map)) {
    if (capeId === id) {
      delete map[nick];
      changed = true;
    }
  }
  if (changed) {
    config.set({ capeByName: map });
    const acc = currentAccount();
    if (acc && serverBase()) await publishCape(acc.username).catch(() => {});
  }
}

/** PNG peleryny o podanym id (wbudowanej albo z biblioteki). */
async function bufferFor(id) {
  if (String(id).startsWith('builtin-')) {
    const buf = capeArt.render(String(id).slice('builtin-'.length));
    if (!buf) throw new Error('Nie ma takiej peleryny.');
    return buf;
  }
  const library = await loadLibrary();
  if (!library.some((e) => e.id === id)) throw new Error('Nie ma takiej peleryny.');
  return fsp.readFile(paths.capeFile(id));
}

// ---- wybór dla konta -------------------------------------------------------------------------------

function currentAccount() {
  const { accounts, selected } = auth.listPublic();
  const acc = accounts.find((a) => a.id === selected) || null;
  return acc ? { username: acc.username, type: acc.type } : null;
}

/** Nicki wszystkich kont zapisanych w launcherze. */
function accountNicks() {
  try {
    return auth.listPublic().accounts.map((a) => String(a.username || '')).filter((n) => NICK_RE.test(n));
  } catch {
    return [];
  }
}

function selection(username) {
  return (config.get().capeByName || {})[username] || '';
}

/**
 * Dostęp do peleryn: w prywatnej dystrybucji tylko dla kluczy, którym administrator go nadał w panelu (patrz
 * invite.capesAllowed). Bez dostępu launcher nie pokazuje sekcji peleryn, nie zapisuje peleryn do gry i zdejmuje
 * z serwera tę, którą wgrał wcześniej.
 */
const allowed = () => require('./invite').capesAllowed();
/** Gracz z dostępem z panelu wyłączył „Peleryny i korona w grze” (u pozostałych zawsze włączone - patrz invite.cosmeticsOff). */
const cosmeticsOff = () => require('./invite').cosmeticsOff();

function requireAccess() {
  if (!allowed()) throw new Error('Peleryny są dostępne tylko dla wybranych graczy. Poproś administratora o dostęp.');
}

/** Wybrana peleryna konta, o ile launcher ma dostęp do peleryn (inaczej '' - jakby jej nie wybrano). */
const effectiveSelection = (username) => (allowed() ? selection(username) : '');

async function select(id) {
  if (id) requireAccess();
  const acc = currentAccount();
  if (!acc) throw new Error('Najpierw dodaj konto w Ustawieniach.');
  const map = { ...(config.get().capeByName || {}) };
  if (id) {
    await bufferFor(id); // sprawdza, czy peleryna istnieje
    map[acc.username] = id;
  } else {
    delete map[acc.username];
  }
  config.set({ capeByName: map });
  // serwer peleryn: wybór jest od razu widoczny dla wszystkich graczy launchera (bez udziału administracji)
  let share = { shared: false };
  if (serverBase()) {
    try {
      share = await publishCape(acc.username);
    } catch (e) {
      share = { shared: false, error: e.message };
    }
  }
  return { username: acc.username, selected: id || '', ...share };
}

async function state() {
  const acc = currentAccount();
  const ok = allowed();
  return {
    account: acc,
    allowed: ok, // false: interfejs nie pokazuje sekcji peleryn
    selected: acc && ok ? selection(acc.username) : '',
    capes: ok ? await list() : [],
    enabled: !cosmeticsOff(),
    shared: sharedSourceUrl() !== '',
    selfService: serverBase() !== '', // peleryna wybrana w launcherze trafia na serwer sama
  };
}

// ---- wspólne źródło (GitHub) ---------------------------------------------------------------------

function repoSource() {
  try {
    const src = announcements.source();
    return src?.type === 'github' ? src : null;
  } catch {
    return null;
  }
}

// ---- serwer peleryn (server/server.js) -------------------------------------------------------------

/**
 * Adres serwera peleryn: CAPES_URL z app-config.js, a gdy go brak - serwer ogłoszeń. Puste = tryb GitHub
 * (peleryny nadaje administracja). https:// albo http:// tylko dla localhost.
 */
function serverBase() {
  const raw = String(process.env.CROWN_CAPES_URL || appConfig.CAPES_URL || '').trim().replace(/\/+$/, '');
  if (raw) {
    try {
      const u = new URL(raw);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      /* niepoprawny adres - tryb GitHub */
    }
    return '';
  }
  try {
    const src = announcements.source();
    return src?.type === 'server' ? src.base : '';
  } catch {
    return '';
  }
}

/** Adres listy graczy z koroną dla CrownClienta (serwer albo listing katalogu w repozytorium GitHub). */
function badgeListUrl() {
  const base = serverBase();
  if (base) return `${base}/v1/crown-users`;
  const src = repoSource();
  return src ? `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${PLAYERS_DIR}` : '';
}

/** Sekret nicka (dowód własności dla kont offline): losowy, zapisany w config.json zaszyfrowany (DPAPI). */
function secretFor(nick) {
  const map = { ...(config.get().capeSecrets || {}) };
  const stored = map[nick];
  if (stored) {
    // dawne wpisy były jawnym tekstem - przy okazji przepisujemy je na zaszyfrowane
    const plain = auth.isSealed(stored) ? auth.unseal(stored) : stored;
    if (plain) {
      if (!auth.isSealed(stored)) {
        try {
          config.set({ capeSecrets: { ...map, [nick]: auth.seal(plain) } });
        } catch {
          /* szyfrowanie niedostępne - zostaje, jak było */
        }
      }
      return plain;
    }
  }
  const secret = crypto.randomBytes(24).toString('base64url');
  map[nick] = auth.seal(secret);
  config.set({ capeSecrets: map });
  return secret;
}

const MC_JOIN_URL = process.env.CROWN_MC_JOIN_URL || 'https://sessionserver.mojang.com/session/minecraft/join';

/**
 * Dowód, że konto Microsoft jest właścicielem nicka - BEZ wysyłania tokenu komukolwiek poza Mojangiem.
 * To ta sama wymiana, której gra używa przy wejściu na serwer: launcher losuje jednorazowy identyfikator i zgłasza
 * go sessionserverowi Mojanga (tam trafia token), a serwer peleryn pyta Mojanga (hasJoined), czy konto o tym
 * nicku to zrobiło. Identyfikator wybiera launcher, nie serwer - gdyby narzucał go serwer, złośliwy serwer
 * mógłby podstawić taki, który pasuje do prawdziwego serwera gry, i zalogować się jako gracz.
 * Zwraca identyfikator albo '' (konto offline / brak tokenu / Mojang odmówił).
 */
async function mojangProof(username) {
  const acc = currentAccount();
  if (acc?.type !== 'microsoft' || acc.username !== username) return '';
  const account = await auth.getLaunchAccount();
  if (!account?.accessToken || !account.uuid) return '';
  const serverId = crypto.randomBytes(20).toString('hex');
  const res = await fetch(MC_JOIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      accessToken: account.accessToken,
      selectedProfile: String(account.uuid).replace(/-/g, ''),
      serverId,
    }),
    signal: AbortSignal.timeout(8000),
  });
  return res.ok ? serverId : '';
}

/**
 * Nagłówki dowodzące własności nicka: sekret + (dla konta Microsoft) dowód od Mojanga. Token nie opuszcza Mojanga.
 * W trybie prywatnym dochodzi klucz zaproszenia - tylko dla serwera, dla którego go wpisano.
 */
async function ownerHeaders(username, base = '') {
  const headers = { 'X-Crown-Secret': secretFor(username), ...(base ? require('./invite').headersFor(base) : {}) };
  try {
    const serverId = await mojangProof(username);
    if (serverId) headers['X-Crown-Server-Id'] = serverId;
  } catch {
    /* bez dowodu zostaje sekret */
  }
  return headers;
}

async function serverError(res) {
  let msg = '';
  try {
    msg = (await res.json()).error || '';
  } catch {
    /* brak treści */
  }
  return new Error(msg || `Serwer peleryn odrzucił żądanie (HTTP ${res.status}).`);
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/**
 * Wysyła wybraną pelerynę nicka na serwer (albo ją zdejmuje, gdy nic nie wybrano). Rzuca przy błędzie.
 * Zwraca { shared } - czy peleryna jest teraz widoczna dla innych.
 */
async function publishCape(username) {
  const base = serverBase();
  if (!base || !NICK_RE.test(String(username || ''))) return { shared: false };
  const url = `${base}/v1/capes/${encodeURIComponent(username)}`;
  const headers = await ownerHeaders(username, base);
  const shared = { ...(config.get().capeShared || {}) };
  const capeId = effectiveSelection(username);

  if (!capeId) {
    const res = await fetch(url, { method: 'DELETE', headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(10000) });
    if (!res.ok && res.status !== 404) throw await serverError(res);
    delete shared[username];
    config.set({ capeShared: shared });
    return { shared: false };
  }
  const png = await bufferFor(capeId);
  validateCapePng(png);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'image/png', ...headers },
    body: png,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw await serverError(res);
  shared[username] = sha1(png);
  config.set({ capeShared: shared });
  return { shared: true };
}

/** Przy starcie gry: serwer ma aktualną pelerynę nicka (np. po zmianie pliku albo na nowym serwerze). */
async function ensurePublished(username) {
  if (!serverBase() || !NICK_RE.test(String(username || ''))) return;
  const capeId = effectiveSelection(username);
  const known = (config.get().capeShared || {})[username];
  if (!capeId) {
    if (known) await publishCape(username);
    return;
  }
  if (known !== sha1(await bufferFor(capeId))) await publishCape(username);
}

/** „Gram przez CrownLauncher”: korona przed nickiem u pozostałych graczy launchera. Nie rzuca. */
async function announcePresence(username) {
  const base = serverBase();
  if (!base || !NICK_RE.test(String(username || ''))) return;
  try {
    await fetch(`${base}/v1/presence`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', ...(await ownerHeaders(username, base)) },
      body: JSON.stringify({ nick: username }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    /* brak sieci albo serwera - korona i tak jest u siebie */
  }
}

/**
 * Argument JVM dla CrownClienta: nicki wszystkich kont zapisanych w tym launcherze. Skoro konto jest w
 * launcherze, to gra przez CrownLauncher - korona jest przy nim u pozostałych kont tego samego gracza
 * (np. dwa konta na jednym komputerze) bez żadnej listy i bez serwera.
 */
function localMembersArgs() {
  if (cosmeticsOff()) return [];
  const nicks = accountNicks();
  return nicks.length ? [`-Dcrownclient.members=${[...new Set(nicks)].join(',')}`] : [];
}

/** Wzorzec adresu wspólnej peleryny ({USERNAME} podstawia CustomSkinLoader): serwer albo repozytorium GitHub. */
function sharedSourceUrl() {
  const base = serverBase();
  if (base) return `${base}/capes/{USERNAME}.png`;
  const src = repoSource();
  return src ? `${GITHUB_RAW}/${src.owner}/${src.repo}/HEAD/${PLAYERS_DIR}/{USERNAME}.png` : '';
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Czy administracja nadała pelerynę temu nickowi (widoczną dla wszystkich graczy launchera). */
async function assignedFor(username) {
  const pattern = sharedSourceUrl();
  if (!pattern || !NICK_RE.test(username)) return { assigned: false };
  const url = pattern.replace('{USERNAME}', encodeURIComponent(username));
  return { assigned: await headOk(url), url };
}

function requireStaff() {
  const src = repoSource();
  if (!src) throw new Error('Nadawanie peleryn wymaga repozytorium GitHub (GITHUB_REPO).');
  const token = announcements.savedKey();
  if (!token) throw new Error('Zaloguj się kluczem dostępu w Ustawieniach (jak przy ogłoszeniach), aby nadawać peleryny.');
  return { src, token };
}

/** Lista nadanych peleryn (nick -> adres podglądu). Dostępna dla wszystkich (odczyt publiczny). */
async function listAssigned() {
  const src = repoSource();
  if (!src) return [];
  const token = announcements.savedKey() || undefined;
  try {
    const items = await announcements.githubApi('GET', `/repos/${src.owner}/${src.repo}/contents/${PLAYERS_DIR}`, { token });
    return (Array.isArray(items) ? items : [])
      .filter((f) => f.type === 'file' && /\.png$/i.test(f.name))
      .map((f) => ({ nick: f.name.replace(/\.png$/i, ''), sha: f.sha, url: f.download_url }))
      .sort((a, b) => a.nick.localeCompare(b.nick));
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

/** Nadaje pelerynę (id z biblioteki / wbudowaną) graczowi o podanym nicku. Tylko dla publikujących. */
async function assign(nick, capeId) {
  nick = String(nick || '').trim();
  if (!NICK_RE.test(nick)) throw new Error('Nick: 1–16 znaków, litery, cyfry i podkreślnik.');
  const { src, token } = requireStaff();
  const png = await bufferFor(capeId);
  validateCapePng(png);

  const file = `/repos/${src.owner}/${src.repo}/contents/${PLAYERS_DIR}/${nick}.png`;
  let sha;
  try {
    sha = (await announcements.githubApi('GET', file, { token })).sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await announcements.githubApi('PUT', file, {
    token,
    body: {
      message: announcements.COMMIT_MESSAGE,
      content: png.toString('base64'),
      ...(sha ? { sha } : {}),
    },
  });
  return { nick };
}

async function unassign(nick) {
  nick = String(nick || '').trim();
  if (!NICK_RE.test(nick)) throw new Error('Niepoprawny nick.');
  const { src, token } = requireStaff();
  const file = `/repos/${src.owner}/${src.repo}/contents/${PLAYERS_DIR}/${nick}.png`;
  let sha;
  try {
    sha = (await announcements.githubApi('GET', file, { token })).sha;
  } catch (e) {
    if (e.status === 404) return;
    throw e;
  }
  await announcements.githubApi('DELETE', file, { token, body: { message: announcements.COMMIT_MESSAGE, sha } });
}

// ---- gra: CustomSkinLoader -------------------------------------------------------------------------

const CSL_LOADERS = new Set(['fabric']);

async function hasCustomSkinLoader(instance) {
  const index = await instances.readIndex(instance.id);
  if (Object.entries(index).some(([file, m]) => /customskinloader/i.test(m.slug || '') || /customskinloader/i.test(file))) {
    return true;
  }
  try {
    return (await fsp.readdir(instances.contentDir(instance.id, 'mod'))).some((f) => /customskinloader/i.test(f));
  } catch {
    return false;
  }
}

async function ensureCustomSkinLoader(instance) {
  if (!CSL_LOADERS.has(instance.loader)) return { ok: false, reason: 'loader' };
  if (await hasCustomSkinLoader(instance)) return { ok: true, added: false };
  try {
    const modrinth = require('./modrinth'); // leniwie: modrinth ładuje się później niż ten moduł
    const p = await modrinth.project(CSL_SLUG);
    await modrinth.installContent({
      instanceId: instance.id,
      projectId: p.id,
      type: 'mod',
      title: p.title,
      slug: p.slug,
      icon: p.icon,
    });
    return { ok: true, added: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Konfiguracja CustomSkinLoader: tylko peleryny.
 *
 * Źródła lokalne i wspólne mają wyłącznie `cape`/`elytra` (bez `skin`), a na końcu stoi `GameProfile`, które oddaje
 * skin (i oficjalną pelerynę) dokładnie tak, jak przysłała je gra: sesja konta Microsoft albo serwer. Dzięki temu
 * skin jest taki, jaki jest - launcher go nie podmienia, nie dociąga z Mojang po nicku i nie zgaduje modelu.
 */
function cslConfig({ capes = true } = {}) {
  const loadlist = [];
  if (capes) {
    loadlist.push({
      name: 'LocalSkin',
      type: 'Legacy',
      checkPNG: false,
      cape: 'LocalSkin/capes/{USERNAME}.png',
      elytra: 'LocalSkin/capes/{USERNAME}.png',
    });
    const shared = sharedSourceUrl();
    if (shared) {
      loadlist.push({ name: 'CrownCapes', type: 'Legacy', checkPNG: false, cape: shared, elytra: shared });
    }
  }
  loadlist.push({ name: 'GameProfile', type: 'GameProfile' });
  // pola zgodne z CustomSkinLoader 15.x (Config.java); `version` zapobiega uznaniu pliku za uszkodzony
  return {
    version: '15.1',
    buildNumber: 0,
    loadlist,
    enableTransparentSkin: true,
    forceLoadAllTextures: true, // skin z jednego źródła, peleryna z innego (pętla idzie, aż profil jest pełny)
    enableCape: true,
    threadPoolSize: 3,
    enableLogStdOut: false,
    cacheExpiry: 30,
    forceUpdateSkull: false,
    enableLocalProfileCache: false,
    enableCacheAutoClean: false,
    forceDisableCache: false,
  };
}

async function readMarker(file) {
  try {
    const m = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { capes: Array.isArray(m.capes) ? m.capes : [], skins: Array.isArray(m.skins) ? m.skins : [] };
  } catch {
    return { capes: [], skins: [] };
  }
}

/**
 * Zapisuje konfigurację CustomSkinLoader i sprząta skiny zapisane przez dawne wersje launchera (usuwamy tylko to,
 * co launcher sam zapisał - lista nicków jest w znaczniku). Nadpisuje wyłącznie plik utworzony przez launcher
 * albo brakujący; własnej konfiguracji gracza nie ruszamy.
 */
async function writeManagedConfig(base, marker, markerFile, { capes }) {
  for (const nick of marker.skins) {
    if (NICK_RE.test(nick)) await fsp.rm(path.join(base, 'LocalSkin', 'skins', `${nick}.png`), { force: true });
  }
  if (marker.skins.length) {
    marker.skins = [];
    await writeJson(markerFile, marker);
  }
  const cfgFile = path.join(base, 'CustomSkinLoader.json');
  const ownedMarker = path.join(base, '.crown-config');
  if (!(await exists(cfgFile)) || (await exists(ownedMarker))) {
    await writeJson(cfgFile, cslConfig({ capes }));
    await fsp.writeFile(ownedMarker, 'managed by CrownLauncher\n');
  }
}

/**
 * Przed startem gry: dokłada CustomSkinLoader (gdy jest po co), zapisuje pelerynę gracza i konfigurację.
 * Sprząta też pliki skinów zapisane przez wcześniejsze wersje launchera. Nie rzuca - brak peleryny nie może
 * blokować gry. Zwraca opis do logu.
 */
async function prepareForLaunch(instance, username) {
  try {
    const cfg = config.get();
    if (!NICK_RE.test(String(username || ''))) return { applied: false };

    // bez dostępu do peleryn (klucz bez uprawnienia) własne peleryny nie trafiają do gry - zostają widoczne cudze
    const hasAccess = allowed();
    const capeId = (hasAccess && (cfg.capeByName || {})[username]) || '';
    // peleryny WSZYSTKICH kont zapisanych w launcherze (nie tylko tego, które startuje): inaczej drugie konto
    // na tym samym komputerze, grające z innej instancji, nie zobaczyłoby własnej peleryny pierwszego
    const wanted = new Map();
    for (const nick of hasAccess ? new Set([username, ...accountNicks()]) : []) {
      const id = (cfg.capeByName || {})[nick];
      if (id) wanted.set(nick, id);
    }
    const gameDir = paths.gameDir(instance.id);
    const base = path.join(gameDir, 'CustomSkinLoader');
    const capesDir = path.join(base, 'LocalSkin', 'capes');
    const markerFile = path.join(base, 'LocalSkin', MARKER);
    const marker = await readMarker(markerFile);

    const csl = await hasCustomSkinLoader(instance);
    if (cosmeticsOff()) {
      // peleryny wyłączone (gracz z dostępem z panelu): niczego nie dokładamy, ale mod, który już jest, nie może dalej
      // rysować peleryn ani używać skinów zapisanych przez dawne wersje launchera
      if (csl) await writeManagedConfig(base, marker, markerFile, { capes: false });
      return { applied: false };
    }
    const wantsCosmetics = Boolean(wanted.size || sharedSourceUrl());
    // mod dokładamy dopiero, gdy jest po co (wybrana peleryna albo wspólne źródło peleryn)
    let installed = csl;
    if (!csl && wantsCosmetics) installed = (await ensureCustomSkinLoader(instance)).ok;
    if (!installed) return { applied: false, reason: 'mod' };

    await fsp.mkdir(capesDir, { recursive: true });

    // pliki peleryn: zapisujemy wybrane, a zdejmujemy tylko te, które launcher sam zapisał (lista w znaczniku)
    for (const [nick, id] of wanted) {
      try {
        await fsp.writeFile(path.join(capesDir, `${nick}.png`), await bufferFor(id));
        if (!marker.capes.includes(nick)) marker.capes.push(nick);
      } catch {
        /* wybrana peleryna została usunięta */
      }
    }
    for (const nick of marker.capes.filter((n) => !wanted.has(n))) {
      if (NICK_RE.test(nick)) await fsp.rm(path.join(capesDir, `${nick}.png`), { force: true });
    }
    marker.capes = marker.capes.filter((n) => wanted.has(n));
    await writeJson(markerFile, marker); // znacznik: które pliki peleryn zapisał launcher (tylko je później zdejmujemy)

    await writeManagedConfig(base, marker, markerFile, { capes: true });
    // serwer peleryn: aktualna peleryna i obecność (nie blokuje startu ani nie przerywa go przy błędzie)
    if (serverBase()) {
      await ensurePublished(username).catch(() => {});
      announcePresence(username);
    }
    return { applied: true, cape: capeId || null };
  } catch (e) {
    return { applied: false, reason: e.message };
  }
}

module.exports = {
  list,
  add,
  remove,
  select,
  state,
  readCapeFile,
  requireAccess,
  validateCapePng,
  bufferFor,
  assignedFor,
  listAssigned,
  assign,
  unassign,
  prepareForLaunch,
  publishCape,
  localMembersArgs,
  serverBase,
  badgeListUrl,
  ensureCustomSkinLoader,
  cslConfig,
  sharedSourceUrl,
  currentAccount,
  secretFor,
};
