// Pilnuje procesu testowego: server-shim co 400 ms zapisuje „puls” w pliku. Gdy puls zniknie (test zabił shim przez proc.kill(),
// a po TerminateProcess nie ma już kto posprzątać), kończymy całe drzewo `wrangler dev` (wrangler + workerd), żeby nie zostawały
// sieroty i blokady plików. (Samo sprawdzanie, czy rodzic żyje, nie wystarcza: proces zabity, którego uchwyt trzyma jeszcze
// proces testowy, wciąż „istnieje”.) Argumenty: <plik pulsu> <pid wranglera>.
const fs = require('fs');
const { spawnSync } = require('child_process');

const [beat, childArg] = process.argv.slice(2);
const child = Number(childArg);
const STALE_MS = 2000;

const timer = setInterval(() => {
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(beat).mtimeMs;
  } catch {
    /* brak pliku = shim zniknął */
  }
  if (age < STALE_MS) return;
  clearInterval(timer);
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child, 'SIGKILL');
    } catch {
      /* już zakończony */
    }
  }
  try {
    fs.rmSync(beat, { force: true });
  } catch {
    /* nieistotne */
  }
  process.exit(0);
}, 500);
