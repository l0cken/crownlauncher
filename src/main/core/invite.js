const crypto = require('crypto');
const config = require('./config');
const appConfig = require('./app-config');
const { seal, unseal } = require('./auth');
const { USER_AGENT } = require('./util');

/**
 * Klucz zaproszenia - prywatna dystrybucja launchera (serwer w trybie INVITE_ONLY, patrz server/server.js).
 *
 * Launcher z INVITE_REQUIRED=true w app-config.js:
 *  - przy pierwszym uruchomieniu prosi o klucz (dostajesz go od administratora), sprawdza go na serwerze
 *    i zapisuje zaszyfrowany (DPAPI),
 *  - dokłada go (nagłówek X-Crown-Invite) do aktualizacji, ogłoszeń, peleryn i listy blokad,
 *  - nie uruchomi gry bez ważnego klucza.
 *
 * Uczciwie: blokada po stronie launchera zatrzymuje przypadkowe użycie wyniesionego instalatora; kto zmodyfikuje
 * sam launcher, ją ominie. Prawdziwą bramką jest serwer - bez zaproszenia nie wyda instalatora ani aktualizacji.
 *
 * Klucz jest wysyłany wyłącznie do serwera, dla którego go wpisano (porównujemy adres), więc podmiana
 * „Adresu serwera ogłoszeń” w ustawieniach nie wyda go na obcy adres.
 */

const TIMEOUT_MS = 8000;
const CHECK_TIMEOUT_MS = 5000; // sprawdzenie przy starcie gry nie może jej długo wstrzymywać
const RETRY_AFTER_FAIL_MS = 5 * 60 * 1000; // bez sieci nie pytamy przy każdym starcie

let lastFailAt = 0;
let lostListener = null; // wołany od razu, gdy serwer odmówi klucza (interfejs ma wtedy natychmiast wrócić do ekranu z kluczem)
const RECHECK_MS = 6 * 60 * 60 * 1000; // domyślna częstotliwość pytania serwera, czy klucz nadal jest ważny
// tyle najdłużej trwa, zanim otwarty launcher zauważy unieważnienie klucza albo zwolnienie komputera
// (CROWN_INVITE_WATCH_MS skraca to w testach); dodatkowo sprawdzamy przy wejściu do okna launchera
const WATCH_MS = Math.max(1000, Number(process.env.CROWN_INVITE_WATCH_MS) || 60 * 1000);
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // bez sieci gra działa jeszcze tyle od ostatniego potwierdzenia

const normalize = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CROWN/, '');

/** Adres serwera wbudowany w launcher (tryb serwera), albo '' gdy launcher używa GitHuba. */
function builtinServer() {
  if (String(appConfig.GITHUB_REPO || '').trim()) return '';
  const raw = String(appConfig.ANNOUNCEMENTS_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** Czy ta wersja launchera wymaga zaproszenia (prywatna dystrybucja z własnego serwera). */
function required() {
  return appConfig.INVITE_REQUIRED === true && Boolean(builtinServer());
}

/** Zapisany klucz, jeśli jest dla tego serwera i nie został unieważniony; inaczej ''. */
function key() {
  const cfg = config.get();
  if (!cfg.inviteKey || !cfg.inviteOrigin) return '';
  const server = builtinServer();
  if (!server || cfg.inviteOrigin !== originOf(server)) return '';
  return unseal(cfg.inviteKey);
}

/**
 * Losowy identyfikator tej instalacji, zapisany zaszyfrowany (DPAPI - przepisanie config.json na inny komputer nie
 * przenosi go). Serwer wiąże klucz zaproszenia z pierwszym takim identyfikatorem: na innym komputerze ten sam klucz
 * nie zadziała.
 */
function deviceId() {
  const cfg = config.get();
  let id = cfg.deviceId ? unseal(cfg.deviceId) : '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
    id = crypto.randomBytes(24).toString('base64url');
    config.set({ deviceId: seal(id) });
  }
  return id;
}

/** Nagłówki z kluczem i identyfikatorem komputera - tylko dla adresów tego samego serwera, dla którego klucz wpisano. */
// Co ten launcher rozumie (nagłówek X-Crown-Features):
//  - event   - kody wydarzeń (tryb ograniczony); serwer nie wpuści kodu do starszych launcherów,
//  - release - „Zwolnij” w panelu: po odłączeniu komputera serwer odmawia, launcher pokazuje ekran z kluczem, a
//              ponowne wpisanie klucza (nagłówek X-Crown-Entry) przyłącza komputer z powrotem.
const FEATURES = 'event,release';

function headersFor(url) {
  const cfg = config.get();
  if (!cfg.inviteKey || !cfg.inviteOrigin || originOf(url) !== cfg.inviteOrigin) return {};
  const k = key();
  if (!k) return {};
  try {
    return { 'X-Crown-Invite': k, 'X-Crown-Device': deviceId(), 'X-Crown-Features': FEATURES };
  } catch {
    return { 'X-Crown-Invite': k }; // bez DPAPI nie ma jak zapisać identyfikatora - zostaje tryb zgodności
  }
}

/** `entry` - gracz właśnie sam wpisał klucz (a nie okresowe sprawdzenie): serwer przyłącza wtedy zwolniony komputer. */
async function ask(base, inviteKey, timeout = TIMEOUT_MS, { entry = false } = {}) {
  const res = await fetch(`${base}/v1/invite`, {
    headers: {
      'User-Agent': USER_AGENT,
      'X-Crown-Invite': inviteKey,
      'X-Crown-Device': deviceId(),
      'X-Crown-Features': FEATURES,
      ...(entry ? { 'X-Crown-Entry': '1' } : {}),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 401) {
    // serwer odróżnia klucz nieznany/unieważniony od wygasłego i mówi to wprost
    const body = await res.json().catch(() => ({}));
    return { ok: false, revoked: true, message: String(body.error || '') };
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, usedElsewhere: true, message: String(body.error || '') };
  }
  if (res.status === 429) throw new Error('Zbyt wiele prób. Spróbuj za minutę.');
  if (!res.ok) throw new Error(`Serwer zaproszeń odpowiada błędem (HTTP ${res.status}).`);
  const body = await res.json().catch(() => ({}));
  return { ok: true, name: String(body.name || ''), profile: String(body.profile || ''), capes: body.capes === true, disableClient: body.disableClient === true };
}

/**
 * Nagłówki dla plików wydarzenia: kod wydarzenia, gdy jest głównym kluczem albo został wpisany osobno.
 * Klucz idzie wyłącznie do serwera, dla którego go wpisano (jak w headersFor).
 */
function eventHeaders(eventId, url) {
  const cfg = config.get();
  if ((cfg.inviteProfile || '') === eventId) return headersFor(url);
  const sealed = cfg.eventKeys && cfg.eventKeys[eventId];
  if (!sealed || !cfg.inviteOrigin || originOf(url) !== cfg.inviteOrigin) return {};
  const k = unseal(sealed);
  if (!k) return {};
  try {
    return { 'X-Crown-Invite': k, 'X-Crown-Device': deviceId(), 'X-Crown-Features': FEATURES };
  } catch {
    return { 'X-Crown-Invite': k };
  }
}

/** Wpisanie klucza: sprawdza go na serwerze i zapisuje zaszyfrowany. */
async function submit(raw) {
  const base = builtinServer();
  if (!required() || !base) throw new Error('Ten launcher nie wymaga klucza zaproszenia.');
  const norm = normalize(raw);
  if (norm.length < 12) throw new Error('Wpisz klucz zaproszenia w formacie CROWN-XXXX-XXXX-XXXX-XXXX.');
  let result;
  try {
    result = await ask(base, norm, undefined, { entry: true }); // jawne wpisanie klucza - przyłącza też zwolniony komputer
  } catch (e) {
    if (e.name === 'TimeoutError' || /fetch failed/i.test(e.message)) {
      throw new Error('Brak połączenia z serwerem zaproszeń. Sprawdź internet i spróbuj ponownie.');
    }
    throw e;
  }
  if (result.usedElsewhere) {
    throw new Error(result.message || 'Ten klucz został już użyty na innym komputerze. Poproś administratora o nowy klucz.');
  }
  if (!result.ok) throw new Error(result.message || 'Nieprawidłowy lub unieważniony klucz zaproszenia.');
  config.set({ inviteKey: seal(norm), inviteOrigin: originOf(base), inviteName: result.name, inviteCheckedAt: Date.now(), inviteLost: '', inviteProfile: result.profile || '', inviteCapes: result.capes === true, inviteDisableClient: result.disableClient === true });
  return status();
}

/** Usuwa klucz z launchera. `lost` - powód pokazywany na ekranie blokady (np. serwer odmówił: unieważniony/wygasły). */
function clear(lost = '') {
  config.set({ inviteKey: '', inviteOrigin: '', inviteName: '', inviteCheckedAt: 0, inviteLost: lost, inviteProfile: '', inviteCapes: false, inviteDisableClient: false });
  return status();
}

/**
 * Stan do interfejsu. `check` pyta serwer, jeśli ostatnie potwierdzenie jest starsze niż `maxAgeMs` (domyślnie
 * RECHECK_MS; 0 = zawsze); unieważniony klucz jest od razu usuwany, a brak sieci nie blokuje (do OFFLINE_GRACE_MS
 * od ostatniego potwierdzenia).
 */
async function status({ check = false, maxAgeMs = RECHECK_MS } = {}) {
  if (!required()) return { required: false, active: false, name: '' };
  let cfg = config.get();
  if (check && key() && Date.now() - (cfg.inviteCheckedAt || 0) > maxAgeMs && Date.now() - lastFailAt > RETRY_AFTER_FAIL_MS) {
    try {
      const r = await ask(builtinServer(), key(), CHECK_TIMEOUT_MS);
      if (r.ok) config.set({ inviteCheckedAt: Date.now(), inviteName: r.name || cfg.inviteName, inviteProfile: r.profile || '', inviteCapes: r.capes === true, inviteDisableClient: r.disableClient === true });
      else {
        clear(r.message || 'Twój klucz zaproszenia został unieważniony albo wygasł.');
        try {
          lostListener?.();
        } catch {
          /* powiadomienie interfejsu nie może przerwać sprawdzenia */
        }
      }
    } catch {
      lastFailAt = Date.now(); // brak sieci: ważne do końca okresu łaski
    }
    cfg = config.get();
  }
  const fresh = Date.now() - (cfg.inviteCheckedAt || 0) <= OFFLINE_GRACE_MS;
  const out = { required: true, active: Boolean(key()) && fresh, name: cfg.inviteName || '' };
  if (!out.active && cfg.inviteLost) out.lost = cfg.inviteLost;
  if (out.active && cfg.inviteProfile) out.profile = cfg.inviteProfile; // klucz-kod wydarzenia: tryb ograniczony
  return out;
}

/**
 * Czy ten launcher może używać peleryn (sekcja „Peleryny” w zakładce Skiny): w prywatnej dystrybucji tylko klucz z
 * dostępem do peleryn (nadaje go administrator w panelu; serwer i tak odrzuci wgranie peleryny bez niego). Launcher
 * bez kluczy zaproszeń (tryb GitHub, testy) nie ma tego ograniczenia.
 */
function capesAllowed() {
  if (!required()) return true;
  return Boolean(key()) && config.get().inviteCapes === true;
}

/**
 * Czy ten launcher może wyłączyć „Peleryny i korona w grze” (przełącznik w Ustawieniach; wyłączone = bez korony CrownClient
 * przed nickiem i bez peleryn z launchera): tylko klucz z takim dostępem (nadaje go administrator w panelu). Bez zaproszeń
 * (tryb GitHub, testy) nikt tego nie nadaje, więc peleryny i korona są zawsze włączone.
 */
function cosmeticsOffAllowed() {
  return required() && Boolean(key()) && config.get().inviteDisableClient === true;
}

/** Czy peleryny i korona mają być wyłączone w grze: gracz z dostępem wyłączył je w Ustawieniach (u pozostałych zawsze włączone). */
function cosmeticsOff() {
  return cosmeticsOffAllowed() && config.get().cosmetics === false;
}

/** Rzuca czytelny błąd, gdy launcher wymaga zaproszenia, a go nie ma (start gry). */
async function assertAllowed() {
  // przy każdym starcie gry pytamy serwer (unieważniony klucz nie uruchomi już gry); bez sieci działa okres łaski
  const s = await status({ check: true, maxAgeMs: 0 });
  if (s.required && !s.active) {
    throw new Error('Ten launcher jest tylko dla zaproszonych graczy. Wpisz klucz zaproszenia (Ustawienia → Zaproszenie).');
  }
}

/** Rejestruje funkcję wołaną, gdy serwer odmówi klucza (unieważniony, wygasły, zwolniony komputer). */
const onLost = (fn) => {
  lostListener = fn;
};

module.exports = { required, key, headersFor, eventHeaders, ask, deviceId, submit, clear, status, assertAllowed, capesAllowed, cosmeticsOffAllowed, cosmeticsOff, builtinServer, normalize, onLost, WATCH_MS };
