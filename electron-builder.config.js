// Konfiguracja budowania instalatora. Źródło aktualizacji bierzemy z src/main/core/app-config.js,
// dzięki czemu `npm run dist` generuje też latest.yml dla automatycznych aktualizacji.
const appConfig = require('./src/main/core/app-config');

const trim = (s) => String(s || '').trim().replace(/\/+$/, '');

// build na Linuksa: `electron-builder --linux …` albo CROWN_TARGET=linux (patrz `npm run dist:linux`)
const isLinuxBuild = process.env.CROWN_TARGET === 'linux' || process.argv.includes('--linux');

function publishConfig() {
  // CROWN_PUBLISH_REPO: wydanie przejściowe na GitHuba z launcherem skierowanym już na własny serwer
  // (scripts/release.js --github właściciel/repo); zwykle puste, wtedy GITHUB_REPO z app-config.js
  const repo = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(trim(process.env.CROWN_PUBLISH_REPO || appConfig.GITHUB_REPO));
  if (repo) {
    // wydania trafiają do GitHub Releases (publikuje je `npm run release` z tokenem GH_TOKEN)
    return [{ provider: 'github', owner: repo[1], repo: repo[2], releaseType: 'release' }];
  }
  const url =
    trim(appConfig.UPDATE_URL) ||
    (trim(appConfig.ANNOUNCEMENTS_URL) ? `${trim(appConfig.ANNOUNCEMENTS_URL)}/updates` : '') ||
    // brak źródła = launcher nie sprawdza aktualizacji, dopóki nie dostanie go w ustawieniach
    'https://updates.invalid/crownlauncher';
  return [{ provider: 'generic', url }];
}

module.exports = {
  appId: 'pl.crownlauncher.app',
  productName: 'CrownLauncher',
  directories: { output: process.env.CROWN_OUT_DIR || 'dist' },
  // CROWN_VERSION pozwala zbudować inną wersję bez edycji package.json (np. do testów aktualizacji);
  // CROWN_DEBUG_BUILD=1 buduje wersję TESTOWĄ, która przyjmuje flagi zdalnego debugowania (testy w prawdziwym oknie) -
  // nigdy nie wydawaj takiego builda graczom (patrz src/main/main.js)
  ...(process.env.CROWN_VERSION || process.env.CROWN_DEBUG_BUILD
    ? {
        extraMetadata: {
          ...(process.env.CROWN_VERSION ? { version: process.env.CROWN_VERSION } : {}),
          ...(process.env.CROWN_DEBUG_BUILD ? { crownDebugBuild: true } : {}),
        },
      }
    : {}),
  files: ['src/**/*', 'assets/**/*', 'package.json'],
  // Linux (AppImage) buduje `npm run dist:linux` - na Linuksie albo w WSL/Dockerze/CI (electron-builder nie składa AppImage w Windowsie)
  // Bezpieczniki Electrona (przestawiane w CrownLauncher.exe przy budowaniu):
  //  - runAsNode / NODE_OPTIONS / --inspect: nie da się uruchomić exe jako zwykłego Node'a ani podłączyć debuggera do
  //    procesu głównego (przez to wołanie modułów launchera i odszyfrowywanie jego danych z zewnątrz),
  //  - onlyLoadAppFromAsar + sprawdzanie integralności: launcher ładuje kod tylko z app.asar, a podmieniony plik w
  //    środku (np. wyłączenie ograniczeń wydarzenia) kończy się odmową startu zamiast cichej zmiany zachowania.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    // Sprawdzanie sumy asara jest wbudowane w plik wykonywalny tylko w Windows i macOS (electron-builder zapisuje tam dane
    // integralności); w buildzie Linuksa wyłączone, żeby aplikacja nie odmawiała startu z powodu braku tych danych.
    enableEmbeddedAsarIntegrityValidation: !isLinuxBuild,
  },
  win: {
    icon: 'assets/icon.ico',
    target: 'nsis',
  },
  linux: {
    icon: 'assets/logo-512.png',
    category: 'Game',
    synopsis: 'Launcher Minecrafta (Fabric)',
    executableName: 'crownlauncher',
    // app_id / WM_CLASS okna = nazwa wpisu .desktop (inaczej Wayland i paski zadań nie wiążą okna z ikoną launchera)
    syncDesktopName: true,
    target: [{ target: 'AppImage', arch: ['x64'] }],
    // plik wydania i latest-linux.yml; nazwa bez spacji - proste adresy URL jak przy instalatorze Windows
    artifactName: 'CrownLauncher-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // bez spacji w nazwie - proste adresy URL plików wydania
    artifactName: 'CrownLauncher-Setup-${version}.${ext}',
  },
  publish: publishConfig(),
};
