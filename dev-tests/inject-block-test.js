// Blokada wstrzykiwania kodu do procesu gry: DACL procesu (anticheat.hardenProcess) + nadzór bibliotek (watchProcess).
// Uruchomienie: node dev-tests/inject-block-test.js   (część z prawdziwym procesem działa tylko na Windows)
// Test NIC nie wstrzykuje: sprawdza, czy system odmawia dokładnie tych praw dostępu, od których zaczyna się każdy injector
// (OpenProcess z CREATE_THREAD / VM_OPERATION / VM_WRITE / DUP_HANDLE...), a prawa potrzebne launcherowi zostają.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFile } = require('child_process');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const CS =
  'using System; using System.Runtime.InteropServices; public static class ProbeProc { ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid); ' +
  '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }';
const MASKS = {
  // prawa, od których zaczynają się wstrzyknięcia i grzebanie w pamięci
  CREATE_THREAD: 0x2,
  VM_OPERATION: 0x8,
  VM_WRITE: 0x20,
  DUP_HANDLE: 0x40,
  CREATE_PROCESS: 0x80,
  SUSPEND_RESUME: 0x800,
  WRITE_DAC: 0x40000,
  WRITE_OWNER: 0x80000,
  CLASSIC_INJECTOR: 0x2 | 0x8 | 0x20 | 0x10 | 0x400, // CreateRemoteThread + VirtualAllocEx + WriteProcessMemory
  DEBUGGER_ALL_ACCESS: 0x1fffff, // DebugActiveProcess / pełna kontrola
  // prawa, które muszą zostać (nadzór launchera, Menedżer zadań, zamknięcie gry)
  QUERY_INFORMATION: 0x400,
  VM_READ: 0x10,
  TERMINATE: 0x1,
  QUERY_LIMITED_INFORMATION: 0x1000,
  SYNCHRONIZE: 0x100000,
  READ_CONTROL: 0x20000,
  QUERY_AND_READ: 0x410,
};
const DENIED = ['CREATE_THREAD', 'VM_OPERATION', 'VM_WRITE', 'DUP_HANDLE', 'CREATE_PROCESS', 'SUSPEND_RESUME', 'WRITE_DAC', 'WRITE_OWNER', 'CLASSIC_INJECTOR', 'DEBUGGER_ALL_ACCESS'];
const KEPT = ['QUERY_INFORMATION', 'VM_READ', 'TERMINATE', 'QUERY_LIMITED_INFORMATION', 'SYNCHRONIZE', 'READ_CONTROL', 'QUERY_AND_READ'];

// osobny proces PowerShell, jak zewnętrzny injector - każde prawo próbujemy otworzyć osobnym OpenProcess
function probe(pid) {
  const list = Object.entries(MASKS).map(([k, v]) => `'${k}'=${v}`).join('; ');
  const script =
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:PROBE_CS; " +
    `$m = [ordered]@{ ${list} }; ` +
    'foreach ($k in $m.Keys) { $h = [ProbeProc]::OpenProcess([uint32]$m[$k], $false, [uint32]$env:PROBE_PID); ' +
    '$e = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); ' +
    'if ($h -ne [IntPtr]::Zero) { [ProbeProc]::CloseHandle($h) | Out-Null; "$k=OK" } else { "$k=DENIED:$e" } }';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [...PS, script], { windowsHide: true, timeout: 30_000, env: { ...process.env, PROBE_CS: CS, PROBE_PID: String(pid) } }, (err, out, errout) => {
      if (err) return reject(new Error(String(errout || err.message)));
      const res = {};
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^(\w+)=(OK|DENIED:(\d+))$/.exec(line.trim());
        if (m) res[m[1]] = m[2] === 'OK' ? 'OK' : `DENIED:${m[3]}`;
      }
      resolve(res);
    });
  });
}

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-inject-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const paths = require(root + 'src/main/core/paths.js');
  const anticheat = require(root + 'src/main/core/anticheat.js');
  // reguły z „świeżego” cache - nadzór nie sięga do sieci
  fs.mkdirSync(paths.cache(), { recursive: true });
  fs.writeFileSync(path.join(paths.cache(), 'blocklist.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

  // ---- nadzór bibliotek (logika, bez prawdziwego procesu) ----
  assert.ok(!anticheat.trustedRoots('C:\\java\\bin\\java.exe').some((r) => /programdata/i.test(r)), 'ProgramData (zapisywalny przez użytkownika) nie jest zaufany');
  assert.ok(!anticheat.trustedRoots().some((r) => r.startsWith(path.resolve(paths.root()).toLowerCase() + path.sep)), 'folder danych launchera nie jest zaufany w całości');
  assert.ok(anticheat.trustedRoots('C:\\java\\bin\\java.exe', ['D:\\gra\\natives']).includes('d:\\gra\\natives\\'), 'katalog natywnych bibliotek podany przez launcher jest zaufany');
  ok('zaufane katalogi: bez ProgramData i bez całego folderu danych launchera, z katalogiem natywnych bibliotek instancji');

  const NAT = path.join(dataDir, 'instances', 'x', 'natives');
  const EVIL = 'C:\\ProgramData\\evil\\cheat.dll';
  const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll');
  const watch = (mods, { signedSet = new Set(), trustedDirs = [NAT], batches, names, intervalMs = 20 } = {}) =>
    new Promise((resolve) => {
      const seq = batches || [mods];
      let i = 0;
      const events = [];
      const w = anticheat.watchProcess({
        pid: 1,
        javaPath: 'C:\\Users\\x\\runtime\\jre\\bin\\java.exe',
        trustedDirs,
        firstDelayMs: 5,
        intervalMs,
        fastMs: 10,
        getNames: names || (async () => []),
        getModules: async () => seq[Math.min(i++, seq.length - 1)],
        signed: async (files) => new Set(files.filter((f) => signedSet.has(f.toLowerCase())).map((f) => f.toLowerCase())),
        onViolation: (v) => events.push(v),
      });
      setTimeout(() => {
        w.stop();
        resolve(events);
      }, 250);
    });

  // 1. wstrzyknięcie tuż po starcie (zanim nadzór zrobił „stan wyjściowy”) jest oceniane od razu
  let ev = await watch([SYS, path.join(NAT, 'lwjgl', 'lwjgl.dll'), EVIL]);
  assert.strictEqual(ev.length, 1, 'jedno naruszenie');
  assert.deepStrictEqual(ev[0].kill, [EVIL]);
  ok('niepodpisana biblioteka obecna już przy pierwszym przeglądzie (wstrzyknięta zaraz po starcie) kończy grę');
  // 2. własne natywne biblioteki gry i system nie budzą alarmu
  ev = await watch([SYS, path.join(NAT, 'lwjgl', 'lwjgl.dll'), path.join(NAT, 'jna', 'jna123.dll')]);
  assert.strictEqual(ev.length, 0);
  ok('system, środowisko Javy i natywne biblioteki instancji: bez alarmu');
  // 3. podpisana obca biblioteka (np. Defender) przechodzi, niepodpisana po starcie - nie
  const DEF = 'C:\\ProgramData\\Microsoft\\Windows Defender\\MpOav.dll';
  ev = await watch([SYS], { batches: [[SYS], [SYS, DEF], [SYS, DEF, EVIL]], signedSet: new Set([DEF.toLowerCase()]) });
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(ev[0].kill, [EVIL]);
  ok('nowa biblioteka z poprawnym podpisem przechodzi, nowa niepodpisana spoza zaufanych miejsc kończy grę');
  // 4. po wcześniejszym alarmie ta sama biblioteka nie jest zgłaszana w kółko
  ev = await watch([SYS], { batches: [[SYS], [SYS, EVIL], [SYS, EVIL], [SYS, EVIL]] });
  assert.strictEqual(ev.length, 1);
  ok('ta sama biblioteka jest zgłoszona raz');
  // 5. szybka ścieżka: pełny przegląd co 60 s, ale nowa NAZWA w tanim odczycie (co `fastMs`) wywołuje go od razu
  {
    let calls = 0;
    const base = ['ntdll.dll', 'kernel32.dll', 'jvm.dll'];
    const getNames = async () => (++calls > 6 ? [...base, 'evil.dll'] : base); // wstrzyknięcie po kilku odczytach
    const t0 = Date.now();
    let fullChecks = 0;
    const seq = [[SYS], [SYS, EVIL]];
    ev = await new Promise((resolve) => {
      const events = [];
      const w = anticheat.watchProcess({
        pid: 1,
        javaPath: 'C:\\Users\\x\\runtime\\jre\\bin\\java.exe',
        trustedDirs: [NAT],
        firstDelayMs: 5,
        intervalMs: 60_000,
        fastMs: 15,
        getNames,
        getModules: async () => seq[Math.min(fullChecks++, 1)],
        signed: async () => new Set(),
        onViolation: (v) => events.push({ ...v, after: Date.now() - t0 }),
      });
      setTimeout(() => {
        w.stop();
        resolve(events);
      }, 600);
    });
    assert.strictEqual(ev.length, 1, JSON.stringify(ev));
    assert.deepStrictEqual(ev[0].kill, [EVIL]);
    assert.ok(ev[0].after < 400, `alarm po ${ev[0].after} ms - szybka ścieżka nie czekała na pełny przegląd`);
    assert.strictEqual(fullChecks, 2, 'pełne przeglądy tylko dwa: stan wyjściowy i ten po nowej nazwie');
    ok(`nowa nazwa biblioteki w tanim odczycie wywołuje pełny przegląd od razu (alarm po ${ev[0].after} ms, nie po 60 s)`);
  }
  assert.strictEqual(anticheat.hasNewName(['a.dll', 'b.dll'], ['b.dll', 'a.dll']), false);
  assert.strictEqual(anticheat.hasNewName(['a.dll', 'a.dll'], ['a.dll']), true, 'druga kopia tej samej nazwy to też nowa biblioteka');
  assert.strictEqual(anticheat.hasNewName(['a.dll'], ['a.dll', 'b.dll']), false, 'zwolniona biblioteka nie jest alarmem');
  ok('porównanie nazw: nowa nazwa albo kolejna kopia = zmiana, zwolnienie biblioteki = nic');

  // 6. natywne biblioteki znanych modów w Temp (imgui-java, Simple Voice Chat) nie dają „Nieznanej biblioteki w grze”
  {
    const T = os.tmpdir();
    const known = [
      path.join(T, 'imgui-java-natives', '1.90.0', 'imgui-moulberry90-java64.dll'),
      path.join(T, 'liblame4j-290c3436fe9f7c2b8e165ddcb5ad66ce', 'liblame4j.dll'),
      path.join(T, 'libopus4j-9783d0e001158567d1e08f6bb3b2c5b5', 'libopus4j.dll'),
      path.join(T, 'librnnoise4j-40cc1fdd40ca1100a850ddee14466799', 'librnnoise4j.dll'),
      path.join(T, 'libspeex4j-e39751f08962f3611e66c90baf107894', 'libspeex4j.dll'),
    ];
    const foreign = [
      path.join(T, 'evil', 'cheat.dll'),
      path.join(T, 'imgui-java-natives', '1.90.0', 'cheat.dll'), // dobry katalog, zła nazwa pliku
      path.join(T, 'libopus4j-9783d0e001158567d1e08f6bb3b2c5b5', 'cheat.dll'),
      path.join(T, 'libopus4j-zly', 'libopus4j.dll'), // zła suma w nazwie katalogu
    ];
    const res = await anticheat.classifyModules([...known, ...foreign], { javaPath: 'C:\\Users\\x\\runtime\\jre\\bin\\java.exe', signed: async () => new Set(), rules: null });
    assert.deepStrictEqual(res.kill, [], 'Temp nigdy nie kończy gry');
    assert.deepStrictEqual(res.warn, foreign, `ostrzeżenia tylko dla obcych: ${JSON.stringify(res.warn)}`);
    ok('znane natywne biblioteki modów w Temp (imgui-java, głos) nie dają ostrzeżenia, a obce pliki w tych samych katalogach nadal tak');
  }

  if (process.platform !== 'win32') {
    console.log('(pomijam część z prawdziwym procesem - tylko Windows)');
    console.log(`WSZYSTKO OK (${n})`);
    return;
  }

  // ---- blokada dostępu do prawdziwego procesu ----
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  await sleep(600);
  try {
    // kontrola: bez blokady te same próby się udają - więc test faktycznie coś mierzy
    const before = await probe(child.pid);
    for (const k of Object.keys(MASKS)) assert.strictEqual(before[k], 'OK', `przed blokadą ${k} powinno się udać (jest: ${before[k]})`);
    ok('kontrola: przed blokadą zwykły program dostaje wszystkie prawa (w tym te, których potrzebuje injector)');

    const t0 = Date.now();
    const res = await anticheat.hardenProcess(child.pid);
    assert.deepStrictEqual(res, { ok: true }, `hardenProcess: ${JSON.stringify(res)}`);
    ok(`hardenProcess zakłada blokadę na procesie (${Date.now() - t0} ms)`);

    const after = await probe(child.pid);
    for (const k of DENIED) assert.strictEqual(after[k], 'DENIED:5', `po blokadzie ${k} ma być odmowa (jest: ${after[k]})`);
    ok('po blokadzie system odmawia (ACCESS_DENIED): tworzenia wątków, zapisu/operacji na pamięci, duplikowania uchwytów, zawieszania, zmiany DACL/właściciela, pełnej kontroli, klasycznego zestawu injectora');
    for (const k of KEPT) assert.strictEqual(after[k], 'OK', `po blokadzie ${k} ma zostać (jest: ${after[k]})`);
    ok('prawa potrzebne launcherowi zostają: zapytanie, odczyt, zamknięcie, oczekiwanie');

    // nadzór bibliotek nadal widzi procesy (Get-Process.Modules: QUERY_INFORMATION + VM_READ)
    const mods = await anticheat.modulesOf(child.pid);
    assert.ok(mods.length > 5 && mods.some((m) => /ntdll\.dll$/i.test(m)), `modulesOf po blokadzie: ${mods.length}`);
    ok(`nadzór bibliotek działa na zabezpieczonym procesie (${mods.length} modułów)`);

    // DACL jest zamknięty także dla launchera: nikt (ani injector, ani my) nie zmieni go po nałożeniu (WRITE_DAC odebrane)
    const again = await anticheat.hardenProcess(child.pid);
    assert.strictEqual(again.ok, false);
    assert.match(again.message, /OpenProcess 5/, `ponowna zmiana DACL ma być odrzucona: ${again.message}`);
    ok('po nałożeniu nikt nie zmieni blokady (WRITE_DAC odebrane także właścicielowi i launcherowi)');
  } catch (e) {
    child.kill();
    throw e;
  }
  // launcher nadal kończy grę (uchwyt z CreateProcess nie podlega DACL-owi)
  child.kill();
  const ex = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
  assert.notStrictEqual(ex, 'timeout', 'child.kill() kończy zabezpieczony proces');
  ok('launcher nadal zamyka zabezpieczony proces (child.kill)');

  // ---- prawdziwa JVM: blokada nie może jej psuć (wątki, GC, JMX, pliki) ----
  const javaHome = (() => {
    const pf = 'C:\\Program Files\\Java';
    try {
      for (const d of fs.readdirSync(pf)) if (fs.existsSync(path.join(pf, d, 'bin', 'javac.exe'))) return path.join(pf, d);
    } catch {
      /* brak JDK */
    }
    return '';
  })();
  if (!javaHome) {
    console.log('--  pominięto test z prawdziwą JVM (brak JDK z javac w C:\\Program Files\\Java)');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jvm-'));
    const go = path.join(work, 'go');
    fs.writeFileSync(
      path.join(work, 'Work.java'),
      `import java.lang.management.*; import java.util.*; import java.util.concurrent.*; import java.nio.file.*;
public class Work { static volatile long sink;
  public static void main(String[] a) throws Exception {
    Path flag = Paths.get(a[0]); long t0 = System.currentTimeMillis();
    while (!Files.exists(flag) && System.currentTimeMillis() - t0 < 60000) Thread.sleep(50);
    ExecutorService ex = Executors.newFixedThreadPool(4); List<Future<Long>> fs = new ArrayList<>();
    for (int t = 0; t < 4; t++) fs.add(ex.submit(() -> { long s = 0; List<byte[]> keep = new ArrayList<>(); for (int i = 0; i < 4_000_000; i++) { s += i % 7; if (i % 40000 == 0) keep.add(new byte[64 * 1024]); } return s + keep.size(); }));
    for (Future<Long> f : fs) sink += f.get(); ex.shutdown(); System.gc();
    String load = "n/a"; try { load = String.valueOf(((com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean()).getProcessCpuLoad()); } catch (Throwable e) { load = "err:" + e; }
    Path p = Files.createTempFile("crown", ".tmp"); Files.writeString(p, "x".repeat(100000)); Files.delete(p);
    System.out.println("JVM-OK pid=" + ProcessHandle.current().pid() + " heap=" + ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() + " load=" + load + " sink=" + sink);
  } }`,
    );
    const { execFileSync } = require('child_process');
    execFileSync(path.join(javaHome, 'bin', 'javac.exe'), ['--release', '21', '-d', work, path.join(work, 'Work.java')]);
    // ta sama Java co w grze (runtime z Mojang), jeśli jest na tym komputerze; inaczej JDK
    const gameJava = (() => {
      try {
        const rt = path.join(process.env.APPDATA || '', 'CrownLauncher', 'runtime');
        for (const d of fs.readdirSync(rt)) if (fs.existsSync(path.join(rt, d, 'bin', 'java.exe'))) return path.join(rt, d, 'bin', 'java.exe');
      } catch {
        /* brak */
      }
      return '';
    })();
    const java = gameJava || path.join(javaHome, 'bin', 'java.exe');
    const jvm = spawn(java, [...anticheat.HARDENING_FLAGS, '-Xmx256M', '-cp', work, 'Work', go], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let jout = '';
    jvm.stdout.on('data', (b) => (jout += b));
    jvm.stderr.on('data', (b) => (jout += b));
    const jexit = new Promise((r) => jvm.on('exit', (code) => r(code)));
    try {
      const hres = await anticheat.hardenProcess(jvm.pid); // tak samo jak game.js: zaraz po starcie
      assert.deepStrictEqual(hres, { ok: true }, JSON.stringify(hres));
      const jp = await probe(jvm.pid);
      for (const k of DENIED) assert.strictEqual(jp[k], 'DENIED:5', `JVM: ${k} ma być odmowa (jest: ${jp[k]})`);
      for (const k of KEPT) assert.strictEqual(jp[k], 'OK', `JVM: ${k} ma zostać (jest: ${jp[k]})`);
      const jmods = await anticheat.modulesOf(jvm.pid);
      assert.ok(jmods.some((m) => /[\\/]jvm\.dll$/i.test(m)), 'nadzór widzi jvm.dll w zabezpieczonej JVM');
      ok(`prawdziwa JVM (${path.basename(path.dirname(path.dirname(java)))}, flagi z launchera): odmowa praw injectora, odczyt i nadzór bibliotek działają (${jmods.length} modułów)`);
      fs.writeFileSync(go, '1'); // dopiero teraz JVM zaczyna pracować - cała robota dzieje się już pod blokadą
      const code = await Promise.race([jexit, sleep(60_000).then(() => 'timeout')]);
      assert.strictEqual(code, 0, `JVM pod blokadą miała zakończyć pracę (kod: ${code}, wyjście: ${jout})`);
      assert.match(jout, /JVM-OK pid=\d+/, jout);
      ok(`prawdziwa JVM pod blokadą normalnie pracuje: wątki, GC, JMX, pliki (${jout.trim().replace(/\s+/g, ' ')})`);
    } finally {
      jvm.kill();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // zły identyfikator: bez wyjątku, z czytelnym błędem
  const bad = await anticheat.hardenProcess(2147483000);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.message && !/undefined/.test(bad.message), bad.message);
  assert.deepStrictEqual(await anticheat.hardenProcess(0), { ok: false, message: 'brak identyfikatora procesu' });
  ok(`nieistniejący proces: ok=false, komunikat „${bad.message}”, bez wyjątku`);

  console.log(`WSZYSTKO OK (${n})`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
