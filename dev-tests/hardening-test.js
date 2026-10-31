// Utwardzenie okna launchera (prawdziwe naciśnięcia klawiszy w prawdziwym Electronie): narzędzia deweloperskie nie
// otwierają się, a zwykła praca (wklejanie klucza, wycinanie, F5) działa mimo braku domyślnego menu.
// Wymaga zalogowanego pulpitu (SendKeys); modyfikuje schowek na czas testu i go przywraca.
// Uruchomienie: node dev-tests/hardening-test.js   (otwiera na chwilę okno launchera)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });

async function until(fn, what, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* dalej */ }
    await sleep(250);
  }
  throw new Error(`Przekroczono czas: ${what}`);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-hard-'));
  const port = await freePort();
  // domyślnie `electron .` z CROWN_HARDEN=1; z CROWN_PKG_EXE=<exe z buildu CROWN_DEBUG_BUILD=1> testujemy spakowaną
  // aplikację (utwardzenie włącza się samo, bo app.isPackaged)
  const proc = process.env.CROWN_PKG_EXE
    ? spawn(process.env.CROWN_PKG_EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' })
    : spawn(electronExe, [root, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, CROWN_HARDEN: '1' } });
  const oldClip = ps('Get-Clipboard -Raw').stdout;
  let ws;
  try {
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)), 'okno launchera');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const devtools = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => /devtools/i.test(t.url)).length;
    const keys = (seq) => {
      const r = ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${proc.pid}); Start-Sleep -Milliseconds 600; [System.Windows.Forms.SendKeys]::SendWait('${seq}')`);
      assert.ok(!r.stderr, `SendKeys: ${r.stderr}`);
    };

    // świeże dane = pole na klucz zaproszenia (zwykły <input>)
    await until(() => evaluate("!!document.querySelector('input.input')"), 'ekran z polem na klucz');
    await evaluate("document.querySelector('input.input').focus()");

    // narzędzia deweloperskie: żaden skrót ich nie otwiera
    for (const seq of ['{F12}', '^+i', '^+j', '^+c', '^u']) {
      keys(seq);
      await sleep(900);
      assert.strictEqual(await devtools(), 0, `skrót ${seq} otworzył narzędzia deweloperskie`);
    }
    ok('F12, Ctrl+Shift+I/J/C i Ctrl+U nie otwierają narzędzi deweloperskich');

    // zwykła praca bez domyślnego menu: wklejanie, zaznaczanie i wycinanie w polu
    await evaluate("document.querySelector('input.input').focus()");
    ps("Set-Clipboard -Value 'Wklejony Nick'");
    keys('^v');
    await sleep(500);
    assert.strictEqual(await evaluate("document.querySelector('input.input').value"), 'Wklejony Nick', 'Ctrl+V nie wkleił tekstu');
    keys('^a');
    keys('^x');
    await sleep(500);
    assert.strictEqual(await evaluate("document.querySelector('input.input').value"), '', 'Ctrl+A, Ctrl+X nie wycięły tekstu');
    assert.match(ps('Get-Clipboard -Raw').stdout, /Wklejony Nick/, 'wycięty tekst trafił do schowka');
    ok('wklejanie (Ctrl+V), zaznaczanie i wycinanie działają mimo braku domyślnego menu');

    // F5 nadal przeładowuje interfejs (obsługujemy go sami)
    await evaluate('window.__znacznik = 1');
    keys('{F5}');
    await until(async () => (await evaluate('window.__znacznik')) === undefined, 'przeładowanie po F5', 8000);
    ok('F5 przeładowuje interfejs');
  } finally {
    try { ws?.close(); } catch { /* */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    ps(`Set-Clipboard -Value ${oldClip ? `'${oldClip.replace(/'/g, "''").trim()}'` : '$null'}`); // przywracamy schowek (tekst)
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
