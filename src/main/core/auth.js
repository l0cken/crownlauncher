const crypto = require('crypto');
const config = require('./config');
const appConfig = require('./app-config');
const { fetchRetry } = require('./util');

const SCOPE = 'XboxLive.signin offline_access';
const MS_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

// Wbudowane logowanie (bez własnej aplikacji w Azure): ten sam przepływ kodem urządzenia i publiczne
// Client ID oficjalnego launchera Minecrafta, których używał mod Account Switcher. Własny Client ID
// (Ustawienia → Konta → Skonfiguruj albo MS_CLIENT_ID w app-config.js) ma pierwszeństwo.
const LIVE_CLIENT_ID = '00000000402b5328';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const LIVE_DEVICE_URL = 'https://login.live.com/oauth20_connect.srf';
const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

// ---- sekrety (tokeny) szyfrowane przez safeStorage Electrona, gdy dostępne ----

// safeStorage istnieje tylko w procesie Electrona (w samym Node `require('electron')` zwraca ścieżkę do pliku)
function safeStorage() {
  try {
    return require('electron').safeStorage || null;
  } catch {
    return null;
  }
}

function seal(text) {
  if (!text) return '';
  const storage = safeStorage();
  if (storage?.isEncryptionAvailable()) {
    return `enc:${storage.encryptString(text).toString('base64')}`;
  }
  // W aplikacji nigdy nie zostawiamy tokenów w config.json jawnym tekstem (base64 to nie szyfrowanie):
  // config.json bywa wklejany w czacie „po pomoc”, kopiowany do chmury i do kopii zapasowych.
  if (storage) throw new Error('Szyfrowanie tokenów (DPAPI w Windows, pęk kluczy w Linuksie) jest niedostępne - nie zapisuję tokenu jawnym tekstem.');
  return `raw:${Buffer.from(text, 'utf8').toString('base64')}`; // tylko poza Electronem (testy w samym Node)
}

/**
 * Linux bez menedżera haseł (gnome-libsecret, KWallet - np. goły i3/sway albo sesja bez keyringa): Electron nie ma wtedy czym
 * zaszyfrować tokenów i `isEncryptionAvailable()` zwraca false, więc launcher nie zapisałby klucza zaproszenia ani identyfikatora
 * komputera. `setUsePlainTextEncryption` każe użyć wtedy klucza wbudowanego w Electrona - to zaciemnienie, nie ochrona przed
 * programem tego samego użytkownika (DPAPI też jej nie daje), ale config.json nie zawiera czytelnych tokenów, gdy ktoś go wklei
 * w czacie albo skopiuje do chmury. Wołać po `app.whenReady()`, przed pierwszym szyfrowaniem. Poza Linuksem nic nie robi.
 * Zwraca rodzaj magazynu: 'dpapi' | 'keychain' | 'keyring' | 'basic' | 'none'.
 */
function prepareStorage(platform = process.platform) {
  const storage = safeStorage();
  storageKindValue = 'none';
  if (!storage) return storageKindValue;
  try {
    if (platform === 'win32') storageKindValue = storage.isEncryptionAvailable() ? 'dpapi' : 'none';
    else if (platform === 'darwin') storageKindValue = storage.isEncryptionAvailable() ? 'keychain' : 'none';
    else {
      const backend = typeof storage.getSelectedStorageBackend === 'function' ? storage.getSelectedStorageBackend() : '';
      if ((!storage.isEncryptionAvailable() || backend === 'basic_text') && typeof storage.setUsePlainTextEncryption === 'function') {
        storage.setUsePlainTextEncryption(true);
      }
      if (storage.isEncryptionAvailable()) storageKindValue = backend === 'basic_text' || !backend ? 'basic' : 'keyring';
    }
  } catch {
    storageKindValue = 'none';
  }
  return storageKindValue;
}

let storageKindValue = 'none';
/** Rodzaj magazynu sekretów ustalony przez prepareStorage (do ekranu informacyjnego i diagnostyki). */
const storageKind = () => storageKindValue;

const SEALED = /^(?:enc|raw):/;
const isSealed = (value) => typeof value === 'string' && SEALED.test(value);

function unseal(text) {
  if (!text) return '';
  const [kind, body] = [text.slice(0, 4), text.slice(4)];
  try {
    if (kind === 'enc:') return require('electron').safeStorage.decryptString(Buffer.from(body, 'base64'));
    if (kind === 'raw:') return Buffer.from(body, 'base64').toString('utf8');
  } catch {
    /* uszkodzony wpis */
  }
  return '';
}

/**
 * Przy starcie: sekrety zapisane kiedyś jawnie (`raw:` albo sam tekst - sekrety nicków peleryn) przepisujemy
 * na szyfrowane. Nic nie robi, gdy szyfrowanie jest niedostępne albo wszystko już jest zaszyfrowane.
 */
function migrateSecrets() {
  if (!safeStorage()?.isEncryptionAvailable()) return false;
  const cfg = config.get();
  let changed = false;
  const upgrade = (value, { plainAllowed = false } = {}) => {
    if (typeof value !== 'string' || !value || value.startsWith('enc:')) return value;
    const plain = value.startsWith('raw:') ? unseal(value) : plainAllowed && !isSealed(value) ? value : '';
    if (!plain) return value;
    changed = true;
    return seal(plain);
  };
  const accounts = (cfg.accounts || []).map((a) =>
    a.type === 'microsoft' ? { ...a, accessToken: upgrade(a.accessToken), refreshToken: upgrade(a.refreshToken) } : a,
  );
  const publisherKey = upgrade(cfg.publisherKey);
  const inviteKey = upgrade(cfg.inviteKey);
  const deviceId = upgrade(cfg.deviceId);
  const capeSecrets = {};
  for (const [nick, secret] of Object.entries(cfg.capeSecrets || {})) {
    capeSecrets[nick] = upgrade(secret, { plainAllowed: true });
  }
  if (changed) config.set({ accounts, publisherKey, inviteKey, deviceId, capeSecrets });
  return changed;
}

// ---- konta -------------------------------------------------------------

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5.toString('hex');
}

function toPublic(a) {
  return { id: a.id, type: a.type, username: a.username, uuid: a.uuid };
}

function listPublic() {
  const cfg = config.get();
  return { accounts: cfg.accounts.map(toPublic), selected: cfg.selectedAccount };
}

function addOffline(username) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Nick: 3–16 znaków, tylko litery, cyfry i podkreślnik.');
  }
  const cfg = config.get();
  const existing = cfg.accounts.find((a) => a.type === 'offline' && a.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    config.set({ selectedAccount: existing.id });
    return toPublic(existing);
  }
  const account = { id: crypto.randomUUID(), type: 'offline', username, uuid: offlineUuid(username) };
  config.set({ accounts: [...cfg.accounts, account], selectedAccount: account.id });
  return toPublic(account);
}

function remove(id) {
  const cfg = config.get();
  const accounts = cfg.accounts.filter((a) => a.id !== id);
  const selected = cfg.selectedAccount === id ? accounts[0]?.id || null : cfg.selectedAccount;
  config.set({ accounts, selectedAccount: selected });
}

function select(id) {
  if (!config.get().accounts.some((a) => a.id === id)) throw new Error('Nie znaleziono konta.');
  config.set({ selectedAccount: id });
}

// ---- Microsoft / Xbox / Minecraft --------------------------------------

async function postJson(url, body, headers = {}) {
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* pusta odpowiedź */
  }
  if (!res.ok) {
    const err = new Error(json.XErr ? `XErr ${json.XErr}` : `HTTP ${res.status}`);
    err.xerr = json.XErr;
    err.status = res.status;
    err.detail = json.errorMessage || json.error || '';
    throw err;
  }
  return json;
}

async function postForm(url, params) {
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const XERR_HINTS = {
  2148916233: 'To konto Microsoft nie ma profilu Xbox. Utwórz go na xbox.com i spróbuj ponownie.',
  2148916235: 'Xbox Live jest niedostępny w Twoim kraju.',
  2148916236: 'Konto wymaga weryfikacji wieku (Xbox).',
  2148916237: 'Konto wymaga weryfikacji wieku (Xbox).',
  2148916238: 'To konto dziecka - dodaj je do rodziny Microsoft, aby grać.',
};

/**
 * Token Microsoft -> Xbox Live -> XSTS -> Minecraft. `flow`: 'azure' (własna aplikacja, bilet "d=<token>")
 * albo 'live' (wbudowane logowanie przez login.live.com, bilet bez przedrostka).
 */
async function minecraftFromMicrosoftToken(msAccessToken, flow = 'azure') {
  try {
    const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: flow === 'live' ? msAccessToken : `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    });
    const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
    const uhs = xbl.DisplayClaims.xui[0].uhs;
    const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
    });
    const profileRes = await fetchRetry('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mc.access_token}` },
    });
    if (profileRes.status === 404) throw new Error('To konto nie posiada Minecraft: Java Edition.');
    if (!profileRes.ok) throw new Error(`Profil Minecraft: HTTP ${profileRes.status}`);
    const profile = await profileRes.json();
    return {
      accessToken: mc.access_token,
      expiresAt: Date.now() + (mc.expires_in - 60) * 1000,
      uuid: profile.id,
      username: profile.name,
    };
  } catch (e) {
    if (e.xerr && XERR_HINTS[e.xerr]) throw new Error(XERR_HINTS[e.xerr]);
    // Mojang wymaga zatwierdzenia aplikacji Azure formularzem - bez tego login_with_xbox zwraca 403
    if (e.status === 403 && /app registration|AppRegInfo/i.test(e.detail || '')) {
      throw new Error(
        'Mojang nie zatwierdził jeszcze aplikacji tego launchera. Wypełnij formularz https://aka.ms/AppRegInfo i poczekaj na akceptację (zwykle kilka dni roboczych) - do tego czasu używaj konta offline.',
      );
    }
    throw e;
  }
}

// ---- konfiguracja aplikacji Azure (Client ID) -----------------------------------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client ID: własny z ustawień (nadpisuje) albo wbudowany w launcher (app-config.js). */
function clientId() {
  return (config.get().msClientId || appConfig.MS_CLIENT_ID || '').trim();
}

function msStatus() {
  const own = (config.get().msClientId || '').trim();
  const builtin = (appConfig.MS_CLIENT_ID || '').trim();
  // bez własnego Client ID działa wbudowane logowanie ('launcher'), więc zawsze jest skonfigurowane
  return {
    configured: true,
    source: own ? 'user' : builtin ? 'builtin' : 'launcher',
  };
}

/** Zamienia błąd z endpointu devicecode na zrozumiałą wskazówkę, co poprawić w Azure. */
function explainDeviceCodeError(json = {}) {
  const text = `${json.error || ''} ${json.error_description || ''}`;
  if (/AADSTS700016|AADSTS700038|was not found in the directory|not a valid application identifier/i.test(text)) {
    return 'Nie znaleziono aplikacji o tym Client ID. Skopiuj „Application (client) ID” ze strony Overview swojej aplikacji w Azure.';
  }
  if (/AADSTS7000218|AADSTS70002\b|AADSTS7000215|client_secret|client_assertion|must be marked as mobile/i.test(text)) {
    return 'Aplikacja nie ma włączonych „Allow public client flows”. W Azure: Authentication → Advanced settings → Allow public client flows = Yes → Save.';
  }
  if (/AADSTS50194|AADSTS700025|personal|consumers|AADSTS9002331/i.test(text)) {
    return 'Aplikacja musi obsługiwać konta osobiste Microsoft („Personal Microsoft accounts only” albo „…and personal Microsoft accounts”).';
  }
  if (/AADSTS65001|consent/i.test(text)) {
    return 'Brak zgody dla zakresu XboxLive.signin - w Azure dodaj uprawnienie XboxLive.signin (Microsoft Graph nie jest potrzebny).';
  }
  return json.error_description ? json.error_description.split('\r\n')[0] : 'Nie udało się rozpocząć logowania Microsoft.';
}

/**
 * Błąd z endpointu tokenu w trakcie logowania kodem urządzenia - po polsku i z podpowiedzią, co zrobić.
 * Najczęstszy: Microsoft kończy logowanie komunikatem „user interaction is required” (konto wymaga dodatkowego
 * kroku, który nie dokończył się w przeglądarce) - wcześniej gracz widział tylko angielski tekst bez wskazówek.
 */
function explainTokenError(json = {}) {
  const code = String(json.error || '');
  const first = String(json.error_description || '').split('\r\n')[0];
  const text = `${code} ${first}`;
  if (/interaction_required|user interaction is required|could not be authenticated|must sign in again/i.test(text)) {
    return (
      'Microsoft przerwał logowanie tego konta - wymaga dodatkowego kroku w przeglądarce. Spróbuj jeszcze raz w oknie ' +
      'prywatnym: zaloguj się kontem osobistym, które ma Minecraft: Java Edition, i przejdź wszystkie ekrany do końca ' +
      '(weryfikacja, zgoda). Jeśli konto prosi o weryfikację, dokończ ją najpierw na account.microsoft.com. ' +
      `(kod: ${code || 'interaction_required'})`
    );
  }
  if (/invalid_grant/i.test(code)) {
    return `Ten kod logowania został już użyty albo wygasł. Uruchom logowanie od nowa i wpisz nowy kod. (kod: ${code})`;
  }
  return first || code || 'Logowanie nie powiodło się.';
}

/** Sprawdza Client ID bez logowania: prosi Microsoft o kod urządzenia (nie jest potem używany). */
async function checkClientId(id) {
  id = String(id || '').trim();
  if (!GUID_RE.test(id)) {
    throw new Error('Client ID to identyfikator w formacie 00000000-0000-0000-0000-000000000000.');
  }
  const { json, status } = await postForm(`${MS_BASE}/devicecode`, { client_id: id, scope: SCOPE });
  if (status !== 200 || !json.device_code) throw new Error(explainDeviceCodeError(json));
  return { ok: true };
}

/**
 * Logowanie kodem urządzenia. `onCode({userCode, verificationUri})` informuje UI,
 * `signal.cancelled` pozwala przerwać oczekiwanie.
 */
async function loginMicrosoft(onCode, signal = {}) {
  const id = clientId();
  if (!id) return loginLive(onCode, signal);
  const { json: dc, status } = await postForm(`${MS_BASE}/devicecode`, { client_id: id, scope: SCOPE });
  if (status !== 200) throw new Error(explainDeviceCodeError(dc));
  onCode({
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    expiresIn: dc.expires_in,
  });

  const deadline = Date.now() + dc.expires_in * 1000;
  let interval = (dc.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal.cancelled) throw new Error('Logowanie anulowane.');
    const { json } = await postForm(`${MS_BASE}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: id,
      device_code: dc.device_code,
    });
    if (json.access_token) {
      const mc = await minecraftFromMicrosoftToken(json.access_token);
      return saveMicrosoftAccount(mc, json.refresh_token);
    }
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (json.error === 'authorization_declined') throw new Error('Odrzucono logowanie po stronie Microsoft.');
    if (json.error === 'expired_token') throw new Error('Kod wygasł. Spróbuj ponownie.');
    throw new Error(explainTokenError(json));
  }
  throw new Error('Kod wygasł. Spróbuj ponownie.');
}

/** Wbudowane logowanie kodem urządzenia (login.live.com) - bez rejestracji aplikacji w Azure. */
async function loginLive(onCode, signal = {}) {
  const { json: dc, status } = await postForm(LIVE_DEVICE_URL, {
    client_id: LIVE_CLIENT_ID,
    scope: LIVE_SCOPE,
    response_type: 'device_code',
  });
  if (status !== 200 || !dc.device_code) {
    throw new Error(dc.error_description?.split('\r\n')[0] || 'Nie udało się rozpocząć logowania Microsoft.');
  }
  const expiresIn = Number(dc.expires_in) || 900;
  onCode({
    userCode: dc.user_code,
    verificationUri: dc.verification_uri || 'https://www.microsoft.com/link',
    expiresIn,
  });

  const deadline = Date.now() + expiresIn * 1000;
  let interval = Math.max(1, Number(dc.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal.cancelled) throw new Error('Logowanie anulowane.');
    const { json } = await postForm(LIVE_TOKEN_URL, {
      client_id: LIVE_CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.device_code,
    });
    if (json.access_token) {
      const mc = await minecraftFromMicrosoftToken(json.access_token, 'live');
      return saveMicrosoftAccount(mc, json.refresh_token, 'live');
    }
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (json.error === 'authorization_declined') throw new Error('Odrzucono logowanie po stronie Microsoft.');
    if (json.error === 'expired_token' || json.error === 'bad_verification_code') throw new Error('Kod wygasł. Spróbuj ponownie.');
    throw new Error(explainTokenError(json));
  }
  throw new Error('Kod wygasł. Spróbuj ponownie.');
}

function saveMicrosoftAccount(mc, refreshToken, flow = 'azure') {
  const cfg = config.get();
  const stored = {
    id: crypto.randomUUID(),
    type: 'microsoft',
    username: mc.username,
    uuid: mc.uuid,
    accessToken: seal(mc.accessToken),
    refreshToken: seal(refreshToken),
    expiresAt: mc.expiresAt,
    authFlow: flow, // którym przepływem odświeżamy sesję: 'live' (wbudowany) albo 'azure' (własna aplikacja)
  };
  const previous = cfg.accounts.find((a) => a.type === 'microsoft' && a.uuid === mc.uuid);
  if (previous) stored.id = previous.id;
  const accounts = [...cfg.accounts.filter((a) => a.id !== stored.id), stored];
  config.set({ accounts, selectedAccount: stored.id });
  return toPublic(stored);
}

/** Zwraca konto gotowe do uruchomienia gry (z odświeżonym tokenem, jeśli trzeba). */
async function getLaunchAccount() {
  const cfg = config.get();
  const account = cfg.accounts.find((a) => a.id === cfg.selectedAccount);
  if (!account) throw new Error('Dodaj konto w Ustawieniach, zanim uruchomisz grę.');
  if (account.type === 'offline') return { ...account };

  if (account.expiresAt > Date.now() && account.accessToken) {
    return { ...account, accessToken: unseal(account.accessToken) };
  }
  const refresh = unseal(account.refreshToken);
  const flow = account.authFlow || 'azure';
  if (!refresh || (flow === 'azure' && !clientId())) {
    throw new Error('Sesja Microsoft wygasła - zaloguj się ponownie w Ustawieniach.');
  }
  const { json } =
    flow === 'live'
      ? await postForm(LIVE_TOKEN_URL, {
          client_id: LIVE_CLIENT_ID,
          scope: LIVE_SCOPE,
          grant_type: 'refresh_token',
          refresh_token: refresh,
        })
      : await postForm(`${MS_BASE}/token`, {
          grant_type: 'refresh_token',
          client_id: clientId(),
          refresh_token: refresh,
          scope: SCOPE,
        });
  if (!json.access_token) throw new Error('Sesja Microsoft wygasła - zaloguj się ponownie w Ustawieniach.');
  const mc = await minecraftFromMicrosoftToken(json.access_token, flow);
  saveMicrosoftAccount(mc, json.refresh_token || refresh, flow);
  return { ...account, ...mc, type: 'microsoft' };
}

module.exports = {
  listPublic,
  addOffline,
  remove,
  select,
  loginMicrosoft,
  msStatus,
  checkClientId,
  explainDeviceCodeError,
  explainTokenError,
  getLaunchAccount,
  seal,
  unseal,
  isSealed,
  migrateSecrets,
  prepareStorage,
  storageKind,
};
