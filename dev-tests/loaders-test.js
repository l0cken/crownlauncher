const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const AdmZip = require('C:/Users/meabx/Desktop/CrownLauncher/node_modules/adm-zip');
const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';
Object.assign(require(root + 'app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false }); // test trybu GitHub: nie zależy od produkcyjnego app-config.js

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-ld-'));
require(root + 'paths.js').init(dir);
const loaders = require(root + 'loaders.js');
const instances = require(root + 'instances.js');
const modrinth = require(root + 'modrinth.js');
const game = require(root + 'game.js');

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

(async () => {
  assert.deepStrictEqual(loaders.LOADERS, ['fabric']);
  ok('lista loaderów: tylko fabric');

  for (const l of ['quilt', 'forge', 'neoforge']) assert.deepStrictEqual(await loaders.listLoaderVersions(l, '1.21.11'), []);
  const fab = await loaders.listLoaderVersions('fabric', '1.21.11');
  assert.ok(fab.length > 0 && fab[0].version);
  ok(`wersje loadera: Fabric ${fab.length}, pozostałe puste`);

  for (const l of ['quilt', 'forge', 'neoforge']) {
    await assert.rejects(() => instances.create({ name: `x ${l}`, mcVersion: '1.21.11', loader: l }), /Nieznany loader/);
  }
  ok('tworzenie instancji Quilt/Forge/NeoForge jest odrzucane');

  await assert.rejects(() => loaders.ensureLoader({ loader: 'quilt', mcVersion: '1.21.11', loaderVersion: '0.1' }, 'java'), /nie jest już obsługiwany/);
  ok('ensureLoader zgłasza czytelny błąd dla starego loadera');

  // istniejąca instancja ze starym loaderem: błąd zanim cokolwiek się pobierze
  const id = 'stara-quilt';
  fs.mkdirSync(path.join(dir, 'instances', id, 'game'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'instances', id, 'instance.json'), JSON.stringify({ id, name: 'Stara', mcVersion: '1.21.11', loader: 'quilt', loaderVersion: '0.24.0' }));
  await assert.rejects(() => game.launch(id), /nie jest już obsługiwany/);
  assert.ok(fs.existsSync(path.join(dir, 'instances', id, 'instance.json')), 'dane instancji zostają');
  ok('uruchomienie starej instancji Quilt: komunikat, a dane instancji zostają na dysku');

  // paczki .mrpack wymagające usuniętych loaderów
  for (const key of ['forge', 'neoforge', 'quilt-loader']) {
    const z = new AdmZip();
    z.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
      formatVersion: 1, game: 'minecraft', name: 'Test', files: [],
      dependencies: { minecraft: '1.21.11', [key]: '1.0.0' },
    })));
    const file = path.join(dir, `pack-${key}.mrpack`);
    z.writeZip(file);
    await assert.rejects(() => modrinth.importMrpackFile(file), /obsługuje tylko Fabric/);
  }
  ok('import .mrpack z Forge/NeoForge/Quilt: odrzucony z czytelnym błędem (bez tworzenia instancji)');
  assert.strictEqual((await instances.list()).filter((i) => i.name === 'Test').length, 0);

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 5).join('\n')); process.exit(1); });
