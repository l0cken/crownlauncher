// Avatary kont w prawdziwym Electronie (CDP): twarze kont pochodzą z serwera launchera (przekaźnik do mc-heads.net - tu atrapa), okno
// nie łączy się z mc-heads.net, a konto bez obrazka dostaje lokalny zastępnik z inicjałem. Prawdziwy proces główny, prawdziwy interfejs.
// Uruchomienie: node dev-tests/avatar-ui-test.js   (otwiera na chwilę okno launchera)
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

/** Uruchamia aplikację i podłącza się do jej okna przez DevTools Protocol. */
async function launchApp(appDir) {
  const userData = tmp('crown-av-data-');
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
  const close = () => {
    try { ws.close(); } catch { /* już zamknięte */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* katalog jeszcze zajęty */ }
  };
  return { evaluate, send, close };
}

/** Kopia aplikacji (src, assets, package.json, junction do node_modules) z podmienionymi polami app-config.js. */
function makeApp(fields) {
  const appDir = tmp('crown-av-app-');
  fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
  const cfgFile = path.join(appDir, 'src', 'main', 'core', 'app-config.js');
  let cfg = fs.readFileSync(cfgFile, 'utf8');
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`${key}: (?:'[^']*'|true|false)`, 'g');
    cfg = cfg.replace(re, `${key}: ${typeof value === 'boolean' ? value : `'${value}'`}`);
  }
  fs.writeFileSync(cfgFile, cfg);
  return appDir;
}

(async () => {
  // ---- atrapa mc-heads.net ----
  const hits = [];
  const upPort = await freePort();
  const upstream = http.createServer((req, res) => {
    hits.push({ path: req.url, headers: req.headers });
    if (decodeURIComponent(req.url.split('/')[2] || '') === 'NoFace_B') return res.writeHead(404).end('nie ma');
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  // ---- serwer prywatny + kopia aplikacji z adresem serwera i INVITE_REQUIRED ----
  const dataDir = tmp('crown-av-srv-');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', AVATAR_UPSTREAM: `http://127.0.0.1:${upPort}` };
  const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  await until(() => up, 'serwer');
  const base = `http://127.0.0.1:${port}`;
  const created = spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'create-invite', 'Tester'], { env, encoding: 'utf8' }).stdout;
  const key = /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(created)[1];

  const appDir = makeApp({ GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, INVITE_REQUIRED: true });
  const app = await launchApp(appDir);
  try {
    await until(() => app.evaluate("!!document.querySelector('input.input')"), 'ekran z kluczem');
    await app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = ${JSON.stringify(key)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length"), 'launcher po wpisaniu klucza');

    // trzy konta offline: dwa z obrazkiem w serwisie, jedno bez
    for (const nick of ['Avatar_A', 'NoFace_B', 'Avatar_C']) {
      const r = await app.evaluate(`window.crown.invoke('accounts:add-offline', ${JSON.stringify(nick)})`);
      assert.ok(r.ok, JSON.stringify(r));
    }
    const list = (await app.evaluate("window.crown.invoke('accounts:list')")).data;
    const idOf = (name) => list.accounts.find((a) => a.username === name).id;
    await app.evaluate(`window.crown.invoke('accounts:select', ${JSON.stringify(idOf('Avatar_A'))})`);
    await app.evaluate("window.crown.invoke('win:reload')"); // launcher blokuje location.reload() (will-navigate), ale ma własne przeładowanie okna
    await until(() => app.evaluate("document.querySelector('.account-chip .nm')?.textContent === 'Avatar_A'"), 'panel boczny z kontem po przeładowaniu');

    // panel boczny: twarz aktywnego konta przychodzi z serwera launchera jako data URL (nie z adresu http)
    await until(() => app.evaluate("document.querySelector('.account-chip img.avatar').src.startsWith('data:image/png;base64,')"), 'twarz konta w panelu bocznym');
    ok('panel boczny: twarz konta to PNG z serwera launchera (data URL), nie adres z internetu');

    // Ustawienia: lista kont - dwa konta z twarzą, trzecie (bez obrazka w serwisie) z lokalnym zastępnikiem
    await app.evaluate("location.hash = '#/settings'");
    await until(() => app.evaluate("document.querySelectorAll('.acct-row img.avatar').length === 3"), 'lista kont w ustawieniach');
    const srcByName = () => app.evaluate(`Object.fromEntries([...document.querySelectorAll('.acct-row')].filter((r) => r.querySelector('img.avatar')).map((r) => [r.querySelector('.grow div').textContent, r.querySelector('img.avatar').src.slice(0, 22)]))`);
    await until(async () => {
      const s = await srcByName();
      return s.Avatar_A.startsWith('data:image/png') && s.Avatar_C.startsWith('data:image/png');
    }, 'twarze kont z serwera');
    await sleep(1500);
    const srcs = await srcByName();
    assert.ok(srcs.NoFace_B.startsWith('data:image/svg+xml'), `konto bez obrazka: lokalny zastępnik (jest: ${srcs.NoFace_B})`);
    ok('Ustawienia → konta: Avatar_A i Avatar_C mają twarz z serwera, NoFace_B (brak w serwisie) lokalny zastępnik z inicjałem');

    // przełącznik kont w panelu bocznym też bierze twarze z tego samego źródła
    await app.evaluate("document.querySelector('.account-chip').click()");
    await until(() => app.evaluate("document.querySelectorAll('.modal .acct-row img.avatar, .acct-row img.avatar').length >= 3"), 'przełącznik kont');
    const allSrc = await app.evaluate("[...document.querySelectorAll('img.avatar')].map((i) => i.src)");
    assert.ok(allSrc.length >= 3 && allSrc.every((s) => s.startsWith('data:')), `wszystkie avatary to data URL: ${allSrc.map((s) => s.slice(0, 30)).join(' | ')}`);
    ok('przełącznik kont: każdy avatar to data URL (żaden nie wskazuje na zewnętrzny adres)');

    // okno nie wysłało żadnego żądania do mc-heads.net (ani do żadnego obrazka spoza siebie z tytułu avatarów)
    const resources = await app.evaluate("performance.getEntriesByType('resource').map((e) => e.name)");
    assert.ok(!resources.some((u) => /mc-heads/i.test(u)), `żądania okna: ${resources.join(', ')}`);
    ok('okno nie wysłało żadnego żądania do mc-heads.net');

    // zastępnik: poprawny obraz, a „dziwny” nick nie psuje SVG (znaki specjalne są zamieniane)
    const ph = await app.evaluate(`(async () => {
      const m = await import('./js/components.js');
      const u = m.placeholderAvatar({ username: '<b>"Z&ły' });
      const img = new Image();
      img.src = u;
      await img.decode();
      return { svg: u.startsWith('data:image/svg+xml'), width: img.naturalWidth, raw: decodeURIComponent(u.split(',')[1]) };
    })()`);
    assert.ok(ph.svg && ph.width > 0, 'zastępnik się rysuje');
    assert.ok(!ph.raw.includes('<b>') && ph.raw.includes('&lt;'), 'znaki specjalne w nicku są zamienione');
    ok('lokalny zastępnik: poprawny SVG, znaki specjalne w nicku nie psują obrazka');

    // serwis dostał pytania tylko od serwera: po jednym na konto i bez śladów gracza w nagłówkach
    const paths = hits.map((h) => h.path).sort();
    assert.deepStrictEqual(paths, ['/avatar/Avatar_A/128', '/avatar/Avatar_C/128', '/avatar/NoFace_B/128'], `pytania do serwisu: ${paths.join(', ')}`);
    for (const h of hits) {
      for (const name of ['x-crown-invite', 'x-crown-device', 'cookie', 'authorization', 'x-forwarded-for']) assert.ok(!(name in h.headers), `serwis dostał nagłówek ${name}`);
      assert.ok(!JSON.stringify(h.headers).includes(key), 'w nagłówkach nie ma klucza zaproszenia');
    }
    ok('serwis (atrapa mc-heads.net) dostał po jednym pytaniu na konto, bez klucza zaproszenia, identyfikatora komputera i ciasteczek');
  } finally {
    app.close();
    server.kill();
    upstream.close();
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
