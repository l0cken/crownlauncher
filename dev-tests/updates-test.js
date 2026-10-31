const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-upd-'));
require(root + 'paths.js').init(dir);
const paths = require(root + 'paths.js');
const instances = require(root + 'instances.js');
const modrinth = require(root + 'modrinth.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ---- atrapa Modrinth (global fetch) ----------------------------------------------------------------------
const AdmZip = require('C:/Users/meabx/Desktop/CrownLauncher/node_modules/adm-zip');
// projekt „pg” ma prawdziwe jary Fabric (żeby sprawdzić usuwanie duplikatów po id moda); reszta to zwykłe bajty
const bytes = (name) => {
  if (name.startsWith('pg-')) {
    const z = new AdmZip();
    z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'pg', version: name.slice(3) })));
    return z.toBuffer();
  }
  return Buffer.from(`JAR:${name}`);
};
const ver = (project, id, number, type, published) => ({
  id, project_id: project, version_number: number, version_type: type, date_published: published,
  game_versions: ['1.21.11'], loaders: ['fabric'], dependencies: [],
  files: [{ primary: true, filename: `${project}-${number}.jar`, url: `https://cdn.test/${project}-${number}.jar`, size: bytes(`${project}-${number}`).length, hashes: { sha1: sha1(bytes(`${project}-${number}`)) } }],
});
// listy od najnowszej
const VERSIONS = {
  pa: [ver('pa', 'pa3', '3.0', 'release', '2026-03-01'), ver('pa', 'pa2', '2.0', 'beta', '2026-02-01'), ver('pa', 'pa1', '1.0', 'release', '2026-01-01')],
  pb: [ver('pb', 'pb4', '4.0-alpha', 'alpha', '2026-04-01'), ver('pb', 'pb3', '3.0-beta', 'beta', '2026-03-01'), ver('pb', 'pb2', '2.0-beta', 'beta', '2026-02-01')],
  pc: [ver('pc', 'pc1', '1.0', 'release', '2026-01-01')],
  pd: [ver('pd', 'pd2', '2.0-beta', 'beta', '2026-02-01'), ver('pd', 'pd1', '1.0', 'release', '2026-01-01')],
  pe: [ver('pe', 'pe9', '9.0', 'release', '2026-05-01'), ver('pe', 'pe8', '8.0', 'beta', '2026-04-01')],
  pcsl: [ver('pcsl', 'pcsl2', '2.0', 'release', '2026-05-01')],
  pg: [ver('pg', 'pg2', '2.0', 'release', '2026-05-01'), ver('pg', 'pg1', '1.0', 'release', '2026-01-01')],
  pf: [ver('pf', 'pf3', '3.0-beta', 'beta', '2026-05-01'), ver('pf', 'pf2', '2.0', 'release', '2026-04-01')],
};
const VERSION_BY_ID = Object.fromEntries(Object.values(VERSIONS).flat().map((v) => [v.id, v]));
const BYTES_BY_URL = Object.fromEntries(Object.values(VERSIONS).flat().map((v) => [v.files[0].url, bytes(`${v.project_id}-${v.version_number}`)]));
const calls = [];
const SHA_TO_PROJECT = {};
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push(u.pathname);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let m;
  if ((m = /^\/v2\/project\/([^/]+)\/version$/.exec(u.pathname))) return json(VERSIONS[m[1]] || []);
  if ((m = /^\/v2\/version\/([^/]+)$/.exec(u.pathname))) return VERSION_BY_ID[m[1]] ? json(VERSION_BY_ID[m[1]]) : new Response('{}', { status: 404 });
  if (u.pathname === '/v2/version_files/update' && opts.method === 'POST') {
    const { hashes } = JSON.parse(opts.body);
    const out = {};
    for (const h of hashes) if (SHA_TO_PROJECT[h]) out[h] = VERSIONS[SHA_TO_PROJECT[h]][0];
    return json(out);
  }
  if (u.hostname === 'cdn.test') return BYTES_BY_URL[url] ? new Response(BYTES_BY_URL[url], { status: 200 }) : new Response('', { status: 404 });
  return new Response('{}', { status: 404 });
};

(async () => {
  const inst = { id: 'upd-test', name: 'upd', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', createdAt: 1 };
  fs.mkdirSync(paths.gameDir(inst.id), { recursive: true });
  fs.writeFileSync(paths.instanceFile(inst.id), JSON.stringify(inst));
  const modsDir = path.join(paths.gameDir(inst.id), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const index = {};
  const put = (project, versionId, number, disabled = false, extra = {}) => {
    const file = `${project}-${number}.jar`;
    const data = bytes(`${project}-${number}`);
    fs.writeFileSync(path.join(modsDir, file + (disabled ? '.disabled' : '')), data);
    index[file] = { projectId: project, versionId, versionNumber: number, title: `Mod ${project}`, slug: project, size: data.length, sha1: sha1(data), ...extra };
    SHA_TO_PROJECT[sha1(data)] = project;
  };
  put('pa', 'pa1', '1.0'); // wydanie -> jest nowsze wydanie
  put('pb', 'pb2', '2.0-beta'); // beta -> nowsza beta (alpha pomijana)
  put('pc', 'pc1', '1.0'); // aktualny
  put('pd', 'pd1', '1.0', true); // wydanie wyłączone; jest tylko nowsza beta -> bez aktualizacji
  put('pe', 'pe-stara', '7.0'); // wersji nie ma na liście -> najlepsze wydanie
  put('pcsl', 'pcsl1', '1.0', false, { slug: 'customskinloader' }); // zarządzany przez launcher
  put('pf', 'pf-stara', '1.0');
  put('pg', 'pg1', '1.0'); // będzie aktualizowany do 2.0
  // dwie dodatkowe kopie tego samego moda: fork z innego projektu (w indeksie) i plik w ogóle poza indeksem
  fs.writeFileSync(path.join(modsDir, 'pg-fork-0.9.jar'), bytes('pg-0.9'));
  index['pg-fork-0.9.jar'] = { projectId: 'pg-fork-project', versionId: 'x', versionNumber: '0.9', title: 'PG fork', slug: 'pg-fork', size: 1, sha1: 'z' };
  fs.writeFileSync(path.join(modsDir, 'pg-bez-indeksu.jar'), bytes('pg-0.5')); // wersji nie ma na liście, a najnowsza to beta -> proponujemy wydanie 2.0, nie betę
  await instances.writeIndex(inst.id, index);

  // ---- sprawdzanie ----
  const found = await modrinth.checkUpdates(inst.id);
  const byProj = Object.fromEntries(found.map((u) => [u.projectId, u]));
  assert.deepStrictEqual(Object.keys(byProj).sort(), ['pa', 'pb', 'pe', 'pf', 'pg']);
  assert.strictEqual(byProj.pf.latest.number, '2.0', 'nieznana obecna: wydanie przed nowszą betą');
  assert.strictEqual(byProj.pa.latest.number, '3.0'); // pomija betę 2.0, bierze najnowsze wydanie
  assert.strictEqual(byProj.pb.latest.number, '3.0-beta'); // z bety nie na alphę
  assert.strictEqual(byProj.pe.latest.number, '9.0'); // nieznana obecna -> najlepsze wydanie
  assert.ok(!byProj.pc && !byProj.pd, 'aktualny i „tylko beta nowsza od wydania” nie są proponowane');
  assert.ok(!byProj.pcsl, 'CustomSkinLoader nie jest sprawdzany');
  assert.ok(calls.includes('/v2/version_files/update'), 'zbiorcze zapytanie o najnowsze wersje');
  assert.ok(!calls.includes('/v2/project/pc/version'), 'aktualny mod nie wymaga osobnego zapytania');
  ok('sprawdzanie: wydanie→najnowsze wydanie, beta→nowsza beta (bez alphy), nieznana wersja→najlepsze wydanie; aktualne i CSL pominięte');

  // ---- aktualizacja jednego (zachowanie wyłączenia) ----
  const r1 = await modrinth.updateMod(inst.id, 'pa-1.0.jar');
  assert.strictEqual(r1.updated, true);
  assert.ok(fs.existsSync(path.join(modsDir, 'pa-3.0.jar')) && !fs.existsSync(path.join(modsDir, 'pa-1.0.jar')));
  assert.deepStrictEqual(fs.readFileSync(path.join(modsDir, 'pa-3.0.jar')), bytes('pa-3.0'));
  let idx = await instances.readIndex(inst.id);
  assert.strictEqual(idx['pa-3.0.jar'].versionId, 'pa3');
  assert.ok(!idx['pa-1.0.jar']);
  ok('aktualizacja jednego moda: nowy plik, stary usunięty, indeks zaktualizowany');

  // wyłączony mod zostaje wyłączony po aktualizacji
  const dsIdx = await instances.readIndex(inst.id);
  const disabledFile = 'pb-2.0-beta.jar';
  fs.renameSync(path.join(modsDir, disabledFile), path.join(modsDir, `${disabledFile}.disabled`));
  void dsIdx;
  const r2 = await modrinth.updateMod(inst.id, `${disabledFile}.disabled`);
  assert.strictEqual(r2.updated, true);
  assert.ok(fs.existsSync(path.join(modsDir, 'pb-3.0-beta.jar.disabled')), 'stan „wyłączony” zachowany');
  assert.ok(!fs.existsSync(path.join(modsDir, 'pb-3.0-beta.jar')));
  ok('mod wyłączony przed aktualizacją pozostaje wyłączony');

  // ---- aktualizuj wszystko ----
  const all = await modrinth.updateAll(inst.id);
  assert.deepStrictEqual([...all.updated].sort(), ['Mod pe', 'Mod pf', 'Mod pg']);
  assert.deepStrictEqual(all.failed, []);
  assert.ok(fs.existsSync(path.join(modsDir, 'pe-9.0.jar')));
  idx = await instances.readIndex(inst.id);
  assert.strictEqual(idx['pe-9.0.jar'].versionId, 'pe9');
  const pgFiles = fs.readdirSync(modsDir).filter((x) => x.startsWith('pg-'));
  assert.deepStrictEqual(pgFiles, ['pg-2.0.jar'], `po aktualizacji zostaje tylko najnowsza kopia: ${pgFiles.join(',')}`);
  assert.ok(r1.deduped.filter((d) => d.id === 'pg').length === 2, 'pierwsza aktualizacja (dowolnego moda) posprzątała też duplikaty pg i je opisała');
  assert.deepStrictEqual(await modrinth.checkUpdates(inst.id), []);
  ok('„aktualizuj wszystko”: reszta zaktualizowana, potem brak dostępnych aktualizacji');

  // ---- lista modów nie pokazuje CustomSkinLoadera ----
  const listed = (await instances.listContent(inst.id, 'mod')).map((m) => m.slug);
  assert.ok(!listed.includes('customskinloader'));
  assert.ok(fs.existsSync(path.join(modsDir, 'pcsl-1.0.jar')), 'plik zostaje na dysku, tylko ukryty na liście');
  ok('CustomSkinLoader jest ukryty na liście modów (plik zostaje)');

  // ---- błąd pobierania jednego moda nie przerywa reszty ----
  VERSIONS.pa.unshift(ver('pa', 'pa4', '4.0', 'release', '2026-06-01'));
  VERSION_BY_ID.pa4 = VERSIONS.pa[0];
  VERSIONS.pc.unshift(ver('pc', 'pc2', '2.0', 'release', '2026-06-01'));
  VERSION_BY_ID.pc2 = VERSIONS.pc[0];
  BYTES_BY_URL[VERSIONS.pc[0].files[0].url] = bytes('pc-2.0');
  // pa4: brak pliku na CDN (404)
  const mix = await modrinth.updateAll(inst.id);
  assert.deepStrictEqual(mix.updated, ['Mod pc']);
  assert.strictEqual(mix.failed.length, 1);
  assert.strictEqual(mix.failed[0].title, 'Mod pa');
  ok('błąd pobierania jednego moda jest zgłoszony, a pozostałe są zaktualizowane');

  // ---- „duch” w indeksie: wpis nowej wersji bez pliku nie może udawać „już zainstalowane” ----
  // (prawdziwy przypadek: „Aktualizuj wszystko (4)” pisało „zaktualizowano”, nic nie pobierało i znów pokazywało 4)
  VERSIONS.ph = [ver('ph', 'ph2', '2.0', 'release', '2026-07-01'), ver('ph', 'ph1', '1.0', 'release', '2026-01-01')];
  for (const v of VERSIONS.ph) {
    VERSION_BY_ID[v.id] = v;
    BYTES_BY_URL[v.files[0].url] = bytes(`ph-${v.version_number}`);
  }
  const phOld = bytes('ph-1.0');
  fs.writeFileSync(path.join(modsDir, 'ph-1.0.jar'), phOld);
  const cur = await instances.readIndex(inst.id);
  cur['ph-1.0.jar'] = { projectId: 'ph', versionId: 'ph1', versionNumber: '1.0', title: 'Mod ph', slug: 'ph', type: 'mod', size: phOld.length, sha1: sha1(phOld) };
  cur['ph-2.0.jar'] = { projectId: 'ph', versionId: 'ph2', versionNumber: '2.0', title: 'Mod ph', slug: 'ph', type: 'mod', size: 99, sha1: 'duch' };
  await instances.writeIndex(inst.id, cur);
  SHA_TO_PROJECT[sha1(phOld)] = 'ph';
  assert.ok(!fs.existsSync(path.join(modsDir, 'ph-2.0.jar')), 'plik nowej wersji nie istnieje');
  const ghost = await modrinth.updateAll(inst.id);
  assert.ok(ghost.updated.includes('Mod ph'), 'zgłoszone jako zaktualizowane');
  assert.ok(fs.existsSync(path.join(modsDir, 'ph-2.0.jar')), 'nowy plik naprawdę pobrany');
  assert.deepStrictEqual(fs.readFileSync(path.join(modsDir, 'ph-2.0.jar')), bytes('ph-2.0'));
  assert.ok(!fs.existsSync(path.join(modsDir, 'ph-1.0.jar')), 'stara wersja usunięta');
  assert.ok(!(await modrinth.checkUpdates(inst.id)).some((u) => u.projectId === 'ph'), 'po aktualizacji brak propozycji');
  const idxAfter = await instances.readIndex(inst.id);
  assert.ok(idxAfter['ph-2.0.jar'] && idxAfter['ph-2.0.jar'].sha1 === sha1(bytes('ph-2.0')) && !idxAfter['ph-1.0.jar']);
  ok('wpis-„duch” w indeksie (nowa wersja bez pliku): aktualizacja naprawdę pobiera plik, a nie raportuje fałszywego sukcesu');

  // wpis bez pliku znika z indeksu przy rozpoznawaniu zawartości
  const withGhost = await instances.readIndex(inst.id);
  withGhost['zniknal-1.0.jar'] = { projectId: 'zz', versionId: 'z1', versionNumber: '1.0', title: 'Zniknął', slug: 'zz', type: 'mod', size: 5, sha1: 'zz' };
  await instances.writeIndex(inst.id, withGhost);
  await modrinth.identifyInstance(inst.id);
  assert.ok(!(await instances.readIndex(inst.id))['zniknal-1.0.jar']);
  ok('identyfikacja usuwa z indeksu wpisy plików, których nie ma na dysku');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 7).join('\n')); process.exit(1); });
