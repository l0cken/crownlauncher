// Dostęp do peleryn „tylko dla wybranych” (0.1.32): pole `capes` na kluczu zaproszenia (panel/API/CLI), bramka na serwerze
// (PUT /v1/capes/* → 403 bez dostępu, DELETE zawsze wolno), zdejmowanie peleryn po utracie dostępu i launcher (invite.js,
// capes.js: sekcja ukryta, dodawanie/wybór odrzucone). Prawdziwy server/server.js (INVITE_ONLY) + prawdziwe moduły launchera.
// Uruchomienie: node dev-tests/capes-access-test.js
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

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capeacc-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < startLoops && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  return { dataDir, port, base: `http://127.0.0.1:${port}`, proc, cli };
}

(async () => {
  const srv = await startServer();
  const { base, cli } = srv;
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin').stdout)[1];
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  const api = (method, p, body) => fetch(`${base}${p}`, { method, headers: bearer, body: body === undefined ? undefined : JSON.stringify(body) });
  const mk = async (name, extra = {}) => {
    const r = await api('POST', '/v1/admin/invites', { name, ...extra });
    assert.strictEqual(r.status, 201, `utworzenie klucza ${name}`);
    return r.json();
  };
  const listInvite = async (id) => (await (await api('GET', '/v1/admin/invites')).json()).invites.find((i) => i.id === id);
  const png = require(root + 'src/main/core/cape-art.js').render('crimson');
  const dev = (k) => `komputer-${k}-0123456789abcdefghijkl`;
  const secretOf = (nick) => `sekret-${nick}-0123456789abcdef`;
  const putCape = (nick, who, device) => fetch(`${base}/v1/capes/${nick}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'X-Crown-Invite': who.key, 'X-Crown-Device': device, 'X-Crown-Secret': secretOf(nick) },
    body: png,
  });
  const delCape = (nick, who, device) => fetch(`${base}/v1/capes/${nick}`, {
    method: 'DELETE',
    headers: { 'X-Crown-Invite': who.key, 'X-Crown-Device': device, 'X-Crown-Secret': secretOf(nick) },
  });
  const capeFile = (nick) => fetch(`${base}/capes/${nick}.png`);
  const probe = (who, device) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': who.key, 'X-Crown-Device': device } });

  // ---- klucz: domyślnie bez peleryn, dostęp nadaje administrator ----
  const bez = await mk('Bez');
  const z = await mk('Z', { capes: true });
  assert.strictEqual(bez.capes, false, 'nowy klucz domyślnie bez peleryn');
  assert.strictEqual(z.capes, true);
  assert.strictEqual((await listInvite(bez.id)).capes, false);
  assert.strictEqual((await listInvite(z.id)).capes, true);
  for (const bad of ['tak', 1, null]) {
    const r = await api('POST', `/v1/admin/invites/${bez.id}/update`, { capes: bad });
    assert.strictEqual(r.status, 400, `capes=${JSON.stringify(bad)} odrzucone`);
  }
  assert.strictEqual((await listInvite(bez.id)).capes, false, 'odrzucone żądanie niczego nie zmieniło');
  ok('API: nowy klucz domyślnie bez peleryn, pole capes (true/false) przyjmowane przy tworzeniu i edycji, inne wartości → 400');

  // ---- serwer: wgranie peleryny tylko z dostępem ----
  let r = await putCape('Bezdostepu', bez, dev('a'));
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /tylko dla wybranych graczy/);
  assert.strictEqual((await capeFile('Bezdostepu')).status, 404, 'nic nie zapisano');
  assert.ok(!(await (await fetch(`${base}/v1/crown-users`)).json()).some((u) => /bezdostepu/i.test(u.name)), 'nick bez dostępu nie trafia na listę');
  r = await putCape('Zdostepem', z, dev('b'));
  assert.strictEqual(r.status, 201);
  r = await capeFile('Zdostepem');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  // zaproszenie bez klucza w ogóle: 401 jak dotąd
  assert.strictEqual((await fetch(`${base}/v1/capes/Ktos`, { method: 'PUT', headers: { 'X-Crown-Secret': secretOf('Ktos') }, body: png })).status, 401);
  // klucz administracji (Bearer) nie podlega ograniczeniu
  r = await fetch(`${base}/v1/capes/Adminowa`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'image/png' }, body: png });
  assert.strictEqual(r.status, 201);
  ok('PUT /v1/capes: bez dostępu 403 z komunikatem (nic nie zapisane), z dostępem 201, bez klucza 401, klucz admin nadal może');

  // ---- /v1/invite mówi launcherowi, czy ma peleryny ----
  assert.strictEqual((await (await probe(bez, dev('a'))).json()).capes, false);
  assert.strictEqual((await (await probe(z, dev('b'))).json()).capes, true);
  assert.strictEqual((await (await fetch(`${base}/v1/invite`, { headers: { Authorization: `Bearer ${adminKey}` } })).json()).capes, true);
  ok('GET /v1/invite zwraca capes (false / true / true dla administratora)');

  // ---- zdjęcie własnej peleryny wolno zawsze ----
  r = await delCape('Bezdostepu', bez, dev('a'));
  assert.strictEqual(r.status, 204, 'launcher bez dostępu może posprzątać po sobie');
  ok('DELETE /v1/capes: klucz bez dostępu może zdjąć własną pelerynę (204)');

  // ---- wyłączenie dostępu zdejmuje peleryny wgrane tym kluczem ----
  assert.strictEqual((await api('POST', `/v1/admin/invites/${z.id}/update`, { capes: false })).status, 200);
  assert.strictEqual((await capeFile('Zdostepem')).status, 404, 'peleryna zniknęła od razu');
  assert.strictEqual((await putCape('Zdostepem', z, dev('b'))).status, 403, 'a ponowne wgranie jest odrzucone');
  assert.strictEqual((await (await probe(z, dev('b'))).json()).capes, false);
  assert.strictEqual((await capeFile('Adminowa')).status, 200, 'cudze peleryny zostają');
  // włączenie z powrotem, wgranie, a potem unieważnienie klucza też zdejmuje pelerynę
  await api('POST', `/v1/admin/invites/${z.id}/update`, { capes: true });
  assert.strictEqual((await putCape('Zdostepem', z, dev('b'))).status, 201);
  assert.strictEqual((await capeFile('Zdostepem')).status, 200);
  assert.strictEqual((await api('POST', `/v1/admin/invites/${z.id}/revoke`)).status, 200);
  assert.strictEqual((await capeFile('Zdostepem')).status, 404, 'unieważnienie klucza zdejmuje jego peleryny');
  ok('wyłączenie dostępu (i unieważnienie klucza) zdejmuje peleryny wgrane tym kluczem; cudze zostają; ponowne wgranie → 403');

  // ---- starszy wpis (bez pola capes) = bez dostępu ----
  const stary = await mk('StaryWpis', { capes: true });
  const docs = backendDocs(srv.dataDir, srv.base);
  const all = await docs.read('invites.json');
  const e = all.find((x) => x.id === stary.id);
  delete e.capes;
  delete e.capeNicks;
  await docs.write('invites.json', all);
  assert.strictEqual((await listInvite(stary.id)).capes, false);
  assert.strictEqual((await putCape('Stary', stary, dev('c'))).status, 403);
  ok('dawny klucz (bez pola capes) nie ma dostępu do peleryn, dopóki administrator go nie nada');

  // ---- CLI ----
  let out = cli('create-invite', 'Cli', '--capes').stdout;
  const cliKey = { key: /(CROWN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/.exec(out)[1], id: /id: ([0-9a-f]{8})/.exec(out)[1] };
  assert.match(cli('list-invites').stdout, new RegExp(`${cliKey.id}.*Cli.*peleryny`));
  assert.strictEqual((await putCape('Cli', cliKey, dev('d'))).status, 201);
  assert.match(cli('set-capes', cliKey.id, 'off').stdout, /wyłączone/);
  assert.strictEqual((await capeFile('Cli')).status, 404);
  assert.strictEqual((await putCape('Cli', cliKey, dev('d'))).status, 403);
  assert.match(cli('set-capes', cliKey.id, 'on').stdout, /włączone/);
  assert.strictEqual((await putCape('Cli', cliKey, dev('d'))).status, 201);
  assert.notStrictEqual(cli('set-capes', cliKey.id, 'moze').status, 0, 'zły argument kończy się błędem');
  assert.notStrictEqual(cli('set-capes', 'ffffffff', 'on').status, 0, 'nieznane id kończy się błędem');
  assert.strictEqual(cli('revoke-invite', cliKey.id).status, 0);
  assert.strictEqual((await capeFile('Cli')).status, 404, 'revoke-invite zdejmuje peleryny');
  ok('CLI: create-invite --capes, list-invites, set-capes on/off (zdejmuje peleryny), revoke-invite zdejmuje peleryny, błędne argumenty');

  // ---- launcher (prawdziwe invite.js i capes.js na tym serwerze) ----
  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  process.env.CROWN_CAPES_URL = base;
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capeacc-l-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const auth = require(root + 'src/main/core/auth.js');
  const invite = require(root + 'src/main/core/invite.js');
  const capes = require(root + 'src/main/core/capes.js');
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'KapeTest', type: 'offline' }], selected: 'a1' });
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const denied = /tylko dla wybranych graczy/;

  // bez klucza: brak dostępu
  assert.strictEqual(invite.capesAllowed(), false);
  const none = await capes.state();
  assert.deepStrictEqual([none.allowed, none.capes.length, none.selected], [false, 0, '']);

  // klucz bez peleryn
  const gracz = await mk('Gracz');
  await invite.submit(gracz.key);
  assert.strictEqual(config.get().inviteCapes, false);
  assert.strictEqual(invite.capesAllowed(), false);
  const st0 = await capes.state();
  assert.deepStrictEqual([st0.allowed, st0.capes.length, st0.selected], [false, 0, ''], 'sekcja peleryn pusta i wyłączona');
  await assert.rejects(capes.add({ name: 'x', dataUrl }), denied);
  await assert.rejects(capes.select('builtin-crimson'), denied);
  assert.throws(() => capes.requireAccess(), denied);
  assert.strictEqual((await fetch(`${base}/capes/KapeTest.png`)).status, 404);
  ok('launcher z kluczem bez peleryn: state.allowed=false (puste), dodanie i wybór odrzucone, nic nie trafia na serwer');

  // administrator nadaje dostęp - launcher widzi go przy następnym sprawdzeniu klucza
  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { capes: true });
  const s1 = await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual(s1.active, true);
  assert.strictEqual(config.get().inviteCapes, true);
  assert.strictEqual(invite.capesAllowed(), true);
  const st1 = await capes.state();
  assert.strictEqual(st1.allowed, true);
  assert.ok(st1.capes.length >= 6, 'wbudowane peleryny widoczne');
  const sel = await capes.select('builtin-crimson');
  assert.strictEqual(sel.shared, true, 'wybór trafia na serwer');
  assert.strictEqual((await fetch(`${base}/capes/KapeTest.png`)).status, 200);
  assert.strictEqual((await capes.state()).selected, 'builtin-crimson');
  const added = await capes.add({ name: 'Moja', dataUrl });
  assert.ok(added.id);
  ok('launcher po nadaniu dostępu w panelu: sekcja pojawia się, wybór i dodanie działają, peleryna widoczna na serwerze');

  // administrator odbiera dostęp: peleryna znika z serwera, a launcher przestaje ją pokazywać i wysyłać
  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { capes: false });
  assert.strictEqual((await capeFile('KapeTest')).status, 404, 'peleryna zdjęta z serwera przez panel');
  await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual(config.get().inviteCapes, false);
  const st2 = await capes.state();
  assert.deepStrictEqual([st2.allowed, st2.capes.length, st2.selected], [false, 0, ''], 'zapisany wybór nie jest już używany');
  assert.ok(config.get().capeByName.KapeTest, 'sam zapisany wybór zostaje (wróci po ponownym nadaniu dostępu)');
  const pub = await capes.publishCape('KapeTest');
  assert.strictEqual(pub.shared, false, 'bez dostępu launcher nic nie wysyła, tylko zdejmuje');
  assert.strictEqual((await capeFile('KapeTest')).status, 404);
  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { capes: true });
  await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual((await capes.state()).selected, 'builtin-crimson', 'po ponownym nadaniu wybór wraca');
  ok('launcher po odebraniu dostępu: sekcja znika, wybór nieużywany i niewysyłany, po ponownym nadaniu wraca');

  // zmiana klucza / wylogowanie zeruje dostęp
  invite.clear('test');
  assert.strictEqual(config.get().inviteCapes, false);
  assert.strictEqual(invite.capesAllowed(), false);
  ok('launcher: utrata klucza zeruje dostęp do peleryn');

  // launcher bez kluczy zaproszeń (tryb GitHub / publiczny) nie ma tego ograniczenia
  Object.assign(appConfig, { INVITE_REQUIRED: false });
  assert.strictEqual(invite.capesAllowed(), true);
  assert.strictEqual((await capes.state()).allowed, true);
  ok('launcher bez wymaganych kluczy zaproszeń: peleryny bez ograniczeń (jak dotąd)');

  srv.proc.kill();
  for (const d of [srv.dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
