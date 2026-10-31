// Szybki test dymny Workera: startuje `wrangler dev` (lokalny R2 i Durable Object), przechodzi przez klucze zaproszeń, bramkę,
// aktualizacje w R2 (wieloczęściowe wgranie, Range, pobranie ze strony), wydarzenie (SHA-1), pelerynę i panel.
// Uruchomienie: node cloudflare/tests/smoke.js   (lub z URL gotowego Workera: SMOKE_BASE=https://… SMOKE_ADMIN_KEY=… node …)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const root = path.join(__dirname, '..');
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const ADMIN = process.env.SMOKE_ADMIN_KEY || `crown_${crypto.randomBytes(24).toString('base64url')}`;

(async () => {
  let proc;
  let persist;
  let base = process.env.SMOKE_BASE;
  if (!base) {
    const port = await freePort();
    persist = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cf-'));
    proc = spawn(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--local', '--port', String(port), '--persist-to', persist, '--var', `BOOTSTRAP_ADMIN_KEY:${ADMIN}`, '--var', 'INVITE_ONLY:1'], {
      cwd: root,
      stdio: 'ignore',
    });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch { /* jeszcze się uruchamia */ }
      await sleep(500);
    }
  }
  const bearer = { Authorization: `Bearer ${ADMIN}` };
  const json = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { ...bearer, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let failed = false;
  try {
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);
    assert.strictEqual((await fetch(`${base}/v1/admin/invites`)).status, 401);
    ok('Worker odpowiada, panel API bez logowania → 401');

    // ---- klucze: utworzenie, wiązanie z komputerem, limit, bramka ----
    let r = await json('POST', '/v1/admin/invites', { name: 'Ola', note: 'test' });
    assert.strictEqual(r.status, 201);
    const ola = await r.json();
    assert.match(ola.key, /^CROWN-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const D1 = 'komputer-jeden-0123456789abcdef';
    const D2 = 'komputer-dwa-0123456789abcdefghij';
    const inv = (key, device, extra = {}) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': key, ...(device ? { 'X-Crown-Device': device } : {}), ...extra } });
    r = await inv(ola.key, D1);
    assert.deepStrictEqual(await r.json(), { ok: true, name: 'Ola', role: 'player', activated: true, profile: '', capes: false, disableClient: false });
    assert.strictEqual((await inv(ola.key, D2)).status, 409);
    assert.strictEqual((await inv('CROWN-AAAA-AAAA-AAAA-AAAA', D1)).status, 401);
    ok('klucz zaproszenia: zapis w storage, wiązanie z komputerem (409 dla drugiego), zły klucz 401');

    // ---- aktualizacje w R2: wgranie wieloczęściowe (jak instalator) i małe pliki ----
    const installerName = 'CrownLauncher-Setup-9.9.9.exe';
    const partSize = 5 * 1024 * 1024;
    const data = crypto.randomBytes(partSize * 2 + 123_456); // 2 pełne części + ogon
    r = await fetch(`${base}/v1/updates/${installerName}?uploads`, { method: 'POST', headers: bearer });
    assert.strictEqual(r.status, 201);
    const { uploadId } = await r.json();
    const parts = [];
    for (let i = 0; i * partSize < data.length; i++) {
      const chunk = data.subarray(i * partSize, (i + 1) * partSize);
      r = await fetch(`${base}/v1/updates/${installerName}?uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`, { method: 'PUT', headers: bearer, body: chunk });
      assert.strictEqual(r.status, 200, await r.clone().text());
      parts.push(await r.json());
    }
    r = await json('POST', `/v1/updates/${installerName}?uploadId=${encodeURIComponent(uploadId)}`, { parts });
    assert.strictEqual(r.status, 201, await r.clone().text());
    assert.strictEqual((await r.json()).size, data.length);
    const sha512 = crypto.createHash('sha512').update(data).digest('base64');
    const yml = `version: 9.9.9\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${installerName}\nsha512: ${sha512}\nreleaseDate: '2026-10-23T00:00:00.000Z'\n`;
    r = await fetch(`${base}/v1/updates/latest.yml`, { method: 'PUT', headers: bearer, body: yml });
    assert.strictEqual(r.status, 201);
    r = await fetch(`${base}/v1/updates/CrownLauncher-Setup-9.9.9.exe.blockmap`, { method: 'PUT', headers: bearer, body: Buffer.from('blockmap-test') });
    assert.strictEqual(r.status, 201);
    ok('instalator wgrany częściami do R2 (3 części), latest.yml i blockmap jednym PUT');

    const upd = (p, headers = {}) => fetch(`${base}/updates/${p}`, { headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D1, ...headers } });
    assert.strictEqual((await fetch(`${base}/updates/latest.yml`)).status, 401, 'bez klucza 401');
    assert.strictEqual((await fetch(`${base}/updates/${installerName}`, { headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D2 } })).status, 409, 'cudzy komputer 409');
    r = await upd(installerName);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-length'), String(data.length));
    assert.strictEqual(r.headers.get('accept-ranges'), 'bytes');
    assert.match(r.headers.get('cache-control'), /private, no-store/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data), 'cały plik bez zmian');
    r = await upd(installerName, { Range: `bytes=${partSize - 10}-${partSize + 9}` });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get('content-range'), `bytes ${partSize - 10}-${partSize + 9}/${data.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(partSize - 10, partSize + 10)), 'zakres przez granicę części');
    r = await upd(installerName, { Range: 'bytes=-100' });
    assert.ok(r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(data.subarray(data.length - 100)), 'ostatnie 100 bajtów');
    r = await upd(installerName, { Range: `bytes=${data.length + 5}-` });
    assert.strictEqual(r.status, 416);
    r = await fetch(`${base}/updates/${installerName}`, { method: 'HEAD', headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-length'), String(data.length));
    assert.match(await (await upd('latest.yml')).text(), /version: 9.9.9/);
    ok('pobieranie z R2 z kluczem: całość, Range (też przez granicę części), ostatnie bajty, 416, HEAD; bez klucza 401');

    // ---- aktualizacje różnicowe: Range z wieloma zakresami → multipart/byteranges (jak prosi electron-updater) ----
    const parseByteranges = (buf, ct) => {
      const b = Buffer.from('--' + /boundary=([^\s;]+)/.exec(ct)[1]);
      const rparts = [];
      let pos = buf.indexOf(b);
      while (pos !== -1) {
        const next = buf.indexOf(b, pos + b.length);
        const seg = buf.subarray(pos + b.length, next === -1 ? buf.length : next);
        if (seg.subarray(0, 2).toString() === '--') break;
        const he = seg.indexOf('\r\n\r\n');
        const head = seg.subarray(0, he).toString();
        let body = seg.subarray(he + 4);
        if (next !== -1) body = body.subarray(0, body.length - 2);
        const cr = /Content-Range: bytes (\d+)-(\d+)\/(\d+)/.exec(head);
        rparts.push({ start: Number(cr[1]), end: Number(cr[2]), total: Number(cr[3]), body });
        pos = next;
      }
      return rparts;
    };
    const multi = async (ranges) => {
      const r = await upd(installerName, { Range: 'bytes=' + ranges.map(([a, b]) => `${a}-${b}`).join(', ') });
      return { r, buf: Buffer.from(await r.arrayBuffer()) };
    };
    let mr = await multi([[0, 99], [5000, 5999], [partSize - 5, partSize + 4]]);
    assert.strictEqual(mr.r.status, 206);
    assert.match(mr.r.headers.get('content-type'), /^multipart\/byteranges; boundary=\w+$/);
    assert.strictEqual(Number(mr.r.headers.get('content-length')), mr.buf.length, 'Content-Length = długość treści');
    let rparts = parseByteranges(mr.buf, mr.r.headers.get('content-type'));
    assert.deepStrictEqual(rparts.map((p) => [p.start, p.end, p.total]), [[0, 99, data.length], [5000, 5999, data.length], [partSize - 5, partSize + 4, data.length]]);
    assert.ok(rparts.every((p) => p.body.equals(data.subarray(p.start, p.end + 1))), 'zawartość trzech części');
    // 300 zakresów po 100 B co 30 KB (luki łączą się w okna odczytu) - jak plan różnicowy electron-updatera
    const many = Array.from({ length: 300 }, (_, i) => [i * 30_000 + 7, i * 30_000 + 106]);
    mr = await multi(many);
    rparts = parseByteranges(mr.buf, mr.r.headers.get('content-type'));
    assert.strictEqual(mr.r.status, 206);
    assert.strictEqual(rparts.length, 300);
    assert.ok(rparts.every((p, i) => p.start === many[i][0] && p.end === many[i][1] && p.body.equals(data.subarray(p.start, p.end + 1))), '300 części zgodne');
    // zakresy duże, w tym ostatni bajt pliku; po kolei, ale nie przylegające
    mr = await multi([[1, 1_000_000], [1_000_002, data.length - 1]]);
    rparts = parseByteranges(mr.buf, mr.r.headers.get('content-type'));
    assert.ok(rparts.length === 2 && rparts[1].end === data.length - 1 && rparts.every((p) => p.body.equals(data.subarray(p.start, p.end + 1))), 'duże zakresy do końca pliku');
    // nachodzące / nie po kolei → serwer ignoruje Range (200, cały plik); poza plikiem → 416; jeden spełnialny → zwykłe 206
    mr = await multi([[100, 200], [150, 300]]);
    assert.ok(mr.r.status === 200 && mr.buf.equals(data), 'nachodzące zakresy → cały plik');
    mr = await multi([[5000, 5100], [100, 200]]);
    assert.ok(mr.r.status === 200 && mr.buf.length === data.length, 'zakresy nie po kolei → cały plik');
    assert.strictEqual((await multi([[data.length + 10, data.length + 20], [data.length + 30, data.length + 40]])).r.status, 416);
    mr = await multi([[10, 19], [data.length + 5, data.length + 9]]);
    assert.ok(mr.r.status === 206 && mr.r.headers.get('content-range') === `bytes 10-19/${data.length}` && mr.buf.equals(data.subarray(10, 20)), 'jeden spełnialny zakres → zwykłe 206');
    ok('aktualizacje różnicowe: Range z wieloma zakresami → 206 multipart/byteranges (3 i 300 części zgodne, Content-Length, duże zakresy), nachodzące/nie po kolei → 200, poza plikiem → 416');

    // ---- strona pobierania: POST /download oddaje instalator, licznik pobrań ----
    const form = (key) => fetch(`${base}/download`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key)}` });
    r = await form(ola.key);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="CrownLauncher-Setup-9.9.9.exe"/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data));
    r = await form('CROWN-AAAA-AAAA-AAAA-AAAA');
    assert.strictEqual(r.status, 401);
    assert.match(await r.text(), /class="error"[^>]*>[^<]*Nieprawidłowy/);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /name="key"/);
    const list = (await (await json('GET', '/v1/admin/invites')).json()).invites;
    assert.strictEqual(list.find((i) => i.name === 'Ola').downloads, 1);
    ok('strona pobierania: formularz, POST /download oddaje instalator z R2 (załącznik), zły klucz → błąd w ramce, licznik pobrań');

    // ---- strona i panel: zasoby, CSP, logo za bramką, logowanie kluczem, sesja ----
    r = await fetch(`${base}/admin`);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.strictEqual((await fetch(`${base}/admin/app.js`)).status, 200);
    assert.strictEqual((await fetch(`${base}/logo.png`)).status, 404);
    r = await fetch(`${base}/logo.png`, { headers: { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'same-origin' } });
    assert.ok(r.status === 200 && (await r.arrayBuffer()).byteLength > 1000);
    assert.strictEqual((await fetch(`${base}/favicon.png`)).status, 200);
    r = await fetch(`${base}/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: ADMIN }) });
    assert.strictEqual(r.status, 200);
    const cookie = /crown_panel=[^;]+/.exec(r.headers.get('set-cookie'))[0];
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    r = await fetch(`${base}/v1/admin/invites`, { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 401, 'sesja bez X-Crown-Panel (CSRF) odrzucona');
    r = await fetch(`${base}/v1/admin/invites`, { headers: { Cookie: cookie, 'X-Crown-Panel': '1' } });
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/v1/admin/ticket`, { method: 'POST', headers: { ...bearer, 'X-Crown-Panel': '1' } });
    const { ticket } = await r.json();
    r = await fetch(`${base}/v1/admin/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/v1/admin/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    assert.strictEqual(r.status, 401, 'bilet jednorazowy');
    ok('panel: CSP, zasoby, logo tylko jako obraz strony, logowanie kluczem, sesja w storage z ochroną CSRF, bilet jednorazowy');

    // ---- wydarzenie: wgranie pliku do R2 z SHA-1 w locie, dostęp po kodzie ----
    r = await json('POST', '/v1/admin/events/igrzyska', { mcVersion: '1.21.4' });
    assert.strictEqual(r.status, 200);
    const jar = Buffer.concat([Buffer.from('PK\u0003\u0004'), crypto.randomBytes(300_000)]);
    r = await fetch(`${base}/v1/admin/events/igrzyska/mods/death-games.jar`, { method: 'PUT', headers: bearer, body: jar });
    assert.strictEqual(r.status, 201, await r.clone().text());
    const ev = (await r.json()).event;
    assert.deepStrictEqual(ev.mods.map((f) => [f.name, f.size, f.sha1]), [['death-games.jar', jar.length, crypto.createHash('sha1').update(jar).digest('hex')]]);
    r = await fetch(`${base}/v1/admin/events/igrzyska/mods/zly.jar`, { method: 'PUT', headers: bearer, body: Buffer.from('to nie zip') });
    assert.strictEqual(r.status, 400);
    r = await fetch(`${base}/v1/admin/events/igrzyska/config?path=${encodeURIComponent('sub/x.json')}`, { method: 'PUT', headers: bearer, body: '{"a":1}' });
    assert.strictEqual(r.status, 201);
    r = await json('POST', '/v1/admin/invites', { name: 'Kod', profile: 'igrzyska' });
    const code = (await r.json()).key;
    const evGet = (p, key, features = 'event') => fetch(`${base}/v1/event/igrzyska${p}`, { headers: { 'X-Crown-Invite': key, 'X-Crown-Device': 'kod-komputer-0123456789abcdef', 'X-Crown-Features': features } });
    r = await evGet('', code);
    const man = await r.json();
    assert.strictEqual(man.mods.length, 1);
    assert.strictEqual(man.config[0].name, 'sub/x.json');
    r = await evGet('/file/mods/death-games.jar', code);
    assert.ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(jar), 'plik z R2 bez zmian');
    r = await evGet('/file/config?path=sub%2Fx.json', code);
    assert.strictEqual(await r.text(), '{"a":1}');
    assert.strictEqual((await fetch(`${base}/v1/event/igrzyska/file/mods/death-games.jar`, { headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D1 } })).status, 403, 'zwykły klucz nie dostaje plików wydarzenia');
    r = await json('DELETE', '/v1/admin/events/igrzyska/mods/death-games.jar');
    assert.strictEqual((await r.json()).event.mods.length, 0);
    ok('wydarzenie: plik .jar do R2 (SHA-1 policzony strumieniem = lokalny), walidacja PK, config w podfolderze, kod 200 / zwykły klucz 403, usuwanie');

    // ---- duży plik wydarzenia (więcej niż mieści jedno żądanie): częściami, SHA-1 liczy serwer ze strumienia z R2 ----
    const bigJar = Buffer.concat([Buffer.from('PK'), crypto.randomBytes(partSize * 2 + 77_777)]);
    const bigUrl = `${base}/v1/admin/events/igrzyska/mods/wielki.jar`;
    r = await fetch(`${bigUrl}?uploads`, { method: 'POST', headers: bearer });
    assert.strictEqual(r.status, 201);
    const big = (await r.json()).uploadId;
    const bigParts = [];
    for (let i = 0; i * partSize < bigJar.length; i++) {
      r = await fetch(`${bigUrl}?uploadId=${encodeURIComponent(big)}&part=${i + 1}`, { method: 'PUT', headers: bearer, body: bigJar.subarray(i * partSize, (i + 1) * partSize) });
      assert.strictEqual(r.status, 200, await r.clone().text());
      bigParts.push(await r.json());
    }
    r = await json('POST', '/v1/admin/events/igrzyska/mods/wielki.jar?uploadId=' + encodeURIComponent(big), { parts: bigParts });
    assert.strictEqual(r.status, 201, await r.clone().text());
    const bigEv = (await r.json()).event;
    assert.deepStrictEqual(bigEv.mods.map((f) => [f.name, f.size, f.sha1]), [['wielki.jar', bigJar.length, crypto.createHash('sha1').update(bigJar).digest('hex')]]);
    r = await evGet('/file/mods/wielki.jar', code);
    assert.ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(bigJar), 'duży plik z R2 bez zmian');
    // zły nagłówek (nie ZIP) w pierwszej części → 400, przerwanie nie zostawia pliku
    r = await fetch(`${base}/v1/admin/events/igrzyska/mods/zly.jar?uploads`, { method: 'POST', headers: bearer });
    const bad = (await r.json()).uploadId;
    r = await fetch(`${base}/v1/admin/events/igrzyska/mods/zly.jar?uploadId=${encodeURIComponent(bad)}&part=1`, { method: 'PUT', headers: bearer, body: Buffer.alloc(1000, 7) });
    assert.strictEqual(r.status, 400);
    r = await fetch(`${base}/v1/admin/events/igrzyska/mods/zly.jar?uploadId=${encodeURIComponent(bad)}`, { method: 'DELETE', headers: bearer });
    assert.strictEqual(r.status, 204);
    assert.strictEqual((await fetch(`${base}/v1/admin/events/igrzyska/mods/nie..zip?uploads`, { method: 'POST', headers: bearer })).status, 400, 'zła nazwa');
    assert.strictEqual((await fetch(`${bigUrl}?uploads`, { method: 'POST' })).status, 401, 'bez klucza');
    r = await json('DELETE', '/v1/admin/events/igrzyska/mods/wielki.jar');
    assert.strictEqual((await r.json()).event.mods.length, 0);
    ok('duży plik wydarzenia: wgranie częściami (3 części), SHA-1 policzony przez serwer = lokalny, pobranie z kodem, zły nagłówek 400 + przerwanie, bez klucza 401');

    // ---- peleryna: nadanie dostępu, wgranie PNG do R2, odczyt publiczny, zdjęcie przy odebraniu dostępu ----
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(5), Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(32, 20);
    const cape = (key, nick = 'Ola') => fetch(`${base}/v1/capes/${nick}`, { method: 'PUT', headers: { 'X-Crown-Invite': key, 'X-Crown-Device': D1, 'X-Crown-Secret': 'sekret-nicka-0123456789abcdef' }, body: png });
    assert.strictEqual((await cape(ola.key)).status, 403, 'bez dostępu do peleryn');
    r = await json('POST', `/v1/admin/invites/${ola.id}/update`, { capes: true });
    assert.strictEqual(r.status, 200);
    r = await cape(ola.key);
    assert.strictEqual(r.status, 201, await r.clone().text());
    r = await fetch(`${base}/capes/ola.png`);
    assert.ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && Buffer.from(await r.arrayBuffer()).equals(png), 'publiczny odczyt peleryny');
    assert.deepStrictEqual(await (await fetch(`${base}/v1/crown-users`)).json(), [{ name: 'Ola.png', type: 'file' }]);
    r = await json('POST', `/v1/admin/invites/${ola.id}/update`, { capes: false });
    assert.strictEqual((await fetch(`${base}/capes/ola.png`)).status, 404, 'wyłączenie dostępu zdejmuje pelerynę');
    ok('peleryny: 403 bez dostępu, PNG w R2, publiczny odczyt i lista koron, zdjęcie peleryny po odebraniu dostępu');

    // ---- ogłoszenia ----
    r = await json('POST', '/v1/announcements', { title: 'Test', text: 'Treść' });
    assert.strictEqual(r.status, 201);
    r = await fetch(`${base}/v1/announcements`, { headers: { 'X-Crown-Invite': ola.key, 'X-Crown-Device': D1 } });
    assert.strictEqual((await r.json()).announcements[0].title, 'Test');
    ok('ogłoszenia (zapis admina, odczyt kluczem)');

    console.log(`\nWSZYSTKO OK (${n})`);
  } catch (e) {
    failed = true;
    console.error('\nFAIL:', e.message);
    console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  } finally {
    if (proc) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else proc.kill();
    }
    if (persist) {
      await sleep(1500);
      fs.rmSync(persist, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
  process.exit(failed ? 1 : 0);
})();
