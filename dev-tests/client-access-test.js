// „Peleryny i korona w grze” (wyłączenie CrownClienta) „tylko dla wybranych” (0.1.32): pole `disableClient` na kluczu zaproszenia
// (panel/API/CLI), /v1/invite, launcher (invite.cosmeticsOffAllowed / cosmeticsOff, config) i wpływ na grę (korona, peleryny).
// Prawdziwy server/server.js (INVITE_ONLY) + prawdziwe invite.js. Uruchomienie: node dev-tests/client-access-test.js
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

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cliacc-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < startLoops && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const base = `http://127.0.0.1:${port}`;
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin').stdout)[1];
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  const api = (method, p, body) => fetch(`${base}${p}`, { method, headers: bearer, body: body === undefined ? undefined : JSON.stringify(body) });
  const mk = async (name, extra = {}) => {
    const r = await api('POST', '/v1/admin/invites', { name, ...extra });
    assert.strictEqual(r.status, 201);
    return r.json();
  };
  const listInvite = async (id) => (await (await api('GET', '/v1/admin/invites')).json()).invites.find((i) => i.id === id);
  const probe = (who, device) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': who.key, 'X-Crown-Device': device } });
  const dev = (k) => `komputer-${k}-0123456789abcdefghijkl`;

  // ---- API: domyślnie wyłączone, nadaje administrator ----
  const bez = await mk('Bez');
  const moze = await mk('Moze', { disableClient: true });
  assert.strictEqual(bez.disableClient, false, 'nowy klucz domyślnie bez możliwości wyłączenia CrownClienta');
  assert.strictEqual(moze.disableClient, true);
  assert.strictEqual((await listInvite(bez.id)).disableClient, false);
  for (const bad of ['tak', 1, null]) {
    assert.strictEqual((await api('POST', `/v1/admin/invites/${bez.id}/update`, { disableClient: bad })).status, 400, `disableClient=${JSON.stringify(bad)}`);
  }
  assert.strictEqual((await api('POST', `/v1/admin/invites/${bez.id}/update`, { disableClient: true })).status, 200);
  assert.strictEqual((await listInvite(bez.id)).disableClient, true);
  assert.strictEqual((await api('POST', `/v1/admin/invites/${bez.id}/update`, { name: 'Bez', note: 'x' })).status, 200);
  assert.strictEqual((await listInvite(bez.id)).disableClient, true, 'edycja innych pól nie rusza dostępu');
  assert.strictEqual((await api('POST', `/v1/admin/invites/${bez.id}/update`, { disableClient: false })).status, 200);
  assert.strictEqual((await listInvite(bez.id)).disableClient, false);
  ok('API: domyślnie bez dostępu, pole przy tworzeniu i edycji (inne wartości → 400), edycja innych pól go nie zmienia');

  // ---- /v1/invite ----
  assert.strictEqual((await (await probe(bez, dev('a'))).json()).disableClient, false);
  assert.strictEqual((await (await probe(moze, dev('b'))).json()).disableClient, true);
  assert.strictEqual((await (await fetch(`${base}/v1/invite`, { headers: { Authorization: `Bearer ${adminKey}` } })).json()).disableClient, true);
  ok('GET /v1/invite zwraca disableClient (false / true / true dla administratora)');

  // ---- dawny wpis bez pola ----
  const stary = await mk('Stary', { disableClient: true });
  const docs = backendDocs(dataDir, base);
  const all = await docs.read('invites.json');
  delete all.find((x) => x.id === stary.id).disableClient;
  await docs.write('invites.json', all);
  assert.strictEqual((await listInvite(stary.id)).disableClient, false);
  ok('dawny klucz (bez pola) nie może wyłączyć CrownClienta, dopóki administrator tego nie nada');

  // ---- CLI ----
  const out = cli('create-invite', 'Cli', '--disable-client').stdout;
  const cliInv = { key: /(CROWN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/.exec(out)[1], id: /id: ([0-9a-f]{8})/.exec(out)[1] };
  assert.match(cli('list-invites').stdout, new RegExp(`${cliInv.id}.*Cli.*może wyłączyć CrownClienta`));
  assert.strictEqual((await (await probe(cliInv, dev('c'))).json()).disableClient, true);
  assert.match(cli('set-disable-client', cliInv.id, 'off').stdout, /niedozwolone/);
  assert.strictEqual((await (await probe(cliInv, dev('c'))).json()).disableClient, false);
  assert.match(cli('set-disable-client', cliInv.id, 'on').stdout, /dozwolone/);
  assert.notStrictEqual(cli('set-disable-client', cliInv.id, 'moze').status, 0);
  assert.notStrictEqual(cli('set-disable-client', 'ffffffff', 'on').status, 0);
  ok('CLI: create-invite --disable-client, list-invites, set-disable-client on/off, błędne argumenty');

  // ---- launcher ----
  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cliacc-l-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const invite = require(root + 'src/main/core/invite.js');
  const capes = require(root + 'src/main/core/capes.js');
  const launch = require(root + 'src/main/core/launch.js');
  require(root + 'src/main/core/auth.js').listPublic = () => ({ accounts: [{ id: 'a1', username: 'KoronaTest', type: 'offline' }], selected: 'a1' });
  const crownOn = () => capes.localMembersArgs().length === 1 && !launch.badgeProperties().includes('-Dcrownclient.badge=off');

  assert.strictEqual(invite.cosmeticsOffAllowed(), false, 'bez klucza nie ma dostępu');
  config.set({ cosmetics: false }); // ktoś ręcznie przestawił ustawienie w config.json
  assert.strictEqual(invite.cosmeticsOff(), false, 'bez dostępu samo ustawienie nic nie wyłącza');

  const gracz = await mk('Gracz');
  await invite.submit(gracz.key);
  assert.strictEqual(config.get().inviteDisableClient, false);
  assert.strictEqual(invite.cosmeticsOffAllowed(), false);
  assert.strictEqual(invite.cosmeticsOff(), false, 'klucz bez dostępu: peleryny i korona zostają włączone mimo ustawienia w pliku');
  assert.ok(crownOn(), 'korona (members, bez badge=off) zostaje');
  assert.strictEqual((await capes.state()).enabled, true);
  ok('launcher z kluczem bez dostępu: nie może wyłączyć peleryn i korony (nawet ręcznie zmienionym config.json)');

  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { disableClient: true });
  await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual(config.get().inviteDisableClient, true);
  assert.strictEqual(invite.cosmeticsOffAllowed(), true);
  assert.strictEqual(invite.cosmeticsOff(), true, 'ustawienie gracza zaczyna działać po nadaniu dostępu');
  assert.deepStrictEqual(capes.localMembersArgs(), [], 'bez korony przy własnych kontach');
  assert.ok(launch.badgeProperties().includes('-Dcrownclient.badge=off'), 'korona wyłączona także u innych graczy');
  assert.strictEqual((await capes.state()).enabled, false);
  config.set({ cosmetics: true });
  assert.strictEqual(invite.cosmeticsOff(), false, 'z dostępem, ale bez wyłączenia: peleryny i korona działają');
  assert.ok(crownOn());
  config.set({ cosmetics: false });
  ok('launcher po nadaniu dostępu: wybór „wyłącz” wyłącza koronę (members, badge=off) i peleryny, „włączone” je zostawia');

  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { disableClient: false });
  await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual(invite.cosmeticsOffAllowed(), false);
  assert.strictEqual(invite.cosmeticsOff(), false, 'odebranie dostępu włącza peleryny i koronę z powrotem');
  assert.ok(crownOn());
  assert.strictEqual(config.get().cosmetics, false, 'sam wybór gracza zostaje zapamiętany (wróci po ponownym nadaniu)');
  await api('POST', `/v1/admin/invites/${gracz.id}/update`, { disableClient: true });
  await invite.status({ check: true, maxAgeMs: 0 });
  assert.strictEqual(invite.cosmeticsOff(), true);
  invite.clear('test');
  assert.strictEqual(config.get().inviteDisableClient, false, 'utrata klucza zeruje dostęp');
  assert.strictEqual(invite.cosmeticsOff(), false);
  ok('launcher po odebraniu dostępu albo utracie klucza: peleryny i korona znów włączone (wybór gracza zostaje zapamiętany)');

  // bez wymaganych zaproszeń (tryb GitHub / testy) nikt tego nie nadaje, więc peleryny i korona są zawsze włączone
  Object.assign(appConfig, { INVITE_REQUIRED: false });
  assert.strictEqual(invite.cosmeticsOffAllowed(), false);
  assert.strictEqual(invite.cosmeticsOff(), false);
  assert.ok(crownOn());
  ok('launcher bez wymaganych kluczy zaproszeń: peleryny i korona zawsze włączone (jak dotąd)');

  proc.kill();
  for (const d of [dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
