// Wspólne pomoce skryptów migracji/eksportu/weryfikacji: adres Workera, klucz admin (DPAPI, nigdy nie wypisywany), klient API admina
// i wgrywanie plików (jedno żądanie albo części R2 multipart). Nic tu nie zapisuje na VPS-ie.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const SINGLE_MAX = 90 * 1024 * 1024; // jedno żądanie przez Cloudflare: maks. 100 MB
const PART = 16 * 1024 * 1024;

/** Sekret zapisany raz na komputerze (szyfrowany DPAPI), jak w scripts/release.js. */
function stored(fileName) {
  const file = path.join(os.homedir(), fileName);
  if (!fs.existsSync(file)) return '';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_SECRET_FILE).Trim(); [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'], {
    encoding: 'utf8',
    env: { ...process.env, CROWN_SECRET_FILE: file },
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/** Losowy adres środowiska testowego z cloudflare/wrangler.jsonc (pierwsza trasa najwyższego poziomu). */
function stageBase() {
  const m = /"routes":\s*\[\{\s*"pattern":\s*"([a-z0-9.-]+)"/.exec(fs.readFileSync(path.join(root, 'cloudflare', 'wrangler.jsonc'), 'utf8'));
  if (!m) throw new Error('Nie znaleziono adresu testowego Workera w cloudflare/wrangler.jsonc.');
  return `https://${m[1]}`;
}

const option = (argv, name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/** Adres Workera z argumentów: --base https://… albo --target test (domyślnie). */
function resolveBase(argv) {
  const b = option(argv, '--base');
  if (b) return b.replace(/\/+$/, '');
  const target = option(argv, '--target', 'test');
  if (target !== 'test') throw new Error('--target: tylko „test”; dla innego Workera podaj --base https://adres');
  return stageBase();
}

/** Klient API admina: pierwszy działający klucz z (CROWN_ADMIN_KEY, klucz admin VPS-a, klucze testowe Workera). */
async function connect(base) {
  const candidates = [
    ['CROWN_ADMIN_KEY', process.env.CROWN_ADMIN_KEY || ''],
    ['klucz admin serwera (.crownlauncher-admin-key)', stored('.crownlauncher-admin-key')],
    ['klucz testowy Workera (.crownlauncher-cf-test-admin-key)', stored('.crownlauncher-cf-test-admin-key')],
    ['klucz produkcyjny Workera (.crownlauncher-cf-production-admin-key)', stored('.crownlauncher-cf-production-admin-key')],
  ].filter(([, k]) => k);
  for (const [label, key] of candidates) {
    const res = await fetch(`${base}/v1/admin/info`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
    if (res && res.ok) {
      const client = {
        base,
        label,
        key,
        headers: (extra = {}) => ({ Authorization: `Bearer ${key}`, ...extra }),
        async api(method, p, body, headers = {}) {
          return fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        },
        async json(method, p, body) {
          const r = await client.api(method, p, body);
          if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
          return r.status === 204 ? null : r.json();
        },
        raw: async (name) => (await client.json('GET', `/v1/admin/raw/${encodeURIComponent(name)}`)).value,
        putRaw: (name, value) => client.json('PUT', `/v1/admin/raw/${encodeURIComponent(name)}`, { value }),
      };
      return client;
    }
  }
  throw new Error(`Żaden zapisany klucz admin nie działa na ${base} (próbowano: ${candidates.map(([l]) => l).join('; ') || 'brak kluczy'}).`);
}

const withParam = (url, param) => `${url}${url.includes('?') ? '&' : '?'}${param}`;

/**
 * Wgrywa plik na `url` (PUT; duże pliki częściami: POST ?uploads → PUT ?uploadId&part → POST ?uploadId). Gdy serwer nie zna wgrywania
 * częściami (404), zostaje jedno żądanie. Zwraca rozmiar.
 */
async function uploadFile(client, url, file, label = path.basename(file)) {
  const size = fs.statSync(file).size;
  const single = async () => {
    const r = await fetch(`${client.base}${url}`, { method: 'PUT', headers: client.headers({ 'Content-Type': 'application/octet-stream' }), body: fs.readFileSync(file) });
    if (!r.ok) throw new Error(`${label}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  if (size <= SINGLE_MAX) {
    await single();
    return size;
  }
  const start = await fetch(`${client.base}${withParam(url, 'uploads')}`, { method: 'POST', headers: client.headers() });
  if (start.status === 404) {
    await single();
    return size;
  }
  if (start.status !== 201) throw new Error(`${label}: HTTP ${start.status} ${(await start.text()).slice(0, 200)}`);
  const { uploadId } = await start.json();
  const id = `uploadId=${encodeURIComponent(uploadId)}`;
  const parts = [];
  const fd = fs.openSync(file, 'r');
  try {
    for (let pos = 0, n = 1; pos < size; pos += PART, n++) {
      const buf = Buffer.alloc(Math.min(PART, size - pos));
      fs.readSync(fd, buf, 0, buf.length, pos);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const r = await fetch(`${client.base}${withParam(url, `${id}&part=${n}`)}`, { method: 'PUT', headers: client.headers({ 'Content-Type': 'application/octet-stream' }), body: buf }).catch(() => null);
        if (r && r.ok) {
          parts.push(await r.json());
          ok = true;
        } else if (attempt === 3) throw new Error(`${label}: część ${n}: HTTP ${r ? r.status : 'brak odpowiedzi'}`);
      }
    }
    const done = await fetch(`${client.base}${withParam(url, id)}`, { method: 'POST', headers: client.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ parts }) });
    if (!done.ok) throw new Error(`${label}: zakończenie: HTTP ${done.status} ${(await done.text()).slice(0, 200)}`);
  } catch (e) {
    await fetch(`${client.base}${withParam(url, id)}`, { method: 'DELETE', headers: client.headers() }).catch(() => {});
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return size;
}

/** Rekurencyjna lista plików katalogu ('a/b.json' względem katalogu, bez plików tymczasowych i ukrytych). */
function walk(dir, prefix = '') {
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

/**
 * Kopia danych VPS-a do katalogu lokalnego - TYLKO ODCZYT na serwerze (ssh/scp w jedną stronę). Bez starych instalatorów:
 * tylko latest.yml, instalator wskazany w latest.yml i wszystkie blockmapy. Zwraca ścieżkę katalogu danych.
 */
function pullVps(ssh, remoteDir, dest, log = console.log) {
  fs.mkdirSync(dest, { recursive: true });
  const run = (cmd) => {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', ssh, cmd], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ssh ${ssh}: ${cmd}\n${r.stderr}`);
    return r.stdout;
  };
  const scp = (remote, local) => {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const r = spawnSync('scp', ['-q', '-r', '-o', 'BatchMode=yes', `${ssh}:${remote}`, local], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`scp ${remote}: ${r.stderr}`);
  };
  const listing = run(`cd ${remoteDir} && ls -1p`).split('\n').filter(Boolean);
  for (const f of ['invites.json', 'keys.json', 'players.json', 'announcements.json']) {
    if (listing.includes(f)) scp(`${remoteDir}/${f}`, path.join(dest, f));
  }
  for (const d of ['events', 'capes']) if (listing.includes(`${d}/`)) scp(`${remoteDir}/${d}`, path.join(dest, d));
  if (listing.includes('updates/')) {
    const yml = run(`cat ${remoteDir}/updates/latest.yml`);
    fs.mkdirSync(path.join(dest, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'updates', 'latest.yml'), yml);
    const installers = [...yml.matchAll(/^\s*(?:- )?url:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, '')).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(n));
    const files = run(`cd ${remoteDir}/updates && ls -1`).split('\n').filter((n) => /\.blockmap$/.test(n));
    for (const name of [...new Set([...installers, ...files])]) {
      log(`    pobieram updates/${name}`);
      scp(`${remoteDir}/updates/${name}`, path.join(dest, 'updates', name));
    }
  }
  return dest;
}

module.exports = { root, stored, stageBase, option, resolveBase, connect, uploadFile, walk, pullVps, withParam };
