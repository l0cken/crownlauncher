// Test dymny (cloudflare/tests/smoke.js) na wdrożonym Workerze: klucz admin czyta z pliku DPAPI (nie jest wypisywany).
// Użycie: node cloudflare/scripts/smoke-remote.js [test]  (adres testowego Workera: pierwsza trasa w cloudflare/wrangler.jsonc, losowy)
// UWAGA: test wgrywa próbny instalator 9.9.9 i tworzy próbne klucze - wolno go uruchamiać tylko na środowisku testowym.
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const target = process.argv[2] || 'test';
if (target !== 'test') throw new Error('Test dymny zapisuje dane próbne - dozwolony tylko na środowisku testowym.');
const file = path.join(os.homedir(), `.crownlauncher-cf-${target}-admin-key`);
const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_SECRET_FILE).Trim(); [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
  { env: { ...process.env, CROWN_SECRET_FILE: file }, encoding: 'utf8' },
);
const key = (ps.stdout || '').trim();
if (ps.status !== 0 || !key) throw new Error(`Nie udało się odczytać klucza z ${file}`);

const host = /"routes":\s*\[\{\s*"pattern":\s*"([a-z0-9.-]+)"/.exec(require('fs').readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8'))?.[1];
if (!host) throw new Error('Nie znaleziono adresu testowego Workera w cloudflare/wrangler.jsonc.');

const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tests', 'smoke.js')], {
  env: { ...process.env, SMOKE_BASE: `https://${host}`, SMOKE_ADMIN_KEY: key },
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
