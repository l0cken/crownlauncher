const assert = require('assert');
const util = require('C:/Users/meabx/Desktop/CrownLauncher/src/main/core/util.js');
let calls = 0;
global.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }); };
(async () => {
  const t0 = Date.now();
  await assert.rejects(() => util.fetchRetry('https://api.modrinth.com/v2/search'), (e) => {
    assert.match(e.message, /api\.modrinth\.com chwilowo ogranicza liczbę zapytań \(HTTP 429\)/);
    assert.strictEqual(e.status, 429);
    return true;
  });
  assert.strictEqual(calls, 3, 'trzy próby');
  assert.ok(Date.now() - t0 >= 4000, 'odstępy między próbami przy 429 są dłuższe niż zwykle');
  // powodzenie po jednym 429
  calls = 0;
  global.fetch = async () => (++calls === 1 ? new Response('', { status: 429 }) : new Response('{"ok":true}', { status: 200 }));
  const res = await util.fetchRetry('https://api.modrinth.com/v2/x');
  assert.strictEqual(res.status, 200);
  // 503
  global.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(() => util.fetchRetry('https://example.org/a', {}, 1), /nie odpowiada poprawnie \(HTTP 503\)/);
  console.log('OK fetchRetry: Retry-After/dłuższy odstęp przy 429, czytelny komunikat z nazwą serwera, powrót po jednym 429, 5xx');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });