// scripts/release.js w TRYBIE SERWERA na prawdziwym server/server.js (INVITE_ONLY): wgranie wydania kluczem admin
// z zmiennej środowiskowej i z pliku DPAPI, auto-podbicie wersji (z atrapą electron-buildera), odmowy.
// Uruchomienie: node dev-tests/release-server-mode-test.js   (Windows - klucz w pliku szyfruje DPAPI)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REAL = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // ---- prawdziwy serwer w trybie prywatnym ----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-relsrv-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const server = spawn(process.execPath, [REAL + 'server/server.js'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < 40 && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const base = `http://127.0.0.1:${port}`;
  const adminKey = /(crown_\S+)/.exec(spawnSync(process.execPath, [REAL + 'server/server.js', 'create-key', 'Release', 'admin'], { env, encoding: 'utf8' }).stdout)[1];
  const inviteKey = /(CROWN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/.exec(spawnSync(process.execPath, [REAL + 'server/server.js', 'create-invite', 'Gracz'], { env, encoding: 'utf8' }).stdout)[1];

  // ---- piaskownica projektu: skrypt wydania + atrapa electron-buildera (npx) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-relproj-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/main/core'), { recursive: true });
  fs.copyFileSync(REAL + 'scripts/release.js', path.join(dir, 'scripts/release.js'));
  fs.copyFileSync(REAL + 'scripts/version-util.js', path.join(dir, 'scripts/version-util.js'));
  const appCfg = fs.readFileSync(REAL + 'src/main/core/app-config.js', 'utf8')
    .replace(/GITHUB_REPO: '[^']*'/g, "GITHUB_REPO: ''")
    .replace(/ANNOUNCEMENTS_URL: '[^']*'/g, `ANNOUNCEMENTS_URL: '${base}'`);
  fs.writeFileSync(path.join(dir, 'src/main/core/app-config.js'), appCfg);
  fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "x",\n  "version": "9.9.9"\n}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{\n  "name": "x",\n  "version": "9.9.9",\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "9.9.9"\n    }\n  }\n}\n');

  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-fakenpx-'));
  fs.writeFileSync(
    path.join(fakeBin, 'fake-builder.js'),
    `const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
     const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
     const out = process.env.CROWN_OUT_DIR; fs.mkdirSync(out, { recursive: true });
     const exe = 'CrownLauncher-Setup-' + v + '.exe';
     const body = crypto.randomBytes(200 * 1024); fs.writeFileSync(path.join(out, exe), body);
     fs.writeFileSync(path.join(out, exe + '.blockmap'), 'blockmap ' + v);
     fs.writeFileSync(path.join(out, 'latest.yml'), 'version: ' + v + '\\nfiles:\\n  - url: ' + exe + '\\n    sha512: x\\n    size: ' + body.length + '\\npath: ' + exe + '\\n');`,
  );
  fs.writeFileSync(path.join(fakeBin, 'npx.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-builder.js" %*\r\n`);

  const outDir = path.join(dir, 'out');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-profile-'));
  const run = (extraEnv, ...args) =>
    spawnSync(process.execPath, [path.join(dir, 'scripts/release.js'), '--dir', outDir, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin};${process.env.PATH}`, USERPROFILE: profile, CROWN_ADMIN_KEY: '', ...extraEnv },
    });
  const get = (p, headers) => fetch(`${base}${p}`, { headers });

  // 1. klucz admin ze zmiennej środowiskowej; wersja 9.9.9 nie jest jeszcze „zajęta”: bez podbijania
  let r = run({ CROWN_ADMIN_KEY: adminKey });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Opublikowano aktualizację 9\.9\.9/);
  let res = await get('/updates/latest.yml', { 'X-Crown-Invite': inviteKey });
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /version: 9\.9\.9/);
  assert.strictEqual((await get('/updates/CrownLauncher-Setup-9.9.9.exe')).status, 401, 'instalator tylko z zaproszeniem');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'scripts/.last-release.json'), 'utf8')).version, '9.9.9');
  ok('wydanie kluczem admin ze zmiennej: pliki na serwerze (latest.yml, exe, blockmap), instalator za zaproszeniem, znacznik zapisany');

  // 2. ta sama wersja jest już wydana -> skrypt sam podbija numer (package.json i lock) i wgrywa 9.9.10
  r = run({ CROWN_ADMIN_KEY: adminKey });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /podbijam na 9\.9\.10/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '9.9.10');
  assert.match(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), /"version": "9\.9\.10"[\s\S]*"version": "9\.9\.10"/);
  res = await get('/updates/latest.yml', { 'X-Crown-Invite': inviteKey });
  assert.match(await res.text(), /version: 9\.9\.10/);
  ok('tryb serwera: wersja już wydana -> auto-podbicie 9.9.9 → 9.9.10 (package.json + lock) i wgranie nowej');

  // 3. klucz z pliku zaszyfrowanego DPAPI (jak token GitHub) - bez zmiennej środowiskowej
  if (process.platform === 'win32') {
    const keyFile = path.join(profile, '.crownlauncher-admin-key');
    const enc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "ConvertTo-SecureString -String $env:K -AsPlainText -Force | ConvertFrom-SecureString"], { encoding: 'utf8', env: { ...process.env, K: adminKey } });
    assert.strictEqual(enc.status, 0, enc.stderr);
    fs.writeFileSync(keyFile, enc.stdout.trim());
    assert.ok(!fs.readFileSync(keyFile, 'utf8').includes(adminKey.slice(10)), 'plik nie zawiera klucza jawnie');
    r = run({}, '--keep-version');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Opublikowano aktualizację 9\.9\.10/);
    ok('klucz admin z pliku .crownlauncher-admin-key (DPAPI) działa bez zmiennej środowiskowej');
    fs.rmSync(keyFile);
  }

  // 4. brak klucza, zły klucz, serwer bez https
  r = run({});
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Brak klucza administratora/);
  r = run({ CROWN_ADMIN_KEY: 'crown_zly_klucz_zly_klucz_zly_klucz' }, '--keep-version');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /401/);
  r = run({ CROWN_ADMIN_KEY: adminKey, CROWN_SERVER: 'http://example.com' }, '--keep-version');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /https/);
  ok('odmowy: brak klucza, zły klucz (401), serwer bez https (klucz nie idzie jawnym tekstem)');

  server.kill();
  for (const d of [dir, fakeBin, profile, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
