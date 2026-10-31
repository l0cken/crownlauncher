// Tworzy losowy klucz administratora środowiska Cloudflare i zapisuje go w dwóch miejscach, NIGDY go nie wypisując:
//   1) lokalnie, szyfrowany DPAPI Windowsa: %USERPROFILE%\.crownlauncher-cf-<środowisko>-admin-key (jak klucz admin VPS-a),
//   2) jako sekret Workera BOOTSTRAP_ADMIN_KEY (pierwszy klucz admin tworzy się z niego, gdy w Workerze nie ma żadnych kluczy).
// Użycie: node cloudflare/scripts/set-admin-key.js [test|production]   (domyślnie test; Worker musi już być wdrożony)
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const target = process.argv[2] || 'test';
if (!['test', 'production'].includes(target)) throw new Error('Środowisko: test albo production');
const file = path.join(os.homedir(), `.crownlauncher-cf-${target}-admin-key`);
const key = `crown_${crypto.randomBytes(32).toString('base64url')}`;

const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', '$s = ConvertTo-SecureString $env:CROWN_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -LiteralPath $env:CROWN_SECRET_FILE -Encoding ascii'],
  { env: { ...process.env, CROWN_SECRET: key, CROWN_SECRET_FILE: file }, encoding: 'utf8' },
);
if (ps.status !== 0) throw new Error(`Nie udało się zapisać klucza (DPAPI): ${ps.stderr}`);

const wrangler = path.join(__dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const args = [wrangler, 'secret', 'put', 'BOOTSTRAP_ADMIN_KEY', ...(target === 'production' ? ['--env', 'production'] : [])];
const put = spawnSync(process.execPath, args, { cwd: path.join(__dirname, '..'), input: key, encoding: 'utf8' });
if (put.status !== 0) throw new Error(`wrangler secret put nie powiódł się: ${(put.stderr || put.stdout || '').split('\n').slice(-6).join('\n')}`);
console.log(`Klucz administratora (${target}) zapisany: ${file} (DPAPI) i jako sekret Workera. Nie jest wypisywany.`);
console.log('Uwaga: sekret działa tylko do utworzenia pierwszego klucza; po imporcie danych klucze pochodzą z bazy.');
