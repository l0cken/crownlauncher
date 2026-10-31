// Weryfikacja wydania 0.1.31 (utwardzenie: bezpieczniki Electrona + integralność app.asar, brak DevTools i flag debugowania,
// instancja wydarzenia): wydanie na VPS (https://launcher.locken.pl, sprawdzane przez SSH - bez używania kluczy),
// zawartość wydanej paczki (release/win-unpacked = ta sama, którą pakuje instalator) i bezpieczniki w exe.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const V = '0.1.31';
const HOST = 'https://launcher.locken.pl';
const exeName = `CrownLauncher-Setup-${V}.exe`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'anarchia', cmd], { encoding: 'utf8' }).trim();
const parseYml = (yml) => ({
  version: /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  sha: /^\s*sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  size: Number(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1]),
});

(async () => {
  const local = path.join(root, 'release', exeName);
  const myYml = parseYml(fs.readFileSync(path.join(root, 'release', 'latest.yml'), 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'scripts', '.last-release.json'), 'utf8'));
  check(`zapis wydania: ostatnie wydanie to ${V}`, marker.version === V, marker.at);

  // 1. instalator lokalny = latest.yml
  const buf = fs.readFileSync(local);
  const localSha = crypto.createHash('sha512').update(buf).digest('base64');
  check(`lokalny instalator ${V}: latest.yml (wersja, SHA-512, rozmiar) zgodny`, myYml.version === V && localSha === myYml.sha && buf.length === myYml.size, `${(buf.length / 1048576).toFixed(1)} MB`);

  // 2. VPS: te same pliki na dysku serwera, bramka zaproszeń zamknięta
  const remoteYml = parseYml(ssh('cat /opt/crownlauncher/data/updates/latest.yml'));
  check('VPS: latest.yml wskazuje na tę samą wersję, sumę i rozmiar', remoteYml.version === V && remoteYml.sha === myYml.sha && remoteYml.size === myYml.size);
  const remoteSha = ssh(`openssl dgst -sha512 -binary /opt/crownlauncher/data/updates/${exeName} | base64 -w0`);
  check('VPS (dysk): SHA-512 instalatora = latest.yml', remoteSha === myYml.sha);
  const remoteMap = Number(ssh(`stat -c %s /opt/crownlauncher/data/updates/${exeName}.blockmap`));
  check('VPS (dysk): .blockmap (pobieranie różnicowe) zgodny z lokalnym', remoteMap === fs.statSync(path.join(root, 'release', `${exeName}.blockmap`)).size, `${remoteMap} B`);
  const noKey = await Promise.all(['/updates/latest.yml', `/updates/${exeName}`, '/v1/announcements'].map((p) => fetch(HOST + p).then((r) => r.status)));
  check('VPS bez klucza: latest.yml, instalator, ogłoszenia → 401', noKey.every((s) => s === 401), noKey.join(','));
  const svc = ssh('systemctl is-active crownlauncher caddy mc-anarchia').split(/\s+/);
  check('VPS: usługi crownlauncher, caddy i mc-anarchia (serwer Minecrafta) aktywne', svc.length === 3 && svc.every((s) => s === 'active'), svc.join(','));

  // 3. zawartość wydanej paczki
  const asarFile = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  check('app.asar zbudowany w tym samym przebiegu co instalator (±15 min)', Math.abs(fs.statSync(asarFile).mtimeMs - fs.statSync(local).mtimeMs) < 15 * 60_000);
  const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => list.includes('/' + p);
  const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
  const pkg = JSON.parse(read('package.json'));
  check(`paczka: package.json = ${V}, bez znacznika builda testowego (crownDebugBuild)`, pkg.version === V && !('crownDebugBuild' in pkg), JSON.stringify({ v: pkg.version, dbg: pkg.crownDebugBuild }));
  const appCfg = read('src/main/core/app-config.js');
  check('app-config w paczce: GITHUB_REPO puste, serwer https://launcher.locken.pl, INVITE_REQUIRED: true',
    /^\s*GITHUB_REPO: '',/m.test(appCfg) && /^\s*ANNOUNCEMENTS_URL: 'https:\/\/launcher\.locken\.pl',/m.test(appCfg) && /^\s*INVITE_REQUIRED: true,/m.test(appCfg));
  const mainSrc = read('src/main/main.js');
  check('main.js: utwardzenie (menu wyłączone, devTools: !HARDEN, blokada skrótów, odmowa flag debugowania, bez webview)',
    /Menu\.setApplicationMenu\(null\)/.test(mainSrc) && /devTools: !HARDEN/.test(mainSrc) && /devtools-opened/.test(mainSrc) && /DEBUG_SWITCH/.test(mainSrc) && /will-attach-webview/.test(mainSrc));
  check('main.js: HARDEN włącza się w zainstalowanej wersji (app.isPackaged), a nie tylko po zmiennej', /HARDEN = app\.isPackaged \|\|/.test(mainSrc));
  const inviteSrc = read('src/main/core/invite.js');
  check('invite.js: obsługa wydarzeń i zwolnienia (X-Crown-Features: event,release, X-Crown-Entry), nadzór co 60 s',
    /FEATURES = 'event,release'/.test(inviteSrc) && /X-Crown-Entry/.test(inviteSrc) && /60 \* 1000/.test(inviteSrc) && /onLost/.test(inviteSrc));
  const evSrc = read('src/main/core/event.js');
  check('event.js: zamykane foldery .fabric, logs, crash-reports; klucze pliku pomocniczego jako skróty; sprzątanie po grze',
    /'\.fabric', 'logs', 'crash-reports'/.test(evSrc) && /appliedKey/.test(evSrc) && /cleanAfterGame/.test(evSrc) && has('src/main/core/hidden.js'));
  check('strona wydarzenia: bez list plików (brak fileList), restrictions.js w paczce',
    !/fileList/.test(read('src/renderer/js/pages/event.js')) && has('src/main/core/restrictions.js'));
  check('paczka nie zawiera serwera, skryptów wydania, plików z kluczami ani testów', !list.some((p) => /^\/server\/|^\/scripts\/|\.crownlauncher-|\.env|\.last-release|invites\.json|keys\.json|dev-tests/.test(p)));
  const SECRET_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|crown_[A-Za-z0-9_-]{40,}|CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
  const leaked = list.filter((p) => /\.(js|json|html|css|md|yml|txt)$/i.test(p)).filter((p) => SECRET_RE.test(read(p.slice(1)).replace(/CROWN-XXXX-XXXX-XXXX-XXXX/g, '')));
  check('w plikach paczki nie ma wzorców tokenów ani kluczy (admin, zaproszenia, GitHub, JWT)', leaked.length === 0, leaked.join(', '));

  // 4. bezpieczniki w wydanym exe
  const exe = path.join(root, 'release', 'win-unpacked', 'CrownLauncher.exe');
  const fuses = spawnSync(process.execPath, [path.join(root, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js'), 'read', '--app', exe], { encoding: 'utf8' });
  const ft = fuses.stdout + fuses.stderr;
  check('exe: tryb Node, NODE_OPTIONS i --inspect wyłączone; app.asar tylko z asara, z kontrolą integralności',
    /RunAsNode is Disabled/.test(ft) && /EnableNodeOptionsEnvironmentVariable is Disabled/.test(ft) && /EnableNodeCliInspectArguments is Disabled/.test(ft) &&
    /EnableEmbeddedAsarIntegrityValidation is Enabled/.test(ft) && /OnlyLoadAppFromAsar is Enabled/.test(ft));

  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((r) => !r).length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
