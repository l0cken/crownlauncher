// Linux NA PRAWDZIWYM SYSTEMIE: czytanie /proc/<pid>/maps, klasyfikacja bibliotek, nadzór (watchProcess) na prawdziwym procesie
// z „wstrzykniętą” (dlopen) biblioteką oraz chmod folderów wydarzenia. W innych systemach test się pomija.
// Uruchomienie: node dev-tests/linux-real-test.js      (potrzebuje python3 do części z dlopen; bez niego ta część jest pomijana)
// Niczego nie wstrzykuje do cudzych procesów: biblioteka systemowa (kopia libz/libm) jest ładowana przez WŁASNY proces testu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('(tylko Linux - pomijam)');
  process.exit(0);
}

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Przekroczono czas: ${what}`);
}

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-linuxreal-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const paths = require(root + 'src/main/core/paths.js');
  const anticheat = require(root + 'src/main/core/anticheat.js');
  const hidden = require(root + 'src/main/core/hidden.js');
  // reguły z „świeżego” cache - nadzór nie sięga do sieci
  fs.mkdirSync(paths.cache(), { recursive: true });
  fs.writeFileSync(path.join(paths.cache(), 'blocklist.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

  // ---- zwykły proces: biblioteki systemowe są zaufane ----
  const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    const mods = await until(async () => {
      const m = await anticheat.modulesOf(sleeper.pid);
      return m.length ? m : null;
    }, 'odczyt /proc/<pid>/maps');
    assert.ok(mods.every((m) => path.isAbsolute(m)), 'same ścieżki bezwzględne');
    assert.ok(mods.some((m) => /libc[.-]/.test(path.basename(m)) || /ld-/.test(path.basename(m))), `libc / loader widoczne: ${mods.join(', ')}`);
    const r = await anticheat.classifyModules(mods, { javaPath: '', rules: null });
    assert.deepStrictEqual(r.kill, [], `systemowe biblioteki procesu nie dają kill: ${r.kill.join(', ')}`);
    ok(`modulesOf: ${mods.length} bibliotek prawdziwego procesu (/proc/${sleeper.pid}/maps); żadna systemowa nie jest uznana za obcą`);
  } finally {
    sleeper.kill();
  }

  // ---- „wstrzyknięta” biblioteka: kopia biblioteki systemowej załadowana (dlopen) z katalogu użytkownika i z /tmp ----
  const py = spawnSync('python3', ['-c', 'import ctypes'], { encoding: 'utf8' });
  const libDirs = ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/lib64', '/usr/lib', '/lib'];
  const findLib = () => {
    for (const name of ['libz.so.1', 'libm.so.6']) for (const d of libDirs) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
    return '';
  };
  const sysLib = findLib();
  if (py.error || py.status !== 0 || !sysLib) {
    console.log('(brak python3 z ctypes albo biblioteki do skopiowania - pomijam część z dlopen)');
  } else {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.crown-linuxreal-'));
    const tmpLibDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-linuxreal-lib-'));
    const evilHome = path.join(homeDir, 'cheat-hook.so');
    const evilTmp = path.join(tmpLibDir, 'overlay-copy.so');
    fs.copyFileSync(sysLib, evilHome);
    fs.copyFileSync(sysLib, evilTmp);
    // proces, który ładuje obie kopie po sygnale z pliku (żeby watchProcess zdążył zrobić pierwszy przegląd BEZ nich)
    const go = path.join(dataDir, 'go');
    const script =
      'import ctypes, os, sys, time\n' +
      'print("ready", flush=True)\n' +
      'while not os.path.exists(sys.argv[1]): time.sleep(0.05)\n' +
      'ctypes.CDLL(sys.argv[2]); ctypes.CDLL(sys.argv[3])\n' +
      'print("loaded", flush=True)\n' +
      'time.sleep(60)\n';
    const child = spawn('python3', ['-c', script, go, evilHome, evilTmp], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    try {
      await until(() => out.includes('ready'), 'start python');
      const before = await anticheat.modulesOf(child.pid);
      assert.ok(!before.some((m) => m.endsWith('cheat-hook.so')), 'przed załadowaniem biblioteki nie ma w mapie');

      // nadzór na prawdziwym procesie: pierwszy przegląd po 300 ms (bez obcej biblioteki), potem ładujemy ją
      const violations = [];
      const watch = anticheat.watchProcess({ pid: child.pid, javaPath: '', firstDelayMs: 300, fastMs: 200, intervalMs: 2000, onViolation: (v) => violations.push(v) });
      await sleep(900);
      assert.strictEqual(violations.length, 0, 'bez obcych bibliotek nadzór milczy');
      fs.writeFileSync(go, '1');
      await until(() => out.includes('loaded'), 'dlopen w procesie');
      const t0 = Date.now();
      await until(() => violations.length > 0, 'wykrycie wstrzykniętej biblioteki', 10000);
      watch.stop();
      const took = Date.now() - t0;
      const kill = violations.flatMap((v) => v.kill).map((m) => path.basename(m));
      const warn = violations.flatMap((v) => v.warn).map((m) => path.basename(m));
      assert.ok(kill.includes('cheat-hook.so'), `biblioteka z katalogu użytkownika → kill (kill=${kill}, warn=${warn})`);
      assert.ok(!kill.includes('overlay-copy.so'), 'biblioteka z /tmp nie zamyka gry');
      ok(`watchProcess na prawdziwym procesie: wstrzyknięta (dlopen) biblioteka z katalogu użytkownika wykryta po ${took} ms → kill`);

      // ta sama biblioteka oceniona wprost: katalog użytkownika = kill, /tmp = ostrzeżenie, a własność roota wystarcza tylko dla plików roota
      const cls = await anticheat.classifyModules([evilHome, evilTmp], { javaPath: '', rules: null });
      assert.deepStrictEqual(cls.kill.map((m) => path.basename(m)), ['cheat-hook.so']);
      assert.deepStrictEqual(cls.warn.map((m) => path.basename(m)), ['overlay-copy.so']);
      ok('classifyModules: kopia biblioteki w katalogu domowym = kill, w /tmp = ostrzeżenie (zawartość pliku nie ma znaczenia, liczy się miejsce)');
      if (!isRoot) {
        const trusted = await anticheat.signedModules([evilHome, sysLib], 'linux');
        assert.ok(!trusted.has(evilHome.toLowerCase()), 'kopia użytkownika nie jest zaufana');
        assert.ok(trusted.has(sysLib.toLowerCase()) || fs.statSync(sysLib).uid !== 0, 'biblioteka systemowa roota jest zaufana');
        ok('signedModules (Linux): kopia użytkownika niezaufana, biblioteka systemowa należąca do roota zaufana');
      }
    } finally {
      child.kill();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(tmpLibDir, { recursive: true, force: true });
    }
  }

  // ---- foldery wydarzenia: prawdziwy chmod ----
  if (isRoot) {
    console.log('(root omija uprawnienia plików - pomijam część z chmod)');
  } else {
    const mods = path.join(dataDir, 'ev', 'mods');
    fs.mkdirSync(path.join(mods, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'a.jar'), 'x');
    fs.writeFileSync(path.join(mods, 'sub', 'b.jar'), 'y');
    await hidden.setAccess([mods], 'sealed');
    assert.throws(() => fs.readdirSync(mods), /EACCES/, 'sealed: nie da się wejść do folderu');
    await hidden.setAccess([mods], 'readonly');
    assert.deepStrictEqual(fs.readdirSync(mods).sort(), ['a.jar', 'sub']);
    assert.throws(() => fs.writeFileSync(path.join(mods, 'nowy.jar'), 'z'), /EACCES/, 'readonly: nie da się dodać pliku');
    assert.throws(() => fs.writeFileSync(path.join(mods, 'a.jar'), 'podmiana'), /EACCES/, 'readonly: nie da się nadpisać pliku');
    assert.throws(() => fs.writeFileSync(path.join(mods, 'sub', 'b.jar'), 'podmiana'), /EACCES/, 'readonly: także w podfolderze');
    assert.strictEqual(fs.readFileSync(path.join(mods, 'a.jar'), 'utf8'), 'x', 'odczyt działa (gra musi czytać mody)');
    await hidden.setAccess([mods], 'open');
    fs.writeFileSync(path.join(mods, 'nowy.jar'), 'z');
    fs.writeFileSync(path.join(mods, 'a.jar'), 'ok');
    ok('hidden.setAccess na prawdziwych plikach: sealed blokuje wejście, readonly blokuje dodanie i nadpisanie (odczyt działa), open przywraca zapis');
  }

  // ---- środowisko prawdziwego procesu potomnego ----
  const env = anticheat.scrubEnv({ ...process.env, LD_PRELOAD: '/tmp/x.so', JAVA_TOOL_OPTIONS: '-javaagent:x.jar', MOJ_TOKEN: 'sekret', PATH: process.env.PATH });
  const printed = spawnSync('sh', ['-c', 'echo "[$LD_PRELOAD][$JAVA_TOOL_OPTIONS][$MOJ_TOKEN]"'], { env, encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(printed, '[][][]', 'proces potomny nie dostaje LD_PRELOAD, opcji Javy ani zmiennych z sekretami');
  ok('scrubEnv: prawdziwy proces potomny nie dziedziczy LD_PRELOAD, JAVA_TOOL_OPTIONS ani zmiennych z sekretami');

  // ---- ptrace_scope ----
  const note = await anticheat.linuxPtraceNote();
  console.log(`  (ptrace_scope na tym systemie: ${note ? 'ZERO - launcher ostrzeże' : 'bezpieczna wartość albo brak Yamy'})`);
  ok('linuxPtraceNote: odczyt /proc/sys/kernel/yama/ptrace_scope nie rzuca wyjątku');

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
