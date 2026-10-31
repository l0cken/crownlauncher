// IGRZYSKA ŚMIERCI: kod wydarzenia (profil klucza), pliki wydarzenia na serwerze, ograniczenia launchera i synchronizacja.
// Prawdziwy server/server.js (INVITE_ONLY) i moduły launchera (invite, event, restrictions, instances).
// Wymaga internetu (tworzenie instancji pobiera listę wersji Fabric). Uruchomienie: node dev-tests/event-test.js
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { CF, serverEntry, startLoops, docs: backendDocs, rmDir } = require('./lib/backend');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-event-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1', ...extraEnv };
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  for (let i = 0; i < startLoops && !up; i++) await sleep(150);
  assert.ok(up, 'serwer wystartował');
  const cli = (...args) => spawnSync(process.execPath, [serverEntry, ...args], { env, encoding: 'utf8' });
  return { dataDir, port, base: `http://127.0.0.1:${port}`, proc, cli, env };
}

const KEY_RE = /(CROWN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/;
const D1 = 'komputer-jeden-0123456789abcdef';
const D2 = 'komputer-dwa-0123456789abcdefghij';

/** Minimalne „archiwum” z nagłówkiem ZIP - serwer sprawdza tylko „PK”. */
const zipLike = (label, size = 2048) => {
  const b = crypto.randomBytes(size);
  b[0] = 0x50;
  b[1] = 0x4b;
  b.write(label, 4);
  return b;
};

(async () => {
  const srv = await startServer();
  const { base, cli, dataDir } = srv;
  const adminKey = /(crown_\S+)/.exec(cli('create-key', 'Panel', 'admin').stdout)[1];
  // pliki wydarzenia „na serwerze”: katalog (Node) albo lista z API admina (Worker, R2 nie ma katalogów)
  const serverFiles = async (kind) => (CF
    ? (await (await fetch(`${base}/v1/admin/events`, { headers: { Authorization: `Bearer ${adminKey}` } })).json()).events.find((e) => e.id === 'igrzyska')[kind].map((f) => f.name).sort()
    : fs.readdirSync(path.join(dataDir, 'events', 'igrzyska', kind)).sort());
  const evDocs = backendDocs(dataDir, base);
  const bearer = { Authorization: `Bearer ${adminKey}` };
  const json = { ...bearer, 'Content-Type': 'application/json' };
  const probe = (key, device, features = 'event') => fetch(`${base}/v1/invite`, { headers: { 'X-Crown-Invite': key, ...(device ? { 'X-Crown-Device': device } : {}), ...(features ? { 'X-Crown-Features': features } : {}) } });
  const asKey = (key, device = D1) => ({ 'X-Crown-Invite': key, 'X-Crown-Device': device });
  const mk = (name, ...extra) => {
    const o = cli('create-invite', name, ...extra).stdout;
    return { key: KEY_RE.exec(o)[1], id: /id: ([0-9a-f]{8})/.exec(o)[1] };
  };
  const put = (kind, name, body, headers = bearer) =>
    fetch(`${base}/v1/admin/events/igrzyska/${kind}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body });

  // ---------------------------------------------------------------- profil klucza
  const pelny = mk('Pelny');
  const kod = mk('KodIgrzysk', '--profile', 'igrzyska', '--uses', '5');
  assert.match(cli('create-invite', 'Zly', '--profile', 'nie-ma-takiego').stderr + cli('create-invite', 'Zly', '--profile', 'nie-ma-takiego').stdout, /Nie ma wydarzenia/);
  let r = await probe(pelny.key, D1);
  assert.deepStrictEqual(await r.json(), { ok: true, name: 'Pelny', role: 'player', activated: true, profile: '', capes: false, disableClient: false });
  // starszy launcher (bez X-Crown-Features) nie dostaje kodu wydarzenia - i nie zajmuje przy tym komputera
  r = await probe(kod.key, D1, '');
  assert.strictEqual(r.status, 401);
  assert.match((await r.json()).error, /nowszej wersji CrownLaunchera/);
  assert.strictEqual((await probe(kod.key, D1, 'inna-funkcja')).status, 401);
  assert.match(cli('list-invites').stdout, /KodIgrzysk.*użycia 0\/5/, 'odrzucony launcher nie związał klucza');
  r = await probe(kod.key, D1);
  assert.deepStrictEqual(await r.json(), { ok: true, name: 'KodIgrzysk', role: 'player', activated: true, profile: 'igrzyska', capes: false, disableClient: false });
  assert.match(cli('list-invites').stdout, /KodIgrzysk.*kod wydarzenia: igrzyska/);
  assert.doesNotMatch(/.*Pelny.*/.exec(cli('list-invites').stdout)[0], /kod wydarzenia/);
  assert.match(cli('find-invite', kod.key).stdout, /KodIgrzysk.*profil: igrzyska/);
  assert.match(cli('find-invite', pelny.key).stdout, /Pelny.*profil: pełny dostęp/);
  ok('klucz z profilem „igrzyska” (CLI --profile): /v1/invite zwraca profil, nieznane wydarzenie odrzucone');

  // klucz zwykły → kod przez API panelu i set-profile
  r = await fetch(`${base}/v1/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'ZPanelu', profile: 'igrzyska', maxUses: 2 }) });
  assert.strictEqual(r.status, 201);
  const zPanelu = await r.json();
  assert.strictEqual(zPanelu.profile, 'igrzyska');
  r = await fetch(`${base}/v1/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Zly', profile: 'x'.repeat(40) }) });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/v1/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Zly', profile: 'nieistnieje' }) });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/v1/admin/invites/${pelny.id}/update`, { method: 'POST', headers: json, body: JSON.stringify({ profile: 'igrzyska' }) });
  assert.strictEqual((await r.json()).invite.profile, 'igrzyska');
  r = await fetch(`${base}/v1/admin/invites/${pelny.id}/update`, { method: 'POST', headers: json, body: JSON.stringify({ profile: '' }) });
  assert.strictEqual((await r.json()).invite.profile, '');
  assert.match(cli('set-profile', pelny.id, 'igrzyska').stdout, /igrzyska/);
  assert.match(cli('set-profile', pelny.id, '-').stdout, /pełny dostęp/);
  ok('panel/API/CLI: profil przy tworzeniu i edycji klucza, walidacja, powrót do pełnego dostępu');

  // ---------------------------------------------------------------- pliki wydarzenia (administrator)
  r = await fetch(`${base}/v1/admin/events`, { headers: bearer });
  const events = (await r.json()).events;
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual([events[0].id, events[0].title, events[0].mcVersion, events[0].mods, events[0].resourcepacks], ['igrzyska', 'IGRZYSKA ŚMIERCI', '', [], []]);
  assert.strictEqual((await fetch(`${base}/v1/admin/events`)).status, 401);
  assert.strictEqual((await fetch(`${base}/v1/admin/events`, { headers: asKey(kod.key) })).status, 401, 'kod wydarzenia to nie administrator');

  const modA = zipLike('mod-a', 4096);
  const modB = zipLike('mod-b', 3000);
  const pack = zipLike('pack', 5000);
  assert.strictEqual((await put('mods', 'Crown Death Games-1.0.jar', modA)).status, 201);
  assert.strictEqual((await put('mods', 'fabric-api-0.1.jar', modB)).status, 201);
  r = await put('resourcepacks', 'Igrzyska Pack.zip', pack);
  assert.strictEqual(r.status, 201);
  const manifest = (await r.json()).event;
  assert.deepStrictEqual(manifest.mods.map((m) => m.name), ['Crown Death Games-1.0.jar', 'fabric-api-0.1.jar']);
  assert.strictEqual(manifest.mods[0].sha1, sha1(modA));
  assert.strictEqual(manifest.mods[0].size, modA.length);
  assert.strictEqual(manifest.resourcepacks[0].sha1, sha1(pack));
  if (!CF) assert.ok(!fs.readdirSync(path.join(dataDir, 'events', 'igrzyska', 'mods')).some((f) => f.endsWith('.part')), 'bez plików tymczasowych');

  // walidacja
  assert.strictEqual((await put('mods', 'plik.txt', modA)).status, 400, 'zły typ pliku');
  assert.strictEqual((await put('resourcepacks', 'x.jar', pack)).status, 400, 'jar nie jest texturepackiem');
  assert.strictEqual((await put('mods', '../ucieczka.jar', modA)).status, 400, 'ścieżka poza katalogiem');
  assert.strictEqual((await put('mods', '.ukryty.jar', modA)).status, 400, 'nazwa musi zaczynać się od znaku alfanumerycznego');
  assert.strictEqual((await put('mods', 'pusty.jar', Buffer.alloc(0))).status, 400, 'pusty plik');
  assert.strictEqual((await put('mods', 'nie-zip.jar', Buffer.from('to na pewno nie jest archiwum'))).status, 400, 'bez nagłówka PK');
  assert.strictEqual((await put('mods', 'a.jar', modA, {})).status, 401, 'bez uwierzytelnienia');
  assert.strictEqual((await put('mods', 'a.jar', modA, asKey(kod.key))).status, 401, 'kod wydarzenia nie wgrywa plików');
  assert.strictEqual((await fetch(`${base}/v1/admin/events/nie-ma/mods/a.jar`, { method: 'PUT', headers: bearer, body: modA })).status, 404);
  if (!CF) assert.ok(!fs.existsSync(path.join(dataDir, 'events', 'ucieczka.jar')) && !fs.existsSync(path.join(dataDir, 'ucieczka.jar')), 'nic nie wyszło poza katalog wydarzenia');
  assert.deepStrictEqual(await serverFiles('mods'), ['Crown Death Games-1.0.jar', 'fabric-api-0.1.jar']);
  ok('panel: wgrywanie modów (.jar) i texturepacków (.zip): manifest z SHA-1, walidacja nazw/typu/nagłówka, tylko administrator');

  // metadane
  r = await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ mcVersion: 'nie-wersja' }) });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ title: '   ' }) });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'Igrzyska Śmierci 2026', mcVersion: '1.21.4', crownClient: false }) });
  assert.strictEqual(r.status, 200);
  const meta = (await r.json()).event;
  assert.deepStrictEqual([meta.title, meta.mcVersion, meta.crownClient, meta.loader], ['Igrzyska Śmierci 2026', '1.21.4', false, 'fabric']);
  r = await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'IGRZYSKA ŚMIERCI', crownClient: true }) });
  assert.strictEqual((await r.json()).event.mcVersion, '1.21.4', 'pola, których nie podano, zostają');
  ok('panel: ustawienia wydarzenia (nazwa, wersja gry, CrownClient) z walidacją');

  // ---------------------------------------------------------------- dostęp do plików
  const inactive = mk('Zwykly');
  r = await fetch(`${base}/v1/event/igrzyska`);
  assert.strictEqual(r.status, 401, 'bez klucza');
  r = await fetch(`${base}/v1/event/igrzyska/info`, { headers: asKey(inactive.key) });
  assert.strictEqual(r.status, 200, 'zwykły klucz widzi tylko „info”');
  assert.deepStrictEqual(await r.json(), { id: 'igrzyska', title: 'IGRZYSKA ŚMIERCI', ready: true });
  r = await fetch(`${base}/v1/event/igrzyska`, { headers: asKey(inactive.key) });
  assert.strictEqual(r.status, 403, 'zwykły klucz nie dostaje listy plików');
  assert.match((await r.json()).error, /wymaga kodu/);
  r = await fetch(`${base}/v1/event/igrzyska/file/mods/${encodeURIComponent('Crown Death Games-1.0.jar')}`, { headers: asKey(inactive.key) });
  assert.strictEqual(r.status, 403, 'zwykły klucz nie pobiera plików');
  r = await fetch(`${base}/v1/event/igrzyska`, { headers: asKey(kod.key) });
  assert.strictEqual(r.status, 200);
  const man = await r.json();
  assert.deepStrictEqual(man.mods.map((m) => m.name), ['Crown Death Games-1.0.jar', 'fabric-api-0.1.jar']);
  r = await fetch(`${base}/v1/event/igrzyska/file/mods/${encodeURIComponent('Crown Death Games-1.0.jar')}`, { headers: asKey(kod.key) });
  assert.strictEqual(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(modA), 'pobrany plik jest identyczny');
  r = await fetch(`${base}/v1/event/igrzyska`, { headers: bearer });
  assert.strictEqual(r.status, 200, 'administrator też widzi');
  for (const bad of ['..%2Fserver.js', '%2e%2e%2f%2e%2e%2fpackage.json', 'nie-ma.jar', 'plik.txt']) {
    const rr = await fetch(`${base}/v1/event/igrzyska/file/mods/${bad}`, { headers: asKey(kod.key) });
    assert.ok([400, 404].includes(rr.status), `ścieżka ${bad}: ${rr.status}`);
  }
  assert.strictEqual((await fetch(`${base}/v1/event/nie-ma`, { headers: asKey(kod.key) })).status, 404);
  // klucz-kod związany z jednym komputerem (limit 5, ale komputer 1 już zajęty - drugi zajmuje kolejne użycie)
  assert.strictEqual((await fetch(`${base}/v1/event/igrzyska`, { headers: asKey(kod.key, D2) })).status, 200);
  // unieważniony kod traci dostęp do plików
  assert.strictEqual((await fetch(`${base}/v1/admin/invites/${zPanelu.id}/revoke`, { method: 'POST', headers: bearer })).status, 200);
  assert.strictEqual((await fetch(`${base}/v1/event/igrzyska`, { headers: asKey(zPanelu.key) })).status, 401);
  ok('dostęp: zwykły klucz → tylko info (403 na pliki), kod wydarzenia i administrator → pliki, path traversal odrzucony, unieważniony kod traci dostęp');

  // ---------------------------------------------------------------- shaderpacki, configi i pliki gry
  const putPath = (kind, rel, body, headers = bearer) =>
    fetch(`${base}/v1/admin/events/igrzyska/${kind}?path=${encodeURIComponent(rel)}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body });
  const optionsTxt = Buffer.from('fov:70.0\nlang:en_us\nresourcePacks:["vanilla","file/Stary Pack.zip"]\n');
  const sodiumJson = Buffer.from('{"quality":{"weather_quality":"FAST"}}\n');
  const irisProps = Buffer.from('shaderPack=Arena Shaders.zip\nenableShaders=true\n');
  const shaderZip = zipLike('shader', 2500);
  assert.strictEqual((await putPath('root', 'options.txt', optionsTxt)).status, 201);
  assert.strictEqual((await putPath('config', 'sodium-options.json', sodiumJson)).status, 201);
  assert.strictEqual((await putPath('config', 'sub/dir/iris.properties', irisProps)).status, 201, 'config w podfolderach');
  assert.strictEqual((await putPath('config', 'doomed/tmp.json', Buffer.from('{}'))).status, 201);
  assert.strictEqual((await putPath('shaderpacks', 'Arena Shaders.zip', shaderZip)).status, 201);
  assert.strictEqual((await putPath('shaderpacks', 'Arena Shaders.txt', Buffer.from('sun=1\n'))).status, 201, 'ustawienia shaderpacka (.txt) bez nagłówka PK');
  r = await fetch(`${base}/v1/admin/events`, { headers: bearer });
  let evm = (await r.json()).events[0];
  assert.deepStrictEqual(evm.config.map((f) => [f.name, f.enforce]), [['doomed/tmp.json', true], ['sodium-options.json', true], ['sub/dir/iris.properties', true]], 'configi domyślnie wymuszane');
  assert.deepStrictEqual(evm.root.map((f) => [f.name, f.enforce]), [['options.txt', false]], 'options.txt domyślnie jako ustawienie startowe');
  assert.deepStrictEqual(evm.shaderpacks.map((f) => f.name), ['Arena Shaders.txt', 'Arena Shaders.zip']);
  assert.strictEqual(evm.config[1].sha1, sha1(sodiumJson));
  assert.ok(evm.mods.every((f) => !('enforce' in f)), 'mody są zawsze wymuszane - bez flagi');
  // walidacja nazw, rodzajów, nagłówków, uprawnień i rozmiaru
  for (const [kind, rel, body] of [['config', 'program.exe', 'MZ'], ['config', '../x.json', '{}'], ['config', 'a/b/c/d/e.json', '{}'], ['config', 'a//b.json', '{}'],
    ['config', '.ukryty.json', '{}'], ['root', 'autoexec.txt', 'x'], ['root', 'sub/options.txt', 'x'], ['shaderpacks', 'zly.zip', 'to nie jest zip'], ['shaderpacks', 'a.jar', 'PK..']]) {
    assert.strictEqual((await putPath(kind, rel, Buffer.from(body))).status, 400, `${kind}/${rel}`);
  }
  assert.strictEqual((await putPath('config', 'sodium-options.json', sodiumJson, {})).status, 401);
  assert.strictEqual((await putPath('config', 'sodium-options.json', sodiumJson, asKey(kod.key))).status, 401);
  let tooBig;
  try {
    tooBig = (await putPath('config', 'wielki.json', Buffer.alloc(6 * 1024 * 1024, 0x20))).status;
  } catch {
    tooBig = 'zerwane'; // serwer zamyka połączenie po przekroczeniu limitu
  }
  assert.ok([413, 'zerwane'].includes(tooBig), `config > 5 MB: ${tooBig}`);
  const cfgDir = path.join(dataDir, 'events', 'igrzyska', 'config');
  assert.ok(CF ? !(await serverFiles('config')).includes('wielki.json') : !fs.existsSync(path.join(cfgDir, 'wielki.json')) && !fs.readdirSync(cfgDir).some((f) => f.endsWith('.part')), 'za duży plik nie zostaje');
  // flaga wymuszania
  const setEnforce = (enforce) => fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ enforce }) });
  r = await setEnforce({ 'config/sodium-options.json': false, 'root/options.txt': true });
  evm = (await r.json()).event;
  assert.deepStrictEqual([evm.config.find((f) => f.name === 'sodium-options.json').enforce, evm.root[0].enforce], [false, true]);
  await setEnforce({ 'config/sodium-options.json': true, 'root/options.txt': false });
  for (const bad of [{ 'mods/x.jar': true }, { 'config/../x.json': true }, { 'root/evil.txt': true }, { 'config/x.json': 'tak' }, ['config/x.json']]) {
    assert.strictEqual((await setEnforce(bad)).status, 400, JSON.stringify(bad));
  }
  // pobranie z podfolderu: ścieżka w parametrze, tylko z kodem wydarzenia
  const cfgUrl = `${base}/v1/event/igrzyska/file/config?path=${encodeURIComponent('sub/dir/iris.properties')}`;
  r = await fetch(cfgUrl, { headers: asKey(kod.key) });
  assert.strictEqual(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(irisProps));
  assert.strictEqual((await fetch(cfgUrl, { headers: asKey(inactive.key) })).status, 403, 'zwykły klucz nie pobiera configów');
  assert.strictEqual((await fetch(`${base}/v1/event/igrzyska/file/config?path=${encodeURIComponent('../../server.js')}`, { headers: asKey(kod.key) })).status, 404);
  assert.strictEqual((await fetch(`${base}/v1/event/igrzyska/file/root?path=options.txt`, { headers: asKey(kod.key) })).status, 200);
  // usunięcie: puste foldery znikają, flaga razem z plikiem
  await setEnforce({ 'config/doomed/tmp.json': false });
  assert.strictEqual((await evDocs.read('event:igrzyska')).enforce['config/doomed/tmp.json'], false);
  r = await fetch(`${base}/v1/admin/events/igrzyska/config?path=${encodeURIComponent('doomed/tmp.json')}`, { method: 'DELETE', headers: bearer });
  assert.strictEqual(r.status, 200);
  if (!CF) assert.ok(!fs.existsSync(path.join(cfgDir, 'doomed')), 'pusty folder usunięty');
  assert.ok(!('config/doomed/tmp.json' in (await evDocs.read('event:igrzyska')).enforce), 'flaga usunięta z plikiem');
  assert.deepStrictEqual((await r.json()).event.config.map((f) => f.name), ['sodium-options.json', 'sub/dir/iris.properties']);
  ok('serwer: shaderpacki, configi (też w podfolderach) i pliki gry — walidacja, limit 5 MB, flaga „wymuszaj”, pobieranie tylko z kodem, sprzątanie przy usunięciu');

  // ---------------------------------------------------------------- ograniczenia launchera (restrictions.check)
  const restrictions = require(root + 'src/main/core/restrictions.js');
  const locked = new Set(['event-igrzyska']);
  const ctx = (profile) => ({ profile, eventInstanceId: 'event-igrzyska', isLocked: async (id) => locked.has(id) });
  const full = ctx('');
  const evMode = ctx('igrzyska');
  // pełny dostęp: wszystko poza zawartością zablokowanej instancji
  assert.strictEqual(await restrictions.check('instances:create', [{}], full), null);
  assert.strictEqual(await restrictions.check('servers:list', [], full), null);
  assert.strictEqual(await restrictions.check('modrinth:search', [{}], full), null);
  assert.strictEqual(await restrictions.check('skins:list', [], full), null);
  assert.strictEqual(await restrictions.check('instances:launch', ['moja'], full), null);
  for (const ch of ['instances:update', 'instances:delete', 'instances:optimize', 'instances:open-folder', 'content:toggle', 'content:delete', 'content:update', 'content:update-all', 'content:identify']) {
    assert.strictEqual(await restrictions.check(ch, ['event-igrzyska', 'x'], full), restrictions.MESSAGE_LOCKED, `${ch} na zablokowanej instancji`);
    assert.strictEqual(await restrictions.check(ch, ['moja', 'x'], full), null, `${ch} na zwykłej instancji`);
  }
  assert.strictEqual(await restrictions.check('modrinth:install', [{ instanceId: 'event-igrzyska', projectId: 'p' }], full), restrictions.MESSAGE_LOCKED);
  assert.strictEqual(await restrictions.check('modrinth:install', [{ instanceId: 'moja', projectId: 'p' }], full), null);
  assert.strictEqual(await restrictions.check('instances:launch', ['event-igrzyska'], full), null, 'granie w instancji wydarzenia wolno');
  // tryb wydarzenia: zakładki z prośby (Instancje, Serwery, Skiny, Modrinth) zablokowane
  for (const ch of ['instances:create', 'instances:delete', 'instances:update', 'servers:list', 'servers:add', 'servers:ping', 'skins:list', 'skins:apply', 'capes:select',
    'modrinth:search', 'modrinth:install', 'modrinth:import-mrpack', 'content:list', 'content:toggle', 'versions:list', 'loaders:list', 'shell:open-data-dir']) {
    assert.strictEqual(await restrictions.check(ch, ['moja', {}], evMode), restrictions.MESSAGE_MODE, `${ch} w trybie wydarzenia`);
  }
  assert.strictEqual(await restrictions.check('instances:launch', ['moja'], evMode), restrictions.MESSAGE_MODE, 'tylko instancja wydarzenia');
  assert.strictEqual(await restrictions.check('instances:launch', ['event-igrzyska'], evMode), null);
  assert.strictEqual(await restrictions.check('instances:stop', ['event-igrzyska'], evMode), null);
  assert.strictEqual(await restrictions.check('instances:logs', ['event-igrzyska'], evMode), null);
  for (const ch of ['update:check', 'win:close', 'app:info', 'invite:status', 'accounts:list', 'accounts:add-offline', 'event:state', 'event:sync', 'event:redeem', 'news:list', 'config:get', 'config:set', 'shell:open-external']) {
    assert.strictEqual(await restrictions.check(ch, [], evMode), null, `${ch} dozwolone w trybie wydarzenia`);
  }
  ok('restrictions: pełny dostęp bez blokad (poza zawartością instancji wydarzenia), tryb wydarzenia blokuje Instancje/Serwery/Skiny/Modrinth');

  // ---------------------------------------------------------------- launcher: kod, synchronizacja
  const appConfig = require(root + 'src/main/core/app-config.js');
  Object.assign(appConfig, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: base, UPDATE_URL: '', INVITE_REQUIRED: true, CAPES_URL: '' });
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-event-l-'));
  const paths = require(root + 'src/main/core/paths.js');
  paths.init(ldir);
  const config = require(root + 'src/main/core/config.js');
  const invite = require(root + 'src/main/core/invite.js');
  const event = require(root + 'src/main/core/event.js');
  const instances = require(root + 'src/main/core/instances.js');

  // gracz z pełnym dostępem
  const gracz = mk('Gracz');
  await invite.submit(gracz.key);
  let st = await invite.status();
  assert.deepStrictEqual([st.active, st.profile], [true, undefined], 'pełny dostęp: brak trybu ograniczonego');
  assert.strictEqual(event.access().hasAccess, false);
  assert.deepStrictEqual(await event.info(), { available: true, id: 'igrzyska', title: 'IGRZYSKA ŚMIERCI', ready: true });
  let es = await event.state();
  assert.deepStrictEqual([es.hasAccess, es.restricted, es.mods], [false, false, undefined], 'bez kodu nie widać plików');
  await assert.rejects(event.sync(), /Wpisz kod Igrzysk/);
  await assert.rejects(event.redeem('abc'), /w formacie CROWN-XXXX/);
  const zwykly = mk('ZwyklyNiezwiazany'); // pelny jest już związany z innym komputerem (409)
  await assert.rejects(event.redeem(zwykly.key), /To nie jest kod Igrzysk/, 'zwykły klucz nie jest kodem wydarzenia');
  await assert.rejects(event.redeem(pelny.key), /już użyty na innym komputerze/, 'zajęty klucz: komunikat serwera');
  await assert.rejects(event.redeem('CROWN-ZZZZ-ZZZZ-ZZZZ-ZZZZ'), /Nieprawidłowy|unieważniony/);
  await assert.rejects(event.redeem(zPanelu.key), /unieważniony|wygasły|Nieprawidłowy/, 'unieważniony kod odrzucony');
  const kod2 = mk('KodGracza', '--profile', 'igrzyska');
  const acc = await event.redeem(kod2.key);
  assert.deepStrictEqual(acc, { hasAccess: true, via: 'code' });
  const sealed = config.get().eventKeys.igrzyska;
  assert.ok(/^(raw|enc):/.test(sealed) && !sealed.includes(kod2.key.replace(/CROWN-|-/g, '')), 'kod zapisany zaszyfrowany');
  assert.ok(!('eventKeys' in config.publicView()), 'renderer nie dostaje kodów');
  assert.strictEqual(invite.eventHeaders('igrzyska', base + '/x')['X-Crown-Invite'], kod2.key.replace(/CROWN-|-/g, ''), 'kod idzie do serwera (znormalizowany)');
  assert.deepStrictEqual(invite.eventHeaders('igrzyska', 'https://obcy.example/x'), {}, 'kod tylko do własnego serwera');
  assert.strictEqual(config.get().inviteProfile, '', 'główny klucz nadal pełny dostęp');
  es = await event.state();
  // do interfejsu idzie tylko liczba plików (mody 2 + texturepack 1 + shaderpacki 2 + configi 2 + options 1), nie nazwy
  assert.deepStrictEqual([es.hasAccess, es.via, es.mcVersion, es.files], [true, 'code', '1.21.4', 8]);
  for (const kind of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'root']) assert.ok(!(kind in es), `stan dla interfejsu nie zawiera listy ${kind}`);
  assert.ok(!JSON.stringify(es).includes('Crown Death Games') && !JSON.stringify(es).includes('sodium-options'), 'bez nazw plików');
  ok('launcher: kod wpisany przez gracza z pełnym dostępem (walidacja, zaszyfrowany zapis, nagłówki tylko do własnego serwera)');

  // synchronizacja (tworzy instancję, pobiera pliki, usuwa obce, włącza texturepack)
  const progress = [];
  const result = await event.sync((p) => progress.push(p.stage));
  assert.deepStrictEqual([result.mods, result.resourcepacks, result.instance.id, result.instance.locked, result.instance.event], [2, 1, 'event-igrzyska', true, 'igrzyska']);
  assert.deepStrictEqual([result.shaderpacks, result.config, result.root], [2, 2, 1]);
  assert.ok(progress.includes('manifest') && progress.includes('download') && progress.at(-1) === 'done');
  const gameDir = paths.gameDir('event-igrzyska');
  const modsDir = path.join(gameDir, 'mods');
  const packsDir = path.join(gameDir, 'resourcepacks');
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['Crown Death Games-1.0.jar', 'fabric-api-0.1.jar']);
  assert.ok(fs.readFileSync(path.join(modsDir, 'Crown Death Games-1.0.jar')).equals(modA));
  assert.ok(fs.readFileSync(path.join(packsDir, 'Igrzyska Pack.zip')).equals(pack));
  let options = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  assert.match(options, /^fov:70\.0$/m, 'options.txt organizatora trafił do gry');
  assert.match(options, /^resourcePacks:\["vanilla","file\/Igrzyska Pack\.zip"\]$/m, 'obcy pack z options.txt organizatora wyłączony, pack wydarzenia włączony');
  assert.ok(fs.readFileSync(path.join(gameDir, 'config', 'sodium-options.json')).equals(sodiumJson));
  assert.ok(fs.readFileSync(path.join(gameDir, 'config', 'sub', 'dir', 'iris.properties')).equals(irisProps), 'config z podfolderu');
  assert.ok(fs.readFileSync(path.join(gameDir, 'shaderpacks', 'Arena Shaders.zip')).equals(shaderZip));
  assert.strictEqual((await instances.isLocked('event-igrzyska')), true);
  assert.strictEqual((await instances.list()).filter((i) => i.locked).length, 1);
  ok('sync: instancja zablokowana; mody, texturepacki, shaderpacki, configi (z podfolderami) i options.txt pobrane z weryfikacją SHA-1, texturepack włączony');

  // gracz „dorzucił” swoje pliki, zmodyfikował mod i ma własne ustawienia gry - przy następnej synchronizacji wraca do stanu z serwera
  fs.writeFileSync(path.join(modsDir, 'cheat-client.jar'), 'nie-to');
  fs.writeFileSync(path.join(modsDir, 'Crown Death Games-1.0.jar.disabled'), 'x');
  fs.mkdirSync(path.join(modsDir, 'podkatalog'));
  fs.writeFileSync(path.join(modsDir, 'podkatalog', 'x.jar'), 'x');
  fs.writeFileSync(path.join(packsDir, 'moj-pack.zip'), 'x');
  fs.writeFileSync(path.join(modsDir, 'fabric-api-0.1.jar'), Buffer.concat([modB.subarray(0, modB.length - 1), Buffer.from([1])])); // ta sama długość, inna treść
  fs.writeFileSync(path.join(gameDir, 'options.txt'), 'fov:90.0\nresourcePacks:["vanilla","file/moj-pack.zip","file/Igrzyska Pack.zip"]\nlang:pl_pl\n');
  fs.writeFileSync(path.join(gameDir, 'shaderpacks', 'moj-shader.zip'), 'x');
  fs.writeFileSync(path.join(gameDir, 'config', 'sodium-options.json'), '{"hacked":true}'); // config wymuszany
  fs.writeFileSync(path.join(gameDir, 'config', 'mod-wlasny.json'), '{}'); // spoza listy - zostaje
  await event.sync();
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['Crown Death Games-1.0.jar', 'fabric-api-0.1.jar'], 'obce pliki, .disabled i katalogi usunięte');
  assert.deepStrictEqual(fs.readdirSync(packsDir), ['Igrzyska Pack.zip']);
  assert.deepStrictEqual(fs.readdirSync(path.join(gameDir, 'shaderpacks')).sort(), ['Arena Shaders.txt', 'Arena Shaders.zip'], 'cudzy shaderpack usunięty');
  assert.ok(fs.readFileSync(path.join(gameDir, 'config', 'sodium-options.json')).equals(sodiumJson), 'wymuszany config przywrócony');
  assert.ok(fs.existsSync(path.join(gameDir, 'config', 'mod-wlasny.json')), 'config spoza listy nietknięty');
  assert.ok(fs.readFileSync(path.join(modsDir, 'fabric-api-0.1.jar')).equals(modB), 'zmodyfikowany mod pobrany ponownie');
  options = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  assert.match(options, /^fov:90\.0$/m);
  assert.match(options, /^lang:pl_pl$/m);
  assert.match(options, /^resourcePacks:\["vanilla","file\/Igrzyska Pack\.zip"\]$/m);
  ok('sync: obce mody/texturepacki/.disabled usunięte, zmieniony plik odtworzony, własne ustawienia gry zachowane, obcy pack wyłączony');

  // administrator usuwa i podmienia pliki - launcher dostaje dokładnie nowy zestaw
  assert.strictEqual((await fetch(`${base}/v1/admin/events/igrzyska/mods/${encodeURIComponent('fabric-api-0.1.jar')}`, { method: 'DELETE', headers: bearer })).status, 200);
  const modC = zipLike('mod-c', 2500);
  assert.strictEqual((await put('mods', 'nowy-mod.jar', modC)).status, 201);
  assert.strictEqual((await put('mods', 'Crown Death Games-1.0.jar', modC)).status, 201, 'nadpisanie pliku o tej samej nazwie');
  await event.sync();
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['Crown Death Games-1.0.jar', 'nowy-mod.jar']);
  assert.ok(fs.readFileSync(path.join(modsDir, 'Crown Death Games-1.0.jar')).equals(modC));
  ok('sync: usunięcie i podmiana plików na serwerze trafia do launchera');

  // options.txt to ustawienie startowe: zmiana organizatora nadpisuje plik gracza, własne zmiany gracza między nimi zostają
  const optionsFile = path.join(gameDir, 'options.txt');
  const optionsV2 = Buffer.from('fov:80.0\nlang:pl_pl\n');
  assert.strictEqual((await putPath('root', 'options.txt', optionsV2)).status, 201);
  await event.sync();
  options = fs.readFileSync(optionsFile, 'utf8');
  assert.match(options, /^fov:80\.0$/m, 'nowa wersja organizatora wgrana');
  assert.match(options, /^resourcePacks:\["vanilla","file\/Igrzyska Pack\.zip"\]$/m, 'texturepack wydarzenia dalej włączony');
  fs.writeFileSync(optionsFile, options.replace('fov:80.0', 'fov:100.0'));
  await event.sync();
  assert.match(fs.readFileSync(optionsFile, 'utf8'), /^fov:100\.0$/m, 'zmiana gracza zostaje, dopóki organizator nie zmieni pliku');
  fs.rmSync(optionsFile);
  await event.sync();
  assert.match(fs.readFileSync(optionsFile, 'utf8'), /^fov:80\.0$/m, 'usunięty plik startowy wraca');
  // wymuszanie włączone: zmiana gracza jest cofana przy każdym starcie, wyłączone: znowu zostaje
  assert.strictEqual((await setEnforce({ 'root/options.txt': true })).status, 200);
  fs.writeFileSync(optionsFile, 'fov:110.0\n');
  await event.sync();
  assert.match(fs.readFileSync(optionsFile, 'utf8'), /^fov:80\.0$/m, 'wymuszany options.txt przywrócony');
  assert.strictEqual((await setEnforce({ 'root/options.txt': false })).status, 200);
  fs.writeFileSync(optionsFile, 'fov:120.0\n');
  await event.sync();
  assert.match(fs.readFileSync(optionsFile, 'utf8'), /^fov:120\.0$/m);
  // config usunięty na serwerze zostaje u gracza (launcher nie kasuje plików, które mod mógł utworzyć sam)
  assert.strictEqual((await fetch(`${base}/v1/admin/events/igrzyska/config?path=${encodeURIComponent('sub/dir/iris.properties')}`, { method: 'DELETE', headers: bearer })).status, 200);
  await event.sync();
  assert.ok(fs.existsSync(path.join(gameDir, 'config', 'sub', 'dir', 'iris.properties')));
  ok('sync: options.txt jako ustawienie startowe (zmiana organizatora nadpisuje, zmiany gracza zostają), „wymuszaj” przywraca przy każdym starcie');

  // plik pomocniczy instancji (niezamykany) nie zdradza nazw configów i opcji: klucze to skróty
  const appliedRaw = fs.readFileSync(path.join(paths.instanceDir('event-igrzyska'), 'event-applied.json'), 'utf8');
  assert.ok(!/sodium|options|iris|config\//i.test(appliedRaw), 'event-applied.json zawiera nazwy plików');
  assert.ok(Object.keys(JSON.parse(appliedRaw)).every((k) => /^[0-9a-f]{40}$/.test(k)) && Object.keys(JSON.parse(appliedRaw)).length >= 2);
  // raporty awarii JVM (listy bibliotek i modułów) znikają z katalogu głównego po grze; reszta zostaje
  for (const f of ['hs_err_pid4242.log', 'replay_pid77.log', 'moje-notatki.log']) fs.writeFileSync(path.join(gameDir, f), 'x');
  await event.cleanAfterGame('event-igrzyska');
  assert.deepStrictEqual(['hs_err_pid4242.log', 'replay_pid77.log', 'moje-notatki.log'].map((f) => fs.existsSync(path.join(gameDir, f))), [false, false, true]);
  fs.rmSync(path.join(gameDir, 'moje-notatki.log'));

  // foldery wydarzenia są ukryte (Ukryty + Systemowy): nie widać ich w Eksploratorze nawet przy „pokaż ukryte elementy”
  if (process.platform === 'win32') {
    const { execFileSync } = require('child_process');
    const hiddenDirs = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports'];
    const attrsOf = (dir) => {
      const out = execFileSync('attrib', [dir], { encoding: 'utf8' });
      return out.split(/[A-Za-z]:\\/)[0]; // litery atrybutów przed ścieżką
    };
    for (const d of hiddenDirs) {
      const attrs = attrsOf(path.join(gameDir, d));
      assert.ok(attrs.includes('H') && attrs.includes('S'), `${d}: atrybuty „${attrs.trim()}”`);
    }
    // ukryty jest też folder instancji i jej „game”, a launcher dalej widzi instancję
    for (const dir of [paths.instanceDir('event-igrzyska'), gameDir]) {
      const attrs = attrsOf(dir);
      assert.ok(attrs.includes('H') && attrs.includes('S'), `${dir}: atrybuty „${attrs.trim()}”`);
    }
    assert.ok((await instances.list()).some((i) => i.id === 'event-igrzyska'), 'instancja nadal widoczna dla launchera');
    const listing = (flags) => {
      try {
        return execFileSync('cmd', ['/c', 'dir', '/b', ...flags, gameDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
      } catch {
        return []; // dir kończy się błędem „File Not Found”, gdy nic nie pasuje do filtra
      }
    };
    const visible = listing([]);
    for (const d of hiddenDirs) assert.ok(!visible.includes(d), `${d} widoczny w zwykłym widoku`);
    assert.ok(visible.includes('options.txt'), 'zwykłe pliki nadal widać');
    const hiddenToo = listing(['/a:h']); // „pokaż ukryte elementy”: tylko ukryte
    for (const d of hiddenDirs) assert.ok(hiddenToo.includes(d), `${d} powinien być ukryty (jest w widoku /a:h)`);
    // „pokaż ukryte” z domyślnie włączoną ochroną plików systemowych (jak Eksplorator): ukryte, ale nie systemowe
    const hiddenNotSystem = listing(['/a:h-s']);
    for (const d of hiddenDirs) assert.ok(!hiddenNotSystem.includes(d), `${d} ma atrybut systemowy, więc zostaje niewidoczny przy „pokaż ukryte”`);
    // gra czyta i zapisuje w ukrytych folderach normalnie
    fs.writeFileSync(path.join(gameDir, 'downloads', 'test.bin'), 'x');
    assert.deepStrictEqual(fs.readdirSync(path.join(gameDir, 'downloads')), ['test.bin']);
    // gracz zdejmuje atrybut „Ukryty” we właściwościach - launcher przywraca go przy następnym starcie
    execFileSync('attrib', ['-h', '-s', modsDir]);
    assert.ok(!attrsOf(modsDir).includes('H'));
    await event.sync();
    assert.ok(attrsOf(modsDir).includes('H') && attrsOf(modsDir).includes('S'), 'atrybuty przywrócone');
    ok('foldery mods, resourcepacks, shaderpacks, config i downloads są ukryte (H+S) — niewidoczne także przy „pokaż ukryte elementy”; launcher przywraca atrybuty');
  }

  // wpisanie pełnej ścieżki nic nie daje: poza grą foldery mają odmowę NTFS, w trakcie gry mods/resourcepacks są tylko do odczytu
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const denied = (fn) => {
      try {
        fn();
        return false;
      } catch (e) {
        return ['EPERM', 'EACCES'].includes(e.code);
      }
    };
    const hiddenDirs = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'downloads', '.fabric', 'logs', 'crash-reports'];
    const instId = 'event-igrzyska';
    await event.lockDirs(instId);
    for (const d of hiddenDirs) {
      const dir = path.join(gameDir, d);
      assert.ok(denied(() => fs.readdirSync(dir)), `${d}: listowanie po wpisaniu ścieżki powinno być zablokowane`);
      assert.ok(denied(() => fs.writeFileSync(path.join(dir, 'evil.tmp'), 'x')), `${d}: zapis powinien być zablokowany`);
    }
    assert.ok(denied(() => fs.readFileSync(path.join(modsDir, 'nowy-mod.jar'))), 'odczyt pliku po wpisaniu pełnej ścieżki');
    assert.ok(denied(() => fs.readFileSync(path.join(gameDir, 'config', 'sodium-options.json'))), 'odczyt configu');
    assert.ok(denied(() => fs.rmSync(path.join(modsDir, 'nowy-mod.jar'))), 'usunięcie moda');
    const dirCmd = spawnSync('cmd', ['/c', 'dir', '/b', modsDir], { encoding: 'utf8' });
    assert.notStrictEqual(dirCmd.status, 0, 'wiersz poleceń też dostaje odmowę');
    assert.ok(!denied(() => fs.readFileSync(path.join(gameDir, 'options.txt'))), 'options.txt (katalog główny) nie jest blokowany');

    // w trakcie gry: czytanie działa, dodawanie i podmiana paczek/modów nie, a config i downloads są zapisywalne
    await event.protectRunning(instId);
    assert.ok(fs.readdirSync(modsDir).includes('nowy-mod.jar'), 'gra czyta mody');
    assert.ok(fs.readFileSync(path.join(modsDir, 'nowy-mod.jar')).length > 0);
    assert.ok(fs.readdirSync(packsDir).includes('Igrzyska Pack.zip'), 'gra czyta texturepacki');
    assert.ok(denied(() => fs.writeFileSync(path.join(modsDir, 'evil.jar'), 'x')), 'nie da się dodać moda w trakcie gry');
    assert.ok(denied(() => fs.writeFileSync(path.join(packsDir, 'xray.zip'), 'x')), 'nie da się dodać texturepacka w trakcie gry');
    assert.ok(denied(() => fs.writeFileSync(path.join(modsDir, 'nowy-mod.jar'), 'podmiana')), 'nie da się podmienić moda');
    fs.writeFileSync(path.join(gameDir, 'config', 'runtime.json'), '{}'); // mody zapisują config w trakcie gry
    fs.writeFileSync(path.join(gameDir, 'downloads', 'server-pack.zip'), 'PK'); // gra zapisuje paczki z serwerów
    fs.rmSync(path.join(gameDir, 'config', 'runtime.json'));

    // kolejna synchronizacja zdejmuje blokady i działa normalnie (także po „zamknięciu” folderów)
    await event.lockDirs(instId);
    await event.sync();
    assert.ok(!denied(() => fs.readdirSync(modsDir)), 'synchronizacja zdjęła blokadę');
    assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['Crown Death Games-1.0.jar', 'nowy-mod.jar']);

    // właściciel może wyłączyć zakładanie blokad zmienną środowiskową; ukrycie (H+S) działa niezależnie od blokady
    process.env.CROWN_EVENT_NO_SEAL = '1';
    await event.lockDirs(instId);
    assert.ok(!denied(() => fs.readdirSync(modsDir)), 'CROWN_EVENT_NO_SEAL=1 wyłącza blokadę');
    delete process.env.CROWN_EVENT_NO_SEAL;
    await event.lockDirs(instId);
    const attrs = require('child_process').execFileSync(path.join(process.env.SystemRoot, 'System32', 'attrib.exe'), [modsDir], { encoding: 'utf8' }).split(/[A-Za-z]:\\/)[0];
    assert.ok(attrs.includes('H') && attrs.includes('S'), 'zablokowany folder jest też ukryty');
    await event.unlockDirs(instId);
    ok('blokada wejścia: poza grą foldery wydarzenia nie dają się otworzyć po wpisaniu ścieżki (listowanie, odczyt, zapis, usuwanie, cmd); w grze mods/resourcepacks tylko do odczytu; synchronizacja zdejmuje blokadę');
  }

  // zmiana wersji gry odtwarza instancję (usuwanie ukrytych folderów działa) i ponownie ukrywa foldery
  r = await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ mcVersion: '1.21.5' }) });
  assert.strictEqual(r.status, 200);
  const upgraded = await event.sync();
  assert.strictEqual(upgraded.instance.mcVersion, '1.21.5');
  assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['Crown Death Games-1.0.jar', 'nowy-mod.jar']);
  assert.ok(fs.existsSync(path.join(gameDir, 'config', 'sodium-options.json')));
  assert.ok(!fs.existsSync(path.join(gameDir, 'downloads', 'test.bin')), 'stare dane instancji usunięte');
  if (process.platform === 'win32') {
    const out = require('child_process').execFileSync('attrib', [modsDir], { encoding: 'utf8' }).split(/[A-Za-z]:\\/)[0];
    assert.ok(out.includes('H') && out.includes('S'), 'nowa instancja też ma ukryte foldery');
  }
  await fetch(`${base}/v1/admin/events/igrzyska`, { method: 'POST', headers: json, body: JSON.stringify({ mcVersion: '1.21.4' }) });
  assert.strictEqual((await event.sync()).instance.mcVersion, '1.21.4');
  ok('zmiana wersji gry w wydarzeniu: instancja odtworzona z plikami, foldery znów ukryte');

  // uszkodzone pobranie: proxy zmienia jeden bajt pliku w drodze (manifest zostaje poprawny)
  let corrupt = true;
  const proxyPort = await freePort();
  const proxy = require('http').createServer(async (req, res) => {
    const up = await fetch(base + req.url, { headers: { 'x-crown-invite': req.headers['x-crown-invite'] || '', 'x-crown-device': req.headers['x-crown-device'] || '' } });
    const body = Buffer.from(await up.arrayBuffer());
    if (corrupt && req.url.includes('/file/') && body.length) body[body.length - 1] ^= 0xff;
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  }).listen(proxyPort, '127.0.0.1');
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  appConfig.ANNOUNCEMENTS_URL = proxyBase;
  config.set({ inviteOrigin: proxyBase });
  fs.rmSync(path.join(modsDir, 'nowy-mod.jar'));
  await assert.rejects(event.sync(), /uszkodzony.*niezgodna suma SHA-1/);
  assert.ok(!fs.existsSync(path.join(modsDir, 'nowy-mod.jar')) && !fs.existsSync(path.join(modsDir, 'nowy-mod.jar.part')), 'uszkodzony plik nie zostaje w grze');
  corrupt = false;
  await event.sync();
  assert.ok(fs.readFileSync(path.join(modsDir, 'nowy-mod.jar')).equals(modC));
  proxy.close();
  appConfig.ANNOUNCEMENTS_URL = base;
  config.set({ inviteOrigin: base });
  ok('sync: plik o złej sumie SHA-1 jest odrzucany i nie trafia do gry');

  // „Zwolnij” w panelu odłącza komputer także od kodu wpisanego w zakładce: launcher zapomina kod, ponowne wpisanie działa
  assert.strictEqual((await fetch(`${base}/v1/admin/invites/${kod2.id}/release`, { method: 'POST', headers: json, body: '{}' })).status, 200);
  es = await event.state();
  assert.strictEqual(es.hasAccess, false, 'kod zapomniany po zwolnieniu komputera');
  assert.strictEqual(config.get().eventKeys.igrzyska, undefined);
  assert.deepStrictEqual(await event.redeem(kod2.key), { hasAccess: true, via: 'code' });
  assert.strictEqual((await event.state()).hasAccess, true, 'po ponownym wpisaniu kod znów działa');
  ok('„Zwolnij” odłącza też kod wydarzenia wpisany w zakładce: launcher go zapomina, ponowne wpisanie działa');

  // kod przestał działać → launcher zapomina go i nie synchronizuje
  assert.strictEqual((await fetch(`${base}/v1/admin/invites/${kod2.id}/revoke`, { method: 'POST', headers: bearer })).status, 200);
  await assert.rejects(event.sync(), /unieważniony|wygasły|Nieprawidłowy/);
  assert.strictEqual(config.get().eventKeys.igrzyska, undefined, 'unieważniony kod usunięty z launchera');
  es = await event.state();
  assert.strictEqual(es.hasAccess, false);
  ok('unieważniony kod wydarzenia: launcher go zapomina i prosi o nowy');

  // ---------------------------------------------------------------- launcher: kod jako główny klucz (tryb ograniczony)
  config.set({ inviteKey: '', inviteOrigin: '', inviteName: '', inviteProfile: '', eventKeys: {} });
  const goly = mk('Tylko Igrzyska', '--profile', 'igrzyska');
  st = await invite.submit(goly.key);
  assert.deepStrictEqual([st.active, st.name, st.profile], [true, 'Tylko Igrzyska', 'igrzyska']);
  assert.strictEqual(config.get().inviteProfile, 'igrzyska');
  assert.deepStrictEqual(event.access(), { hasAccess: true, via: 'primary' });
  assert.strictEqual(invite.eventHeaders('igrzyska', base + '/x')['X-Crown-Invite'], goly.key.replace(/CROWN-|-/g, ''));
  es = await event.state();
  assert.deepStrictEqual([es.restricted, es.hasAccess, es.via, es.installed], [true, true, 'primary', true]);
  await event.sync();
  assert.ok(fs.existsSync(path.join(modsDir, 'nowy-mod.jar')));
  // przy sprawdzaniu klucza profil jest odświeżany z serwera, a ręczna zmiana profilu w pliku nie wyłącza trybu na stałe
  config.set({ inviteProfile: '', inviteCheckedAt: 0 });
  st = await invite.status({ check: true });
  assert.strictEqual(st.profile, 'igrzyska');
  // zmiana profilu klucza po stronie serwera (administrator zdejmuje kod) działa po następnym sprawdzeniu
  assert.match(cli('set-profile', goly.id, '-').stdout, /pełny dostęp/);
  config.set({ inviteCheckedAt: 0 });
  st = await invite.status({ check: true });
  assert.strictEqual(st.profile, undefined);
  assert.strictEqual(config.get().inviteProfile, '');
  ok('launcher: kod jako jedyny klucz → tryb ograniczony; profil odświeżany z serwera (też zdjęcie kodu)');

  srv.proc.kill();
  for (const d of [dataDir, ldir]) rmDir(d);
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
