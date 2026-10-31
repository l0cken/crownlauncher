const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const paths = require('./paths');

/**
 * Natywny start gry (Windows): proces gry powstaje z blokadą wstrzykiwania kodu już w CreateProcess - lista praw dostępu
 * (DACL) bez prawa do tworzenia wątków i zapisu pamięci oraz mitygacja „extension point disable” (brak wstrzykiwania DLL
 * globalnymi hakami okien i AppInit_DLLs). Node tego nie potrafi, więc start robi malutki pomocnik CrownSpawn
 * (src/main/native/CrownSpawn.cs), który launcher kompiluje wbudowanym csc.exe (.NET Framework 4 jest w każdym Windowsie
 * 10/11) przy każdym swoim starcie. Pomocnik pośredniczy też w wyjściu gry i kodzie zakończenia, a ma pełny uchwyt do gry,
 * więc dostarcza nadzorowi bibliotek ich listę mimo zablokowanego dostępu.
 *
 * Brak pomocnika (csc, antywirus, polityka systemu) nigdy nie blokuje gry: start() zwraca null, a launch.run() startuje po
 * staremu i zakłada blokadę zaraz po starcie (anticheat.hardenProcess).
 */

const SOURCE = path.join(__dirname, '..', 'native', 'CrownSpawn.cs');
const PID_TIMEOUT_MS = 20_000;

let helperPromise = null;
let helperHash = ''; // SHA-256 pomocnika skompilowanego w tym uruchomieniu (tylko w pamięci)
let helperOverride; // tylko testy: ścieżka pomocnika albo null (brak)

function cscPath() {
  const win = process.env.windir || process.env.SystemRoot || 'C:\\Windows';
  const dirs = process.arch === 'ia32' ? ['Framework', 'Framework64'] : ['Framework64', 'Framework'];
  for (const d of dirs) {
    const p = path.join(win, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function compile(csc, src, out) {
  return new Promise((resolve) => {
    execFile(
      csc,
      ['-nologo', '-target:exe', '-optimize+', '-platform:anycpu', '-debug-', `-out:${out}`, src],
      { windowsHide: true, timeout: 90_000 },
      (err) => resolve(!err && fs.existsSync(out)),
    );
  });
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Ścieżka do skompilowanego pomocnika albo null. Kompilacja jest tania (~0,3 s), więc pomocnik powstaje na nowo przy KAŻDYM
 * starcie launchera pod losową nazwą, a jego skrót SHA-256 zostaje tylko w pamięci i jest sprawdzany przed każdą grą
 * (start()). Dzięki temu nie ma gotowego pliku w cache, który gracz mógłby podmienić na pomocnika uruchamiającego grę bez
 * blokady - podmiana w trakcie pracy launchera kończy się startem zapasowym (zwykły spawn + blokada po starcie).
 */
function ensureHelper() {
  if (helperOverride !== undefined) return Promise.resolve(helperOverride);
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!paths.root()) return Promise.resolve(null); // katalog danych jeszcze nie ustawiony - nie zapamiętujemy porażki
  if (helperPromise) return helperPromise;
  helperPromise = (async () => {
    try {
      const csc = cscPath();
      if (!csc) return null;
      const source = fs.readFileSync(SOURCE);
      const dir = paths.cache();
      fs.mkdirSync(dir, { recursive: true });
      const tag = `${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}-${crypto.randomBytes(4).toString('hex')}`;
      const exe = path.join(dir, `CrownSpawn-${tag}.exe`);
      const srcFile = path.join(dir, `CrownSpawn-${tag}.cs`);
      fs.writeFileSync(srcFile, source);
      const ok = await compile(csc, srcFile, exe);
      fs.rmSync(srcFile, { force: true });
      if (!ok) {
        fs.rmSync(exe, { force: true });
        return null;
      }
      helperHash = sha256File(exe);
      // pozostałości po poprzednich uruchomieniach (używany przez trwającą grę plik się nie usunie - zostanie na później)
      for (const name of fs.readdirSync(dir)) {
        if (/^CrownSpawn-[0-9a-f]{12}-[0-9a-f]{8}\.(?:exe|cs)$/.test(name) && !name.includes(tag)) {
          try {
            fs.rmSync(path.join(dir, name), { force: true });
          } catch {
            /* w użyciu */
          }
        }
      }
      return exe;
    } catch {
      return null;
    }
  })();
  return helperPromise;
}

/** Czy plik pomocnika nadal jest tym, który skompilowaliśmy w tym uruchomieniu launchera. */
function helperIntact(exe) {
  if (helperOverride !== undefined) return true; // testy podają własną ścieżkę
  try {
    return Boolean(helperHash) && sha256File(exe) === helperHash;
  } catch {
    return false;
  }
}

/** Kompilacja w tle zaraz po starcie launchera, żeby pierwsza gra nie czekała. */
function prepare() {
  ensureHelper().catch(() => {});
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** Udaje ChildProcess w tym zakresie, którego używa launch.js/game.js: pid, stdout, stderr, on('close'), kill(). */
class NativeChild extends EventEmitter {
  constructor(helper, info) {
    super();
    this.helper = helper;
    this.pid = info.pid;
    this.stdout = helper.stdout; // wyjście gry (stdout i stderr razem)
    this.stderr = new PassThrough(); // pusty: wszystko idzie jednym strumieniem
    this.stderr.end();
    this.crownGuard = info.guard; // proces od urodzenia zamknięty na wstrzykiwanie (sprawdzone przez pomocnika)
    this.crownExt = info.ext; // mitygacja haków systemowych aktywna
    this.exitCode = null;
    this.closed = false;
    // biblioteki załadowane w grze, wyliczane przez pomocnika (pełny uchwyt) - działa mimo blokady dostępu; pasuje do watchProcess
    this.modulePaths = new Set();
    this.getModules = async () => [...this.modulePaths];
    this.getNames = async () => [...this.modulePaths].map((p) => path.basename(p).toLowerCase());
  }

  kill() {
    // pomocnik ma pełny uchwyt do gry; process.kill to drugie, niezależne zabezpieczenie (TERMINATE zostaje w DACL)
    try {
      this.helper.stdin.write('kill\n');
    } catch {
      /* pomocnik już nie żyje */
    }
    try {
      process.kill(this.pid);
    } catch {
      /* proces już zakończony */
    }
    return true;
  }
}

/**
 * Startuje grę przez pomocnika. Zwraca NativeChild albo null (wtedy wołający startuje zwykłym spawn).
 * Przed zwróceniem NativeChild gra już działa i ma blokadę dostępu.
 */
async function start({ file, args = [], cwd, env = process.env, timeoutMs = PID_TIMEOUT_MS }) {
  const exe = await ensureHelper().catch(() => null);
  if (!exe || !helperIntact(exe)) return null; // brak albo podmieniony pomocnik: start zapasowy
  return new Promise((resolve) => {
    let helper;
    try {
      helper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    let child = null;
    let settled = false;
    let exitCode = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value) {
        try {
          helper.kill();
        } catch {
          /* ignoruj */
        }
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    timer.unref?.();

    helper.on('error', () => settle(null));
    helper.stdin.on('error', () => {}); // pomocnik mógł się zamknąć - to nie błąd launchera
    helper.on('close', () => {
      if (!settled) return settle(null);
      if (child && !child.closed) {
        child.closed = true;
        if (exitCode === null) {
          // pomocnik zginął bez raportu o końcu gry: gra bez pośrednika nie ma już dokąd pisać - kończymy ją
          try {
            process.kill(child.pid);
          } catch {
            /* już jej nie ma */
          }
        }
        child.emit('close', exitCode === null ? -1 : exitCode);
      }
    });

    let buf = '';
    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const pid = /^PID (\d+) guard=([01]) ext=([01])$/.exec(line);
        if (pid && !child) {
          child = new NativeChild(helper, { pid: Number(pid[1]), guard: pid[2] === '1', ext: pid[3] === '1' });
          settle(child);
        } else if (/^ERR /.test(line) && !child) {
          settle(null);
        } else {
          const mod = /^MOD([+-]) (\S+)$/.exec(line);
          if (mod && child) {
            const p = Buffer.from(mod[2], 'base64').toString('utf8');
            if (mod[1] === '+') child.modulePaths.add(p);
            else child.modulePaths.delete(p);
          } else {
            const ex = /^EXIT (\d+)$/.exec(line);
            if (ex) exitCode = Number(ex[1]);
          }
        }
      }
    });

    try {
      const lines = [`exe ${b64(file)}`, `cwd ${b64(cwd || process.cwd())}`];
      for (const a of args) lines.push(`arg ${b64(a)}`);
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string' && k) lines.push(`env ${b64(`${k}=${v}`)}`);
      }
      lines.push('go');
      helper.stdin.write(`${lines.join('\n')}\n`); // stdin zostaje otwarte: potem tędy idzie „kill”
    } catch {
      settle(null);
    }
  });
}

module.exports = {
  start,
  prepare,
  ensureHelper,
  // tylko testy
  _setHelperForTests(p) {
    helperOverride = p;
  },
  _reset() {
    helperOverride = undefined;
    helperPromise = null;
    helperHash = '';
  },
};
