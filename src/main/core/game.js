const fsp = require('fs').promises;
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const servers = require('./servers');
const pinnedServers = require('./pinned-servers');
const bundledMods = require('./bundled-mods');
const discord = require('./discord');
const anticheat = require('./anticheat');
const nativeSpawn = require('./native-spawn');
const performanceMods = require('./performance-mods');
const modCheck = require('./mod-check');
const crashAnalyzer = require('./crash-analyzer');
const crashFixer = require('./crash-fixer');
const capes = require('./capes');
const instances = require('./instances');
const { prepare } = require('./installer');
const { buildCommand, run, scrubCrashFiles } = require('./launch');
const { redact } = require('./util');
const invite = require('./invite');
const gate = require('./gate');
const eventCore = require('./event');

const MAX_LOG_LINES = 3000;

// Minecraft loguje w formacie XML log4j (<log4j:Event>) - zamieniamy zdarzenia na zwykłe linie.
function formatLog4jEvent(xml) {
  const head = xml.slice(0, xml.indexOf('>'));
  const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(head)?.[1] || '';
  const cdata = (tag) =>
    new RegExp(`<log4j:${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></log4j:${tag}>`).exec(xml)?.[1] || '';
  const time = new Date(Number(attr('timestamp')) || Date.now()).toTimeString().slice(0, 8);
  const trace = cdata('Throwable');
  return `[${time}] [${attr('thread')}/${attr('level')}] ${cdata('Message')}${trace ? `\n${trace}` : ''}`;
}

function createLogFormatter(push) {
  let buf = null;
  const flushEvent = () => {
    push(formatLog4jEvent(buf.join('\n')));
    buf = null;
  };
  const feed = (line) => {
    if (buf === null) {
      if (!line.includes('<log4j:Event ')) return push(line);
      buf = [line];
    } else {
      buf.push(line);
    }
    if (line.includes('</log4j:Event>')) flushEvent();
  };
  feed.end = () => {
    if (buf) push(buf.join('\n'));
    buf = null;
  };
  return feed;
}

const running = new Map(); // id -> { child, startedAt }
const installing = new Set();
const logs = new Map(); // id -> string[]
const lastCrash = new Map(); // id -> wynik analizy ostatniej awarii (pokazywany na stronie instancji)

let emit = () => {};

function init(emitFn) {
  emit = emitFn;
  nativeSpawn.prepare(); // pomocnik natywnego startu gry kompiluje się w tle (raz), żeby pierwsza gra nie czekała
}

function setState(id, state) {
  emit('instance:state', { id, state });
}

function states() {
  const out = {};
  for (const id of installing) out[id] = 'installing';
  for (const id of running.keys()) out[id] = 'running';
  return out;
}

function getLogs(id) {
  return logs.get(id) || [];
}

function getLastCrash(id) {
  return lastCrash.get(id) || null;
}

// Pobiera/weryfikuje pliki instancji. Zwraca dane potrzebne do uruchomienia.
// Launcher działa tylko z Fabricem - czytelny komunikat, zanim cokolwiek się pobierze
function assertSupportedLoader(instance) {
  if (instance.loader !== 'fabric') {
    throw new Error(
      `Instancja „${instance.name}” używa loadera ${instance.loader}, który nie jest już obsługiwany. ` +
        'Launcher działa tylko z Fabric — utwórz nową instancję.',
    );
  }
}

/** Instancja gotowa do startu: dawna Vanilla przechodzi na Fabric (CrownClient i peleryny wymagają loadera). */
async function currentInstance(id) {
  let instance = await instances.get(id);
  if (instance.loader === 'vanilla') instance = await instances.useFabric(id);
  assertSupportedLoader(instance);
  return instance;
}

async function ensureInstalled(id) {
  const instance = await currentInstance(id);
  const prep = await prepare(instance, (p) => emit('install:progress', { id, ...p }));
  return { instance, prep };
}

// Instalacja w tle (bez startu gry), np. zaraz po utworzeniu instancji.
async function install(id) {
  if (installing.has(id) || running.has(id)) return;
  installing.add(id);
  setState(id, 'installing');
  try {
    await ensureInstalled(id);
  } finally {
    installing.delete(id);
    setState(id, running.has(id) ? 'running' : 'idle');
  }
}

/** Uruchamia instancję; z `server` gra od razu dołącza do serwera (szybkie dołączanie). */
async function launch(id, { server = '' } = {}) {
  if (running.has(id)) throw new Error('Ta instancja już jest uruchomiona.');
  if (installing.has(id)) throw new Error('Instancja jest w trakcie instalacji.');
  if (server) server = servers.validateAddress(server);

  lastCrash.delete(id); // nowy start - poprzednia awaria nie jest już aktualna
  installing.add(id);
  setState(id, 'installing');
  let command;
  let instance;
  let perfAdded = [];
  let cosmetics = { applied: false };
  let crownClient = true;
  let dupes = [];
  let eventInstance = false; // instancja wydarzenia: foldery są zamknięte poza grą (event.js: seal / protectRunning)
  let account; // konto, na którym startuje gra (jego nick zgłaszamy bramce serwera, patrz gate.js)
  let nativesDir = ''; // natywne biblioteki instancji (LWJGL…): jedyny folder użytkownika, z którego nadzór bibliotek nie podejrzewa nowych plików
  try {
    await invite.assertAllowed(); // prywatna dystrybucja: bez ważnego klucza zaproszenia gra nie startuje
    const target = await currentInstance(id);
    // instancja wydarzenia: pliki muszą zgadzać się z serwerem (dociągnięcie brakujących, usunięcie obcych)
    if (target.locked && target.event) {
      eventInstance = true;
      await eventCore.beforeLaunch(target); // zdejmuje blokadę folderów - zakładamy ją z powrotem przy zamknięciu gry
    }
    // cheaty: zanim cokolwiek pobierzemy, sprawdzamy mody instancji
    await anticheat.assertInstanceClean(id);
    account = await auth.getLaunchAccount();
    const ready = await ensureInstalled(id);
    instance = ready.instance;
    nativesDir = ready.prep?.nativesDir || '';
    // wbudowane mody launchera (CrownClient): ładowane z katalogu launchera, nie z folderu mods
    // wydarzenie może wyłączyć wbudowanego CrownClienta (noCrownClient) - wtedy grają wyłącznie pliki z serwera
    if (!instance.noCrownClient) await bundledMods.ensureBundledMods(instance);
    const bundledJvm = instance.noCrownClient ? [] : await bundledMods.jvmArgs(instance);
    crownClient = bundledJvm.length > 0;
    // korona także przy innych kontach zapisanych w tym launcherze (np. drugie konto na tym samym komputerze)
    const extraJvm = crownClient ? [...bundledJvm, ...capes.localMembersArgs()] : bundledJvm;
    command = buildCommand({ instance, account, prep: ready.prep, config: config.get(), joinServer: server, extraJvm });
    await fsp.mkdir(path.join(command.cwd, 'quickPlay'), { recursive: true });
    // przypięte serwery (np. KORONAMC.PL) na górze listy serwerów w grze
    await pinnedServers.ensurePinned(command.cwd).catch(() => {});
    // mody optymalizujące (Sodium, Lithium…) - jednorazowo na instancję, bez blokowania startu
    perfAdded = instance.locked ? [] : await performanceMods.ensure(instance); // zablokowana instancja nie dostaje własnych modów
    // dwa jary tego samego moda (np. stara i nowa wersja) - Fabric odmawia startu, więc zostaje najnowszy
    dupes = instance.locked ? [] : await modCheck.dedupe(id).catch(() => []);
    // peleryna z biblioteki launchera (CustomSkinLoader) dla nicka tego konta; skin zostaje taki, jaki jest
    // zablokowana instancja nie dostaje obcych modów (CustomSkinLoader) - peleryny z biblioteki tu nie działają
    cosmetics = instance.locked ? { applied: false } : await capes.prepareForLaunch(instance, account.username);
  } catch (e) {
    installing.delete(id);
    setState(id, 'idle');
    if (eventInstance) await eventCore.lockDirs(id).catch(() => {}); // start się nie udał - foldery z powrotem zamknięte
    throw e;
  }
  installing.delete(id);

  const buffer = [];
  // instancja wydarzenia: log (z listą modów i śladami) zostaje w procesie głównym - do analizy awarii, nie do interfejsu
  if (!instance.locked) logs.set(id, buffer);
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    if (!instance.locked) emit('game:log', { id, lines: pending });
    pending = [];
  };
  const secrets = command.secrets || [];
  const push = (text) => {
    // token gry nie trafia do konsoli, bufora logów (analiza awarii) ani do renderera
    for (const line of redact(text, secrets).split('\n')) {
      buffer.push(line);
      if (buffer.length > MAX_LOG_LINES) buffer.shift();
      pending.push(line);
    }
    if (!timer) timer = setTimeout(flush, 150);
  };
  const onLine = createLogFormatter(push);

  const startedAt = Date.now();
  let exited = false;
  let watch = null;
  const onExit = async (code) => {
    if (exited) return;
    exited = true;
    gate.end(id); // koniec gry = koniec sesji na bramce serwera
    watch?.stop();
    onLine.end();
    flush();
    const userStopped = Boolean(running.get(id)?.stopping); // „Zatrzymaj” / zamknięcie launchera to nie awaria
    running.delete(id);
    // raporty awarii JVM (hs_err) zawierają linię poleceń z tokenem - zamazujemy go, zanim ktoś taki plik wklei
    await scrubCrashFiles(command.cwd, secrets, startedAt).catch(() => {});
    // VulkanMod potrafi nie wystartować na starszym sterowniku: gra zamknęła się sama zaraz po starcie -> Sodium
    const quickCrash = !userStopped && code !== 0 && code !== null && Date.now() - startedAt < 90_000;
    if (quickCrash && (await instances.get(id).catch(() => null))?.perfRenderer === 'vulkanmod') {
      if (await performanceMods.fallbackFromVulkan(id)) {
        emit('instance:error', {
          id,
          message: 'Gra z VulkanMod zamknęła się zaraz po starcie - wróciłem do Sodium (OpenGL). Uruchom grę ponownie.',
        });
      }
    }
    if (!running.size) discord.stop();
    // gracz mógł usunąć przypięty serwer w grze - po zamknięciu wraca na górę listy
    await pinnedServers.ensurePinned(command.cwd).catch(() => {});
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    try {
      const fresh = await instances.get(id);
      await instances.update(id, { playTime: (fresh.playTime || 0) + seconds });
    } catch {
      /* instancja mogła zostać usunięta */
    }
    setState(id, 'idle');
    // awaria: który mod ją wywołał (komunikaty Fabrica, mixiny, raport awarii, ślady stosu)
    if (code !== 0 && code !== null && !userStopped) {
      try {
        const analysis = await crashAnalyzer.analyze({ instanceId: id, lines: buffer, startedAt });
        const summary = crashAnalyzer.describe(analysis);
        if (summary || analysis.report) {
          // od razu naprawiamy to, co da się pewnie naprawić (aktualizacja / doinstalowanie / wyłączenie moda)
          let fixed = [];
          if (config.get().autoFixCrashes !== false && !instance.locked) {
            try {
              fixed = (await crashFixer.fix(id, analysis)).fixed;
            } catch {
              /* naprawa jest dodatkiem - bez niej zostaje sama diagnoza */
            }
          }
          lastCrash.set(id, instance.locked ? { at: Date.now(), code } : { at: Date.now(), code, summary, fixed, ...analysis });
          if (summary) onLine(`[CrownLauncher] AWARIA: ${summary}`);
          if (fixed.length) onLine(`[CrownLauncher] NAPRAWA: ${crashFixer.describe({ fixed })}. Uruchom grę ponownie.`);
          flush();
          // instancja wydarzenia: sama informacja o awarii, bez wskazywania modów
          emit('game:crash', instance.locked ? { id, code } : { id, code, summary, suspects: analysis.suspects, cause: analysis.cause, fixed });
        }
      } catch {
        /* analiza jest dodatkiem - błąd nie może zablokować zamknięcia gry */
      }
    }
    // wydarzenie: po analizie awarii (czyta mody) foldery znów nie dają się otworzyć
    if (eventInstance) {
      await eventCore.cleanAfterGame(id).catch(() => {});
      await eventCore.lockDirs(id).catch(() => {});
    }
    emit('game:exit', { id, code });
  };

  onLine(`[CrownLauncher] Uruchamianie ${instance.name} (${instance.mcVersion}, ${instance.loader})`);
  if (!crownClient && !instance.noCrownClient) {
    onLine(`[CrownLauncher] CrownClient nie ma wersji dla Minecrafta ${instance.mcVersion} - korona przed nickiem nie będzie widoczna.`);
  }
  if (server) onLine(`[CrownLauncher] Szybkie dołączanie do serwera ${server}`);
  if (dupes.length) {
    onLine(`[CrownLauncher] Usunięto zdublowane mody (zostaje najnowsza wersja): ${dupes.map((d) => `${d.file} → ${d.kept}`).join(', ')}`);
  }
  if (perfAdded.length) onLine(`[CrownLauncher] Dodano mody optymalizujące: ${perfAdded.join(', ')}`);
  if (cosmetics.applied) {
    onLine(`[CrownLauncher] Peleryny: ${cosmetics.cape ? 'własna peleryna' : 'wspólne peleryny graczy'} (CustomSkinLoader; skin bez zmian)`);
  }
  if (command.removedJvm?.length) {
    onLine(`[CrownLauncher] Usunięto niedozwolone argumenty JVM: ${command.removedJvm.join(' ')}`);
  }
  // wydarzenie: w trakcie gry mods i resourcepacks tylko do odczytu (nikt nie podmieni paczki w locie)
  if (eventInstance) await eventCore.protectRunning(id).catch(() => {});
  // bramka serwera gry („na serwer tylko z launchera”): sesja zgłoszona, zanim gra zdąży połączyć się z serwerem; odnawiana co
  // minutę, dopóki gra działa, zdejmowana w onExit. Brak zgłoszenia nie blokuje startu - najwyżej serwer odmówi wejścia.
  const gated = await gate.begin(id, account, { event: eventInstance ? instance.event || '' : '' }); // instancja wydarzenia zgłasza się kodem wydarzenia
  if (gated.ok === false) {
    onLine(`[CrownLauncher] Uwaga: nie udało się zgłosić sesji gry serwerowi launchera (${gated.message}). Serwery tylko dla CrownLaunchera mogą odmówić wejścia.`);
  }
  let child;
  try {
    child = await run(command, { onLine, onExit });
  } catch (e) {
    gate.end(id);
    if (eventInstance) await eventCore.lockDirs(id).catch(() => {});
    throw e;
  }
  running.set(id, { child, startedAt });

  // blokada wstrzykiwania: żaden program (cheat, nakładka, debugger) nie dostaje prawa do zapisu pamięci ani tworzenia wątków
  // w procesie gry. Natywny start (native-spawn.js) zakłada ją w CreateProcess - od pierwszej chwili, razem z blokadą haków
  // systemowych; gdy pomocnika nie ma, zakładamy ją zaraz po starcie. Nie blokuje gry, a wynik trafia do konsoli.
  if (child.crownGuard) {
    onLine(
      `[CrownLauncher] ANTYCHEAT: proces gry uruchomiony od razu zamknięty na wstrzykiwanie kodu${child.crownExt ? ' (także hakami systemowymi)' : ''}.`,
    );
  } else if (process.platform === 'linux') {
    // Linux nie ma DACL procesu: dostępu do gry pilnuje jądro (Yama), a nadzór bibliotek czyta /proc/<pid>/maps
    anticheat
      .linuxPtraceNote()
      .then((note) => {
        if (note && !exited) onLine(`[CrownLauncher] ${note}`);
      })
      .catch(() => {});
  } else {
    anticheat
      .hardenProcess(child.pid)
      .then((res) => {
        if (res.skipped || exited) return;
        if (res.ok) onLine('[CrownLauncher] ANTYCHEAT: proces gry zabezpieczony przed wstrzykiwaniem kodu.');
        else onLine(`[CrownLauncher] Uwaga: nie udało się zabezpieczyć procesu gry przed wstrzykiwaniem kodu (${res.message}).`);
      })
      .catch(() => {});
  }

  // nadzór: biblioteki wstrzyknięte do procesu gry (DLL) - niepodpisana obca biblioteka kończy grę
  watch = anticheat.watchProcess({
    pid: child.pid,
    javaPath: command.javaPath,
    trustedDirs: nativesDir ? [nativesDir] : [],
    // natywny start: biblioteki dostarcza pomocnik (bez uruchamiania PowerShella), więc można sprawdzać co pół sekundy
    ...(child.getModules ? { getModules: child.getModules, getNames: child.getNames, fastMs: 500 } : {}),
    onViolation: ({ kill, warn }) => {
      const names = (list) => list.map((m) => path.basename(m)).join(', ');
      if (kill.length) {
        onLine(`[CrownLauncher] ANTYCHEAT: wykryto wstrzyknięte biblioteki (${names(kill)}) - zamykam grę.`);
        emit('anticheat:alert', { id, message: `Wykryto wstrzyknięty kod (${names(kill)}). Gra została zamknięta.`, fatal: true });
        if (running.get(id)) running.get(id).stopping = true; // to nie awaria renderera
        child.kill();
      } else {
        onLine(`[CrownLauncher] ANTYCHEAT: nieznana biblioteka w procesie gry (${names(warn)}).`);
        emit('anticheat:alert', { id, message: `Nieznana biblioteka w grze: ${names(warn)}.`, fatal: false });
      }
    },
  });
  if (config.get().discordPresence) discord.start({ instance, server, startedAt });
  await instances.update(id, { lastPlayed: startedAt });
  config.set({ lastInstance: id });
  setState(id, 'running');
  emit('game:started', { id });
}

function stop(id) {
  const entry = running.get(id);
  if (entry) {
    entry.stopping = true;
    entry.child.kill();
  }
}

function stopAll() {
  gate.endAll();
  for (const entry of running.values()) {
    entry.stopping = true;
    entry.child.kill();
  }
}

module.exports = { init, states, getLogs, getLastCrash, install, launch, stop, stopAll };
