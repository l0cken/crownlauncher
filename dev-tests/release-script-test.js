// Test scripts/release.js na atrapie API GitHub (bez tokenu użytkownika, bez budowania):
// podbicie wersji, nazwa/opis wydania, kontrola kompletu plików, publikacja, usuwanie starych wydań i tagów.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const REAL = 'C:/Users/meabx/Desktop/CrownLauncher/';
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

function makeProject(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-rel-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/main/core'), { recursive: true });
  fs.copyFileSync(REAL + 'scripts/release.js', path.join(dir, 'scripts/release.js'));
  fs.copyFileSync(REAL + 'scripts/version-util.js', path.join(dir, 'scripts/version-util.js'));
  // piaskownica testuje tryb GitHub - niezależnie od tego, na co wskazuje produkcyjny app-config.js
  fs.writeFileSync(
    path.join(dir, 'src/main/core/app-config.js'),
    fs.readFileSync(REAL + 'src/main/core/app-config.js', 'utf8').replace(/GITHUB_REPO: '[^']*'/g, "GITHUB_REPO: 'l0cken/crownlauncher'").replace(/ANNOUNCEMENTS_URL: '[^']*'/g, "ANNOUNCEMENTS_URL: ''"),
  );
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "x",\n  "version": "${version}"\n}\n`);
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    `{\n  "name": "x",\n  "version": "${version}",\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "${version}"\n    },\n    "node_modules/y": {\n      "version": "${version}"\n    }\n  }\n}\n`,
  );
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  return { dir, out };
}

/** „Zbudowane” pliki wydania: latest.yml + instalator; zwraca listę zasobów, jakie ma mieć wydanie na GitHubie. */
function buildOutput(out, version, exeSize) {
  const exe = `CrownLauncher-Setup-${version}.exe`;
  fs.writeFileSync(path.join(out, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${exe}\n`);
  fs.writeFileSync(path.join(out, exe), Buffer.alloc(exeSize));
  return [
    { name: 'latest.yml', size: fs.statSync(path.join(out, 'latest.yml')).size, state: 'uploaded' },
    { name: exe, size: exeSize, state: 'uploaded' },
  ];
}

/** Atrapa API GitHub. `autoAssets` - zasoby, które dostaje każde nowo utworzone wydanie (udaje wgranie przez electron-builder). */
function startApi(initialReleases, autoAssets = []) {
  const state = { releases: initialReleases, nextId: 100, log: [], tags: new Set(initialReleases.map((r) => r.tag_name)) };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
      const data = body ? JSON.parse(body) : {};
      state.log.push(`${req.method} ${p}${body ? ' ' + body : ''}`);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === null ? '' : JSON.stringify(obj));
      };
      let m;
      if (req.method === 'GET' && p === '/releases') return send(200, state.releases);
      if (req.method === 'POST' && p === '/releases') {
        const r = { id: state.nextId++, draft: true, ...data, assets: autoAssets.map((a) => ({ ...a })) };
        state.releases.push(r);
        state.tags.add(data.tag_name);
        return send(201, r);
      }
      if (req.method === 'GET' && p === '/releases/latest') {
        const pub = state.releases.filter((r) => !r.draft);
        return pub.length ? send(200, pub[pub.length - 1]) : send(404, { message: 'Not Found' });
      }
      if ((m = /^\/releases\/(\d+)$/.exec(p))) {
        const r = state.releases.find((x) => x.id === Number(m[1]));
        if (!r) return send(404, { message: 'Not Found' });
        if (req.method === 'GET') return send(200, r);
        if (req.method === 'PATCH') {
          Object.assign(r, data);
          return send(200, r);
        }
        if (req.method === 'DELETE') {
          state.releases = state.releases.filter((x) => x.id !== r.id);
          return send(204, null);
        }
      }
      if (req.method === 'DELETE' && (m = /^\/git\/refs\/tags\/(.+)$/.exec(p))) {
        state.tags.delete(decodeURIComponent(m[1]));
        return send(204, null);
      }
      return send(404, { message: `Nie obsłużono ${req.method} ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

function run(dir, out, port, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'scripts/release.js'), '--no-upload', '--dir', out, ...extra], {
      env: { ...process.env, GH_TOKEN: 'test-token', CROWN_GITHUB_API: `http://127.0.0.1:${port}` },
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', (code) => resolve({ code, text }));
  });
}

const old = (id, tag) => ({ id, tag_name: tag, name: tag.slice(1), draft: false, assets: [{ name: 'latest.yml', size: 10, state: 'uploaded' }] });

(async () => {
  // 1) wersja z package.json jest już wydana (v0.1.18) -> skrypt podbija na 0.1.19; wydanie „CrownLauncher”; stare znikają
  const { dir, out } = makeProject('0.1.18');
  let api = await startApi([old(1, 'v0.1.17'), old(2, 'v0.1.18')], buildOutput(out, '0.1.19', 1000));
  let r = await run(dir, out, api.port);
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /podbijam na 0\.1\.19/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.1.19');
  const lock = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  assert.strictEqual((lock.match(/"version": "0\.1\.19"/g) || []).length, 2, 'dwa wpisy locka');
  assert.match(lock, /node_modules\/y"[\s\S]*"version": "0\.1\.18"/, 'zależność bez zmian');
  ok('wersja już wydana -> skrypt sam podbija numer (package.json + 2 wpisy locka, zależności nietknięte)');

  const created = api.state.log.find((l) => l.startsWith('POST /releases '));
  assert.match(created, /"name":"CrownLauncher"/);
  assert.ok(created.includes('"body":"​"'), created);
  assert.match(created, /"tag_name":"v0\.1\.19"/);
  ok('wydanie nazywa się „CrownLauncher”, opis to niewidoczny znak (nie komunikat commita), tag v0.1.19');

  const pub = api.state.log.find((l) => l.startsWith('PATCH /releases/') && l.includes('"draft":false'));
  assert.ok(pub && /"name":"CrownLauncher"/.test(pub) && /"make_latest":"true"/.test(pub), pub);
  assert.deepStrictEqual(api.state.releases.map((x) => x.tag_name), ['v0.1.19']);
  assert.deepStrictEqual([...api.state.tags], ['v0.1.19']);
  ok('po publikacji zostaje jedno wydanie (v0.1.19); starsze wydania i ich tagi usunięte');

  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'scripts/.last-release.json'), 'utf8'));
  assert.strictEqual(marker.version, '0.1.19');
  ok('znacznik ostatniego wydania zapisany');
  api.server.close();

  // 2) kolejne uruchomienie przy PUSTYM GitHubie (wydania skasowane ręcznie): znacznik wymusza podbicie
  api = await startApi([], buildOutput(out, '0.1.20', 1000));
  r = await run(dir, out, api.port);
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /podbijam na 0\.1\.20/);
  assert.deepStrictEqual(api.state.releases.map((x) => x.tag_name), ['v0.1.20']);
  ok('GitHub pusty (wydania skasowane ręcznie), ale znacznik pamięta 0.1.19 -> wydanie 0.1.20');
  api.server.close();

  // 3) wersja jeszcze niewydana -> bez podbijania; --keep-old nie usuwa starych wydań
  {
    const p = makeProject('0.1.18');
    fs.writeFileSync(path.join(p.dir, 'scripts/.last-release.json'), JSON.stringify({ version: '0.1.17' }));
    api = await startApi([old(1, 'v0.1.17')], buildOutput(p.out, '0.1.18', 500));
    r = await run(p.dir, p.out, api.port, ['--keep-old']);
    assert.strictEqual(r.code, 0, r.text);
    assert.doesNotMatch(r.text, /podbijam/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8')).version, '0.1.18');
    assert.deepStrictEqual(api.state.releases.map((x) => x.tag_name).sort(), ['v0.1.17', 'v0.1.18']);
    ok('wersja jeszcze niewydana: bez podbijania; --keep-old zostawia stare wydania');
    api.server.close();
  }

  // 4) niekompletne wydanie (brak pliku .exe na GitHubie) -> nie publikuje i nie usuwa starych
  {
    const p = makeProject('0.1.20');
    buildOutput(p.out, '0.1.20', 500);
    api = await startApi([old(1, 'v0.1.19')], [{ name: 'latest.yml', size: 5, state: 'uploaded' }]);
    r = await run(p.dir, p.out, api.port);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.text, /niekompletne/);
    assert.ok(api.state.releases.some((x) => x.tag_name === 'v0.1.19'), 'stare wydanie zostaje');
    assert.ok(api.state.releases.find((x) => x.tag_name === 'v0.1.20').draft, 'nowe zostaje wersją roboczą');
    ok('niekompletne wydanie: zostaje ukryte, stare wydanie nietknięte');
    api.server.close();
  }

  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
