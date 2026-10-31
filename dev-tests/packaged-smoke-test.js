// Spakowana aplikacja (release/win-unpacked, ta sama co w instalatorze) w prawdziwym Electronie, z osobnym katalogiem
// danych: czy startuje, zna swoją wersję i czy aktualizator (tryb pakietu) poprawnie pyta źródło wydań (GitHub albo prywatny serwer).
// Uruchomienie: node dev-tests/packaged-smoke-test.js   (otwiera na chwilę okno launchera)
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const exe = process.env.CROWN_PKG_EXE || path.join(root, 'release', 'win-unpacked', 'CrownLauncher.exe'); // CROWN_PKG_EXE: inna kopia spakowanej aplikacji (np. świeży build do testu)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

async function until(fn, what, ms = 40000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`Przekroczono czas: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

(async () => {
  assert.ok(fs.existsSync(exe), `brak ${exe} - najpierw zbuduj/wydaj launcher`);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-pkg-'));
  const port = await freePort();
  const proc = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let ws;
  try {
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    }, 'okno spakowanego launchera');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP: brak połączenia')); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const evaluate = (expression) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (d) => (d.result?.exceptionDetails ? rej(new Error(d.result.exceptionDetails.exception?.description || 'wyjątek')) : res(d.result?.result?.value)));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });

    // build z INVITE_REQUIRED pokazuje ekran z kluczem zamiast launchera (klucza tu nie mamy i nie wpisujemy)
    const inv = (await until(async () => {
      const r = await evaluate("window.crown.invoke('invite:status')");
      return r?.ok ? r : null;
    }, 'invite:status')).data;
    if (inv.required) {
      await until(() => evaluate("!!document.querySelector('input.input') && /tylko dla zaproszonych/.test(document.body.innerText)"), 'ekran z kluczem');
      assert.strictEqual(await evaluate("!!document.querySelector('.sidebar')"), false);
      ok('spakowany launcher (prywatna dystrybucja): bez klucza pokazuje tylko ekran zaproszenia');
    } else {
      await until(() => evaluate("!!document.querySelector('.sidebar') && document.querySelectorAll('.nav-item').length"), 'launcher w oknie');
      assert.strictEqual(await evaluate("document.querySelectorAll('.nav-item').length"), 6);
      assert.ok(!/Błąd uruchomienia/.test(await evaluate('document.body.innerText')));
      ok('spakowany launcher startuje i pokazuje interfejs (menu z 6 pozycjami)');
    }

    const info = await evaluate("window.crown.invoke('app:info')");
    assert.strictEqual(info.data.version, version);
    ok(`app:info: wersja ${info.data.version}`);

    const conf = await evaluate("window.crown.invoke('config:get')");
    assert.ok(conf.ok && !('accounts' in conf.data) && !('capeSecrets' in conf.data) && !('inviteKey' in conf.data) && !('publisherKey' in conf.data));
    ok('config:get bez kont, kluczy i sekretów');

    let noKeyMessage = null;
    // aktualizator w trybie pakietu pyta źródło wydań:
    //  - bez zaproszeń: ta sama wersja = „Masz najnowszą wersję”,
    //  - serwer prywatny, a my bez klucza: czytelny błąd o kluczu zaproszenia (serwer odpowiada 401 - jest osiągalny i zamknięty)
    const upd = await evaluate("window.crown.invoke('update:check')");
    assert.ok(upd.ok, JSON.stringify(upd));
    const state = await until(async () => {
      const s = (await evaluate("window.crown.invoke('update:status')")).data;
      return ['none', 'available', 'error', 'disabled'].includes(s.state) ? s : null;
    }, 'wynik sprawdzenia aktualizacji', 60000);
    if (inv.required) {
      assert.strictEqual(state.state, 'error', `aktualizator: ${JSON.stringify(state)}`);
      noKeyMessage = state.error;
      ok('aktualizator odpytał prywatny serwer bez klucza: odmowa (stan „error”)');

      // z prawdziwym kluczem (env CROWN_INVITE_KEY, nigdzie nie wypisywany): klucz przyjęty, aktualizator dostaje
      // latest.yml z serwera (ta sama wersja = brak aktualizacji; nowsza na serwerze = „available”)
      if (process.env.CROWN_INVITE_KEY) {
        const set = await evaluate(`window.crown.invoke('invite:set', ${JSON.stringify(process.env.CROWN_INVITE_KEY)})`);
        assert.ok(set.ok && set.data.active, JSON.stringify(set));
        ok(`klucz zaproszenia przyjęty przez spakowaną aplikację (właściciel: ${set.data.name})`);
        await evaluate("window.crown.invoke('update:check')");
        const withKey = await until(async () => {
          const st = (await evaluate("window.crown.invoke('update:status')")).data;
          return ['none', 'available', 'error'].includes(st.state) && st.state !== 'error' ? st : st.state === 'error' && !/klucz zaproszenia/i.test(st.error || '') ? st : null;
        }, 'wynik aktualizatora z kluczem', 60000);
        assert.ok(['none', 'available'].includes(withKey.state), `aktualizator z kluczem: ${JSON.stringify(withKey)}`);
        ok(`aktualizator z kluczem odczytał latest.yml z serwera prywatnego: stan „${withKey.state}”`);
      }
    } else {
      assert.strictEqual(state.state, 'none', `aktualizator: ${JSON.stringify(state)}`);
      ok('aktualizator (tryb pakietu) odpytał źródło wydań: „Masz najnowszą wersję”, bez błędu');
    }

    if (noKeyMessage !== null) {
      assert.match(noKeyMessage, /klucz zaproszenia/i, `komunikat aktualizatora bez klucza: ${noKeyMessage}`);
      ok('komunikat aktualizatora przy odmowie 401 mówi o kluczu zaproszenia (nie o „publikowanej wersji”)');
    }
    const accs = await evaluate("window.crown.invoke('accounts:list')");
    assert.deepStrictEqual(accs.data.accounts, []);
    ok('świeże dane: brak kont (pierwszy start pokazuje okno powitalne)');
  } finally {
    try { ws?.close(); } catch { /* już zamknięte */ }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* jeszcze zajęty */ }
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
