// Weryfikacja wydania 0.1.38 (blokada wstrzykiwania kodu do gry: natywny start CrownSpawn + nadzór bibliotek): wydanie na Workerze
// (https://launcher.locken.pl, sprawdzane kluczem admin z pliku DPAPI - nigdy kluczami graczy) i zawartość WYDANEGO instalatora.
// Tylko odczyt: serwer pytany GET-ami, instalator rozpakowany do katalogu tymczasowego (po zakończeniu usuwany).
// Wzór: verify-release-0137.js. Różnica: tam paczkę brano z release/win-unpacked; tu wyciągamy ją z samego instalatora, bo przy
// kolejnym budowaniu win-unpacked jest nadpisywany (po 0.1.38 powstawała już 0.1.39) - a to instalator trafił do graczy.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const { connect } = require(root + '/cloudflare/scripts/lib/client');
const V = '0.1.38';
const PREV = '0.1.37';
const HOST = 'https://launcher.locken.pl';
const exeName = `CrownLauncher-Setup-${V}.exe`;
const SEVEN_ZIP = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe'); // pełne 7-Zip (z 7z.dll) umie otworzyć instalator NSIS; samodzielne 7za z cache electron-builder nie
const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const info = (text) => console.log(`INFO ${text}`);
const parseYml = (yml) => ({
  version: /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  sha: /^\s*sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  size: Number(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1]),
});
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const findFile = (dir, name) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return '';
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-verify-0138-'));
  try {
    const local = path.join(root, 'release', exeName);
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'scripts', '.last-release.json'), 'utf8'));
    info(`zapis wydania: ${marker.version} (${marker.at})` + (marker.version !== V ? ' — w międzyczasie wydano nowszą wersję' : ''));

    // 1. instalator lokalny: suma
    const buf = fs.readFileSync(local);
    const localSha = crypto.createHash('sha512').update(buf).digest('base64');
    const ymlLocal = parseYml(fs.readFileSync(path.join(root, 'release', 'latest.yml'), 'utf8'));
    if (ymlLocal.version === V) {
      check(`lokalny instalator ${V}: latest.yml (wersja, SHA-512, rozmiar) zgodny`, localSha === ymlLocal.sha && buf.length === ymlLocal.size, `${(buf.length / 1048576).toFixed(1)} MB`);
    } else {
      info(`lokalny release/latest.yml ma już ${ymlLocal.version} - suma 0.1.38 sprawdzana tylko względem serwera`);
    }

    // 2. serwer (Worker)
    const admin = await connect(HOST);
    const get = (p, init = {}) => fetch(HOST + p, { signal: AbortSignal.timeout(120_000), ...init, headers: { ...admin.headers(), ...(init.headers || {}) } });
    const remoteYml = parseYml(await (await get('/updates/latest.yml')).text());
    if (remoteYml.version === V) {
      check('serwer: latest.yml wskazuje na 0.1.38 z tą samą sumą i rozmiarem co instalator', remoteYml.sha === localSha && remoteYml.size === buf.length);
    } else {
      info(`serwer ma w latest.yml już ${remoteYml.version} (następne wydanie) - 0.1.38 sprawdzam po pliku instalatora`);
    }
    const t0 = Date.now();
    const resp = await get(`/updates/${exeName}`);
    if (resp.status === 200) {
      const full = Buffer.from(await resp.arrayBuffer());
      const remoteSha = crypto.createHash('sha512').update(full).digest('base64');
      check('serwer: pełne pobranie instalatora 0.1.38 → SHA-512 = lokalny instalator', remoteSha === localSha && full.length === buf.length, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } else {
      check('serwer: instalator 0.1.38 jest do pobrania', false, `HTTP ${resp.status}`);
    }
    const map = await get(`/updates/${exeName}.blockmap`);
    const localMapFile = path.join(root, 'release', `${exeName}.blockmap`);
    check('serwer: .blockmap 0.1.38 (pobieranie różnicowe) identyczny z lokalnym', map.status === 200 && Buffer.from(await map.arrayBuffer()).equals(fs.readFileSync(localMapFile)));
    const prevMap = await get(`/updates/CrownLauncher-Setup-${PREV}.exe.blockmap`);
    check(`serwer: blockmapa poprzedniej wersji (${PREV}) nadal jest (potrzebna do aktualizacji różnicowej)`, prevMap.status === 200);
    const listed = JSON.stringify(await (await get('/v1/admin/updates')).json().catch(() => ({})));
    check('API admina: lista aktualizacji zawiera instalator i blockmapę 0.1.38', listed.includes(exeName) && listed.includes(`${exeName}.blockmap`));
    const noKey = await Promise.all(['/updates/latest.yml', `/updates/${exeName}`, '/v1/announcements'].map((p) => fetch(HOST + p).then((r) => r.status)));
    check('serwer bez klucza: latest.yml, instalator, ogłoszenia → 401', noKey.every((s) => s === 401), noKey.join(','));
    const gate = await get('/v1/admin/gate');
    check('bramka na serwerze działa (GET /v1/admin/gate → 200, klucz bramki ustawiony)', gate.status === 200 && (await gate.json()).keySet === true);

    // 3. zawartość WYDANEGO instalatora: NSIS -> app-64.7z -> resources/app.asar + CrownLauncher.exe
    check('narzędzie 7z (electron-winstaller, z NSIS) jest dostępne', fs.existsSync(SEVEN_ZIP), SEVEN_ZIP);
    const nsisDir = path.join(tmp, 'nsis');
    let r = spawnSync(SEVEN_ZIP, ['x', local, `-o${nsisDir}`, '-y'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const appArchive = fs.existsSync(nsisDir) ? findFile(nsisDir, 'app-64.7z') : '';
    check('instalator rozpakowany (NSIS), jest app-64.7z', Boolean(appArchive), r.status !== 0 ? String(r.stderr || r.stdout).slice(0, 160) : '');
    const appDir = path.join(tmp, 'app');
    r = spawnSync(SEVEN_ZIP, ['x', appArchive, `-o${appDir}`, '-y', 'resources/app.asar', 'CrownLauncher.exe'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const asarFile = path.join(appDir, 'resources', 'app.asar');
    check('z app-64.7z wyciągnięto app.asar i CrownLauncher.exe', fs.existsSync(asarFile) && fs.existsSync(path.join(appDir, 'CrownLauncher.exe')), r.status !== 0 ? String(r.stderr).slice(0, 160) : '');

    const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
    const has = (p) => list.includes('/' + p);
    const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const pkg = JSON.parse(read('package.json'));
    check(`paczka: package.json = ${V}, bez znacznika builda testowego (crownDebugBuild)`, pkg.version === V && !('crownDebugBuild' in pkg), JSON.stringify({ v: pkg.version, debug: pkg.crownDebugBuild }));
    const appCfg = read('src/main/core/app-config.js');
    check('app-config w paczce: GITHUB_REPO puste, serwer https://launcher.locken.pl, INVITE_REQUIRED: true',
      /^\s*GITHUB_REPO: '',/m.test(appCfg) && /^\s*ANNOUNCEMENTS_URL: 'https:\/\/launcher\.locken\.pl',/m.test(appCfg) && /^\s*INVITE_REQUIRED: true,/m.test(appCfg));

    // kod 0.1.38 w paczce = źródła, które testowałem (anticheat.js różni się od dzisiejszych źródeł tylko poprawką 0.1.39)
    const srcFile = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const same = (p) => has(p) && norm(srcFile(p)) === norm(read(p));
    const names = ['src/main/native/CrownSpawn.cs', 'src/main/core/native-spawn.js', 'src/main/core/launch.js', 'src/main/core/game.js', 'src/main/core/gate.js', 'src/main/core/invite.js'];
    check('paczka: CrownSpawn.cs, native-spawn.js, launch.js, game.js, gate.js, invite.js identyczne z kodem źródłowym (testowanym)', names.every(same), names.filter((p) => !same(p)).join(', '));
    const acPack = read('src/main/core/anticheat.js');
    const acSrc039 = norm(srcFile('src/main/core/anticheat.js'))
      .replace(/\/\/ natywne biblioteki znanych modów[\s\S]*?\/i;\n/, '')
      .replace('!TEMP_NATIVE_RE.test(m) && !TEMP_MOD_NATIVE_RE.test(m)', '!TEMP_NATIVE_RE.test(m)');
    check('paczka: anticheat.js = dzisiejsze źródło bez poprawki 0.1.39 (wyjątek dla natywnych bibliotek imgui-java/głosu jeszcze nie wydany)', norm(acPack) === acSrc039 && !/TEMP_MOD_NATIVE_RE/.test(acPack));
    check('anticheat.js w paczce: blokada dostępu do procesu (hardenProcess, PROC_DENY_MASK), nadzór z listą od pomocnika (trustedDirs, hasNewName), ProgramData nie jest zaufane',
      /async function hardenProcess/.test(acPack) && /PROC_DENY_MASK = '0xc08ea'/.test(acPack) && /trustedDirs/.test(acPack) && /function hasNewName/.test(acPack) && !/env\.ProgramData/.test(acPack));
    const gameSrc = read('src/main/core/game.js');
    const launchSrc = read('src/main/core/launch.js');
    check('game.js/launch.js w paczce: natywny start z wyjściem awaryjnym (nativeSpawn.start → spawn), blokada po starcie tylko gdy brak crownGuard, biblioteki z pomocnika',
      /nativeSpawn\.start\(/.test(launchSrc) && /\|\|\s*\n?\s*spawn\(command\.javaPath/.test(launchSrc) && /child\.crownGuard/.test(gameSrc) && /anticheat\s*\n?\s*\.hardenProcess\(child\.pid\)/.test(gameSrc) && /child\.getModules/.test(gameSrc));
    const mainSrc = read('src/main/main.js');
    check('main.js: utwardzenie bez zmian (menu wyłączone, devTools: !HARDEN, blokada skrótów, odmowa flag debugowania, bez webview)',
      /Menu\.setApplicationMenu\(null\)/.test(mainSrc) && /devTools: !HARDEN/.test(mainSrc) && /devtools-opened/.test(mainSrc) && /DEBUG_SWITCH/.test(mainSrc) && /will-attach-webview/.test(mainSrc) && /HARDEN = app\.isPackaged \|\|/.test(mainSrc));
    check('paczka nie zawiera serwera, skryptów wydania, plików z kluczami ani testów', !list.some((p) => /^\/server\/|^\/scripts\/|^\/cloudflare\/|\.crownlauncher-|\.env|\.last-release|invites\.json|keys\.json|gate\.json|dev-tests/.test(p)));
    const SECRET_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|crown_[A-Za-z0-9_-]{40,}|gate_[A-Za-z0-9_-]{30,}|CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
    const leaked = list.filter((p) => /\.(js|json|html|css|md|yml|txt|cs)$/i.test(p)).filter((p) => SECRET_RE.test(read(p.slice(1)).replace(/CROWN-XXXX-XXXX-XXXX-XXXX/g, '')));
    check('w plikach paczki nie ma wzorców tokenów ani kluczy (admin, zaproszenia, bramka, GitHub, JWT)', leaked.length === 0, leaked.join(', '));

    // 4. pomocnik z paczki kompiluje się i działa (to samo, co zrobi launcher gracza przy starcie)
    check('csc.exe (.NET Framework 4) jest na tym komputerze', fs.existsSync(CSC));
    const csFile = path.join(tmp, 'CrownSpawn.cs');
    const helperExe = path.join(tmp, 'CrownSpawn.exe');
    fs.writeFileSync(csFile, read('src/main/native/CrownSpawn.cs'));
    r = spawnSync(CSC, ['-nologo', '-target:exe', '-optimize+', '-platform:anycpu', '-debug-', `-out:${helperExe}`, csFile], { encoding: 'utf8' });
    check('CrownSpawn.cs z wydanej paczki kompiluje się (csc, C# 5) bez błędów', r.status === 0 && fs.existsSync(helperExe), r.status !== 0 ? String(r.stdout).slice(0, 200) : `${fs.statSync(helperExe).size} B`);
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const cmdExe = path.join(sysRoot, 'System32', 'cmd.exe');
    const cfg = [`exe ${b64(cmdExe)}`, `cwd ${b64(tmp)}`, `arg ${b64('/c')}`, `arg ${b64('echo PAKIET-OK zażółć')}`, `env ${b64(`SystemRoot=${sysRoot}`)}`, 'go'].join('\n') + '\n';
    r = spawnSync(helperExe, [], { input: cfg, encoding: 'utf8', timeout: 30_000 });
    check('pomocnik z paczki uruchamia proces: wyjście dociera, kod 0, od urodzenia zamknięty na wstrzykiwanie (guard=1) z mitygacją haków (ext=1)',
      /PAKIET-OK/.test(r.stdout) && /^PID \d+ guard=1 ext=1$/m.test(r.stderr) && /^EXIT 0$/m.test(r.stderr), `stderr: ${String(r.stderr).split(/\r?\n/).filter((l) => /^(PID|EXIT|ERR|WARN)/.test(l)).join(' | ')}`);

    // 5. bezpieczniki w wydanym exe (z instalatora)
    const exe = path.join(appDir, 'CrownLauncher.exe');
    const fuses = spawnSync(process.execPath, [path.join(root, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js'), 'read', '--app', exe], { encoding: 'utf8' });
    const ft = fuses.stdout + fuses.stderr;
    check('exe: tryb Node, NODE_OPTIONS i --inspect wyłączone; app.asar tylko z asara, z kontrolą integralności',
      /RunAsNode is Disabled/.test(ft) && /EnableNodeOptionsEnvironmentVariable is Disabled/.test(ft) && /EnableNodeCliInspectArguments is Disabled/.test(ft) &&
      /EnableEmbeddedAsarIntegrityValidation is Enabled/.test(ft) && /OnlyLoadAppFromAsar is Enabled/.test(ft));
    const sig = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${local}').Status`], { encoding: 'utf8' });
    info(`podpis cyfrowy instalatora: ${String(sig.stdout).trim()} (NotSigned = SmartScreen może ostrzegać; znane, §22)`);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      info(`nie usunięto katalogu tymczasowego ${tmp}`);
    }
  }
  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((x) => !x).length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
