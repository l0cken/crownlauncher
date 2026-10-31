const crypto = require('crypto');
const config = require('./config');
const appConfig = require('./app-config');
const { seal, unseal } = require('./auth');
const { USER_AGENT } = require('./util');
const { validateAnnouncement } = require('./announcement-schema');

/**
 * Ogłoszenia launchera. Dwa źródła:
 *  - GitHub: plik announcements.json w publicznym repozytorium ("właściciel/repo"). Czytać może każdy,
 *    publikuje osoba z dostępem do zapisu i tokenem GitHub (to jest "klucz dostępu").
 *  - własny serwer (server/server.js) pod adresem https://…
 */

const GITHUB_API = process.env.CROWN_GITHUB_API || 'https://api.github.com';
const GITHUB_RAW = process.env.CROWN_GITHUB_RAW || 'https://raw.githubusercontent.com';
const FILE = 'announcements.json';
const TIMEOUT_MS = 10_000;
const MAX_STORED = 200;
const LABELS = { info: 'Ogłoszenie', important: 'Ważne', event: 'Wydarzenie' };

const REPO_RE = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** Wskazuje, skąd bierzemy ogłoszenia (i aktualizacje): repozytorium GitHub albo serwer. */
function source() {
  const raw = String(config.get().announcementsUrl || appConfig.GITHUB_REPO || appConfig.ANNOUNCEMENTS_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return null;

  const repo = REPO_RE.exec(raw);
  if (repo) return { type: 'github', owner: repo[1], repo: repo[2] };

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Wpisz repozytorium GitHub (właściciel/repo) albo adres serwera ogłoszeń (https://…).');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('Adres serwera ogłoszeń musi zaczynać się od https:// (http:// tylko dla localhost).');
  }
  return { type: 'server', base: u.origin + u.pathname.replace(/\/+$/, '') };
}

/** Zachowane dla kompatybilności: adres bazowy serwera (puste dla GitHuba). */
function baseUrl() {
  const s = source();
  return s?.type === 'server' ? s.base : '';
}

/** Stała tożsamość źródła, do którego należy klucz (bez wielkości liter i końcowych ukośników). */
function sourceId(src) {
  if (!src) return '';
  return (src.type === 'github' ? `github:${src.owner}/${src.repo}` : `server:${src.base}`).toLowerCase();
}

function currentSourceId() {
  try {
    return sourceId(source());
  } catch {
    return '';
  }
}

/** Źródło wbudowane w launcher - do niego należą klucze zapisane, zanim launcher zaczął zapamiętywać źródło. */
function builtinSourceId() {
  const raw = String(appConfig.GITHUB_REPO || appConfig.ANNOUNCEMENTS_URL || '').trim().replace(/\/+$/, '');
  const repo = REPO_RE.exec(raw);
  if (repo) return `github:${repo[1]}/${repo[2]}`.toLowerCase();
  try {
    const u = new URL(raw);
    return `server:${u.origin + u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Czy zapisany klucz wolno użyć dla bieżącego źródła. Klucz (token GitHub albo klucz serwera) jest wysyłany
 * wyłącznie tam, gdzie został wpisany - inaczej wystarczyłoby podmienić „Adres serwera ogłoszeń” w ustawieniach,
 * żeby launcher sam wysłał klucz na obcy adres.
 */
function keyUsable(cfg = config.get()) {
  if (!cfg.publisherKey) return false;
  const bound = cfg.publisherSource || builtinSourceId();
  return Boolean(bound) && bound === currentSourceId();
}

function savedKey() {
  const cfg = config.get();
  return keyUsable(cfg) ? unseal(cfg.publisherKey) : '';
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'przekroczono czas oczekiwania' : e.cause?.code || e.message;
    throw new Error(`Brak połączenia z serwerem ogłoszeń (${reason}).`);
  }
  return res;
}

function toItem(a, canDelete) {
  const text = String(a.text || '');
  return {
    id: `ann-${a.id}`,
    source: 'announcement',
    annId: a.id,
    level: a.level,
    pinned: Boolean(a.pinned),
    label: LABELS[a.level] || LABELS.info,
    title: a.title,
    text: text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : text,
    fullText: text,
    date: a.createdAt,
    image: /^https:\/\//i.test(a.image || '') ? a.image : '',
    link: /^https:\/\//i.test(a.link || '') ? a.link : '',
    author: a.author,
    canDelete,
  };
}

// ---- backend: serwer własny --------------------------------------------------------

async function serverApi(src, method, pathname, { body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  // tryb prywatny: klucz zaproszenia idzie tylko do serwera, dla którego go wpisano (invite.headersFor sprawdza adres)
  Object.assign(headers, require('./invite').headersFor(src.base));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await request(`${src.base}${pathname}`, { method, headers, body });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* brak treści */
  }
  if (!res.ok) throw new Error(data?.error || `Serwer ogłoszeń zwrócił błąd (HTTP ${res.status}).`);
  return data;
}

// ---- backend: GitHub -------------------------------------------------------------------

// Każdy commit launchera w repozytorium (ogłoszenia, peleryny graczy) ma tę samą, neutralną nazwę - widać ją na
// stronie repozytorium i w opisie wydania, więc nie wolno w niej zdradzać nicków ani tytułów.
const COMMIT_MESSAGE = 'CrownLauncher';

async function githubApi(method, pathname, { token, body } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await request(`${GITHUB_API}${pathname}`, { method, headers, body });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* brak treści */
  }
  if (res.status === 401) throw Object.assign(new Error('Token GitHub jest nieprawidłowy, wygasł albo został cofnięty.'), { status: 401 });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw Object.assign(new Error('Limit zapytań GitHub wyczerpany - spróbuj za chwilę.'), { status: 403 });
  }
  if (!res.ok) {
    const detail = data?.message ? `: ${data.message}` : '';
    throw Object.assign(new Error(`GitHub zwrócił błąd (HTTP ${res.status})${detail}`), { status: res.status });
  }
  return data;
}

function parseList(text) {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : Array.isArray(data.announcements) ? data.announcements : [];
  } catch {
    return [];
  }
}

/**
 * Bez tokenu: surowy plik z CDN GitHuba (bez limitu zapytań). Zwraca [] gdy pliku jeszcze nie ma.
 * Gdy CDN jest nieosiągalny (część sieci i DNS-ów blokuje raw.githubusercontent.com), próbujemy
 * jeszcze anonimowo przez api.github.com - inaczej gracz po prostu nie zobaczyłby ogłoszeń.
 */
async function githubReadPublic(src) {
  const minute = Math.floor(Date.now() / 60_000); // omija 5-minutowy cache CDN
  let failure;
  try {
    const res = await request(`${GITHUB_RAW}/${src.owner}/${src.repo}/HEAD/${FILE}?t=${minute}`);
    if (res.status === 404) return [];
    if (res.ok) return parseList(await res.text());
    failure = new Error(`Nie udało się pobrać ogłoszeń z GitHuba (HTTP ${res.status}).`);
  } catch (e) {
    failure = e;
  }

  try {
    const res = await request(`${GITHUB_API}/repos/${src.owner}/${src.repo}/contents/${FILE}`, {
      headers: { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (res.status === 404) return [];
    if (res.ok) return parseList(await res.text());
  } catch {
    /* zostaje pierwszy błąd - on mówi więcej o przyczynie */
  }
  throw failure;
}

/** Z tokenem: przez API (bez cache) - razem z sha potrzebnym do zapisu. */
async function githubReadFile(src, token) {
  try {
    const f = await githubApi('GET', `/repos/${src.owner}/${src.repo}/contents/${FILE}`, { token });
    const text = Buffer.from(f.content || '', 'base64').toString('utf8');
    return { list: parseList(text), sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { list: [], sha: null }; // plik zostanie utworzony przy pierwszej publikacji
    throw e;
  }
}

async function githubWriteFile(src, token, list, sha, message) {
  const content = Buffer.from(`${JSON.stringify({ announcements: list }, null, 2)}\n`, 'utf8').toString('base64');
  await githubApi('PUT', `/repos/${src.owner}/${src.repo}/contents/${FILE}`, {
    token,
    body: { message, content, ...(sha ? { sha } : {}) },
  });
}

/** Odczyt-modyfikacja-zapis z ponowieniem przy konflikcie (ktoś opublikował w tym samym momencie). */
async function githubMutate(src, token, mutate, message) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { list, sha } = await githubReadFile(src, token);
    const next = mutate(list);
    try {
      await githubWriteFile(src, token, next, sha, message);
      return next;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw lastErr;
}

const prune = (list) => {
  const now = Date.now();
  const alive = list.filter((a) => !a.expiresAt || new Date(a.expiresAt).getTime() > now);
  alive.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt));
  return alive.slice(0, MAX_STORED);
};

// ---- API modułu ------------------------------------------------------------------------------

function canDeleteGithub(a, cfg) {
  if (!keyUsable(cfg)) return false;
  return cfg.publisherRole === 'admin' || a.author === cfg.publisherName;
}

/** Ogłoszenia jako elementy listy newsów. Brak skonfigurowanego źródła = pusta lista. */
async function fetchItems() {
  const src = source();
  if (!src) return [];

  if (src.type === 'server') {
    const data = await serverApi(src, 'GET', '/v1/announcements', { key: savedKey() || undefined });
    return (data.announcements || []).map((a) => toItem(a, Boolean(a.canDelete)));
  }

  const cfg = config.get();
  const token = savedKey();
  let list;
  try {
    list = token ? (await githubReadFile(src, token)).list : await githubReadPublic(src);
  } catch (e) {
    if (!token || e.status === 401) list = await githubReadPublic(src); // cofnięty token nie psuje odczytu
    else throw e;
  }
  const now = Date.now();
  return list
    .filter((a) => a && a.id && a.title && (!a.expiresAt || new Date(a.expiresAt).getTime() > now))
    .map((a) => toItem(a, canDeleteGithub(a, cfg)));
}

function status() {
  const cfg = config.get();
  let src = null;
  let error = '';
  try {
    src = source();
  } catch (e) {
    error = e.message;
  }
  const own = String(cfg.announcementsUrl || '').trim();
  return {
    mode: src?.type || null,
    repo: src?.type === 'github' ? `${src.owner}/${src.repo}` : '',
    url: own,
    builtin: !own && Boolean(src),
    configured: Boolean(src),
    error,
    loggedIn: keyUsable(cfg),
    name: cfg.publisherName || '',
    role: cfg.publisherRole || '',
  };
}

async function login(key) {
  key = String(key || '').trim();
  if (!key) throw new Error('Wpisz klucz dostępu.');
  const src = source();
  if (!src) throw new Error('Najpierw ustaw repozytorium GitHub lub adres serwera ogłoszeń.');

  let name;
  let role;
  if (src.type === 'server') {
    const me = await serverApi(src, 'GET', '/v1/me', { key });
    name = me.name;
    role = me.role;
  } else {
    const user = await githubApi('GET', '/user', { token: key });
    const repo = await githubApi('GET', `/repos/${src.owner}/${src.repo}`, { token: key }).catch((e) => {
      if (e.status === 404) throw new Error(`Token nie ma dostępu do repozytorium ${src.owner}/${src.repo}.`);
      throw e;
    });
    if (!repo.permissions?.push) {
      throw new Error(`Konto ${user.login} nie ma uprawnień zapisu w ${src.owner}/${src.repo}. Poproś właściciela o dodanie Cię jako współpracownika.`);
    }
    name = user.login;
    role = repo.permissions.admin || user.login.toLowerCase() === src.owner.toLowerCase() ? 'admin' : 'publisher';
  }
  config.set({ publisherKey: seal(key), publisherSource: sourceId(src), publisherName: name, publisherRole: role });
  return status();
}

function logout() {
  config.set({ publisherKey: '', publisherSource: '', publisherName: '', publisherRole: '' });
  return status();
}

function requireKey() {
  const key = savedKey();
  if (!key) throw new Error('Zaloguj się kluczem dostępu w Ustawieniach, aby publikować ogłoszenia.');
  return key;
}

async function publish(data) {
  const src = source();
  if (!src) throw new Error('Nie ustawiono źródła ogłoszeń (Ustawienia → Ogłoszenia launchera).');
  const key = requireKey();

  if (src.type === 'server') {
    const res = await serverApi(src, 'POST', '/v1/announcements', { key, body: data });
    return res.announcement;
  }

  const fields = validateAnnouncement(data);
  const entry = {
    id: crypto.randomBytes(5).toString('hex'),
    ...fields,
    author: config.get().publisherName,
    createdAt: new Date().toISOString(),
  };
  await githubMutate(src, key, (list) => prune([...list, entry]), COMMIT_MESSAGE);
  return toItem(entry, true);
}

async function remove(id) {
  if (!/^[a-f0-9]{4,32}$/.test(String(id))) throw new Error('Niepoprawne id ogłoszenia.');
  const src = source();
  if (!src) throw new Error('Nie ustawiono źródła ogłoszeń.');
  const key = requireKey();

  if (src.type === 'server') {
    await serverApi(src, 'DELETE', `/v1/announcements/${id}`, { key });
    return;
  }

  const cfg = config.get();
  await githubMutate(
    src,
    key,
    (list) => {
      const entry = list.find((a) => a.id === id);
      if (!entry) throw new Error('Nie znaleziono ogłoszenia (mogło już zostać usunięte).');
      if (cfg.publisherRole !== 'admin' && entry.author !== cfg.publisherName) {
        throw new Error('Możesz usuwać tylko własne ogłoszenia.');
      }
      return list.filter((a) => a.id !== id);
    },
    COMMIT_MESSAGE,
  );
}

module.exports = { fetchItems, status, login, logout, publish, remove, baseUrl, source, githubApi, savedKey, COMMIT_MESSAGE };
