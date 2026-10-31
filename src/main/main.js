const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');

app.setName('CrownLauncher');

// Utwardzenie zainstalowanej wersji (CROWN_HARDEN=1 włącza je też przy `electron .` - do testów): bez narzędzi
// deweloperskich (konsola pozwalałaby wołać kanały launchera i oglądać interfejs), bez domyślnego menu ze skrótami
// (Ctrl+Shift+I, Ctrl+R…), bez osadzonych webview. To ochrona przed zwykłym graczem - nie przed kimś, kto zmodyfikuje
// pliki aplikacji.
const HARDEN = app.isPackaged || process.env.CROWN_HARDEN === '1';

// Zdalne debugowanie (Chrome DevTools Protocol) pozwoliłoby obejrzeć interfejs i wołać kanały launchera, więc
// zainstalowana wersja nie startuje z takimi flagami. Wyjątek: build testowy (CROWN_DEBUG_BUILD=1 przy budowaniu
// wpisuje znacznik do package.json wewnątrz app.asar, którego nie da się zmienić bez złamania sumy kontrolnej).
const DEBUG_SWITCH = /^--(remote-debugging-(port|pipe|address)|remote-allow-origins|inspect(-brk|-port)?)(=|$)/;
if (app.isPackaged && !require('../../package.json').crownDebugBuild && process.argv.some((a) => DEBUG_SWITCH.test(a))) {
  process.exit(1);
}

const paths = require('./core/paths');
paths.init(app.getPath('userData'));

const { register } = require('./ipc');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0d0e12',
    title: 'CrownLauncher',
    icon: path.join(__dirname, '../../assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !HARDEN,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // linki z zewnątrz zawsze w przeglądarce systemowej
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Okno nie ma menu, więc F5 / Ctrl+R (z Shift = z pominięciem cache) obsługujemy sami.
  // Odświeżenie pobiera też od nowa newsy i ogłoszenia (w procesie głównym mają krótki cache).
  if (HARDEN) {
    // gdyby jakimś sposobem otwarto narzędzia (np. skrót), zamykamy je od razu
    mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
  }
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (HARDEN) {
      const k = String(input.key).toLowerCase();
      const devKeys = input.key === 'F12' || ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(k)) || ((input.control || input.meta) && k === 'u');
      if (devKeys) {
        event.preventDefault();
        return;
      }
    }
    const isReload = input.key === 'F5' || ((input.control || input.meta) && String(input.key).toLowerCase() === 'r');
    if (!isReload) return;
    event.preventDefault();
    require('./core/news').invalidate();
    if (input.shift) mainWindow.webContents.reloadIgnoringCache();
    else mainWindow.webContents.reload();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // żadnych osadzonych stron (webview) - launcher ładuje wyłącznie własny interfejs
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(() => {
    if (HARDEN) Menu.setApplicationMenu(null); // domyślne menu Electrona ma m.in. „Przełącz narzędzia deweloperskie”
    // dawne sekrety zapisane jawnie (jeśli jakieś są) przepisujemy na zaszyfrowane
    try {
      require('./core/auth').migrateSecrets();
    } catch {
      /* migracja jest dodatkiem - nie blokuje startu */
    }
    register(ipcMain, { getWindow: () => mainWindow });
    createWindow();
    require('./updater').start(); // automatyczne aktualizacje (tylko w zainstalowanej wersji)
  });

  // Uruchomione gry celowo nie są zabijane przy zamknięciu launchera - gracz nie traci postępów.
  app.on('window-all-closed', () => app.quit());
}
