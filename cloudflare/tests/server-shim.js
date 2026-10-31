#!/usr/bin/env node
// Zastępnik server/server.js dla testów z dev-tests: ten sam interfejs (zmienne środowiskowe + polecenia CLI), ale backendem jest
// Worker na `wrangler dev` (lokalny R2 i Durable Object). Testy wybierają go zmienną CROWN_BACKEND=cf.
//   bez argumentów: uruchamia Workera i wypisuje „Serwer ogłoszeń CrownLaunchera: …” gdy odpowiada (PORT, HOST, DATA_DIR,
//                   INVITE_ONLY, REQUIRE_DEVICE, MC_HASJOINED_URL jak w server.js; dokumenty z DATA_DIR/*.json trafiają do Workera)
//   z argumentami:  tłumaczy polecenia CLI (create-key, create-invite, list-invites, …) na API admina Workera
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(root, '.test-data');
const BASE = `http://${HOST}:${PORT}`;
const BOOT_FILE = path.join(DATA_DIR, '.cf-boot-key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- tryb serwera ----------------------------------------------------------------------------------
async function serve() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const boot = `crown_${crypto.randomBytes(24).toString('base64url')}`;
  fs.writeFileSync(BOOT_FILE, boot);
  const vars = { BOOTSTRAP_ADMIN_KEY: boot, INVITE_ONLY: process.env.INVITE_ONLY === '1' ? '1' : '0' };
  for (const k of ['REQUIRE_DEVICE', 'MC_HASJOINED_URL', 'PLAY_TTL_MS', 'AVATAR_UPSTREAM']) if (process.env[k]) vars[k] = process.env[k];
  const args = [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--local', '--ip', HOST, '--port', String(PORT),
    '--inspector-port', String(await freePort()), '--persist-to', path.join(DATA_DIR, '.cf-state'), '--log-level', 'error',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ];
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'ignore', windowsHide: true });
  // puls dla watchdoga (patrz watchdog.js): gdy test zabije ten proces, watchdog kończy wrangler i workerd
  const beat = path.join(require('os').tmpdir(), `crown-shim-${process.pid}.beat`);
  const touch = () => fs.writeFileSync(beat, String(Date.now()));
  touch();
  setInterval(touch, 400);
  spawn(process.execPath, [path.join(__dirname, 'watchdog.js'), beat, String(child.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  child.on('exit', (code) => process.exit(code || 1));

  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch { /* jeszcze się uruchamia */ }
    await sleep(500);
  }
  // dokumenty wstawione do DATA_DIR przed startem (np. test migracji dawnego formatu) przenosimy do Workera
  for (const name of ['invites.json', 'keys.json', 'players.json', 'announcements.json', 'blocklist.json']) {
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) continue;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    await api('PUT', `/v1/admin/raw/${encodeURIComponent(name)}`, { value });
  }
  console.log(`Serwer ogłoszeń CrownLaunchera: ${BASE}  (dane: ${DATA_DIR}, backend: Cloudflare Worker)`);
  setInterval(() => {}, 1 << 30);
}

// ---- tryb CLI ---------------------------------------------------------------------------------------
async function api(method, p, body) {
  const key = fs.readFileSync(BOOT_FILE, 'utf8').trim();
  const res = await fetch(`${BASE}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch { /* brak treści */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const LABELS = { unused: 'nieużyty', activated: 'aktywowany', full: 'wykorzystany', expired: 'wygasły', revoked: 'unieważnione' };

async function cli([cmd, ...args]) {
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const onOff = (v, usage) => {
    if (!['on', 'off'].includes(v)) throw new Error(usage);
    return v === 'on';
  };
  const invites = async () => (await api('GET', '/v1/admin/invites')).invites;
  const byId = async (id) => {
    const inv = (await invites()).find((i) => i.id === id);
    if (!inv) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    return inv;
  };

  if (cmd === 'create-key') {
    const name = (args[0] || '').trim();
    const role = args[1] || 'publisher';
    if (!name) throw new Error('Użycie: create-key "Nazwa osoby" [publisher|admin]');
    const k = await api('POST', '/v1/admin/keys', { name, role });
    console.log(`Utworzono klucz dla: ${name} (${role}), id: ${k.id}`);
    console.log(`Klucz (pokazany tylko raz, przekaż go osobie bezpiecznym kanałem):\n\n  ${k.key}\n`);
    return;
  }
  if (cmd === 'list-keys') {
    const { keys } = await api('GET', '/v1/admin/keys');
    if (!keys.length) console.log('Brak kluczy.');
    for (const k of keys) console.log(`${k.id}  ${k.role.padEnd(9)} ${k.revoked ? '[unieważniony] ' : ''}${k.name}  (${k.createdAt.slice(0, 10)})`);
    return;
  }
  if (cmd === 'revoke-key') {
    const r = await api('POST', `/v1/admin/keys/${encodeURIComponent(args[0] || '')}/revoke`);
    console.log(`Unieważniono klucz ${r.id} (${r.name}).`);
    return;
  }
  if (cmd === 'create-invite') {
    const name = (args[0] || '').trim();
    if (!name) throw new Error('Użycie: create-invite "Nazwa osoby"');
    const inv = await api('POST', '/v1/admin/invites', {
      name, maxUses: flag('--uses'), expiresInDays: flag('--days'), note: flag('--note'), profile: flag('--profile'),
      capes: args.includes('--capes') ? true : undefined, disableClient: args.includes('--disable-client') ? true : undefined,
    });
    console.log(`Utworzono zaproszenie dla: ${name}, id: ${inv.id}`);
    console.log('Klucz zaproszenia (pokazany tylko raz, przekaż go tej jednej osobie bezpiecznym kanałem):\n');
    console.log(`  ${inv.key}\n`);
    console.log('Osoba pobiera instalator ze strony głównej serwera i wpisuje ten sam klucz przy pierwszym uruchomieniu.');
    console.log(`Limit użyć (komputerów): ${inv.maxUses === 0 ? 'bez limitu' : inv.maxUses}; wygasa: ${inv.expiresAt ? inv.expiresAt.slice(0, 10) : 'nigdy'}.`);
    return;
  }
  if (cmd === 'list-invites') {
    const list = (await invites()).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!list.length) console.log('Brak zaproszeń.');
    for (const i of list) {
      const seen = i.lastSeenAt ? `ostatnio: ${i.lastSeenAt.slice(0, 16).replace('T', ' ')}` : 'jeszcze nieużyte';
      const uses = `${i.uses}/${i.maxUses === 0 ? '∞' : i.maxUses}`;
      const exp = i.expiresAt ? `, do ${i.expiresAt.slice(0, 10)}` : '';
      const profile = (i.profile ? `, kod wydarzenia: ${i.profile}` : '') + (i.capes ? ', peleryny' : '') + (i.disableClient ? ', może wyłączyć CrownClienta' : '');
      console.log(`${i.id}  [${LABELS[i.status]}] ${i.name}  (użycia ${uses}${exp}${profile}; utworzone ${i.createdAt.slice(0, 10)}, ${seen})`);
    }
    return;
  }
  if (cmd === 'find-invite') {
    const i = await api('POST', '/v1/admin/invites/find', { key: args[0] });
    console.log(`${i.id}  ${i.name}  [${i.status}]  profil: ${i.profile || 'pełny dostęp'}  użycia: ${i.uses}/${i.maxUses === 0 ? '∞' : i.maxUses}`);
    return;
  }
  if (cmd === 'set-profile') {
    const r = await api('POST', `/v1/admin/invites/${encodeURIComponent(args[0] || '')}/update`, { profile: args[1] === '-' ? '' : args[1] });
    console.log(`Profil zaproszenia ${r.invite.id} (${r.invite.name}): ${r.invite.profile || 'pełny dostęp'}.`);
    return;
  }
  if (cmd === 'set-capes') {
    const on = onOff(args[1], 'Użycie: set-capes <id> <on|off>');
    const r = await api('POST', `/v1/admin/invites/${encodeURIComponent(args[0] || '')}/update`, { capes: on });
    console.log(`Peleryny dla zaproszenia ${r.invite.id} (${r.invite.name}): ${on ? 'włączone' : 'wyłączone'}.`);
    return;
  }
  if (cmd === 'set-disable-client') {
    const on = onOff(args[1], 'Użycie: set-disable-client <id> <on|off>');
    const r = await api('POST', `/v1/admin/invites/${encodeURIComponent(args[0] || '')}/update`, { disableClient: on });
    console.log(`Wyłączanie CrownClienta dla zaproszenia ${r.invite.id} (${r.invite.name}): ${on ? 'dozwolone' : 'niedozwolone'}.`);
    return;
  }
  if (cmd === 'release-invite') {
    const r = await api('POST', `/v1/admin/invites/${encodeURIComponent(args[0] || '')}/release`, {});
    console.log(`Zwolniono komputery dla zaproszenia ${r.invite.id} (${r.invite.name}) - klucz można aktywować od nowa.`);
    return;
  }
  if (cmd === 'revoke-invite') {
    const r = await api('POST', `/v1/admin/invites/${encodeURIComponent(args[0] || '')}/revoke`, {});
    console.log(`Unieważniono zaproszenie ${r.invite.id} (${r.invite.name}). Przestanie działać od następnego zapytania.`);
    return;
  }
  throw new Error(`Nieznane polecenie: ${cmd}`);
}

if (process.argv.length > 2) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  serve().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
