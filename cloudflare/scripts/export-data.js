// Eksport danych Workera do układu katalogów VPS-a (data/): invites.json, keys.json, players.json, announcements.json,
// events/<id>/event.json + pliki, capes/<nick>.png (opcjonalnie updates/ z --with-updates). To droga POWROTU na VPS (patrz CUTOVER.md)
// i część weryfikacji migracji. Skrypt tylko CZYTA z Workera i zapisuje do lokalnego katalogu.
// Użycie: node cloudflare/scripts/export-data.js --out <katalog> [--target test | --base https://adres] [--with-updates]
const fs = require('fs');
const path = require('path');
const { resolveBase, connect, option } = require('./lib/client');

const KINDS = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'root'];
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

async function exportData(client, out, { withUpdates = false, log = () => {} } = {}) {
  // dokumenty (tak samo zapisane jak na VPS-ie: JSON z wcięciem 2 spacje)
  for (const name of ['invites.json', 'keys.json', 'players.json', 'announcements.json']) {
    const value = await client.raw(name);
    if (value === null || value === undefined) continue;
    write(path.join(out, name), JSON.stringify(value, null, 2));
    log(`  ${name}`);
  }
  // wydarzenia
  const { events } = await client.json('GET', '/v1/admin/events');
  for (const ev of events) {
    const meta = await client.raw(`event:${ev.id}`);
    if (meta) write(path.join(out, 'events', ev.id, 'event.json'), JSON.stringify(meta, null, 2));
    for (const kind of KINDS) {
      for (const f of ev[kind] || []) {
        const r = await client.api('GET', `/v1/event/${ev.id}/file/${kind}?path=${encodeURIComponent(f.name)}`);
        if (!r.ok) throw new Error(`events/${ev.id}/${kind}/${f.name}: HTTP ${r.status}`);
        write(path.join(out, 'events', ev.id, kind, ...f.name.split('/')), Buffer.from(await r.arrayBuffer()));
      }
    }
    log(`  events/${ev.id}: ${KINDS.reduce((n, k) => n + (ev[k] || []).length, 0)} plików`);
  }
  // peleryny: lista plików w R2 (pliki są publiczne, jak na VPS-ie - serwer oddaje je po nicku niezależnie od wpisu gracza)
  const { capes: capeIds } = await client.json('GET', '/v1/admin/capes');
  for (const id of capeIds) {
    const r = await fetch(`${client.base}/capes/${id}.png`);
    if (!r.ok) throw new Error(`capes/${id}.png: HTTP ${r.status}`);
    write(path.join(out, 'capes', `${id}.png`), Buffer.from(await r.arrayBuffer()));
  }
  log(`  capes: ${capeIds.length}`);
  if (withUpdates) {
    const { files } = await client.json('GET', '/v1/admin/updates');
    for (const f of files) {
      const r = await client.api('GET', `/updates/${encodeURIComponent(f.name)}`);
      if (!r.ok) throw new Error(`updates/${f.name}: HTTP ${r.status}`);
      write(path.join(out, 'updates', f.name), Buffer.from(await r.arrayBuffer()));
    }
    log(`  updates: ${files.length} plików`);
  }
}

module.exports = { exportData };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const out = option(argv, '--out');
    if (!out) throw new Error('Podaj katalog: --out <katalog>');
    const client = await connect(resolveBase(argv));
    console.log(`Eksport z ${client.base} (klucz: ${client.label}) → ${path.resolve(out)}`);
    await exportData(client, path.resolve(out), { withUpdates: argv.includes('--with-updates'), log: console.log });
    console.log('Gotowe. Powrót na VPS: patrz cloudflare/CUTOVER.md (kopiowanie do /opt/crownlauncher/data przy zatrzymanej usłudze).');
  })().catch((e) => {
    console.error('BŁĄD:', e.message);
    process.exit(1);
  });
}
