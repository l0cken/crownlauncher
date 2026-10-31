const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-bi-'));
require(root + 'paths.js').init(dir);
const paths = require(root + 'paths.js');
const bundled = require(root + 'bundled-mods.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

function makeInstance(id, mcVersion, loader) {
  fs.mkdirSync(path.join(paths.instanceDir(id), 'game', 'mods'), { recursive: true });
  const inst = { id, name: id, mcVersion, loader };
  fs.writeFileSync(paths.instanceFile(id), JSON.stringify(inst));
  return inst;
}
const mods = (inst) => fs.readdirSync(path.join(paths.gameDir(inst.id), 'mods')).sort();

(async () => {
  const man = await bundled.manifest();
  assert.strictEqual(man.length, 11);
  assert.ok(man.every((m) => m.id === 'crownclient' && m.version.startsWith('1.0.0')));
  ok('manifest: 11 jarów komponentu CrownClient (1.21.4 - 26.3, bez Account Switchera)');

  // stara instancja z kopią Account Switchera z poprzednich wersji launchera i kopią wgraną przez gracza
  const a = makeInstance('a', '1.21.11', 'fabric');
  const modsDir = path.join(paths.gameDir('a'), 'mods');
  fs.writeFileSync(path.join(modsDir, 'accountswitcher-1.0.0+1.21.11.jar'), 'stary');
  fs.writeFileSync(path.join(modsDir, 'accountswitcher-1.1.0+1.21.11.jar'), 'gracza');
  fs.writeFileSync(path.join(modsDir, 'sodium-fabric.jar'), 'sodium');
  fs.writeFileSync(path.join(modsDir, 'crownclient-1.0.0+1.21.11.jar.disabled'), 'stara kopia bez indeksu');
  fs.writeFileSync(paths.contentIndex('a'), JSON.stringify({
    'accountswitcher-1.0.0+1.21.11.jar': { bundledId: 'accountswitcher', bundled: true },
    'sodium-fabric.jar': { projectId: 'AANobbMI' },
  }));
  const added = await bundled.ensureBundledMods(a);
  assert.deepStrictEqual(mods(a), ['accountswitcher-1.1.0+1.21.11.jar', 'sodium-fabric.jar']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(paths.contentIndex('a'), 'utf8')), { 'sodium-fabric.jar': { projectId: 'AANobbMI' } });
  assert.deepStrictEqual(added, ['crownclient-1.0.0+1.21.11.jar']);
  const args = await bundled.jvmArgs(a);
  const m = /^-Dfabric\.addMods=(.+)$/.exec(args[0] || '');
  assert.ok(m, args[0]);
  assert.ok(fs.existsSync(m[1]) && m[1].startsWith(path.join(dir, 'builtin-mods')));
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(m[1])).digest('hex'), man.find((e) => e.file.includes('1.21.11')).sha1);
  ok('kopia Account Switchera z launchera i stara kopia CrownClienta usunięte, Account Switcher gracza i cudzy mod zostają, CrownClient rozpakowany do katalogu launchera (-Dfabric.addMods)');

  // ponowny start i uszkodzenie pliku
  assert.deepStrictEqual(await bundled.ensureBundledMods(a), []);
  fs.writeFileSync(m[1], 'zepsuty');
  await bundled.ensureBundledMods(a);
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(m[1])).digest('hex'), man.find((e) => e.file.includes('1.21.11')).sha1);
  ok('ponowny start bez rozpakowywania; uszkodzony plik przywracany');

  // Quilt/Forge/NeoForge nie są już obsługiwane: żadnych argumentów
  for (const loader of ['quilt', 'forge', 'neoforge']) {
    const old = makeInstance(`old-${loader}`, '1.21.11', loader);
    assert.deepStrictEqual(await bundled.ensureBundledMods(old), []);
    assert.deepStrictEqual(await bundled.jvmArgs(old), []);
  }
  ok('Quilt/Forge/NeoForge: bez komponentu i bez argumentów');

  // każda obsługiwana wersja Minecrafta (1.21.4 - 26.3) ma własny jar; poza zakresem i dawna Vanilla: brak
  const supported = ['1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11', '26.1', '26.1.1', '26.1.2', '26.2', '26.3'];
  for (const v of supported) {
    const inst = makeInstance(`s${v}`, v, 'fabric');
    await bundled.ensureBundledMods(inst);
    const a = await bundled.jvmArgs(inst);
    assert.strictEqual(a.length, 1, `CrownClient dla ${v}`);
    assert.match(a[0], /^-Dfabric\.addMods=.*crownclient-1\.0\.0\+.*\.jar$/, v);
  }
  for (const [id, mc, loader] of [['v', '1.21.11', 'vanilla'], ['o', '1.21.3', 'fabric']]) {
    const inst = makeInstance(id, mc, loader);
    assert.deepStrictEqual(await bundled.jvmArgs(inst), []);
  }
  ok('Fabric 1.21.4 … 26.3 (13 wersji): każda dostaje CrownClienta; 1.21.3 i dawna Vanilla: brak');

  // zakres 26.1–26.1.2
  for (const v of ['26.1', '26.1.1', '26.1.2']) {
    const inst = makeInstance(`r${v}`, v, 'fabric');
    await bundled.ensureBundledMods(inst);
    assert.match((await bundled.jvmArgs(inst))[0], /crownclient-1\.0\.0\+26\.1-26\.1\.2\.jar$/);
  }
  ok('26.1, 26.1.1, 26.1.2: wspólny jar z zakresem');

  // własna kopia gracza (CrownClient wgrany ręcznie): nie dokładamy drugiej
  const u = makeInstance('u', '26.3', 'fabric');
  fs.writeFileSync(path.join(paths.gameDir('u'), 'mods', 'CrownClient-custom.jar'), 'wlasny');
  assert.deepStrictEqual(await bundled.ensureBundledMods(u), []);
  assert.deepStrictEqual(await bundled.jvmArgs(u), []);
  ok('własna kopia gracza: bez drugiej kopii i bez kasowania');

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 5).join('\n')); process.exit(1); });
