const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/';
const AdmZip = require(root + 'node_modules/adm-zip');
const core = root + 'src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-fix-'));
require(core + 'paths.js').init(dir);
const paths = require(core + 'paths.js');
const crash = require(core + 'crash-analyzer.js');
const fixer = require(core + 'crash-fixer.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

const jarBytes = (meta, nested = []) => {
  const z = new AdmZip();
  const m = { schemaVersion: 1, ...meta };
  if (nested.length) {
    m.jars = nested.map((_, i) => ({ file: `META-INF/jars/n${i}.jar` }));
    nested.forEach((nm, i) => {
      const nz = new AdmZip();
      nz.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, ...nm })));
      z.addFile(`META-INF/jars/n${i}.jar`, nz.toBuffer());
    });
  }
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify(m)));
  z.addFile('x/Marker.class', Buffer.from('x'));
  return z.toBuffer();
};

// ---- atrapa Modrinth ---------------------------------------------------------------------------------------
const NEW = {}; // versionId -> { project, number, bytes }
const addVersion = (project, versionId, number, meta) => {
  const bytes = jarBytes(meta);
  NEW[versionId] = {
    id: versionId, project_id: project, version_number: number, version_type: 'release', date_published: '2026-06-01',
    game_versions: ['1.21.11'], loaders: ['fabric'], dependencies: [],
    files: [{ primary: true, filename: `${project}-${number}.jar`, url: `https://cdn.test/${project}-${number}.jar`, size: bytes.length, hashes: { sha1: sha1(bytes) } }],
    _bytes: bytes,
  };
};
const PROJECT_VERSIONS = {}; // project -> [version ids od najnowszej]
const SEARCH = {}; // zapytanie (małymi) -> [hit]
const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push(u.pathname);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let m;
  if ((m = /^\/v2\/project\/([^/]+)\/version$/.exec(u.pathname))) return json((PROJECT_VERSIONS[m[1]] || []).map((id) => NEW[id]));
  if ((m = /^\/v2\/version\/([^/]+)$/.exec(u.pathname))) return NEW[m[1]] ? json(NEW[m[1]]) : new Response('{}', { status: 404 });
  if (u.pathname === '/v2/version_files/update' && opts.method === 'POST') return json({});
  if (u.pathname === '/v2/search') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return json({ total_hits: (SEARCH[q] || []).length, hits: SEARCH[q] || [] });
  }
  if (u.hostname === 'cdn.test') {
    const v = Object.values(NEW).find((x) => x.files[0].url === url);
    return v ? new Response(v._bytes, { status: 200 }) : new Response('', { status: 404 });
  }
  return new Response('{}', { status: 404 });
};

// ---- instancja -----------------------------------------------------------------------------------------------
const id = 'fix-inst';
const modsDir = path.join(paths.gameDir(id), 'mods');
fs.mkdirSync(modsDir, { recursive: true });
fs.writeFileSync(paths.instanceFile(id), JSON.stringify({ id, name: 'fix', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', createdAt: 1 }));
const index = {};
const put = (file, meta, { project = '', versionId = '', nested = [] } = {}) => {
  const bytes = jarBytes(meta, nested);
  fs.writeFileSync(path.join(modsDir, file), bytes);
  if (project) index[file] = { projectId: project, versionId, versionNumber: meta.version, title: meta.name || meta.id, slug: project, sha1: sha1(bytes), type: 'mod' };
};
const flush = () => fs.writeFileSync(paths.contentIndex(id), JSON.stringify(index));
const has = (f) => fs.existsSync(path.join(modsDir, f));
const fabricLine = (s) => `[08:00:00] [main/ERROR]: ${s}`;

(async () => {
  // 1) niezgodność z rendererem: Resourcify schodzi, VulkanMod zostaje (chroniony)
  put('vulkanmod-0.6.8.jar', { id: 'vulkanmod', version: '0.6.8', name: 'VulkanMod' });
  put('resourcify-1.8.7.jar', { id: 'resourcify', version: '1.8.7', name: 'Resourcify' }, { project: 'resourcify', versionId: 'r1' });
  flush();
  let a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'Resourcify' (resourcify) 1.8.7 is incompatible with any version of mod 'VulkanMod' (vulkanmod), yet a conflicting version is present: 0.6.8!"),
  ] });
  assert.strictEqual(a.suspects[0].kind, 'incompatible');
  assert.strictEqual(a.suspects[0].other.id, 'vulkanmod');
  let r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed.length, 1);
  assert.strictEqual(r.fixed[0].action, 'disabled');
  assert.ok(!has('resourcify-1.8.7.jar') && has('resourcify-1.8.7.jar.disabled'), 'plik dostał .disabled');
  assert.ok(has('vulkanmod-0.6.8.jar'), 'renderer nietknięty');
  ok('niezgodność z rendererem: wyłączony Resourcify (z .disabled), VulkanMod zostaje');

  // 2) chroniony podejrzany: konflikt zgłoszony na VulkanMod -> schodzi drugi mod
  put('foo-1.0.jar', { id: 'foo', version: '1.0', name: 'Foo' });
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'VulkanMod' (vulkanmod) 0.6.8 is incompatible with any version of mod 'Foo' (foo), yet a conflicting version is present: 1.0!"),
  ] });
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed.length, 1);
  assert.strictEqual(r.fixed[0].id, 'foo');
  assert.ok(has('foo-1.0.jar.disabled') && has('vulkanmod-0.6.8.jar'));
  ok('podejrzany jest chroniony (VulkanMod) -> wyłączony zostaje drugi mod konfliktu');

  // 3) Java 22 w module zagnieżdżonym: wyłączony jar, który go zawiera (bez prób aktualizacji)
  put('c2me-0.3.6.jar', { id: 'c2me-base', version: '0.3.6' }, { nested: [{ id: 'c2me-opts-natives-math', version: '0.3.6', depends: { java: '>=22' } }] });
  const before = calls.length;
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'C2ME Math' (c2me-opts-natives-math) 0.3.6 requires version 22 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 21!"),
  ] });
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'disabled');
  assert.ok(has('c2me-0.3.6.jar.disabled'));
  assert.strictEqual(calls.length, before, 'Java: bez zapytań do Modrinth');
  ok('wymaga Javy 22: wyłączony jar z modułem zagnieżdżonym, bez odpytywania Modrinth');

  // 4) zły Minecraft + jest nowa wersja: zaktualizowany (stary jar znika, nowy jest)
  put('autosprintfix-1.0.jar', { id: 'autosprintfix', version: '1.0', name: 'AutoSprintFix' }, { project: 'asf', versionId: 'asf1' });
  addVersion('asf', 'asf2', '1.1', { id: 'autosprintfix', version: '1.1', name: 'AutoSprintFix' });
  addVersion('asf', 'asf1', '1.0', { id: 'autosprintfix', version: '1.0', name: 'AutoSprintFix' });
  PROJECT_VERSIONS.asf = ['asf2', 'asf1'];
  flush();
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'AutoSprintFix' (autosprintfix) 1.0 requires version 1.21.5 of 'Minecraft' (minecraft), but only the wrong version is present: 1.21.11!"),
  ] });
  assert.strictEqual(a.suspects[0].kind, 'minecraft');
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'updated', JSON.stringify(r));
  assert.match(r.fixed[0].note, /1\.1/);
  assert.ok(has('asf-1.1.jar') && !has('autosprintfix-1.0.jar'), fs.readdirSync(modsDir).join(','));
  ok('zła wersja Minecrafta + nowsza wersja na Modrinth: mod zaktualizowany');

  // 5) to samo po raz drugi (nowa wersja też się sypie): teraz wyłączany
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'AutoSprintFix' (autosprintfix) 1.1 requires version 1.21.5 of 'Minecraft' (minecraft), but only the wrong version is present: 1.21.11!"),
  ] });
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'disabled');
  assert.ok(has('asf-1.1.jar.disabled'));
  ok('ten sam mod zaktualizowany wcześniej i dalej zły: wyłączony (bez pętli aktualizacji)');

  // 6) brakująca zależność: doinstalowana z Modrinth
  put('xmod-1.0.jar', { id: 'xmod', version: '1.0', name: 'X Mod' });
  addVersion('ymod', 'y1', '2.0', { id: 'ymod', version: '2.0', name: 'Y Library' });
  PROJECT_VERSIONS.ymod = ['y1'];
  SEARCH['y library'] = [{ project_id: 'ymod', slug: 'y-library', title: 'Y Library', description: '', icon_url: '', author: 'a', downloads: 1, follows: 1, categories: [], project_type: 'mod', date_modified: '2026-01-01' }];
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'X Mod' (xmod) 1.0 requires any version of mod 'Y Library' (ymod), which is missing!"),
  ] });
  assert.strictEqual(a.suspects[0].kind, 'dependency');
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'installed', JSON.stringify(r));
  assert.strictEqual(r.fixed[0].requiredBy, 'X Mod');
  assert.ok(fs.readdirSync(modsDir).some((f) => /^ymod-2\.0\.jar$/.test(f)), 'jar zależności jest w mods');
  assert.ok(has('xmod-1.0.jar'), 'mod zostaje włączony');
  ok('brakująca zależność: doinstalowana z Modrinth, mod wymagający jej zostaje');

  // 7) dostarczył zależność, a mod dalej jej nie widzi (druga awaria): wyłączony mod wymagający
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'X Mod' (xmod) 1.0 requires any version of mod 'Y Library' (ymod), which is missing!"),
  ] });
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'disabled');
  assert.ok(has('xmod-1.0.jar.disabled'));
  ok('zależność już raz doinstalowana, a brakuje jej dalej: wyłączony mod wymagający (bez pętli)');

  // 8) za stary Fabric API: aktualizowana zależność, nie mod, który jej wymaga
  put('fabric-api-0.134.jar', { id: 'fabric-api', version: '0.134.0', name: 'Fabric API' }, { project: 'fabric-api', versionId: 'f1' });
  put('needs-api-1.0.jar', { id: 'needsapi', version: '1.0', name: 'Needs API' });
  addVersion('fabric-api', 'f2', '0.140.0', { id: 'fabric-api', version: '0.140.0', name: 'Fabric API' });
  addVersion('fabric-api', 'f1', '0.134.0', { id: 'fabric-api', version: '0.134.0', name: 'Fabric API' });
  PROJECT_VERSIONS['fabric-api'] = ['f2', 'f1'];
  flush();
  a = await crash.analyze({ instanceId: id, lines: [
    fabricLine("Mod 'Needs API' (needsapi) 1.0 requires version 0.140.0 or later of 'Fabric API' (fabric-api), but only the wrong version is present: 0.134.0!"),
  ] });
  assert.strictEqual(a.suspects[0].kind, 'dependency-version');
  assert.strictEqual(a.suspects[0].dep.file, 'fabric-api-0.134.jar');
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed[0].action, 'updated', JSON.stringify(r));
  assert.strictEqual(r.fixed[0].id, 'fabric-api');
  assert.ok(has('fabric-api-0.140.0.jar') && !has('fabric-api-0.134.jar'));
  assert.ok(has('needs-api-1.0.jar'), 'mod wymagający nie jest wyłączany');
  ok('za stary Fabric API: zaktualizowany Fabric API, mod wymagający zostaje');

  // 9) słabe wskazanie (sam ślad stosu) niczego nie wyłącza
  put('weak-1.0.jar', { id: 'weak', version: '1.0', name: 'Weak' });
  const z = new AdmZip(path.join(modsDir, 'weak-1.0.jar'));
  z.addFile('me/weak/Thing.class', Buffer.from('x'));
  z.writeZip(path.join(modsDir, 'weak-1.0.jar'));
  a = await crash.analyze({ instanceId: id, lines: [
    '[08:03:00] [Render thread/ERROR]: Unable', 'java.lang.NullPointerException: x', '\tat knot//me.weak.Thing.frame(Thing.java:55)', '\tat knot//me.weak.Thing.tick(Thing.java:12)',
  ] });
  assert.ok(a.suspects.some((s) => s.id === 'weak'));
  r = await fixer.fix(id, a);
  assert.strictEqual(r.fixed.length, 0);
  assert.ok(has('weak-1.0.jar'));
  ok('ślad stosu to za słabe wskazanie: nic nie jest wyłączane (tylko podpowiedź w oknie)');

  // 10) historia jest zapisana na dysku, opis do konsoli
  const hist = JSON.parse(fs.readFileSync(path.join(paths.instanceDir(id), 'crash-fixes.json'), 'utf8'));
  assert.ok(hist.resourcify.disabled && hist.autosprintfix.disabled && hist.ymod.installed);
  const text = fixer.describe({ fixed: [{ action: 'disabled', name: 'Resourcify', note: 'jest niezgodny z modem VulkanMod' }, { action: 'updated', name: 'Fabric API', note: 'x' }] });
  assert.match(text, /Wyłączono Resourcify — jest niezgodny z modem VulkanMod; Zaktualizowano Fabric API/);
  ok('historia napraw zapisana w instancji, opis do konsoli czytelny');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 8).join('\n')); process.exit(1); });
