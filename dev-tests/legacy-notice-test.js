// „Aktualizacja” dla starych launcherów (scripts/legacy-notice): prawdziwy electron-updater (provider GitHub, tak jak w
// launcherach <= 0.1.19) na lokalnej atrapie GitHuba. Sprawdza, że stary launcher widzi nowszą wersję, pobiera
// instalator z poprawną sumą SHA-512 i uruchamia go po cichu (/S --updated --force-run) - czyli że komunikat dojdzie.
// Wersja testowa instalatora zamiast okna zapisuje wiersz poleceń do pliku. Uruchomienie: node dev-tests/legacy-notice-test.js
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const root = path.join(__dirname, '..') + path.sep;
const electronExe = require(root + 'node_modules/electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

function findMakensis() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base).filter((x) => /^nsis-\d/.test(x))) {
    for (const sub of fs.readdirSync(path.join(base, d))) {
      const exe = path.join(base, d, sub, 'makensis.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

(async () => {
  const makensis = findMakensis();
  if (!makensis) {
    console.log('--  pominięto: brak makensis.exe w cache electron-buildera (zbuduj launcher raz, żeby go pobrał)');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-notice-'));
  const marker = path.join(work, 'uruchomiono.txt');
  const exe = path.join(work, 'CrownLauncher-Setup-0.1.99.exe');
  const build = spawnSync(makensis, ['-V1', `-DOUT=${exe}`, `-DTEST_FILE=${marker}`, path.join(root, 'scripts', 'legacy-notice', 'notice.nsi')], { encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stdout + build.stderr);
  const body = fs.readFileSync(exe);
  const sha = crypto.createHash('sha512').update(body).digest('base64');
  ok(`instalator-komunikat zbudowany (${(body.length / 1024).toFixed(0)} KB, nie jest launcherem)`);

  // ---- atrapa GitHuba ----
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const hits = [];
  const yml = `version: 0.1.99\nfiles:\n  - url: CrownLauncher-Setup-0.1.99.exe\n    sha512: ${sha}\n    size: ${body.length}\npath: CrownLauncher-Setup-0.1.99.exe\nsha512: ${sha}\nreleaseDate: '2026-10-13T00:00:00.000Z'\n`;
  const atom = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">\n  <id>tag:github.com,2008:https://github.com/l0cken/crownlauncher/releases</id>\n  <title>Release notes from crownlauncher</title>\n  <updated>2026-10-13T00:00:00Z</updated>\n  <entry>\n    <id>tag:github.com,2008:Repository/1/v0.1.99</id>\n    <updated>2026-10-13T00:00:00Z</updated>\n    <link rel="alternate" type="text/html" href="http://${host}/l0cken/crownlauncher/releases/tag/v0.1.99"/>\n    <title>CrownLauncher</title>\n    <content type="html"></content>\n  </entry>\n</feed>\n`;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(p);
    const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) }); res.end(data); };
    if (p === '/l0cken/crownlauncher/releases.atom') return send(200, 'application/atom+xml', atom);
    if (p === '/l0cken/crownlauncher/releases/latest' || p === '/api/v3/repos/l0cken/crownlauncher/releases/latest') return send(200, 'application/json', JSON.stringify({ tag_name: 'v0.1.99' }));
    if (p === '/l0cken/crownlauncher/releases/download/v0.1.99/latest.yml') return send(200, 'text/yaml', yml);
    if (p === '/l0cken/crownlauncher/releases/download/v0.1.99/CrownLauncher-Setup-0.1.99.exe') return send(200, 'application/octet-stream', body);
    return send(404, 'text/plain', 'not found');
  }).listen(port, '127.0.0.1');

  // ---- „stary launcher”: Electron 0.1.19 z electron-updater (GitHub) ----
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-oldapp-'));
  const logFile = path.join(work, 'updater.log');
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'crown-oldlauncher-test', version: '0.1.19', main: 'main.js' }));
  // w zainstalowanym launcherze to app-update.yml (zapisany przez electron-buildera); poza pakietem aktualizator czyta ten plik
  fs.writeFileSync(path.join(appDir, 'dev-app-update.yml'), `provider: github\nowner: l0cken\nrepo: crownlauncher\nhost: ${host}\nprotocol: http\nreleaseType: release\n`);
  fs.writeFileSync(path.join(appDir, 'main.js'), `
const { app } = require('electron');
const { autoUpdater } = require(${JSON.stringify(root + 'node_modules/electron-updater')});
const fs = require('fs');
const log = (m) => fs.appendFileSync(${JSON.stringify(logFile)}, m + '\\n');
app.whenReady().then(async () => {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (i) => log('available ' + i.version));
  autoUpdater.on('update-not-available', () => log('none'));
  autoUpdater.on('update-downloaded', (i) => { log('downloaded ' + i.version); setTimeout(() => autoUpdater.quitAndInstall(true, true), 300); });
  autoUpdater.on('error', (e) => log('error ' + String(e.message).split('\\n')[0]));
  autoUpdater.setFeedURL({ provider: 'github', owner: 'l0cken', repo: 'crownlauncher', host: ${JSON.stringify(host)}, protocol: 'http', releaseType: 'release' });
  try {
    await autoUpdater.checkForUpdates();
    await autoUpdater.downloadUpdate();
  } catch (e) {
    log('exception ' + String(e.message).split('\\n')[0]);
    app.quit();
  }
});
`);
  const proc = spawn(electronExe, [appDir, `--user-data-dir=${path.join(appDir, 'ud')}`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 160 && !fs.existsSync(marker); i++) await sleep(250);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert.ok(fs.existsSync(marker), `instalator nie został uruchomiony. Dziennik aktualizatora:\n${log}\nżądania: ${hits.join(', ')}`);
    assert.match(log, /available 0\.1\.99/);
    assert.match(log, /downloaded 0\.1\.99/);
    ok('stary launcher (0.1.19, provider GitHub): widzi wersję 0.1.99 jako nowszą, pobiera instalator i weryfikuje SHA-512');
    const cmd = fs.readFileSync(marker, 'utf8');
    assert.match(cmd, /\/S/);
    assert.match(cmd, /--updated/);
    assert.match(cmd, /--force-run/);
    ok(`instalator uruchomiony po cichu tak, jak robi to launcher przy aktualizacji (${cmd.trim().slice(-48)})`);
    assert.ok(hits.includes('/l0cken/crownlauncher/releases.atom') && hits.some((h) => h.endsWith('/latest.yml')));
  } finally {
    proc.kill();
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    server.close();
    await sleep(500);
    for (const d of [work, appDir, path.join(process.env.LOCALAPPDATA || '', 'crown-oldlauncher-test-updater')]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* zajęty */ }
    }
  }
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
