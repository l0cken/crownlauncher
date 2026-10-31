// Klucz zaproszenia = jeden komputer + panel administratora (/admin, API /v1/admin/*) + skrypt `npm run panel`.
// Prawdziwy server/server.js (INVITE_ONLY) i launcher (invite.js). Uruchomienie: node dev-tests/invite-panel-test.js
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-panel-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', ...extraEnv };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < startLoops && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  return { dataDir, port, base: `http://127.0.0.1:${port}`, proc, cli, env };
}
const KEY_RE = /(CROWN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/;
const D1 = 'komputer-jeden-0123456789abcdef';
const D2 = 'komputer-dwa-0123456789abcdefghij';

(async () => {
  const srv = await startServer();
  const { base, cli } = srv;
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin').stdout)[1];
  const mk = (name) => {
    const o = cli('create-invite', name).stdout;
    return { key: KEY_RE.exec(o)[1], id: /id: ([0-9a-f]{8})/.exec(o)[1] };
  };
  const probe = (key, device) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': key, ...(device ? { 'X-Crown-Device': device } : {}) } });

  // ---- klucz wiąże się z pierwszym komputerem ----
  const ola = mk('Ola');
  let r = await probe(ola.key, D1);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true, name: 'Ola', role: 'player', activated: true, profile: '', capes: false, disableClient: false });
  assert.match(cli('list-invites').stdout, /\[wykorzystany\] Ola/);
  assert.strictEqual((await probe(ola.key, D1)).status, 200, 'ten sam komputer nadal działa');
  r = await probe(ola.key, D2);
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /już użyty na innym komputerze/);
  assert.strictEqual((await probe(ola.key)).status, 409, 'bez identyfikatora (stary launcher) po związaniu - odmowa');
  assert.strictEqual((await probe(ola.key, 'krotki')).status, 401, 'niepoprawny identyfikator');
  // aktualizacje też tylko z komputera, z którym klucz jest związany
  const upd = (key, device) => fetch(`${base}/updates/latest.yml`, { headers: { 'X-Crown-Invite': key, ...(device ? { 'X-Crown-Device': device } : {}) } });
  assert.strictEqual((await upd(ola.key, D2)).status, 409);
  ok('klucz wiąże się z pierwszym komputerem: ten sam działa, drugi dostaje 409 (też przy pobieraniu aktualizacji)');

  // launcher sprzed wiązania: działa, dopóki klucz nie jest związany
  const stary = mk('Stary');
  assert.strictEqual((await probe(stary.key)).status, 200);
  assert.strictEqual((await probe(stary.key)).status, 200);
  ok('tryb zgodności: launcher bez X-Crown-Device działa na kluczu, który nie został jeszcze związany');

  // zwolnienie komputera (CLI)
  assert.match(cli('release-invite', ola.id).stdout, /Zwolniono komputer/);
  assert.strictEqual((await probe(ola.key, D2)).status, 200, 'po zwolnieniu klucz aktywuje się na nowym komputerze');
  assert.strictEqual((await probe(ola.key, D1)).status, 409, 'a stary komputer już nie');
  ok('release-invite: komputer zwolniony, klucz wiąże się z nowym');

  // ---- panel: szkielet publiczny, dane tylko z uwierzytelnieniem ----
  r = await fetch(`${base}/admin`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline/);
  const html = await r.text();
  assert.ok(/<script src="\/admin\/app\.js">/.test(html) && !/<script>[^<]/.test(html), 'bez skryptów inline');
  assert.match(r.headers.get('x-content-type-options'), /nosniff/);
  assert.match(await (await fetch(`${base}/admin/app.js`)).text(), /\/v1\/admin\/invites/);
  assert.strictEqual((await fetch(`${base}/admin/app.css`)).status, 200);
  assert.strictEqual((await fetch(`${base}/v1/admin/invites`)).status, 401);
  assert.strictEqual((await fetch(`${base}/v1/admin/invites`, { headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D2 } })).status, 401, 'zaproszenie to nie administrator');
  ok('panel: strona i zasoby z CSP bez unsafe-inline; API /v1/admin/* bez uwierzytelnienia i dla gracza → 401');

  // ---- API kluczem admin (skrypty) ----
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  r = await fetch(`${base}/v1/admin/invites`, { headers: bearer });
  const list = (await r.json()).invites;
  assert.ok(r.status === 200 && list.length === 2);
  assert.deepStrictEqual(list.map((i) => i.name).sort(), ['Ola', 'Stary']);
  assert.strictEqual(list.find((i) => i.name === 'Ola').status, 'full');
  assert.strictEqual(list.find((i) => i.name === 'Ola').uses, 1);
  assert.strictEqual(list.find((i) => i.name === 'Ola').maxUses, 1);
  assert.strictEqual(list.find((i) => i.name === 'Stary').status, 'unused');
  assert.ok(!JSON.stringify(list).includes('hash') && !JSON.stringify(list).includes('deviceHash'), 'API nie zwraca skrótów');
  r = await fetch(`${base}/v1/admin/invites`, { method: 'POST', headers: bearer, body: JSON.stringify({ name: 'Z Panelu' }) });
  assert.strictEqual(r.status, 201);
  const created = await r.json();
  assert.match(created.key, KEY_RE);
  assert.strictEqual((await probe(created.key, D1)).status, 200, 'klucz z panelu działa');
  for (const bad of ['', '   ', 'x'.repeat(41)]) {
    assert.strictEqual((await fetch(`${base}/v1/admin/invites`, { method: 'POST', headers: bearer, body: JSON.stringify({ name: bad }) })).status, 400);
  }
  ok('API (klucz admin): lista bez skrótów, tworzenie klucza (zwraca go raz), walidacja nazwy');

  // ---- sesja panelu: logowanie kluczem, ciasteczko, CSRF ----
  r = await fetch(`${base}/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'crown_zly_klucz_zly_klucz_zly_klucz' }) });
  assert.strictEqual(r.status, 401);
  r = await fetch(`${base}/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: adminKey }) });
  assert.strictEqual(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /crown_panel=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.strictEqual((await fetch(`${base}/v1/admin/invites`, { headers: { Cookie: cookie } })).status, 401, 'ciasteczko bez X-Crown-Panel (CSRF) nie wystarcza');
  assert.strictEqual((await fetch(`${base}/v1/admin/invites`, { headers: { Cookie: cookie, 'X-Crown-Panel': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 401, 'żądanie z innej strony odrzucone');
  const panelHdr = { Cookie: cookie, 'X-Crown-Panel': '1', 'Content-Type': 'application/json' };
  assert.strictEqual((await fetch(`${base}/v1/admin/invites`, { headers: panelHdr })).status, 200);
  r = await fetch(`${base}/v1/admin/ticket`, { method: 'POST', headers: panelHdr, body: '{}' });
  assert.strictEqual(r.status, 403, 'bilet wydaje tylko klucz admin, nie sesja');
  ok('sesja panelu: logowanie kluczem, ciasteczko HttpOnly+SameSite=Strict, ochrona CSRF (X-Crown-Panel, Sec-Fetch-Site)');

  // ---- akcje: unieważnij, zwolnij, usuń ----
  const act = (method, p) => fetch(`${base}/v1/admin/invites/${p}`, { method, headers: panelHdr, body: method === 'POST' ? '{}' : undefined });
  assert.strictEqual((await act('POST', `${created.id}/release`)).status, 200);
  assert.strictEqual((await probe(created.key, D2)).status, 200, 'po zwolnieniu aktywuje się na drugim komputerze (przez panel)');
  assert.strictEqual((await act('DELETE', created.id)).status, 409, 'nie usuwa aktywnego klucza');
  assert.strictEqual((await act('POST', `${created.id}/revoke`)).status, 200);
  assert.strictEqual((await probe(created.key, D2)).status, 401, 'unieważniony klucz przestaje działać od razu');
  assert.strictEqual((await act('DELETE', created.id)).status, 200);
  assert.strictEqual((await act('POST', 'ffffffff/revoke')).status, 404);
  assert.ok(!(await (await fetch(`${base}/v1/admin/invites`, { headers: panelHdr })).json()).invites.some((i) => i.id === created.id));
  ok('panel: zwolnienie komputera, unieważnienie (działa od razu), usunięcie tylko unieważnionych, 404 dla nieznanego');

  // ---- bilet z `npm run panel` ----
  r = await fetch(`${base}/v1/admin/ticket`, { method: 'POST', headers: bearer, body: '{}' });
  assert.strictEqual(r.status, 200);
  const { ticket } = await r.json();
  const exchange = (t) => fetch(`${base}/v1/admin/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) });
  r = await exchange(ticket);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /crown_panel=/);
  assert.strictEqual((await exchange(ticket)).status, 401, 'bilet jest jednorazowy');
  assert.strictEqual((await exchange('zmyslony-bilet')).status, 401);
  const out = spawnSync(process.execPath, [root + 'scripts/panel.js', '--check'], { encoding: 'utf8', env: { ...process.env, CROWN_SERVER: base, CROWN_ADMIN_KEY: adminKey } });
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Panel działa/);
  const bad = spawnSync(process.execPath, [root + 'scripts/panel.js', '--check'], { encoding: 'utf8', env: { ...process.env, CROWN_SERVER: base, CROWN_ADMIN_KEY: 'crown_zly_klucz_zly_klucz_zly_klucz' } });
  assert.strictEqual(bad.status, 1);
  ok('bilet z `npm run panel`: jednorazowy, wymienia się na sesję; skrypt --check działa, zły klucz → błąd');

  // ---- limit użyć (komputerów) ----
  const withBody = (method, p, body) => fetch(`${base}${p}`, { method, headers: bearer, body: JSON.stringify(body || {}) });
  const dev = (n) => `komputer-numer-${String(n).padStart(2, '0')}-0123456789abcdef`;
  r = await withBody('POST', '/v1/admin/invites', { name: 'Trzy', maxUses: 3, note: 'kolega z serwera' });
  assert.strictEqual(r.status, 201);
  const trzy = await r.json();
  assert.strictEqual(trzy.maxUses, 3);
  assert.strictEqual(trzy.note, 'kolega z serwera');
  for (const n of [1, 2, 3]) assert.strictEqual((await probe(trzy.key, dev(n))).status, 200, `komputer ${n}`);
  r = await probe(trzy.key, dev(4));
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /maksymalnej liczbie komputerów \(3\)/);
  assert.strictEqual((await probe(trzy.key, dev(2))).status, 200, 'komputer, który już używa klucza, działa dalej');
  let one = (await (await fetch(`${base}/v1/admin/invites`, { headers: bearer })).json()).invites.find((i) => i.id === trzy.id);
  assert.strictEqual(one.uses, 3);
  assert.strictEqual(one.status, 'full');
  assert.strictEqual(one.devices.length, 3);
  assert.ok(one.devices.every((d) => /^[0-9a-f]{8}$/.test(d.id) && d.firstAt), 'komputery z identyfikatorem skróconym i datą');
  ok('limit użyć: klucz na 3 komputery — czwarty dostaje 409 z liczbą; dotychczasowe nadal działają');

  // zwolnienie jednego komputera oddaje jedno użycie
  r = await withBody('POST', `/v1/admin/invites/${trzy.id}/release`, { device: one.devices[0].id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).invite.uses, 2);
  assert.strictEqual((await probe(trzy.key, dev(4))).status, 200, 'zwolnione użycie zajmuje nowy komputer');
  assert.strictEqual((await probe(trzy.key, dev(5))).status, 409);
  ok('zwolnienie jednego komputera: wraca jedno użycie, reszta zostaje');

  // bez limitu
  r = await withBody('POST', '/v1/admin/invites', { name: 'Bez limitu', maxUses: 0 });
  const nolimit = await r.json();
  for (let n = 1; n <= 6; n++) assert.strictEqual((await probe(nolimit.key, dev(n))).status, 200);
  assert.strictEqual((await (await fetch(`${base}/v1/admin/invites`, { headers: bearer })).json()).invites.find((i) => i.id === nolimit.id).status, 'activated');
  ok('maxUses = 0: bez limitu komputerów');

  // ---- wygaśnięcie ----
  r = await withBody('POST', '/v1/admin/invites', { name: 'Na tydzień', expiresInDays: 7 });
  const week = await r.json();
  const delta = Date.parse(week.expiresAt) - Date.now();
  assert.ok(Math.abs(delta - 7 * 86400_000) < 60_000, 'expiresInDays: 7 → ok. 7 dni od teraz');
  assert.strictEqual((await probe(week.key, D1)).status, 200);
  // ustawiamy datę w przeszłości (edycja): klucz przestaje działać także na komputerze, który już go używa
  r = await withBody('POST', `/v1/admin/invites/${week.id}/update`, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).invite.status, 'expired');
  r = await probe(week.key, D1);
  assert.strictEqual(r.status, 401);
  assert.match((await r.json()).error, /wygasł/);
  assert.strictEqual((await fetch(`${base}/updates/latest.yml`, { headers: { 'X-Crown-Invite': week.key, 'X-Crown-Device': D1 } })).status, 401, 'aktualizacje też');
  r = await fetch(`${base}/download`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(week.key)}` });
  assert.strictEqual(r.status, 401);
  assert.match(await r.text(), /wygasł/);
  // przedłużenie przywraca działanie; null = bez limitu
  r = await withBody('POST', `/v1/admin/invites/${week.id}/update`, { expiresInDays: 30 });
  assert.strictEqual((await r.json()).invite.status, 'full'); // 1 użycie z 1 zajęte, ale klucz działa
  assert.strictEqual((await probe(week.key, D1)).status, 200);
  r = await withBody('POST', `/v1/admin/invites/${week.id}/update`, { expiresAt: null });
  assert.strictEqual((await r.json()).invite.expiresAt, null);
  ok('wygaśnięcie: po dacie klucz nie działa (launcher, aktualizacje, pobranie); przedłużenie i „bez limitu” przywracają');

  // ---- edycja i walidacja ----
  r = await withBody('POST', `/v1/admin/invites/${week.id}/update`, { name: 'Nowa nazwa', note: 'zmieniona', maxUses: 2 });
  const edited = (await r.json()).invite;
  assert.deepStrictEqual([edited.name, edited.note, edited.maxUses], ['Nowa nazwa', 'zmieniona', 2]);
  for (const bad of [{ maxUses: -1 }, { maxUses: 1001 }, { maxUses: 1.5 }, { expiresAt: 'nie-data' }, { expiresInDays: 0 }, { expiresInDays: 4000 }, { note: 'x'.repeat(201) }, { name: '   ' }]) {
    assert.strictEqual((await withBody('POST', `/v1/admin/invites/${week.id}/update`, bad)).status, 400, JSON.stringify(bad));
  }
  r = await withBody('POST', '/v1/admin/invites', { name: 'Zła liczba', maxUses: 'dużo' });
  assert.strictEqual(r.status, 400);
  ok('edycja (nazwa, notatka, limit, data) i walidacja pól: błędne wartości → 400');

  // ---- CLI z opcjami ----
  const cliOut = cli('create-invite', 'Z CLI', '--uses', '2', '--days', '30', '--note', 'test').stdout;
  assert.match(cliOut, /Limit użyć \(komputerów\): 2/);
  assert.match(cli('list-invites').stdout, /\[nieużyty\] Z CLI\s+\(użycia 0\/2, do \d{4}-\d{2}-\d{2}/);
  assert.strictEqual(cli('create-invite', 'Źle', '--uses', 'abc').status, 1);
  ok('CLI: create-invite --uses N --days N --note, list-invites pokazuje użycia i datę');

  // ---- strona pobierania ----
  r = await fetch(`${base}/`);
  const downloadHtml = await r.text();
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline/);
  assert.ok(/<link rel="stylesheet" href="\/site\.css">/.test(downloadHtml) && /<script src="\/site\.js">/.test(downloadHtml) && !/<style|<script>[^<]/.test(downloadHtml), 'style i skrypt jako pliki, bez inline');
  assert.ok(/<form method="post" action="\/download"/.test(downloadHtml) && /name="key"/.test(downloadHtml));
  const css = await fetch(`${base}/site.css`);
  assert.ok(css.status === 200 && /text\/css/.test(css.headers.get('content-type')));
  assert.match(await css.text(), /--gold/);
  assert.match(await (await fetch(`${base}/site.js`)).text(), /CROWN-/);
  // logo: tylko jako obraz własnej strony (tło CSS) - adres z paska, „otwórz w nowej karcie”, fetch i obce strony dostają 404
  const asImage = { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'same-origin' };
  const logo = await fetch(`${base}/logo.png`, { headers: asImage });
  assert.ok(logo.status === 200 && logo.headers.get('content-type') === 'image/png' && (await logo.arrayBuffer()).byteLength > 1000);
  assert.strictEqual(logo.headers.get('cache-control'), 'no-store');
  assert.match(logo.headers.get('vary'), /Sec-Fetch-Dest/i);
  assert.match(logo.headers.get('vary'), /Sec-Fetch-Site/i);
  for (const h of [
    {}, // curl / skrypt
    { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }, // adres wpisany w pasku
    { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' }, // „otwórz obraz w nowej karcie”
    { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' }, // fetch()
    { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'cross-site' }, // <img> na cudzej stronie
    { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Dest': 'image' },
  ]) {
    const denied = await fetch(`${base}/logo.png`, { headers: h });
    assert.strictEqual(denied.status, 404, JSON.stringify(h));
    assert.match(denied.headers.get('vary'), /Sec-Fetch-Site/i, '404 też z Vary (nie trafia do pamięci podręcznej obrazów)');
    assert.strictEqual(denied.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(denied.headers.get('content-type'), /image/);
  }
  // ikona karty to osobny, mały plik (przeglądarka pobiera ją bez nagłówków strony, więc nie może iść przez bramkę logo)
  assert.match(downloadHtml, /<link rel="icon" href="\/favicon\.png"/);
  assert.doesNotMatch((await (await fetch(`${base}/admin`)).text()), /logo\.png/);
  const fav = await fetch(`${base}/favicon.png`, { headers: { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'none' } });
  const favBytes = Buffer.from(await fav.arrayBuffer());
  assert.ok(fav.status === 200 && fav.headers.get('content-type') === 'image/png' && favBytes.length < 8000 && favBytes.readUInt32BE(16) === 32, 'favicon 32 px, mały');
  assert.doesNotMatch(downloadHtml, /logo\.png/, 'logo.png tylko w CSS, nie w HTML strony');
  assert.ok(!/<img/i.test(downloadHtml), 'strona pobierania bez <img> (logo to tło CSS)');
  assert.match(downloadHtml, /<span class="logo" aria-hidden="true"><\/span>/);
  assert.match(await (await fetch(`${base}/site.css`)).text(), /\.logo\s*\{[^}]*background:\s*url\(\/logo\.png\)[^}]*user-select:\s*none[^}]*pointer-events:\s*none/s);
  const panelJs = await (await fetch(`${base}/admin/app.js`)).text();
  assert.ok(!/el\('img'|<img/.test(panelJs), 'panel bez <img>');
  assert.match(await (await fetch(`${base}/admin/app.css`)).text(), /\.logo\s*\{[^}]*background:\s*url\(\/logo\.png\)[^}]*pointer-events:\s*none/s);
  r = await fetch(`${base}/download`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=CROWN-AAAA-AAAA-AAAA-AAAA' });
  assert.strictEqual(r.status, 401);
  assert.match(await r.text(), /class="error"[^>]*>[^<]*Nieprawidłowy/);
  ok('strona pobierania: style, skrypt jako zasoby (CSP bez inline), formularz, błąd w ramce; logo tylko dla Sec-Fetch-Dest: image + same-origin (reszta 404, no-store, Vary), bez <img>');

  // ---- migracja starych wpisów (jeden deviceHash, bez limitu i daty) ----
  const legacy = await startServer();
  const legacyKey = 'ABCDEFGHJKLMNPQR'; // 16 znaków z alfabetu klucza
  const legacyDevice = 'stary-komputer-0123456789abcdef';
  const crypto = require('crypto');
  await backendDocs(legacy.dataDir, legacy.base).write('invites.json', [{
    id: '0a1b2c3d', name: 'Stary wpis', hash: crypto.createHash('sha256').update(legacyKey).digest('hex'),
    createdAt: '2026-10-01T10:00:00.000Z', deviceHash: crypto.createHash('sha256').update('crown-device:' + legacyDevice).digest('hex'),
    activatedAt: '2026-10-02T10:00:00.000Z',
  }]);
  const lk = 'CROWN-ABCD-EFGH-JKLM-NPQR';
  const lprobe = (device) => fetch(`${legacy.base}/v1/invite`, { headers: { 'X-Crown-Invite': lk, ...(device ? { 'X-Crown-Device': device } : {}) } });
  assert.strictEqual((await lprobe(legacyDevice)).status, 200, 'dawny związany komputer nadal działa');
  assert.strictEqual((await lprobe('inny-komputer-0123456789abcdefgh')).status, 409, 'limit domyślny = 1');
  const legacyAdmin = /(crown_\S+)/.exec(legacy.cli('create-key', 'A', 'admin').stdout)[1];
  const legacyList = (await (await fetch(`${legacy.base}/v1/admin/invites`, { headers: { Authorization: `Bearer ${legacyAdmin}` } })).json()).invites[0];
  assert.deepStrictEqual([legacyList.status, legacyList.uses, legacyList.maxUses, legacyList.expiresAt], ['full', 1, 1, null]);
  assert.ok(legacyList.devices[0].firstAt === '2026-10-02T10:00:00.000Z');
  legacy.proc.kill();
  rmDir(legacy.dataDir);
  ok('migracja: dawny wpis (jeden komputer) działa jako klucz na 1 użycie, bez wygaśnięcia');

  // ---- REQUIRE_DEVICE: stare launchery dostają odmowę ----
  const strict = await startServer({ REQUIRE_DEVICE: '1' });
  const k = KEY_RE.exec(strict.cli('create-invite', 'Ktos').stdout)[1];
  r = await fetch(`${strict.base}/v1/invite`, { headers: { 'X-Crown-Invite': k } });
  assert.strictEqual(r.status, 401);
  assert.match((await r.json()).error, /przestarzały/);
  assert.strictEqual((await fetch(`${strict.base}/v1/invite`, { headers: { 'X-Crown-Invite': k, 'X-Crown-Device': D1 } })).status, 200);
  ok('REQUIRE_DEVICE=1: launcher bez X-Crown-Device dostaje „przestarzały”, nowy działa');

  // ---- launcher ----
  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-devcli-'));
  require(root + 'src/main/core/paths.js').init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const invite = require(root + 'src/main/core/invite.js');

  const id1 = invite.deviceId();
  assert.match(id1, /^[A-Za-z0-9_-]{16,128}$/);
  assert.strictEqual(invite.deviceId(), id1, 'identyfikator jest stały');
  assert.ok(/^(raw|enc):/.test(config.get().deviceId) && !config.get().deviceId.includes(id1), 'zapisany zaszyfrowany');
  assert.ok(!('deviceId' in config.publicView()), 'renderer go nie dostaje');

  const zajety = mk('Zajety');
  assert.strictEqual((await probe(zajety.key, D1)).status, 200); // ktoś inny aktywował już ten klucz
  await assert.rejects(invite.submit(zajety.key), /już użyty na innym komputerze/);
  assert.deepStrictEqual(await invite.status(), { required: true, active: false, name: '' });
  const wolny = mk('Wolny');
  const st = await invite.submit(wolny.key);
  assert.deepStrictEqual(st, { required: true, active: true, name: 'Wolny' });
  const h = invite.headersFor(`${base}/updates`);
  assert.strictEqual(h['X-Crown-Device'], id1);
  assert.ok(h['X-Crown-Invite']);
  assert.deepStrictEqual(invite.headersFor('https://obcy.example/x'), {}, 'identyfikator też tylko do właściwego serwera');
  assert.strictEqual((await fetch(`${base}/updates/latest.yml`, { headers: h })).status, 404, 'serwer rozpoznaje ten komputer (404 = brak pliku, nie odmowa)');
  ok('launcher: stały zaszyfrowany identyfikator, klucz użyty gdzie indziej odrzucony z komunikatem, własny klucz przyjęty i związany');

  // klucz wiązany przez launcher; administrator zwalnia, a ktoś inny go przejmuje -> launcher traci ważność przy sprawdzeniu
  cli('release-invite', wolny.id);
  assert.strictEqual((await probe(wolny.key, D2)).status, 200);
  config.set({ inviteCheckedAt: Date.now() - 7 * 3600_000 });
  const takenStatus = await invite.status({ check: true });
  assert.deepStrictEqual([takenStatus.required, takenStatus.active, takenStatus.name], [true, false, '']);
  assert.match(takenStatus.lost, /odłączony od klucza przez administratora/, 'ekran blokady dostaje powód od serwera');
  assert.strictEqual(config.get().inviteKey, '');
  // gracz próbuje wpisać ten sam klucz - użycie zajął już inny komputer
  await assert.rejects(invite.submit(wolny.key), /już użyty na innym komputerze/);
  ok('klucz przejęty przez inny komputer po zwolnieniu: launcher traci klucz z powodem, a ponowne wpisanie dostaje „użyty na innym komputerze”');

  // unieważnienie działa przy najbliższym starcie gry, mimo że ostatnie potwierdzenie jest świeże (nie czekamy 6 h)
  const odwolany = await (await withBody('POST', '/v1/admin/invites', { name: 'Odwolany', maxUses: 0 })).json();
  config.set({ inviteKey: '', inviteOrigin: '' });
  await invite.submit(odwolany.key);
  await invite.assertAllowed(); // klucz ważny
  assert.ok(Date.now() - config.get().inviteCheckedAt < 60_000, 'ostatnie potwierdzenie jest świeże');
  assert.strictEqual((await withBody('POST', `/v1/admin/invites/${odwolany.id}/revoke`)).status, 200);
  await assert.rejects(invite.assertAllowed(), /tylko dla zaproszonych/);
  assert.strictEqual(config.get().inviteKey, '', 'unieważniony klucz usunięty z launchera');
  ok('unieważnienie blokuje start gry od razu (bez czekania na okresowe sprawdzenie)');

  // klucz wygasły: launcher mówi wprost, że klucz wygasł (a nie ogólne „nieprawidłowy”)
  r = await withBody('POST', '/v1/admin/invites', { name: 'Wygasly', expiresAt: new Date(Date.now() - 1000).toISOString() });
  const wygasly = await r.json();
  await assert.rejects(invite.submit(wygasly.key), /Ten klucz wygasł/);
  ok('launcher: wygasły klucz → komunikat „Ten klucz wygasł”');

  // ---- „Zwolnij”: komputer traci klucz w launcherze, dopóki gracz nie wpisze go ponownie; slot jest wolny dla innych ----
  const feat = { 'X-Crown-Features': 'event,release' };
  const probeF = (key, device, extra = {}) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': key, 'X-Crown-Device': device, ...feat, ...extra } });
  const zw = await (await withBody('POST', '/v1/admin/invites', { name: 'Zwalniany', maxUses: 2 })).json();
  assert.strictEqual((await probeF(zw.key, dev(1))).status, 200);
  assert.strictEqual((await probeF(zw.key, dev(2))).status, 200);
  assert.strictEqual((await probeF(zw.key, dev(3))).status, 409, 'limit 2 komputerów');
  assert.strictEqual((await withBody('POST', `/v1/admin/invites/${zw.id}/release`, {})).status, 200);
  r = await probeF(zw.key, dev(1));
  assert.strictEqual(r.status, 401, 'launcher z obsługą zwolnienia dostaje odmowę przy kolejnym sprawdzeniu');
  assert.match((await r.json()).error, /odłączony od klucza przez administratora/);
  assert.strictEqual((await probeF(zw.key, dev(2))).status, 401);
  // zwolniony slot może zająć inny komputer, a komputer 1 po jawnym wpisaniu klucza wraca
  assert.strictEqual((await probeF(zw.key, dev(3), { 'X-Crown-Entry': '1' })).status, 200, 'nowy komputer zajmuje zwolnione użycie');
  assert.strictEqual((await probeF(zw.key, dev(1), { 'X-Crown-Entry': '1' })).status, 200, 'jawne wpisanie przyłącza komputer z powrotem');
  assert.strictEqual((await probeF(zw.key, dev(1))).status, 200, 'po wpisaniu kolejne sprawdzenia przechodzą');
  r = await probeF(zw.key, dev(2), { 'X-Crown-Entry': '1' });
  assert.strictEqual(r.status, 409, 'limit znów zajęty (komputery 1 i 3)');
  // starszy launcher (bez „release”) nie zna komunikatu - wiąże się sam, jak dotąd
  const zw2 = await (await withBody('POST', '/v1/admin/invites', { name: 'ZwalnianyStary', maxUses: 0 })).json();
  assert.strictEqual((await probe(zw2.key, D1)).status, 200);
  await withBody('POST', `/v1/admin/invites/${zw2.id}/release`, {});
  assert.strictEqual((await probe(zw2.key, D1)).status, 200, 'stary launcher łączy się ponownie sam');
  assert.strictEqual((await probeF(zw2.key, D1)).status, 200, 'a po przejściu na nowy nie ma już flagi zwolnienia');
  // dane zwolnionych komputerów nie wychodzą przez API
  assert.ok(!JSON.stringify(await (await fetch(`${base}/v1/admin/invites`, { headers: bearer })).json()).includes('released'), 'API nie zwraca listy zwolnionych skrótów');
  // CLI release-invite też odłącza
  assert.match(cli('release-invite', zw.id).stdout, /Zwolniono komputery/);
  assert.strictEqual((await probeF(zw.key, dev(1))).status, 401);
  ok('„Zwolnij”: launcher z obsługą zwolnienia traci klucz przy sprawdzeniu, jawne wpisanie przyłącza komputer, slot jest wolny dla innych, starszy launcher łączy się sam');

  // launcher: po zwolnieniu traci klucz (z powodem na ekranie blokady), a ponowne wpisanie klucza działa
  config.set({ inviteKey: '', inviteOrigin: '', inviteName: '', inviteProfile: '', inviteLost: '', inviteCheckedAt: 0 });
  const zl = await (await withBody('POST', '/v1/admin/invites', { name: 'ZwalnianyL', maxUses: 0 })).json();
  await invite.submit(zl.key);
  assert.strictEqual((await invite.status({ check: true, maxAgeMs: 0 })).active, true);
  await withBody('POST', `/v1/admin/invites/${zl.id}/release`, {});
  const kicked = await invite.status({ check: true, maxAgeMs: 0 });
  assert.deepStrictEqual([kicked.required, kicked.active], [true, false]);
  assert.match(kicked.lost, /odłączony od klucza przez administratora/, 'powód na ekranie blokady');
  assert.strictEqual(config.get().inviteKey, '', 'klucz usunięty z launchera');
  const again = await invite.submit(zl.key);
  assert.strictEqual(again.active, true, 'ponowne wpisanie klucza działa');
  assert.strictEqual((await invite.status({ check: true, maxAgeMs: 0 })).active, true);
  ok('launcher po „Zwolnij”: klucz usunięty z komunikatem, ponowne wpisanie tego samego klucza działa');

  for (const p of [srv.proc, strict.proc]) p.kill();
  for (const d of [srv.dataDir, strict.dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
