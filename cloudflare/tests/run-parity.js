// Uruchamia testy serwera z dev-tests na backendzie Cloudflare (CROWN_BACKEND=cf → Worker na `wrangler dev` przez server-shim.js)
// jeden po drugim i wypisuje podsumowanie. Użycie: node cloudflare/tests/run-parity.js [nazwa-testu …]
const { spawnSync } = require('child_process');
const path = require('path');

const ALL = ['invite-test', 'invite-panel-test', 'capes-access-test', 'client-access-test', 'event-test', 'capes-server-test', 'panel-ui-test'];
const wanted = process.argv.slice(2);
const tests = wanted.length ? wanted : ALL;
const root = path.join(__dirname, '..', '..');

const rows = [];
for (const t of tests) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'dev-tests', `${t}.js`)], { env: { ...process.env, CROWN_BACKEND: 'cf' }, encoding: 'utf8', timeout: 600_000 });
  const line = (r.stdout + r.stderr).split('\n').filter((l) => /WSZYSTKO OK|FAIL/.test(l)).slice(0, 2).join(' | ');
  rows.push({ t, ok: r.status === 0, sec: Math.round((Date.now() - t0) / 1000), line });
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${t.padEnd(22)} ${String(rows.at(-1).sec).padStart(4)} s  ${line.slice(0, 110)}`);
}
const bad = rows.filter((x) => !x.ok);
console.log(bad.length ? `\n${bad.length} z ${rows.length} testów nie przeszło` : `\nWSZYSTKO OK (${rows.length} testów na backendzie Cloudflare)`);
process.exit(bad.length ? 1 : 0);
