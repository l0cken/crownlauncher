// Launcher a bramka serwera gry: prawdziwe invite.js + gate.js na prawdziwym backendzie (INVITE_ONLY): zgłoszenie sesji przy starcie
// gry, odnawianie w tle, zdjęcie po zamknięciu, odmowa dla unieważnionego klucza, brak sieci i tryb bez kluczy zaproszeń.
// Uruchomienie: node dev-tests/gate-launcher-test.js   (na Workerze: CROWN_BACKEND=cf)
process.env.CROWN_GATE_BEAT_MS = '1000';
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { serverEntry, startLoops, rmDir } = require('./lib/backend');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-gatel-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', PLAY_TTL_MS: '3000' };
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
  const gateKey = (await (await api('POST', '/v1/admin/gate/key')).json()).key;
  const verdict = async (nick) => (await fetch(`${base}/v1/gate/check?nick=${nick}`, { headers: { 'X-Crown-Gate': gateKey } })).json();
  const until = async (nick, want, ms = 6000) => {
    for (let t = 0; t < ms; t += 150) {
      if ((await verdict(nick)).allowed === want) return true;
      await sleep(150);
    }
    return false;
  };

  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-gatel-l-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const invite = require(root + 'src/main/core/invite.js');
  const gate = require(root + 'src/main/core/gate.js');
  assert.strictEqual(gate.BEAT_MS, 1000);

  const konto = (username) => ({ username, uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' });

  // ---- bez klucza zaproszenia launcher nie ma czego zgłaszać (a grę i tak blokuje ekran z kluczem) ----
  assert.deepStrictEqual(await gate.begin('i0', konto('BezKlucza')), { skipped: true });
  assert.strictEqual((await verdict('BezKlucza')).allowed, false);
  ok('bez klucza zaproszenia: nic nie jest zgłaszane');

  // ---- start gry: sesja zgłoszona od razu, odnawiana w tle, zdjęta po zamknięciu ----
  const made = await (await api('POST', '/v1/admin/invites', { name: 'Gracz' })).json();
  await invite.submit(made.key);
  const r = await gate.begin('i1', konto('KoronaTest'));
  assert.strictEqual(r.ok, true, 'zgłoszenie sesji przy starcie gry');
  const v = await verdict('KoronaTest');
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.by, 'Gracz');
  await sleep(4500); // dłużej niż TTL serwera (3 s): żyje tylko dzięki odnawianiu co sekundę
  assert.strictEqual((await verdict('KoronaTest')).allowed, true, 'launcher odnawia sesję, dopóki gra działa');
  gate.end('i1');
  assert.ok(await until('KoronaTest', false), 'po zamknięciu gry sesja znika');
  await sleep(2500);
  assert.strictEqual((await verdict('KoronaTest')).allowed, false, 'po zamknięciu gry launcher nie odnawia już sesji');
  ok('sesja: zgłoszona przy starcie, odnawiana co minutę (tu co sekundę) i zdjęta po zamknięciu gry');

  // ---- dwa konta naraz na jednym komputerze, powtórny start tej samej instancji ----
  assert.strictEqual((await gate.begin('a', konto('Konto_A'))).ok, true);
  assert.strictEqual((await gate.begin('b', konto('Konto_B'))).ok, true);
  assert.strictEqual((await verdict('Konto_A')).allowed && (await verdict('Konto_B')).allowed, true);
  assert.strictEqual((await gate.begin('a', konto('Konto_A2'))).ok, true, 'ponowny start instancji zastępuje jej sesję');
  assert.ok(await until('Konto_A', false), 'poprzedni nick tej instancji zdjęty');
  assert.strictEqual((await verdict('Konto_A2')).allowed, true);
  gate.endAll();
  assert.ok((await until('Konto_B', false)) && (await until('Konto_A2', false)), 'endAll zdejmuje wszystkie sesje');
  ok('dwa konta naraz, ponowny start instancji zastępuje sesję, endAll zdejmuje wszystko');

  // ---- limit nicków z jednego komputera: komunikat serwera trafia do konsoli gry, start nie jest blokowany ----
  for (const nick of ['Limit_1', 'Limit_2', 'Limit_3', 'Limit_4']) assert.strictEqual((await gate.begin(nick, konto(nick))).ok, true);
  const over = await gate.begin('Limit_5', konto('Limit_5'));
  assert.strictEqual(over.ok, false);
  assert.match(over.message, /co najwyżej 4 nickach/);
  gate.endAll();
  ok('piąty nick z jednego komputera: komunikat serwera zamiast wyjątku (start gry nie jest blokowany)');

  // ---- unieważniony klucz: serwer odmawia zgłoszenia, bramka nie wpuszcza ----
  assert.strictEqual((await gate.begin('r1', konto('Cofniety'))).ok, true);
  await api('POST', `/v1/admin/invites/${made.id}/revoke`);
  assert.ok(await until('Cofniety', false, 3000), 'unieważnienie odcina mimo żywej sesji');
  const denied = await gate.begin('r2', konto('Cofniety2'));
  assert.strictEqual(denied.ok, false);
  assert.ok(denied.message, 'powód odmowy z serwera');
  gate.endAll();
  ok('unieważniony klucz: sesja przestaje wpuszczać, a nowa nie powstaje (komunikat z serwera)');

  // ---- brak sieci: bez wyjątku, z czytelnym komunikatem; potem odnawianie wraca po przywróceniu serwera ----
  const made2 = await (await api('POST', '/v1/admin/invites', { name: 'Gracz2' })).json();
  await invite.submit(made2.key);
  Object.assign(appConfig, { ANNOUNCEMENTS_URL: base });
  const cfg = require(root + 'src/main/core/config.js');
  const realOrigin = cfg.get().inviteOrigin;
  const dead = `http://127.0.0.1:${await freePort()}`;
  cfg.set({ inviteOrigin: dead }); // zapisany klucz „należy” do martwego adresu
  Object.assign(appConfig, { ANNOUNCEMENTS_URL: dead });
  const offline = await gate.begin('o1', konto('BezSieci'));
  assert.strictEqual(offline.ok, false);
  assert.match(offline.message, /brak połączenia/);
  gate.endAll();
  Object.assign(appConfig, { ANNOUNCEMENTS_URL: base });
  cfg.set({ inviteOrigin: realOrigin });
  ok('brak sieci: wynik z komunikatem „brak połączenia”, bez wyjątku');

  // ---- instancja wydarzenia (IGRZYSKA ŚMIERCI): launcher zgłasza sesję KODEM WYDARZENIA; zwykła instancja nie przejdzie bramki wydarzenia ----
  const eventCore = require(root + 'src/main/core/event.js');
  const made3 = await (await api('POST', '/v1/admin/invites', { name: 'Gracz3' })).json();
  const kod = await (await api('POST', '/v1/admin/invites', { name: 'KodIgrzysk', profile: 'igrzyska', maxUses: 0 })).json();
  await invite.submit(made3.key); // gracz z pełnym dostępem...
  const verdictEv = async (nick) => (await fetch(`${base}/v1/gate/check?nick=${nick}&event=igrzyska`, { headers: { 'X-Crown-Gate': gateKey } })).json();
  assert.deepStrictEqual(await gate.begin('e0', konto('BezKodu'), { event: 'igrzyska' }), { skipped: true }, 'bez wpisanego kodu wydarzenia instancja wydarzenia nie ma czym zgłosić sesji');
  await eventCore.redeem(kod.key); // ...wpisuje kod wydarzenia w zakładce IGRZYSKA ŚMIERCI
  const e1 = await gate.begin('e1', konto('Igrzyskowy'), { event: 'igrzyska' });
  assert.strictEqual(e1.ok, true, 'instancja wydarzenia zgłasza sesję wydarzenia');
  const evV = await verdictEv('Igrzyskowy');
  assert.deepStrictEqual({ a: evV.allowed, by: evV.by }, { a: true, by: 'KodIgrzysk' }, 'sesja wydarzenia pochodzi z KODU wydarzenia, nie z pełnego klucza');
  assert.strictEqual((await verdict('Igrzyskowy')).allowed, true, 'jest też zwykłą sesją');
  assert.strictEqual((await gate.begin('n1', konto('ZwyklaInstancja'))).ok, true);
  assert.deepStrictEqual(await verdictEv('ZwyklaInstancja'), { allowed: false, reason: 'wrong-instance' }, 'zwykła instancja tego samego launchera nie przechodzi bramki wydarzenia');
  assert.strictEqual((await verdict('ZwyklaInstancja')).allowed, true, 'a zwykłą bramkę (dowolna instancja) przechodzi');
  await sleep(4500); // dłużej niż TTL serwera (3 s): sesja wydarzenia żyje dzięki odnawianiu z kodem wydarzenia
  assert.strictEqual((await verdictEv('Igrzyskowy')).allowed, true, 'launcher odnawia sesję wydarzenia, dopóki gra działa');
  gate.end('e1');
  assert.ok(await until('Igrzyskowy', false), 'po zamknięciu instancji wydarzenia sesja znika');
  gate.endAll();
  ok('instancja wydarzenia zgłasza sesję kodem wydarzenia (odnawianą i zdejmowaną), zwykła instancja nie przechodzi bramki wydarzenia, bez kodu nic się nie zgłasza');

  // ---- launcher bez wymaganych kluczy zaproszeń (tryb GitHub / testy): bramka nic nie robi ----
  Object.assign(appConfig, { INVITE_REQUIRED: false });
  assert.deepStrictEqual(await gate.begin('g1', konto('BezKluczy')), { skipped: true });
  assert.strictEqual((await verdict('BezKluczy')).allowed, false);
  ok('launcher bez wymaganych kluczy zaproszeń: bramka nic nie zgłasza');

  proc.kill();
  for (const d of [dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
