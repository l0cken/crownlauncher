// Bramka serwera gry end-to-end: PRAWDZIWY Velocity (ten sam jar co na VPS) z pluginem CrownGate + prawdziwy server/server.js
// (INVITE_ONLY) + udawany klient Minecrafta (handshake i logowanie po TCP). Sprawdza, że gracz bez sesji launchera dostaje komunikat
// o launcherze, gracz z sesją przechodzi, a unieważnienie, zamknięcie gry, awaria API, lista „bez-bramki” i tryb „tylko-log” działają.
//
// Wymaga: CROWN_VELOCITY_JAR=<velocity.jar> (np. skopiowany z VPS: /opt/mc/velocity/server.jar),
//         CROWN_GATE_JAR=<CrownGate-1.0.jar> (domyślnie pluginy/bukkit/out), java w PATH.
// Opcjonalnie CROWN_VELOCITY_EXTRA=<jar,jar> (np. SkyAuth-Velocity i IPblocker z VPS) - druga runda na produkcyjnym zestawie pluginów.
// Uruchomienie: node dev-tests/gate-velocity-test.js
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { rmDir } = require('./lib/backend');

const VELOCITY = process.env.CROWN_VELOCITY_JAR || '';
const GATE_JAR = process.env.CROWN_GATE_JAR || 'C:\\Users\\meabx\\Desktop\\pluginy\\bukkit\\out\\CrownGate-1.0.jar';
const EXTRA = (process.env.CROWN_VELOCITY_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!VELOCITY || !fs.existsSync(VELOCITY) || !fs.existsSync(GATE_JAR)) {
  console.log('POMINIĘTO: ustaw CROWN_VELOCITY_JAR (velocity.jar) i zbuduj CrownGate (pluginy/bukkit: ./build.sh CrownGate).');
  process.exit(0);
}

const root = path.join(__dirname, '..') + path.sep;
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// procesy potomne (serwer launchera, Velocity) zawsze giną razem z testem - także po błędzie i po przekroczeniu czasu
const children = [];
const track = (c) => { children.push(c); return c; };
// na Windowsie c.kill() zabija tylko powłokę „java”, a nie proces Javy - ubijamy całe drzewo
const killTree = (c) => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); else c.kill(); } catch { /* już zakończony */ } };
process.on('exit', () => { for (const c of children) killTree(c); });
setTimeout(() => { console.error('\nFAIL: przekroczono limit czasu testu (170 s)'); process.exit(1); }, 170_000).unref();
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- udawany klient Minecrafta: handshake + Login Start, czyta pierwszy pakiet odpowiedzi ----
const varint = (v) => { const b = []; for (;;) { const t = v & 0x7f; v >>>= 7; if (v) b.push(t | 0x80); else { b.push(t); break; } } return Buffer.from(b); };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };
const pkt = (id, ...parts) => { const body = Buffer.concat([varint(id), ...parts]); return Buffer.concat([varint(body.length), body]); };
const readVarint = (buf, off) => { let v = 0; let sh = 0; for (let i = off; i < buf.length; i++) { v |= (buf[i] & 0x7f) << sh; if (!(buf[i] & 0x80)) return { v, next: i + 1 }; sh += 7; } return null; };

function join(port, name) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.on('connect', () => {
      const hs = pkt(0x00, varint(769), str('127.0.0.1'), Buffer.from([port >> 8, port & 255]), varint(2)); // 1.21.4, następny stan: logowanie
      const uuid = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
      s.write(Buffer.concat([hs, pkt(0x00, str(name), uuid)]));
    });
    let compressed = false; // po pakiecie Set Compression każdy pakiet ma jeszcze długość nieskompresowanych danych (0 = bez kompresji)
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.next + len.v) return;
        const end = len.next + len.v;
        let off = len.next;
        if (compressed) off = readVarint(buf, off).next;
        const id = readVarint(buf, off);
        if (id.v === 0x00) {
          const sl = readVarint(buf, id.next);
          const json = buf.subarray(sl.next, sl.next + sl.v).toString('utf8');
          const text = [...json.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
          return finish({ kind: 'disconnect', text });
        }
        if (id.v === 0x03) {
          compressed = true; // Velocity włącza kompresję przed LoginEvent; odrzucenie w LoginEvent przychodzi już w ramce skompresowanej
          buf = buf.subarray(end);
          continue;
        }
        return finish({ kind: 'accepted', id: id.v }); // 0x01 prośba o szyfrowanie, 0x02 Login Success
      }
    });
    s.on('error', () => finish({ kind: 'error' }));
    s.on('close', () => finish({ kind: 'closed' }));
    setTimeout(() => finish({ kind: 'timeout' }), 10_000);
  });
}

// czeka, aż w logu Velocity pojawi się wpis (logi trafiają do rury z opóźnieniem względem odpowiedzi dla klienta)
const seen = async (vel, re, msg = '') => {
  for (let i = 0; i < 30 && !re.test(vel.log()); i++) await sleep(100);
  assert.ok(re.test(vel.log()), `w logu Velocity brak ${re} ${msg}
${vel.log().slice(-1200)}`);
};
const gated = (r) => r.kind === 'disconnect' && /CrownLaunchera/.test(r.text);
const apiDown = (r) => r.kind === 'disconnect' && /Nie mogę teraz sprawdzić/.test(r.text);
const passed = (r) => r.kind === 'accepted' || (r.kind === 'disconnect' && !/CrownLaunchera|Nie mogę teraz sprawdzić|nieważny/.test(r.text));

(async () => {
  // ---- serwer launchera ----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-gatev-'));
  const apiPort = await freePort();
  const env = { ...process.env, PORT: String(apiPort), HOST: '127.0.0.1', DATA_DIR: dataDir, INVITE_ONLY: '1' };
  let api = track(spawn(process.execPath, [root + 'server/server.js'], { env, stdio: ['ignore', 'pipe', 'ignore'] }));
  await new Promise((res, rej) => { api.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) res(); }); setTimeout(() => rej(new Error('serwer launchera nie wystartował')), 8000); });
  const base = `http://127.0.0.1:${apiPort}`;
  const adminKey = /(crown_\S+)/.exec(spawnSync(process.execPath, [root + 'server/server.js', 'create-key', 'Panel', 'admin'], { env, encoding: 'utf8' }).stdout)[1];
  const bearer = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  const adm = (method, p, body) => fetch(`${base}${p}`, { method, headers: bearer, body: body === undefined ? undefined : JSON.stringify(body) });
  const gateKey = (await (await adm('POST', '/v1/admin/gate/key')).json()).key;
  const invite = await (await adm('POST', '/v1/admin/invites', { name: 'Gracz', maxUses: 5 })).json();
  const dev = 'komputer-e2e-0123456789abcdefghijkl';
  const hdr = { 'X-Crown-Invite': invite.key, 'X-Crown-Device': dev, 'Content-Type': 'application/json' };
  const startGame = (nick, h = hdr) => fetch(`${base}/v1/play`, { method: 'POST', headers: h, body: JSON.stringify({ nick }) }); // to robi launcher
  const stopGame = (nick) => fetch(`${base}/v1/play?nick=${nick}`, { method: 'DELETE', headers: hdr });

  // ---- Velocity ----
  async function runVelocity(extraJars) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-velocity-'));
    const port = await freePort();
    fs.mkdirSync(path.join(dir, 'plugins', 'crowngate'), { recursive: true });
    fs.copyFileSync(GATE_JAR, path.join(dir, 'plugins', path.basename(GATE_JAR)));
    for (const j of extraJars) fs.copyFileSync(j, path.join(dir, 'plugins', path.basename(j)));
    fs.writeFileSync(path.join(dir, 'velocity.toml'), [
      'config-version = "2.7"', `bind = "127.0.0.1:${port}"`, 'motd = "test"', 'show-max-players = 10', 'online-mode = false',
      'prevent-client-proxy-connections = false', 'player-info-forwarding-mode = "none"', 'ping-passthrough = "DISABLED"',
      '[servers]', 'igrzyska = "127.0.0.1:9"', 'try = ["igrzyska"]', '[forced-hosts]', '[advanced]', 'login-ratelimit = 0',
    ].join('\n'));
    const cfgFile = path.join(dir, 'plugins', 'crowngate', 'config.properties');
    const writeCfg = (extra = {}) => fs.writeFileSync(cfgFile, Object.entries({
      wlaczony: 'true', tryb: 'blokuj', api: base, klucz: gateKey, 'cache-ok-s': '1', 'cache-nie-s': '0', 'timeout-ms': '1500',
      'gdy-api-nie-dziala': 'blokuj', 'lata-po-awarii-min': '15', 'bez-bramki': 'Adminek', ...extra,
    }).map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8');
    writeCfg();
    if (extraJars.length) {
      // IPblocker z pustą listą wyjątków wiąże także adres 127.0.0.1 (żeby pokazać, że odrzucony przez bramkę nie zajmie adresu)
      fs.mkdirSync(path.join(dir, 'plugins', 'ipblocker'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugins', 'ipblocker', 'config.properties'), 'wlaczony=true\nwyjatki=\nbez-blokady=\npermisja-dziala=false\nloguj-odrzucenia=true\n', 'utf8');
    }
    const proc = track(spawn('java', ['-Xmx256m', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dfile.encoding=UTF-8', '-jar', VELOCITY], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }));
    let log = '';
    const onData = (d) => { log += String(d); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    for (let i = 0; i < 400 && !/Done \(/.test(log); i++) await sleep(100);
    assert.ok(/Done \(/.test(log), `Velocity wystartował\n${log.slice(-800)}`);
    assert.ok(/\[CrownGate\].*klucz bramki przyjęty|\[CrownGate\]/.test(log) || (await sleep(1000), /\[CrownGate\]/.test(log)), 'plugin CrownGate się załadował');
    return {
      port, dir, log: () => log, writeCfg,
      console: (cmd) => proc.stdin.write(`${cmd}\n`),
      stop: () => { killTree(proc); },
      exited: new Promise((r) => proc.on('exit', r)),
    };
  }

  const v = await runVelocity([]);
  await sleep(500);
  await seen(v, /połączenie z serwerem launchera działa, klucz bramki przyjęty/, '(próba połączenia przy starcie)');
  ok('Velocity (prawdziwy jar z VPS) ładuje CrownGate; przy starcie sprawdza klucz bramki w serwerze launchera');

  // ---- klient bez launchera ----
  let r = await join(v.port, 'Vanilla_Gracz');
  assert.ok(gated(r), `bez sesji launchera: komunikat o launcherze (${JSON.stringify(r)})`);
  await seen(v, /odrzucono Vanilla_Gracz z 127\.0\.0\.1 — no-session/);
  ok('gracz bez sesji launchera dostaje komunikat „tylko z CrownLaunchera” i wpis w logu');

  // ---- klient z launchera ----
  await startGame('Launcher_Gracz');
  r = await join(v.port, 'Launcher_Gracz');
  assert.ok(passed(r), `z sesją launchera wchodzi (${JSON.stringify(r)})`);
  await seen(v, /wpuszczono Launcher_Gracz \(z launchera, klucz: Gracz\)/);
  r = await join(v.port, 'launcher_gracz');
  assert.ok(passed(r), 'wielkość liter nicku bez znaczenia');
  ok('gracz z sesją launchera przechodzi bramkę (log wskazuje, czyj to klucz)');

  // ---- zamknięcie gry ----
  await stopGame('Launcher_Gracz');
  await sleep(1300); // cache „ok” (1 s)
  assert.ok(gated(await join(v.port, 'Launcher_Gracz')), 'po zamknięciu gry w launcherze bramka znów nie wpuszcza');
  ok('po zamknięciu gry (DELETE sesji) bramka znów odrzuca');

  // ---- unieważnienie klucza ----
  await startGame('Launcher_Gracz');
  await sleep(1300);
  assert.ok(passed(await join(v.port, 'Launcher_Gracz')));
  await adm('POST', `/v1/admin/invites/${invite.id}/revoke`);
  await sleep(1300);
  r = await join(v.port, 'Launcher_Gracz');
  assert.ok(r.kind === 'disconnect' && /nieważny/.test(r.text), `unieważniony klucz: komunikat o kluczu (${JSON.stringify(r)})`);
  ok('unieważnienie klucza w panelu odcina od razu przy następnym wejściu (osobny komunikat o kluczu)');

  // ---- nick z listy bez-bramki, ale bez potwierdzenia premium (Velocity w trybie offline) ----
  assert.ok(gated(await join(v.port, 'Adminek')), 'nick z „bez-bramki” bez potwierdzenia premium nie omija bramki');
  await seen(v, /odrzucono Adminek/);
  ok('nick z „bez-bramki” nie omija bramki, gdy Mojang nie potwierdził konta (tu: proxy w trybie offline)');

  // ---- tryb tylko-log ----
  v.writeCfg({ tryb: 'tylko-log' });
  v.console('crowngate reload');
  await sleep(800);
  assert.ok(passed(await join(v.port, 'Ktos_Bez_Sesji')), 'tryb tylko-log nikogo nie odrzuca');
  await seen(v, /\(tryb tylko-log\) odrzuciłbym Ktos_Bez_Sesji z 127\.0\.0\.1 — no-session/);
  ok('tryb „tylko-log” + /crowngate reload: nikt nie jest odrzucany, ale log pokazuje kogo by odrzucono');
  v.writeCfg();
  v.console('crowngate reload');
  await sleep(800);
  assert.ok(gated(await join(v.port, 'Ktos_Bez_Sesji')), 'po powrocie do trybu blokuj bramka działa');

  // ---- awaria serwera launchera ----
  const adm2 = await (await adm('POST', '/v1/admin/invites', { name: 'Gracz2', maxUses: 5 })).json();
  const hdr2 = { 'X-Crown-Invite': adm2.key, 'X-Crown-Device': dev, 'Content-Type': 'application/json' };
  await fetch(`${base}/v1/play`, { method: 'POST', headers: hdr2, body: JSON.stringify({ nick: 'Stalyklient' }) });
  assert.ok(passed(await join(v.port, 'Stalyklient')));
  api.kill();
  await new Promise((res) => api.on('close', res));
  await sleep(1300);
  assert.ok(passed(await join(v.port, 'Stalyklient')), 'przy awarii API gracz, który przeszedł bramkę przed chwilą, wchodzi (okres łaski)');
  r = await join(v.port, 'Nowy_Nieznajomy');
  assert.ok(apiDown(r), `przy awarii API nieznany gracz dostaje komunikat o awarii (${JSON.stringify(r)})`);
  v.writeCfg({ 'gdy-api-nie-dziala': 'przepusc' });
  v.console('crowngate reload');
  await sleep(800);
  assert.ok(passed(await join(v.port, 'Nowy_Nieznajomy')), 'tryb „przepusc” wpuszcza przy awarii API');
  ok('awaria serwera launchera: okres łaski dla niedawnych graczy, „blokuj” odrzuca resztę z komunikatem o awarii, „przepusc” wpuszcza wszystkich');

  // ---- zły klucz bramki ----
  api = track(spawn(process.execPath, [root + 'server/server.js'], { env, stdio: ['ignore', 'pipe', 'ignore'] }));
  await new Promise((res) => api.stdout.on('data', (d) => { if (String(d).includes('Serwer ogłoszeń')) res(); }));
  v.writeCfg({ klucz: 'gate_zly-klucz-0123456789abcdef' });
  v.console('crowngate reload');
  await sleep(1200);
  await seen(v, /nie odpowiada poprawnie na zapytanie bramki: awaria: HTTP 401/, 'zły klucz bramki widać w logu od razu po reloadzie');
  assert.ok(apiDown(await join(v.port, 'Nowy_Nieznajomy2')), 'zły klucz bramki = awaria (blokuj), nie „wpuszczam wszystkich”');
  ok('zły klucz bramki: głośny błąd w logu przy starcie/reloadzie, a gracze dostają komunikat o awarii');

  // ---- wydarzenie: wejść można TYLKO z instancji IGRZYSKA ŚMIERCI (nie z dowolnej instancji CrownLaunchera) ----
  const kodInv = await (await adm('POST', '/v1/admin/invites', { name: 'KodIgrzysk', profile: 'igrzyska', maxUses: 0 })).json();
  const zwInv = await (await adm('POST', '/v1/admin/invites', { name: 'Zwykly', maxUses: 5 })).json();
  const hdrOf = (inv) => ({ 'X-Crown-Invite': inv.key, 'X-Crown-Device': dev, 'Content-Type': 'application/json' });
  const startIn = (nick, inv, event) => fetch(`${base}/v1/play`, { method: 'POST', headers: hdrOf(inv), body: JSON.stringify({ nick, event }) });
  v.writeCfg({ wydarzenie: 'igrzyska' });
  v.console('crowngate reload');
  await sleep(1200);
  await seen(v, /wydarzenie igrzyska \(tylko z jego instancji\)/);
  assert.strictEqual((await startIn('Z_Instancji', kodInv, 'igrzyska')).status, 200); // launcher: instancja IGRZYSKA ŚMIERCI, kod wydarzenia
  assert.strictEqual((await startIn('Z_Innej', zwInv)).status, 200); // launcher: zwykła instancja (pełny klucz)
  r = await join(v.port, 'Z_Instancji');
  assert.ok(passed(r), `z instancji IGRZYSKA ŚMIERCI wchodzi (${JSON.stringify(r)})`);
  r = await join(v.port, 'Z_Innej');
  assert.ok(r.kind === 'disconnect' && /nie z właściwej instancji/.test(r.text), `z innej instancji CrownLaunchera nie wchodzi i dostaje komunikat o instancji (${JSON.stringify(r)})`);
  await seen(v, /odrzucono Z_Innej z 127\.0\.0\.1 — wrong-instance/);
  r = await join(v.port, 'Bez_Launchera');
  assert.ok(r.kind === 'disconnect' && /tylko z CrownLaunchera/.test(r.text) && !/właściwej instancji/.test(r.text), `bez launchera: zwykły komunikat (${JSON.stringify(r)})`);
  v.writeCfg({ wydarzenie: 'igrzyska', 'komunikat-instancja': '&cWejdź z instancji &eIGRZYSKA ŚMIERCI&c.', komunikat: '&cTylko z instancji IGRZYSKA ŚMIERCI w CrownLauncherze.' });
  v.console('crowngate reload');
  await sleep(1200);
  r = await join(v.port, 'Z_Innej');
  assert.ok(r.kind === 'disconnect' && /Wejdź z instancji IGRZYSKA ŚMIERCI/.test(r.text), `komunikat z configu (${JSON.stringify(r)})`);
  ok('wydarzenie=igrzyska: z instancji IGRZYSKA ŚMIERCI wchodzi, z innej instancji CrownLaunchera nie (komunikat o instancji), bez launchera zwykły komunikat; komunikaty z configu');

  v.stop();
  await v.exited;
  await sleep(700);
  try { rmDir(v.dir); } catch { /* katalog tymczasowy może jeszcze chwilę być zajęty - system go posprząta */ }

  // ---- druga runda: produkcyjny zestaw pluginów (kolejność zdarzeń: SkyAuth nie nadpisze odrzucenia, IPblocker nie zajmie adresu) ----
  if (EXTRA.length) {
    const p = await runVelocity(EXTRA);
    const fresh = await (await adm('POST', '/v1/admin/invites', { name: 'Gracz3', maxUses: 5 })).json(); // klucz z rundy 1 jest już unieważniony
    const h3 = { 'X-Crown-Invite': fresh.key, 'X-Crown-Device': dev, 'Content-Type': 'application/json' };
    await sleep(1500);
    // losowe nicki: pewnie nie są kontami premium (SkyAuth sprawdza je w Mojangu i premium przechodzą przez szyfrowanie zamiast LoginEvent)
    const rnd = () => 'Z' + crypto.randomBytes(5).toString('hex');
    const [vanilla, first, second] = [rnd(), rnd(), rnd()];
    r = await join(p.port, vanilla);
    assert.ok(gated(r), `SkyAuth-Velocity nie nadpisuje odrzucenia bramki (${JSON.stringify(r)})`);
    await startGame(first, h3);
    r = await join(p.port, first);
    assert.ok(r.kind === 'accepted' && (r.id === 2 || r.id === 3), `gracz z launchera przechodzi cały zestaw pluginów aż do Login Success (${JSON.stringify(r)})`);
    await startGame(second, h3);
    r = await join(p.port, second);
    assert.ok(r.kind === 'disconnect' && /przypisany do konta/.test(r.text), `IPblocker działa i wiąże adres z pierwszym ZAAKCEPTOWANYM graczem (${JSON.stringify(r)})`);
    await seen(p, new RegExp('należy do ' + first));
    ok('z produkcyjnymi pluginami (SkyAuth-Velocity, IPblocker): bramka odrzuca mimo SkyAuth, a odrzucony gracz bez launchera nie zajął adresu (pierwszy był gracz z launchera)');
    p.stop();
    await p.exited;
    await sleep(700);
    try { rmDir(p.dir); } catch { /* jw. */ }
  }

  api.kill();
  try { rmDir(dataDir); } catch { /* jw. */ }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  console.error(String(e.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
