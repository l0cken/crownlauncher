// scripts/release.js: wgrywanie instalatora CZĘŚCIAMI (R2 multipart) na Workera oraz powrót do jednego PUT na serwerze Node (VPS), który
// wgrywania częściami nie zna. Plik 12 MB, próg jednego żądania zbity do 1 MB, część 5 MiB (minimum R2) → 3 części na Workerze.
// Uruchomienie: node cloudflare/tests/release-multipart-test.js   (dla sanity: nie dotyka .last-release.json - tryb --target cf-test)
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..', '..');
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function start(entry) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-relmp-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const proc = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < 400 && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const adminKey = /(crown_\S+)/.exec(spawnSync(process.execPath, [entry, 'create-key', 'Release', 'admin'], { env, encoding: 'utf8' }).stdout)[1];
  return { dataDir, proc, base: `http://127.0.0.1:${port}`, adminKey };
}

function release(srv, outDir) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'release.js'), '--skip-build', '--dir', outDir], {
    encoding: 'utf8',
    env: { ...process.env, CROWN_RELEASE_TARGET: 'cf-test', CROWN_SERVER: srv.base, CROWN_ADMIN_KEY: srv.adminKey, CROWN_SINGLE_PUT_MAX: String(1024 * 1024), CROWN_PART_SIZE: String(5 * 1024 * 1024) },
  });
}

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-relout-'));
  const exe = 'CrownLauncher-Setup-9.9.9.exe';
  const body = crypto.randomBytes(12 * 1024 * 1024 + 4321);
  const sha512 = crypto.createHash('sha512').update(body).digest('base64');
  fs.writeFileSync(path.join(outDir, exe), body);
  fs.writeFileSync(path.join(outDir, `${exe}.blockmap`), 'blockmap 9.9.9');
  fs.writeFileSync(path.join(outDir, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: ${exe}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${exe}\nsha512: ${sha512}\n`);
  const lastRelease = path.join(root, 'scripts', '.last-release.json');
  const lastBefore = fs.existsSync(lastRelease) ? fs.readFileSync(lastRelease, 'utf8') : null;

  const servers = [];
  try {
    // ---- Worker (R2): część po części ----
    const cf = await start(path.join(__dirname, 'server-shim.js'));
    servers.push(cf);
    let r = release(cf, outDir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\.\.\.108\.3 MB|\.{3}12\.\d MB/, 'trzy kropki = trzy części');
    const got = await fetch(`${cf.base}/updates/${exe}`, { headers: { Authorization: `Bearer ${cf.adminKey}` } });
    assert.strictEqual(got.status, 200);
    assert.ok(crypto.createHash('sha512').update(Buffer.from(await got.arrayBuffer())).digest('base64') === sha512, 'plik z R2 identyczny');
    const yml = await (await fetch(`${cf.base}/updates/latest.yml`, { headers: { Authorization: `Bearer ${cf.adminKey}` } })).text();
    assert.match(yml, /version: 9\.9\.9/);
    ok('Worker: instalator 12 MB wgrany w 3 częściach (R2 multipart), SHA-512 po pobraniu zgodny, latest.yml na końcu');

    // ---- błędny klucz: wgrywanie częściami też odmawia i nic nie zostaje ----
    r = spawnSync(process.execPath, [path.join(root, 'scripts', 'release.js'), '--skip-build', '--dir', outDir], {
      encoding: 'utf8',
      env: { ...process.env, CROWN_RELEASE_TARGET: 'cf-test', CROWN_SERVER: cf.base, CROWN_ADMIN_KEY: 'crown_zly_klucz_zly_klucz_zly_klucz', CROWN_SINGLE_PUT_MAX: '1048576' },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /HTTP 401/);
    ok('Worker: zły klucz admin → HTTP 401, wydanie przerwane');

    // ---- serwer Node (VPS): nie zna wgrywania częściami → jeden PUT ----
    const node = await start(path.join(root, 'server', 'server.js'));
    servers.push(node);
    r = release(node, outDir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const got2 = await fetch(`${node.base}/updates/${exe}`, { headers: { Authorization: `Bearer ${node.adminKey}` } });
    assert.ok(crypto.createHash('sha512').update(Buffer.from(await got2.arrayBuffer())).digest('base64') === sha512, 'plik z serwera Node identyczny');
    ok('serwer Node: brak wgrywania częściami → release.js wraca do jednego PUT, plik identyczny');

    assert.strictEqual(fs.existsSync(lastRelease) ? fs.readFileSync(lastRelease, 'utf8') : null, lastBefore, '.last-release.json nietknięty');
    ok('tryb cf-test nie oznacza wersji jako wydanej (.last-release.json bez zmian)');
    console.log(`\nWSZYSTKO OK (${n})`);
  } finally {
    for (const s of servers) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else s.proc.kill();
    }
    await sleep(3500); // watchdog kończy wrangler/workerd
    const { rmDir } = require(path.join(root, 'dev-tests', 'lib', 'backend.js'));
    for (const d of [outDir, ...servers.map((s) => s.dataDir)]) rmDir(d);
  }
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
