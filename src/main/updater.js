const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const config = require('./core/config');
const appConfig = require('./core/app-config');
const announcements = require('./core/announcements');
const invite = require('./core/invite');

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let emit = () => {};
let started = false;
let forceDev = false;
let timer = null;
let installAfterDownload = false; // gracz kliknął „Pobierz”: po pobraniu od razu instalujemy i uruchamiamy
let state = { state: 'idle' }; // idle | checking | available | downloading | ready | none | error | disabled

function setState(next) {
  state = next;
  emit('update:state', state);
}

/** Krótki, zrozumiały komunikat zamiast surowego błędu HTTP z całymi nagłówkami. */
function friendlyError(err) {
  const raw = String(err?.message || err || '');
  // 401 przed „latest.yml”: komunikat electron-updatera o odmowie też zawiera nazwę pliku latest.yml
  if (/\b401\b|Unauthorized/i.test(raw)) {
    return 'Serwer odrzucił klucz zaproszenia — wpisz go ponownie w Ustawieniach (Zaproszenie).';
  }
  if (/latest(?:-linux)?\.yml|HttpError: 404|status code 404|\b404\b/i.test(raw)) {
    return 'Nowa wersja jest właśnie publikowana — spróbuj ponownie za minutę lub dwie.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|net::/i.test(raw)) {
    return 'Brak połączenia z internetem albo serwer aktualizacji jest chwilowo niedostępny.';
  }
  if (/rate limit|status code 403|HTTP 403/i.test(raw)) {
    return 'GitHub chwilowo ogranicza zapytania — spróbuj za kilka minut.';
  }
  const first = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : first || 'Nieznany błąd.';
}

/**
 * Skąd bierzemy aktualizacje:
 *  - repozytorium GitHub → GitHub Releases (provider "github"),
 *  - własny serwer → <serwer>/updates albo UPDATE_URL (provider "generic").
 * Zwraca obiekt dla autoUpdater.setFeedURL albo null, gdy nic nie skonfigurowano.
 */
function feed() {
  const src = announcements.source(); // rzuca czytelny błąd przy niepoprawnym adresie
  if (src?.type === 'github') {
    return { provider: 'github', owner: src.owner, repo: src.repo, releaseType: 'release' };
  }

  let base = String(config.get().updateUrl || appConfig.UPDATE_URL || '').trim();
  if (!base && src?.type === 'server') base = `${src.base}/updates`;
  base = base.replace(/\/+$/, '');
  if (!base) return null;

  const u = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('Adres aktualizacji musi zaczynać się od https:// (http:// tylko dla localhost).');
  }
  return { provider: 'generic', url: base };
}

/** Czytelny opis źródła (do logów i testów). */
function feedUrl() {
  const f = feed();
  if (!f) return '';
  return f.provider === 'github' ? `github:${f.owner}/${f.repo}` : f.url;
}

function configure() {
  autoUpdater.autoDownload = false; // pobieranie rusza po kliknięciu „Pobierz” (potem sama instalacja i start)
  autoUpdater.autoInstallOnAppQuit = true; // pobrana, a niezainstalowana aktualizacja wejdzie przy zamknięciu
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (forceDev) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => setState({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => setState({ state: 'none' }));
  autoUpdater.on('download-progress', (p) =>
    setState({ state: 'downloading', version: state.version, percent: Math.round(p.percent || 0) }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    setState({ state: 'ready', version: info.version });
    if (installAfterDownload) {
      installAfterDownload = false;
      // chwila, żeby interfejs zdążył pokazać „gotowe”; potem cicha instalacja i automatyczny start launchera
      setTimeout(() => {
        try {
          install();
        } catch (e) {
          setState({ state: 'error', error: friendlyError(e) });
        }
      }, 700);
    }
  });
  autoUpdater.on('error', (err) => {
    installAfterDownload = false;
    setState({ state: 'error', error: friendlyError(err) });
  });
}

async function check() {
  if (!app.isPackaged && !forceDev) {
    setState({ state: 'disabled', reason: 'Aktualizacje działają tylko w zainstalowanej wersji launchera.' });
    return state;
  }
  if (state.state === 'downloading' || state.state === 'ready') return state;
  // Linux: electron-updater podmienia plik AppImage; wersja rozpakowana z archiwum / z pakietu nie ma czego podmienić
  if (process.platform === 'linux' && !process.env.APPIMAGE && !forceDev) {
    setState({ state: 'disabled', reason: 'Automatyczne aktualizacje na Linuksie działają tylko w wersji AppImage. Pobierz nową wersję ze strony launchera.' });
    return state;
  }

  let source;
  try {
    source = feed();
  } catch (e) {
    setState({ state: 'error', error: friendlyError(e) });
    return state;
  }
  if (!source) {
    setState({ state: 'disabled', reason: 'Nie ustawiono źródła aktualizacji (repozytorium GitHub lub serwera).' });
    return state;
  }
  try {
    // prywatna dystrybucja: serwer wydaje latest.yml i instalator tylko z kluczem zaproszenia - dokładamy go,
    // ale wyłącznie do tego samego serwera, dla którego został wpisany
    autoUpdater.requestHeaders = source.provider === 'generic' ? invite.headersFor(source.url) : null;
    autoUpdater.setFeedURL(source);
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setState({ state: 'error', error: friendlyError(e) });
  }
  return state;
}

function setEmitter(fn) {
  emit = fn;
}

/** Uruchamia automatyczne sprawdzanie: krótko po starcie i co kilka godzin. */
function start({ force = false } = {}) {
  if (started) return;
  started = true;
  forceDev = force;
  configure();
  setTimeout(() => {
    check();
    timer = setInterval(check, CHECK_EVERY_MS);
    timer.unref?.();
  }, FIRST_CHECK_MS).unref?.();
}

function install() {
  if (state.state !== 'ready') throw new Error('Aktualizacja nie jest jeszcze pobrana.');
  // isSilent = true (bez okna instalatora), isForceRunAfter = true (uruchom launcher ponownie)
  autoUpdater.quitAndInstall(true, true);
}

/**
 * „Pobierz”: pobiera znalezioną aktualizację, a po pobraniu sama ją instaluje i uruchamia nową wersję.
 * Gdy aktualizacja jest już pobrana, od razu instaluje.
 */
async function download() {
  if (state.state === 'ready') {
    install();
    return state;
  }
  if (state.state === 'downloading') return state;
  if (state.state !== 'available') throw new Error('Nie ma aktualizacji do pobrania. Najpierw sprawdź aktualizacje.');

  installAfterDownload = true;
  setState({ state: 'downloading', version: state.version, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    installAfterDownload = false;
    setState({ state: 'error', error: friendlyError(e) });
  }
  return state;
}

module.exports = { start, check, install, download, setEmitter, getState: () => state, feedUrl };
