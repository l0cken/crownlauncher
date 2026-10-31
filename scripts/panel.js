#!/usr/bin/env node
/**
 * Otwiera panel administratora serwera (klucze zaproszeń) w przeglądarce - bez wpisywania klucza admin.
 *
 *   npm run panel            otwiera https://<serwer>/admin zalogowany (jednorazowy bilet ważny 60 s)
 *   npm run panel -- --check tylko sprawdza, że logowanie działa (nic nie otwiera)
 *
 * Klucz admin: CROWN_ADMIN_KEY albo plik %USERPROFILE%\.crownlauncher-admin-key (szyfrowany DPAPI, ten sam co
 * dla `npm run release`). Adres serwera: ANNOUNCEMENTS_URL z app-config.js albo CROWN_SERVER.
 * Bilet jest wymieniany na sesję w ciasteczku (HttpOnly, 8 h) - klucz admin nie trafia do przeglądarki.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const appConfig = require(path.join(root, 'src/main/core/app-config'));
const args = process.argv.slice(2);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** Sekret zapisany raz na komputerze (szyfrowany DPAPI Windowsa) - jak token w scripts/release.js. */
function storedSecret(fileName) {
  if (process.platform !== 'win32') return '';
  const file = path.join(process.env.USERPROFILE || require('os').homedir(), fileName);
  if (!fs.existsSync(file)) return '';
  const script =
    '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_SECRET_FILE).Trim(); ' +
    '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, CROWN_SECRET_FILE: file },
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

const server = String(process.env.CROWN_SERVER || appConfig.ANNOUNCEMENTS_URL || '').replace(/\/+$/, '');
const key = process.env.CROWN_ADMIN_KEY || storedSecret('.crownlauncher-admin-key');
if (!server) fail('Brak adresu serwera. Ustaw ANNOUNCEMENTS_URL w src/main/core/app-config.js albo CROWN_SERVER.');
if (!key) fail('Brak klucza administratora (CROWN_ADMIN_KEY albo plik %USERPROFILE%\\.crownlauncher-admin-key).');
if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(server)) {
  fail('Serwer musi mieć adres https:// (http:// tylko dla localhost) - klucz nie może iść jawnym tekstem.');
}

(async () => {
  const res = await fetch(`${server}/v1/admin/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 401) fail('Serwer odrzucił klucz administratora (401). Czy klucz nie został unieważniony?');
  if (!res.ok) fail(`Serwer odpowiedział błędem HTTP ${res.status}.`);
  const { ticket } = await res.json();

  if (args.includes('--check')) {
    // wymieniamy bilet na sesję tak, jak zrobi to przeglądarka, i czytamy listę kluczy
    const ex = await fetch(`${server}/v1/admin/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Crown-Panel': '1' },
      body: JSON.stringify({ ticket }),
    });
    const cookie = String(ex.headers.get('set-cookie') || '').split(';')[0];
    if (!ex.ok || !cookie) fail(`Wymiana biletu na sesję nie powiodła się (HTTP ${ex.status}).`);
    const list = await fetch(`${server}/v1/admin/invites`, { headers: { Cookie: cookie, 'X-Crown-Panel': '1' } });
    if (!list.ok) fail(`Odczyt listy kluczy nie powiódł się (HTTP ${list.status}).`);
    const { invites } = await list.json();
    console.log(`✓ Panel działa: ${server}/admin (kluczy: ${invites.length}).`);
    return;
  }

  const url = `${server}/admin?ticket=${encodeURIComponent(ticket)}`;
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { stdio: 'ignore' });
  else spawnSync('open', [url], { stdio: 'ignore' });
  console.log(`✓ Otwieram panel: ${server}/admin  (bilet jednorazowy, ważny 60 s)`);
})().catch((e) => fail(e.message));
