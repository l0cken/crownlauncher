const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';
Object.assign(require(root + 'app-config.js'), { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', UPDATE_URL: '', CAPES_URL: '', INVITE_REQUIRED: false }); // test trybu GitHub: nie zależy od produkcyjnego app-config.js

// ---- atrapa GitHuba: API (contents) + raw ------------------------------------------------------------
const store = new Map(); // nazwa pliku -> { sha, content(base64) }
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // raw: /<owner>/<repo>/HEAD/capes/players/<Nick>.png
    const raw = /^\/l0cken\/crownlauncher\/HEAD\/capes\/players\/([^/]+\.png)$/.exec(url.pathname);
    if (raw) {
      const has = store.has(raw[1]);
      res.writeHead(has ? 200 : 404);
      return res.end();
    }
    const dir = /^\/repos\/l0cken\/crownlauncher\/contents\/capes\/players$/.exec(url.pathname);
    if (dir && req.method === 'GET') {
      if (!store.size) return json(404, { message: 'Not Found' });
      return json(200, [...store].map(([name, f]) => ({ name, type: 'file', sha: f.sha, download_url: `http://x/${name}` })));
    }
    const file = /^\/repos\/l0cken\/crownlauncher\/contents\/capes\/players\/([^/]+\.png)$/.exec(url.pathname);
    if (file) {
      const name = file[1];
      const cur = store.get(name);
      if (req.method === 'GET') return cur ? json(200, { name, sha: cur.sha }) : json(404, { message: 'Not Found' });
      const b = JSON.parse(body || '{}');
      if (req.method === 'PUT') {
        if (cur && b.sha !== cur.sha) return json(422, { message: 'sha wasn\'t supplied' });
        store.set(name, { sha: 'sha' + (store.size + 1) + Date.now(), content: b.content });
        return json(cur ? 200 : 201, { content: { name } });
      }
      if (req.method === 'DELETE') {
        if (!cur || b.sha !== cur.sha) return json(409, { message: 'sha mismatch' });
        store.delete(name);
        return json(200, {});
      }
    }
    return json(404, { message: 'Not Found' });
  });
});

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.CROWN_GITHUB_API = `http://127.0.0.1:${port}`;
  process.env.CROWN_GITHUB_RAW = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capes-'));
  // stary plik konfiguracji z kluczami po skinach - wczytanie ma go posprzątać
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    localSkins: false, cosmetics: false, skinSync: true, skinByName: { CrownTest: 'skin1' }, capeByName: {},
  }));
  require(root + 'paths.js').init(dir);
  const paths = require(root + 'paths.js');
  const config = require(root + 'config.js');
  const auth = require(root + 'auth.js');
  const capeArt = require(root + 'cape-art.js');
  const capes = require(root + 'capes.js');

  // ---- migracja konfiguracji ----
  const cfg0 = config.get();
  assert.strictEqual(cfg0.cosmetics, false, 'zapisane cosmetics:false zostaje w pliku (skuteczne tylko z dostępem z panelu)');
  for (const k of ['localSkins', 'skinSync', 'skinByName']) assert.ok(!(k in cfg0), `klucz ${k} usunięty`);
  config.set({ cosmetics: true });
  ok('konfiguracja: klucze skinSync/skinByName/localSkins usunięte');

  // konto "wybrane" bez dotykania prawdziwego magazynu kont
  auth.listPublic = () => ({ accounts: [{ id: 'a1', username: 'CrownTest', type: 'offline' }], selected: 'a1' });

  // ---- moduł nie ma już nic od skinów ----
  for (const fnName of ['selectSkin', 'skinSyncArgs', 'assignSkin', 'unassignSkin', 'listAssignedSkins', 'skinAssignedFor', 'sharedSkinUrl']) {
    assert.strictEqual(capes[fnName], undefined, `${fnName} nie powinno istnieć`);
  }
  const appConfig = require(root + 'app-config.js');
  assert.strictEqual(appConfig.SKIN_SYNC, undefined);
  ok('capes.js i app-config.js: brak funkcji i ustawień związanych ze skinami (SkinSync, nadawanie, wybór)');

  // ---- grafika ----
  for (const d of capeArt.DESIGNS) {
    const png = capeArt.render(d.id);
    const info = capes.validateCapePng(png);
    assert.deepStrictEqual(info, { width: 64, height: 32 });
    let off = 8;
    const idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    assert.strictEqual(raw.length, (64 * 4 + 1) * 32);
    const px = (x, y) => raw.subarray(y * 257 + 1 + x * 4, y * 257 + 1 + x * 4 + 4);
    const expected = d.pixel(0, 0);
    assert.deepStrictEqual([...px(1, 1)], [...expected, 255], d.id);
    assert.strictEqual(px(12, 1)[3], 255);
    // elytry: zewnętrzna strona skrzydła (36,2)-(45,21) w kształcie skrzydła, reszta przezroczysta
    assert.strictEqual(px(36, 2)[3], 255, `${d.id}: lewy górny róg skrzydła`);
    assert.deepStrictEqual([...px(36, 2)], [...d.pixel(0, 0), 255], `${d.id}: obrzeże peleryny na brzegu skrzydła`);
    assert.strictEqual(px(45, 21)[3], 255, `${d.id}: prawy dolny róg skrzydła`);
    assert.strictEqual(px(45, 2)[3], 0, `${d.id}: prawy górny róg ścięty`);
    assert.strictEqual(px(36, 21)[3], 0, `${d.id}: lewy dolny róg ścięty`);
    assert.strictEqual(px(30, 10)[3], 0, `${d.id}: wewnętrzna strona skrzydła przezroczysta`);
    assert.strictEqual(px(60, 30)[3], 0);
  }
  ok(`wszystkie ${capeArt.DESIGNS.length} wbudowane peleryny: poprawny PNG 64×32, układ UV (zewn./wewn./elytra)`);

  // ---- walidacja ----
  const fake = (w, h, size = 100) => {
    const b = Buffer.alloc(Math.max(size, 33));
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  for (const [w, h] of [[64, 32], [128, 64], [512, 256], [1024, 512], [2048, 1024], [22, 17], [46, 22]]) capes.validateCapePng(fake(w, h));
  for (const [w, h] of [[64, 64], [100, 50], [32, 16], [4096, 2048], [92, 44]]) {
    assert.throws(() => capes.validateCapePng(fake(w, h)), /proporcje 2:1/, `${w}×${h}`);
  }
  assert.throws(() => capes.validateCapePng(Buffer.from('nie png nie png nie png nie png nie png')), /PNG/);
  capes.validateCapePng(fake(1024, 512, 900 * 1024)); // HD o sporej wadze przechodzi (limit 2 MB, wcześniej 500 KB)
  assert.throws(() => capes.validateCapePng(fake(64, 32, 3 * 1024 * 1024)), /za duży/);
  ok('walidacja: 64×32 i HD do 2048×1024 (do 2 MB), 22×17, 46×22 przechodzą; reszta z czytelnym komunikatem');

  // plik wybrany przez gracza: renderer dopasowuje go do formatu, więc czytanie nie wymaga jeszcze „idealnych” wymiarów
  const picked = path.join(dir, 'optifine-2x.png');
  fs.writeFileSync(picked, fake(92, 44, 2000));
  const rf = await capes.readCapeFile(picked);
  assert.strictEqual(rf.width, 92);
  assert.strictEqual(rf.height, 44);
  assert.match(rf.dataUrl, /^data:image\/png;base64,/);
  fs.writeFileSync(path.join(dir, 'zly.png'), 'to nie jest obraz, ale ma rozszerzenie png i ponad trzydzieści trzy bajty');
  await assert.rejects(() => capes.readCapeFile(path.join(dir, 'zly.png')), /nie jest plik PNG/);
  await assert.rejects(() => capes.readCapeFile(path.join(dir, 'cos.jpg')), /PNG/);
  ok('readCapeFile: zwraca dowolny PNG z wymiarami (np. 92×44) do dopasowania w interfejsie, odrzuca nie-PNG');

  // ---- biblioteka i wybór ----
  let list = await capes.list();
  assert.strictEqual(list.filter((c) => c.builtin).length, capeArt.DESIGNS.length);
  const own = await capes.add({ name: 'Moja', dataUrl: `data:image/png;base64,${capeArt.render('gold').toString('base64')}` });
  assert.strictEqual((await capes.list()).filter((c) => !c.builtin).length, 1);
  await assert.rejects(() => capes.add({ name: 'x', dataUrl: 'data:image/png;base64,AAAA' }), /PNG|wymiar|musi/);
  assert.strictEqual((await capes.select(own.id)).username, 'CrownTest');
  const st = await capes.state();
  assert.strictEqual(st.selected, own.id);
  assert.ok(!('skinSelected' in st), 'stan nie zawiera już wyboru skina');
  await capes.select('builtin-crown');
  assert.strictEqual((await capes.state()).selected, 'builtin-crown');
  await assert.rejects(() => capes.select('builtin-nie-ma'), /Nie ma takiej/);
  await capes.select(own.id);
  await capes.remove(own.id);
  assert.strictEqual((await capes.state()).selected, '', 'usunięcie zdejmuje wybór');
  ok('biblioteka: dodanie, wybór per konto, odrzucenie nieznanej, usunięcie zdejmuje wybór');

  // ---- gra: pliki dla CustomSkinLoader ----
  const instId = 'inst-test';
  fs.mkdirSync(path.join(paths.instanceDir(instId), 'game', 'mods'), { recursive: true });
  fs.writeFileSync(paths.instanceFile(instId), JSON.stringify({ id: instId, name: 't', mcVersion: '1.21.11', loader: 'fabric' }));
  fs.writeFileSync(path.join(paths.instanceDir(instId), 'game', 'mods', 'CustomSkinLoader_Universal-15.1.jar'), 'x');
  const instance = { id: instId, loader: 'fabric', mcVersion: '1.21.11' };
  const base = path.join(paths.gameDir(instId), 'CustomSkinLoader');

  await capes.select('builtin-midnight');
  let r = await capes.prepareForLaunch(instance, 'CrownTest');
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.skin, undefined, 'wynik nie mówi już nic o skinie');
  assert.deepStrictEqual(fs.readFileSync(path.join(base, 'LocalSkin', 'capes', 'CrownTest.png')), capeArt.render('midnight'));
  const written = JSON.parse(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8'));
  assert.deepStrictEqual(written.loadlist.map((p) => p.name), ['LocalSkin', 'CrownCapes', 'GameProfile']);
  const bySource = Object.fromEntries(written.loadlist.map((p) => [p.name, p]));
  assert.match(bySource.CrownCapes.cape, /127\.0\.0\.1.*\/capes\/players\/\{USERNAME\}\.png$/);
  for (const p of written.loadlist) {
    assert.strictEqual(p.skin, undefined, `${p.name}: źródło nie podaje skinów`);
    assert.strictEqual(p.model, undefined, `${p.name}: bez wymuszania modelu ramion`);
  }
  assert.strictEqual(bySource.GameProfile.type, 'GameProfile');
  assert.ok(!written.loadlist.some((p) => /mojang|crownskins/i.test(p.name + p.type)), 'brak Mojang/CrownSkins');
  ok('start gry: peleryna w LocalSkin/capes/<nick>.png; konfiguracja tylko peleryny (LocalSkin → CrownCapes → GameProfile), bez skinów');

  // sprzątanie po dawnych wersjach: skin i konfiguracja ze skinami
  fs.mkdirSync(path.join(base, 'LocalSkin', 'skins'), { recursive: true });
  fs.writeFileSync(path.join(base, 'LocalSkin', 'skins', 'CrownTest.png'), 'STARY SKIN');
  fs.writeFileSync(path.join(base, 'LocalSkin', 'skins', 'Cudzy.png'), 'cudzy skin');
  fs.writeFileSync(path.join(base, 'LocalSkin', '.crown.json'), JSON.stringify({ capes: ['CrownTest'], skins: ['CrownTest'] }));
  fs.writeFileSync(path.join(base, 'CustomSkinLoader.json'), JSON.stringify({
    loadlist: [{ name: 'LocalSkin', skin: 'LocalSkin/skins/{USERNAME}.png', model: 'slim' }, { name: 'CrownSkins' }, { name: 'Mojang', type: 'MojangAPI' }],
  }));
  r = await capes.prepareForLaunch(instance, 'CrownTest');
  assert.ok(!fs.existsSync(path.join(base, 'LocalSkin', 'skins', 'CrownTest.png')), 'skin zapisany przez launcher usunięty');
  assert.ok(fs.existsSync(path.join(base, 'LocalSkin', 'skins', 'Cudzy.png')), 'cudzego pliku nie ruszamy');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, 'LocalSkin', '.crown.json'), 'utf8')).skins, []);
  const cleaned = JSON.parse(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8'));
  assert.deepStrictEqual(cleaned.loadlist.map((p) => p.name), ['LocalSkin', 'CrownCapes', 'GameProfile']);
  ok('migracja: skin zapisany przez dawny launcher usunięty, stara konfiguracja ze skinami/Mojang zastąpiona');

  // zdjęcie peleryny usuwa tylko plik, który zapisał launcher
  fs.writeFileSync(path.join(base, 'LocalSkin', 'capes', 'Inny.png'), 'cudzy');
  await capes.select(null);
  await capes.prepareForLaunch(instance, 'CrownTest');
  assert.ok(!fs.existsSync(path.join(base, 'LocalSkin', 'capes', 'CrownTest.png')));
  assert.ok(fs.existsSync(path.join(base, 'LocalSkin', 'capes', 'Inny.png')), 'cudzych plików nie ruszamy');
  ok('zdjęcie peleryny usuwa własny plik launchera, cudzych nie rusza');

  // dwa konta w jednym launcherze, dwie instancje: każda instancja dostaje peleryny OBU kont
  // (inaczej drugie konto nie zobaczyłoby własnej, wybranej peleryny pierwszego)
  {
    const realList = auth.listPublic;
    auth.listPublic = () => ({
      accounts: [{ id: 'a1', username: 'CrownTest', type: 'offline' }, { id: 'a2', username: 'Druga_Postac', type: 'offline' }],
      selected: 'a1',
    });
    config.set({ capeByName: { CrownTest: 'builtin-midnight', Druga_Postac: 'builtin-gold' } });
    const other = { id: 'inst-druga', loader: 'fabric', mcVersion: '1.21.11' };
    fs.mkdirSync(path.join(paths.instanceDir(other.id), 'game', 'mods'), { recursive: true });
    fs.writeFileSync(paths.instanceFile(other.id), JSON.stringify({ ...other, name: 'druga' }));
    fs.writeFileSync(path.join(paths.instanceDir(other.id), 'game', 'mods', 'CustomSkinLoader_Universal-15.1.jar'), 'x');
    // start z konta Druga_Postac w drugiej instancji: ma też plik peleryny CrownTest
    await capes.prepareForLaunch(other, 'Druga_Postac');
    const dir2 = path.join(paths.gameDir(other.id), 'CustomSkinLoader', 'LocalSkin', 'capes');
    assert.deepStrictEqual(fs.readFileSync(path.join(dir2, 'CrownTest.png')), capeArt.render('midnight'));
    assert.deepStrictEqual(fs.readFileSync(path.join(dir2, 'Druga_Postac.png')), capeArt.render('gold'));
    // zdjęcie peleryny jednego konta usuwa tylko jego plik; cudzy plik zostaje
    fs.writeFileSync(path.join(dir2, 'Obcy.png'), 'cudzy');
    config.set({ capeByName: { CrownTest: 'builtin-midnight' } });
    await capes.prepareForLaunch(other, 'Druga_Postac');
    assert.ok(fs.existsSync(path.join(dir2, 'CrownTest.png')), 'peleryna drugiego konta zostaje');
    assert.ok(!fs.existsSync(path.join(dir2, 'Druga_Postac.png')), 'zdjęta peleryna znika');
    assert.ok(fs.existsSync(path.join(dir2, 'Obcy.png')), 'cudzych plików nie ruszamy');
    const mk = JSON.parse(fs.readFileSync(path.join(paths.gameDir(other.id), 'CustomSkinLoader', 'LocalSkin', '.crown.json'), 'utf8'));
    assert.deepStrictEqual(mk.capes, ['CrownTest']);
    auth.listPublic = realList;
    config.set({ capeByName: {} });
    ok('dwa konta w jednym launcherze: każda instancja dostaje peleryny obu kont; zdjęcie usuwa tylko własny plik');
  }
  // własna konfiguracja gracza nie jest nadpisywana
  fs.rmSync(path.join(base, '.crown-config'), { force: true });
  fs.writeFileSync(path.join(base, 'CustomSkinLoader.json'), '{"custom":true}');
  await capes.prepareForLaunch(instance, 'CrownTest');
  assert.strictEqual(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8'), '{"custom":true}');
  ok('ręcznie zmieniona konfiguracja CustomSkinLoader nie jest nadpisywana');

  // „Peleryny i korona w grze” wyłączyć mogą tylko gracze z dostępem z panelu; bez niego zapisane cosmetics:false jest ignorowane
  await capes.prepareForLaunch(instance, 'CrownTest');
  fs.rmSync(path.join(base, 'CustomSkinLoader.json'), { force: true });
  await capes.select('builtin-gold');
  config.set({ cosmetics: false });
  r = await capes.prepareForLaunch(instance, 'CrownTest');
  assert.strictEqual(r.applied, true, 'bez dostępu peleryny działają mimo cosmetics:false w konfiguracji');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8')).loadlist.map((p) => p.name), ['LocalSkin', 'CrownCapes', 'GameProfile']);
  assert.ok(capes.localMembersArgs().some((a) => a.startsWith('-Dcrownclient.members=')), 'korona przy własnych kontach też');
  assert.strictEqual((await capes.state()).enabled, true);
  ok('bez dostępu z panelu: zapisane cosmetics:false niczego nie wyłącza (peleryny, CustomSkinLoader i korona zostają)');

  // z dostępem (klucz zaproszenia z polem disableClient): wyłączone zostawia tylko GameProfile (skin bez zmian), włączone przywraca
  const appCfg = require(root + 'app-config.js');
  Object.assign(appCfg, { GITHUB_REPO: '', ANNOUNCEMENTS_URL: 'http://127.0.0.1:9', INVITE_REQUIRED: true });
  config.set({ inviteKey: auth.seal('CROWNTESTKEYCROWN'), inviteOrigin: 'http://127.0.0.1:9', inviteDisableClient: true, inviteCapes: true });
  try {
    r = await capes.prepareForLaunch(instance, 'CrownTest');
    assert.strictEqual(r.applied, false);
    const off = JSON.parse(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8'));
    assert.deepStrictEqual(off.loadlist.map((p) => p.name), ['GameProfile']);
    assert.deepStrictEqual(capes.localMembersArgs(), [], 'bez korony przy własnych kontach');
    assert.strictEqual((await capes.state()).enabled, false);
    config.set({ cosmetics: true });
    r = await capes.prepareForLaunch(instance, 'CrownTest');
    assert.strictEqual(r.applied, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, 'CustomSkinLoader.json'), 'utf8')).loadlist.map((p) => p.name), ['LocalSkin', 'CrownCapes', 'GameProfile']);
  } finally {
    Object.assign(appCfg, { GITHUB_REPO: 'l0cken/crownlauncher', ANNOUNCEMENTS_URL: '', INVITE_REQUIRED: false });
    config.set({ inviteKey: '', inviteOrigin: '', inviteDisableClient: false, inviteCapes: false, cosmetics: true });
  }
  ok('z dostępem z panelu: przełącznik „Peleryny i korona w grze” — wyłączony zostawia tylko GameProfile (skin bez zmian), włączony przywraca');

  // ---- administracja: nadawanie przez GitHub ----
  config.set({ publisherKey: auth.seal('test-token'), publisherName: 'l0cken', publisherRole: 'admin' });
  assert.deepStrictEqual(await capes.listAssigned(), []);
  assert.strictEqual((await capes.assignedFor('Gracz_1')).assigned, false);
  await assert.rejects(() => capes.assign('zły nick!', 'builtin-crown'), /Nick/);
  await capes.assign('Gracz_1', 'builtin-crown');
  assert.ok(store.has('Gracz_1.png'));
  assert.deepStrictEqual(Buffer.from(store.get('Gracz_1.png').content, 'base64'), capeArt.render('crown'));
  await capes.assign('Gracz_1', 'builtin-gold'); // nadpisanie wymaga sha - launcher je pobiera
  assert.deepStrictEqual(Buffer.from(store.get('Gracz_1.png').content, 'base64'), capeArt.render('gold'));
  assert.deepStrictEqual((await capes.listAssigned()).map((x) => x.nick), ['Gracz_1']);
  assert.strictEqual((await capes.assignedFor('Gracz_1')).assigned, true);
  await capes.unassign('Gracz_1');
  assert.strictEqual(store.size, 0);
  assert.strictEqual((await capes.assignedFor('Gracz_1')).assigned, false);
  ok('administracja: nadanie, nadpisanie (sha), lista, sprawdzenie „czy mam”, odebranie — przez API GitHuba');

  config.set({ publisherKey: '' });
  await assert.rejects(() => capes.assign('Gracz_2', 'builtin-crown'), /Zaloguj się kluczem/);
  ok('bez klucza dostępu nadawanie jest odrzucone');

  console.log(`\nWSZYSTKO OK (${n})`);
  server.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 6).join('\n')); process.exit(1); });
