// Start gry (launch.js) bez prawdziwego Minecrafta: składanie polecenia (flagi JVM, argumenty gracza bez filtrowania) i uruchomienie
// procesu zwykłym spawn (strumień wyjścia, kod wyjścia, środowisko bez sekretów). Zamiast Javy działa Node.
// Uruchomienie: node dev-tests/launch-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-launch-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const launch = require(root + 'src/main/core/launch.js');

  // ---- składanie polecenia ----
  const prep = {
    merged: { _baseId: '1.21.11', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', javaVersion: { majorVersion: 21 }, arguments: { jvm: ['-Dtest.jvm=1'], game: ['--demo'] } },
    assetIndexId: '29',
    nativesDir: path.join(dataDir, 'natives'),
    classpath: [path.join(dataDir, 'a.jar')],
    loggingArg: '',
    javaExe: process.execPath,
  };
  const instance = { id: 'i1', memoryMb: 3072, jvmArgs: '-javaagent:instancja.jar -Dinstancja=1' };
  const account = { username: 'Gracz', uuid: 'u', type: 'offline' };
  const command = launch.buildCommand({ instance, account, prep, config: { memoryMb: 4096, jvmArgs: '-Dgracz=1 -Xbootclasspath/a:x.jar', optimizeJvm: false } });
  assert.strictEqual(command.args[0], '-Xmx3072M');
  assert.ok(command.args.includes('-XX:+IgnoreUnrecognizedVMOptions'), 'nieznana opcja JVM nie przerywa startu');
  for (const flag of ['-XX:+DisableAttachMechanism', '-XX:-EnableDynamicAgentLoading', '-XX:-UsePerfData']) {
    assert.ok(!command.args.includes(flag), `launcher nie dokłada już ${flag}`);
  }
  assert.ok(!('removedJvm' in command), 'polecenie nie niesie listy „usuniętych” argumentów');
  ok('buildCommand: pamięć z instancji, -XX:+IgnoreUnrecognizedVMOptions, bez dawnych flag „utwardzających”');

  for (const a of ['-Dgracz=1', '-Xbootclasspath/a:x.jar', '-javaagent:instancja.jar', '-Dinstancja=1']) {
    assert.ok(command.args.includes(a), `argument gracza ${a} zostaje bez filtrowania`);
  }
  assert.ok(command.args.indexOf('-Dgracz=1') < command.args.indexOf(prep.merged.mainClass), 'argumenty JVM stoją przed klasą główną');
  assert.ok(command.args.includes('--demo'), 'argumenty gry z manifestu');
  ok('argumenty JVM gracza (też -javaagent i -Xbootclasspath) przechodzą bez zmian, przed klasą główną');

  // ---- uruchomienie procesu ----
  process.env.GH_TOKEN = 'tajny-token-do-usuniecia';
  process.env.MOJ_PASSWORD = 'haslo';
  const code = "console.log('out:' + (process.env.GH_TOKEN || 'brak') + ':' + (process.env.MOJ_PASSWORD || 'brak') + ':' + (process.env.PATH || process.env.Path ? 'PATH' : 'bez-PATH')); console.error('blad-linia'); process.exit(7);";
  const lines = [];
  const exit = await new Promise((resolve, reject) => {
    launch
      .run({ javaPath: process.execPath, args: ['-e', code], cwd: path.join(dataDir, 'game'), secrets: [], mainIndex: 0 }, { onLine: (l) => lines.push(l), onExit: resolve })
      .catch(reject);
  });
  assert.strictEqual(exit, 7, 'kod wyjścia procesu');
  assert.ok(lines.includes('blad-linia'), 'stderr trafia do konsoli');
  assert.ok(lines.includes('out:brak:brak:PATH'), `środowisko gry bez sekretów, z PATH (jest: ${lines.join(' | ')})`);
  ok('run: zwykły spawn — stdout i stderr w konsoli, kod wyjścia, środowisko bez sekretów (TOKEN/PASSWORD), PATH zostaje');

  // ---- brak pliku Javy: czytelny komunikat i kod -1, bez wyjątku ----
  const lines2 = [];
  const exit2 = await new Promise((resolve, reject) => {
    launch
      .run({ javaPath: path.join(dataDir, 'nie-ma-javy.exe'), args: [], cwd: path.join(dataDir, 'game'), secrets: [], mainIndex: 0 }, { onLine: (l) => lines2.push(l), onExit: resolve })
      .catch(reject);
  });
  assert.strictEqual(exit2, -1);
  assert.ok(lines2.some((l) => /Nie udało się uruchomić Javy/.test(l)), lines2.join(' | '));
  ok('run: brak pliku Javy → komunikat „Nie udało się uruchomić Javy” i kod -1');

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
