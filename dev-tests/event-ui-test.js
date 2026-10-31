// IGRZYSKA ŚMIERCI w prawdziwym Electronie (CDP): tryb ograniczony (kod jako jedyny klucz), zablokowane zakładki,
// ponowny start z zapisanym kodem, oraz gracz z pełnym dostępem, który wpisuje kod w zakładce wydarzenia.
// Wymaga internetu (synchronizacja tworzy instancję Fabric). Uruchomienie: node dev-tests/event-ui-test.js
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.CROWN_INVITE_WATCH_MS = '60000';
const { setAccess } = require(path.join(__dirname, '..', 'src', 'main', 'core', 'hidden.js'));
const unlockEventDirs = (userDir) =>
  setAccess(['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports'].map((d) => path.join(userDir, 'instances', 'event-igrzyska', 'game', d)), 'open');
const root = path.join(__dirname, '..');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function until(fn, what, ms = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Przekroczono czas: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function launchApp(appDir, userData = tmp('crown-evui-data-')) {
  const port = await freePort();
  const proc = spawn(electronExe, [appDir, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  }, 'okno launchera');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP: brak połączenia')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'wyjątek w stronie');
    return r.result?.result?.value;
  };
  // graceful: zamknięcie okna jak u użytkownika (Chromium zapisuje wtedy klucz szyfrowania w „Local State”;
  // twarde zabicie krótko po starcie go gubi i zapisane sekrety przestają się odszyfrowywać).
  const close = async ({ graceful = false } = {}) => {
    if (graceful) {
      const exited = new Promise((res) => proc.once('exit', res));
      send('Runtime.evaluate', { expression: "window.crown.invoke('win:close')" });
      await Promise.race([exited, sleep(8000)]);
    }
    try { ws.close(); } catch { /* już zamknięte */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  return { evaluate, send, close, shot, userData };
}

function makeApp(fields) {
  const appDir = tmp('crown-evui-app-');
  fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
  const cfgFile = path.join(appDir, 'src', 'main', 'core', 'app-config.js');
  let cfg = fs.readFileSync(cfgFile, 'utf8');
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`${key}: (?:'[^']*'|true|false)`, 'g');
    cfg = cfg.replace(re, () => `${key}: ${typeof value === 'boolean' ? value : `'${value}'`}`);
  }
  fs.writeFileSync(cfgFile, cfg);
  return appDir;
}

const zipLike = (label, size) => {
  const b = crypto.randomBytes(size);
  b[0] = 0x50;
  b[1] = 0x4b;
  b.write(label, 4);
  return b;
};

(async () => {
  const dataDir = tmp('crown-evui-srv-');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  await until(() => up, 'serwer');
  const base = `http://127.0.0.1:${port}`;
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), ...args], { env, encoding: 'utf8' }).stdout;
  const KEY_RE = /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/;
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin'))[1];
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };

  // wydarzenie: wersja gry, jeden mod i jeden texturepack
  await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: bearer, body: JSON.stringify({ mcVersion: '1.21.4', crownClient: false }) });
  const put = (kind, name, body) => fetch(`${base}/v1/admin/events/igrzyska/${kind}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body });
  assert.strictEqual((await put('mods', 'death-games-1.0.jar', zipLike('mod', 4096))).status, 201);
  assert.strictEqual((await put('resourcepacks', 'Arena Pack.zip', zipLike('pack', 3000))).status, 201);
  const putPath = (kind, rel, body) => fetch(`${base}/v1/admin/events/igrzyska/${kind}?path=${encodeURIComponent(rel)}`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body });
  assert.strictEqual((await putPath('config', 'sodium-options.json', Buffer.from('{"quality":{}}'))).status, 201);
  assert.strictEqual((await putPath('root', 'options.txt', Buffer.from('fov:70.0\n'))).status, 201);
  const kodKey = KEY_RE.exec(cli('create-invite', 'Tylko Igrzyska', '--profile', 'igrzyska'))[1];
  const pelnyKey = KEY_RE.exec(cli('create-invite', 'Gracz Pelny', '--uses', '2'))[1];
  const kod2Key = KEY_RE.exec(cli('create-invite', 'Kod Dla Pelnego', '--profile', 'igrzyska'))[1];

  const appDir = makeApp({ GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, INVITE_REQUIRED: true });
  const text = (app) => app.evaluate('document.body.innerText');
  const navLabels = (app) => app.evaluate("[...document.querySelectorAll('.nav-item')].map((a) => a.textContent.trim())");
  const typeKey = (app, value) => app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  const errToasts = (app) => app.evaluate("[...document.querySelectorAll('.toast.err')].map((t) => t.textContent)");

  // ================================================================ A) kod jako jedyny klucz: tryb ograniczony
  const userA = tmp('crown-evui-dataA-');
  let app = await launchApp(appDir, userA);
  try {
    await until(() => app.evaluate("!!document.querySelector('input.input') && !document.querySelector('.sidebar')"), 'ekran z kluczem');
    await typeKey(app, kodKey);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length > 3"), 'launcher po wpisaniu kodu');
    const labels = await navLabels(app);
    assert.deepStrictEqual(labels, ['IGRZYSKA ŚMIERCI', 'Instancje', 'Serwery', 'Skiny', 'Modrinth', 'Ustawienia'], 'Start ukryty, wydarzenie nad Instancjami');
    assert.deepStrictEqual(await app.evaluate("[...document.querySelectorAll('.nav-item.locked')].map((a) => a.textContent.trim())"), ['Instancje', 'Serwery', 'Skiny', 'Modrinth']);
    assert.strictEqual(await app.evaluate('location.hash'), '#/event');
    await until(async () => /Minecraft 1\.21\.4/.test(await text(app)), 'strona wydarzenia');
    const page = await text(app);
    // gracz nie widzi składu zestawu: ani nazw, ani list modów, paczek, configów i opcji
    assert.doesNotMatch(page, /death-games|Arena Pack|sodium-options|options\.txt|Mody \(|Texturepacki|Shaderpacki|Ustawienia i configi|wymuszone|ustawienie startowe/);
    assert.match(page, /Dostęp: kod wydarzenia/);
    assert.match(page, /Pliki wydarzenia są zablokowane/);
    assert.strictEqual(await app.evaluate("[...document.querySelectorAll('.btn.primary')].some((b) => /Zagraj/.test(b.textContent) && !b.disabled)"), true, 'Zagraj aktywny');
    const file = await app.shot('crown-event-restricted.png');
    ok(`kod jako jedyny klucz: menu IGRZYSKA ŚMIERCI + 4 zablokowane zakładki, strona wydarzenia bez list plików (zrzut: ${file})`);

    // zablokowane zakładki nie otwierają się ani kliknięciem, ani ręczną zmianą adresu
    await app.evaluate("document.querySelector('.nav-item.locked').click()");
    await until(async () => /zablokowana w trybie Igrzysk/.test(await text(app)), 'komunikat o blokadzie');
    for (const hash of ['#/instances', '#/servers', '#/skins', '#/browse', '#/home', '#/instance/cokolwiek']) {
      await app.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await until(async () => (await app.evaluate('location.hash')) === '#/event', `przekierowanie z ${hash}`);
    }
    ok('zakładki Instancje/Serwery/Skiny/Modrinth (i Start) nie otwierają się, także przez ręczną zmianę adresu');

    // po stronie procesu głównego: kanały zablokowane, lista instancji bez cudzych, plików nie da się zmienić
    const inv = async (...a) => app.evaluate(`window.crown.invoke(...${JSON.stringify(a)})`);
    for (const call of [['servers:list'], ['modrinth:search', { type: 'mod' }], ['instances:create', { name: 'x', mcVersion: '1.21.4' }], ['skins:list'], ['versions:list']]) {
      const r = await inv(...call);
      assert.ok(r.ok === false && /zablokowana w trybie Igrzysk/.test(r.error), `${call[0]}: ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual((await inv('instances:list')).data, []);
    const sync = await inv('event:sync');
    assert.ok(sync.ok, JSON.stringify(sync));
    const list = (await inv('instances:list')).data;
    assert.deepStrictEqual(list.map((i) => [i.id, i.locked, i.event]), [['event-igrzyska', true, 'igrzyska']]);
    if (process.platform === 'win32') {
      // prawdziwy launcher ukrył foldery wydarzenia (Ukryty + Systemowy) i wgrał config
      const gameDir = path.join(userA, 'instances', 'event-igrzyska', 'game');
      for (const d of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports']) {
        const attrs = spawnSync('attrib', [path.join(gameDir, d)], { encoding: 'utf8' }).stdout.split(/[A-Za-z]:\\/)[0];
        assert.ok(attrs.includes('H') && attrs.includes('S'), `${d} powinien być ukryty: „${attrs.trim()}”`);
      }
      // po „Sprawdź pliki” (bez startu gry) foldery są zamknięte: nie wejdzie się do nich nawet po wpisaniu ścieżki
      for (const d of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports']) {
        assert.throws(() => fs.readdirSync(path.join(gameDir, d)), (e) => ['EPERM', 'EACCES'].includes(e.code), `${d} powinien być zablokowany po wpisaniu ścieżki`);
      }
      assert.notStrictEqual(spawnSync('cmd', ['/c', 'dir', '/b', path.join(gameDir, 'mods')], { encoding: 'utf8' }).status, 0, 'wiersz poleceń też dostaje odmowę');
      assert.match(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8'), /^fov:70\.0$/m, 'options.txt (katalog główny) dostępny');
    }
    for (const call of [['instances:delete', 'event-igrzyska'], ['content:toggle', 'event-igrzyska', 'mod', 'death-games-1.0.jar'], ['instances:update', 'event-igrzyska', { name: 'x' }]]) {
      const r = await inv(...call);
      assert.ok(r.ok === false, `${call[0]} powinno być zablokowane: ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual((await inv('instances:list')).data.map((i) => i.name), ['IGRZYSKA ŚMIERCI'], 'instancja nietknięta');
    ok('IPC w trybie wydarzenia: Serwery/Modrinth/Skiny/Wersje/tworzenie instancji zablokowane, synchronizacja tworzy zablokowaną instancję, jej nie da się usunąć ani zmienić');

    await app.evaluate("document.getElementById('toasts').replaceChildren()"); // wcześniejsze komunikaty (blokada zakładki)
    await app.evaluate("location.hash = '#/settings'");
    await until(async () => /Ustawienia/.test(await text(app)) && (await app.evaluate("!!document.querySelector('.settings-card')")), 'ustawienia');
    await sleep(600);
    assert.deepStrictEqual(await errToasts(app), [], 'ustawienia bez błędów w trybie wydarzenia');
    ok('Ustawienia w trybie wydarzenia otwierają się bez błędów');
  } finally {
    await app.close({ graceful: true });
  }

  // ponowny start z zapisanym kodem (te same dane): launcher wstaje bez ekranu błędu i pokazuje wydarzenie
  await sleep(800);
  app = await launchApp(appDir, userA);
  try {
    try {
      await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length > 3"), 'ponowny start z zapisanym kodem', 40000);
    } catch (e) {
      const dump = await app.evaluate('document.body.innerText').catch(() => '(brak odpowiedzi strony)');
      const status = await app.evaluate("window.crown.invoke('invite:status')").catch(() => null);
      throw new Error(`${e.message}; invite:status: ${JSON.stringify(status)}; treść okna: ${String(dump).slice(0, 300)}`);
    }
    assert.doesNotMatch(await text(app), /Błąd uruchomienia/);
    assert.deepStrictEqual(await navLabels(app), ['IGRZYSKA ŚMIERCI', 'Instancje', 'Serwery', 'Skiny', 'Modrinth', 'Ustawienia']);
    await until(async () => /Minecraft 1\.21\.4/.test(await text(app)), 'strona wydarzenia po restarcie');
    assert.match(await text(app), /Zagraj|Zatrzymaj/);
    assert.deepStrictEqual(await errToasts(app), [], 'bez błędów przy starcie');
    ok('ponowny start z zapisanym kodem: launcher wstaje w trybie wydarzenia bez błędów');
  } finally {
    app.close();
  }

  // ================================================================ B) pełny dostęp + kod wpisany w zakładce
  const userB = tmp('crown-evui-dataB-');
  app = await launchApp(appDir, userB);
  try {
    await until(() => app.evaluate("!!document.querySelector('input.input') && !document.querySelector('.sidebar')"), 'ekran z kluczem (B)');
    await typeKey(app, pelnyKey);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length > 3"), 'launcher (B)');
    assert.deepStrictEqual(await navLabels(app), ['Start', 'IGRZYSKA ŚMIERCI', 'Instancje', 'Serwery', 'Skiny', 'Modrinth', 'Ustawienia']);
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item.locked').length"), 0, 'nic nie jest zablokowane');
    ok('pełny dostęp: menu Start, IGRZYSKA ŚMIERCI (nad Instancjami), reszta bez blokad');

    // wchodzi w zakładkę wydarzenia: prosi o kod
    await app.evaluate("[...document.querySelectorAll('.nav-item')].find((a) => /IGRZYSKA/.test(a.textContent)).click()");
    await until(async () => /wpisz kod od organizatora/.test(await text(app)), 'prośba o kod');
    assert.strictEqual(await app.evaluate("[...document.querySelectorAll('.btn')].some((b) => /Odblokuj/.test(b.textContent))"), true);
    // zły kod (zwykły klucz) i poprawny
    await app.evaluate("(() => { const i = document.querySelector('input.input'); i.value = 'CROWN-AAAA-AAAA-AAAA-AAAA'; document.querySelector('.btn.primary').click(); })()");
    await until(async () => (await errToasts(app)).length > 0, 'komunikat o złym kodzie');
    await app.evaluate("(() => { const i = document.querySelector('input.input'); i.value = " + JSON.stringify(kod2Key) + "; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()");
    await until(async () => /Kod wpisany/.test(await text(app)), 'strona wydarzenia po wpisaniu kodu');
    assert.doesNotMatch(await text(app), /death-games|Arena Pack|sodium-options/, 'po wpisaniu kodu też bez list plików');
    assert.match(await text(app), /Kod wpisany/);
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item.locked').length"), 0, 'po wpisaniu kodu nadal nic nie jest zablokowane');
    const file = await app.shot('crown-event-code.png');
    ok(`gracz z pełnym dostępem wpisuje kod w zakładce wydarzenia: pliki widoczne, nic nie zablokowane (zrzut: ${file})`);

    // zakładki działają jak zawsze, a instancja wydarzenia nie miesza się z listą instancji
    const inv = async (...a) => app.evaluate(`window.crown.invoke(...${JSON.stringify(a)})`);
    assert.ok((await inv('servers:list')).ok);
    const sync = await inv('event:sync');
    assert.ok(sync.ok, JSON.stringify(sync));
    assert.deepStrictEqual((await inv('instances:list')).data, [], 'instancja wydarzenia poza listą zwykłych instancji');
    const del = await inv('instances:delete', 'event-igrzyska');
    assert.ok(del.ok === false && /zablokowana/.test(del.error), JSON.stringify(del));
    await app.evaluate("location.hash = '#/instances'");
    await sleep(500);
    assert.strictEqual(await app.evaluate('location.hash'), '#/instances');
    ok('pełny dostęp po wpisaniu kodu: Instancje/Serwery działają, instancja wydarzenia ukryta na liście i zablokowana');
  } finally {
    app.close();
    server.kill();
    // foldery wydarzenia są zamknięte (odmowa NTFS) - przed sprzątaniem trzeba je otworzyć
    for (const u of [userA, userB]) await unlockEventDirs(u);
    for (const d of [appDir, userA, userB, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
