// Dla każdej wersji: profil optymalizacji (renderer + mody) i start gry z tym zestawem.
const fs = require('fs');
const path = require('path');
const P = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';
const paths = require(P + 'paths.js');
paths.init(process.env.SHOT_DATA);
const instances = require(P + 'instances.js');
const { prepare } = require(P + 'installer.js');
const { buildCommand, run } = require(P + 'launch.js');
const bundled = require(P + 'bundled-mods.js');
const perf = require(P + 'performance-mods.js');
const config = require(P + 'config.js');

const versions = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = /Mixin apply failed|InvalidInjection|Critical injection|MixinTransformerError|NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|Failed to load mod|Incompatible mod set|Incompatible mods found|requires .* of|Could not execute entrypoint|Crash report|has crashed/i;

(async () => {
  console.log(`vulkan-1.dll: ${perf.vulkanAvailable()} | renderer: ${config.get().renderer}`);
  let failures = 0;
  for (const mc of versions) {
    const inst = await instances.create({ name: `PERF ${mc}`, mcVersion: mc, loader: 'fabric' });
    let note = '';
    let ok = false;
    try {
      const res = await perf.optimize(inst.id);
      const mods = (await instances.listContent(inst.id, 'mod')).map((m) => m.title || m.file);
      note += `renderer=${res.renderer} dodano=${res.added.length} usuniete=${res.removed.length} pominiete=[${(res.skipped || []).join(',')}] BLEDY=[${(res.failed || []).map((x) => x.title + ': ' + x.error).join(' | ')}] COFNIETE=[${(res.downgraded || []).join(' ; ')}] pliki=${mods.length}`;
      await bundled.ensureBundledMods(inst);
      const prep = await prepare(inst, () => {});
      const extraJvm = await bundled.jvmArgs(inst);
      const cmd = buildCommand({
        instance: inst,
        account: { username: 'PerfTest', uuid: '00000000000000000000000000000000', type: 'offline' },
        prep,
        config: { memoryMb: 3072, jvmArgs: '' },
        extraJvm,
      });
      const java25 = cmd.args.includes('-XX:+UseCompactObjectHeaders');
      const lines = [];
      let exited = null;
      const child = await run(cmd, { onLine: (l) => lines.push(l), onExit: (c) => (exited = c) });
      const t0 = Date.now();
      let soundAt = 0;
      while (Date.now() - t0 < 420000 && exited === null) {
        if (!soundAt && lines.some((l) => /Sound engine started/.test(l))) soundAt = Date.now();
        if (soundAt && Date.now() - soundAt > 10000) break;
        await sleep(500);
      }
      const crashed = exited !== null;
      child.kill();
      await sleep(2000);
      const bad = lines.filter((l) => BAD.test(l)).slice(0, 3);
      const modsLoaded = (lines.find((l) => /Loading \d+ mods/.test(l)) || '').trim();
      ok = Boolean(soundAt) && !crashed && bad.length === 0;
      note += ` | start: dzwiek=${Boolean(soundAt)} padla=${crashed}${crashed ? `(kod ${exited})` : ''} compactHeaders=${java25} ${modsLoaded}`;
      for (const b of bad) note += `\n      ! ${b.slice(0, 200)}`;
      if (!ok && crashed) {
        const tail = lines.slice(-12).join('\n').slice(0, 1500);
        note += `\n--- koniec logu ---\n${tail}`;
      }
    } catch (e) {
      note += ` WYJATEK: ${e.message}`;
    } finally {
      await instances.remove(inst.id).catch(() => {});
    }
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${mc}: ${note}`);
  }
  console.log(failures ? `\nNIEPOWODZENIA: ${failures}` : '\nWSZYSTKO OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('BLAD:', e.message); process.exit(1); });
