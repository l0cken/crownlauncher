// Eksport instancji do .mrpack: strumieniowy zapis ZIP-a (zip-writer.js) i zawartość paczki (export.js).
// Uruchomienie: node dev-tests/export-test.js
// Paczkę czytają niezależnie: adm-zip (jak import launchera) i systemowe `tar` (bsdtar w Windows 10+, GNU tar w Linuksie) - jeśli jest.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

(async () => {
  Object.assign(require(root + 'src/main/core/app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-export-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-export-out-'));
  require(root + 'src/main/core/paths.js').init(dataDir);
  const paths = require(root + 'src/main/core/paths.js');
  const { ZipWriter, crc32, crc32Fallback } = require(root + 'src/main/core/zip-writer.js');

  // ---- ZipWriter ----
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 wzorcowy ciąg');
  assert.strictEqual(crc32Fallback(Buffer.from('123456789')), 0xcbf43926, 'tablica zapasowa daje ten sam wynik');
  assert.strictEqual(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xcbf43926, 'CRC liczony kawałkami');
  ok('CRC-32: wynik wzorcowy, tablica zapasowa i liczenie kawałkami');

  const zpath = path.join(outDir, 'unit.zip');
  const sizes = [0, 1, 65535, 65536, 65537, 1024 * 1024 + 3];
  const blobs = sizes.map((s) => crypto.randomBytes(s));
  const zw = await ZipWriter.create(zpath);
  assert.ok(fs.existsSync(`${zpath}.part`) && !fs.existsSync(zpath), 'w trakcie zapisu istnieje tylko plik .part');
  for (let i = 0; i < sizes.length; i++) {
    const f = path.join(outDir, `blob${i}.bin`);
    fs.writeFileSync(f, blobs[i]);
    assert.strictEqual(await zw.addFile(`dane/blob${i}.bin`, f), sizes[i]);
  }
  await zw.addBuffer('żółć/zażółć gęślą jaźń.txt', 'Zażółć gęślą jaźń ✓');
  await zw.addBuffer('pusty.txt', Buffer.alloc(0));
  await assert.rejects(() => zw.addBuffer('pusty.txt', 'x'), /Powtórzony/, 'duplikat nazwy');
  await assert.rejects(() => zw.addBuffer('../ucieczka.txt', 'x'), /Niepoprawna nazwa/, 'ścieżka z ..');
  const fin = await zw.finish();
  assert.ok(fs.existsSync(zpath) && !fs.existsSync(`${zpath}.part`), 'po finish jest plik docelowy bez .part');
  assert.strictEqual(fin.entries, sizes.length + 2);
  const back = new AdmZip(zpath);
  for (let i = 0; i < sizes.length; i++) {
    assert.ok(back.getEntry(`dane/blob${i}.bin`).getData().equals(blobs[i]), `blob ${sizes[i]} B wraca bajt w bajt (adm-zip sprawdza CRC)`);
  }
  assert.strictEqual(back.getEntry('żółć/zażółć gęślą jaźń.txt').getData().toString('utf8'), 'Zażółć gęślą jaźń ✓');
  assert.strictEqual(back.getEntry('pusty.txt').getData().length, 0);
  ok(`ZipWriter: ${sizes.length} plików (0 B … 1 MB), nazwy UTF-8, pusty wpis, duplikat i „..” odrzucone`);

  // Windows: systemowy bsdtar (System32\tar.exe czyta ZIP-y); GNU tar z Git Bash bierze „C:” za nazwę zdalnego hosta
  // Linux: GNU tar nie czyta ZIP-ów - bierzemy `unzip` albo `bsdtar`
  const EXTRACTORS =
    process.platform === 'win32'
      ? [{ cmd: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), probe: ['--version'], args: (z, d) => ['-xf', z, '-C', d] }]
      : [
          { cmd: 'unzip', probe: ['-v'], args: (z, d) => ['-q', '-o', z, '-d', d] },
          { cmd: 'bsdtar', probe: ['--version'], args: (z, d) => ['-xf', z, '-C', d] },
        ];
  const extractor = EXTRACTORS.find((e) => {
    const p = spawnSync(e.cmd, e.probe);
    return !p.error && p.status === 0;
  });
  const haveTar = Boolean(extractor);
  const extractWithTar = (zip, into) => {
    fs.mkdirSync(into, { recursive: true });
    const r = spawnSync(extractor.cmd, extractor.args(zip, into), { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${extractor.cmd}: ${r.stderr || r.stdout}`);
  };
  if (haveTar) {
    const into = path.join(outDir, 'tar-unit');
    extractWithTar(zpath, into);
    for (let i = 0; i < sizes.length; i++) assert.ok(fs.readFileSync(path.join(into, 'dane', `blob${i}.bin`)).equals(blobs[i]));
    assert.strictEqual(fs.readFileSync(path.join(into, 'żółć', 'zażółć gęślą jaźń.txt'), 'utf8'), 'Zażółć gęślą jaźń ✓');
    ok('systemowe tar rozpakowuje archiwum identycznie (druga, niezależna implementacja)');
  } else {
    console.log('(brak polecenia tar - pomijam odczyt drugim narzędziem)');
  }

  const zabort = await ZipWriter.create(path.join(outDir, 'abort.zip'));
  await zabort.addBuffer('a.txt', 'a');
  await zabort.abort();
  assert.ok(!fs.existsSync(path.join(outDir, 'abort.zip')) && !fs.existsSync(path.join(outDir, 'abort.zip.part')), 'abort nie zostawia plików');
  await assert.rejects(() => zabort.addBuffer('b.txt', 'b'), /zamknięte/);
  ok('ZipWriter.abort usuwa plik tymczasowy; dalszy zapis odrzucony');

  // ---- eksport instancji ----
  const instances = require(root + 'src/main/core/instances.js');
  const exporter = require(root + 'src/main/core/export.js');
  const id = 'moja-instancja-ab12';
  const game = paths.gameDir(id);
  fs.mkdirSync(paths.instanceDir(id), { recursive: true });
  fs.writeFileSync(
    paths.instanceFile(id),
    JSON.stringify({ id, name: 'Moja: instancja?', mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '0.17.3', memoryMb: 8192, jvmArgs: '-Dsekret=1', javaPath: 'C:\\Java\\bin\\java.exe', createdAt: 1 }),
  );
  const big = crypto.randomBytes(2 * 1024 * 1024);
  const files = {
    'mods/sodium.jar': crypto.randomBytes(5000),
    'mods/lithium.jar.disabled': crypto.randomBytes(3000),
    'mods/CustomSkinLoader_Fabric.jar': Buffer.from('zarządzany przez launcher'),
    'mods/secretsofthedeep.jar': Buffer.from('nazwa jara zawiera „secret”, ale to mod'),
    'resourcepacks/Faithful.zip': crypto.randomBytes(2000),
    'shaderpacks/BSL.zip': crypto.randomBytes(2000),
    'config/sodium-options.json': Buffer.from('{"a":1}'),
    'config/dużo/zagnieżdżony.toml': Buffer.from('x = 1'),
    'config/big.bin': big,
    'options.txt': Buffer.from('fov:90\n'),
    'servers.dat': Buffer.from([1, 2, 3, 4]),
    'saves/Swiat1/level.dat': Buffer.from('level'),
    'saves/Swiat1/region/r.0.0.mca': crypto.randomBytes(4096),
    'logs/latest.log': Buffer.from('log'),
    'crash-reports/crash-1.txt': Buffer.from('crash'),
    'screenshots/a.png': Buffer.from('png'),
    'CustomSkinLoader/CustomSkinLoader.json': Buffer.from('{}'),
    '.fabric/processedMods/x.jar': Buffer.from('x'),
    'quickPlay/log.json': Buffer.from('{}'),
    'hs_err_pid123.log': Buffer.from('hs'),
    'usercache.json': Buffer.from('[]'),
    'config/discord-token.json': Buffer.from('{"token":"abc"}'),
    'config/mod/api_key.txt': Buffer.from('klucz'),
    'config/cert.pem': Buffer.from('-----BEGIN'),
  };
  for (const [rel, data] of Object.entries(files)) write(path.join(game, rel), data);
  let symlinked = false;
  try {
    fs.symlinkSync(os.tmpdir(), path.join(game, 'config', 'wyjscie'), 'dir');
    symlinked = true;
  } catch {
    /* Windows bez uprawnień do dowiązań - ten fragment pomijamy */
  }

  const dest = path.join(outDir, 'eksport');
  const res = await exporter.exportInstance(id, dest);
  assert.strictEqual(res.path, `${dest}.mrpack`, 'rozszerzenie .mrpack dopisane');
  assert.ok(fs.existsSync(res.path) && !fs.existsSync(`${res.path}.part`));
  const zip = new AdmZip(res.path);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  const expected = [
    'modrinth.index.json',
    'overrides/mods/sodium.jar',
    'overrides/mods/lithium.jar.disabled',
    'overrides/mods/secretsofthedeep.jar',
    'overrides/resourcepacks/Faithful.zip',
    'overrides/shaderpacks/BSL.zip',
    'overrides/config/sodium-options.json',
    'overrides/config/dużo/zagnieżdżony.toml',
    'overrides/config/big.bin',
    'overrides/options.txt',
    'overrides/servers.dat',
  ].sort();
  assert.deepStrictEqual(names, expected);
  ok('paczka zawiera mody (też wyłączone), paczki zasobów, shadery, configi, options.txt i servers.dat');
  ok('pominięte: logi, raporty awarii, zrzuty ekranu, CustomSkinLoader, .fabric, quickPlay, hs_err, usercache, światy, pliki poufne, dowiązanie');
  for (const [rel, data] of Object.entries(files)) {
    const e = zip.getEntry(`overrides/${rel}`);
    if (expected.includes(`overrides/${rel}`)) assert.ok(e.getData().equals(data), `${rel} bajt w bajt`);
    else assert.ok(!e, `${rel} nie powinno być w paczce`);
  }
  assert.strictEqual(res.skipped.secrets, 3, 'trzy pliki wyglądające na poufne (token, api_key, .pem) policzone');
  assert.ok(zip.getEntry('overrides/mods/secretsofthedeep.jar'), 'jar z „secret” w nazwie NIE jest uznany za poufny');
  if (symlinked) assert.ok(res.skipped.other >= 1, 'dowiązanie policzone jako pominięte');

  const index = JSON.parse(zip.getEntry('modrinth.index.json').getData().toString('utf8'));
  assert.strictEqual(index.formatVersion, 1);
  assert.strictEqual(index.game, 'minecraft');
  assert.strictEqual(index.name, 'Moja: instancja?');
  assert.deepStrictEqual(index.dependencies, { minecraft: '1.21.11', 'fabric-loader': '0.17.3' });
  assert.deepStrictEqual(index.files, []);
  assert.ok(/^export-\d{8}-\d{4}$/.test(index.versionId), index.versionId);
  const raw = zip.getEntries().map((e) => e.getData().toString('latin1')).join('');
  assert.ok(!raw.includes('-Dsekret=1') && !raw.includes('C:\\Java'), 'ustawienia instancji (JVM, ścieżka Javy) nie trafiają do paczki');
  ok('modrinth.index.json: format 1, minecraft + fabric-loader, nazwa, pusta lista files; ustawienia instancji nie wyciekają');

  // wszystkie wpisy overrides bezpieczne dla importera (isInside) i bez katalogów-widm
  for (const e of zip.getEntries()) {
    assert.ok(!e.entryName.includes('..') && !path.isAbsolute(e.entryName) && !e.entryName.includes('\\'), e.entryName);
  }
  ok('ścieżki w paczce są względne, bez „..” i bez ukośników wstecznych');

  if (haveTar) {
    const into = path.join(outDir, 'tar-mrpack');
    extractWithTar(res.path, into);
    assert.ok(fs.readFileSync(path.join(into, 'overrides', 'config', 'big.bin')).equals(big));
    assert.ok(fs.readFileSync(path.join(into, 'overrides', 'mods', 'sodium.jar')).equals(files['mods/sodium.jar']));
    ok('systemowe tar rozpakowuje .mrpack (2 MB plik i jar zgodne bajt w bajt)');
  }

  // z światami
  const withWorlds = await exporter.exportInstance(id, path.join(outDir, 'swiaty.mrpack'), { worlds: true });
  const z2 = new AdmZip(withWorlds.path);
  assert.ok(z2.getEntry('overrides/saves/Swiat1/level.dat').getData().equals(files['saves/Swiat1/level.dat']));
  assert.ok(z2.getEntry('overrides/saves/Swiat1/region/r.0.0.mca').getData().equals(files['saves/Swiat1/region/r.0.0.mca']));
  assert.ok(withWorlds.worlds && withWorlds.files === res.files + 2);
  ok('worlds:true dodaje saves/ (2 pliki), reszta bez zmian');

  // eksport do folderu, który jest wewnątrz folderu gry, nie pakuje samego siebie
  const inside = path.join(game, 'eksporty', 'sam.mrpack');
  const self = await exporter.exportInstance(id, inside);
  assert.ok(!new AdmZip(self.path).getEntries().some((e) => /sam\.mrpack/.test(e.entryName)), 'paczka nie zawiera siebie');
  ok('plik docelowy wewnątrz folderu gry nie trafia do własnej paczki');

  // postęp
  const seen = [];
  await exporter.exportInstance(id, path.join(outDir, 'postep.mrpack'), { onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= expected.length - 1 && seen[seen.length - 1].text === 'Gotowe' && seen[seen.length - 1].current === seen[seen.length - 1].total);
  ok(`postęp: ${seen.length} zdarzeń, ostatnie „Gotowe” z kompletem`);

  // instancja wydarzenia (locked) nie wychodzi z launchera
  const evId = 'event-igrzyska';
  fs.mkdirSync(paths.gameDir(evId), { recursive: true });
  fs.writeFileSync(paths.instanceFile(evId), JSON.stringify({ id: evId, name: 'IGRZYSKA', mcVersion: '1.21.11', loader: 'fabric', locked: true, event: 'igrzyska' }));
  write(path.join(paths.gameDir(evId), 'mods', 'tajny.jar'), 'x');
  await assert.rejects(() => exporter.exportInstance(evId, path.join(outDir, 'event.mrpack')), /nie można eksportować/);
  assert.ok(!fs.existsSync(path.join(outDir, 'event.mrpack')) && !fs.existsSync(path.join(outDir, 'event.mrpack.part')));
  const restrictions = require(root + 'src/main/core/restrictions.js');
  const ctx = { profile: '', eventInstanceId: evId, isLocked: (i) => instances.isLocked(i) };
  assert.match(await restrictions.check('instances:export', [evId], ctx), /nie można eksportować/, 'kanał IPC odmawia dla zablokowanej instancji');
  assert.strictEqual(await restrictions.check('instances:export', [id], ctx), null, 'zwykła instancja wolno');
  assert.ok(await restrictions.check('instances:export', [evId], { ...ctx, profile: 'igrzyska' }), 'tryb wydarzenia blokuje eksport w ogóle');
  assert.ok(await restrictions.check('shell:show-export', [], { ...ctx, profile: 'igrzyska' }), 'tryb wydarzenia blokuje też „Pokaż w folderze”');
  ok('instancja wydarzenia: eksport odrzucony w core i w kanale IPC; tryb wydarzenia blokuje eksport');

  // limit rozmiaru: błąd bez śladu na dysku
  process.env.CROWN_EXPORT_MAX_BYTES = '1000';
  delete require.cache[require.resolve(root + 'src/main/core/export.js')];
  const tiny = require(root + 'src/main/core/export.js');
  await assert.rejects(() => tiny.exportInstance(id, path.join(outDir, 'za-duza.mrpack')), /za duża na eksport/);
  assert.ok(!fs.existsSync(path.join(outDir, 'za-duza.mrpack')) && !fs.existsSync(path.join(outDir, 'za-duza.mrpack.part')));
  delete process.env.CROWN_EXPORT_MAX_BYTES;
  ok('przekroczony limit rozmiaru: komunikat po polsku, żadnego pliku na dysku');

  // brak instancji
  await assert.rejects(() => exporter.exportInstance('nie-ma', path.join(outDir, 'x.mrpack')), /Nie znaleziono instancji/);
  ok('nieistniejąca instancja: czytelny błąd');

  assert.strictEqual(exporter.suggestedName({ name: 'Moja: instancja?' }), 'Moja_ instancja_.mrpack');
  assert.strictEqual(exporter.suggestedName({ name: '   ' }), 'instancja.mrpack');
  ok('proponowana nazwa pliku bez znaków zabronionych w nazwach plików');

  // ---- pełny obieg: eksport → import prawdziwym importerem launchera → ponowny eksport (wymaga sieci: manifest wersji Mojanga) ----
  const modrinth = require(root + 'src/main/core/modrinth.js');
  let online = true;
  try {
    await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  } catch {
    online = false;
  }
  if (online) {
    const imported = await modrinth.importMrpackFile(res.path, { fallbackName: 'x' });
    assert.notStrictEqual(imported.id, id);
    assert.strictEqual(imported.name, 'Moja: instancja?');
    assert.strictEqual(imported.mcVersion, '1.21.11');
    assert.strictEqual(imported.loader, 'fabric');
    assert.strictEqual(imported.loaderVersion, '0.17.3');
    const g2 = paths.gameDir(imported.id);
    for (const rel of expected.filter((e) => e.startsWith('overrides/')).map((e) => e.slice('overrides/'.length))) {
      assert.ok(fs.readFileSync(path.join(g2, rel)).equals(files[rel]), `${rel} po imporcie bajt w bajt`);
    }
    assert.ok(!fs.existsSync(path.join(g2, 'logs')) && !fs.existsSync(path.join(g2, 'saves')), 'logi i światy nie wróciły');
    const again = await exporter.exportInstance(imported.id, path.join(outDir, 'drugi-obieg.mrpack'));
    assert.deepStrictEqual(
      new AdmZip(again.path).getEntries().map((e) => e.entryName).sort(),
      names,
      'ponowny eksport zaimportowanej instancji daje ten sam zestaw plików',
    );
    ok('obieg: eksport → import (importer launchera przyjmuje paczkę, pliki bajt w bajt, loader i wersja gry) → ponowny eksport = ten sam zestaw');
  } else {
    console.log('(brak sieci - pomijam obieg eksport → import)');
  }

  rm(dataDir);
  rm(outDir);
  console.log(`\nWSZYSTKO OK (${n})`);
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
