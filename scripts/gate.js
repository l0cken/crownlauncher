#!/usr/bin/env node
/**
 * Bramka serwera gry („na serwer tylko z CrownLaunchera”) - obsługa po stronie administratora.
 *
 *   npm run gate -- status               czy klucz bramki jest ustawiony + kto gra teraz z launchera (aktywne sesje)
 *   npm run gate -- klucz                wydaje NOWY klucz bramki (poprzedni przestaje działać) i wypisuje go raz
 *   npm run gate -- klucz --plik <plik>  to samo, ale zapisuje linię „klucz=gate_…” do pliku (nic nie wypisuje) -
 *                                        np. do wklejenia w plugins/crowngate/config.properties na proxy
 *   npm run gate -- zdejmij <nick>       zdejmuje sesję gracza (kolejne wejście na serwer będzie odrzucone,
 *                                        dopóki launcher gracza nie zgłosi jej znowu - co najwyżej po minucie)
 *
 * Klucz bramki ma plugin CrownGate na proxy Minecrafta i służy tylko do pytania „czy ten nick gra z launchera”.
 * Klucz admin: CROWN_ADMIN_KEY albo plik %USERPROFILE%\.crownlauncher-admin-key (DPAPI, jak `npm run release`).
 * Adres serwera: ANNOUNCEMENTS_URL z app-config.js albo CROWN_SERVER.
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

/** Sekret zapisany raz na komputerze (szyfrowany DPAPI Windowsa) - jak w scripts/panel.js. */
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
const adminKey = process.env.CROWN_ADMIN_KEY || storedSecret('.crownlauncher-admin-key');
if (!server) fail('Brak adresu serwera. Ustaw ANNOUNCEMENTS_URL w src/main/core/app-config.js albo CROWN_SERVER.');
if (!adminKey) fail('Brak klucza administratora (CROWN_ADMIN_KEY albo plik %USERPROFILE%\\.crownlauncher-admin-key).');
if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(server)) {
  fail('Serwer musi mieć adres https:// (http:// tylko dla localhost) - klucz nie może iść jawnym tekstem.');
}

async function call(method, route) {
  const res = await fetch(`${server}${route}`, { method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' } });
  if (res.status === 401) fail('Serwer odrzucił klucz administratora (401). Czy klucz nie został unieważniony?');
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  const [cmd = 'status', ...rest] = args;

  if (cmd === 'status') {
    const { status, body } = await call('GET', '/v1/admin/gate');
    if (status === 404) fail('Ten serwer nie zna jeszcze bramki (wdróż wersję serwera z bramką).');
    if (status !== 200) fail(`Serwer odpowiedział błędem HTTP ${status}.`);
    console.log(body.keySet ? `✓ Klucz bramki ustawiony (od ${body.keyCreatedAt}).` : '! Klucz bramki NIE jest ustawiony - wydaj go: npm run gate -- klucz');
    console.log(`Aktywne sesje z launchera (${body.sessions.length}), sesja wygasa ${body.ttl} s po ostatnim zgłoszeniu:`);
    for (const s of body.sessions) console.log(`  ${s.nick.padEnd(16)} klucz: ${s.by || '-'}  od ${s.since}  (wygasa za ${s.expiresIn} s)`);
    return;
  }

  if (cmd === 'klucz') {
    const { status, body } = await call('POST', '/v1/admin/gate/key');
    if (status !== 201) fail(`Nie udało się wydać klucza (HTTP ${status}${body.error ? `: ${body.error}` : ''}).`);
    const i = rest.indexOf('--plik');
    if (i >= 0 && rest[i + 1]) {
      fs.writeFileSync(rest[i + 1], `klucz=${body.key}\n`, 'utf8');
      console.log(`✓ Nowy klucz bramki zapisany w ${rest[i + 1]} (poprzedni przestał działać).`);
    } else {
      console.log('✓ Nowy klucz bramki (pokazany tylko raz; poprzedni przestał działać) - wklej go w plugins/crowngate/config.properties jako klucz=…:\n');
      console.log(`  ${body.key}\n`);
    }
    return;
  }

  if (cmd === 'zdejmij') {
    const nick = rest[0] || '';
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) fail('Użycie: npm run gate -- zdejmij <nick>');
    const { status } = await call('DELETE', `/v1/admin/play/${nick}`);
    if (status === 404) fail(`${nick} nie ma teraz sesji.`);
    if (status !== 200) fail(`Serwer odpowiedział błędem HTTP ${status}.`);
    console.log(`✓ Zdjęto sesję ${nick}.`);
    return;
  }

  fail('Polecenia: status | klucz [--plik <plik>] | zdejmij <nick>');
})().catch((e) => fail(e.message));
