const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

/**
 * Ochrona folderów instancji wydarzenia w Windows (mods, resourcepacks, shaderpacks, config, downloads):
 *
 *  1. \`hideDirs\` - atrybuty „Ukryty” + „Systemowy” (attrib +h +s). Sam „Ukryty” znika po „Pokaż ukryte elementy”;
 *     z oboma folder pozostaje niewidoczny także wtedy (pojawia się po wyłączeniu osobnej opcji „Ukryj chronione pliki
 *     systemu operacyjnego”). To tylko ukrycie na liście - wpisanie pełnej ścieżki w pasku adresu nadal wchodzi do folderu.
 *  2. \`setAccess\` - odmowa NTFS dla bieżącego użytkownika (z dziedziczeniem na zawartość): w trybie \`sealed\` nie da się
 *     wejść do folderu ani czytać, zapisywać i usuwać plików także po wpisaniu ścieżki ręcznie (Eksplorator, okna
 *     „Otwórz”, wiersz poleceń); \`readonly\` blokuje tylko tworzenie i nadpisywanie plików; \`open\` zdejmuje blokadę.
 *
 * Launcher zdejmuje blokadę na czas synchronizacji i gry (proces gry działa na tym samym koncie, więc musi mieć
 * dostęp), a zakłada ją po zamknięciu gry i przy starcie launchera. Uczciwie: to ochrona przed zwykłym graczem, nie
 * przed kimś, kto zna uprawnienia NTFS - właściciel plików może przywrócić dostęp we właściwościach folderu, a w
 * trakcie gry foldery są otwarte (tylko mods i resourcepacks bez zapisu).
 *
 * Wszystko jest „best effort”: błąd nie może zatrzymać gry (najwyżej folder zostaje otwarty).
 * Zmienna CROWN_EVENT_NO_SEAL=1 wyłącza zakładanie blokad (dla właściciela, który chce obejrzeć pliki).
 */

const sys32 = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err) => resolve(!err));
  });

const exists = (dir) => fsp.stat(dir).then((st) => st.isDirectory(), () => false);

/** Ukrywa foldery (Ukryty + Systemowy); brakujące tworzy (gra użyje istniejącego). */
async function hideDirs(dirs) {
  if (process.platform !== 'win32') return;
  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await fsp.mkdir(dir, { recursive: true });
        await run(sys32('attrib.exe'), ['+h', '+s', dir]);
      } catch {
        /* ukrycie jest dodatkiem */
      }
    }),
  );
}

let sidPromise = null;
/** SID bieżącego użytkownika (do uprawnień NTFS) albo '' gdy nie da się go ustalić. */
function userSid() {
  if (!sidPromise) {
    sidPromise = new Promise((resolve) => {
      execFile(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }, (err, out) => {
        const m = /"(S-1-[0-9-]+)"/.exec(String(out || ''));
        resolve(!err && m ? m[1] : '');
      });
    });
  }
  return sidPromise;
}

// Prawa odmawiane użytkownikowi. UWAGA: odmowa samego „D” (usuwanie) psuje też odczyt, więc w trybie „readonly”
// jej nie ma - plik można wtedy usunąć, ale nie da się dodać ani podmienić żadnego.
const DENY = {
  sealed: 'RD,REA,X,WD,AD,WEA,DC,D', // listowanie, odczyt, wejście, zapis, dopisywanie, usuwanie
  readonly: 'WD,AD,WEA,DC', // tworzenie plików i folderów, nadpisywanie
};

/**
 * Ustawia dostęp do folderów: 'sealed' | 'readonly' | 'open'. Najpierw zawsze zdejmuje poprzednie odmowy
 * (idempotentnie), potem zakłada nową. Nieistniejące foldery są pomijane.
 */
async function setAccess(dirs, mode) {
  if (mode !== 'open' && process.env.CROWN_EVENT_NO_SEAL === '1') mode = 'open';
  if (process.platform !== 'win32') return;
  const sid = await userSid();
  if (!sid) return; // bez SID lepiej zostawić otwarte niż uszkodzić dostęp
  await Promise.all(
    dirs.map(async (dir) => {
      if (!(await exists(dir))) return;
      await run(sys32('icacls.exe'), [dir, '/remove:d', `*${sid}`, '/C', '/Q']);
      if (mode !== 'open') await run(sys32('icacls.exe'), [dir, '/deny', `*${sid}:(OI)(CI)(${DENY[mode]})`, '/C', '/Q']);
    }),
  );
}

module.exports = { hideDirs, setAccess };
