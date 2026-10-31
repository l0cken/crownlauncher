// Start gry z wbudowanym CrownClientem na kolejnych wersjach: czy mod się ładuje i czy mixiny się aplikują.
const P = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';
const paths = require(P + 'paths.js');
paths.init(process.env.SHOT_DATA);
const instances = require(P + 'instances.js');
const { prepare } = require(P + 'installer.js');
const { buildCommand, run } = require(P + 'launch.js');
const bundled = require(P + 'bundled-mods.js');

const versions = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = /Mixin apply failed|InvalidInjection|Critical injection|MixinTransformerError|Mixin transformation|NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|Failed to load mod|crownclient.*(error|exception|fail)/i;

(async () => {
  const results = [];
  for (const mc of versions) {
    const inst = await instances.create({ name: `SMOKE ${mc}`, mcVersion: mc, loader: 'fabric' });
    let verdict = { mc, ok: false, note: '' };
    try {
      await bundled.ensureBundledMods(inst);
      const prep = await prepare(inst, () => {});
      const extraJvm = await bundled.jvmArgs(inst);
      if (!extraJvm.length) throw new Error('brak argumentu -Dfabric.addMods (jar nie dobrany)');
      const cmd = buildCommand({
        instance: inst,
        account: { username: 'CrownSmoke', uuid: '00000000000000000000000000000000', type: 'offline' },
        prep,
        config: { memoryMb: 2048, jvmArgs: '' },
        extraJvm,
      });
      const lines = [];
      let exited = null;
      const child = await run(cmd, { onLine: (l) => lines.push(l), onExit: (c) => (exited = c) });
      const t0 = Date.now();
      let soundAt = 0;
      while (Date.now() - t0 < 240000 && exited === null) {
        if (!soundAt && lines.some((l) => /Sound engine started/.test(l))) soundAt = Date.now();
        if (soundAt && Date.now() - soundAt > 8000) break;
        await sleep(500);
      }
      const crashed = exited !== null;
      child.kill();
      await sleep(1500);
      const loaded = lines.some((l) => /^\s*- crownclient /.test(l) || /crownclient 1\.0\.0/.test(l));
      const bad = lines.filter((l) => BAD.test(l)).slice(0, 4);
      verdict = {
        mc,
        ok: Boolean(soundAt) && !crashed && loaded && bad.length === 0,
        note: `silnik dźwięku=${Boolean(soundAt)} zamknięta_sama=${crashed}${crashed ? ` (kod ${exited})` : ''} mod_załadowany=${loaded} błędy=${bad.length}`,
        bad,
      };
    } catch (e) {
      verdict.note = `WYJĄTEK: ${e.message}`;
    } finally {
      await instances.remove(inst.id).catch(() => {});
    }
    results.push(verdict);
    console.log(`${verdict.ok ? 'OK  ' : 'FAIL'} ${mc}  ${verdict.note}`);
    for (const b of verdict.bad || []) console.log('   !', b.slice(0, 220));
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
