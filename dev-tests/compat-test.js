const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/';
const AdmZip = require(root + 'node_modules/adm-zip');
const core = root + 'src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-compat-'));
const win = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-win-'));
fs.mkdirSync(path.join(win, 'System32'), { recursive: true });
fs.writeFileSync(path.join(win, 'System32', 'vulkan-1.dll'), 'x');
process.env.windir = win;
require(core + 'paths.js').init(dir);
const paths = require(core + 'paths.js');
const instances = require(core + 'instances.js');
const modrinth = require(core + 'modrinth.js');
const perf = require(core + 'performance-mods.js');
const modCheck = require(core + 'mod-check.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

// ---- sztuczne jary Fabric ------------------------------------------------------------------------------
const metaJar = (meta, nested = []) => {
  const z = new AdmZip();
  const m = { schemaVersion: 1, ...meta };
  if (nested.length) {
    m.jars = nested.map((nm, i) => ({ file: `META-INF/jars/n${i}.jar` }));
    nested.forEach((nm, i) => {
      const nz = new AdmZip();
      nz.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, ...nm })));
      z.addFile(`META-INF/jars/n${i}.jar`, nz.toBuffer());
    });
  }
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify(m)));
  return z.toBuffer();
};

// wersje (od najnowszej) i ich metadane
const V = {
  'fabric-api': [{ n: '0.134.1+1.21.9', meta: { id: 'fabric-api', version: '0.134.1+1.21.9', provides: ['fabric'] } }],
  vulkanmod: [{ n: '0.6.8', meta: { id: 'vulkanmod', version: '0.6.8', breaks: { 'gamma-utils': '*' } } }],
  'gamma-utils': [{ n: '3.1', meta: { id: 'gamma-utils', version: '3.1' } }],
  yacl: [
    { n: '3.8.2', meta: { id: 'yacl', version: '3.8.2', depends: { 'fabric-api': '>=0.138.3', minecraft: '1.21.x' } } },
    { n: '3.7.0', meta: { id: 'yacl', version: '3.7.0', depends: { 'fabric-api': '>=0.100.0', minecraft: '1.21.x' } } },
  ],
  'auto-sprint-fix': [
    { n: '1.0.1', meta: { id: 'autosprintfix', version: '1.0.1', depends: { minecraft: '1.21.5' } } },
    { n: '1.0.0', meta: { id: 'autosprintfix', version: '1.0.0', depends: { minecraft: '1.21.x' } } },
  ],
  ksyxis: [{ n: '1.4.3', meta: { id: 'ksyxis', version: '1.4.3' }, nested: [{ id: 'ksyxis-natives', version: '1', depends: { java: '>=22' } }] }],
  modmenu: [{ n: '20.0', meta: { id: 'modmenu', version: '20.0', breaks: { vulkanmod: '*' } } }],
  lithium: [{ n: '0.21', meta: { id: 'lithium', version: '0.21', depends: { minecraft: '~1.21.9', java: '>=21', fabricloader: '>=0.18.0' } } }],
};
const titles = {};
let installedLog = [];
modrinth.projects = async (slugs) => {
  const out = {};
  for (const s of slugs) {
    if (!V[s] && !['sodium', 'sodium-extra', 'iris', 'immediatelyfast', 'not-enough-vulkan'].includes(s)) {
      V[s] = [{ n: '1.0', meta: { id: s.replace(/-/g, '_'), version: '1.0' } }]; // niewinny mod
    }
    if (V[s]) out[s] = { id: `id-${s}`, slug: s, title: s, icon: '' };
    titles[`id-${s}`] = s;
  }
  return out;
};
modrinth.identifyInstance = async () => ({ identified: 0 });
modrinth.listVersions = async (projectId, { mcVersion }) => {
  const slug = projectId.replace(/^id-/, '');
  if (slug === 'vulkanmod' && mcVersion !== '1.21.9') return [];
  return (V[slug] || []).map((v) => ({ id: `${slug}@${v.n}`, type: 'release', number: v.n }));
};
modrinth.installContent = async ({ instanceId, projectId, versionId, slug, title, icon }) => {
  const [s, number] = versionId.split('@');
  const v = (V[s] || []).find((x) => x.n === number);
  const mods = path.join(paths.gameDir(instanceId), 'mods');
  fs.mkdirSync(mods, { recursive: true });
  const idx = await instances.readIndex(instanceId);
  for (const [name, m] of Object.entries(idx)) {
    if (m.projectId === projectId) {
      fs.rmSync(path.join(mods, name), { force: true });
      delete idx[name];
    }
  }
  const file = `${s}-${number}.jar`;
  fs.writeFileSync(path.join(mods, file), metaJar(v.meta, v.nested || []));
  idx[file] = { projectId, versionId, versionNumber: number, title, slug, icon };
  await instances.writeIndex(instanceId, idx);
  installedLog.push(file);
  return { installed: [{ title, file }] };
};

(async () => {
  // ---- sam mod-check na sztucznych jarach ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-mc-'));
  fs.writeFileSync(path.join(tmp, 'a.jar'), metaJar({ id: 'a', version: '1', depends: { minecraft: '>=1.21.5 <1.21.6', b: '>=2' } }));
  fs.writeFileSync(path.join(tmp, 'b.jar'), metaJar({ id: 'b', version: '1.5', provides: ['bee'] }));
  fs.writeFileSync(path.join(tmp, 'c.jar'), metaJar({ id: 'c', version: '1', breaks: { bee: '*' } }, [{ id: 'cm', version: '1', depends: { java: '>=22' } }]));
  const res = await modCheck.validate(tmp, ['a.jar', 'b.jar', 'c.jar'], { minecraft: '1.21.9', java: '21', fabricloader: '0.19.5' });
  const kinds = (f) => (res.bad.get(f) || []).map((p) => `${p.kind}:${p.other}`).sort();
  assert.deepStrictEqual(kinds('a.jar'), ['depends:b', 'depends:minecraft']);
  assert.deepStrictEqual(kinds('c.jar'), ['breaks:bee', 'depends:java']);
  assert.ok(!res.bad.has('b.jar'));
  ok('mod-check: zła wersja gry/zależności, `breaks` (także przez provides) i moduł zagnieżdżony wymagający Javy 22 są wykryte');

  // ---- instalacja pakietu z naprawą zgodności ----
  const inst = await instances.create({ name: 'compat', mcVersion: '1.21.9', loader: 'fabric', loaderVersion: '0.19.5' }).catch(() => null);
  // create() pyta sieć o manifest - tworzymy instancję ręcznie
  const id = 'compat-test';
  const instance = { id, name: 'compat', mcVersion: '1.21.9', loader: 'fabric', loaderVersion: '0.19.5', createdAt: 1 };
  fs.mkdirSync(paths.gameDir(id), { recursive: true });
  fs.writeFileSync(paths.instanceFile(id), JSON.stringify(instance));
  void inst;

  const out = await perf.optimize(id);
  const files = fs.readdirSync(path.join(paths.gameDir(id), 'mods')).sort();
  const has = (prefix) => files.some((f) => f.startsWith(prefix));
  assert.ok(has('yacl-3.7.0'), `YACL cofnięty do zgodnej wersji: ${files.join(',')}`);
  assert.ok(!has('yacl-3.8.2'));
  assert.ok(has('auto-sprint-fix-1.0.0') && !has('auto-sprint-fix-1.0.1'), 'AutoSprintFix cofnięty do wersji dla 1.21.x');
  assert.ok(!has('ksyxis'), 'moduł zagnieżdżony wymagający Javy 22 -> mod usunięty (brak starszej zgodnej)');
  assert.ok(!has('modmenu'), 'mod deklarujący breaks vulkanmod usunięty');
  assert.ok(has('vulkanmod') && !has('gamma-utils'), 'konflikt z rendererem: schodzi druga strona (Gamma Utils), VulkanMod zostaje');
  assert.ok(has('lithium') && has('fabric-api'));
  assert.ok(out.downgraded.some((d) => /yacl/.test(d)) && out.downgraded.some((d) => /auto-sprint-fix/.test(d)));
  assert.ok(out.skipped.some((x) => /ksyxis/.test(x)) && out.skipped.some((x) => /modmenu/.test(x)) && out.skipped.some((x) => /gamma-utils/.test(x)));
  ok('pakiet: YACL i AutoSprintFix cofnięte do zgodnych wersji; Ksyxis (Java 22) i Mod Menu (breaks) usunięte; z VulkanMod kolidujący Gamma Utils schodzi, renderer zostaje');

  // ---- po naprawie zestaw jest spójny ----
  const final = await modCheck.validate(path.join(paths.gameDir(id), 'mods'), fs.readdirSync(path.join(paths.gameDir(id), 'mods')), { minecraft: '1.21.9', java: '21', fabricloader: '0.19.5' });
  assert.strictEqual(final.bad.size, 0, JSON.stringify([...final.bad]));
  ok('po naprawie wszystkie mody w instancji przechodzą kontrolę zgodności');

  // ---- duplikaty: ten sam mod w dwóch plikach -> zostaje najnowsza wersja ----
  {
    const did = 'dedupe-test';
    fs.mkdirSync(paths.gameDir(did), { recursive: true });
    fs.writeFileSync(paths.instanceFile(did), JSON.stringify({ id: did, name: 'd', mcVersion: '1.21.9', loader: 'fabric', loaderVersion: '0.19.5', createdAt: 1 }));
    const mods = path.join(paths.gameDir(did), 'mods');
    fs.mkdirSync(mods, { recursive: true });
    const put = (file, meta, ageSeconds = 0) => {
      fs.writeFileSync(path.join(mods, file), metaJar(meta));
      const t = new Date(Date.now() - ageSeconds * 1000);
      fs.utimesSync(path.join(mods, file), t, t);
    };
    put('modernfix-5.20.jar', { id: 'modernfix', version: '5.20.3+mc1.21.4' });
    put('modernfix-mvus-5.27.jar', { id: 'modernfix', version: '5.27.19+mc1.21.9' });
    put('sodium-0.6.13.jar', { id: 'sodium', version: '0.6.13' });
    put('sodium-0.8.14.jar', { id: 'sodium', version: '0.8.14' });
    put('tie-a.jar', { id: 'tie', version: '1.0' }, 100);
    put('tie-b.jar', { id: 'tie', version: '1.0' }, 0);
    put('alone.jar', { id: 'alone', version: '1.0' });
    put('disabled-old.jar.disabled', { id: 'alone', version: '0.1' });
    fs.writeFileSync(path.join(mods, 'readme.txt'), 'x');
    await instances.writeIndex(did, {
      'modernfix-5.20.jar': { projectId: 'p-mf', slug: 'modernfix', title: 'ModernFix' },
      'modernfix-mvus-5.27.jar': { projectId: 'p-mfv', slug: 'modernfix-mvus', title: 'ModernFix-mVUS' },
      'sodium-0.6.13.jar': { projectId: 'p-s', slug: 'sodium', title: 'Sodium' },
      'sodium-0.8.14.jar': { projectId: 'p-s', slug: 'sodium', title: 'Sodium' },
    });
    const removed = await modCheck.dedupe(did);
    const left = fs.readdirSync(mods).sort();
    assert.deepStrictEqual(left, ['alone.jar', 'disabled-old.jar.disabled', 'modernfix-mvus-5.27.jar', 'readme.txt', 'sodium-0.8.14.jar', 'tie-b.jar']);
    assert.deepStrictEqual(removed.map((r) => r.file).sort(), ['modernfix-5.20.jar', 'sodium-0.6.13.jar', 'tie-a.jar']);
    const idx = await instances.readIndex(did);
    assert.ok(!idx['modernfix-5.20.jar'] && !idx['sodium-0.6.13.jar'], 'wpisy usuniętych znikają z indeksu');
    assert.ok(idx['sodium-0.8.14.jar'] && idx['modernfix-mvus-5.27.jar']);
    assert.deepStrictEqual(await modCheck.dedupe(did), [], 'drugie wywołanie nic nie zmienia');
    assert.ok(modCheck.compareVersions('0.8.14+mc1.21.11', '0.8.9') > 0 && modCheck.compareVersions('1.10', '1.9') > 0);
    ok('duplikaty po id moda: zostaje najnowsza wersja (ModernFix vs fork, Sodium stary/nowy, remis -> nowszy plik), wyłączone i obce pliki nietknięte');
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 7).join('\n')); process.exit(1); });
