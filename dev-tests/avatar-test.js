// Avatary kont bez ujawniania adresu IP gracza: trasa GET /v1/avatar/… na serwerze (przekaźnik do mc-heads.net - tu atrapa serwisu)
// i moduł launchera avatars.js (prawdziwe invite.js na prawdziwym backendzie). Sprawdza, że serwis dostaje tylko ścieżkę (żadnych
// nagłówków ani adresu gracza), że launcher łączy się wyłącznie z własnym serwerem i że nigdzie nie ma zapasowego połączenia wprost.
// Uruchomienie: node dev-tests/avatar-test.js   (na Workerze: CROWN_BACKEND=cf)
const http = require('http');
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

// poprawny PNG 1×1 (70 B): wystarczy, by przejść kontrolę nagłówka PNG po stronie serwera i launchera
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

(async () => {
  // ---- atrapa mc-heads.net: zapisuje, o co i jakimi nagłówkami pytano ----
  const hits = [];
  const upPort = await freePort();
  const upstream = http.createServer((req, res) => {
    hits.push({ path: req.url, headers: req.headers });
    const id = decodeURIComponent(req.url.split('/')[2] || '');
    if (req.url === '/elsewhere') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
    if (id === 'NoSuchPlayer') return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('nie ma');
    if (id === 'BadImage') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>to nie obrazek</html>');
    if (id === 'HugeImage') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.concat([PNG, Buffer.alloc(200 * 1024)]));
    if (id === 'Redirector') return res.writeHead(302, { Location: `http://127.0.0.1:${upPort}/elsewhere` }).end();
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=21600' }).end(PNG);
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));
  const upHits = (id) => hits.filter((h) => h.path.startsWith(`/avatar/${id}/`));

  // ---- serwer launchera (Node albo Worker) z atrapą zamiast mc-heads.net ----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-avatar-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', AVATAR_UPSTREAM: `http://127.0.0.1:${upPort}` };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < startLoops && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const base = `http://127.0.0.1:${port}`;
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin').stdout)[1];
  const api = (method, p, body) => fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const made = await (await api('POST', '/v1/admin/invites', { name: 'Gracz' })).json();
  const DEVICE = 'komputer-a-0123456789abcdefghijkl';
  const asPlayer = (extra = {}) => ({ 'X-Crown-Invite': made.key, 'X-Crown-Device': DEVICE, ...extra });
  const avatar = (id, query = '', headers = asPlayer()) => fetch(`${base}/v1/avatar/${id}${query}`, { headers });

  // ---- dostęp: tylko z kluczem zaproszenia (to nie jest otwarty proxy) ----
  assert.strictEqual((await avatar('Steve', '', {})).status, 401, 'bez klucza 401');
  assert.strictEqual((await avatar('Steve', '', { 'X-Crown-Invite': 'CROWN-AAAA-BBBB-CCCC-DDDD', 'X-Crown-Device': DEVICE })).status, 401, 'zły klucz 401');
  assert.strictEqual(hits.length, 0, 'odmowa nie dotyka serwisu');
  ok('bez klucza zaproszenia (albo ze złym) serwer odmawia i nie pyta serwisu - to nie jest otwarty proxy');

  // ---- serwis nie dostaje niczego od gracza ----
  const secretIp = '203.0.113.77';
  const r1 = await avatar('Steve', '?size=128', asPlayer({ 'X-Forwarded-For': secretIp, 'X-Real-IP': secretIp, Cookie: 'sid=tajne-ciasteczko', 'CF-Connecting-IP': secretIp }));
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.headers.get('content-type'), 'image/png');
  assert.match(r1.headers.get('cache-control') || '', /private/);
  assert.ok(Buffer.from(await r1.arrayBuffer()).equals(PNG), 'serwer oddaje obrazek z serwisu bez zmian');
  assert.strictEqual(upHits('Steve').length, 1);
  const seen = upHits('Steve')[0];
  assert.strictEqual(seen.path, '/avatar/Steve/128');
  for (const name of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'x-crown-invite', 'x-crown-device', 'cookie', 'authorization']) {
    assert.ok(!(name in seen.headers), `serwis nie powinien dostać nagłówka ${name}`);
  }
  const everything = JSON.stringify(seen.headers) + seen.path;
  assert.ok(!everything.includes(secretIp) && !everything.includes(made.key) && !everything.includes('tajne-ciasteczko'), 'w żądaniu do serwisu nie ma adresu IP gracza, klucza ani ciasteczka');
  ok('serwis dostaje tylko ścieżkę /avatar/<nick>/<rozmiar>: bez adresu IP gracza, klucza zaproszenia, identyfikatora komputera i ciasteczek');

  // ---- pamięć podręczna i rozmiary ----
  await avatar('Steve', '?size=128');
  await avatar('steve', '?size=100'); // inna wielkość liter i rozmiar zaokrąglony w górę do 128
  await avatar('Steve');
  await avatar('Steve', '?size=abc');
  assert.strictEqual(upHits('Steve').length, 1, 'powtórne pytania o ten sam obrazek nie wracają do serwisu');
  await avatar('Steve', '?size=200');
  await avatar('Steve', '?size=10');
  await avatar('Steve', '?size=99999');
  assert.deepStrictEqual(upHits('Steve').map((h) => h.path).sort(), ['/avatar/Steve/128', '/avatar/Steve/256', '/avatar/Steve/32'], 'rozmiary: 128 (domyślny i 100), 256 (200 i 99999), 32 (10)');
  ok('pamięć podręczna: ten sam gracz i rozmiar pobierany raz (wielkość liter nie ma znaczenia), rozmiary zaokrąglane do 32/64/128/256');

  // ---- identyfikatory: UUID z kreskami trafia do serwisu bez kresek, złe identyfikatory są odrzucane ----
  const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
  assert.strictEqual((await avatar(uuid)).status, 200);
  assert.strictEqual(hits.filter((h) => h.path === '/avatar/069a79f444e94726a5befca90e38aaf5/128').length, 1, 'UUID bez kresek');
  const before = hits.length;
  for (const bad of ['abcdefghijklmnopq', 'ab-cd', 'a%20b', '%2e%2e', 'nick%2F..%2Fx', 'x'.repeat(40)]) {
    const r = await avatar(bad);
    assert.notStrictEqual(r.status, 200, `odrzucony identyfikator: ${bad}`);
  }
  assert.strictEqual(hits.length, before, 'złe identyfikatory nie docierają do serwisu');
  ok('UUID z kreskami → 32 znaki bez kresek; za długi nick, kreski w nicku, ukośniki i „..” są odrzucane przed pytaniem serwisu');

  // ---- odpowiedzi serwisu, którym nie wierzymy ----
  for (const [id, why] of [['NoSuchPlayer', 'serwis zwraca 404'], ['BadImage', 'odpowiedź nie jest PNG'], ['HugeImage', 'odpowiedź jest zbyt duża'], ['Redirector', 'serwis przekierowuje']]) {
    const r = await avatar(id);
    assert.strictEqual(r.status, 404, `${why} → 404`);
    await avatar(id);
    assert.strictEqual(upHits(id).length, 1, `${why}: porażka też jest pamiętana (serwisu nie męczymy)`);
  }
  assert.ok(!hits.some((h) => h.path === '/elsewhere'), 'przekierowania nie są wykonywane');
  ok('serwis: brak gracza, nie-PNG, zbyt duży plik i przekierowanie dają 404 (przekierowania nie są wykonywane, porażki są pamiętane)');

  // ---- launcher: avatars.js (prawdziwe invite.js) ----
  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-avatar-l-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const invite = require(root + 'src/main/core/invite.js');
  const avatars = require(root + 'src/main/core/avatars.js');

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = (url, ...rest) => {
    calls.push(String(url));
    return realFetch(url, ...rest);
  };
  const offline = (username) => ({ id: `o-${username}`, type: 'offline', username, uuid: 'b2f8a1c93d6e3a5c8b2e4d6f8a0c1e3a' });
  const micro = (username, uuid) => ({ id: `m-${username}`, type: 'microsoft', username, uuid });

  assert.strictEqual(await avatars.forAccount(offline('BezKlucza')), null, 'bez klucza zaproszenia nie ma obrazka');
  assert.strictEqual(calls.length, 0, 'bez klucza launcher w ogóle nie łączy się z siecią');
  ok('launcher bez klucza zaproszenia: brak obrazka i brak jakiegokolwiek połączenia');

  const launcherInvite = await (await api('POST', '/v1/admin/invites', { name: 'Launcher' })).json(); // osobny klucz: pierwszy jest związany z komputerem z testów HTTP
  await invite.submit(launcherInvite.key);
  calls.length = 0;
  const face = await avatars.forAccount(offline('Alex_Test'));
  assert.strictEqual(face, PNG_URL, 'obrazek jako data URL');
  assert.deepStrictEqual(calls, [`${base}/v1/avatar/Alex_Test?size=128`], 'launcher pyta wyłącznie własny serwer');
  assert.strictEqual(upHits('Alex_Test').length, 1);
  assert.strictEqual(await avatars.forAccount(offline('Alex_Test')), PNG_URL);
  assert.strictEqual(calls.length, 1, 'drugie pytanie o to samo konto z pamięci');
  ok('launcher z kluczem: twarz konta offline przez własny serwer (data URL), powtórne pytanie z pamięci');

  calls.length = 0;
  assert.strictEqual(await avatars.forAccount(micro('Notch', uuid)), PNG_URL);
  assert.deepStrictEqual(calls, [`${base}/v1/avatar/069a79f444e94726a5befca90e38aaf5?size=128`], 'konto Microsoft: UUID bez kresek');
  ok('konto Microsoft: launcher prosi o UUID (bez kresek), nie o nick');

  calls.length = 0;
  assert.strictEqual(await avatars.forAccount(offline('Zły nick!')), null);
  assert.strictEqual(await avatars.forAccount(null), null);
  assert.strictEqual(calls.length, 0, 'niepoprawny nick nie wychodzi poza launcher');
  assert.strictEqual(await avatars.forAccount(offline('NoSuchPlayer')), null, 'konto bez obrazka w serwisie → null');
  assert.strictEqual(await avatars.forAccount(offline('NoSuchPlayer')), null);
  assert.strictEqual(calls.length, 1, 'brak obrazka jest pamiętany - launcher nie ponawia pytania');
  ok('konto bez obrazka albo z niepoprawnym nickiem: null, bez wyjątku, bez ponawiania pytań');

  calls.length = 0;
  const both = await Promise.all([avatars.forAccount(offline('Rownolegle')), avatars.forAccount(offline('Rownolegle'))]);
  assert.deepStrictEqual(both, [PNG_URL, PNG_URL]);
  assert.strictEqual(calls.length, 1, 'dwa jednoczesne pytania o to samo konto = jedno połączenie');
  ok('dwa jednoczesne pytania o to samo konto: jedno połączenie');

  // ---- brak serwera: null, a launcher NIE próbuje łączyć się z mc-heads.net sam ----
  const cfg = require(root + 'src/main/core/config.js');
  const realOrigin = cfg.get().inviteOrigin;
  const dead = `http://127.0.0.1:${await freePort()}`;
  cfg.set({ inviteOrigin: dead });
  Object.assign(appConfig, { ANNOUNCEMENTS_URL: dead });
  calls.length = 0;
  assert.strictEqual(await avatars.forAccount(offline('BezSieci')), null, 'serwer nie odpowiada → null');
  assert.ok(calls.length >= 1 && calls.every((u) => u.startsWith(dead)), 'jedyna próba połączenia idzie do serwera launchera');
  assert.ok(!calls.some((u) => /mc-heads/i.test(u)), 'żadnego zapasowego połączenia wprost');
  Object.assign(appConfig, { ANNOUNCEMENTS_URL: base });
  cfg.set({ inviteOrigin: realOrigin });
  ok('serwer launchera nie odpowiada: null (interfejs rysuje własny zastępnik), żadnego połączenia z mc-heads.net');

  // ---- launcher bez wymaganych kluczy (tryb GitHub / testy): nic nie wychodzi ----
  Object.assign(appConfig, { INVITE_REQUIRED: false });
  calls.length = 0;
  assert.strictEqual(await avatars.forAccount(offline('BezKluczy')), null);
  assert.strictEqual(calls.length, 0);
  Object.assign(appConfig, { INVITE_REQUIRED: true });
  ok('launcher bez wymaganych kluczy zaproszeń: brak obrazka, brak połączeń');
  global.fetch = realFetch;

  // ---- tryb wydarzenia (jedyny klucz gracza to kod wydarzenia): twarz konta nadal działa, bo kanał jest w przestrzeni accounts: ----
  const restrictions = require(root + 'src/main/core/restrictions.js');
  const eventCtx = { profile: 'igrzyska', eventInstanceId: 'event-igrzyska', isLocked: async () => false };
  assert.strictEqual(await restrictions.check('accounts:avatar', ['o-Alex_Test'], eventCtx), null, 'accounts:avatar wolno w trybie wydarzenia');
  assert.ok(await restrictions.check('skins:lookup', ['Steve'], eventCtx), 'a skins:lookup nadal jest zablokowane w trybie wydarzenia');
  ok('tryb wydarzenia: kanał accounts:avatar jest dozwolony (skins:* nadal zablokowane)');

  // ---- kod źródłowy: nigdzie nie ma adresu mc-heads.net jako celu połączenia ----
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|html|css|cs)$/.test(e.name)) files.push(full);
    }
  })(path.join(root, 'src'));
  const offenders = files.filter((f) => /(?:https?:)?\/\/(?:www\.)?mc-heads\.net/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], 'w src/ nie ma adresu mc-heads.net');
  const csp = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(csp, /connect-src 'none'/, 'interfejs nie ma prawa łączyć się z siecią (CSP)');
  ok(`kod launchera (${files.length} plików) nie zawiera adresu mc-heads.net, a interfejs ma CSP connect-src 'none'`);

  // ---- limit zapytań (na końcu: wyczerpuje limit tego adresu na minutę) ----
  let limited = 0;
  for (let i = 0; i < 90 && !limited; i++) if ((await avatar('Steve', '?size=128')).status === 429) limited = i + 1;
  assert.ok(limited > 0 && limited <= 70, `limit zapytań o avatary (429 po ${limited} żądaniach)`);
  ok(`limit zapytań: 429 po ${limited} żądaniach w minucie z jednego adresu`);

  proc.kill();
  upstream.close();
  for (const d of [dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
