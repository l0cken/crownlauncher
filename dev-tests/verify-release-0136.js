// Weryfikacja wydania 0.1.36 (bramka „na serwer tylko z launchera”): wydanie na Workerze (https://launcher.locken.pl, sprawdzane
// kluczem admin z pliku DPAPI - nigdy kluczami graczy), zawartość wydanej paczki (release/win-unpacked = ta sama, którą pakuje instalator)
// i bezpieczniki w exe. Wzór: verify-release-0131.js (tam serwer był na VPS i szedł przez SSH).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const { connect } = require(root + '/cloudflare/scripts/lib/client');
const V = '0.1.36';
const HOST = 'https://launcher.locken.pl';
const exeName = `CrownLauncher-Setup-${V}.exe`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
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

  // 2. serwer (Worker): te same pliki, bramka zaproszeń zamknięta
  const admin = await connect(HOST);
  const get = (p, init = {}) => fetch(HOST + p, { signal: AbortSignal.timeout(120_000), ...init, headers: { ...admin.headers(), ...(init.headers || {}) } }); // limit czasu: zerwane pobranie nie może wieszać skryptu
  const remoteYml = parseYml(await (await get('/updates/latest.yml')).text());
  check('serwer: latest.yml wskazuje na tę samą wersję, sumę i rozmiar', remoteYml.version === V && remoteYml.sha === myYml.sha && remoteYml.size === myYml.size);
  const t0 = Date.now();
  const full = Buffer.from(await (await get(`/updates/${exeName}`)).arrayBuffer());
  const remoteSha = crypto.createHash('sha512').update(full).digest('base64');
  check('serwer: pełne pobranie instalatora → SHA-512 = latest.yml', remoteSha === myYml.sha && full.length === myYml.size, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const map = Buffer.from(await (await get(`/updates/${exeName}.blockmap`)).arrayBuffer());
  const localMap = fs.readFileSync(path.join(root, 'release', `${exeName}.blockmap`));
  check('serwer: .blockmap (pobieranie różnicowe) identyczny z lokalnym', map.equals(localMap), `${map.length} B`);
  const prevMap = await get(`/updates/CrownLauncher-Setup-0.1.35.exe.blockmap`);
  check('serwer: blockmapa poprzedniej wersji (0.1.35) nadal jest (potrzebna do aktualizacji różnicowej)', prevMap.status === 200);
  const listed = await (await get('/v1/admin/updates')).json().catch(() => ({}));
  check('API admina: lista aktualizacji zawiera instalator, blockmapę i latest.yml wersji 0.1.36',
    JSON.stringify(listed).includes(exeName) && JSON.stringify(listed).includes(`${exeName}.blockmap`) && JSON.stringify(listed).includes('latest.yml'));
  const noKey = await Promise.all(['/updates/latest.yml', `/updates/${exeName}`, '/v1/announcements'].map((p) => fetch(HOST + p).then((r) => r.status)));
  check('serwer bez klucza: latest.yml, instalator, ogłoszenia → 401', noKey.every((s) => s === 401), noKey.join(','));
  const gate = await get('/v1/admin/gate');
  check('bramka na serwerze działa po wydaniu (GET /v1/admin/gate → 200, klucz bramki ustawiony)', gate.status === 200 && (await gate.json()).keySet === true);

  // 3. zawartość wydanej paczki
  const asarFile = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  check('app.asar zbudowany w tym samym przebiegu co instalator (±15 min)', Math.abs(fs.statSync(asarFile).mtimeMs - fs.statSync(local).mtimeMs) < 15 * 60_000);
  const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => list.includes('/' + p);
  const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
  const pkg = JSON.parse(read('package.json'));
  check(`paczka: package.json = ${V}, bez znacznika builda testowego (crownDebugBuild)`, pkg.version === V && !('crownDebugBuild' in pkg), JSON.stringify({ v: pkg.version, debug: pkg.crownDebugBuild }));
  const appCfg = read('src/main/core/app-config.js');
  check('app-config w paczce: GITHUB_REPO puste, serwer https://launcher.locken.pl, INVITE_REQUIRED: true',
    /^\s*GITHUB_REPO: '',/m.test(appCfg) && /^\s*ANNOUNCEMENTS_URL: 'https:\/\/launcher\.locken\.pl',/m.test(appCfg) && /^\s*INVITE_REQUIRED: true,/m.test(appCfg));
  const same = (p) => fs.readFileSync(path.join(root, p)).equals(Buffer.from(asar.extractFile(asarFile, p.replace(/\//g, '\\'))));
  check('paczka: gate.js, game.js i invite.js identyczne z kodem źródłowym (testowanym)', has('src/main/core/gate.js') && ['src/main/core/gate.js', 'src/main/core/game.js', 'src/main/core/invite.js'].every(same));
  const gateSrc = read('src/main/core/gate.js');
  const gameSrc = read('src/main/core/game.js');
  check('gate.js: POST/DELETE /v1/play, odnawianie co 60 s, klucz tylko do serwera launchera (invite.headersFor), bez blokowania startu',
    /\/v1\/play/.test(gateSrc) && /60 \* 1000/.test(gateSrc) && /invite\.headersFor\(url\)/.test(gateSrc) && /Nie rzuca/.test(gateSrc));
  check('game.js: sesja zgłaszana przed startem procesu gry (gate.begin), zdejmowana w onExit, przy błędzie startu i w stopAll',
    /gate\.begin\(id, account\)/.test(gameSrc) && /gate\.end\(id\); \/\/ koniec gry/.test(gameSrc) && /gate\.end\(id\);\s*\n\s*if \(eventInstance\)/.test(gameSrc) && /gate\.endAll\(\)/.test(gameSrc));
  const mainSrc = read('src/main/main.js');
  check('main.js: utwardzenie bez zmian (menu wyłączone, devTools: !HARDEN, blokada skrótów, odmowa flag debugowania, bez webview)',
    /Menu\.setApplicationMenu\(null\)/.test(mainSrc) && /devTools: !HARDEN/.test(mainSrc) && /devtools-opened/.test(mainSrc) && /DEBUG_SWITCH/.test(mainSrc) && /will-attach-webview/.test(mainSrc) && /HARDEN = app\.isPackaged \|\|/.test(mainSrc));
  check('paczka nie zawiera serwera, skryptów wydania, plików z kluczami ani testów', !list.some((p) => /^\/server\/|^\/scripts\/|^\/cloudflare\/|\.crownlauncher-|\.env|\.last-release|invites\.json|keys\.json|gate\.json|dev-tests/.test(p)));
  const SECRET_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|crown_[A-Za-z0-9_-]{40,}|gate_[A-Za-z0-9_-]{30,}|CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
  const leaked = list.filter((p) => /\.(js|json|html|css|md|yml|txt)$/i.test(p)).filter((p) => SECRET_RE.test(read(p.slice(1)).replace(/CROWN-XXXX-XXXX-XXXX-XXXX/g, '')));
  check('w plikach paczki nie ma wzorców tokenów ani kluczy (admin, zaproszenia, bramka, GitHub, JWT)', leaked.length === 0, leaked.join(', '));

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
