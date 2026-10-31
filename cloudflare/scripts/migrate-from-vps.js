// Migracja danych serwera CrownLaunchera z VPS-a do Workera Cloudflare. VPS jest tylko CZYTANY (ssh/scp w jedną stronę), nic na nim się nie zmienia.
// Powtarzalna (idempotentna): dokumenty są nadpisywane, pliki wydarzenia i peleryny odzwierciedlają VPS (nadmiarowe na Workerze są usuwane),
// instalatory o tej samej nazwie i rozmiarze są pomijane. Na końcu weryfikacja (dokumenty, pliki wydarzenia z SHA-1, peleryny, aktualizacje
// z SHA-512 instalatora) oraz obieg powrotny: eksport z Workera do układu VPS-a i porównanie z kopią VPS-a.
//
// Użycie: node cloudflare/scripts/migrate-from-vps.js [--target test | --base https://adres] [--ssh anarchia] [--remote /opt/crownlauncher/data]
//                                                   [--dry-run] [--verify-only] [--skip-updates] [--skip-roundtrip] [--keep-copy <katalog>]
// Klucz admin: CROWN_ADMIN_KEY albo pliki DPAPI w %USERPROFILE% (klucz VPS-a, klucz testowy Workera) - nie jest wypisywany.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBase, connect, option, uploadFile, walk, pullVps } = require('./lib/client');
const { exportData } = require('./export-data');

const KINDS = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'root'];
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex');
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};

async function importAll(client, dir) {
  const have = (p) => fs.existsSync(path.join(dir, p));

  // ---- wydarzenia: metadane, potem pliki; nadmiarowe pliki na Workerze znikają ----
  const eventsDir = path.join(dir, 'events');
  const ids = have('events') ? fs.readdirSync(eventsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const id of ids) {
    const metaFile = path.join(eventsDir, id, 'event.json');
    if (fs.existsSync(metaFile)) await client.putRaw(`event:${id}`, readJson(metaFile));
    const manifest = (await client.json('GET', '/v1/admin/events')).events.find((e) => e.id === id) || {};
    let uploaded = 0;
    let removed = 0;
    for (const kind of KINDS) {
      const local = walk(path.join(eventsDir, id, kind));
      for (const rel of local) {
        await uploadFile(client, `/v1/admin/events/${id}/${kind}?path=${encodeURIComponent(rel)}`, path.join(eventsDir, id, kind, ...rel.split('/')), `events/${id}/${kind}/${rel}`);
        uploaded++;
      }
      for (const f of manifest[kind] || []) {
        if (!local.includes(f.name)) {
          await client.json('DELETE', `/v1/admin/events/${id}/${kind}?path=${encodeURIComponent(f.name)}`);
          removed++;
        }
      }
    }
    console.log(`  events/${id}: wgrano ${uploaded}, usunięto nadmiarowych ${removed}`);
  }

  // ---- peleryny (przed dokumentem graczy: wgranie admina dotyka wpisu gracza, a dokument z VPS-a nadpisze go na końcu) ----
  const capeIds = walk(path.join(dir, 'capes')).filter((f) => /^[a-z0-9_]{1,16}\.png$/.test(f)).map((f) => f.slice(0, -4));
  for (const id of capeIds) {
    const r = await fetch(`${client.base}/v1/capes/${id}`, { method: 'PUT', headers: client.headers({ 'Content-Type': 'image/png' }), body: fs.readFileSync(path.join(dir, 'capes', `${id}.png`)) });
    if (!r.ok) throw new Error(`capes/${id}.png: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  }
  let capesRemoved = 0;
  for (const id of (await client.json('GET', '/v1/admin/capes')).capes) {
    if (!capeIds.includes(id)) {
      await client.api('DELETE', `/v1/capes/${id}`);
      capesRemoved++;
    }
  }
  console.log(`  capes: wgrano ${capeIds.length}, usunięto nadmiarowych ${capesRemoved}`);

  // ---- aktualizacje: instalator(y) i blockmapy najpierw, latest.yml na końcu ----
  if (!flag('--skip-updates') && have('updates')) {
    const present = new Map((await client.json('GET', '/v1/admin/updates')).files.map((f) => [f.name, f.size]));
    const names = walk(path.join(dir, 'updates')).filter((n) => n !== 'latest.yml');
    for (const name of names) {
      const file = path.join(dir, 'updates', name);
      if (present.get(name) === fs.statSync(file).size) {
        console.log(`  updates/${name}: już jest (ten sam rozmiar) - pomijam`);
        continue;
      }
      process.stdout.write(`  updates/${name} … `);
      const size = await uploadFile(client, `/v1/updates/${encodeURIComponent(name)}`, file, name);
      console.log(`${(size / 1048576).toFixed(1)} MB`);
    }
    for (const name of present.keys()) {
      if (name !== 'latest.yml' && !names.includes(name)) {
        await client.json('DELETE', `/v1/admin/updates/${encodeURIComponent(name)}`);
        console.log(`  updates/${name}: usunięty z Workera (nie ma go w kopii z VPS-a)`);
      }
    }
    if (have('updates/latest.yml')) await uploadFile(client, '/v1/updates/latest.yml', path.join(dir, 'updates', 'latest.yml'), 'latest.yml');
    console.log('  updates/latest.yml (na końcu)');
  }

  // ---- dokumenty stanu; klucze OSTATNIE (po nich klucz bootstrap z sekretu przestaje działać, zostają klucze z VPS-a) ----
  for (const name of ['players.json', 'announcements.json', 'invites.json', 'keys.json']) {
    if (!have(name)) continue;
    await client.putRaw(name, readJson(path.join(dir, name)));
    console.log(`  ${name}`);
  }
}

async function verify(client, dir) {
  const have = (p) => fs.existsSync(path.join(dir, p));
  console.log(`\nWeryfikacja na ${client.base} (klucz: ${client.label})`);
  for (const name of ['invites.json', 'keys.json', 'players.json', 'announcements.json']) {
    if (have(name)) check(canon(await client.raw(name)) === canon(readJson(path.join(dir, name))), `dokument ${name} identyczny z VPS-em`);
  }
  const eventsDir = path.join(dir, 'events');
  const ids = have('events') ? fs.readdirSync(eventsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const events = (await client.json('GET', '/v1/admin/events')).events;
  for (const id of ids) {
    if (fs.existsSync(path.join(eventsDir, id, 'event.json'))) check(canon(await client.raw(`event:${id}`)) === canon(readJson(path.join(eventsDir, id, 'event.json'))), `wydarzenie ${id}: ustawienia (event.json) identyczne`);
    const m = events.find((e) => e.id === id) || {};
    for (const kind of KINDS) {
      const local = walk(path.join(eventsDir, id, kind)).map((rel) => {
        const buf = fs.readFileSync(path.join(eventsDir, id, kind, ...rel.split('/')));
        return `${rel}|${buf.length}|${sha('sha1', buf)}`;
      });
      const remote = (m[kind] || []).map((f) => `${f.name}|${f.size}|${f.sha1}`).sort();
      check(canon(local.sort()) === canon(remote), `wydarzenie ${id}/${kind}: ${local.length} plików (nazwa, rozmiar, SHA-1) zgodnych`);
    }
  }
  for (const rel of walk(path.join(dir, 'capes'))) {
    const r = await fetch(`${client.base}/capes/${rel}`);
    check(r.ok && Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(path.join(dir, 'capes', rel))), `peleryna ${rel} identyczna`);
  }
  if (!flag('--skip-updates') && have('updates')) {
    const remote = new Map((await client.json('GET', '/v1/admin/updates')).files.map((f) => [f.name, f.size]));
    for (const name of walk(path.join(dir, 'updates'))) check(remote.get(name) === fs.statSync(path.join(dir, 'updates', name)).size, `updates/${name}: jest, rozmiar zgodny`);
    const yml = fs.readFileSync(path.join(dir, 'updates', 'latest.yml'), 'utf8');
    const got = await client.api('GET', '/updates/latest.yml');
    check((await got.text()) === yml, 'latest.yml identyczny');
    const exe = /^path:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    const want = /^sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    if (exe && want) {
      const r = await client.api('GET', `/updates/${encodeURIComponent(exe)}`);
      const got512 = crypto.createHash('sha512').update(Buffer.from(await r.arrayBuffer())).digest('base64');
      check(r.ok && got512 === want, `instalator ${exe} pobrany z Workera ma SHA-512 z latest.yml`);
    }
  }
  check(client.label.includes('serwera') || client.label === 'CROWN_ADMIN_KEY', `prawdziwy klucz admin z VPS-a działa na Workerze (użyto: ${client.label})`);
}

async function roundtrip(client, dir) {
  console.log('\nObieg powrotny: eksport z Workera do układu VPS-a i porównanie z kopią VPS-a');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-export-'));
  try {
    await exportData(client, out, { withUpdates: !flag('--skip-updates') && fs.existsSync(path.join(dir, 'updates')) });
    const a = walk(dir);
    const b = walk(out);
    check(canon(a) === canon(b), `te same pliki po eksporcie (${a.length} plików: ${a.filter((f) => !f.includes('/')).join(', ')} …)`);
    let same = true;
    for (const f of a) {
      const x = fs.readFileSync(path.join(dir, ...f.split('/')));
      const y = fs.existsSync(path.join(out, ...f.split('/'))) ? fs.readFileSync(path.join(out, ...f.split('/'))) : null;
      const isDoc = /\.json$/.test(f);
      const ok = y && (isDoc ? canon(JSON.parse(x)) === canon(JSON.parse(y)) : sha('sha1', x) === sha('sha1', y));
      if (!ok) {
        same = false;
        console.log(`    różnica: ${f}`);
      }
    }
    check(same, 'zawartość każdego pliku po eksporcie identyczna z VPS-em (dokumenty: porównanie logiczne, reszta: SHA-1)');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

(async () => {
  const ssh = option(argv, '--ssh', 'anarchia');
  const remote = option(argv, '--remote', '/opt/crownlauncher/data');
  const keep = option(argv, '--keep-copy');
  const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'crown-vps-'));
  try {
    console.log(`1) Kopia danych z VPS-a (${ssh}:${remote}, tylko odczyt) → ${dir}`);
    pullVps(ssh, remote, dir, console.log);
    const local = walk(dir);
    console.log(`   skopiowano ${local.length} plików (${(local.reduce((n, f) => n + fs.statSync(path.join(dir, ...f.split('/'))).size, 0) / 1048576).toFixed(1)} MB)`);

    const base = resolveBase(argv);
    const client = await connect(base);
    console.log(`2) Worker: ${base} (klucz: ${client.label})`);
    if (flag('--dry-run')) {
      console.log('   --dry-run: nic nie zapisuję. Do wgrania:\n   ' + local.join('\n   '));
      return;
    }
    if (!flag('--verify-only')) {
      console.log('3) Import do Workera');
      await importAll(client, dir);
    }
    // po imporcie kluczy (keys.json z VPS-a) łączymy się od nowa - działa już prawdziwy klucz admin
    const after = await connect(base);
    await verify(after, dir);
    if (!flag('--skip-roundtrip')) await roundtrip(after, dir);
    console.log(failed ? `\n${failed} sprawdzeń NIE przeszło` : '\nWSZYSTKO OK — dane na Workerze zgodne z VPS-em');
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
