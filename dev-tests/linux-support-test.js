// Wsparcie Linuksa: logika zależna od platformy, sprawdzana z podstawioną platformą (test działa też w Windowsie).
// Uruchomienie: node dev-tests/linux-support-test.js
// UCZCIWIE: to NIE jest test na prawdziwym Linuksie - sprawdza parsowanie /proc/<pid>/maps, klasyfikację bibliotek, czyszczenie
// środowiska, chmod folderów wydarzenia (na atrapie systemu plików), wybór magazynu sekretów i konfigurację budowania.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-linux-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const anticheat = require(root + 'src/main/core/anticheat.js');

  // ---- /proc/<pid>/maps ----
  const MAPS = [
    '55d0c3a00000-55d0c3a01000 r--p 00000000 08:01 1310738                    /usr/lib/jvm/java-21/bin/java',
    '55d0c3a01000-55d0c3a02000 r-xp 00001000 08:01 1310738                    /usr/lib/jvm/java-21/bin/java',
    '7f0c1c000000-7f0c1c021000 rw-p 00000000 00:00 0 ',
    '7f0c20000000-7f0c20150000 r-xp 00000000 08:01 2097161                    /usr/lib/x86_64-linux-gnu/libc.so.6',
    '7f0c20150000-7f0c20350000 ---p 00150000 08:01 2097161                    /usr/lib/x86_64-linux-gnu/libc.so.6',
    '7f0c30000000-7f0c30020000 r--p 00000000 08:01 3145731                    /home/gracz/.local/share/cheat/hook.so',
    '7f0c31000000-7f0c31020000 r-xp 00000000 08:01 3145731                    /home/gracz/.local/share/cheat/hook.so',
    '7f0c32000000-7f0c32020000 r-xp 00000000 08:01 3145740                    /tmp/evil.tmp (deleted)',
    '7f0c33000000-7f0c33020000 r-xp 00000000 00:01 5242881                    /memfd:wstrzyk (deleted)',
    '7f0c34000000-7f0c34020000 r-xp 00000000 08:01 3145741                    /tmp/lwjgl_gracz/3.3.3/x64/liblwjgl.so',
    '7ffd5c9fe000-7ffd5ca1f000 rw-p 00000000 00:00 0                          [stack]',
    '7ffd5cbf6000-7ffd5cbfa000 r-xp 00000000 00:00 0                          [vdso]',
    '',
  ].join('\n');
  assert.deepStrictEqual(anticheat.parseMaps(MAPS).sort(), [
    '/home/gracz/.local/share/cheat/hook.so',
    '/memfd:wstrzyk',
    '/tmp/evil.tmp',
    '/tmp/lwjgl_gracz/3.3.3/x64/liblwjgl.so',
    '/usr/lib/jvm/java-21/bin/java',
    '/usr/lib/x86_64-linux-gnu/libc.so.6',
  ].sort());
  ok('parseMaps: tylko pliki zmapowane jako kod (prawo x), bez [stack]/[vdso]/pamięci anonimowej, bez dopisku (deleted), każda ścieżka raz');

  // ---- klasyfikacja bibliotek ----
  const JAVA = '/home/gracz/.config/CrownLauncher/runtime/java-runtime-delta/bin/java';
  const NATIVES = '/home/gracz/.config/CrownLauncher/instances/x/natives';
  const classify = (mods, extra = {}) =>
    anticheat.classifyModules(mods, { javaPath: JAVA, platform: 'linux', tmpDir: '/tmp', trustedDirs: [NATIVES], signed: async () => new Set(), rules: null, ...extra });

  let r = await classify([
    '/usr/lib/x86_64-linux-gnu/libc.so.6',
    '/usr/lib64/dri/radeonsi_dri.so',
    '/nix/store/abc-mesa/lib/libGL.so.1',
    '/run/opengl-driver/lib/libEGL_nvidia.so.0',
    '/home/gracz/.config/CrownLauncher/runtime/java-runtime-delta/lib/server/libjvm.so',
    `${NATIVES}/java/libX.so`,
  ]);
  assert.deepStrictEqual(r, { kill: [], warn: [] });
  ok('biblioteki systemowe (/usr, /nix/store, /run/opengl-driver), runtime Javy i katalog natywnych instancji są zaufane');

  r = await classify(['/home/gracz/.local/share/cheat/hook.so', '/opt/cheat/x.so'.replace('/opt', '/srv')]);
  assert.deepStrictEqual(r.kill, ['/home/gracz/.local/share/cheat/hook.so', '/srv/cheat/x.so']);
  assert.deepStrictEqual(r.warn, []);
  ok('nieznana biblioteka z katalogu użytkownika albo spoza zaufanych miejsc kończy grę (kill)');

  r = await classify([
    '/tmp/lwjgl_gracz/3.3.3/x64/liblwjgl.so',
    '/tmp/jna-4821/jna5521.tmp',
    '/tmp/libnetty_transport_native_epoll_x86_64827364.so',
    '/tmp/sqlite-3.45.1-0a1b2c3d-libsqlitejdbc.so',
    '/tmp/imgui-java-natives/1.90.0/libimgui-java64.so',
    `/tmp/libopus4j-${'a'.repeat(32)}/libopus4j.so`,
  ]);
  assert.deepStrictEqual(r, { kill: [], warn: [] });
  ok('znane natywne biblioteki w /tmp (LWJGL, JNA, Netty, sqlite, imgui-java, Simple Voice Chat) nie dają nawet ostrzeżenia');

  r = await classify(['/tmp/evil.so', '/tmp/imgui-java-natives/1.90.0/libcheat.so', `/tmp/libopus4j-${'a'.repeat(32)}/libinny.so`, '/dev/shm/x.so', '/memfd:wstrzyk']);
  assert.deepStrictEqual(r.kill, []);
  assert.deepStrictEqual(r.warn, ['/tmp/evil.so', '/tmp/imgui-java-natives/1.90.0/libcheat.so', `/tmp/libopus4j-${'a'.repeat(32)}/libinny.so`, '/dev/shm/x.so', '/memfd:wstrzyk']);
  ok('obcy plik w /tmp, w katalogach znanych modów, w /dev/shm i kod z memfd: tylko ostrzeżenie');

  r = await classify(['/srv/biblioteka-od-admina.so'], { signed: async (files) => new Set(files.map((f) => f.toLowerCase())) });
  assert.deepStrictEqual(r, { kill: [], warn: [] });
  r = await classify(['/srv/inna.so'], { rules: { allowModules: new Set(['inna.so']) } });
  assert.deepStrictEqual(r, { kill: [], warn: [] });
  ok('plik należący do roota (odpowiednik podpisu) i biblioteka z listy allowModules przechodzą');

  // własność pliku: na tym systemie sprawdzamy tylko, że funkcja nie zaufa zwykłemu plikowi użytkownika
  const mine = path.join(dataDir, 'moja.so');
  fs.writeFileSync(mine, 'x');
  const trustedSet = await anticheat.signedModules([mine, path.join(dataDir, 'nie-ma.so')], 'linux');
  // (uruchomiony jako root, test sam tworzy plik roota - wtedy ten warunek nie ma sensu)
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    assert.ok(!trustedSet.has(mine.toLowerCase()), 'zwykły plik użytkownika nie jest „zaufany”');
  }
  assert.ok(!trustedSet.has(path.join(dataDir, 'nie-ma.so').toLowerCase()));
  assert.strictEqual((await anticheat.signedModules([], 'linux')).size, 0);
  ok('signedModules (Linux): plik użytkownika i nieistniejący nie są zaufane');

  assert.ok(anticheat.trustedRoots(JAVA, [], 'linux').includes('/home/gracz/.config/crownlauncher/runtime/java-runtime-delta/'));
  assert.ok(!anticheat.trustedRoots(JAVA, [], 'linux').some((x) => x === '/home/' || x === '/tmp/' || x === '/'));
  ok('trustedRoots (Linux): bez /home, /tmp i /; z katalogiem Javy');

  // ---- środowisko procesu gry ----
  const env = {
    LD_PRELOAD: '/home/gracz/cheat.so',
    LD_AUDIT: '/x.so',
    JAVA_TOOL_OPTIONS: '-javaagent:x.jar',
    SSH_AUTH_SOCK: '/run/user/1000/ssh',
    GITHUB_TOKEN: 'ghp_x',
    HOME: '/home/gracz',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    APPDIR: '/tmp/.mount_CrownLXYZ',
    APPIMAGE: '/home/gracz/CrownLauncher-0.1.40.AppImage',
    ARGV0: 'x',
    OWD: '/home/gracz',
    PATH: '/tmp/.mount_CrownLXYZ:/tmp/.mount_CrownLXYZ/usr/sbin:/usr/local/bin:/usr/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_CrownLXYZ/usr/lib:/opt/cuda/lib64',
    XDG_DATA_DIRS: '/tmp/.mount_CrownLXYZ/usr/share/:/usr/share',
    GSETTINGS_SCHEMA_DIR: '/tmp/.mount_CrownLXYZ/usr/share/glib-2.0/schemas',
  };
  const clean = anticheat.scrubEnv(env, 'linux');
  for (const k of ['LD_PRELOAD', 'LD_AUDIT', 'JAVA_TOOL_OPTIONS', 'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'GSETTINGS_SCHEMA_DIR']) {
    assert.ok(!(k in clean), `${k} usunięte`);
  }
  assert.strictEqual(clean.PATH, '/usr/local/bin:/usr/bin', 'PATH bez wpisów z obrazu AppImage');
  assert.strictEqual(clean.LD_LIBRARY_PATH, '/opt/cuda/lib64', 'LD_LIBRARY_PATH zachowuje wpisy użytkownika');
  assert.strictEqual(clean.XDG_DATA_DIRS, '/usr/share');
  for (const k of ['HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) assert.strictEqual(clean[k], env[k], `${k} zostaje`);
  const noAppImage = anticheat.scrubEnv({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/x', LD_PRELOAD: '/a.so' }, 'linux');
  assert.deepStrictEqual(noAppImage, { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/x' }, 'poza AppImage ścieżki nietknięte, LD_PRELOAD usunięte');
  const win = anticheat.scrubEnv({ APPDIR: 'x', PATH: 'C:\\x' }, 'win32');
  assert.deepStrictEqual(win, { APPDIR: 'x', PATH: 'C:\\x' }, 'Windows: zmienne AppImage nie są ruszane');
  ok('scrubEnv: LD_PRELOAD/LD_AUDIT i tokeny usunięte, ślady AppImage (APPDIR, PATH, LD_LIBRARY_PATH…) wyczyszczone, reszta zostaje');

  // ---- ptrace_scope ----
  assert.match(await anticheat.linuxPtraceNote('linux', async () => '0\n'), /ptrace_scope=0/);
  assert.strictEqual(await anticheat.linuxPtraceNote('linux', async () => '1\n'), '');
  assert.strictEqual(await anticheat.linuxPtraceNote('linux', async () => { throw new Error('ENOENT'); }), '');
  assert.strictEqual(await anticheat.linuxPtraceNote('win32', async () => '0'), '');
  ok('ostrzeżenie o ptrace_scope=0 tylko na Linuksie i tylko przy wartości 0');

  // ---- foldery wydarzenia (chmod) na atrapie systemu plików ----
  const hidden = require(root + 'src/main/core/hidden.js');
  function fakeFs(tree) {
    // tree: { 'sciezka': { dir: true, mode } | { mode, exec } } - ścieżki z ukośnikami
    const norm = (p) => p.replace(/\\/g, '/');
    const node = (p) => tree[norm(p)];
    const kids = (dir) => Object.keys(tree).filter((p) => path.posix.dirname(p) === norm(dir));
    const dirent = (p) => ({
      name: path.posix.basename(p),
      isDirectory: () => Boolean(tree[p].dir),
      isFile: () => !tree[p].dir && !tree[p].link,
      isSymbolicLink: () => Boolean(tree[p].link),
    });
    return {
      calls: [],
      async lstat(p) {
        if (!node(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isDirectory: () => Boolean(node(p).dir), mode: node(p).mode };
      },
      async readdir(p) {
        return kids(p).map(dirent);
      },
      async chmod(p, mode) {
        tree[norm(p)].mode = mode;
        this.calls.push([norm(p), mode]);
      },
    };
  }
  {
    const tree = {
      '/g/mods': { dir: true, mode: 0o000 },
      '/g/mods/a.jar': { mode: 0o600 },
      '/g/mods/sub': { dir: true, mode: 0o700 },
      '/g/mods/sub/b.jar': { mode: 0o644 },
      '/g/mods/link': { link: true, mode: 0o777 },
      '/g/mods/run.sh': { mode: 0o755 },
      '/g/config': { dir: true, mode: 0o755 },
    };
    const f = fakeFs(tree);
    await hidden.setAccess(['/g/mods', '/g/nie-ma'], 'open', { platform: 'linux', fs: f });
    assert.strictEqual(tree['/g/mods'].mode, 0o755);
    assert.strictEqual(tree['/g/mods/a.jar'].mode, 0o644);
    assert.strictEqual(tree['/g/mods/sub'].mode, 0o755);
    assert.strictEqual(tree['/g/mods/run.sh'].mode, 0o755, 'bit wykonywalny zostaje');
    assert.strictEqual(tree['/g/mods/link'].mode, 0o777, 'dowiązań nie ruszamy');
    await hidden.setAccess(['/g/mods'], 'readonly', { platform: 'linux', fs: f });
    assert.strictEqual(tree['/g/mods'].mode, 0o555);
    assert.strictEqual(tree['/g/mods/a.jar'].mode, 0o444);
    assert.strictEqual(tree['/g/mods/sub'].mode, 0o555);
    assert.strictEqual(tree['/g/mods/sub/b.jar'].mode, 0o444);
    assert.strictEqual(tree['/g/mods/run.sh'].mode, 0o555);
    await hidden.setAccess(['/g/mods'], 'sealed', { platform: 'linux', fs: f });
    assert.strictEqual(tree['/g/mods'].mode, 0o000, 'sealed = brak wejścia do folderu');
    await hidden.setAccess(['/g/mods'], 'open', { platform: 'linux', fs: f }); // z sealed wracamy do open
    assert.strictEqual(tree['/g/mods'].mode, 0o755);
    assert.strictEqual(tree['/g/mods/sub/b.jar'].mode, 0o644);
    process.env.CROWN_EVENT_NO_SEAL = '1';
    await hidden.setAccess(['/g/config'], 'sealed', { platform: 'linux', fs: f });
    assert.strictEqual(tree['/g/config'].mode, 0o755, 'CROWN_EVENT_NO_SEAL=1 zostawia folder otwarty');
    delete process.env.CROWN_EVENT_NO_SEAL;
    ok('hidden.setAccess (Linux/chmod): open/readonly/sealed i powrót z sealed, bez dowiązań, brakujący folder pominięty, NO_SEAL');
  }
  {
    // ten sam kod na prawdziwych katalogach, z podsłuchem chmod (prawa na dysku nie są tu zmieniane)
    const base = path.join(dataDir, 'ev');
    fs.mkdirSync(path.join(base, 'mods', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(base, 'mods', 'a.jar'), 'x');
    const calls = [];
    const real = fs.promises;
    const spy = {
      lstat: (p) => real.lstat(p),
      readdir: (p, o) => real.readdir(p, o),
      chmod: async (p, m) => {
        calls.push([path.relative(base, p).replace(/\\/g, '/'), m]);
      },
    };
    await hidden.setAccess([path.join(base, 'mods'), path.join(base, 'brak')], 'readonly', { platform: 'linux', fs: spy });
    const byPath = Object.fromEntries(calls.map(([p, m]) => [p, m]));
    assert.strictEqual(byPath['mods/a.jar'], 0o444);
    assert.strictEqual(byPath['mods/sub'], 0o555);
    assert.strictEqual(calls[calls.length - 1][0] + ':' + calls[calls.length - 1][1], `mods:${0o555}`, 'folder główny zmieniany na końcu');
    assert.ok(!calls.some(([p]) => p === 'brak'), 'brakujący folder pominięty');
    calls.length = 0;
    await hidden.setAccess([path.join(base, 'mods')], 'sealed', { platform: 'linux', fs: spy });
    assert.strictEqual(calls[calls.length - 1][1], 0o000);
    ok('hidden.setAccess (Linux/chmod) na prawdziwych katalogach z podsłuchem chmod: readonly 555/444, sealed 000, brak folderu pominięty');
  }

  // ---- magazyn sekretów ----
  const electronPath = require.resolve('electron');
  require('electron'); // w samym Node to tylko ścieżka do pliku - podstawiamy atrapę safeStorage w cache modułów
  const realElectron = require.cache[electronPath].exports;
  const auth = require(root + 'src/main/core/auth.js');
  const fakeStorage = ({ available, backend }) => {
    const s = {
      plain: false,
      isEncryptionAvailable: () => available || s.plain,
      getSelectedStorageBackend: () => backend,
      setUsePlainTextEncryption: (v) => {
        s.plain = v;
        s.called = true;
      },
    };
    return s;
  };
  try {
    let st = fakeStorage({ available: false, backend: 'basic_text' });
    require.cache[electronPath].exports = { safeStorage: st };
    assert.strictEqual(auth.prepareStorage('linux'), 'basic');
    assert.ok(st.called && st.plain, 'Linux bez pęku kluczy: włączony zapasowy magazyn Electrona');
    assert.strictEqual(auth.storageKind(), 'basic');
    st = fakeStorage({ available: true, backend: 'gnome_libsecret' });
    require.cache[electronPath].exports = { safeStorage: st };
    assert.strictEqual(auth.prepareStorage('linux'), 'keyring');
    assert.ok(!st.called, 'z prawdziwym pękiem kluczy nic nie zmieniamy');
    st = fakeStorage({ available: true, backend: 'kwallet6' });
    require.cache[electronPath].exports = { safeStorage: st };
    assert.strictEqual(auth.prepareStorage('linux'), 'keyring');
    st = fakeStorage({ available: true, backend: '' });
    require.cache[electronPath].exports = { safeStorage: st };
    assert.strictEqual(auth.prepareStorage('win32'), 'dpapi');
    assert.ok(!st.called, 'Windows: bez zmian');
    st = { isEncryptionAvailable: () => false }; // brak setUsePlainTextEncryption (stary Electron)
    require.cache[electronPath].exports = { safeStorage: st };
    assert.strictEqual(auth.prepareStorage('linux'), 'none');
    assert.throws(() => auth.seal('token'), /nie zapisuję tokenu jawnym tekstem/, 'bez żadnego magazynu token nie trafia na dysk jawnie');
    st = fakeStorage({ available: false, backend: 'basic_text' });
    st.encryptString = (t) => Buffer.from(`ZASZYFROWANE:${t}`);
    st.decryptString = (b) => b.toString().replace('ZASZYFROWANE:', '');
    require.cache[electronPath].exports = { safeStorage: st };
    auth.prepareStorage('linux');
    const sealed = auth.seal('tajny-token');
    assert.ok(sealed.startsWith('enc:') && !sealed.includes('tajny'), 'po włączeniu zapasowego magazynu seal() szyfruje');
    assert.strictEqual(auth.unseal(sealed), 'tajny-token');
  } finally {
    require.cache[electronPath].exports = realElectron;
  }
  ok('prepareStorage: pęk kluczy → keyring; brak pęku → zapasowy magazyn (basic); brak wszystkiego → none i odmowa jawnego zapisu; Windows → dpapi');

  // ---- budowanie ----
  const cfg = (env) =>
    JSON.parse(
      spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(root + 'electron-builder.config.js')});console.log(JSON.stringify({fuses:c.electronFuses,linux:c.linux,win:c.win}))`], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }).stdout,
    );
  const winCfg = cfg({ CROWN_TARGET: '' });
  assert.strictEqual(winCfg.fuses.enableEmbeddedAsarIntegrityValidation, true, 'build Windows: sprawdzanie asara włączone');
  const linCfg = cfg({ CROWN_TARGET: 'linux' });
  assert.strictEqual(linCfg.fuses.enableEmbeddedAsarIntegrityValidation, false, 'build Linux: wyłączone (brak danych integralności w pliku)');
  assert.strictEqual(linCfg.fuses.onlyLoadAppFromAsar, true);
  assert.strictEqual(linCfg.fuses.runAsNode, false);
  assert.deepStrictEqual(linCfg.linux.target, [{ target: 'AppImage', arch: ['x64'] }]);
  assert.strictEqual(linCfg.linux.artifactName, 'CrownLauncher-${version}.${ext}');
  assert.ok(fs.existsSync(path.join(root, linCfg.linux.icon)));
  assert.strictEqual(linCfg.win.target, 'nsis');
  ok('electron-builder: AppImage x64 + nazwa pliku + ikona; bezpieczniki Electrona bez zmian poza sprawdzaniem asara na Linuksie');

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nWSZYSTKO OK (${n})`);
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
