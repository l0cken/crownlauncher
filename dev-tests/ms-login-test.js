// Logowanie Microsoft (kod urządzenia): komunikaty błędów po polsku na atrapie endpointów Microsoftu.
// Uruchomienie: node dev-tests/ms-login-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

(async () => {
  require(root + 'src/main/core/paths.js').init(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-ms-')));
  Object.assign(require(root + 'src/main/core/app-config.js'), { MS_CLIENT_ID: '' });
  const auth = require(root + 'src/main/core/auth.js');

  // ---- tłumaczenie błędów ----
  const interaction = {
    error: 'interaction_required',
    error_description:
      'The user could not be authenticated or user interaction is required. The user must sign in again and if needed grant the client application access to the requested scope.\r\nTrace ID: x',
  };
  const msg = auth.explainTokenError(interaction);
  assert.match(msg, /wymaga dodatkowego kroku/);
  assert.match(msg, /okn\w+ prywatnym/);
  assert.match(msg, /account\.microsoft\.com/);
  assert.match(msg, /kod: interaction_required/);
  assert.ok(!/Trace ID/.test(msg), 'bez śladu z odpowiedzi Microsoftu');
  // sam opis bez kodu też jest rozpoznawany
  assert.match(auth.explainTokenError({ error_description: interaction.error_description }), /wymaga dodatkowego kroku/);
  assert.match(auth.explainTokenError({ error: 'invalid_grant' }), /został już użyty albo wygasł/);
  assert.strictEqual(auth.explainTokenError({ error: 'something', error_description: 'Inny błąd.\r\nTrace' }), 'Inny błąd.');
  assert.strictEqual(auth.explainTokenError({}), 'Logowanie nie powiodło się.');
  ok('explainTokenError: „user interaction is required” → polska wskazówka z kodem; invalid_grant; inne bez zmian');

  // ---- cały przepływ na atrapie: kod urządzenia OK, a token kończy się odmową ----
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('oauth20_connect.srf')) {
      return json(200, { device_code: 'DEV', user_code: 'ABCD1234', verification_uri: 'https://www.microsoft.com/link', expires_in: 900, interval: 1 });
    }
    if (String(url).includes('oauth20_token.srf')) return json(400, interaction);
    return realFetch(url, opts);
  };
  let shown = null;
  try {
    await assert.rejects(
      auth.loginMicrosoft((code) => { shown = code; }, {}),
      (e) => /wymaga dodatkowego kroku/.test(e.message) && /kod: interaction_required/.test(e.message),
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.strictEqual(shown.userCode, 'ABCD1234');
  assert.ok(calls.some((u) => u.includes('oauth20_token.srf')));
  ok('logowanie (wbudowany przepływ live): odmowa tokenu pokazuje polską wskazówkę zamiast surowego angielskiego tekstu');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
