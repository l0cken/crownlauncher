const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const auth = require('./auth');
const config = require('./config');
const { fetchRetry, readJson, writeJson, USER_AGENT } = require('./util');

const MC_API = 'https://api.minecraftservices.com';
const MAX_PNG_BYTES = 200 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const VARIANTS = ['classic', 'slim'];

// ---- walidacja PNG -----------------------------------------------------

/** Sprawdza, czy bufor to skin Minecrafta (PNG 64x64 albo starszy 64x32). */
function validateSkinPng(buf) {
  if (buf.length > MAX_PNG_BYTES) throw new Error('Plik skina jest za duży (maks. 200 KB).');
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('To nie jest plik PNG.');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`Skin musi mieć wymiary 64×64 lub 64×32 px (ten ma ${width}×${height}).`);
  }
  return { width, height };
}

const toDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

function fromDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!m) throw new Error('Niepoprawne dane obrazu.');
  const buf = Buffer.from(m[1], 'base64');
  validateSkinPng(buf);
  return buf;
}

/** Wczytuje skin z pliku na dysku (do importu). */
async function readSkinFile(filePath) {
  if (!/\.png$/i.test(filePath)) throw new Error('Wybierz plik PNG.');
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('Nie znaleziono pliku.');
  if (st.size > MAX_PNG_BYTES) throw new Error('Plik skina jest za duży (maks. 200 KB).');
  const buf = await fsp.readFile(filePath);
  validateSkinPng(buf);
  return { fileName: path.basename(filePath), dataUrl: toDataUrl(buf) };
}

// ---- biblioteka lokalna --------------------------------------------------

async function loadLibrary() {
  try {
    const data = await readJson(paths.skinLibrary());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const saveLibrary = (entries) => writeJson(paths.skinLibrary(), entries);

async function list() {
  const out = [];
  for (const e of await loadLibrary()) {
    try {
      const buf = await fsp.readFile(paths.skinFile(e.id));
      out.push({ ...e, dataUrl: toDataUrl(buf) });
    } catch {
      /* brak pliku - pomiń wpis */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function cleanName(name, fallback = 'Skin') {
  return String(name || '').trim().slice(0, 32) || fallback;
}

async function add({ name, variant, dataUrl }) {
  const buf = fromDataUrl(dataUrl);
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    name: cleanName(name),
    variant: VARIANTS.includes(variant) ? variant : 'classic',
    createdAt: Date.now(),
  };
  await fsp.mkdir(paths.skins(), { recursive: true });
  await fsp.writeFile(paths.skinFile(entry.id), buf);
  const library = await loadLibrary();
  library.push(entry);
  await saveLibrary(library);
  return { ...entry, dataUrl: toDataUrl(buf) };
}

async function update(id, patch) {
  const library = await loadLibrary();
  const entry = library.find((e) => e.id === id);
  if (!entry) throw new Error('Nie znaleziono skina.');
  if ('name' in patch) entry.name = cleanName(patch.name, entry.name);
  if ('variant' in patch && VARIANTS.includes(patch.variant)) entry.variant = patch.variant;
  await saveLibrary(library);
  return entry;
}

async function remove(id) {
  const library = await loadLibrary();
  if (!library.some((e) => e.id === id)) return;
  await saveLibrary(library.filter((e) => e.id !== id));
  await fsp.rm(paths.skinFile(id), { force: true });
}

// ---- API Minecraft Services (konto Microsoft) -------------------------------

async function microsoftToken() {
  const { accounts, selected } = auth.listPublic();
  const current = accounts.find((a) => a.id === selected);
  if (!current || current.type !== 'microsoft') {
    throw new Error('Zmiana skina i peleryny działa tylko dla konta Microsoft.');
  }
  const account = await auth.getLaunchAccount();
  return account.accessToken;
}

async function mc(method, apiPath, token, { json, body } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchRetry(`${MC_API}${apiPath}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 401) throw new Error('Sesja Microsoft wygasła - zaloguj się ponownie w Ustawieniach.');
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).errorMessage || '';
    } catch {
      /* brak treści */
    }
    throw new Error(`Serwery Minecrafta odrzuciły żądanie (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Tekstury pobieramy wyłącznie z oficjalnego hosta Mojang.
async function fetchTexture(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Niepoprawny adres tekstury.');
  }
  if (u.hostname !== 'textures.minecraft.net') throw new Error('Nieoczekiwany host tekstury.');
  u.protocol = 'https:'; // API zwraca adresy http://, host obsługuje HTTPS
  const res = await fetchRetry(u.href);
  if (!res.ok) throw new Error(`Nie udało się pobrać tekstury (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  validateSkinPng(buf);
  return toDataUrl(buf);
}

// ---- oficjalny skin: odczyt i wykrywanie zmian ---------------------------------------------------------
//
// Launcher niczego nie podmienia w grze - skin jest taki, jaki ma konto. Tutaj tylko go CZYTAMY z serwerów
// Minecrafta (profil konta Microsoft; dla konta offline - profil premium o tym samym nicku), razem z modelem
// ramion (classic = Steve, slim = Alex), i porównujemy z tym, co launcher widział ostatnio. Dzięki temu zmiana
// zrobiona w oficjalnym Minecrafcie / na minecraft.net / w innym launcherze od razu jest widoczna tutaj.

const textureId = (url) => String(url || '').split('/').pop() || '';
const modelOf = (variant) => (String(variant || '').toLowerCase() === 'slim' ? 'slim' : 'classic');

/**
 * Model domyślnego skina (gdy konto nie ma własnego): gra wybiera go po UUID - pierwsze 9 z 18 domyślnych
 * skinów ma wąskie ramiona (Alex i spółka), kolejne 9 klasyczne (Steve i spółka).
 */
function defaultModel(uuid) {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return 'classic';
  const hilo = BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`) ^ BigInt(`0x${hex.slice(16)}`));
  const hash = Number(BigInt.asIntN(32, (hilo >> 32n) ^ hilo));
  return ((hash % 18) + 18) % 18 < 9 ? 'slim' : 'classic';
}

const textureCache = new Map(); // id tekstury -> data URL (skiny są niezmienne, więc cache jest bezpieczny)

async function textureDataUrl(url) {
  const id = textureId(url);
  if (textureCache.has(id)) return textureCache.get(id);
  const dataUrl = await fetchTexture(url);
  if (textureCache.size > 32) textureCache.clear();
  textureCache.set(id, dataUrl);
  return dataUrl;
}

/**
 * Porównuje odczyt z ostatnio widzianym (config.skinSeen) i zapisuje nowy stan. `quiet` - zmiana jest naszym
 * dziełem (ustawiliśmy skin z launchera), więc nie zgłaszamy jej jako „zmiana w oficjalnym Minecrafcie”.
 */
function trackChange(key, fingerprint, { quiet = false } = {}) {
  const seen = { ...(config.get().skinSeen || {}) };
  const prev = seen[key] || null;
  const skin = Boolean(prev) && prev.skin !== fingerprint.skin;
  const model = Boolean(prev) && prev.model !== fingerprint.model;
  const cape = Boolean(prev) && prev.cape !== fingerprint.cape;
  if (!prev || skin || model || cape) {
    // zapis tylko przy pierwszym odczycie i przy zmianie - odczyty w tle nie piszą po dysku
    seen[key] = { ...fingerprint, at: Date.now() };
    config.set({ skinSeen: seen });
  }
  if (!prev) return { first: true, any: false, skin: false, model: false, cape: false };
  return {
    first: false,
    skin,
    model,
    cape,
    any: !quiet && (skin || model || cape),
    previousModel: prev.model,
    previousAt: prev.at,
  };
}

async function describeSkin(url, variant, uuid) {
  if (!url) return { skin: null, model: defaultModel(uuid), defaultSkin: true };
  let skin = null;
  try {
    skin = { variant: modelOf(variant), dataUrl: await textureDataUrl(url) };
  } catch {
    skin = null; // model znamy z API, nawet gdy tekstury nie udało się pobrać
  }
  return { skin, model: modelOf(variant), defaultSkin: false };
}

// profil premium po nicku (konto offline): 1 zapytanie na minutę na nick - sesja Mojang ogranicza częstotliwość
const nickCache = new Map();
const NICK_TTL_MS = 60 * 1000;

async function premiumByNick(name) {
  const key = name.toLowerCase();
  const hit = nickCache.get(key);
  if (hit && Date.now() - hit.at < NICK_TTL_MS) return hit.value;

  const idRes = await fetchRetry(`${MC_API}/minecraft/profile/lookup/name/${encodeURIComponent(name)}`);
  let value;
  if (idRes.status === 404 || idRes.status === 204) {
    value = { found: false };
  } else if (!idRes.ok) {
    throw new Error(`Nie udało się wyszukać gracza (HTTP ${idRes.status}).`);
  } else {
    const { id, name: exact } = await idRes.json();
    let profRes;
    try {
      profRes = await fetchRetry(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
    } catch (e) {
      // sesja Mojang ogranicza częstotliwość (HTTP 429) - przy odczycie w tle zostajemy przy ostatnim wyniku
      if (hit) return hit.value;
      throw new Error(/429/.test(e.message) ? 'Mojang ogranicza zapytania - spróbuj za minutę.' : `Nie udało się pobrać profilu (${e.message}).`);
    }
    if (!profRes.ok) throw new Error(`Nie udało się pobrać profilu (HTTP ${profRes.status}).`);
    const profile = await profRes.json();
    const prop = (profile.properties || []).find((p) => p.name === 'textures');
    const textures = prop ? JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {} : {};
    value = {
      found: true,
      id,
      name: exact || name,
      skinUrl: textures.SKIN?.url || '',
      variant: textures.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic',
      capeUrl: textures.CAPE?.url || '',
    };
  }
  nickCache.set(key, { at: Date.now(), value });
  return value;
}

/** Oficjalny skin dla konta offline: skin gracza premium o tym samym nicku (jeśli taki istnieje). */
async function officialByNick(account, { quiet }) {
  let p;
  try {
    p = await premiumByNick(account.username);
  } catch (e) {
    return { error: e.message };
  }
  const key = `offline:${account.username.toLowerCase()}`;
  if (!p.found) {
    const model = defaultModel(account.uuid);
    trackChange(key, { skin: '', model, cape: '' }, { quiet: true });
    return { found: false, model, defaultSkin: true, skin: null, change: { first: false, any: false } };
  }
  const described = await describeSkin(p.skinUrl, p.variant, p.id);
  const change = trackChange(key, { skin: textureId(p.skinUrl), model: described.model, cape: textureId(p.capeUrl) }, { quiet });
  return { found: true, name: p.name, ...described, change };
}

/**
 * Aktualny skin, model ramion i peleryny konta. `quiet: true` - nie zgłaszaj zmiany (używane zaraz po tym,
 * jak launcher sam ustawił skin/pelerynę).
 *
 * Zwraca:
 *  - konto Microsoft: { available, name, skin: {variant, dataUrl}|null, model, defaultSkin, capes, change }
 *  - konto offline:   { available: false, reason: 'offline', name, official: {found, model, skin, change}|{error} }
 */
async function accountProfile({ quiet = false } = {}) {
  const { accounts, selected } = auth.listPublic();
  const current = accounts.find((a) => a.id === selected);
  if (!current) return { available: false, reason: 'Brak konta.' };
  if (current.type !== 'microsoft') {
    return { available: false, reason: 'offline', name: current.username, official: await officialByNick(current, { quiet }) };
  }
  const token = await microsoftToken();
  const profile = await mc('GET', '/minecraft/profile', token);
  const active = (profile.skins || []).find((s) => s.state === 'ACTIVE') || null;
  const described = await describeSkin(active?.url, active?.variant, profile.id);
  const capes = (profile.capes || []).map((c) => ({ id: c.id, alias: c.alias || 'Peleryna', active: c.state === 'ACTIVE' }));
  const change = trackChange(
    current.uuid || profile.id,
    { skin: textureId(active?.url), model: described.model, cape: capes.find((c) => c.active)?.id || '' },
    { quiet },
  );
  return { available: true, name: profile.name, ...described, capes, change, checkedAt: Date.now() };
}

/** Wysyła skin z biblioteki na konto Microsoft. */
async function applyToAccount(id) {
  const library = await loadLibrary();
  const entry = library.find((e) => e.id === id);
  if (!entry) throw new Error('Nie znaleziono skina.');
  const png = await fsp.readFile(paths.skinFile(id));
  validateSkinPng(png);
  const token = await microsoftToken();

  const form = new FormData();
  form.append('variant', entry.variant);
  form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  await mc('POST', '/minecraft/profile/skins', token, { body: form });
}

/** Przywraca domyślny skin konta (usuwa aktywny skin). */
async function resetAccountSkin() {
  await mc('DELETE', '/minecraft/profile/skins/active', await microsoftToken());
}

/** Ustawia pelerynę (capeId) albo ukrywa ją (null). */
async function setCape(capeId) {
  const token = await microsoftToken();
  if (capeId) await mc('PUT', '/minecraft/profile/capes/active', token, { json: { capeId: String(capeId) } });
  else await mc('DELETE', '/minecraft/profile/capes/active', token);
}

// ---- skin dowolnego gracza po nicku ------------------------------------------

async function lookupByName(name) {
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Nick: 1–16 znaków, litery, cyfry i podkreślnik.');

  const p = await premiumByNick(name);
  if (!p.found) throw new Error(`Nie ma gracza o nicku „${name}”.`);
  if (!p.skinUrl) throw new Error(`Gracz „${p.name}” ma domyślny skin (brak własnego do pobrania).`);

  return { name: p.name, variant: p.variant, dataUrl: await textureDataUrl(p.skinUrl) };
}

module.exports = {
  list,
  add,
  update,
  remove,
  readSkinFile,
  accountProfile,
  applyToAccount,
  resetAccountSkin,
  setCape,
  lookupByName,
  validateSkinPng,
};
