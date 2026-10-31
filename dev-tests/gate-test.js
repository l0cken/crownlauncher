// Bramka serwera gry („na serwer tylko z launchera”): sesje gry zgłaszane przez launcher (POST/DELETE /v1/play) i pytanie pluginu
// na proxy (GET /v1/gate/check z kluczem bramki). Prawdziwy server/server.js (INVITE_ONLY) albo Worker (CROWN_BACKEND=cf).
// Uruchomienie: node dev-tests/gate-test.js
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { serverEntry, startLoops, rmDir } = require('./lib/backend');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-gate-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', PLAY_TTL_MS: '4000' };
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
  const dev = (k) => `komputer-${k}-0123456789abcdefghijkl`;
  const asPlayer = (who, device, extra = {}) => ({ 'X-Crown-Invite': who.key, 'X-Crown-Device': device, 'Content-Type': 'application/json', ...extra });
  const play = (who, device, nick, uuid) => fetch(`${base}/v1/play`, { method: 'POST', headers: asPlayer(who, device), body: JSON.stringify({ nick, uuid }) });
  const unplay = (who, device, nick) => fetch(`${base}/v1/play?nick=${nick}`, { method: 'DELETE', headers: asPlayer(who, device) });
  const check = (gateKey, nick) => fetch(`${base}/v1/gate/check?nick=${encodeURIComponent(nick)}`, { headers: gateKey ? { 'X-Crown-Gate': gateKey } : {} });
  const verdict = async (gateKey, nick) => (await check(gateKey, nick)).json();

  // ---- klucz bramki ----
  assert.strictEqual((await check('', 'Steve')).status, 401, 'bez klucza bramki 401');
  assert.strictEqual((await check('gate_nie-ma-takiego-klucza-0123456789', 'Steve')).status, 401, 'bez utworzonego klucza bramki każdy klucz jest zły');
  const g0 = await (await api('GET', '/v1/admin/gate')).json();
  assert.strictEqual(g0.keySet, false);
  const made = await api('POST', '/v1/admin/gate/key');
  assert.strictEqual(made.status, 201);
  const gate = (await made.json()).key;
  assert.ok(/^gate_[A-Za-z0-9_-]{30,}$/.test(gate), 'klucz bramki ma prefiks gate_');
  assert.strictEqual((await api('GET', '/v1/admin/gate').then((r) => r.json())).keySet, true);
  assert.strictEqual((await check(gate, 'Steve')).status, 200);
  assert.deepStrictEqual(await verdict(gate, 'Steve'), { allowed: false, reason: 'no-session' }, 'nick bez sesji nie wchodzi');
  assert.strictEqual((await check(gate, 'x')).status, 400, 'za krótki nick');
  assert.strictEqual((await check(gate, 'zły nick!')).status, 400, 'niedozwolone znaki');
  ok('klucz bramki: bez niego 401, tworzy go tylko administrator, nick bez sesji → no-session, zły nick → 400');

  // ---- sesja z launchera ----
  const ala = await mk('Ala');
  const ola = await mk('Ola', { maxUses: 2 });
  assert.strictEqual((await fetch(`${base}/v1/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nick":"Steve"}' })).status, 401, 'bez klucza zaproszenia nie ma sesji');
  assert.strictEqual((await fetch(`${base}/v1/play`, { method: 'POST', headers: asPlayer({ key: 'CROWN-AAAA-BBBB-CCCC-DDDD' }, dev('a')), body: '{"nick":"Steve"}' })).status, 401, 'zły klucz zaproszenia');
  assert.strictEqual((await play(ala, dev('a'), 'x')).status, 400, 'zły nick w sesji');
  const r1 = await play(ala, dev('a'), 'Steve', '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(r1.status, 200);
  assert.ok((await r1.json()).ttl >= 1);
  const v1 = await verdict(gate, 'Steve');
  assert.strictEqual(v1.allowed, true);
  assert.strictEqual(v1.by, 'Ala', 'plugin dostaje, czyj to klucz');
  assert.strictEqual((await verdict(gate, 'steve')).allowed, true, 'wielkość liter nie ma znaczenia');
  assert.strictEqual((await verdict(gate, 'STEVE')).allowed, true);
  assert.strictEqual((await verdict(gate, 'Alex')).allowed, false, 'inny nick nie dziedziczy sesji');
  ok('sesja z launchera: wymaga ważnego klucza, nick wchodzi bez względu na wielkość liter, plugin widzi czyj to klucz');

  // ---- wygasanie i odnawianie ----
  await sleep(2500);
  assert.strictEqual((await play(ala, dev('a'), 'Steve')).status, 200, 'odnowienie sesji');
  await sleep(2500); // od pierwszego zgłoszenia minęło 5 s > TTL 4 s, ale odnowienie przedłużyło sesję
  assert.strictEqual((await verdict(gate, 'Steve')).allowed, true, 'odnowiona sesja żyje dłużej niż TTL od pierwszego zgłoszenia');
  await sleep(4500);
  assert.deepStrictEqual(await verdict(gate, 'Steve'), { allowed: false, reason: 'no-session' }, 'bez odnawiania sesja wygasa');
  ok('sesja wygasa po TTL bez zgłoszeń launchera, a odnawianie ją przedłuża');

  // ---- kończenie gry (DELETE), cudzych sesji nie ruszamy ----
  await play(ala, dev('a'), 'Steve');
  assert.strictEqual((await unplay(ola, dev('o'), 'Steve')).status, 204, 'obcy klucz dostaje 204…');
  assert.strictEqual((await verdict(gate, 'Steve')).allowed, true, '…ale cudza sesja zostaje');
  assert.strictEqual((await unplay(ala, dev('a'), 'Steve')).status, 204);
  assert.strictEqual((await verdict(gate, 'Steve')).allowed, false, 'zamknięcie gry zdejmuje sesję');
  assert.strictEqual((await unplay(ala, dev('a'), 'x')).status, 400);
  ok('zamknięcie gry zdejmuje sesję; DELETE cudzego nicku nic nie robi');

  // ---- unieważnienie, wygaśnięcie klucza, zwolnienie komputera: działają od razu przy następnym wejściu ----
  await play(ala, dev('a'), 'Steve');
  assert.strictEqual((await api('POST', `/v1/admin/invites/${ala.id}/revoke`)).status, 200);
  assert.deepStrictEqual(await verdict(gate, 'Steve'), { allowed: false, reason: 'revoked' }, 'unieważniony klucz nie wpuści mimo żywej sesji');
  assert.strictEqual((await play(ala, dev('a'), 'Steve')).status, 401, 'unieważniony klucz nie założy nowej sesji');

  await play(ola, dev('o'), 'Zofia');
  assert.strictEqual((await verdict(gate, 'Zofia')).allowed, true);
  assert.strictEqual((await api('POST', `/v1/admin/invites/${ola.id}/update`, { expiresAt: new Date(Date.now() - 60_000).toISOString() })).status, 200);
  assert.deepStrictEqual(await verdict(gate, 'Zofia'), { allowed: false, reason: 'expired' }, 'wygasły klucz');
  assert.strictEqual((await api('POST', `/v1/admin/invites/${ola.id}/update`, { expiresAt: '' })).status, 200);
  assert.strictEqual((await verdict(gate, 'Zofia')).allowed, true, 'przedłużony klucz znów wpuszcza');
  assert.strictEqual((await api('POST', `/v1/admin/invites/${ola.id}/release`, { device: (await mkDeviceHash(ola)).slice(0, 8) })).status, 200);
  assert.deepStrictEqual(await verdict(gate, 'Zofia'), { allowed: false, reason: 'released' }, 'zwolniony komputer');
  ok('unieważnienie, wygaśnięcie klucza i „Zwolnij” odcinają od razu (mimo żywej sesji), przedłużenie klucza przywraca');

  async function mkDeviceHash(inv) {
    const list = (await (await api('GET', '/v1/admin/invites')).json()).invites.find((i) => i.id === inv.id);
    return list.devices[0].id;
  }

  // ---- limit nicków z jednego komputera ----
  const kasia = await mk('Kasia', { maxUses: 2 });
  for (const nick of ['Gracz_1', 'Gracz_2', 'Gracz_3', 'Gracz_4']) assert.strictEqual((await play(kasia, dev('k'), nick)).status, 200, nick);
  assert.strictEqual((await play(kasia, dev('k'), 'Gracz_5')).status, 429, 'piąty nick z jednego komputera');
  assert.strictEqual((await play(kasia, dev('k'), 'Gracz_2')).status, 200, 'odnowienie istniejącego nicku nie liczy się jako nowy');
  assert.strictEqual((await play(kasia, dev('k2'), 'Gracz_5')).status, 200, 'drugi komputer tego klucza ma własny limit');
  ok('limit 4 nicków naraz z jednego komputera i klucza (odnowienie nie liczy się, drugi komputer ma własny limit)');

  // ---- klucz administratora (testy / obsługa) i podgląd w panelu ----
  assert.strictEqual((await fetch(`${base}/v1/play`, { method: 'POST', headers: bearer, body: JSON.stringify({ nick: 'Brhpq' }) })).status, 200);
  assert.strictEqual((await verdict(gate, 'Brhpq')).allowed, true);
  const list = await (await api('GET', '/v1/admin/gate')).json();
  assert.ok(list.sessions.some((s) => s.nick === 'Gracz_1' && s.by === 'Kasia'), 'lista sesji w API admina');
  assert.ok(list.sessions.every((s) => !('uuid' in s) && !('dev' in s) && !('inviteId' in s)), 'lista nie wyciąga identyfikatorów');
  assert.strictEqual((await api('DELETE', '/v1/admin/play/Gracz_1')).status, 200);
  assert.strictEqual((await verdict(gate, 'Gracz_1')).allowed, false, 'administrator zdejmuje sesję');
  assert.strictEqual((await api('DELETE', '/v1/admin/play/Gracz_1')).status, 404);
  ok('API admina: lista sesji (bez identyfikatorów), zdejmowanie sesji; klucz admina też może zgłosić sesję');

  // ---- sesje nie wychodzą publicznie ----
  const probe = await fetch(`${base}/v1/gate/check?nick=Brhpq`, { headers: { 'X-Crown-Invite': ala.key } });
  assert.strictEqual(probe.status, 401, 'klucz zaproszenia nie wystarcza do pytania bramki');
  assert.strictEqual((await fetch(`${base}/v1/admin/gate`)).status, 401, 'lista sesji tylko dla administratora');
  ok('klucz zaproszenia nie otwiera bramki, a lista sesji wymaga logowania administratora');

  // ---- klucz bramki: rotacja i ochrona przed zgadywaniem ----
  const rotated = (await (await api('POST', '/v1/admin/gate/key')).json()).key;
  assert.notStrictEqual(rotated, gate);
  assert.strictEqual((await check(gate, 'Brhpq')).status, 401, 'stary klucz bramki przestaje działać po rotacji');
  assert.strictEqual((await verdict(rotated, 'Brhpq')).allowed, true);
  let last = 0;
  for (let i = 0; i < 14 && last !== 429; i++) last = (await check(`gate_zly-klucz-${i}-0123456789abcdef`, 'Steve')).status;
  assert.strictEqual(last, 429, 'zgadywanie klucza bramki jest ograniczone');
  assert.strictEqual((await check(rotated, 'Brhpq')).status, 200, 'poprawny klucz nie jest blokowany przez limit prób zgadywania');
  ok('rotacja klucza bramki unieważnia stary; zgadywanie klucza → 429, a poprawny klucz dalej działa');

  // ---- sesja z instancji wydarzenia (IGRZYSKA ŚMIERCI): tylko kod wydarzenia; gracz z innej instancji CrownLaunchera nie przechodzi ----
  const zwykly = await mk('Zwykly', { maxUses: 3 });
  const kod = await mk('KodIgrzysk', { profile: 'igrzyska', maxUses: 0 });
  const playEv = (who, device, nick, event) => fetch(`${base}/v1/play`, { method: 'POST', headers: asPlayer(who, device), body: JSON.stringify({ nick, event }) });
  const verdictEv = async (nick, event = 'igrzyska') => (await fetch(`${base}/v1/gate/check?nick=${nick}&event=${event}`, { headers: { 'X-Crown-Gate': rotated } })).json();
  assert.strictEqual((await playEv(zwykly, dev('z'), 'Zwykly_1', 'igrzyska')).status, 403, 'pełny klucz bez kodu wydarzenia nie zgłosi sesji wydarzenia');
  assert.strictEqual((await playEv(kod, dev('i'), 'Igrzysk_1', 'nie-ma-takiego')).status, 400, 'nieistniejące wydarzenie');
  assert.strictEqual((await playEv(kod, dev('i'), 'Igrzysk_1', 'ZLE ID!')).status, 400, 'niepoprawne id wydarzenia');
  assert.strictEqual((await playEv(kod, dev('i'), 'Igrzysk_1', 'igrzyska')).status, 200, 'kod wydarzenia zgłasza sesję wydarzenia');
  assert.strictEqual((await play(zwykly, dev('z'), 'Zwykly_1')).status, 200, 'zwykła instancja: zwykła sesja');
  const ev1 = await verdictEv('Igrzysk_1');
  assert.deepStrictEqual({ a: ev1.allowed, by: ev1.by, e: ev1.event }, { a: true, by: 'KodIgrzysk', e: 'igrzyska' }, 'instancja wydarzenia przechodzi bramkę wydarzenia');
  assert.strictEqual((await verdict(rotated, 'Igrzysk_1')).allowed, true, 'a pluginy bez „event” widzą ją jako zwykłą sesję');
  assert.deepStrictEqual(await verdictEv('Zwykly_1'), { allowed: false, reason: 'wrong-instance' }, 'gracz z CrownLaunchera, ale z innej instancji, nie przechodzi bramki wydarzenia');
  assert.strictEqual((await verdict(rotated, 'Zwykly_1')).allowed, true, '…choć zwykłą bramkę (dowolna instancja) przechodzi');
  assert.deepStrictEqual(await verdictEv('Nikt_Nikogo'), { allowed: false, reason: 'no-session' }, 'bez sesji w ogóle');
  assert.strictEqual((await (await fetch(`${base}/v1/gate/check?nick=Zwykly_1&event=ZLE%20ID`, { headers: { 'X-Crown-Gate': rotated } })).status), 400, 'niepoprawny parametr event w pytaniu bramki');
  // ta sama osoba gra jednocześnie z instancji wydarzenia i ze zwykłej (to samo konto): zwykłe zgłoszenia nie kasują sesji wydarzenia
  assert.strictEqual((await play(zwykly, dev('z'), 'Igrzysk_1')).status, 200);
  assert.strictEqual((await verdictEv('Igrzysk_1')).allowed, true, 'zwykła sesja tego samego nicku nie nadpisuje sesji wydarzenia');
  const listEv = await (await api('GET', '/v1/admin/gate')).json();
  assert.deepStrictEqual(listEv.sessions.find((s) => s.nick === 'Igrzysk_1').events, ['igrzyska'], 'lista sesji w API admina pokazuje wydarzenie');
  assert.deepStrictEqual(listEv.sessions.find((s) => s.nick === 'Zwykly_1').events, []);
  // sesja wydarzenia wygasa osobno: zwykła jest odnawiana, wydarzenia nie
  await playEv(kod, dev('i'), 'Igrzysk_3', 'igrzyska');
  await sleep(2500);
  await play(kod, dev('i'), 'Igrzysk_3');
  await sleep(2000);
  assert.strictEqual((await verdict(rotated, 'Igrzysk_3')).allowed, true);
  assert.deepStrictEqual(await verdictEv('Igrzysk_3'), { allowed: false, reason: 'wrong-instance' }, 'sesja wydarzenia wygasła, mimo że zwykła żyje');
  // zamknięcie gry zdejmuje sesję wydarzenia; cudzej nie ruszamy
  await playEv(kod, dev('i'), 'Igrzysk_2', 'igrzyska');
  assert.strictEqual((await unplay(zwykly, dev('z'), 'Igrzysk_2')).status, 204);
  assert.strictEqual((await verdictEv('Igrzysk_2')).allowed, true, 'obcy klucz nie zdejmie sesji wydarzenia');
  assert.strictEqual((await unplay(kod, dev('i'), 'Igrzysk_2')).status, 204);
  assert.strictEqual((await verdictEv('Igrzysk_2')).allowed, false, 'zamknięcie instancji wydarzenia zdejmuje sesję');
  // unieważniony kod wydarzenia odcina od razu (TTL w teście to 4 s - najpierw odnawiamy sesję)
  assert.strictEqual((await playEv(kod, dev('i'), 'Igrzysk_1', 'igrzyska')).status, 200);
  assert.strictEqual((await verdictEv('Igrzysk_1')).allowed, true);
  assert.strictEqual((await api('POST', `/v1/admin/invites/${kod.id}/revoke`)).status, 200);
  assert.deepStrictEqual(await verdictEv('Igrzysk_1'), { allowed: false, reason: 'revoked' }, 'unieważniony kod wydarzenia');
  assert.strictEqual((await playEv(kod, dev('i'), 'Igrzysk_1', 'igrzyska')).status, 401, 'unieważniony kod nie zgłosi nowej sesji');
  ok('instancja wydarzenia: sesję zgłasza tylko kod wydarzenia (pełny klucz → 403), bramka wydarzenia odrzuca graczy z innych instancji (wrong-instance), sesje są niezależne, wygasają osobno, kod można unieważnić');

  // ---- scripts/gate.js (obsługa po stronie administratora; adres i klucz admin podane wprost, żeby nie dotknąć produkcji) ----
  const gateCli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gate.js'), ...a], { env: { ...process.env, CROWN_SERVER: base, CROWN_ADMIN_KEY: adminKey }, encoding: 'utf8' });
  await fetch(`${base}/v1/play`, { method: 'POST', headers: bearer, body: JSON.stringify({ nick: 'Brhpq' }) }); // sesje w teście żyją 4 s - odnawiamy sesję administratora tuż przed sprawdzeniem
  const st = gateCli('status');
  assert.strictEqual(st.status, 0, st.stderr);
  assert.match(st.stdout, /Klucz bramki ustawiony/);
  assert.match(st.stdout, /Brhpq/, 'status wypisuje aktywne sesje');
  const keyFile = path.join(dataDir, 'gate-key.txt');
  const nk = gateCli('klucz', '--plik', keyFile);
  assert.strictEqual(nk.status, 0, nk.stderr);
  const written = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(written, /^klucz=gate_[A-Za-z0-9_-]{30,}$/);
  assert.ok(!nk.stdout.includes(written.slice(6)), 'przy --plik klucz nie jest wypisywany na ekran');
  assert.notStrictEqual((await check(rotated, 'Brhpq')).status, 200, 'poprzedni klucz przestał działać (401, a po serii prób zgadywania - 429)');
  await fetch(`${base}/v1/play`, { method: 'POST', headers: bearer, body: JSON.stringify({ nick: 'Brhpq' }) });
  assert.strictEqual((await verdict(written.slice(6), 'Brhpq')).allowed, true, 'klucz z pliku działa');
  assert.strictEqual(gateCli('zdejmij', 'Brhpq').status, 0);
  assert.strictEqual((await verdict(written.slice(6), 'Brhpq')).allowed, false);
  assert.notStrictEqual(gateCli('zdejmij', 'Brhpq').status, 0, 'drugie zdjęcie tej samej sesji kończy się błędem');
  ok('scripts/gate.js: status z sesjami, klucz --plik (nie wypisuje sekretu, unieważnia poprzedni), zdejmij');

  proc.kill();
  rmDir(dataDir);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
