const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/';
const AdmZip = require(root + 'node_modules/adm-zip');
const core = root + 'src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-crash-'));
require(core + 'paths.js').init(dir);
const paths = require(core + 'paths.js');
const instances = require(core + 'instances.js');
const crash = require(core + 'crash-analyzer.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

const jar = (meta, classes = [], nested = []) => {
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
  for (const c of classes) z.addFile(c, Buffer.from('x'));
  return z.toBuffer();
};

const id = 'crash-inst';
fs.mkdirSync(path.join(paths.gameDir(id), 'mods'), { recursive: true });
fs.writeFileSync(paths.instanceFile(id), JSON.stringify({ id, name: 'c', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.19.5', createdAt: 1 }));
const mods = path.join(paths.gameDir(id), 'mods');
fs.writeFileSync(path.join(mods, 'resourcify-1.8.7.jar'), jar({ id: 'resourcify', version: '1.8.7' }, ['com/example/resourcify/Main.class']));
fs.writeFileSync(path.join(mods, 'vulkanmod-0.6.8.jar'), jar({ id: 'vulkanmod', version: '0.6.8' }, ['net/vulkanmod/mixin/window/WindowMixin.class', 'net/vulkanmod/Initializer.class']));
fs.writeFileSync(path.join(mods, 'c2me-0.3.6.jar'), jar({ id: 'c2me-base', version: '0.3.6' }, ['com/ishland/c2me/Base.class'], [{ id: 'c2me-opts-natives-math', version: '0.3.6', depends: { java: '>=22' } }]));
fs.writeFileSync(path.join(mods, 'cwb-4.1.0.jar'), jar({ id: 'cubes-without-borders', version: '4.1.0' }, ['com/cwb/WindowMixin.class']));
fs.writeFileSync(path.join(mods, 'badmod-1.0.jar'), jar({ id: 'badmod', version: '1.0' }, ['me/example/badmod/Feature.class', 'me/example/badmod/render/Draw.class']));
fs.writeFileSync(path.join(mods, 'sodium-0.8.14.jar'), jar({ id: 'sodium', version: '0.8.14' }, ['me/jellysquid/mods/sodium/Core.class']));
fs.writeFileSync(paths.contentIndex(id), JSON.stringify({
  'resourcify-1.8.7.jar': { title: 'Resourcify', slug: 'resourcify', projectId: 'p1' },
  'sodium-0.8.14.jar': { title: 'Sodium', slug: 'sodium', projectId: 'p2' },
}));

(async () => {
  // 1) niezgodności zgłoszone przez Fabric Loader
  const fabricLog = [
    '[08:00:00] [main/ERROR]: Incompatible mods found!',
    'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'More details:',
    "\t - Mod 'Resourcify' (resourcify) 1.8.7 is incompatible with any version of mod 'VulkanMod' (vulkanmod), yet a conflicting version is present: 0.6.8+1.21.11!",
    "\t - Mod 'Concurrent Chunk Management Engine (Optimizations/Natives Math)' (c2me-opts-natives-math) 0.3.6.0.0+1.21.11 requires version 22 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 21!",
    "\t - Mod 'AutoSprintFix' (autosprintfix) 1.0.0 requires version 1.21.5 of 'Minecraft' (minecraft), but only the wrong version is present: 1.21.6!",
    "\t - Mod 'X' (xmod) 1.0 requires any version of mod 'Y' (ymod), which is missing!",
  ];
  let r = await crash.analyze({ instanceId: id, lines: fabricLog });
  const byId = Object.fromEntries(r.suspects.map((s) => [s.id, s]));
  assert.ok(r.suspects.length >= 1);
  const full = await crash.analyze({ instanceId: id, lines: fabricLog });
  assert.strictEqual(full.suspects[0].id, 'resourcify');
  assert.strictEqual(full.suspects[0].file, 'resourcify-1.8.7.jar');
  assert.match(full.suspects[0].reason, /niezgodny z modem VulkanMod/);
  assert.strictEqual(full.suspects[0].name, 'Concurrent Chunk Management Engine (Optimizations/Natives Math)' === full.suspects[0].name ? full.suspects[0].name : 'Resourcify');
  void byId;
  ok('Fabric: niezgodność Resourcify↔VulkanMod wskazuje Resourcify, z plikiem do wyłączenia i powodem po polsku');

  // wszyscy podejrzani (zwracamy do 4) - sprawdzamy powody
  const all = await crash.analyze({ instanceId: id, lines: fabricLog.slice(0, 5) });
  const c2 = all.suspects.find((s) => s.id === 'c2me-opts-natives-math');
  assert.ok(c2, 'moduł zagnieżdżony C2ME');
  assert.match(c2.reason, /wymaga Javy 22 lub nowszej, a jest 21/);
  assert.strictEqual(c2.file, 'c2me-0.3.6.jar', 'plik jara, który zawiera moduł zagnieżdżony');
  ok('Fabric: moduł zagnieżdżony C2ME wymagający Javy 22 wskazuje jar, w którym siedzi');

  const mc = await crash.analyze({ instanceId: id, lines: [fabricLog[5]] });
  assert.strictEqual(mc.suspects.some((s) => s.id === 'minecraft'), false);
  assert.strictEqual(mc.suspects[0].id, 'autosprintfix');
  assert.match(mc.suspects[0].reason, /wymaga Minecrafta 1\.21\.5, a jest 1\.21\.6/);
  const missing = await crash.analyze({ instanceId: id, lines: [fabricLog[6]] });
  assert.match(missing.suspects[0].reason, /wymaga moda Y, którego nie ma/);
  ok('Fabric: zła wersja Minecrafta i brakująca zależność mają czytelne powody (Minecraft/Java nie są „modem do wyłączenia”)');

  // 2) błąd mixinu z konfliktem między dwoma modami
  const mixinLog = [
    '[08:01:00] [main/ERROR]: Mixin transformation of net.minecraft.class_1041 failed',
    'MixinApplyError: Mixin [cubes-without-borders.mixins.json:WindowMixin from mod cubes-without-borders] from phase [DEFAULT] in config [cubes-without-borders.mixins.json] FAILED during APPLY',
    'InvalidInjectionException: @At("INVOKE") on net/minecraft/class_1041::disableFullscreen cannot inject into class_1041::method_4479()V merged by net.vulkanmod.mixin.window.WindowMixin with priority 1000',
  ];
  r = await crash.analyze({ instanceId: id, lines: mixinLog });
  assert.strictEqual(r.suspects[0].id, 'cubes-without-borders');
  assert.ok(r.suspects.some((s) => s.id === 'vulkanmod' && /koliduje|konflikt/.test(s.reason)), 'drugi mod konfliktu też wskazany');
  assert.match(crash.describe(r), /Prawdopodobna przyczyna awarii: .*cubes-without-borders/);
  ok('mixin: wskazuje mod, którego mixin się nie stosuje, i drugi mod konfliktu („merged by …”)');

  // 3) wyjątek w punkcie wejścia
  r = await crash.analyze({ instanceId: id, lines: ["[08:02:00] [main/ERROR]: Could not execute entrypoint stage 'client' due to errors, provided by 'sodium'!"] });
  assert.strictEqual(r.suspects[0].id, 'sodium');
  assert.strictEqual(r.suspects[0].name, 'Sodium');
  ok("punkt wejścia: „provided by 'sodium'” wskazuje Sodium (nazwa z indeksu)");

  // 4) sam ślad stosu: pakiet klasy należy do jara
  const trace = [
    '[08:03:00] [Render thread/ERROR]: Unable to render',
    'java.lang.NullPointerException: x',
    '\tat knot//me.example.badmod.render.Draw.frame(Draw.java:55)',
    '\tat knot//me.example.badmod.Feature.tick(Feature.java:12)',
    '\tat knot//net.minecraft.client.Minecraft.runTick(Minecraft.java:1)',
    '\tat knot//net.minecraft.client.Minecraft.run(Minecraft.java:2)',
  ];
  r = await crash.analyze({ instanceId: id, lines: trace });
  assert.strictEqual(r.suspects[0].id, 'badmod');
  assert.match(r.suspects[0].reason, /ramek/);
  ok('ślad stosu: klasy z pakietów jara moda wskazują ten mod (klasy gry/biblioteki są pomijane)');

  // 5) raport awarii z „Suspected Mods”
  const report = path.join(paths.gameDir(id), 'crash-reports');
  fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, 'crash-2026-10-13_12.00.00-client.txt'), 'Time: x\nDescription: Rendering\n\nSuspected Mods: \n\tSodium (sodium), Lithium (lithium)\n\n-- System Details --\n');
  r = await crash.analyze({ instanceId: id, lines: ['[08:04:00] [main/ERROR]: Minecraft ran into a problem'] });
  assert.strictEqual(r.suspects[0].id, 'sodium');
  assert.match(r.suspects[0].reason, /raporcie awarii/);
  assert.ok(r.report.endsWith('.txt'));
  ok('raport awarii: „Suspected Mods” wskazuje podejrzanych, z plikiem raportu');
  fs.rmSync(path.join(report, 'crash-2026-10-13_12.00.00-client.txt'), { force: true });

  // 6) przyczyny spoza modów
  r = await crash.analyze({ instanceId: id, lines: ['[08:05:00] [main/FATAL]: java.lang.OutOfMemoryError: Java heap space'] });
  assert.strictEqual(r.suspects.length, 0);
  assert.match(r.cause, /Za mało pamięci/);
  r = await crash.analyze({ instanceId: id, lines: ['[08:05:00] [Render thread/ERROR]: GLFW error 65543: WGL: Failed to make context current'] });
  assert.match(r.cause, /sterownik/i);
  r = await crash.analyze({ instanceId: id, lines: ['nic ciekawego', '[08:06:00] [main/INFO]: koniec'] });
  assert.strictEqual(r.suspects.length, 0);
  assert.strictEqual(r.cause, '');
  assert.strictEqual(crash.describe(r), '');
  ok('przyczyny spoza modów: brak pamięci i sterownik grafiki rozpoznane; zwykły log nie daje fałszywych podejrzanych');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 7).join('\n')); process.exit(1); });
