// Prywatna dystrybucja: serwer w trybie INVITE_ONLY (klucze zaproszeń, strona pobierania, bramka na aktualizacje)
// i launcher (invite.js: zapis klucza, nagłówki tylko do właściwego serwera, blokada startu, unieważnienie).
// Uruchomienie: node dev-tests/invite-test.js
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { CF, serverEntry, startLoops, docs: backendDocs, rmDir } = require('./lib/backend');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-invite-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...extraEnv };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) started = true; });
  for (let i = 0; i < startLoops && !started; i++) await sleep(150);
  assert.ok(started, 'serwer wystartował');
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  return { dataDir, port, base: `http://127.0.0.1:${port}`, proc, cli };
}

(async () => {
  const srv = await startServer({ INVITE_ONLY: '1' });
  const { base, dataDir, cli } = srv;

  // ---- klucze: administracja i zaproszenia (przez CLI serwera) ----
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Admin', 'admin').stdout)[1];
  const out1 = cli('create-invite', 'Anna').stdout;
  const annaKey = /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out1)[1];
  const bartekOut = cli('create-invite', 'Bartek').stdout;
  const bartekKey = /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(bartekOut)[1];
  const bartekId = /id: ([0-9a-f]{8})/.exec(bartekOut)[1];
  assert.notStrictEqual(annaKey, bartekKey);
  const stored = await backendDocs(dataDir, base).readText('invites.json');
  assert.ok(!stored.includes(annaKey.replace(/-/g, '').slice(5)) && !stored.includes(annaKey), 'serwer trzyma tylko skrót klucza');
  assert.match(cli('list-invites').stdout, /Anna[\s\S]*Bartek/);
  ok('CLI: create-invite daje klucz CROWN-XXXX-… (pokazany raz), na dysku jest tylko skrót; list-invites działa');

  // ---- wydanie wgrane przez administrację (jak robi to scripts/release.js) ----
  const exe = Buffer.alloc(300 * 1024, 7);
  const put = (name, body) => fetch(`${base}/v1/updates/${name}`, { method: 'PUT', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/octet-stream' }, body });
  assert.strictEqual((await put('CrownLauncher-Setup-9.9.9.exe', exe)).status, 201);
  assert.strictEqual((await put('latest.yml', Buffer.from('version: 9.9.9\nfiles:\n  - url: CrownLauncher-Setup-9.9.9.exe\n    sha512: x\n    size: 307200\npath: CrownLauncher-Setup-9.9.9.exe\n'))).status, 201);
  ok('administracja wgrywa wydanie (PUT /v1/updates z kluczem admin) także w trybie prywatnym');

  // ---- bez klucza: nic prywatnego nie jest dostępne ----
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });
  for (const p of ['/updates/latest.yml', '/updates/CrownLauncher-Setup-9.9.9.exe', '/v1/announcements', '/blocklist.json', '/v1/invite']) {
    assert.strictEqual((await get(p)).status, 401, `${p} bez klucza`);
  }
  assert.strictEqual((await fetch(`${base}/v1/presence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nick":"Anna"}' })).status, 401);
  assert.strictEqual((await fetch(`${base}/v1/capes/Anna`, { method: 'DELETE' })).status, 401);
  assert.strictEqual((await get('/updates/latest.yml', { 'X-Crown-Invite': 'CROWN-ZZZZ-ZZZZ-ZZZZ-ZZZZ' })).status, 401, 'zmyślony klucz');
  assert.strictEqual((await get('/capes/Anna.png')).status, 404, 'peleryny zostają publiczne (404 = brak pliku, nie brak dostępu)');
  assert.strictEqual((await get('/v1/crown-users')).status, 200, 'lista koron zostaje publiczna (czyta ją gra)');
  assert.strictEqual((await get('/health')).status, 200);
  ok('bez zaproszenia: latest.yml, instalator, ogłoszenia, lista blokad, zapis peleryn → 401; peleryny i lista koron publiczne');

  // ---- z zaproszeniem ----
  const inv = (key) => ({ 'X-Crown-Invite': key });
  let r = await get('/updates/latest.yml', inv(annaKey));
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /version: 9\.9\.9/);
  r = await get('/updates/CrownLauncher-Setup-9.9.9.exe', { ...inv(annaKey), Range: 'bytes=0-99' });
  assert.strictEqual(r.status, 206, 'pobieranie częściami (różnicowe) działa z kluczem');
  assert.strictEqual((await r.arrayBuffer()).byteLength, 100);
  assert.match(r.headers.get('cache-control'), /private|no-store/, 'pliki prywatne nie trafiają do cache proxy');
  r = await get('/v1/invite', inv(annaKey.toLowerCase().replace(/-/g, ' ')));
  assert.strictEqual(r.status, 200, 'wielkość liter, myślniki i spacje nie mają znaczenia');
  assert.strictEqual((await r.json()).name, 'Anna');
  assert.strictEqual((await get('/v1/announcements', inv(bartekKey))).status, 200);
  assert.strictEqual((await get('/updates/latest.yml', { Authorization: `Bearer ${adminKey}` })).status, 200, 'klucz administracji też');
  await backendDocs(dataDir, base).write('blocklist.json', { modIds: ['zlymod'] });
  assert.deepStrictEqual(await (await get('/blocklist.json', inv(annaKey))).json(), { modIds: ['zlymod'] });
  ok('z zaproszeniem: aktualizacje (też Range), ogłoszenia, lista blokad, /v1/invite → 200; klucz admin też przechodzi');

  // ---- strona pobierania ----
  r = await get('/');
  assert.strictEqual(r.status, 200);
  const page = await r.text();
  assert.ok(/<form method="post" action="\/download"/.test(page) && !page.includes('9.9.9'), 'formularz, bez ujawniania wersji');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const post = (key) => fetch(`${base}/download`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key)}` });
  r = await post('CROWN-AAAA-AAAA-AAAA-AAAA');
  assert.strictEqual(r.status, 401);
  assert.match(await r.text(), /Nieprawidłowy/);
  r = await post(annaKey);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="CrownLauncher-Setup-9\.9\.9\.exe"/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(exe), 'ten sam plik co wgrany');
  ok('strona pobierania: formularz; zły klucz 401; dobry klucz → instalator jako załącznik (klucz w POST, nie w adresie)');

  // ---- wersja dla Linuksa (AppImage + latest-linux.yml) ----
  // strona pokazuje jeden przycisk „Pobierz instalator” (przycisk Linuksa zdjęty ze strony); POST /download ignoruje pole os
  assert.strictEqual((page.match(/<button\b/g) || []).length, 1, 'strona ma jeden przycisk pobierania');
  assert.match(page, /<button type="submit" id="go">Pobierz instalator<\/button>/);
  assert.ok(!/go-linux|Linuks|AppImage|value="linux"/i.test(page), 'strona nie ma przycisku ani tekstu o Linuksie');
  const postOs = (key, os) => fetch(`${base}/download`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key)}&os=${os}` });
  const appImage = Buffer.alloc(200 * 1024, 9);
  assert.strictEqual((await put('CrownLauncher-9.9.9.AppImage', appImage)).status, 201, 'plik .AppImage jest dozwolony');
  assert.strictEqual((await put('latest-linux.yml', Buffer.from('version: 9.9.9\nfiles:\n  - url: CrownLauncher-9.9.9.AppImage\n    sha512: x\n    size: 204800\npath: CrownLauncher-9.9.9.AppImage\n'))).status, 201, 'latest-linux.yml jest dozwolony');
  assert.strictEqual((await get('/updates/CrownLauncher-9.9.9.AppImage')).status, 401, 'AppImage bez klucza → 401');
  assert.strictEqual((await get('/updates/latest-linux.yml')).status, 401, 'latest-linux.yml bez klucza → 401');
  r = await get('/updates/latest-linux.yml', inv(annaKey));
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /CrownLauncher-9\.9\.9\.AppImage/, 'electron-updater na Linuksie czyta latest-linux.yml z kluczem');
  r = await get('/updates/CrownLauncher-9.9.9.AppImage', { ...inv(annaKey), Range: 'bytes=0-99' });
  assert.strictEqual(r.status, 206);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 100);
  // strona pobierania oddaje tylko instalator Windows: pole os (dawny przycisk Linuksa) jest ignorowane, nawet gdy AppImage jest wgrany
  for (const os of ['linux', 'windows']) {
    r = await postOs(annaKey, os);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="CrownLauncher-Setup-9\.9\.9\.exe"/, `os=${os} → instalator`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(exe), `os=${os}: ten sam plik co wgrany instalator`);
  }
  r = await post(annaKey);
  assert.match(r.headers.get('content-disposition'), /CrownLauncher-Setup-9\.9\.9\.exe/, 'bez pola os → instalator');
  await r.arrayBuffer();
  assert.strictEqual((await postOs('CROWN-AAAA-AAAA-AAAA-AAAA', 'linux')).status, 401, 'zły klucz nie dostaje niczego');
  r = await fetch(`${base}/v1/admin/info`, { headers: { Authorization: `Bearer ${adminKey}` } });
  if (r.status === 200) {
    const info = await r.json();
    assert.strictEqual(info.linuxInstaller, 'CrownLauncher-9.9.9.AppImage');
    assert.strictEqual(info.installer, 'CrownLauncher-Setup-9.9.9.exe');
  }
  ok('Linux: AppImage i latest-linux.yml wgrywane i chronione kluczem; strona pobierania oddaje tylko instalator (os=linux ignorowane), AppImage idzie tylko aktualizacjami z kluczem');

  // ---- unieważnienie jednego gracza ----
  assert.strictEqual((await get('/v1/invite', inv(bartekKey))).status, 200);
  assert.match(cli('revoke-invite', bartekId).stdout, /Unieważniono/);
  assert.strictEqual((await get('/updates/latest.yml', inv(bartekKey))).status, 401, 'unieważniony gracz traci dostęp od razu');
  assert.strictEqual((await post(bartekKey)).status, 401, 'i pobranie instalatora');
  assert.strictEqual((await get('/updates/latest.yml', inv(annaKey))).status, 200, 'reszta działa');
  ok('revoke-invite: jeden gracz traci dostęp (aktualizacje i pobranie), pozostali bez zmian');

  // ---- ochrona przed zgadywaniem ----
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) limited = (await get('/updates/latest.yml', inv('CROWN-BBBB-BBBB-BBBB-BBBB'))).status === 429;
  assert.ok(limited, 'po serii błędnych kluczy serwer odpowiada 429');
  ok('zgadywanie kluczy: po kilkudziesięciu błędnych próbach z jednego adresu 429');

  // ---- launcher ----
  // druga instancja serwera do testów launchera (limit prób z poprzedniego testu dotyczy adresu IP pierwszej)
  const srv2 = await startServer({ INVITE_ONLY: '1' });
  const adminKey2 = /(crown_\S+)/.exec(srv2.cli('create-key', 'Admin', 'admin').stdout)[1];
  const mk = (name) => {
    const o = srv2.cli('create-invite', name).stdout;
    return { key: /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(o)[1], id: /id: ([0-9a-f]{8})/.exec(o)[1] };
  };
  const ola = mk('Ola');
  await fetch(`${srv2.base}/v1/updates/latest.yml`, { method: 'PUT', headers: { Authorization: `Bearer ${adminKey2}` }, body: 'version: 1.0.0\n' });
  await backendDocs(srv2.dataDir, srv2.base).write('blocklist.json', { modIds: ['zlymod'] });

  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: srv2.base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-invcli-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const auth = require(root + 'src/main/core/auth.js');
  const invite = require(root + 'src/main/core/invite.js');
  const announcements = require(root + 'src/main/core/announcements.js');
  const anticheat = require(root + 'src/main/core/anticheat.js');
  const capes = require(root + 'src/main/core/capes.js');

  assert.strictEqual(invite.required(), true);
  assert.deepStrictEqual(await invite.status(), { required: true, active: false, name: '' });
  await assert.rejects(invite.assertAllowed(), /tylko dla zaproszonych/);
  await assert.rejects(invite.submit('CROWN-AAAA-AAAA-AAAA-AAAA'), /Nieprawidłowy lub unieważniony/);
  await assert.rejects(invite.submit('abc'), /formacie/);
  const s = await invite.submit(` ${ola.key.toLowerCase()} `);
  assert.deepStrictEqual(s, { required: true, active: true, name: 'Ola' });
  assert.ok(config.get().inviteKey.startsWith('raw:') || config.get().inviteKey.startsWith('enc:'), 'klucz zapisany przez seal');
  assert.ok(!JSON.stringify(config.get()).includes(ola.key.slice(6)), 'klucz nie leży w config.json jawnie');
  await invite.assertAllowed();
  assert.ok(!('inviteKey' in config.publicView()) && !('inviteOrigin' in config.publicView()), 'renderer nie dostaje klucza');
  ok('launcher: bez klucza blokada; zły klucz odrzucony; dobry zapisany zaszyfrowany i niewidoczny dla renderera');

  // klucz idzie tylko do właściwego serwera
  assert.ok(invite.headersFor(`${srv2.base}/updates`)['X-Crown-Invite']);
  assert.deepStrictEqual(invite.headersFor('https://obcy.example/updates'), {});
  assert.deepStrictEqual(invite.headersFor(`http://127.0.0.1:${srv2.port + 1}/x`), {}, 'inny port = inny serwer');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    if (String(url).startsWith('https://obcy.example')) return new Response('{"announcements":[]}', { status: 200 });
    return realFetch(url, opts);
  };
  try {
    config.set({ announcementsUrl: 'https://obcy.example/api' }); // podmiana adresu w ustawieniach
    await announcements.fetchItems();
    config.set({ announcementsUrl: '' });
    await announcements.fetchItems(); // wbudowany serwer
  } finally {
    global.fetch = realFetch;
  }
  const toObcy = seen.filter((q) => q.url.startsWith('https://obcy.example'));
  const toOurs = seen.filter((q) => q.url.startsWith(srv2.base));
  assert.ok(toObcy.length >= 1 && toObcy.every((q) => !JSON.stringify(q.headers).includes('X-Crown-Invite') && !JSON.stringify(q.headers).includes(ola.key.slice(6))), 'obcy serwer nie dostaje klucza');
  assert.ok(toOurs.length >= 1 && toOurs.every((q) => 'X-Crown-Invite' in q.headers), 'własny serwer dostaje');
  ok('klucz zaproszenia wysyłany tylko do serwera, dla którego go wpisano (podmiana adresu w ustawieniach go nie wydaje)');

  // lista blokad z serwera (zamiast GitHuba) i peleryny z kluczem
  const rules = await anticheat.loadRules({ force: true });
  assert.ok(rules.ids.has('zlymod'), 'blocklist.json z serwera zaczytany');
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'Ola', type: 'offline', uuid: 'u' }], selected: 'a1' });
  // peleryny są tylko dla kluczy z dostępem nadanym przez administratora (panel / set-capes)
  await assert.rejects(capes.select('builtin-gold'), /tylko dla wybranych graczy/);
  srv2.cli('set-capes', ola.id, 'on');
  await invite.status({ check: true, maxAgeMs: 0 });
  const sel = await capes.select('builtin-gold');
  assert.strictEqual(sel.shared, true, JSON.stringify(sel));
  assert.strictEqual((await fetch(`${srv2.base}/capes/Ola.png`)).status, 200);
  ok('launcher: lista blokad z serwera; wybór peleryny z kluczem zaproszenia przechodzi');

  // unieważnienie po stronie serwera blokuje launcher po następnym sprawdzeniu
  srv2.cli('revoke-invite', ola.id);
  config.set({ inviteCheckedAt: Date.now() - 7 * 3600_000 }); // ostatnie potwierdzenie starsze niż 6 h
  const lostStatus = await invite.status({ check: true });
  assert.deepStrictEqual([lostStatus.required, lostStatus.active, lostStatus.name], [true, false, '']);
  assert.match(lostStatus.lost, /unieważniony|Nieprawidłowy/, 'ekran blokady dostaje powód');
  assert.strictEqual(config.get().inviteKey, '', 'unieważniony klucz usunięty z launchera');
  await assert.rejects(invite.assertAllowed(), /tylko dla zaproszonych/);
  ok('unieważnienie na serwerze: launcher przy następnym sprawdzeniu traci ważność klucza i nie uruchomi gry');

  // brak sieci: okres łaski
  const ola2 = mk('Ola2');
  await invite.submit(ola2.key);
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    config.set({ inviteCheckedAt: Date.now() - 7 * 24 * 3600_000 });
    assert.strictEqual((await invite.status({ check: true })).active, true, 'tydzień bez sieci - nadal ważny');
    config.set({ inviteCheckedAt: Date.now() - 20 * 24 * 3600_000 });
    assert.strictEqual((await invite.status({ check: true })).active, false, '20 dni bez potwierdzenia - nie');
  } finally {
    global.fetch = realFetch;
  }
  ok('brak sieci: klucz działa do 14 dni od ostatniego potwierdzenia, potem trzeba połączyć się z serwerem');

  // wersja bez INVITE_REQUIRED i serwer bez INVITE_ONLY zachowują się jak dotąd
  appConfig.INVITE_REQUIRED = false;
  assert.deepStrictEqual(await invite.status(), { required: false, active: false, name: '' });
  await invite.assertAllowed();
  const open = await startServer();
  assert.strictEqual((await fetch(`${open.base}/health`)).status, 200);
  await fetch(`${open.base}/v1/updates/latest.yml`, { method: 'PUT', headers: { Authorization: `Bearer ${/(crown_\S+)/.exec(open.cli('create-key', 'A', 'admin').stdout)[1]}` }, body: 'version: 1\n' });
  assert.strictEqual((await fetch(`${open.base}/updates/latest.yml`)).status, 200, 'bez INVITE_ONLY aktualizacje publiczne jak dotąd');
  assert.strictEqual((await fetch(`${open.base}/`)).status, 404, 'bez INVITE_ONLY nie ma strony pobierania');
  ok('zgodność wsteczna: bez INVITE_REQUIRED/INVITE_ONLY nic się nie zmienia');

  // updater: nagłówki idą tylko do dostawcy generic (statyczna kontrola - updater.js wymaga Electrona)
  const upd = fs.readFileSync(root + 'src/main/updater.js', 'utf8');
  assert.ok(/requestHeaders = source\.provider === 'generic' \? invite\.headersFor\(source\.url\) : null/.test(upd));
  ok('updater: requestHeaders z kluczem tylko dla serwera aktualizacji (provider generic)');

  for (const p of [srv.proc, srv2.proc, open.proc]) p.kill();
  rmDir(ldir);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
