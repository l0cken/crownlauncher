// Eksport instancji w prawdziwym Electronie (CDP): karta „Eksport instancji” na stronie instancji, okno „Zapisz jako” (podstawione),
// postęp, okno z wynikiem, anulowanie, światy, odmowa przy działającej grze, instancja wydarzenia (brak karty, kanał odmawia).
// Bez internetu. Uruchomienie: node dev-tests/export-ui-test.js
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

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
    await sleep(200);
  }
  throw new Error(`Przekroczono czas: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

/** Kopia aplikacji bez prywatnej dystrybucji i bez sieci + własny punkt wejścia, który podstawia okno „Zapisz jako”. */
function makeApp(controlFile) {
  const appDir = tmp('crown-exui-app-');
  fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.main = 'test-main.js';
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
  const cfgFile = path.join(appDir, 'src', 'main', 'core', 'app-config.js');
  let cfg = fs.readFileSync(cfgFile, 'utf8');
  for (const [key, value] of Object.entries({ GITHUB_REPO: '', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false, DISCORD_CLIENT_ID: '' })) {
    cfg = cfg.replace(new RegExp(`${key}: (?:'[^']*'|true|false)`, 'g'), () => `${key}: ${typeof value === 'boolean' ? value : `'${value}'`}`);
  }
  fs.writeFileSync(cfgFile, cfg);
  fs.writeFileSync(
    path.join(appDir, 'test-main.js'),
    `const fs = require('fs');
     const { dialog } = require('electron');
     // okno „Zapisz jako”: zawartość pliku sterującego = ścieżka docelowa albo CANCEL; zapisujemy też opcje, z jakimi je otwarto
     dialog.showSaveDialog = async (...args) => {
       const opts = args[args.length - 1];
       fs.writeFileSync(${JSON.stringify(controlFile + '.opts')}, JSON.stringify({ defaultPath: opts.defaultPath, filters: opts.filters, title: opts.title }));
       const want = fs.readFileSync(${JSON.stringify(controlFile)}, 'utf8').trim();
       return want === 'CANCEL' ? { canceled: true } : { canceled: false, filePath: want };
     };
     require('./src/main/main.js');`,
  );
  return appDir;
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
  const close = () => {
    try { ws.close(); } catch { /* już zamknięte */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  return { evaluate, close, shot };
}

(async () => {
  const userData = tmp('crown-exui-data-');
  const outDir = tmp('crown-exui-out-');
  const control = path.join(outDir, 'control.txt');
  const exportsDir = path.join(outDir, 'eksporty');

  // dane „użytkownika”: konto offline (bez ekranu powitalnego) i dwie instancje: zwykła i wydarzenia
  write(path.join(userData, 'config.json'), JSON.stringify({ accounts: [{ id: 'a1', type: 'offline', username: 'Tester', uuid: 'u' }], selectedAccount: 'a1', discordPresence: false, optimizeMods: false }));
  const mk = (id, extra) => {
    write(path.join(userData, 'instances', id, 'instance.json'), JSON.stringify({ id, name: 'Moja instancja', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memoryMb: 0, jvmArgs: '', javaPath: '', color: '#f2b01e', createdAt: Date.now(), lastPlayed: 0, playTime: 0, perfModsApplied: true, ...extra }));
  };
  mk('moja-ab12', {});
  const game = path.join(userData, 'instances', 'moja-ab12', 'game');
  write(path.join(game, 'mods', 'sodium.jar'), Buffer.from('PK-sodium'));
  write(path.join(game, 'config', 'a.json'), '{}');
  write(path.join(game, 'options.txt'), 'fov:90\n');
  write(path.join(game, 'saves', 'Swiat', 'level.dat'), 'lvl');
  write(path.join(game, 'logs', 'latest.log'), 'log');
  write(path.join(game, 'config', 'discord-token.json'), '{"t":1}');
  mk('event-igrzyska', { name: 'IGRZYSKA ŚMIERCI', locked: true, event: 'igrzyska' });
  write(path.join(userData, 'instances', 'event-igrzyska', 'game', 'mods', 'tajny.jar'), 'x');

  const app = await launchApp(makeApp(control), userData);
  try {
    const body = () => app.evaluate('document.body.innerText');
    const toasts = () => app.evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent)");
    const clickText = (sel, text) => app.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('brak: ' + ${JSON.stringify(text)}); b.click(); return true; })()`);

    await until(() => app.evaluate("!!document.querySelector('.sidebar')"), 'interfejs launchera');
    await app.evaluate("location.hash = '#/instance/moja-ab12'");
    await until(async () => (await app.evaluate("[...document.querySelectorAll('.tabs button')].some((b) => b.textContent === 'Ustawienia')")), 'strona instancji');
    await clickText('.tabs button', 'Ustawienia');
    await until(async () => /Eksport instancji/.test(await body()), 'karta eksportu');
    const text = await body();
    // etykiety w interfejsie bywają wersalikami (text-transform), więc bez rozróżniania wielkości liter
    assert.ok(/Eksport instancji/i.test(text) && /Eksportuj do pliku \.mrpack/i.test(text) && /Dołącz światy/i.test(text), JSON.stringify(text.slice(-700)));
    ok('strona instancji → Ustawienia: jest karta „Eksport instancji” z przyciskiem i przełącznikiem światów');

    // anulowanie okna „Zapisz jako”: nic się nie dzieje, żadnego okna z wynikiem, żadnego pliku
    fs.writeFileSync(control, 'CANCEL');
    await clickText('button', 'Eksportuj do pliku .mrpack');
    await until(() => fs.existsSync(`${control}.opts`), 'okno zapisu');
    await sleep(600);
    assert.ok(!/Instancja wyeksportowana|Eksport instancji\n\nPrzygotowanie/.test(await body()), 'po anulowaniu brak okna wyniku');
    assert.ok(!fs.existsSync(exportsDir), 'po anulowaniu brak pliku');
    const opts = JSON.parse(fs.readFileSync(`${control}.opts`, 'utf8'));
    assert.strictEqual(path.basename(opts.defaultPath), 'Moja instancja.mrpack', 'proponowana nazwa = nazwa instancji');
    assert.deepStrictEqual(opts.filters[0].extensions, ['mrpack']);
    ok('okno „Zapisz jako”: proponuje „Moja instancja.mrpack”, filtr .mrpack; anulowanie nic nie robi');

    // eksport bez światów
    const dest1 = path.join(exportsDir, 'bez-swiatow.mrpack');
    fs.writeFileSync(control, dest1);
    await clickText('button', 'Eksportuj do pliku .mrpack');
    await until(async () => /Instancja wyeksportowana/.test(await body()), 'okno wyniku');
    const done = await body();
    assert.match(done, /Plików w paczce: 3 /);
    assert.ok(done.includes(dest1), 'ścieżka pliku w oknie wyniku');
    assert.match(done, /Pominięte pliki: 1 \(w tym 1 wyglądających na poufne/);
    assert.ok(/Importuj/.test(done) && /Pokaż w folderze/.test(done));
    const zip = new AdmZip(dest1);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    assert.deepStrictEqual(names, ['modrinth.index.json', 'overrides/config/a.json', 'overrides/mods/sodium.jar', 'overrides/options.txt']);
    ok('eksport z interfejsu: plik .mrpack z modami, configiem i options.txt; bez światów, logów i pliku z tokenem; okno z wynikiem');
    await app.shot('export-ui-wynik.png');

    // zamknij okno wyniku i wyeksportuj ze światami
    await clickText('.modal header button', '');
    await until(async () => !/Instancja wyeksportowana/.test(await body()), 'zamknięcie okna wyniku');
    await app.evaluate("document.querySelector('.settings-card .switch.on') ? null : [...document.querySelectorAll('.settings-card')].find((c) => c.textContent.includes('Eksport instancji')).querySelector('.switch').click()");
    const dest2 = path.join(exportsDir, 'ze-swiatami.mrpack');
    fs.writeFileSync(control, dest2);
    await clickText('button', 'Eksportuj do pliku .mrpack');
    await until(async () => /ze światami/.test(await body()), 'wynik ze światami');
    assert.ok(new AdmZip(dest2).getEntry('overrides/saves/Swiat/level.dat'), 'światy w paczce po włączeniu przełącznika');
    ok('przełącznik „Dołącz światy” włącza saves/ w paczce, a okno wyniku mówi „ze światami”');
    await clickText('.modal header button', '');

    // kanał IPC: instancja wydarzenia i działająca gra
    const invoke = (ch, ...a) => app.evaluate(`window.crown.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(a)})`);
    fs.writeFileSync(control, path.join(exportsDir, 'event.mrpack'));
    const ev = await invoke('instances:export', 'event-igrzyska', {});
    assert.strictEqual(ev.ok, false);
    assert.match(ev.error, /nie można eksportować/);
    assert.ok(!fs.existsSync(path.join(exportsDir, 'event.mrpack')));
    ok('kanał IPC: instancja wydarzenia nie da się wyeksportować, nawet z pominięciem interfejsu');

    // plik z poza instancji i inne wejścia
    const bad = await invoke('instances:export', 'nie-ma-takiej', {});
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Nie znaleziono instancji/);
    const traversal = await invoke('instances:export', '../moja-ab12', {});
    assert.strictEqual(traversal.ok, false, 'id ze ścieżką odrzucone');
    ok('nieistniejąca instancja i id ze ścieżką (..): odmowa');

    // eksport nie zostawia plików .part
    assert.deepStrictEqual(fs.readdirSync(exportsDir).sort(), ['bez-swiatow.mrpack', 'ze-swiatami.mrpack']);
    ok('w folderze docelowym zostały tylko gotowe paczki (bez plików .part)');
  } finally {
    app.close();
    await sleep(500);
    for (const d of [userData, outDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* katalog jeszcze zajęty */ } }
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
