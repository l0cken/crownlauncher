// Pomiar obciążenia testowego Workera na PRAWDZIWYM Cloudflare: czas CPU każdego wywołania (Worker i Durable Object) z `wrangler tail`,
// duży plik wydarzenia (>100 MB) częściami + pobranie, odrzucenie jednego żądania > 100 MB oraz skalowanie dokumentu zaproszeń.
// Tylko środowisko TESTOWE (zapisuje dane próbne: podmienia dokument zaproszeń na syntetyczny i na końcu go przywraca).
// Użycie: node cloudflare/scripts/stress-remote.js [--skip-big] [--skip-scale]
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const host = /"routes":\s*\[\{\s*"pattern":\s*"([a-z0-9.-]+)"/.exec(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'))?.[1];
if (!host) throw new Error('Brak adresu testowego Workera w wrangler.jsonc');
const base = `https://${host}`;
const keyFile = path.join(os.homedir(), '.crownlauncher-cf-test-admin-key');
const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_SECRET_FILE).Trim(); [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'], { env: { ...process.env, CROWN_SECRET_FILE: keyFile }, encoding: 'utf8' });
const ADMIN = (ps.stdout || '').trim();
if (ps.status !== 0 || !ADMIN) throw new Error('Nie udało się odczytać klucza admin środowiska testowego.');
const bearer = { Authorization: `Bearer ${ADMIN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const api = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { ...bearer, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- wrangler tail: zbieramy zdarzenia z czasem CPU ----
const tailFile = path.join(os.tmpdir(), `crown-tail-${process.pid}.json`);
const tail = spawn(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'tail', 'crownlauncher-test', '--format', 'json'], { cwd: root, stdio: ['ignore', fs.openSync(tailFile, 'w'), 'ignore'] });

function parseTail() {
  const t = fs.readFileSync(tailFile, 'utf8');
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') { depth--; if (depth === 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch { /* ucięty */ } } }
  }
  return out;
}

const windows = []; // { label, from, to }
async function scenario(label, fn) {
  const from = Date.now() - 2000;
  const t0 = Date.now();
  let note = '';
  try {
    note = (await fn()) || '';
  } catch (e) {
    note = `BŁĄD: ${e.message}`;
  }
  windows.push({ label, from, to: Date.now() + 4000, sec: ((Date.now() - t0) / 1000).toFixed(1), note });
}

(async () => {
  await sleep(10_000); // połączenie taila
  const skipBig = process.argv.includes('--skip-big');
  const original = (await (await api('GET', '/v1/admin/raw/invites.json')).json()).value;

  // klucz i klucz „kodu wydarzenia” do prób pobierania
  const mk = async (name, extra = {}) => (await (await api('POST', '/v1/admin/invites', { name, ...extra })).json());
  const player = await mk('StressGracz');
  const code = await mk('StressKod', { profile: 'igrzyska', maxUses: 0 });
  const dev = 'stress-komputer-0123456789abcdef';
  const inv = (key, extra = {}) => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': key, 'X-Crown-Device': dev, 'X-Crown-Features': 'event', ...extra } });

  if (!process.argv.includes('--skip-scale')) await scenario('sprawdzenie klucza (GET /v1/invite), ~10 zaproszeń w bazie', async () => {
    for (let i = 0; i < 15; i++) { const r = await inv(player.key); if (r.status !== 200) throw new Error(`status ${r.status}`); await sleep(400); }
    return '15 żądań, 200';
  });

  // ---- skalowanie dokumentu zaproszeń (jeden dokument w storage.kv, limit 2 MB na wartość) ----
  const known = 'ABCDEFGHJKLMNPQR';
  const synthetic = (n) => {
    const now = new Date().toISOString();
    const list = Array.from({ length: n - 1 }, (_, i) => ({
      id: crypto.randomBytes(4).toString('hex'), name: `Gracz${i}`, note: 'syntetyczny', hash: sha256(`x${i}${n}`), createdAt: now, maxUses: 2, expiresAt: null, profile: '',
      capes: false, capeNicks: [], disableClient: false, released: [], lastSeenAt: now,
      devices: [{ hash: sha256(`d1${i}`), firstAt: now, lastAt: now }, { hash: sha256(`d2${i}`), firstAt: now, lastAt: now }],
    }));
    list.push({ id: 'aaaaaaaa', name: 'Znany', note: '', hash: sha256(known), createdAt: now, maxUses: 0, expiresAt: null, profile: '', capes: false, capeNicks: [], disableClient: false, released: [], devices: [] });
    return list;
  };
  for (const n of process.argv.includes('--skip-scale') ? [] : [200, 1000, 2500]) {
    await scenario(`${n} zaproszeń w bazie: GET /v1/invite ×10, lista admina ×3, nowy klucz ×3`, async () => {
      const doc = synthetic(n);
      const put = await api('PUT', '/v1/admin/raw/invites.json', { value: doc });
      if (!put.ok) throw new Error(`zapis dokumentu (${JSON.stringify(doc).length} B): HTTP ${put.status} ${(await put.text()).slice(0, 120)}`);
      await sleep(1500);
      const codes = new Map();
      for (let i = 0; i < 10; i++) { const r = await inv('CROWN-ABCD-EFGH-JKLM-NPQR'); codes.set(r.status, (codes.get(r.status) || 0) + 1); await sleep(300); }
      for (let i = 0; i < 3; i++) { const r = await api('GET', '/v1/admin/invites'); codes.set(`lista:${r.status}`, (codes.get(`lista:${r.status}`) || 0) + 1); await sleep(300); }
      for (let i = 0; i < 3; i++) { const r = await api('POST', '/v1/admin/invites', { name: `Nowy${i}` }); codes.set(`nowy:${r.status}`, (codes.get(`nowy:${r.status}`) || 0) + 1); await sleep(300); }
      return `dokument ${(JSON.stringify(doc).length / 1024).toFixed(0)} KB; statusy: ${[...codes].map(([k, v]) => `${k}×${v}`).join(' ')}`;
    });
  }
  await api('PUT', '/v1/admin/raw/invites.json', { value: original }); // przywracamy dokument

  if (!skipBig) {
    // ---- duży plik wydarzenia: 130 MB częściami, hash na serwerze, pobranie ----
    const size = 130 * 1024 * 1024;
    const body = Buffer.concat([Buffer.from('PK\u0003\u0004'), crypto.randomBytes(size)]);
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    const url = `${base}/v1/admin/events/igrzyska/mods/stress-duzy.jar`;
    const code2 = await mk('StressKod2', { profile: 'igrzyska', maxUses: 0 });
    await api('POST', '/v1/admin/events/igrzyska', { mcVersion: '1.21.4' });
    await scenario(`wgranie ${mb(body.length)} częściami po 16 MiB + SHA-1 na serwerze`, async () => {
      const t0 = Date.now();
      const start = await fetch(`${url}?uploads`, { method: 'POST', headers: bearer });
      const { uploadId } = await start.json();
      const parts = [];
      const PART = 16 * 1024 * 1024;
      for (let pos = 0, n = 1; pos < body.length; pos += PART, n++) {
        const r = await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}&part=${n}`, { method: 'PUT', headers: bearer, body: body.subarray(pos, pos + PART) });
        if (!r.ok) throw new Error(`część ${n}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        parts.push(await r.json());
      }
      const tUp = Date.now();
      const done = await api('POST', `/v1/admin/events/igrzyska/mods/stress-duzy.jar?uploadId=${encodeURIComponent(uploadId)}`, { parts });
      if (done.status !== 201) throw new Error(`zakończenie: HTTP ${done.status} ${(await done.text()).slice(0, 200)}`);
      const ev = (await done.json()).event;
      const f = ev.mods.find((m) => m.name === 'stress-duzy.jar');
      if (!f || f.sha1 !== sha1 || f.size !== body.length) throw new Error(`SHA-1/rozmiar niezgodne (serwer ${f && f.sha1}, lokalnie ${sha1})`);
      return `części ${((tUp - t0) / 1000).toFixed(1)} s, zakończenie+SHA-1 ${((Date.now() - tUp) / 1000).toFixed(1)} s, SHA-1 zgodny`;
    });
    await scenario(`pobranie ${mb(body.length)} z kodem wydarzenia`, async () => {
      const t0 = Date.now();
      const r = await fetch(`${base}/v1/event/igrzyska/file/mods/stress-duzy.jar`, { headers: { 'X-Crown-Invite': code2.key, 'X-Crown-Device': dev, 'X-Crown-Features': 'event' } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const got = crypto.createHash('sha1').update(Buffer.from(await r.arrayBuffer())).digest('hex');
      return `${((Date.now() - t0) / 1000).toFixed(1)} s, SHA-1 ${got === sha1 ? 'zgodny' : 'NIEZGODNY'}`;
    });
    await scenario('jedno żądanie 105 MB (powinno odbić się od limitu 100 MB)', async () => {
      try {
        const r = await fetch(`${base}/v1/admin/events/igrzyska/mods/stress-za-duzy.jar`, { method: 'PUT', headers: bearer, body: body.subarray(0, 105 * 1024 * 1024) });
        return `HTTP ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 80)}`;
      } catch (e) {
        return `zerwane: ${e.cause?.code || e.message}`;
      }
    });
    await api('DELETE', '/v1/admin/events/igrzyska/mods/stress-duzy.jar');
  }
  // sprzątanie kluczy próbnych
  for (const k of [player, code, ...(skipBig ? [] : [])]) if (k && k.id) await api('POST', `/v1/admin/invites/${k.id}/revoke`, {});

  await sleep(10_000);
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(tail.pid), '/T', '/F'], { stdio: 'ignore' });
  else tail.kill();
  await sleep(500);

  const events = parseTail();
  console.log(`\nZdarzeń z taila: ${events.length}\n`);
  for (const w of windows) {
    const evs = events.filter((e) => e.eventTimestamp >= w.from && e.eventTimestamp <= w.to);
    const stat = (model) => {
      const l = evs.filter((e) => e.executionModel === model);
      if (!l.length) return `${model}: brak`;
      const cpu = l.map((e) => e.cpuTime);
      const bad = l.filter((e) => e.outcome !== 'ok').map((e) => e.outcome);
      return `${model}: ${l.length}× CPU max ${Math.max(...cpu)} ms, śr. ${(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1)} ms${bad.length ? ` — NIEUDANE: ${[...new Set(bad)].join(',')}` : ''}`;
    };
    console.log(`▸ ${w.label}  [${w.sec} s]\n    ${stat('stateless')}\n    ${stat('durableObject')}\n    ${w.note}`);
  }
  fs.rmSync(tailFile, { force: true });
})().catch((e) => {
  console.error('FAIL:', e.message);
  try { tail.kill(); } catch { /* nic */ }
  process.exit(1);
});
