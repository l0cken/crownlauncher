/**
 * Ograniczenia launchera:
 *  1. tryb wydarzenia - klucz z profilem (np. „igrzyska”) jest jedynym kluczem gracza: zablokowane są Instancje,
 *     Serwery, Skiny i Modrinth, a launcher służy tylko do gry w instancji wydarzenia (patrz event.js),
 *  2. instancja wydarzenia (`locked`) - nie można zmieniać jej zawartości ani ustawień, także przy pełnym dostępie.
 *
 * Uczciwie: to ograniczenie po stronie launchera (uczciwa gra na wydarzeniu), a nie zabezpieczenie przed kimś, kto
 * zmodyfikuje sam launcher. Pliki wydarzenia i tak są weryfikowane i przywracane przy każdym starcie gry.
 */

const MESSAGE_MODE = 'Ta funkcja jest zablokowana w trybie Igrzysk śmierci.';
const MESSAGE_LOCKED = 'Instancja wydarzenia jest zablokowana - nie można zmieniać jej zawartości ani ustawień.';

// kanały dostępne w trybie wydarzenia (poza kanałami instancji, które sprawdzamy osobno)
const MODE_ALLOW = [/^update:/, /^win:/, /^app:/, /^invite:/, /^accounts:/, /^event:/, /^news:/, /^config:/, /^announce:status$/, /^shell:open-external$/];

// kanały instancji dozwolone tylko dla instancji wydarzenia
const MODE_INSTANCE_ALLOW = new Set(['instances:launch', 'instances:stop', 'instances:logs', 'instances:crash']);

// kanały, których pierwszy argument to id instancji; zmieniają jej zawartość albo ustawienia
const INSTANCE_MUTATING = new Set([
  'instances:update',
  'instances:delete',
  'instances:optimize',
  'instances:open-folder',
  'content:identify',
  'content:update',
  'content:update-all',
  'content:toggle',
  'content:delete',
]);

// kanały, które wynoszą pliki instancji poza launcher - zamknięty zestaw modów wydarzenia nie może z niego wyciec
const INSTANCE_PRIVATE = new Set(['instances:export']);
const MESSAGE_PRIVATE = 'Instancji wydarzenia nie można eksportować - jej zestaw plików jest zamknięty.';

/**
 * Sprawdza wywołanie kanału. Zwraca komunikat błędu (string) albo null, gdy wolno.
 * `ctx.profile` - profil głównego klucza ('' = pełny dostęp), `ctx.eventInstanceId` - id instancji wydarzenia,
 * `ctx.isLocked(id)` - czy instancja jest zablokowana (async; zwraca boolean).
 */
async function check(channel, args, ctx) {
  const id = typeof args?.[0] === 'string' ? args[0] : '';

  if (ctx.profile) {
    if (MODE_INSTANCE_ALLOW.has(channel)) return id && id === ctx.eventInstanceId ? null : MESSAGE_MODE;
    if (channel === 'instances:list' || channel === 'instances:states') return null; // lista jest filtrowana w ipc.js
    if (!MODE_ALLOW.some((re) => re.test(channel))) return MESSAGE_MODE;
  }

  // zawartość zablokowanej instancji nigdy się nie zmienia z poziomu launchera
  if (INSTANCE_MUTATING.has(channel) && id && (await ctx.isLocked(id))) return MESSAGE_LOCKED;
  if (INSTANCE_PRIVATE.has(channel) && id && (await ctx.isLocked(id))) return MESSAGE_PRIVATE;
  if (channel === 'modrinth:install') {
    const target = args?.[0]?.instanceId;
    if (typeof target === 'string' && (await ctx.isLocked(target))) return MESSAGE_LOCKED;
  }
  return null;
}

module.exports = { check, MESSAGE_MODE, MESSAGE_LOCKED };
