const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-perf-'));
// komputer „z Vulkanem”: windir ze sterownikiem
const win = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-win-'));
fs.mkdirSync(path.join(win, 'System32'), { recursive: true });
fs.writeFileSync(path.join(win, 'System32', 'vulkan-1.dll'), 'x');
process.env.windir = win;

require(root + 'paths.js').init(dir);
const paths = require(root + 'paths.js');
const config = require(root + 'config.js');
const instances = require(root + 'instances.js');
const modrinth = require(root + 'modrinth.js');
const perf = require(root + 'performance-mods.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

// ---- atrapa Modrinth: które wydania istnieją dla której wersji gry ----
let AVAIL = {}; // `${slug}@${mc}` albo `${slug}@*` -> typ wydania
const knownSlugs = new Set([...perf.PERFORMANCE_MODS, 'sodium', 'sodium-extra', 'iris', 'immediatelyfast', 'vulkanmod', 'not-enough-vulkan', 'modernfix']);
modrinth.projects = async (slugs) => {
  const out = {};
  for (const s of slugs) {
    if (!knownSlugs.has(s)) continue;
    const p = { id: `id-${s}`, slug: s, title: s, icon: '' };
    out[s] = p;
    out[p.id] = p;
  }
  return out;
};
modrinth.identifyInstance = async () => ({ identified: 0 });
modrinth.listVersions = async (projectId, { mcVersion }) => {
  const slug = projectId.replace(/^id-/, '');
  const type = AVAIL[`${slug}@${mcVersion}`] ?? AVAIL[`${slug}@*`];
  return type ? [{ id: `v-${slug}-${mcVersion}`, type, number: `1.0-${type}` }] : [];
};
const installed = [];
modrinth.installContent = async ({ instanceId, projectId, versionId, slug, title }) => {
  if (/NIEDOZWOLONY/.test(slug)) throw new Error('niedozwolony na tym launcherze');
  const mods = path.join(paths.gameDir(instanceId), 'mods');
  fs.mkdirSync(mods, { recursive: true });
  const file = `${slug}-fabric-1.0.jar`;
  if (fs.existsSync(path.join(mods, file))) return { installed: [], already: true };
  fs.writeFileSync(path.join(mods, file), 'x');
  const idx = await instances.readIndex(instanceId);
  idx[file] = { projectId, versionId, slug, title };
  await instances.writeIndex(instanceId, idx);
  installed.push(`${instanceId}:${slug}`);
  return { installed: [file] };
};

const everything = (extra = {}) => {
  const a = {};
  for (const s of knownSlugs) a[`${s}@*`] = 'release';
  delete a['modernfix@*'];
  delete a['vulkanmod@*'];
  delete a['not-enough-vulkan@*'];
  return { ...a, ...extra };
};
const modsOf = async (inst) => (await instances.listContent(inst.id, 'mod')).map((m) => m.slug || m.file).sort();
const newInst = (mc) => instances.create({ name: `t-${mc}-${Math.random().toString(36).slice(2, 6)}`, mcVersion: mc, loader: 'fabric', loaderVersion: '0.19.5' });
const OPENGL = ['sodium', 'sodium-extra', 'iris', 'immediatelyfast'];

(async () => {
  // ---- wybór renderera ----
  const c = perf.chooseRenderer;
  assert.strictEqual(c({ mcVersion: '1.21.11', vulkan: true, vulkanModBuild: true }), 'vulkanmod');
  assert.strictEqual(c({ mcVersion: '26.1.2', vulkan: true, vulkanModBuild: true }), 'vulkanmod');
  assert.strictEqual(c({ mcVersion: '26.2', vulkan: true, vulkanModBuild: true }), 'sodium');
  assert.strictEqual(c({ mcVersion: '26.3', vulkan: true, vulkanModBuild: true }), 'sodium');
  assert.strictEqual(c({ mcVersion: '1.21.8', vulkan: true, vulkanModBuild: false }), 'sodium');
  assert.strictEqual(c({ mcVersion: '1.21.11', vulkan: false, vulkanModBuild: true }), 'sodium');
  assert.strictEqual(c({ mcVersion: '1.21.11', setting: 'sodium', vulkan: true, vulkanModBuild: true }), 'sodium');
  ok('wybór renderera: poniżej 26.2 VulkanMod (gdzie jest wydanie i sterownik), od 26.2 Sodium, ustawienie „Sodium” wygrywa');

  // ---- nowa instancja 1.21.11: VulkanMod + Not Enough Vulkan, bez rodziny Sodium ----
  AVAIL = everything({ 'vulkanmod@1.21.11': 'release', 'not-enough-vulkan@1.21.11': 'release' });
  const a = await newInst('1.21.11');
  const added = await perf.ensure(a);
  const modsA = await modsOf(a);
  assert.ok(modsA.includes('vulkanmod') && modsA.includes('not-enough-vulkan'));
  for (const s of OPENGL) assert.ok(!modsA.includes(s), `${s} nie powinien być przy VulkanMod`);
  for (const s of ['lithium', 'ferrite-core', 'entityculling', 'moreculling', 'gamma-utils', 'simple-voice-chat', 'modmenu', 'fabric-api', 'cloth-config']) {
    assert.ok(modsA.includes(s), s);
  }
  assert.ok(!modsA.includes('resourcify'), 'Resourcify jest niezgodny z VulkanMod');
  assert.ok(!modsA.includes('c2me-fabric'), 'C2ME wymaga Javy 22+, a 1.21.x działa na Javie 21');
  const i = await instances.get(a.id);
  assert.strictEqual(i.perfRenderer, 'vulkanmod');
  assert.strictEqual(i.perfProfile, perf.PROFILE_VERSION);
  assert.ok(added.includes('vulkanmod'));
  ok('nowa instancja 1.21.11: VulkanMod + Not Enough Vulkan + cały pakiet, bez Sodium/Sodium Extra/Iris/ImmediatelyFast');

  // ---- 26.1.2: Java 25 -> C2ME jest, ale Resourcify (VulkanMod) nie ----
  AVAIL['vulkanmod@26.1.2'] = 'release';
  const a3 = await newInst('26.1.2');
  await perf.ensure(a3);
  const m3 = await modsOf(a3);
  assert.ok(m3.includes('vulkanmod') && m3.includes('c2me-fabric') && !m3.includes('resourcify'));
  const dd = await newInst('26.2');
  await perf.ensure(dd);
  const md = await modsOf(dd);
  assert.ok(md.includes('sodium') && md.includes('resourcify') && md.includes('c2me-fabric'), 'z Sodium i na Javie 25 jest pełny pakiet');
  ok('wyjątki: Resourcify znika przy VulkanMod, C2ME tylko na Javie 25 (26.1+); przy Sodium na 26.2 komplet');

  // ---- Not Enough Vulkan tylko tam, gdzie ma wydanie ----
  AVAIL['vulkanmod@1.21.4'] = 'beta';
  const a2 = await newInst('1.21.4');
  await perf.ensure(a2);
  const m2 = await modsOf(a2);
  assert.ok(m2.includes('vulkanmod') && !m2.includes('not-enough-vulkan') && !m2.includes('sodium'));
  ok('1.21.4: VulkanMod (beta) bez Not Enough Vulkan (brak wydania), bez Sodium');

  // ---- 1.21.6: brak VulkanMod -> Sodium + dodatki ----
  const b = await newInst('1.21.6');
  await perf.ensure(b);
  const modsB = await modsOf(b);
  for (const s of OPENGL) assert.ok(modsB.includes(s), s);
  assert.ok(!modsB.includes('vulkanmod'));
  ok('1.21.6 (brak VulkanMod): Sodium + Sodium Extra + Iris + ImmediatelyFast + pakiet');

  // ---- 26.2: Sodium mimo że VulkanMod „miałby” wydanie ----
  AVAIL['vulkanmod@26.2'] = 'release';
  const d = await newInst('26.2');
  await perf.ensure(d);
  const modsD = await modsOf(d);
  assert.ok(modsD.includes('sodium') && modsD.includes('iris') && !modsD.includes('vulkanmod'));
  ok('26.2: Sodium (Vulkan wbudowany w opcje gry), nie VulkanMod');

  // ---- kanały: „tak jak jest na Modrinth” (alpha też), wersje bez wydania pomijane, grupa ModernFix ----
  AVAIL['scalablelux@26.3'] = 'alpha';
  AVAIL['modernfix@1.21.4'] = 'release';
  delete AVAIL['cubes-without-borders@*'];
  const e = await newInst('26.3');
  await perf.ensure(e);
  const modsE = await modsOf(e);
  assert.ok(modsE.includes('scalablelux'), 'alpha jest instalowana, jeśli to jedyne wydanie');
  assert.ok(!modsE.includes('cubes-without-borders'), 'brak wydania -> pomijany');
  AVAIL['cubes-without-borders@*'] = 'release';
  const f4 = await newInst('1.21.4');
  AVAIL['modernfix-mvus@*'] = undefined;
  delete AVAIL['modernfix-mvus@*'];
  await perf.ensure(f4);
  assert.ok((await modsOf(f4)).includes('modernfix'), 'ModernFix (1.21.4) zamiast modernfix-mvus');
  ok('wydania jak na Modrinth: alpha gdy to jedyne, brak wydania pomijany, ModernFix wybiera dostępny projekt');

  // ---- błąd jednego moda nie przerywa reszty ----
  const failing = await newInst('1.21.11');
  const oldInstall = modrinth.installContent;
  modrinth.installContent = async (opts) => {
    if (opts.slug === 'gamma-utils') throw new Error('nie udało się zainstalować (test)');
    return oldInstall(opts);
  };
  const resFail = await perf.optimize(failing.id);
  modrinth.installContent = oldInstall;
  assert.ok(resFail.failed.some((x) => x.title === 'gamma-utils'));
  assert.ok((await modsOf(failing)).includes('lithium'), 'reszta pakietu zainstalowana mimo błędu jednego moda');
  ok('błąd instalacji jednego moda jest zgłoszony, a reszta pakietu się instaluje');

  // ---- ustawienie „zawsze Sodium” ----
  config.set({ renderer: 'sodium' });
  const g0 = await newInst('1.21.11');
  await perf.ensure(g0);
  assert.ok((await modsOf(g0)).includes('sodium'));
  config.set({ renderer: 'auto' });
  ok('ustawienie „Zawsze Sodium” wymusza Sodium także tam, gdzie jest VulkanMod');

  // ---- dawna instancja nie jest ruszana sama; „Optymalizuj” zamienia rodzinę Sodium na Vulkan ----
  const g = await newInst('1.21.11');
  fs.mkdirSync(path.join(paths.gameDir(g.id), 'mods'), { recursive: true });
  const idx = {};
  for (const s of ['sodium', 'sodium-extra', 'iris', 'immediatelyfast', 'lithium']) {
    fs.writeFileSync(path.join(paths.gameDir(g.id), 'mods', `${s}-fabric-1.0.jar`), 'x');
    idx[`${s}-fabric-1.0.jar`] = { slug: s, title: s, projectId: `id-${s}` };
  }
  await instances.writeIndex(g.id, idx);
  await instances.update(g.id, { perfModsApplied: true });
  assert.deepStrictEqual(await perf.ensure(await instances.get(g.id)), [], 'dawnej instancji launcher nie rusza sam');
  const before = await modsOf(g);
  assert.ok(before.includes('sodium') && !before.includes('gamma-utils'));
  const res = await perf.optimize(g.id);
  const after = await modsOf(g);
  for (const s of OPENGL) assert.ok(!after.includes(s), `${s} zdjęty`);
  assert.ok(after.includes('vulkanmod') && after.includes('not-enough-vulkan') && after.includes('gamma-utils'));
  assert.ok(res.removed.includes('sodium') && res.added.includes('vulkanmod'));
  ok('dawna instancja: sama bez zmian; „Optymalizuj” zdejmuje Sodium/Extra/Iris/ImmediatelyFast i daje VulkanMod + Not Enough Vulkan + pakiet');

  // ---- awaria VulkanMod: powrót do rodziny Sodium i brak ponownych prób ----
  assert.strictEqual(await perf.fallbackFromVulkan(g.id), true);
  const back = await modsOf(g);
  assert.ok(back.includes('sodium') && !back.includes('vulkanmod') && !back.includes('not-enough-vulkan'), back.join(','));
  const st = await instances.get(g.id);
  assert.strictEqual(st.perfVulkanFailed, true);
  assert.strictEqual(st.perfRenderer, 'sodium');
  await perf.optimize(g.id);
  assert.ok(!(await modsOf(g)).includes('vulkanmod'), 'po awarii nie próbujemy ponownie z Vulkanem');
  ok('awaria VulkanMod: wraca Sodium, instancja jest oznaczona i nie dostaje już VulkanMod');

  // ---- paczka (dużo modów) nie jest ruszana automatycznie ----
  const p = await newInst('1.21.11');
  await instances.update(p.id, { perfModsApplied: true });
  fs.mkdirSync(path.join(paths.gameDir(p.id), 'mods'), { recursive: true });
  for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(paths.gameDir(p.id), 'mods', `pack-mod-${k}.jar`), 'x');
  assert.deepStrictEqual(await perf.ensure(await instances.get(p.id)), []);
  assert.strictEqual((await modsOf(p)).length, 20);
  ok('instancja z paczką modów pozostaje nietknięta (pakiet tylko na życzenie)');

  // ---- przełącznik wyłączony ----
  config.set({ optimizeMods: false });
  const q = await newInst('1.21.11');
  assert.deepStrictEqual(await perf.ensure(q), []);
  config.set({ optimizeMods: true });
  ok('przełącznik „Mody optymalizujące” wyłączony: nic nie jest dokładane');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 6).join('\n')); process.exit(1); });
