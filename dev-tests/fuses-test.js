// Bezpieczniki Electrona w spakowanej aplikacji: exe nie działa jako zwykły Node (ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
// --inspect), a podmieniony app.asar jest odrzucany zamiast cicho zmieniać zachowanie launchera.
// Wymaga zbudowanej aplikacji: CROWN_PKG_EXE=<ścieżka do CrownLauncher.exe> (np. z `electron-builder --dir`),
// domyślnie release/win-unpacked; opcjonalnie CROWN_PKG_DEBUG_EXE=<exe z buildu CROWN_DEBUG_BUILD=1> - sprawdza, że
// tylko build testowy przyjmuje flagi zdalnego debugowania. Uruchomienie: node dev-tests/fuses-test.js
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const exe = process.env.CROWN_PKG_EXE || path.join(root, 'release', 'win-unpacked', 'CrownLauncher.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

/** Uruchamia exe z danymi w osobnym katalogu; zwraca { code, out, alive } po `ms` (żywy proces jest zabijany). */
async function run(exePath, { args = [], env = {}, ms = 9000 } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-fuse-'));
  const proc = spawn(exePath, [`--user-data-dir=${userData}`, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  let code = null;
  proc.on('exit', (c) => { code = c; });
  const t0 = Date.now();
  while (code === null && Date.now() - t0 < ms) await sleep(250);
  const alive = code === null;
  if (alive) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  // Windows chwilę po zabiciu aplikacji trzyma jeszcze pliki katalogu danych (EPERM) - ponawiamy, a w razie porażki zostawiamy go w %TEMP%
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
  return { code, out, alive };
}

(async () => {
  assert.ok(fs.existsSync(exe), `brak ${exe} - zbuduj: electron-builder --config electron-builder.config.js --win --dir`);

  // 1) odczyt bezpieczników
  const read = spawnSync(process.execPath, [path.join(root, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js'), 'read', '--app', exe], { encoding: 'utf8' });
  const text = read.stdout + read.stderr;
  for (const [fuse, state] of [['RunAsNode', 'Disabled'], ['EnableNodeOptionsEnvironmentVariable', 'Disabled'], ['EnableNodeCliInspectArguments', 'Disabled'],
    ['EnableEmbeddedAsarIntegrityValidation', 'Enabled'], ['OnlyLoadAppFromAsar', 'Enabled']]) {
    assert.match(text, new RegExp(`${fuse} is ${state}`), `bezpiecznik ${fuse} powinien być ${state}:\n${text}`);
  }
  ok('bezpieczniki w exe: tryb Node, NODE_OPTIONS i --inspect wyłączone; ładowanie tylko z app.asar z kontrolą integralności');

  // 2) ELECTRON_RUN_AS_NODE nie zamienia exe w Node (inaczej wykonałby podany kod)
  const marker = path.join(os.tmpdir(), `crown-node-mode-${process.pid}.txt`);
  fs.rmSync(marker, { force: true });
  const asNode = await run(exe, { args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'wykonano')`], env: { ELECTRON_RUN_AS_NODE: '1' }, ms: 6000 });
  assert.ok(!fs.existsSync(marker), `ELECTRON_RUN_AS_NODE wykonał kod (wyjście: ${asNode.out.slice(0, 200)})`);
  ok('ELECTRON_RUN_AS_NODE=1 nie wykonuje podanego kodu (exe nie działa jako Node)');

  // 3) NODE_OPTIONS jest ignorowane (tu: --require ze skryptem zostawiającym ślad)
  const preload = path.join(os.tmpdir(), `crown-node-options-${process.pid}.js`);
  const marker2 = path.join(os.tmpdir(), `crown-node-options-${process.pid}.txt`);
  fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker2)}, 'wykonano');`);
  fs.rmSync(marker2, { force: true });
  await run(exe, { env: { NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"` }, ms: 7000 });
  assert.ok(!fs.existsSync(marker2), 'NODE_OPTIONS --require wykonał obcy kod');
  fs.rmSync(preload, { force: true });
  ok('NODE_OPTIONS=--require jest ignorowane');

  // 4) podmieniony app.asar: kopia aplikacji z jednym zmienionym bajtem w środku nie wstaje
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-tamper-'));
  fs.cpSync(path.dirname(exe), copy, { recursive: true });
  const asar = path.join(copy, 'resources', 'app.asar');
  const buf = fs.readFileSync(asar);
  const needle = Buffer.from('MESSAGE_MODE');
  const at = buf.indexOf(needle);
  assert.ok(at > 0, 'nie znaleziono tekstu do podmiany w app.asar');
  buf[at] = buf[at] ^ 0x01; // jeden bit - kod pliku restrictions.js zmieniony
  fs.writeFileSync(asar, buf);
  const tampered = await run(path.join(copy, path.basename(exe)), { ms: 12000 });
  assert.ok(!tampered.alive, `podmieniony app.asar wystartował (proces działa, wyjście: ${tampered.out.slice(0, 200)})`);
  assert.notStrictEqual(tampered.code, 0, 'podmieniony app.asar zakończył się bez błędu');
  // a nieruszona kopia wstaje
  const clean = await run(exe, { ms: 9000 });
  assert.ok(clean.alive, `nieruszona aplikacja nie wstała (kod ${clean.code}, wyjście: ${clean.out.slice(0, 200)})`);
  fs.rmSync(copy, { recursive: true, force: true });
  ok('app.asar ze zmienionym bajtem zostaje odrzucony przy starcie, a nieruszony wstaje normalnie');

  // 5) flagi zdalnego debugowania: zainstalowana wersja odmawia startu (inaczej przeglądarka mogłaby się podłączyć do okna)
  const net = require('net');
  const freePort = () => new Promise((res) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const listening = async (p) => {
    try {
      return (await fetch(`http://127.0.0.1:${p}/json`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  };
  for (const flag of ['--remote-debugging-port', '--remote-debugging-pipe', '--inspect']) {
    const p = await freePort();
    const refused = await run(exe, { args: [flag === '--remote-debugging-pipe' ? flag : `${flag}=${p}`], ms: 6000 });
    assert.ok(!refused.alive && refused.code === 1, `${flag}: oczekiwano odmowy startu (kod 1), jest alive=${refused.alive} kod=${refused.code}`);
    assert.ok(!(await listening(p)), `${flag}: port debugowania nie powinien nasłuchiwać`);
  }
  ok('zainstalowana wersja nie startuje z flagami --remote-debugging-port/-pipe i --inspect (kod 1, nic nie nasłuchuje)');
  if (process.env.CROWN_PKG_DEBUG_EXE) {
    const p = await freePort();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-fuse-dbg-'));
    const proc = spawn(process.env.CROWN_PKG_DEBUG_EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${p}`], { stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await listening(p);
      if (!up) await sleep(400);
    }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.rmSync(userData, { recursive: true, force: true });
    assert.ok(up, 'build testowy powinien przyjmować --remote-debugging-port');
    ok('build testowy (CROWN_DEBUG_BUILD=1) przyjmuje flagi debugowania - tylko do testów');
  }

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
