// Zrzuty ekranu PRAWDZIWEGO launchera do poradnika dla graczy IGRZYSK ŚMIERCI: lokalny serwer (server.js, INVITE_ONLY) z wydarzeniem
// „igrzyska” (Minecraft 26.2) i FAŁSZYWYMI kluczami, prawdziwy Electron (CDP). Nic nie dotyka produkcji ani prawdziwych kluczy.
// Użycie: node dev-tests/guide-screenshots.js <katalog-wyjściowy>
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CROWN_INVITE_WATCH_MS = '60000';
const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'poradnik-zrzuty'));
fs.mkdirSync(out, { recursive: true });
const { setAccess } = require(path.join(root, 'src', 'main', 'core', 'hidden.js'));
const unlockEventDirs = (userDir) =>
  setAccess(['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports'].map((d) => path.join(userDir, 'instances', 'event-igrzyska', 'game', d)), 'open');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function until(fn, what, ms = 30000) {
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

async function launchApp(appDir, userData) {
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
    const file = path.join(out, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log(`zrzut: ${file}`);
    return file;
  };
  return { evaluate, send, close, shot };
}

function makeApp(fields) {
  const appDir = tmp('crown-guide-app-');
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
  const dataDir = tmp('crown-guide-srv-');
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
  await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: bearer, body: JSON.stringify({ mcVersion: '26.2', crownClient: true }) });
  const put = (kind, name, body) => fetch(`${base}/v1/admin/events/igrzyska/${kind}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body });
  await put('mods', 'przykladowy-mod.jar', zipLike('mod', 4096));
  await put('resourcepacks', 'przykladowa-paczka.zip', zipLike('pack', 3000));
  await fetch(`${base}/v1/admin/events/igrzyska/root?path=options.txt`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('fov:70.0\n') });
  const kodKey = KEY_RE.exec(cli('create-invite', 'Gracz z kodem', '--profile', 'igrzyska'))[1];
  const pelnyKey = KEY_RE.exec(cli('create-invite', 'Gracz pelny', '--uses', '2'))[1];
  const kod2Key = KEY_RE.exec(cli('create-invite', 'Kod dla pelnego', '--profile', 'igrzyska'))[1];

  const appDir = makeApp({ GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, INVITE_REQUIRED: true });
  const text = (app) => app.evaluate('document.body.innerText');
  const setInput = (app, value, enter) => app.evaluate(`(() => { const i = document.querySelector('input.input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); ${enter ? "i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));" : ''} })()`);
  const userA = tmp('crown-guide-dataA-');
  const userB = tmp('crown-guide-dataB-');

  // ---- A) gracz z samym kodem wydarzenia ----
  let app = await launchApp(appDir, userA);
  try {
    await until(() => app.evaluate("!!document.querySelector('input.input') && !document.querySelector('.sidebar')"), 'ekran z kluczem');
    await sleep(600);
    await setInput(app, 'CROWN-7KQ2-M9XD-4WPH-T3NB', false); // przykładowy kształt klucza (nie jest prawdziwym kluczem)
    await sleep(300);
    await app.shot('01-ekran-klucza.png');
    await setInput(app, kodKey, true);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length > 3"), 'launcher po kodzie');
    await until(async () => /Minecraft 26\.2/.test(await text(app)), 'strona wydarzenia');
    await sleep(800);
    await app.shot('02-igrzyska-zagraj.png');
    await app.evaluate("location.hash = '#/settings'");
    await until(() => app.evaluate("!!document.querySelector('.settings-card')"), 'ustawienia');
    await sleep(800);
    await app.shot('03-ustawienia-konta.png');
    // konto offline, tak jak doda je gracz bez Microsoftu
    await app.evaluate("(() => { const i = document.querySelector('.settings-card input.input'); i.value = 'TwojNick'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(300);
    await app.shot('03b-ustawienia-nick.png');
    await app.evaluate("[...document.querySelectorAll('.btn')].find((b) => /Dodaj offline/.test(b.textContent)).click()");
    await until(async () => /TwojNick/.test(await text(app)), 'konto dodane');
    await sleep(700);
    await app.shot('04-konto-dodane.png');
    await app.evaluate("[...document.querySelectorAll('.nav-item')].find((a) => /IGRZYSKA/.test(a.textContent)).click()");
    await until(async () => /Minecraft 26\.2/.test(await text(app)), 'wydarzenie ponownie');
    await sleep(4500); // komunikat „Dodano konto offline” zdąży zniknąć
    await app.shot('02b-igrzyska-gotowe.png');
    // „Zagraj”: pierwszy start synchronizuje pliki - łapiemy pasek postępu
    await app.evaluate("[...document.querySelectorAll('.btn.primary')].find((b) => /Zagraj/.test(b.textContent)).click()");
    for (let i = 0; i < 40; i++) {
      if (await app.evaluate("/Przygotowuję pliki|Pobieram pliki|Sprawdzam pliki/.test(document.body.innerText)")) break;
      await sleep(100);
    }
    await app.shot('05-przygotowanie-plikow.png');
  } finally {
    await app.close({ graceful: false });
  }

  // ---- B) gracz z pełnym dostępem, który wpisuje kod w zakładce wydarzenia ----
  app = await launchApp(appDir, userB);
  try {
    await until(() => app.evaluate("!!document.querySelector('input.input') && !document.querySelector('.sidebar')"), 'ekran z kluczem (B)');
    await setInput(app, pelnyKey, true);
    await until(() => app.evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length > 3"), 'launcher (B)');
    await sleep(900);
    await app.shot('06-pelny-dostep-menu.png');
    await app.evaluate("[...document.querySelectorAll('.nav-item')].find((a) => /IGRZYSKA/.test(a.textContent)).click()");
    await until(async () => /wpisz kod od organizatora/.test(await text(app)), 'prośba o kod');
    await sleep(500);
    await setInput(app, 'CROWN-7KQ2-M9XD-4WPH-T3NB', false);
    await sleep(300);
    await app.shot('07-kod-w-zakladce.png');
    await setInput(app, kod2Key, true);
    await until(async () => /Kod wpisany/.test(await text(app)), 'strona wydarzenia po kodzie');
    await sleep(700);
    await app.shot('08-kod-przyjety.png');
  } finally {
    await app.close({ graceful: false });
    server.kill();
    await sleep(1500);
    for (const u of [userA, userB]) await unlockEventDirs(u).catch(() => {});
    for (const d of [appDir, userA, userB, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* katalog tymczasowy */ } }
  }
  console.log('GOTOWE');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
