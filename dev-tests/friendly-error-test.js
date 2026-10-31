// Komunikaty błędów plików po ludzku (zamiast „EBUSY: resource busy or locked, rename '…'”).
const assert = require('assert');
const { friendlyFsError } = require('C:/Users/meabx/Desktop/CrownLauncher/src/main/core/util.js');

const busy = Object.assign(
  new Error("EBUSY: resource busy or locked, rename 'C:\\x\\mods\\a.jar' -> 'C:\\x\\mods\\a.jar.disabled'"),
  { code: 'EBUSY', syscall: 'rename' },
);
const text = friendlyFsError(busy);
assert.ok(!/EBUSY|rename|C:\\/.test(text), 'bez kodu błędu i ścieżek');
assert.match(text, /Zamknij grę/);
assert.match(text, /używany/);

const perm = Object.assign(new Error("EPERM: operation not permitted, unlink 'C:\\x.jar'"), { code: 'EPERM', syscall: 'unlink' });
assert.match(friendlyFsError(perm), /Zamknij grę/);
assert.ok(!/EPERM/.test(friendlyFsError(perm)));

assert.strictEqual(friendlyFsError(new Error('Zwykły błąd')), 'Zwykły błąd');
assert.strictEqual(friendlyFsError('tekst'), 'tekst');
console.log('OK friendlyFsError: EBUSY/EPERM po polsku, inne błędy bez zmian');
