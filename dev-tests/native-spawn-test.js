// Natywny start gry (native-spawn.js + src/main/native/CrownSpawn.cs): proces powstaje z blokadą wstrzykiwania od pierwszej chwili.
// Uruchomienie: node dev-tests/native-spawn-test.js   (tylko Windows; kompilacja pomocnika wbudowanym csc.exe)
// Test NIC nie wstrzykuje do cudzych procesów. Haki okien sprawdzamy na własnym, atrapowym procesie z pętlą komunikatów
// i celowanym hakiem (SetWindowsHookEx z docelowym wątkiem) z biblioteką, której sami podpisu pozbawiamy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFile, execFileSync } = require('child_process');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`czas minął: ${what}`); })]);

if (process.platform !== 'win32') {
  console.log('(tylko Windows - pomijam)');
  process.exit(0);
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const ps = (script, env) =>
  new Promise((resolve) =>
    execFile('powershell.exe', [...PS, script], { windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } }, (e, o, er) =>
      resolve(`${o}`.trim() + (e ? ` ${er || e.message}` : '')),
    ),
  );

// ---- sonda praw dostępu do procesu (jak zewnętrzny injector, osobny proces) ----
const PROBE_CS =
  'using System; using System.Runtime.InteropServices; public static class ProbeProc { ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid); ' +
  '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }';
const MASKS = {
  CREATE_THREAD: 0x2, VM_OPERATION: 0x8, VM_WRITE: 0x20, DUP_HANDLE: 0x40, CREATE_PROCESS: 0x80, SUSPEND_RESUME: 0x800,
  WRITE_DAC: 0x40000, WRITE_OWNER: 0x80000, CLASSIC_INJECTOR: 0x2 | 0x8 | 0x20 | 0x10 | 0x400, DEBUGGER_ALL_ACCESS: 0x1fffff,
  QUERY_INFORMATION: 0x400, VM_READ: 0x10, TERMINATE: 0x1, QUERY_LIMITED_INFORMATION: 0x1000, SYNCHRONIZE: 0x100000, READ_CONTROL: 0x20000,
};
const DENIED = ['CREATE_THREAD', 'VM_OPERATION', 'VM_WRITE', 'DUP_HANDLE', 'CREATE_PROCESS', 'SUSPEND_RESUME', 'WRITE_DAC', 'WRITE_OWNER', 'CLASSIC_INJECTOR', 'DEBUGGER_ALL_ACCESS'];
const KEPT = ['QUERY_INFORMATION', 'VM_READ', 'TERMINATE', 'QUERY_LIMITED_INFORMATION', 'SYNCHRONIZE', 'READ_CONTROL'];
async function probe(pid) {
  const list = Object.entries(MASKS).map(([k, v]) => `'${k}'=${v}`).join('; ');
  const out = await ps(
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:PROBE_CS; " +
      `$m = [ordered]@{ ${list} }; ` +
      'foreach ($k in $m.Keys) { $h = [ProbeProc]::OpenProcess([uint32]$m[$k], $false, [uint32]$env:PROBE_PID); $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); ' +
      'if ($h -ne [IntPtr]::Zero) { [ProbeProc]::CloseHandle($h) | Out-Null; "$k=OK" } else { "$k=DENIED:$e" } }',
    { PROBE_CS, PROBE_PID: String(pid) },
  );
  const res = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\w+)=(OK|DENIED:(\d+))$/.exec(line.trim());
    if (m) res[m[1]] = m[2] === 'OK' ? 'OK' : `DENIED:${m[3]}`;
  }
  return res;
}
// mitygacja procesu odczytana z ZEWNĄTRZ (nie z raportu pomocnika)
const MIT_CS =
  'using System; using System.Runtime.InteropServices; public static class MitProc { ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid); ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessMitigationPolicy(IntPtr h, int p, IntPtr buf, IntPtr len); }';
async function extensionPointsDisabled(pid) {
  const out = await ps(
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:MIT_CS; $h = [MitProc]::OpenProcess(0x400, $false, [uint32]$env:T_PID); " +
      '$b = [Runtime.InteropServices.Marshal]::AllocHGlobal(4); [Runtime.InteropServices.Marshal]::WriteInt32($b, 0); ' +
      '$ok = [MitProc]::GetProcessMitigationPolicy($h, 6, $b, [IntPtr]4); "OK=" + $ok + " EXT=" + ([Runtime.InteropServices.Marshal]::ReadInt32($b) -band 1)',
    { MIT_CS, T_PID: String(pid) },
  );
  const m = /OK=True EXT=(\d)/.exec(out);
  assert.ok(m, `odczyt mitygacji: ${out}`);
  return m[1] === '1';
}

const collect = (child) => {
  const chunks = [];
  child.stdout.on('data', (b) => chunks.push(b));
  return () => Buffer.concat(chunks).toString('utf8');
};
const closed = (child) => new Promise((resolve) => child.on('close', (code) => resolve(code)));

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-native-'));
  const paths = require(root + 'src/main/core/paths.js');
  paths.init(dataDir);
  const nativeSpawn = require(root + 'src/main/core/native-spawn.js');
  const anticheat = require(root + 'src/main/core/anticheat.js');
  const launch = require(root + 'src/main/core/launch.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-native-work-'));
  const node = process.execPath;
  const toKill = [];
  const hookDirs = [];

  try {
    // ---- pomocnik ----
    let t0 = Date.now();
    const helper = await nativeSpawn.ensureHelper();
    assert.ok(helper && fs.existsSync(helper), `pomocnik: ${helper}`);
    const compileMs = Date.now() - t0;
    t0 = Date.now();
    assert.strictEqual(await nativeSpawn.ensureHelper(), helper);
    ok(`pomocnik CrownSpawn skompilowany wbudowanym csc.exe (${compileMs} ms, ${fs.statSync(helper).size} B), kolejne wywołanie z pamięci (${Date.now() - t0} ms)`);
    // każdy start launchera kompiluje pomocnika od nowa pod losową nazwą, a poprzedni plik znika
    nativeSpawn._reset();
    const helper2 = await nativeSpawn.ensureHelper();
    assert.ok(helper2 && helper2 !== helper, 'nowa, losowa nazwa pomocnika');
    assert.ok(!fs.existsSync(helper), 'poprzedni plik pomocnika usunięty');
    assert.strictEqual(fs.readdirSync(paths.cache()).filter((f) => /^CrownSpawn-/.test(f)).length, 1, 'w cache zostaje jeden pomocnik');
    ok('każde uruchomienie launchera kompiluje pomocnika od nowa pod losową nazwą (gotowego pliku do podmiany nie ma), stary znika');
    // podmiana pliku pomocnika w trakcie pracy launchera: start natywny odmawia (skrót SHA-256 z pamięci), gra poleci zapasową drogą
    fs.appendFileSync(helper2, Buffer.from([0]));
    assert.strictEqual(await nativeSpawn.start({ file: process.execPath, args: ['-e', '0'], cwd: os.tmpdir(), env: process.env }), null, 'podmieniony pomocnik nie jest uruchamiany');
    nativeSpawn._reset();
    assert.ok(await nativeSpawn.ensureHelper(), 'po ponownej kompilacji znów działa');
    ok('podmieniony plik pomocnika (inny skrót niż skompilowany) nie jest uruchamiany - start zapasowy; po restarcie launchera znów jest dobry');

    // ---- wejście/wyjście, argumenty, środowisko, katalog, kod zakończenia ----
    const script = path.join(work, 'game.js');
    fs.writeFileSync(
      script,
      "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));" +
        "console.log('ENV ' + JSON.stringify([process.env.CROWN_TEST_VAR, process.env.CROWN_PARENT_ONLY || null]));" +
        "console.log('CWD ' + process.cwd());" +
        "console.error('NA-STDERR zażółć gęślą jaźń');" +
        "process.exitCode = 7;",
    );
    process.env.CROWN_PARENT_ONLY = 'nie-przekazywane';
    const weird = ['zwykły', 'ze spacją i "cudzysłowem"', 'koniec\\', 'ścieżka C:\\Program Files\\gra\\', '', 'ąęłóżźćń 🎮', '--accessToken=eyJ.abc.def'];
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crown cwd ąę-'));
    const env = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, CROWN_TEST_VAR: 'wartość ze spacją' };
    let child = await nativeSpawn.start({ file: node, args: [script, ...weird], cwd, env });
    assert.ok(child, 'start natywny');
    const out1 = collect(child);
    const code1 = await withTimeout(closed(child), 20_000, 'zamknięcie gry testowej');
    const text = out1();
    assert.strictEqual(code1, 7, `kod zakończenia: ${code1}`);
    assert.deepStrictEqual(JSON.parse(/^ARGS (.*)$/m.exec(text)[1]), weird, 'argumenty (spacje, cudzysłowy, ukośniki, pusty, unicode) bez zmian');
    assert.deepStrictEqual(JSON.parse(/^ENV (.*)$/m.exec(text)[1]), ['wartość ze spacją', null], 'środowisko tylko takie, jak podano');
    assert.strictEqual(/^CWD (.*)$/m.exec(text)[1].toLowerCase(), fs.realpathSync.native(cwd).toLowerCase(), 'katalog roboczy');
    assert.match(text, /NA-STDERR zażółć gęślą jaźń/, 'stderr gry idzie tym samym strumieniem, z polskimi znakami');
    ok('start natywny: argumenty bez zmian (też spacje, cudzysłowy, ukośniki, pusty, unicode), środowisko tylko podane, katalog roboczy, stdout+stderr z UTF-8, kod zakończenia 7');
    delete process.env.CROWN_PARENT_ONLY;

    // ---- blokada od pierwszej chwili + mitygacja, sprawdzone z zewnątrz ----
    const sleeper = path.join(work, 'sleeper.js');
    fs.writeFileSync(sleeper, "console.log('READY'); setInterval(() => {}, 1000);");
    child = await nativeSpawn.start({ file: node, args: [sleeper], cwd: work, env: process.env });
    toKill.push(child);
    const out2 = collect(child);
    assert.strictEqual(child.crownGuard, true, 'pomocnik sam sprawdził: obcy proces nie dostaje praw injectora do nowej gry');
    assert.strictEqual(child.crownExt, true, 'mitygacja „extension point disable” aktywna (raport pomocnika)');
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    const rights = await probe(child.pid);
    for (const k of DENIED) assert.strictEqual(rights[k], 'DENIED:5', `natywny start: ${k} ma być odmowa (jest: ${rights[k]})`);
    for (const k of KEPT) assert.strictEqual(rights[k], 'OK', `natywny start: ${k} ma zostać (jest: ${rights[k]})`);
    ok('proces gry z natywnego startu: odmowa praw injectora (obcy proces), zostają odczyt/zapytanie/zamknięcie');
    assert.strictEqual(await extensionPointsDisabled(child.pid), true, 'mitygacja odczytana z obcego procesu');
    ok('mitygacja „extension point disable” (globalne haki okien, AppInit_DLLs) potwierdzona z zewnątrz');
    const again = await anticheat.hardenProcess(child.pid);
    assert.strictEqual(again.ok, false, 'blokady nie da się zmienić po starcie');
    ok('po natywnym starcie nikt (także launcher) nie zmieni listy praw procesu');
    assert.ok((await anticheat.modulesOf(child.pid)).length > 5, 'przegląd przez PowerShell widzi proces');
    for (let i = 0; i < 30 && !(await child.getNames()).includes('ntdll.dll'); i++) await sleep(100);
    const seenNames = await child.getNames();
    assert.ok(seenNames.includes('ntdll.dll') && seenNames.includes('kernel32.dll'), `pomocnik wylicza biblioteki gry: ${seenNames.length}`);
    assert.ok((await child.getModules()).every((m) => path.isAbsolute(m)), 'pełne ścieżki');
    // zwykłe narzędzia (tasklist) nie widzą modułów zabezpieczonego procesu - dlatego bibliotek pilnuje pomocnik z pełnym uchwytem
    ok(`nadzór bibliotek widzi zabezpieczony proces: przegląd PowerShellem i szybki odczyt z pomocnika (${seenNames.length} modułów)`);
    // kill: pomocnik + TerminateProcess
    t0 = Date.now();
    const exit2 = closed(child);
    child.kill();
    const code2 = await withTimeout(exit2, 10_000, 'kill');
    assert.notStrictEqual(code2, undefined);
    assert.match(out2(), /READY/);
    ok(`child.kill() kończy zabezpieczoną grę (${Date.now() - t0} ms, kod ${code2})`);

    // ---- duże wyjście: pomocnik nie blokuje gry i niczego nie gubi ----
    const loud = path.join(work, 'loud.js');
    fs.writeFileSync(loud, "const line = 'x'.repeat(199) + '\\n'; let i = 0; (function w() { while (i < 40000) { i++; if (!process.stdout.write(line)) return process.stdout.once('drain', w); } console.log('KONIEC'); })();");
    child = await nativeSpawn.start({ file: node, args: [loud], cwd: work, env: process.env });
    const out3 = collect(child);
    const code3 = await withTimeout(closed(child), 60_000, 'duże wyjście');
    const big = out3();
    assert.strictEqual(code3, 0);
    assert.strictEqual(big.split('\n').filter((l) => l.startsWith('xxxx')).length, 40000, 'wszystkie linie dotarły');
    assert.match(big, /KONIEC\s*$/);
    ok(`duże wyjście (${(big.length / 1e6).toFixed(1)} MB) przechodzi bez utraty linii i bez zablokowania gry`);

    // ---- prawdziwa JVM ze środowiska gry, flagi launchera ----
    const javaHome = (() => {
      const pf = 'C:\\Program Files\\Java';
      try {
        for (const d of fs.readdirSync(pf)) if (fs.existsSync(path.join(pf, d, 'bin', 'javac.exe'))) return path.join(pf, d);
      } catch { /* brak JDK */ }
      return '';
    })();
    if (!javaHome) {
      console.log('--  pominięto test z prawdziwą JVM (brak JDK z javac w C:\\Program Files\\Java)');
    } else {
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
    System.out.println("JVM-OK pid=" + ProcessHandle.current().pid() + " load=" + load + " sink=" + sink);
    System.err.println("JVM-STDERR-OK");
  } }`,
      );
      execFileSync(path.join(javaHome, 'bin', 'javac.exe'), ['--release', '21', '-d', work, path.join(work, 'Work.java')]);
      const gameJava = (() => {
        try {
          const rt = path.join(process.env.APPDATA || '', 'CrownLauncher', 'runtime');
          for (const d of fs.readdirSync(rt)) if (fs.existsSync(path.join(rt, d, 'bin', 'java.exe'))) return path.join(rt, d, 'bin', 'java.exe');
        } catch { /* brak */ }
        return '';
      })();
      const java = gameJava || path.join(javaHome, 'bin', 'java.exe');
      // przez launch.run - tak samo jak gra (natywny start, strumienie, kod zakończenia)
      const lines = [];
      const exitP = new Promise((resolve) => {
        launch.run(
          { javaPath: java, args: [...anticheat.HARDENING_FLAGS, '-Xmx256M', '-cp', work, 'Work', go], cwd: work, secrets: [] },
          { onLine: (l) => lines.push(l), onExit: resolve },
        ).then((c) => {
          global.__jvmChild = c;
        });
      });
      for (let i = 0; i < 100 && !global.__jvmChild; i++) await sleep(100);
      const jchild = global.__jvmChild;
      assert.ok(jchild && jchild.crownGuard === true && jchild.crownExt === true, 'JVM wystartowała natywnie, zabezpieczona');
      toKill.push(jchild);
      const jr = await probe(jchild.pid);
      for (const k of DENIED) assert.strictEqual(jr[k], 'DENIED:5', `JVM: ${k} (jest: ${jr[k]})`);
      for (const k of KEPT) assert.strictEqual(jr[k], 'OK', `JVM: ${k} (jest: ${jr[k]})`);
      assert.ok((await anticheat.modulesOf(jchild.pid)).some((m) => /[\\/]jvm\.dll$/i.test(m)));
      fs.writeFileSync(go, '1');
      const jcode = await withTimeout(exitP, 60_000, 'JVM pod blokadą');
      assert.strictEqual(jcode, 0, `JVM: kod ${jcode}, wyjście: ${lines.join(' | ')}`);
      assert.ok(lines.some((l) => /^JVM-OK pid=\d+/.test(l)) && lines.includes('JVM-STDERR-OK'), lines.join(' | '));
      ok(`prawdziwa JVM (${path.basename(path.dirname(path.dirname(java)))}) przez launch.run: natywny start, odmowa praw injectora, wątki/GC/JMX/pliki działają, stdout i stderr dotarły, kod 0`);
      global.__jvmChild = null;
    }

    // ---- sterownik karty graficznej pod blokadą: OpenGL i Vulkan inicjują się tak samo jak przy zwykłym starcie ----
    // (gra ładuje sterownik GPU we własnym procesie - to główne ryzyko mitygacji i listy praw dostępu)
    const gpuCs = `using System; using System.Runtime.InteropServices; using System.Text;
class Gpu {
  [StructLayout(LayoutKind.Sequential)] struct PFD { public ushort nSize, nVersion; public uint dwFlags; public byte iPixelType, cColorBits, cRedBits, cRedShift, cGreenBits, cGreenShift, cBlueBits, cBlueShift, cAlphaBits, cAlphaShift, cAccumBits, cAccumRedBits, cAccumGreenBits, cAccumBlueBits, cAccumAlphaBits, cDepthBits, cStencilBits, cAuxBuffers, iLayerType, bReserved; public uint dwLayerMask, dwVisibleMask, dwDamageMask; }
  [StructLayout(LayoutKind.Sequential)] struct VkInstanceCreateInfo { public int sType; public IntPtr pNext; public uint flags; public IntPtr pApplicationInfo; public uint enabledLayerCount; public IntPtr ppEnabledLayerNames; public uint enabledExtensionCount; public IntPtr ppEnabledExtensionNames; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(int ex, string cls, string title, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
  [DllImport("gdi32.dll")] static extern int ChoosePixelFormat(IntPtr dc, ref PFD pfd);
  [DllImport("gdi32.dll")] static extern bool SetPixelFormat(IntPtr dc, int fmt, ref PFD pfd);
  [DllImport("gdi32.dll")] static extern bool SwapBuffers(IntPtr dc);
  [DllImport("opengl32.dll")] static extern IntPtr wglCreateContext(IntPtr dc);
  [DllImport("opengl32.dll")] static extern bool wglMakeCurrent(IntPtr dc, IntPtr rc);
  [DllImport("opengl32.dll")] static extern IntPtr glGetString(uint name);
  [DllImport("vulkan-1.dll")] static extern int vkCreateInstance(ref VkInstanceCreateInfo ci, IntPtr alloc, out IntPtr inst);
  [DllImport("vulkan-1.dll")] static extern int vkEnumeratePhysicalDevices(IntPtr inst, ref uint count, IntPtr devs);
  [DllImport("vulkan-1.dll")] static extern void vkGetPhysicalDeviceProperties(IntPtr dev, IntPtr props);
  static void Main() {
    try {
      IntPtr w = CreateWindowExW(0, "STATIC", "gl", 0, 0, 0, 64, 64, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      IntPtr dc = GetDC(w);
      PFD p = new PFD(); p.nSize = (ushort)Marshal.SizeOf(typeof(PFD)); p.nVersion = 1; p.dwFlags = 4 | 0x20 | 1; p.cColorBits = 32; p.cDepthBits = 24;
      int f = ChoosePixelFormat(dc, ref p); SetPixelFormat(dc, f, ref p);
      IntPtr rc = wglCreateContext(dc); bool cur = wglMakeCurrent(dc, rc);
      string r = cur ? Marshal.PtrToStringAnsi(glGetString(0x1F01)) : "brak-kontekstu";
      for (int i = 0; i < 5; i++) SwapBuffers(dc);
      Console.WriteLine("GL=" + r);
    } catch (Exception e) { Console.WriteLine("GL=wyjatek:" + e.GetType().Name); }
    try {
      VkInstanceCreateInfo ci = new VkInstanceCreateInfo(); ci.sType = 1; IntPtr inst;
      int res = vkCreateInstance(ref ci, IntPtr.Zero, out inst);
      uint n = 0; vkEnumeratePhysicalDevices(inst, ref n, IntPtr.Zero);
      string names = "";
      if (n > 0) { IntPtr devs = Marshal.AllocHGlobal(IntPtr.Size * (int)n); vkEnumeratePhysicalDevices(inst, ref n, devs); IntPtr props = Marshal.AllocHGlobal(2048);
        for (int i = 0; i < n; i++) { vkGetPhysicalDeviceProperties(Marshal.ReadIntPtr(devs, i * IntPtr.Size), props); names += (i > 0 ? "," : "") + Marshal.PtrToStringAnsi(IntPtr.Add(props, 20)); } }
      Console.WriteLine("VK=" + res + ":" + n + ":" + names);
    } catch (Exception e) { Console.WriteLine("VK=" + e.GetType().Name); }
  }
}`;
    fs.writeFileSync(path.join(work, 'Gpu.cs'), gpuCs);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['-nologo', '-target:exe', '-platform:anycpu', `-out:${path.join(work, 'Gpu.exe')}`, path.join(work, 'Gpu.cs')]);
    const gpuRun = async (native) => {
      if (native) {
        const c = await nativeSpawn.start({ file: path.join(work, 'Gpu.exe'), args: [], cwd: work, env: process.env });
        assert.ok(c && c.crownGuard && c.crownExt);
        const o = collect(c);
        await withTimeout(closed(c), 60_000, 'sonda GPU (natywnie)');
        return o();
      }
      const c = spawn(path.join(work, 'Gpu.exe'), [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const o = collect(c);
      await withTimeout(closed(c), 60_000, 'sonda GPU (zwykle)');
      return o();
    };
    const gpuPlain = await gpuRun(false);
    const gpuNative = await gpuRun(true);
    const glPlain = /GL=(.*)/.exec(gpuPlain)?.[1]?.trim();
    const vkPlain = /VK=(.*)/.exec(gpuPlain)?.[1]?.trim();
    if (!glPlain || /brak-kontekstu|wyjatek/.test(glPlain)) {
      console.log(`--  pominięto porównanie GPU: nawet zwykły start nie dostał kontekstu OpenGL (${gpuPlain.trim()})`);
    } else {
      assert.strictEqual(/GL=(.*)/.exec(gpuNative)?.[1]?.trim(), glPlain, `OpenGL pod blokadą: ${gpuNative}`);
      assert.strictEqual(/VK=(.*)/.exec(gpuNative)?.[1]?.trim(), vkPlain, `Vulkan pod blokadą: ${gpuNative}`);
      ok(`sterownik GPU pod blokadą (lista praw + mitygacja): OpenGL „${glPlain}” i Vulkan „${vkPlain}” inicjują się tak samo jak przy zwykłym starcie`);
    }

    // ---- haki okien: co blokuje blokada, a co łapie nadzór ----
    const dummyCs = `using System; using System.Runtime.InteropServices;
class Dummy {
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static void Main() { MSG m; PeekMessage(out m, IntPtr.Zero, 0, 0, 0); Console.WriteLine("READY " + GetCurrentThreadId()); Console.Out.Flush(); while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { } }
}`;
    fs.writeFileSync(path.join(work, 'Dummy.cs'), dummyCs);
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    execFileSync(csc, ['-nologo', '-target:exe', '-platform:anycpu', `-out:${path.join(work, 'Dummy.exe')}`, path.join(work, 'Dummy.cs')]);
    const dummy = path.join(work, 'Dummy.exe');
    // biblioteka bez podpisu: kopia systemowej winmm.dll z jednym zmienionym bajtem w nagłówku DOS (loader tego nie sprawdza,
    // podpis katalogowy przestaje pasować do sumy pliku) - eksportuje timeGetTime(), czyli procedurę haka, która nic nie robi
    const hookDir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA || os.homedir(), 'crown-inject-test-'));
    hookDirs.push(hookDir);
    const hookDll = path.join(hookDir, 'crowntest-hook.dll');
    const raw = fs.readFileSync(path.join(process.env.SystemRoot, 'System32', 'winmm.dll'));
    raw[0x4e] = raw[0x4e] ^ 0x01; // tekst „This program cannot be run in DOS mode” - bez znaczenia dla loadera
    fs.writeFileSync(hookDll, raw);
    const sigStatus = await ps("(Get-AuthenticodeSignature -LiteralPath $env:F).Status", { F: hookDll });
    assert.notStrictEqual(sigStatus, 'Valid', `atrapa biblioteki ma NIE mieć ważnego podpisu (jest: ${sigStatus})`);

    const HOOK_CS =
      'using System; using System.Runtime.InteropServices; public static class HookProc { ' +
      '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryW(string n); ' +
      '[DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] public static extern IntPtr GetProcAddress(IntPtr m, string n); ' +
      '[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowsHookExW(int id, IntPtr p, IntPtr m, uint tid); ' +
      '[DllImport("user32.dll", SetLastError=true)] public static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l); ' +
      '[DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h); }';
    const hookInto = (pid, tid) =>
      ps(
        "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:HOOK_CS; " +
          '$mod = [HookProc]::LoadLibraryW($env:HOOK_DLL); $p = [HookProc]::GetProcAddress($mod, "timeGetTime"); ' +
          '$hook = [HookProc]::SetWindowsHookExW(3, $p, $mod, [uint32]$env:T_TID); ' + // WH_GETMESSAGE celowany w wątek gry
          'for ($i = 0; $i -lt 8; $i++) { [HookProc]::PostThreadMessageW([uint32]$env:T_TID, 0x400, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 150 } ' +
          '"HOOK=" + $hook.ToInt64(); Start-Sleep -Seconds 1; if ($hook -ne [IntPtr]::Zero) { [HookProc]::UnhookWindowsHookEx($hook) | Out-Null }',
        { HOOK_CS, HOOK_DLL: hookDll, T_PID: String(pid), T_TID: String(tid) },
      );
    const loaded = async (pid) => (await anticheat.modulesOf(pid)).some((m) => /crowntest-hook\.dll$/i.test(m));
    const readyTid = (c) =>
      withTimeout(
        new Promise((resolve) => {
          let b = '';
          c.stdout.on('data', (x) => {
            b += x;
            const m = /READY (\d+)/.exec(b);
            if (m) resolve(Number(m[1]));
          });
        }),
        15_000,
        'READY atrapy',
      );

    // (a) kontrola: zwykły proces dostaje bibliotekę hakiem - więc test coś mierzy
    const plain = spawn(dummy, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    toKill.push(plain);
    const tidPlain = await readyTid(plain);
    assert.ok(!(await loaded(plain.pid)), 'przed hakiem biblioteki nie ma');
    const hookOut = await hookInto(plain.pid, tidPlain);
    assert.match(hookOut, /HOOK=[1-9]\d*/, `SetWindowsHookEx: ${hookOut}`);
    assert.ok(await loaded(plain.pid), 'kontrola: hak okna wstrzykuje bibliotekę do zwykłego procesu');
    ok('kontrola: celowany hak okna (SetWindowsHookEx) wstrzykuje bibliotekę do zwykłego procesu');
    plain.kill();

    // (b) natywny start: DACL nie przeszkadza hakowi (nie potrzebuje uchwytu) - uczciwie zapisujemy, że DROGA JEST OTWARTA...
    const guarded = await nativeSpawn.start({ file: dummy, args: [], cwd: work, env: process.env });
    toKill.push(guarded);
    const tidGuarded = await readyTid(guarded);
    // ...a nadzór bibliotek ją łapie. Prawdziwy nadzór: tani odczyt nazw + pełny przegląd z prawdziwym sprawdzaniem podpisu.
    const rules = require(root + 'src/main/core/anticheat.js');
    fs.mkdirSync(paths.cache(), { recursive: true });
    fs.writeFileSync(path.join(paths.cache(), 'blocklist.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
    const violations = [];
    const t1 = Date.now();
    const watcher = rules.watchProcess({
      pid: guarded.pid,
      javaPath: 'C:\\crown-nie-ma\\runtime\\bin\\java.exe', // żaden katalog z procesu nie jest „środowiskiem Javy” - zaufanie nadaje tylko podpis
      trustedDirs: [],
      firstDelayMs: 300,
      intervalMs: 60_000, // pełny przegląd „z zegara” nie ma szans - alarm musi przyjść ze szybkiej ścieżki
      fastMs: 300,
      getModules: guarded.getModules,
      getNames: guarded.getNames,
      onViolation: (v) => violations.push({ ...v, after: Date.now() - t1 }),
    });
    await sleep(1500); // stan wyjściowy zrobiony
    const hookT0 = Date.now();
    const hookOut2 = await hookInto(guarded.pid, tidGuarded);
    assert.match(hookOut2, /HOOK=[1-9]\d*/);
    assert.ok(await loaded(guarded.pid), 'hak okna celowany w wątek gry NIE jest blokowany ani przez DACL, ani przez „extension point disable” (wiemy i mówimy o tym wprost)');
    for (let i = 0; i < 50 && !violations.length; i++) await sleep(200);
    watcher.stop();
    assert.ok(violations.length >= 1, 'nadzór bibliotek wykrył wstrzykniętą bibliotekę');
    assert.ok(violations[0].kill.some((m) => /crowntest-hook\.dll$/i.test(m)), JSON.stringify(violations[0]));
    ok(`hak okna celowany w wątek gry przechodzi blokadę dostępu (nie potrzebuje uchwytu), ale prawdziwy nadzór wykrywa niepodpisaną bibliotekę i kończy grę (alarm ${violations[0].after - (hookT0 - t1)} ms po hakowaniu)`);
    guarded.kill();

    // ---- wyjście awaryjne: brak pomocnika nie psuje startu ----
    const plainScript = path.join(work, 'plain.js');
    fs.writeFileSync(plainScript, "console.log('Z-ZWYKLEGO-STARTU'); process.exitCode = 3;");
    for (const [label, helperPath] of [['brak pomocnika (csc/antywirus)', null], ['pomocnik nie istnieje na dysku', path.join(work, 'nie-ma.exe')]]) {
      nativeSpawn._setHelperForTests(helperPath);
      assert.strictEqual(await nativeSpawn.start({ file: node, args: [plainScript], cwd: work, env: process.env }), null, `${label}: start() zwraca null`);
      const got = [];
      const lc = await launch.run({ javaPath: node, args: [plainScript], cwd: work, secrets: [] }, { onLine: (l) => got.push(l), onExit: (c) => got.push(`EXIT ${c}`) });
      assert.ok(!lc.crownGuard, `${label}: zwykły start nie podaje się za zabezpieczony`);
      await withTimeout(closed(lc), 10_000, label);
      assert.deepStrictEqual(got, ['Z-ZWYKLEGO-STARTU', 'EXIT 3'], `${label}: ${got}`);
    }
    nativeSpawn._setHelperForTests(undefined);
    nativeSpawn._reset();
    ok('wyjście awaryjne: bez pomocnika (null albo brak pliku) launch.run startuje zwykłym spawn - to samo wyjście i kod zakończenia, bez udawania zabezpieczenia');

    // ---- brakujący plik Javy: błąd jak dawniej, bez zawieszenia ----
    const errs = [];
    const bad = await launch.run({ javaPath: path.join(work, 'nie-ma-javy.exe'), args: [], cwd: work, secrets: [] }, { onLine: (l) => errs.push(l), onExit: (c) => errs.push(`EXIT ${c}`) });
    for (let i = 0; i < 50 && !errs.includes('EXIT -1'); i++) await sleep(100);
    assert.ok(errs.some((l) => /Nie udało się uruchomić Javy/.test(l)) && errs.includes('EXIT -1'), errs.join(' | '));
    ok('brak pliku Javy: ten sam komunikat „Nie udało się uruchomić Javy” i kod -1 (nic się nie zawiesza, gra nie startuje podwójnie)');
  } finally {
    for (const c of toKill) {
      try {
        c.kill();
      } catch { /* już zamknięty */ }
    }
    await sleep(500);
    fs.rmSync(work, { recursive: true, force: true });
    for (const d of hookDirs) fs.rmSync(d, { recursive: true, force: true });
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* pomocnik jeszcze się zamyka - zostanie w Temp */
    }
  }

  console.log(`WSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
