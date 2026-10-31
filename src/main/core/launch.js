const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths');
const { rulesAllow } = require('./mojang');
const { splitArgs, redact } = require('./util');
const appConfig = require('./app-config');
const anticheat = require('./anticheat');
const nativeSpawn = require('./native-spawn');

/**
 * Własności systemowe dla CrownClient (korona przed nickiem): adres listy graczy z odznaką (listing katalogu
 * capes/players w repozytorium GitHub) albo wyłączenie funkcji przełącznikiem „Peleryny i korona w grze” (mogą go używać
 * tylko gracze z dostępem z panelu - patrz invite.cosmeticsOff).
 */
function badgeProperties() {
  try {
    if (require('./invite').cosmeticsOff()) return ['-Dcrownclient.badge=off'];
  } catch {
    /* bez modułu zaproszeń: korona włączona */
  }
  try {
    // serwer peleryn (lista graczy z koroną) albo listing katalogu capes/players w repozytorium GitHub
    const url = require('./capes').badgeListUrl();
    if (url) return [`-Dcrownclient.badges=${url}`];
  } catch {
    /* niepoprawne źródło - bez listy */
  }
  return [];
}

const GC_FLAG = /^-XX:\+Use(?:G1|Z|Parallel|Serial|Shenandoah|Epsilon)GC$/;

/**
 * Dostrojony garbage collector (G1) pod grę kliencką: krótkie pauzy zamiast zacięć przy sprzątaniu pamięci,
 * wcześniejsze kompilowanie dużych metod Minecrafta i większy cache kodu. Nie dokładamy nic, gdy gracz sam
 * wybrał inny GC w argumentach JVM.
 */
function tuningArgs({ memory, userJvm, javaMajor = 21 }) {
  if (userJvm.some((a) => GC_FLAG.test(a))) return [];
  const large = memory >= 12288;
  const flags = [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=50',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-XX:-DontCompileHugeMethods',
    '-XX:ReservedCodeCacheSize=512M',
  ];
  // Java 25 (Minecraft 26.x): zwarte nagłówki obiektów - mniej pamięci i lepsza lokalność cache (flaga produkcyjna od JDK 25)
  if (javaMajor >= 25) flags.push('-XX:+UseCompactObjectHeaders');
  return flags;
}

const LAUNCHER_NAME = 'CrownLauncher';
// pokazywane w grze obok wersji (ekran tytułowy: "Minecraft 1.21.11/CrownClient")
const VERSION_TYPE = String(appConfig.CLIENT_NAME || 'release').replace(/[^A-Za-z0-9._-]/g, '') || 'release';
const LAUNCHER_VERSION = require('../../../package.json').version;

function expand(list, vars, features) {
  const sub = (s) => s.replace(/\$\{([^}]+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(sub(item));
    } else if (rulesAllow(item.rules, features)) {
      for (const v of [].concat(item.value)) out.push(sub(v));
    }
  }
  return out;
}

/**
 * Składa polecenie uruchomienia. `joinServer` (np. "mc.example.com:25565") włącza szybkie
 * dołączanie - gra od razu łączy się z serwerem (argumenty --quickPlayMultiplayer).
 */
function buildCommand({ instance, account, prep, config, joinServer = '', extraJvm = [] }) {
  const gameDir = paths.gameDir(instance.id);
  const memory = Number(instance.memoryMb) || config.memoryMb || 4096;
  const features = {};
  if (joinServer) {
    features.has_quick_plays_support = true;
    features.is_quick_play_multiplayer = true;
  }

  const vars = {
    auth_player_name: account.username,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken || '0',
    auth_session: account.accessToken || '0',
    auth_xuid: '',
    clientid: '',
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    user_properties: '{}',
    // id bazowej wersji Minecrafta (jar klienta na classpath nazywa się jak wersja vanilla).
    version_name: prep.merged._baseId,
    version_type: VERSION_TYPE,
    game_directory: gameDir,
    assets_root: paths.assets(),
    game_assets: path.join(paths.assets(), 'virtual', 'legacy'),
    assets_index_name: prep.assetIndexId,
    natives_directory: prep.nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    library_directory: paths.libraries(),
    classpath_separator: path.delimiter,
    classpath: prep.classpath.join(path.delimiter),
    quickPlayPath: path.join(gameDir, 'quickPlay', 'log.json'),
    quickPlayMultiplayer: joinServer,
  };

  const jvm = expand(prep.merged.arguments?.jvm, vars, features);
  const game = expand(prep.merged.arguments?.game, vars, features);

  // argumenty od gracza: bez agentów, atach, classpath itp. (to jest droga do wstrzykiwania kodu)
  const { args: userJvm, removed: removedJvm } = anticheat.sanitizeJvmArgs(
    splitArgs([config.jvmArgs, instance.jvmArgs].filter(Boolean).join(' ')),
  );
  const javaMajor = Number(prep.merged?.javaVersion?.majorVersion) || 21;
  const tuning = config.optimizeJvm === false ? [] : tuningArgs({ memory, userJvm, javaMajor });
  const before = [
    `-Xmx${memory}M`,
    `-Xms${Math.min(1024, memory)}M`,
    ...anticheat.HARDENING_FLAGS,
    ...extraJvm, // wbudowany komponent launchera (-Dfabric.addMods / -Dloader.addMods)
    ...badgeProperties(),
    ...tuning,
    ...userJvm,
    ...(prep.loggingArg ? [prep.loggingArg] : []),
    ...jvm,
  ];
  const args = [...before, prep.merged.mainClass, ...game];

  const javaPath = instance.javaPath || config.javaPath || prep.javaExe;
  // prawdziwy token (konto Microsoft) - nie może trafić do linii poleceń procesu ani do logów
  const secrets = account.type === 'microsoft' && account.accessToken ? [account.accessToken] : [];
  return { javaPath, args, cwd: gameDir, removedJvm, secrets, mainIndex: before.length };
}

// ---- token poza linią poleceń ------------------------------------------------------------------------
//
// Linię poleceń procesu widzi Menedżer zadań (kolumna „Wiersz polecenia”), Process Explorer, WMI, dzienniki
// zdarzeń i produkty EDR - a dla gry jest w niej „--accessToken <token>”. Java umie czytać argumenty z pliku
// (@plik), więc do pliku trafia tylko klasa główna i para z tokenem (czysty ASCII - bez ryzyka złego kodowania
// ścieżek), a cała reszta zostaje w linii poleceń dokładnie tak jak wcześniej. Po starcie gry plik jest usuwany.

const ARGFILE_TTL_MS = 45_000; // twardy limit życia pliku z tokenem, gdyby gra nie wypisała nic na wyjście
const ARGFILE_DIR = 'run';
const ASCII_ARG = /^[\x21-\x7e]+$/;

/** Argument do pliku @: w cudzysłowie, z `\\` i `\"` (tak java.exe czyta pliki argumentów). */
const quoteArgFileArg = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Dzieli polecenie na część widoczną w linii poleceń i ukrytą w pliku. Zwraca null, gdy nie ma czego ukrywać
 * albo nie da się tego zrobić bezpiecznie (wtedy gra startuje po staremu).
 */
function splitSecretArgs(command) {
  const { args, secrets, mainIndex } = command;
  if (!secrets?.length || !Number.isInteger(mainIndex) || mainIndex < 0 || mainIndex >= args.length) return null;
  const hasSecret = (a) => secrets.some((s) => a.includes(s));
  if (args.slice(0, mainIndex).some(hasSecret)) return null; // token w opcjach JVM - nie ruszamy

  const mainClass = args[mainIndex];
  const tail = args.slice(mainIndex + 1);
  const hidden = [mainClass];
  const visible = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (secrets.includes(tail[i + 1]) && /^--?[A-Za-z]/.test(a)) {
      hidden.push(a, tail[i + 1]); // „--accessToken” + wartość
      i += 1;
    } else if (hasSecret(a)) {
      hidden.push(a); // np. „--accessToken=<token>”
    } else {
      visible.push(a);
    }
  }
  if (hidden.length === 1 || !hidden.every((a) => ASCII_ARG.test(a))) return null;
  return {
    visible: [...args.slice(0, mainIndex), '@', ...visible], // '@' to miejsce na ścieżkę pliku
    content: `${hidden.map(quoteArgFileArg).join(' ')}\n`,
  };
}

/** Zapisuje plik z ukrytymi argumentami. Zwraca { args, wipe } albo null (start bez ukrywania). */
async function hideSecrets(command) {
  const split = splitSecretArgs(command);
  if (!split) return null;
  const dir = path.join(paths.root(), ARGFILE_DIR);
  try {
    await fsp.mkdir(dir, { recursive: true });
    // pozostałości po awarii launchera (plik żyje kilka sekund, ale proces mógł zginąć przed sprzątaniem);
    // tylko stare - druga gra może właśnie startować (dwa konta naraz) i jej plik jeszcze jest potrzebny
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!/\.args$/.test(name)) continue;
      const old = path.join(dir, name);
      const st = await fsp.stat(old).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 5 * 60_000) await fsp.rm(old, { force: true }).catch(() => {});
    }
    const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.args`);
    await fsp.writeFile(file, split.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const args = split.visible.map((a) => (a === '@' ? `@${file}` : a));
    let done = false;
    const wipe = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fsp.rm(file, { force: true }).catch(() => {});
    };
    const timer = setTimeout(wipe, ARGFILE_TTL_MS);
    timer.unref?.();
    return { args, wipe };
  } catch {
    return null; // bez pliku gra i tak wystartuje - tylko z tokenem w linii poleceń, jak dawniej
  }
}

/**
 * hs_err_pid*.log (awaria samego JVM) zawiera pełną linię poleceń z tokenem, a ludzie wklejają takie pliki na
 * fora. Po zamknięciu gry zamazujemy token w plikach z tej sesji. Zwraca liczbę poprawionych plików.
 */
async function scrubCrashFiles(gameDir, secrets, since = 0) {
  if (!secrets?.length) return 0;
  const MAX_BYTES = 64 * 1024 * 1024;
  let fixed = 0;
  for (const dir of [gameDir, path.join(gameDir, 'crash-reports'), path.join(gameDir, 'logs')]) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!/^(?:hs_err_pid\d+\.log|crash-.+\.txt|latest\.log)$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile() || st.size > MAX_BYTES || st.mtimeMs < since - 5000) continue;
        const text = await fsp.readFile(file, 'latin1'); // bajt w bajt - tylko ASCII-owy token jest podmieniany
        const clean = redact(text, secrets);
        if (clean !== text) {
          await fsp.writeFile(file, clean, 'latin1');
          fixed += 1;
        }
      } catch {
        /* plik zajęty albo zniknął - pomijamy */
      }
    }
  }
  return fixed;
}

async function run(command, { onLine, onExit }) {
  await fsp.mkdir(command.cwd, { recursive: true });
  const hidden = await hideSecrets(command);
  const wipe = () => hidden?.wipe();
  const gameArgs = hidden ? hidden.args : command.args;
  // bez JAVA_TOOL_OPTIONS i podobnych: przez nie Java ładuje agenty bez wiedzy launchera;
  // bez zmiennych z cudzymi sekretami (tokeny, klucze API) - mody gry nie mają ich czytać
  const gameEnv = anticheat.scrubEnv(process.env);
  // Windows: proces gry od urodzenia z blokadą wstrzykiwania kodu (native-spawn.js); gdy się nie da - zwykły start
  // (game.js zakłada wtedy blokadę zaraz po starcie)
  const child =
    (await nativeSpawn.start({ file: command.javaPath, args: gameArgs, cwd: command.cwd, env: gameEnv }).catch(() => null)) ||
    spawn(command.javaPath, gameArgs, {
      cwd: command.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gameEnv,
    });

  const feed = (buf) => {
    wipe(); // pierwsze wyjście = JVM przeczytała już plik argumentów
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (line.length) onLine(line);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', (err) => {
    wipe();
    onLine(`[CrownLauncher] Nie udało się uruchomić Javy: ${err.message}`);
    onExit(-1);
  });
  child.on('close', (code) => {
    wipe();
    onExit(code ?? -1);
  });
  return child;
}

module.exports = { buildCommand, run, splitSecretArgs, scrubCrashFiles, badgeProperties, LAUNCHER_NAME, LAUNCHER_VERSION };
