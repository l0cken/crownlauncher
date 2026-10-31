// Panel administratora w prawdziwym Chromium (Electron + CDP): logowanie, klucz z rodzajem „Kod: IGRZYSKA ŚMIERCI”,
// karta wydarzenia - wgrywanie modów/texturepacków/shaderpacków/configów/options oraz całego folderu, wymuszanie, usuwanie.
// Uruchomienie: node dev-tests/panel-ui-test.js   (otwiera na chwilę okno)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { CF, serverEntry, startLoops, docs: backendDocs, rmDir } = require('./lib/backend');

const root = path.join(__dirname, '..');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`Przekroczono czas: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

(async () => {
  const dataDir = tmp('crown-panelui-srv-');
  const userData = tmp('crown-panelui-data-');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  const server = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let up = false;
  server.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) up = true; });
  await until(() => up, 'serwer');
  const base = `http://127.0.0.1:${port}`;
  const adminKey = /(crown_\S+)/.exec(spawnSync(process.execPath, [serverEntry, 'create-key', 'Panel', 'admin'], { env, encoding: 'utf8' }).stdout)[1];
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  const events = async () => (await (await fetch(`${base}/v1/admin/events`, { headers: bearer })).json()).events[0];

  const cdpPort = await freePort();
  const proc = spawn(electronExe, [path.join(__dirname, 'fixtures', 'open-url-main.js'), `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], {
    env: { ...process.env, OPEN_URL: `${base}/admin` },
    stdio: 'ignore',
  });
  let ws;
  let finished = false;
  try {
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page' && /\/admin/.test(t.url)), 'okno panelu');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP: brak połączenia')); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'wyjątek w stronie');
      return r.result?.result?.value;
    };
    const text = () => evaluate('document.body.innerText');
    const click = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('brak przycisku: ${label}'); b.click(); return true; })()`);
    const clickStarting = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw new Error('brak przycisku: ${label}'); b.click(); return true; })()`);
    const toasts = () => evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent)");

    /** Wkłada pliki do ukrytego inputa (jak wybór w oknie systemowym) i wywołuje „change”. rel = webkitRelativePath. */
    const pickFiles = (buttonLabel, files) => evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(buttonLabel)}));
      if (!btn) throw new Error('brak przycisku: ${buttonLabel}');
      const input = btn.parentElement.querySelector('input[type=file]');
      const dt = new DataTransfer();
      for (const f of ${JSON.stringify(files)}) {
        const file = new File([f.bigSize ? 'PK' + 'x'.repeat(f.bigSize) : f.content], f.name, { type: 'application/octet-stream' });
        if (f.rel) Object.defineProperty(file, 'webkitRelativePath', { value: f.rel });
        dt.items.add(file);
      }
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return dt.files.length + ' ' + (dt.files[0] && dt.files[0].webkitRelativePath);
    })()`);

    // logo to tło CSS elementu (nie <img>): załadowane z /logo.png, nie do zaznaczenia ani kliknięcia, bez menu kontekstowego i przeciągania
    const logoState = (sel) => evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(sel)});
      if (!n) return null;
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      const fire = (Ctor, type, x, y) => { const e = new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }); document.body.dispatchEvent(e); return e.defaultPrevented; };
      const res = performance.getEntriesByType('resource').find((e) => /\\/logo\\.png$/.test(e.name));
      return {
        tag: n.tagName, bg: cs.backgroundImage, pe: cs.pointerEvents, us: cs.userSelect, w: r.width, imgs: document.querySelectorAll('img').length,
        loaded: !!res && res.decodedBodySize > 1000,
        menuOnLogo: fire(MouseEvent, 'contextmenu', r.left + r.width / 2, r.top + r.height / 2),
        dragOnLogo: fire(MouseEvent, 'dragstart', r.left + r.width / 2, r.top + r.height / 2),
        menuElsewhere: fire(MouseEvent, 'contextmenu', r.right + 300, r.bottom + 300),
      };
    })()`);
    const assertLogo = (s, what) => {
      assert.ok(s, `${what}: brak elementu .logo`);
      assert.strictEqual(s.tag, 'SPAN', `${what}: logo nie jest obrazem`);
      assert.match(s.bg, /url\(".*\/logo\.png"\)/, `${what}: tło z /logo.png`);
      assert.strictEqual(s.pe, 'none', `${what}: pointer-events`);
      assert.strictEqual(s.us, 'none', `${what}: user-select`);
      assert.ok(s.w >= 40, `${what}: logo ma rozmiar (${s.w})`);
      assert.strictEqual(s.imgs, 0, `${what}: na stronie nie ma <img>`);
      assert.strictEqual(s.loaded, true, `${what}: tło naprawdę się załadowało (200, nie 404)`);
      assert.strictEqual(s.menuOnLogo, true, `${what}: menu kontekstowe na logo zablokowane`);
      assert.strictEqual(s.dragOnLogo, true, `${what}: przeciąganie logo zablokowane`);
      assert.strictEqual(s.menuElsewhere, false, `${what}: menu poza logo działa normalnie`);
    };

    // ---- logowanie kluczem administratora ----
    await until(() => evaluate("!!document.querySelector('input[type=password]')"), 'formularz logowania');
    await until(async () => (await logoState('.login .logo'))?.loaded, 'logo na ekranie logowania');
    assertLogo(await logoState('.login .logo'), 'ekran logowania');
    await evaluate(`(() => { const i = document.querySelector('input[type=password]'); i.value = ${JSON.stringify(adminKey)}; })()`);
    await click('Zaloguj');
    await until(async () => /Nowy klucz/.test(await text()), 'panel po zalogowaniu');
    assertLogo(await logoState('.brand .logo'), 'nagłówek panelu');
    // inaczej niż strona wczytująca obraz (Sec-Fetch-Dest: image), fetch() z tej samej strony dostaje 404 i adres otwarty w karcie też
    assert.strictEqual(await evaluate("fetch('/logo.png').then((r) => r.status)"), 404, 'fetch() logo → 404');
    assert.strictEqual(await evaluate("new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = '/logo.png?x=' + Date.now(); })"), 512, 'jako obraz strony logo się ładuje');
    ok('logo w panelu (ekran logowania i nagłówek): tło CSS, user-select/pointer-events: none, brak <img>, menu kontekstowe i przeciąganie zablokowane, fetch() → 404, obraz strony → 200');
    await until(async () => /Wydarzenie: IGRZYSKA ŚMIERCI/.test(await text()), 'karta wydarzenia');
    assert.match(await text(), /Do przygotowania/);
    ok('logowanie kluczem admin → panel z kartą wydarzenia „Do przygotowania”');

    // ---- klucz z rodzajem „Kod: IGRZYSKA ŚMIERCI” ----
    await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Nick gracza"]'); i.value = 'Zawodnik'; })()`);
    await clickStarting('Kod: IGRZYSKA');
    await click('Utwórz klucz');
    await until(async () => /CROWN-[A-Z2-9]{4}-/.test(await evaluate("document.querySelector('.created .key')?.textContent || ''")), 'nowy klucz');
    await until(async () => (await evaluate("[...document.querySelectorAll('.tags .badge.event')].map((b) => b.textContent)")).includes('IGRZYSKA ŚMIERCI'), 'znaczek wydarzenia na liście');
    const created = (await (await fetch(`${base}/v1/admin/invites`, { headers: bearer })).json()).invites;
    assert.strictEqual(created.find((i) => i.name === 'Zawodnik').profile, 'igrzyska');
    ok('nowy klucz z rodzajem „Kod: IGRZYSKA ŚMIERCI”: profil zapisany, znaczek na liście');

    // ---- dostęp do peleryn: pole przy tworzeniu klucza, przycisk przy kluczu i okno edycji ----
    const invites = async () => (await (await fetch(`${base}/v1/admin/invites`, { headers: bearer })).json()).invites;
    const badges = () => evaluate("[...document.querySelectorAll('.tags .badge.event')].map((b) => b.textContent)");
    const itemOf = (name) => `[...document.querySelectorAll('.item')].find((x) => x.querySelector('.name')?.textContent.startsWith(${JSON.stringify(name)}))`;
    const clickIn = (name, label) => evaluate(`(() => { const it = ${itemOf(name)}; const b = [...it.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('brak przycisku: ${label}'); b.click(); return true; })()`);
    assert.strictEqual((await invites()).find((i) => i.name === 'Zawodnik').capes, false, 'domyślnie bez peleryn');
    await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Nick gracza"]'); i.value = 'Krawiec'; })()`);
    await click('Pełny dostęp');
    await evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.includes('Daj dostęp do peleryn')); l.querySelector('input').click(); })()`);
    await click('Utwórz klucz');
    await until(async () => (await invites()).some((i) => i.name === 'Krawiec'), 'klucz z pelerynami');
    assert.strictEqual((await invites()).find((i) => i.name === 'Krawiec').capes, true);
    await until(async () => (await badges()).includes('Peleryny'), 'znaczek „Peleryny” na liście');
    assert.strictEqual(await evaluate("[...document.querySelectorAll('label')].find((x) => x.textContent.includes('Daj dostęp do peleryn')).querySelector('input').checked"), false, 'pole wraca do wyłączonego po utworzeniu klucza');
    assert.strictEqual(await evaluate(`${itemOf('Zawodnik')}.textContent.includes('peleryny')`), false, 'klucz-kod wydarzenia nie ma przycisku peleryn');
    ok('nowy klucz z polem „Daj dostęp do peleryn”: zapisane na serwerze, znaczek „Peleryny”; klucz-kod wydarzenia nie ma przycisku peleryn');

    await clickIn('Krawiec', 'Wyłącz peleryny');
    await until(() => evaluate("!!document.querySelector('.overlay')"), 'potwierdzenie');
    assert.match(await evaluate("document.querySelector('.overlay').textContent"), /peleryna zniknie u innych graczy/);
    await click('Wyłącz');
    await until(async () => (await invites()).find((i) => i.name === 'Krawiec').capes === false, 'peleryny wyłączone');
    await until(async () => !(await badges()).includes('Peleryny'), 'znaczek zniknął');
    await clickIn('Krawiec', 'Włącz peleryny');
    await until(async () => (await invites()).find((i) => i.name === 'Krawiec').capes === true, 'peleryny włączone przyciskiem');
    await until(async () => (await badges()).includes('Peleryny'), 'lista odświeżona po włączeniu peleryn');
    ok('przycisk przy kluczu: „Wyłącz peleryny” (z potwierdzeniem) i „Włącz peleryny” zmieniają dostęp, znaczek na liście nadąża');

    await clickIn('Krawiec', 'Edytuj');
    await until(() => evaluate("!!document.querySelector('.modal')"), 'okno edycji');
    assert.strictEqual(await evaluate("[...document.querySelectorAll('.modal label')].find((x) => x.textContent.includes('Dostęp do peleryn')).querySelector('input').checked"), true, 'okno edycji pokazuje obecny dostęp');
    await evaluate("[...document.querySelectorAll('.modal label')].find((x) => x.textContent.includes('Dostęp do peleryn')).querySelector('input').click()");
    await click('Zapisz');
    await until(async () => (await invites()).find((i) => i.name === 'Krawiec').capes === false, 'peleryny wyłączone w edycji');
    ok('okno edycji klucza: pole dostępu do peleryn pokazuje stan i zapisuje zmianę');

    // ---- pozwolenie na wyłączenie CrownClienta: pole przy tworzeniu klucza i w oknie edycji ----
    assert.strictEqual((await invites()).find((i) => i.name === 'Krawiec').disableClient, false, 'domyślnie niedozwolone');
    await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Nick gracza"]'); i.value = 'Cichy'; })()`);
    await evaluate("[...document.querySelectorAll('label')].find((x) => x.textContent.includes('Pozwól wyłączyć CrownClient')).querySelector('input').click()");
    await click('Utwórz klucz');
    await until(async () => (await invites()).some((i) => i.name === 'Cichy'), 'klucz z możliwością wyłączenia CrownClienta');
    const cichy = (await invites()).find((i) => i.name === 'Cichy');
    assert.deepStrictEqual([cichy.disableClient, cichy.capes], [true, false]);
    await until(async () => (await badges()).includes('Może wyłączyć CrownClient'), 'znaczek na liście');
    assert.strictEqual(await evaluate("[...document.querySelectorAll('label')].find((x) => x.textContent.includes('Pozwól wyłączyć CrownClient')).querySelector('input').checked"), false, 'pole wraca do wyłączonego po utworzeniu klucza');
    await clickIn('Cichy', 'Edytuj');
    await until(() => evaluate("!!document.querySelector('.modal')"), 'okno edycji');
    assert.strictEqual(await evaluate("[...document.querySelectorAll('.modal label')].find((x) => x.textContent.includes('Pozwól wyłączyć CrownClient')).querySelector('input').checked"), true);
    await evaluate("[...document.querySelectorAll('.modal label')].find((x) => x.textContent.includes('Pozwól wyłączyć CrownClient')).querySelector('input').click()");
    await click('Zapisz');
    await until(async () => (await invites()).find((i) => i.name === 'Cichy').disableClient === false, 'dostęp odebrany w edycji');
    await until(async () => !(await badges()).includes('Może wyłączyć CrownClient'), 'znaczek zniknął');
    ok('pole „Pozwól wyłączyć CrownClient”: zapisane przy tworzeniu klucza (znaczek na liście), okno edycji pokazuje stan i odbiera dostęp');

    // przycisk w wierszu klucza (jak „Włącz/Wyłącz peleryny”): jedno kliknięcie nadaje, drugie (z potwierdzeniem) zabiera
    assert.strictEqual(await evaluate(`${itemOf('Zawodnik')}.textContent.includes('wyłączać CrownClient')`), false, 'klucz-kod wydarzenia nie ma tego przycisku');
    await clickIn('Krawiec', 'Pozwól wyłączać CrownClient');
    await until(async () => (await invites()).find((i) => i.name === 'Krawiec').disableClient === true, 'dostęp nadany przyciskiem');
    await until(async () => (await badges()).includes('Może wyłączyć CrownClient'), 'znaczek na liście');
    await clickIn('Krawiec', 'Zabierz wyłączanie CrownClient');
    await until(() => evaluate("!!document.querySelector('.overlay')"), 'potwierdzenie');
    assert.match(await evaluate("document.querySelector('.overlay').textContent"), /straci przełącznik „Peleryny i korona w grze”/);
    await click('Zabierz');
    await until(async () => (await invites()).find((i) => i.name === 'Krawiec').disableClient === false, 'dostęp odebrany przyciskiem');
    await until(async () => !(await badges()).includes('Może wyłączyć CrownClient'), 'znaczek zniknął');
    ok('przycisk przy kluczu: „Pozwól wyłączać CrownClient” nadaje dostęp, „Zabierz wyłączanie CrownClient” (z potwierdzeniem) odbiera; klucz-kod wydarzenia go nie ma');

    // ---- ustawienia wydarzenia ----
    await evaluate(`(() => { const i = document.querySelector('input[placeholder="np. 1.21.11"]'); i.value = '1.21.4'; })()`);
    await click('Zapisz ustawienia');
    await until(async () => (await events()).mcVersion === '1.21.4', 'wersja gry zapisana');
    ok('karta wydarzenia: wersja Minecrafta zapisana');

    // ---- wgrywanie plików ----
    await pickFiles('Dodaj mody', [{ name: 'death-games.jar', content: 'PK-mod' }, { name: 'notes.txt', content: 'x' }]);
    await until(async () => (await events()).mods.length === 1, 'mod wgrany');
    assert.deepStrictEqual((await events()).mods.map((f) => f.name), ['death-games.jar']);
    assert.match((await toasts()).join(' '), /Pominięto: 1/, 'plik .txt pominięty przy wgrywaniu modów');
    await pickFiles('Dodaj texturepacki', [{ name: 'Arena Pack.zip', content: 'PK-pack' }]);
    await pickFiles('Dodaj shaderpacki', [{ name: 'Arena Shaders.zip', content: 'PK-shader' }, { name: 'Arena Shaders.txt', content: 'sun=1' }]);
    await until(async () => { const e = await events(); return e.resourcepacks.length === 1 && e.shaderpacks.length === 2; }, 'texturepack i shaderpacki wgrane');
    ok('przyciski „Dodaj mody / texturepacki / shaderpacki” wgrywają pliki właściwego rodzaju i pomijają nieobsługiwane');

    // duży plik z panelu: progi zbite (1 MB / część 5 MiB), więc 12 MB idzie częściami; serwer bez wgrywania częściami (Node) dostaje zwykły PUT
    await evaluate('window.__crownSingleMax = 1048576; window.__crownPartSize = 5242880; true');
    const bigSize = 12 * 1024 * 1024;
    await pickFiles('Dodaj mody', [{ name: 'duzy-mod.jar', bigSize }]);
    await until(async () => (await events()).mods.some((f) => f.name === 'duzy-mod.jar'), 'duży mod wgrany z panelu', 60000);
    const bigMod = (await events()).mods.find((f) => f.name === 'duzy-mod.jar');
    assert.strictEqual(bigMod.size, bigSize + 2);
    assert.strictEqual(bigMod.sha1, require('crypto').createHash('sha1').update(Buffer.from('PK' + 'x'.repeat(bigSize))).digest('hex'), 'SHA-1 dużego pliku');
    await evaluate('delete window.__crownSingleMax; delete window.__crownPartSize; true');
    assert.strictEqual((await fetch(`${base}/v1/admin/events/igrzyska/mods/duzy-mod.jar`, { method: 'DELETE', headers: bearer })).status, 200);
    await until(async () => (await events()).mods.length === 1, 'duży mod usunięty');
    ok('panel: plik 12 MB idzie częściami (Worker) albo zwykłym PUT (serwer Node) - rozmiar i SHA-1 zgodne');

    // configi i options z pojedynczych plików: options.txt i servers.dat do katalogu głównego, reszta do config
    await pickFiles('Dodaj configi', [
      { name: 'options.txt', content: 'fov:70.0\n' },
      { name: 'sodium-options.json', content: '{"a":1}' },
      { name: 'servers.dat', content: 'nbt' },
    ]);
    await until(async () => { const e = await events(); return e.root.length === 2 && e.config.length === 1; }, 'configi i opcje wgrane');
    let ev = await events();
    assert.deepStrictEqual(ev.root.map((f) => [f.name, f.enforce]), [['options.txt', false], ['servers.dat', false]]);
    assert.deepStrictEqual(ev.config.map((f) => [f.name, f.enforce]), [['sodium-options.json', true]]);

    // cały folder .minecraft: config/, mods/, options.txt trafiają do wydarzenia, saves/ i logs/ są pomijane
    const rel = (p, name, content = 'PK-x') => ({ name, content, rel: `mc/${p}` });
    await pickFiles('Dodaj folder', [
      rel('config/sub/iris.properties', 'iris.properties', 'shaderPack=x'),
      rel('config/lithium.toml', 'lithium.toml', 'a=1'),
      rel('mods/fabric-api.jar', 'fabric-api.jar'),
      rel('resourcepacks/Extra.zip', 'Extra.zip'),
      rel('options.txt', 'options.txt', 'fov:90.0\n'),
      rel('saves/world/level.dat', 'level.dat', 'x'),
      rel('logs/latest.log', 'latest.log', 'x'),
      rel('config/program.exe', 'program.exe', 'MZ'),
    ]);
    await until(async () => (await events()).mods.length === 2, 'folder wgrany');
    ev = await events();
    assert.deepStrictEqual(ev.config.map((f) => f.name).sort(), ['lithium.toml', 'sodium-options.json', 'sub/iris.properties']);
    assert.deepStrictEqual(ev.mods.map((f) => f.name).sort(), ['death-games.jar', 'fabric-api.jar']);
    assert.deepStrictEqual(ev.resourcepacks.map((f) => f.name).sort(), ['Arena Pack.zip', 'Extra.zip']);
    assert.strictEqual(ev.root.find((f) => f.name === 'options.txt').size, 'fov:90.0\n'.length, 'options.txt z folderu nadpisał poprzedni');
    const t = (await toasts()).join(' ');
    assert.match(t, /Pominięto: 3/, `saves/, logs/ i .exe pominięte (${t})`);
    ok('„Dodaj folder”: config/, mods/, resourcepacks/, options.txt trafiają do wydarzenia; saves/, logs/ i nieobsługiwane pliki pomijane');

    // karta pokazuje wszystko i jest gotowa
    await until(async () => /Gotowe/.test(await text()), 'status Gotowe');
    const page = await text();
    for (const needle of ['Mody (2)', 'Texturepacki (2)', 'Shaderpacki (2)', 'Configi (3)', 'Opcje i pliki gry (2)', 'sub/iris.properties', 'servers.dat']) {
      assert.ok(page.includes(needle), `karta nie zawiera „${needle}”`);
    }
    ok('karta wydarzenia: listy rodzajów z liczbami i status „Gotowe”');

    // ---- wymuszanie: przełącznik przy pliku ----
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.dev')].find((r) => r.textContent.includes('servers.dat'));
      const box = row.querySelector('input[type=checkbox]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(async () => (await events()).root.find((f) => f.name === 'servers.dat').enforce === true, 'flaga wymuszania zapisana');
    // configi są wymuszane domyślnie - wyłączamy jeden
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.dev')].find((r) => r.textContent.includes('lithium.toml'));
      const box = row.querySelector('input[type=checkbox]');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(async () => (await events()).config.find((f) => f.name === 'lithium.toml').enforce === false, 'wyłączenie wymuszania configu');
    ok('przełącznik „wymuszaj” zapisuje flagę (options/servers domyślnie startowe, configi domyślnie wymuszane)');

    // ---- usuwanie z potwierdzeniem ----
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.dev')].find((r) => r.textContent.includes('sub/iris.properties'));
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Usuń').click();
    })()`);
    await until(() => evaluate("!!document.querySelector('.overlay')"), 'okno potwierdzenia');
    await evaluate("[...document.querySelectorAll('.overlay button')].find((b) => b.textContent.trim() === 'Usuń').click()");
    await until(async () => !(await events()).config.some((f) => f.name === 'sub/iris.properties'), 'plik usunięty');
    if (!CF) assert.ok(!fs.existsSync(path.join(dataDir, 'events', 'igrzyska', 'config', 'sub')), 'pusty folder usunięty z serwera');
    await until(async () => !(await text()).includes('sub/iris.properties'), 'plik zniknął z karty');
    ok('usuwanie pliku z potwierdzeniem: znika z serwera i z karty, pusty folder sprzątnięty');

    // ---- zrzut ekranu (do oceny wyglądu) ----
    await evaluate("document.querySelector('.card .toolbar h2')?.scrollIntoView()").catch(() => {});
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const shotFile = path.join(os.tmpdir(), 'crown-panel-event.png');
    fs.writeFileSync(shotFile, Buffer.from(shot.result.data, 'base64'));
    // ---- adres logo otwarty w karcie (pasek adresu, „otwórz obraz w nowej karcie”) → 404, nie obraz ----
    await send('Page.navigate', { url: `${base}/logo.png` });
    await until(async () => (await evaluate('document.contentType')) === 'application/json', 'odpowiedź na bezpośrednie wejście w /logo.png');
    assert.match(await evaluate('document.body.innerText'), /Nie znaleziono/);
    ok('/logo.png otwarte bezpośrednio w karcie (nawigacja, Sec-Fetch-Dest: document) → 404 JSON, nie obraz');
    console.log(`\nWSZYSTKO OK (${n})   zrzut panelu: ${shotFile}`);
    finished = true;
  } finally {
    try { ws?.close(); } catch { /* już zamknięte */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    server.kill();
    // Electron jeszcze chwilę zwalnia pliki po zabiciu procesu - ponawiamy usuwanie
    for (const d of [dataDir, userData]) rmDir(d);
  }
  process.exit(finished ? 0 : 1);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
