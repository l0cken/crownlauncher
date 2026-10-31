// Ochrona wrażliwych danych: szyfrowanie sekretów, token poza linią poleceń, logi, środowisko, klucz publikowania.
// Uruchomienie: node dev-tests/secrets-test.js  (część „prawdziwa Java” potrzebuje JDK z javac — bez niego jest pomijana)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(43)}`;

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false }); // test trybu GitHub: nie zależy od produkcyjnego app-config.js
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-secrets-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const config = require(root + 'src/main/core/config.js');
  const auth = require(root + 'src/main/core/auth.js');
  const util = require(root + 'src/main/core/util.js');
  const launch = require(root + 'src/main/core/launch.js');
  const announcements = require(root + 'src/main/core/announcements.js');

  // ---- szyfrowanie sekretów ----
  assert.strictEqual(auth.unseal(auth.seal(TOKEN)), TOKEN);
  assert.ok(auth.isSealed(auth.seal('x')) && !auth.isSealed('jawny tekst'));
  // „Electron” bez DPAPI: w aplikacji NIE wolno zapisać tokenu jawnie
  const electronPath = require.resolve('electron');
  const realElectron = require.cache[electronPath].exports;
  const fake = (storage) => { require.cache[electronPath].exports = { safeStorage: storage }; };
  fake({ isEncryptionAvailable: () => false });
  assert.throws(() => auth.seal('tajny-token'), /nie zapisuję tokenu jawnym tekstem/);
  // „Electron” z DPAPI: zapisuje enc:, a migracja przepisuje stare wpisy jawne
  fake({
    isEncryptionAvailable: () => true,
    encryptString: (t) => Buffer.from(`DPAPI(${t})`),
    decryptString: (b) => /^DPAPI\((.*)\)$/s.exec(b.toString())[1],
  });
  assert.ok(auth.seal('abc').startsWith('enc:'));
  assert.strictEqual(auth.unseal(auth.seal('abc')), 'abc');
  const rawOf = (t) => `raw:${Buffer.from(t).toString('base64')}`;
  config.set({
    accounts: [{ id: 'm', type: 'microsoft', username: 'Gracz', uuid: 'u', accessToken: rawOf('AT'), refreshToken: rawOf('RT') }, { id: 'o', type: 'offline', username: 'Off', uuid: 'u2' }],
    publisherKey: rawOf('ghp_klucz'),
    capeSecrets: { Gracz: 'jawny-sekret-jawny-sekret-1', Inny: rawOf('sekret-raw-sekret-raw-1') },
  });
  assert.strictEqual(auth.migrateSecrets(), true);
  const c1 = config.get();
  assert.ok(c1.accounts[0].accessToken.startsWith('enc:') && c1.accounts[0].refreshToken.startsWith('enc:'));
  assert.strictEqual(auth.unseal(c1.accounts[0].accessToken), 'AT');
  assert.ok(c1.publisherKey.startsWith('enc:'));
  assert.ok(Object.values(c1.capeSecrets).every((v) => v.startsWith('enc:')));
  assert.strictEqual(auth.unseal(c1.capeSecrets.Gracz), 'jawny-sekret-jawny-sekret-1');
  assert.strictEqual(auth.migrateSecrets(), false, 'drugie wywołanie nic nie zmienia');
  assert.deepStrictEqual(c1.accounts[1], { id: 'o', type: 'offline', username: 'Off', uuid: 'u2' });
  // dawny sekret nicka zapisany jawnie jest przepisywany przy pierwszym użyciu
  const capes = require(root + 'src/main/core/capes.js');
  config.set({ capeSecrets: { Stary: 'stary-sekret-stary-sekret-1' } });
  assert.strictEqual(capes.secretFor('Stary'), 'stary-sekret-stary-sekret-1');
  assert.ok(config.get().capeSecrets.Stary.startsWith('enc:'));
  assert.ok(capes.secretFor('Nowy').length >= 16 && config.get().capeSecrets.Nowy.startsWith('enc:'));
  require.cache[electronPath].exports = realElectron;
  ok('seal: w aplikacji bez DPAPI błąd zamiast jawnego zapisu; migracja przepisuje raw:/jawne sekrety na enc:');

  // ---- redakcja ----
  assert.strictEqual(util.redact(`Setting token ${TOKEN} ok`, [TOKEN]), 'Setting token <ukryte> ok');
  assert.strictEqual(util.redact(`inny ${TOKEN}`, []), 'inny <ukryte>', 'JWT ukryty także bez znajomości tokenu');
  assert.strictEqual(util.redact('wartość 0 i 123', ['0']), 'wartość 0 i 123', 'krótkich „sekretów” (offline: 0) nie ruszamy');
  assert.strictEqual(util.redact('zwykła linia logu'), 'zwykła linia logu');
  ok('redact: token i dowolny JWT znikają z linii logów');

  // ---- środowisko procesu gry ----
  const env = launch.scrubEnv({
    PATH: 'C:\\x', JAVA_HOME: 'C:\\j', APPDATA: 'C:\\a', TEMP: 'C:\\t', LOCALAPPDATA: 'C:\\l', USERPROFILE: 'C:\\u', SystemRoot: 'C:\\w',
    ProgramFiles: 'C:\\p', NUMBER_OF_PROCESSORS: '8', MESA_GLSL_CACHE_DIR: 'x', __GL_THREADED_OPTIMIZATIONS: '1',
    GITHUB_TOKEN: 's', GH_TOKEN: 's', ANTHROPIC_API_KEY: 's', AWS_SECRET_ACCESS_KEY: 's', MY_PASSWORD: 's', SSH_AUTH_SOCK: 's',
    NPM_TOKEN: 's', CROWN_GITHUB_TOKEN: 's', DB_CREDENTIALS: 's',
  });
  for (const k of ['PATH', 'JAVA_HOME', 'APPDATA', 'TEMP', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot', 'ProgramFiles', 'NUMBER_OF_PROCESSORS', 'MESA_GLSL_CACHE_DIR', '__GL_THREADED_OPTIMIZATIONS']) {
    assert.ok(k in env, `zostaje ${k}`);
  }
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'MY_PASSWORD', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'CROWN_GITHUB_TOKEN', 'DB_CREDENTIALS']) {
    assert.ok(!(k in env), `usunięte ${k}`);
  }
  ok('scrubEnv: sekrety użytkownika (tokeny, klucze, hasła, SSH) nie trafiają do procesu gry; PATH/JAVA_HOME/AppData zostają');

  // ---- token poza linią poleceń (logika podziału) ----
  const MAIN = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
  const cmd = {
    args: ['-Xmx2G', '-cp', 'C:\\libs\\a.jar', MAIN, '--username', 'Zażółć', '--uuid', 'abc', '--accessToken', TOKEN, '--version', '1.21.11'],
    secrets: [TOKEN],
    mainIndex: 3,
  };
  const split = launch.splitSecretArgs(cmd);
  assert.deepStrictEqual(split.visible, ['-Xmx2G', '-cp', 'C:\\libs\\a.jar', '@', '--username', 'Zażółć', '--uuid', 'abc', '--version', '1.21.11']);
  assert.strictEqual(split.content, `"${MAIN}" "--accessToken" "${TOKEN}"\n`);
  assert.ok(!split.visible.join(' ').includes(TOKEN));
  const eq = launch.splitSecretArgs({ ...cmd, args: ['-Xmx2G', MAIN, `--accessToken=${TOKEN}`, '--x', '1'], mainIndex: 1 });
  assert.deepStrictEqual(eq.visible, ['-Xmx2G', '@', '--x', '1']);
  assert.strictEqual(launch.splitSecretArgs({ ...cmd, secrets: [] }), null, 'konto offline: bez zmian');
  assert.strictEqual(launch.splitSecretArgs({ ...cmd, args: [...cmd.args.slice(0, 9), 'tok-zażółć'], secrets: ['tok-zażółć'] }), null, 'nie-ASCII: bez pliku (kodowanie)');
  assert.strictEqual(launch.splitSecretArgs({ ...cmd, args: ['-Dx=' + TOKEN, ...cmd.args.slice(1)], mainIndex: 3 }), null, 'token w JVM: nie ruszamy');
  ok('splitSecretArgs: do pliku idzie klasa główna + „--accessToken <token>”, reszta zostaje w linii poleceń w tej samej kolejności');

  // ---- sprzątanie po awarii JVM ----
  const game = path.join(dataDir, 'game');
  fs.mkdirSync(path.join(game, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(game, 'crash-reports'), { recursive: true });
  const hs = path.join(game, 'hs_err_pid4242.log');
  fs.writeFileSync(hs, `# fatal error\nCommand Line: -Xmx2G ${MAIN} --username Gracz --accessToken ${TOKEN} --version 1\n`);
  fs.writeFileSync(path.join(game, 'logs', 'latest.log'), 'nic tajnego\n');
  const stale = path.join(game, 'hs_err_pid1.log');
  fs.writeFileSync(stale, `stary ${TOKEN}`);
  fs.utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const fixed = await launch.scrubCrashFiles(game, [TOKEN], Date.now() - 60_000);
  assert.strictEqual(fixed, 1);
  assert.ok(!fs.readFileSync(hs, 'latin1').includes(TOKEN) && fs.readFileSync(hs, 'latin1').includes('<ukryte>'));
  assert.ok(fs.readFileSync(stale, 'latin1').includes(TOKEN), 'pliki sprzed sesji nietknięte');
  ok('scrubCrashFiles: token zamazany w hs_err z tej sesji, starsze pliki nietknięte');

  // ---- klucz publikowania wiązany ze źródłem ----
  fake({ isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`DPAPI(${t})`), decryptString: (b) => /^DPAPI\((.*)\)$/s.exec(b.toString())[1] });
  const sealedKey = auth.seal('ghp_prawdziwy_klucz');
  config.set({ publisherKey: sealedKey, publisherSource: 'github:l0cken/crownlauncher', publisherName: 'l0cken', publisherRole: 'admin', announcementsUrl: '' });
  assert.strictEqual(announcements.savedKey(), 'ghp_prawdziwy_klucz');
  assert.strictEqual(announcements.status().loggedIn, true);
  config.set({ announcementsUrl: 'https://obcy.example/api' });
  assert.strictEqual(announcements.savedKey(), '', 'inny adres - klucza nie oddajemy');
  assert.strictEqual(announcements.status().loggedIn, false);
  // launcher z podmienionym adresem nie wysyła klucza na obcy serwer (żadne żądanie nie niesie Authorization)
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    return new Response(JSON.stringify({ announcements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await announcements.fetchItems();
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(seen.length >= 1 && seen.every((s) => s.url.startsWith('https://obcy.example')), 'zapytanie poszło na obcy adres');
  assert.ok(seen.every((s) => !JSON.stringify(s.headers).includes('ghp_') && !/authorization/i.test(JSON.stringify(s.headers))), 'bez klucza');
  config.set({ announcementsUrl: 'l0cken/CrownLauncher' }); // to samo repozytorium, inna pisownia
  assert.strictEqual(announcements.savedKey(), 'ghp_prawdziwy_klucz');
  // klucz zapisany przed wiązaniem (bez publisherSource) należy do źródła wbudowanego
  config.set({ publisherSource: '', announcementsUrl: '' });
  assert.strictEqual(announcements.savedKey(), 'ghp_prawdziwy_klucz');
  config.set({ announcementsUrl: 'https://obcy.example/api' });
  assert.strictEqual(announcements.savedKey(), '');
  config.set({ announcementsUrl: '', publisherKey: '', publisherSource: '' });
  ok('klucz publikowania: wysyłany tylko do źródła, dla którego go wpisano (zmiana adresu w ustawieniach go nie wydaje)');
  require.cache[electronPath].exports = realElectron;

  // ---- konfiguracja dla renderera (config:get korzysta z config.publicView) ----
  config.set({ capeSecrets: { Gracz: 'enc:sekret' }, publisherKey: 'enc:klucz', publisherSource: 'github:a/b', accounts: [{ id: 'x', type: 'microsoft', username: 'G', accessToken: 'enc:t' }] });
  const view = config.publicView();
  for (const k of ['accounts', 'publisherKey', 'publisherSource', 'capeSecrets']) assert.ok(!(k in view), `widok publiczny nie zawiera ${k}`);
  assert.ok('memoryMb' in view && 'optimizeJvm' in view, 'zwykłe ustawienia zostają');
  assert.ok(config.get().accounts.length === 1, 'sam config nie jest ruszany');
  assert.ok(/publicView\(\)/.test(fs.readFileSync(root + 'src/main/ipc.js', 'utf8')), 'ipc.js używa widoku publicznego');
  ok('config:get: do renderera nie idą konta, klucz publikowania ani sekrety nicków');

  // ---- prawdziwa Java: token nie jest w linii poleceń, a gra dostaje komplet argumentów ----
  const jdk = fs.existsSync('C:\\Program Files\\Java')
    ? fs.readdirSync('C:\\Program Files\\Java').map((d) => path.join('C:\\Program Files\\Java', d, 'bin')).find((b) => fs.existsSync(path.join(b, 'javac.exe')))
    : null;
  if (process.platform !== 'win32' || !jdk) {
    console.log('--  pominięto test z prawdziwą Javą (brak JDK z javac)');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-java-'));
    fs.writeFileSync(
      path.join(work, 'PrintArgs.java'),
      'public class PrintArgs { public static void main(String[] a) throws Exception {' +
        ' for (String s : a) { StringBuilder sb = new StringBuilder();' +
        ' s.codePoints().forEach(c -> sb.append(c < 128 ? String.valueOf((char) c) : String.format("\\\\u%04x", c)));' +
        ' System.out.println("ARG:" + sb); } System.out.flush(); Thread.sleep(Long.getLong("sleep", 0)); } }',
    );
    execFileSync(path.join(jdk, 'javac.exe'), ['-d', work, path.join(work, 'PrintArgs.java')]);
    const java = path.join(jdk, 'java.exe');
    const game2 = path.join(work, 'gra z spacja');

    const runOnce = (secrets) =>
      new Promise((resolve, reject) => {
        const lines = [];
        const base = ['-Dsleep=4000', '-cp', work, 'PrintArgs', '--username', 'Zażółć gęślą', '--uuid', 'abc-123', '--accessToken', TOKEN, '--gameDir', game2, '--version', '1.21.11'];
        const command = { javaPath: java, args: base, cwd: game2, secrets, mainIndex: 3 };
        let child;
        let cmdline = '';
        let sampled = false;
        const sample = async () => {
          if (sampled) return;
          sampled = true;
          cmdline = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}").CommandLine`], { encoding: 'utf8' });
        };
        launch.run(command, {
          onLine: (l) => { lines.push(l); if (lines.length === 1) setTimeout(() => sample().catch(() => {}), 300); },
          onExit: (code) => resolve({ code, lines, cmdline, files: fs.existsSync(path.join(dataDir, 'run')) ? fs.readdirSync(path.join(dataDir, 'run')) : [] }),
        }).then((c) => { child = c; }, reject);
      });

    const hiddenRun = await runOnce([TOKEN]);
    const plainRun = await runOnce([]);
    assert.strictEqual(hiddenRun.code, 0, hiddenRun.lines.join('\n'));
    assert.strictEqual(plainRun.code, 0, plainRun.lines.join('\n'));
    // ukryta para „--accessToken <token>” trafia zaraz za klasę główną - kolejność opcji nie ma znaczenia dla gry,
    // ale każda opcja musi dostać swoją wartość i nic nie może zginąć
    assert.deepStrictEqual([...hiddenRun.lines].sort(), [...plainRun.lines].sort(), 'gra widzi dokładnie te same argumenty');
    const at = hiddenRun.lines.indexOf('ARG:--accessToken');
    assert.ok(at >= 0 && hiddenRun.lines[at + 1] === `ARG:${TOKEN}`, 'opcja i token razem');
    assert.ok(hiddenRun.lines.includes(`ARG:${TOKEN}`), 'token dotarł do gry');
    // tak wypisuje PrintArgs: znaki spoza ASCII jako \uXXXX
    const esc = (t) => [...t].map((c) => (c.codePointAt(0) < 128 ? c : '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'))).join('');
    assert.ok(hiddenRun.lines.includes('ARG:--gameDir') && hiddenRun.lines.includes(`ARG:${esc(game2)}`), 'ścieżka ze spacją cała');
    assert.ok(!hiddenRun.cmdline.includes(TOKEN) && /@.*\.args/.test(hiddenRun.cmdline), `linia poleceń bez tokenu: ${hiddenRun.cmdline.slice(0, 200)}`);
    assert.ok(plainRun.cmdline.includes(TOKEN), 'kontrola: bez ukrywania token jest w linii poleceń (tak było dotąd)');
    assert.deepStrictEqual(hiddenRun.files, [], 'plik z tokenem usunięty po starcie gry');
    ok('prawdziwa Java: gra dostaje komplet argumentów (też spacje i nie-ASCII), a w linii poleceń procesu nie ma tokenu; plik znika');
    fs.rmSync(work, { recursive: true, force: true });
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nWSZYSTKO OK (${n})`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
