const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { CF, serverEntry, startLoops, docs: backendDocs, rmDir } = require('./lib/backend');
const crypto = require('crypto');

const root = 'C:/Users/meabx/Desktop/CrownLauncher/';
// serwer peleryn bez zaproszeń (test nie zależy od produkcyjnego app-config.js; dostęp do peleryn kluczem: capes-access-test.js)
Object.assign(require(root + 'src/main/core/app-config.js'), { INVITE_REQUIRED: false });
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // atrapa sessionservera Mojanga: token "tok-<nick>" należy do konta o tym nicku; join zapamiętuje serverId,
  // hasJoined potwierdza, że konto o danym nicku zgłosiło dokładnie ten serverId
  const mcPort = await freePort();
  const joined = new Map(); // serverId -> nick
  const mc = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mojang.test');
    if (req.method === 'POST' && u.pathname === '/join') {
      let body = '';
      for await (const c of req) body += c;
      const j = JSON.parse(body || '{}');
      const m = /^tok-(\w+)$/.exec(j.accessToken || '');
      if (!m || !/^[a-f0-9]{40}$/.test(j.serverId || '')) { res.writeHead(403); return res.end('{}'); }
      joined.set(j.serverId, m[1]);
      res.writeHead(204);
      return res.end();
    }
    if (u.pathname === '/hasJoined') {
      const name = joined.get(u.searchParams.get('serverId'));
      if (!name || name.toLowerCase() !== String(u.searchParams.get('username') || '').toLowerCase()) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', name }));
    }
    res.writeHead(404);
    res.end();
  }).listen(mcPort, '127.0.0.1');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capesrv-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, MC_HASJOINED_URL: `http://127.0.0.1:${mcPort}/hasJoined` };
  const server = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) started = true; });
  for (let i = 0; i < startLoops && !started; i++) await sleep(150);
  assert.ok(started, 'serwer wystartował');
  const base = `http://127.0.0.1:${port}`;

  // klucz administratora przez CLI serwera
  const cli = spawnSync(process.execPath, [serverEntry, 'create-key', 'Admin', 'admin'], { env, encoding: 'utf8' });
  const adminKey = /(crown_\S+)/.exec(cli.stdout)[1];

  // ---- launcher ----
  process.env.CROWN_CAPES_URL = base;
  process.env.CROWN_MC_JOIN_URL = `http://127.0.0.1:${mcPort}/join`;
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capecli-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const auth = require(root + 'src/main/core/auth.js');
  const capeArt = require(root + 'src/main/core/cape-art.js');
  const capes = require(root + 'src/main/core/capes.js');
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'CrownTest', type: 'offline', uuid: 'u' }], selected: 'a1' });

  assert.strictEqual(capes.serverBase(), base);
  assert.strictEqual(capes.sharedSourceUrl(), `${base}/capes/{USERNAME}.png`);
  assert.strictEqual(capes.badgeListUrl(), `${base}/v1/crown-users`);
  const launch = require(root + 'src/main/core/launch.js');
  assert.ok(launch, 'launch.js ładuje się');
  ok('launcher: serwer peleryn rozpoznany; źródło peleryn i lista korony wskazują na serwer');

  // ---- wybór peleryny = od razu na serwerze ----
  let r = await fetch(`${base}/capes/CrownTest.png`);
  assert.strictEqual(r.status, 404);
  const sel = await capes.select('builtin-gold');
  assert.strictEqual(sel.shared, true, JSON.stringify(sel));
  r = await fetch(`${base}/capes/CrownTest.png`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), capeArt.render('gold'));
  // nick bez względu na wielkość liter
  assert.strictEqual((await fetch(`${base}/capes/crowntest.png`)).status, 200);
  assert.ok(auth.isSealed(config.get().capeSecrets.CrownTest), 'sekret nicka zapisany zaszyfrowany, nie jawnym tekstem');
  assert.ok(auth.unseal(config.get().capeSecrets.CrownTest).length >= 16, 'sekret nicka zapisany lokalnie');
  const st = await capes.state();
  assert.strictEqual(st.selfService, true);
  assert.strictEqual(st.shared, true);
  ok('wybór peleryny w launcherze publikuje ją na serwerze; GET /capes/<nick>.png oddaje identyczny PNG');

  // ---- lista graczy z koroną ----
  let list = await (await fetch(`${base}/v1/crown-users`)).json();
  assert.deepStrictEqual(list.map((x) => x.name), ['CrownTest.png']);
  ok('lista graczy z koroną (format listingu GitHuba): zawiera nick z peleryną');

  // ---- obecność: gracz bez peleryny też dostaje koronę ----
  auth.listPublic = () => ({ accounts: [{ id: 'a2', username: 'Berusek', type: 'offline', uuid: 'u2' }], selected: 'a2' });
  await capes.ensurePublished?.('Berusek');
  const presence = await fetch(`${base}/v1/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Crown-Secret': 'tajny-sekret-berusek-123' },
    body: JSON.stringify({ nick: 'Berusek' }),
  });
  assert.strictEqual(presence.status, 204);
  list = await (await fetch(`${base}/v1/crown-users`)).json();
  assert.deepStrictEqual(list.map((x) => x.name).sort(), ['Berusek.png', 'CrownTest.png']);
  ok('obecność: gracz po uruchomieniu gry ma koronę u wszystkich (bez nadawania przez administrację)');

  // ---- własność nicka ----
  const put = (nick, png, headers) => fetch(`${base}/v1/capes/${nick}`, { method: 'PUT', headers: { 'Content-Type': 'image/png', ...headers }, body: png });
  const png = capeArt.render('crimson');
  let x = await put('CrownTest', png, { 'X-Crown-Secret': 'cudzy-sekret-cudzy-sekret' });
  assert.strictEqual(x.status, 403);
  assert.match((await x.json()).error, /zajęty/);
  x = await put('CrownTest', png, {});
  assert.strictEqual(x.status, 401);
  // właściwy sekret (ten z launchera) działa
  const mine = auth.unseal(config.get().capeSecrets.CrownTest);
  x = await put('CrownTest', png, { 'X-Crown-Secret': mine });
  assert.strictEqual(x.status, 201);
  ok('cudzy sekret nie nadpisze nicka (403), brak sekretu 401, własny sekret działa');

  // ---- konto premium przejmuje nick: dowód od Mojanga, token nigdy nie trafia na serwer peleryn ----
  // to samo robi launcher: losowy serverId zgłoszony Mojangowi tokenem konta
  const proof = async (token) => {
    const serverId = crypto.randomBytes(20).toString('hex');
    const j = await fetch(process.env.CROWN_MC_JOIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: token, selectedProfile: 'x', serverId }),
    });
    assert.strictEqual(j.status, 204);
    return serverId;
  };
  const emerald = capeArt.render('emerald');
  x = await put('CrownTest', emerald, { 'X-Crown-Secret': 'inny-sekret-inny-sekret-1', 'X-Crown-Server-Id': await proof('tok-InnaOsoba') });
  assert.strictEqual(x.status, 403, 'dowód innego konta nie dowodzi własności');
  x = await put('CrownTest', emerald, { 'X-Crown-Secret': 'inny-sekret-inny-sekret-1', 'X-Minecraft-Token': 'tok-CrownTest' });
  assert.strictEqual(x.status, 403, 'surowy token w nagłówku nic nie daje (serwer go nie przyjmuje)');
  x = await put('CrownTest', emerald, { 'X-Crown-Secret': 'inny-sekret-inny-sekret-1', 'X-Crown-Server-Id': 'a'.repeat(40) });
  assert.strictEqual(x.status, 403, 'identyfikator, którego nikt nie zgłosił Mojangowi');
  const mineProof = await proof('tok-CrownTest');
  x = await put('CrownTest', emerald, { 'X-Crown-Secret': 'sekret-premium-sekret-premium', 'X-Crown-Server-Id': mineProof });
  assert.strictEqual(x.status, 201, 'dowód właściciela konta premium przejmuje nick');
  x = await put('CrownTest', emerald, { 'X-Crown-Secret': 'inny-sekret-inny-sekret-1', 'X-Crown-Server-Id': mineProof });
  assert.strictEqual(x.status, 403, 'ten sam dowód drugi raz (powtórka) nie działa');
  x = await put('CrownTest', png, { 'X-Crown-Secret': mine });
  assert.strictEqual(x.status, 403);
  assert.match((await x.json()).error, /konta Microsoft/);
  ok('właściciel konta premium (dowód Mojanga) przejmuje nick; cudzy, zmyślony i powtórzony dowód oraz surowy token — odrzucone');

  // ---- launcher na koncie Microsoft: token idzie tylko do Mojanga, nie do serwera peleryn ----
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'CrownTest', type: 'microsoft', uuid: 'u' }], selected: 'a1' });
  auth.getLaunchAccount = async () => ({ type: 'microsoft', username: 'CrownTest', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'tok-CrownTest' });
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = (url, opts = {}) => {
    sent.push({ url: String(url), headers: JSON.stringify(opts.headers || {}), body: typeof opts.body === 'string' ? opts.body : '' });
    return realFetch(url, opts);
  };
  let viaLauncher;
  try {
    viaLauncher = await capes.select('builtin-crimson');
  } finally {
    global.fetch = realFetch;
  }
  assert.strictEqual(viaLauncher.shared, true, JSON.stringify(viaLauncher));
  const toCapeServer = sent.filter((q) => q.url.startsWith(base));
  assert.ok(toCapeServer.length >= 1, 'launcher wysłał pelerynę na serwer');
  assert.ok(toCapeServer.every((q) => !q.headers.includes('tok-') && !q.body.includes('tok-')), 'serwer peleryn nie dostał tokenu');
  assert.ok(sent.some((q) => q.url === process.env.CROWN_MC_JOIN_URL && q.body.includes('tok-CrownTest')), 'token trafił do Mojanga');
  assert.ok(toCapeServer.some((q) => /x-crown-server-id/i.test(q.headers)), 'żądanie niesie dowód od Mojanga');
  ok('launcher (konto Microsoft): token tylko do sessionservera Mojanga; serwer peleryn dostaje sam dowód');

  // ---- walidacja ----
  x = await put('Walid', Buffer.from('to nie jest png, ale ma wystarczajaco duzo bajtow zeby sprawdzic naglowek'), { 'X-Crown-Secret': 'sekret-walidacji-123456' });
  assert.strictEqual(x.status, 400);
  const bad = Buffer.from(capeArt.render('gold')); bad.writeUInt32BE(100, 16); bad.writeUInt32BE(100, 20); // 100×100
  x = await put('Walid', bad, { 'X-Crown-Secret': 'sekret-walidacji-123456' });
  assert.strictEqual(x.status, 400);
  assert.match((await x.json()).error, /proporcje 2:1/);
  x = await put('Walid', Buffer.alloc(1100 * 1024, 1), { 'X-Crown-Secret': 'sekret-walidacji-123456' });
  assert.strictEqual(x.status, 413);
  x = await fetch(`${base}/v1/capes/zly%20nick`, { method: 'PUT', body: png });
  assert.ok([400, 404].includes(x.status));
  ok('walidacja: nie-PNG, zły rozmiar (100×100), zbyt duży plik (413), zły nick — odrzucone');

  // ---- zdjęcie peleryny z launchera ----
  auth.getLaunchAccount = async () => { throw new Error('konto offline nie ma tokenu'); };
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'CrownTest', type: 'offline', uuid: 'u' }], selected: 'a1' });
  // peleryna CrownTest należy teraz do konta premium, więc launcher offline dostaje błąd, ale nie przewraca wyboru
  const res = await capes.select(null);
  assert.strictEqual(res.shared, false);
  assert.ok(res.error, 'komunikat o zajętym nicku zamiast cichego ignorowania');
  assert.strictEqual((await capes.state()).selected, '', 'lokalny wybór zdjęty mimo błędu serwera');
  ok('zdjęcie peleryny: lokalny wybór schodzi, a błąd serwera (nick premium) jest zgłoszony');

  // ---- administrator ----
  x = await fetch(`${base}/v1/capes/CrownTest`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminKey}` } });
  assert.strictEqual(x.status, 204);
  assert.strictEqual((await fetch(`${base}/capes/CrownTest.png`)).status, 404);
  ok('administrator (klucz admin) może usunąć cudzą pelerynę');

  // ---- publiczne odczyty nie wymagają kluczy; zapis ma limit ----
  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  console.log(`\nWSZYSTKO OK (${n})`);
  server.kill();
  mc.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 6).join('\n')); process.exit(1); });
