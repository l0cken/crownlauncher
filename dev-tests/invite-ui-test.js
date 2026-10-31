// Interfejs w prawdziwym Electronie (CDP): ekran z kluczem zaproszenia, przejście do launchera, karta w ustawieniach,
// oraz zwykły start (bez zaproszeń) na kopii z trybem GitHub. Używa osobnego katalogu danych (--user-data-dir).
// Uruchomienie: node dev-tests/invite-ui-test.js   (otwiera na chwilę okna launchera)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.CROWN_INVITE_WATCH_MS = '1500'; // nadzór klucza w otwartym launcherze co 1,5 s (domyślnie 10 min)
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

/** Uruchamia aplikację i podłącza się do jej okna przez DevTools Protocol. */
async function launchApp(appDir) {
  const userData = tmp('crown-ui-data-');
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
  const appDir = tmp('crown-ui-app-');
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
  // ---- serwer prywatny + kopia aplikacji z adresem serwera i INVITE_REQUIRED ----
  const dataDir = tmp('crown-ui-srv-');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  await until(() => up, 'serwer');
  const base = `http://127.0.0.1:${port}`;
  const created = spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'create-invite', 'Tester'], { env, encoding: 'utf8' }).stdout;
  const key = /(CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(created)[1];
  const keyId = /id: ([0-9a-f]{8})/.exec(created)[1];

  const appDir = makeApp({ GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, INVITE_REQUIRED: true });

  let app = await launchApp(appDir);
  try {
    // ekran z kluczem (bez shella launchera)
    await until(() => app.evaluate("!!document.querySelector('.titlebar') && !!document.querySelector('input.input')"), 'ekran z kluczem');
    assert.strictEqual(await app.evaluate("!!document.querySelector('.sidebar')"), false, 'bez klucza nie ma launchera');
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.winctl button').length"), 3, 'pasek tytułu z przyciskami okna');
    assert.match(await app.evaluate("document.body.innerText"), /Launcher tylko dla zaproszonych/);
    const shot = await app.send('Page.captureScreenshot', { format: 'png' });
    const shotFile = path.join(os.tmpdir(), 'crown-invite-gate.png');
    fs.writeFileSync(shotFile, Buffer.from(shot.result.data, 'base64'));
    ok('bez klucza: ekran „Launcher tylko dla zaproszonych” z paskiem tytułu, bez menu launchera');

    // zły klucz
    await app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = 'CROWN-AAAA-AAAA-AAAA-AAAA'; document.querySelector('.btn.primary').click(); })()`);
    await until(async () => /Nieprawidłowy/.test(await app.evaluate('document.body.innerText')), 'komunikat o złym kluczu');
    assert.strictEqual(await app.evaluate("!!document.querySelector('.sidebar')"), false);
    ok('zły klucz: komunikat „Nieprawidłowy lub unieważniony klucz”, launcher nadal zablokowany');

    // dobry klucz
    await app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = ${JSON.stringify(key.toLowerCase())}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length"), 'launcher po wpisaniu klucza');
    // 6 stałych pozycji + zakładka wydarzenia (IGRZYSKA ŚMIERCI), którą pokazuje każdy launcher z kluczem
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item').length"), 7);
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item.locked').length"), 0, 'zwykły klucz nic nie blokuje');
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.titlebar').length"), 1, 'jeden pasek tytułu');
    ok('dobry klucz: launcher się odblokowuje (pasek tytułu, menu z 7 pozycjami, bez blokad)');

    // stan po stronie procesu głównego i brak klucza w danych dla renderera
    const st = await app.evaluate("window.crown.invoke('invite:status')");
    assert.deepStrictEqual(st.data, { required: true, active: true, name: 'Tester' });
    const conf = await app.evaluate("window.crown.invoke('config:get')");
    assert.ok(conf.ok && !('inviteKey' in conf.data) && !('inviteOrigin' in conf.data) && !('accounts' in conf.data) && !('capeSecrets' in conf.data));
    ok('IPC: invite:status = aktywne (Tester); config:get nie zawiera klucza, kont ani sekretów');

    // peleryny tylko dla wybranych: zwykły klucz nie widzi sekcji „Peleryny” w zakładce Skiny, a po nadaniu dostępu ją dostaje
    const hasCapeCard = "[...document.querySelectorAll('.settings-card h3')].some((h) => h.textContent === 'Peleryny')";
    await app.evaluate("location.hash = '#/skins'");
    await until(() => app.evaluate("!!document.querySelector('.skin-canvas') && !document.querySelector('.settings-card .skeleton')"), 'strona Skiny załadowana');
    await sleep(500);
    assert.strictEqual(await app.evaluate(hasCapeCard), false, 'bez dostępu nie ma sekcji „Peleryny”');
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.cape-card').length"), 0, 'ani kafelków peleryn');
    const capeState = await app.evaluate("window.crown.invoke('capes:state')");
    assert.deepStrictEqual([capeState.data.allowed, capeState.data.capes.length], [false, 0]);
    const denied = await app.evaluate("window.crown.invoke('capes:select', 'builtin-gold')");
    assert.ok(denied.ok === false && /tylko dla wybranych graczy/.test(denied.error), JSON.stringify(denied));
    spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'set-capes', keyId, 'on'], { env, encoding: 'utf8' });
    await sleep(2500); // strona pyta serwer o klucz najwyżej co STATUS_MAX_AGE_MS (tu 1,5 s) - stan sprzed nadania dostępu musi się zestarzeć
    await app.evaluate("location.hash = '#/settings'");
    await sleep(300);
    await app.evaluate("location.hash = '#/skins'");
    await until(() => app.evaluate(hasCapeCard), 'sekcja „Peleryny” po nadaniu dostępu', 20000);
    assert.ok((await app.evaluate("document.querySelectorAll('.cape-card').length")) >= 7, 'kafelki peleryn widoczne');
    ok('Skiny: bez dostępu do peleryn nie ma sekcji „Peleryny” (i wybór jest odrzucany), po nadaniu dostępu w panelu sekcja się pojawia');

    // „Peleryny i korona w grze”: domyślnie włączone u wszystkich, przełącznik w Ustawieniach tylko dla kluczy z dostępem z panelu
    const hasRow = "[...document.querySelectorAll('.settings-card .row')].some((r) => r.textContent.includes('Peleryny i korona w grze'))";
    const cosmeticsValue = async () => (await app.evaluate("window.crown.invoke('config:get')")).data.cosmetics;
    await app.evaluate("location.hash = '#/settings'");
    await until(() => app.evaluate("[...document.querySelectorAll('.settings-card h3')].some((h) => h.textContent === 'Launcher')"), 'karta Launcher');
    await sleep(800);
    assert.strictEqual(await app.evaluate(hasRow), false, 'bez dostępu nie ma przełącznika');
    assert.deepStrictEqual((await app.evaluate("window.crown.invoke('client:state')")).data, { allowed: false });
    const denied2 = await app.evaluate("window.crown.invoke('config:set', { cosmetics: false })");
    assert.ok(denied2.ok === false && /tylko dla wybranych graczy/.test(denied2.error), JSON.stringify(denied2));
    assert.strictEqual(await cosmeticsValue(), true, 'bez dostępu peleryny i korona zostają włączone');
    spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'set-disable-client', keyId, 'on'], { env, encoding: 'utf8' });
    await sleep(2500); // stan sprzed nadania dostępu musi się zestarzeć (strona pyta serwer najwyżej co 1,5 s)
    await app.evaluate("location.hash = '#/skins'");
    await sleep(300);
    await app.evaluate("location.hash = '#/settings'");
    await until(() => app.evaluate(hasRow), 'przełącznik „Peleryny i korona w grze” po nadaniu dostępu', 20000);
    const clickSwitch = () => app.evaluate("[...document.querySelectorAll('.settings-card .row')].find((r) => r.textContent.includes('Peleryny i korona w grze')).querySelector('button.switch').click()");
    const switchOn = () => app.evaluate("[...document.querySelectorAll('.settings-card .row')].find((r) => r.textContent.includes('Peleryny i korona w grze')).querySelector('button.switch').classList.contains('on')");
    assert.strictEqual(await switchOn(), true, 'domyślnie włączone');
    await clickSwitch();
    await until(async () => (await cosmeticsValue()) === false, 'peleryny i korona wyłączone');
    assert.strictEqual(await switchOn(), false);
    await clickSwitch();
    await until(async () => (await cosmeticsValue()) === true, 'peleryny i korona włączone z powrotem');
    ok('Ustawienia: przełącznik „Peleryny i korona w grze” tylko po nadaniu dostępu w panelu; bez dostępu odmowa (zostaje włączone), z dostępem działa w obie strony');

    // karta w ustawieniach
    await app.evaluate("location.hash = '#/settings'");
    await until(() => app.evaluate("[...document.querySelectorAll('.settings-card h3')].some((h) => h.textContent === 'Zaproszenie' && h.parentElement.style.display !== 'none')"), 'karta Zaproszenie');
    assert.match(await app.evaluate("document.body.innerText"), /Tester/);
    ok('Ustawienia: karta „Zaproszenie” widoczna i pokazuje właściciela klucza');

    // administrator klika „Zwolnij”: otwarty launcher traci klucz i prosi o wpisanie go od nowa (powód na ekranie)
    spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'release-invite', keyId], { env, encoding: 'utf8' });
    // karta w Ustawieniach (i inne miejsca) odpytują status w trakcie - samo zobaczenie braku klucza nie może wyciszyć
    // powiadomienia, po którym interfejs wraca do ekranu z kluczem
    for (let i = 0; i < 25; i++) {
      await app.evaluate("window.crown.invoke('invite:status')");
      await sleep(100);
    }
    await until(() => app.evaluate("!document.querySelector('.sidebar') && !!document.querySelector('input.input')"), 'ekran z kluczem po zwolnieniu komputera', 20000);
    assert.match(await app.evaluate("document.querySelector('.lock-notice')?.innerText || ''"), /odłączony od klucza przez administratora/, 'powód na ekranie blokady');
    await app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = ${JSON.stringify(key)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length"), 'launcher po ponownym wpisaniu klucza');
    ok('„Zwolnij” przy otwartym launcherze: ekran z kluczem i powodem, ponowne wpisanie tego samego klucza odblokowuje launcher');

    // administrator unieważnia klucz, a otwarty launcher sam wraca do ekranu z kluczem (bez restartu)
    spawnSync(process.execPath, [path.join(root, 'server', 'server.js'), 'revoke-invite', keyId], { env, encoding: 'utf8' });
    await until(() => app.evaluate("!document.querySelector('.sidebar') && !!document.querySelector('input.input') && /tylko dla zaproszonych/.test(document.body.innerText)"), 'powrót do ekranu z kluczem po unieważnieniu', 20000);
    // nic nie da się zrobić: ekran blokady tłumaczy powód, a start gry jest odrzucany po stronie procesu głównego
    assert.match(await app.evaluate("document.querySelector('.lock-notice')?.innerText || ''"), /unieważniony/i, 'powód na ekranie blokady');
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item').length"), 0, 'brak menu launchera');
    const blocked = await app.evaluate("window.crown.invoke('instances:launch', 'dowolna-instancja')");
    assert.ok(blocked.ok === false && /tylko dla zaproszonych/.test(blocked.error), JSON.stringify(blocked));
    ok('unieważnienie klucza: otwarty launcher sam wraca do ekranu zaproszenia z powodem, a start gry jest zablokowany');
  } finally {
    app.close();
  }

  // ---- unieważnienie: po restarcie launcher znów prosi o klucz? (klucz zapisany w danych, ważny) ----
  // zwykły start na niezmienionej konfiguracji (GitHub, bez zaproszeń) - launcher bez ekranu z kluczem
  const plainDir = makeApp({ GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', INVITE_REQUIRED: false });
  app = await launchApp(plainDir);
  try {
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length"), 'zwykły start launchera');
    assert.strictEqual(await app.evaluate("document.querySelectorAll('.nav-item').length"), 6);
    assert.ok(!/Launcher tylko dla zaproszonych/.test(await app.evaluate('document.body.innerText')));
    const st = await app.evaluate("window.crown.invoke('invite:status')");
    assert.strictEqual(st.data.required, false);
    await app.evaluate("location.hash = '#/settings'");
    await sleep(800);
    assert.strictEqual(await app.evaluate("[...document.querySelectorAll('.settings-card h3')].some((h) => h.textContent === 'Zaproszenie' && h.parentElement.style.display !== 'none')"), false, 'karty Zaproszenie nie ma bez INVITE_REQUIRED');
    ok('zwykły launcher (bez INVITE_REQUIRED): start jak dotąd, bez ekranu z kluczem i bez karty „Zaproszenie”');
  } finally {
    app.close();
    server.kill();
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
  console.log(`\nWSZYSTKO OK (${n})   zrzut ekranu z kluczem: ${path.join(os.tmpdir(), 'crown-invite-gate.png')}`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
