// Weryfikacja wydania 0.1.21 (klucz = jeden komputer, panel, komunikat 401): serwer https://launcher.locken.pl
// (VPS „anarchia”), stan GitHuba po sprzątaniu (tylko ogłoszenie + „aktualizacja-komunikat” v0.1.99) i zawartość paczki.
// Klucz JEDNORAZOWY do weryfikacji z env CROWN_INVITE_KEY (nie klucz właściciela - zwiąże się z komputerem testowym).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const UA = { 'User-Agent': 'crown-verify', Accept: 'application/vnd.github+json' };
const V = '0.1.21';
const REPO = 'l0cken/crownlauncher';
const HOST = 'https://launcher.locken.pl';
const KEY = process.env.CROWN_INVITE_KEY || '';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const getJson = async (url) => (await fetch(url, { headers: UA })).json();
const inv = KEY ? { 'X-Crown-Invite': KEY, 'X-Crown-Device': 'weryfikacja-wydania-0121-komputer-1' } : {};
const parseYml = (yml) => ({
  version: /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  url: /^\s*-?\s*url:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  sha: /^\s*sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  size: Number(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1]),
});

(async () => {
  const exeName = `CrownLauncher-Setup-${V}.exe`;
  const local = path.join(root, 'release', exeName);

  // 1. GitHub: po sprzątaniu nie ma tam launchera - tylko ogłoszenie dla starych wersji i malutka „aktualizacja-komunikat”
  const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
  check('GitHub: jedyne wydanie to v0.1.99 (komunikat dla starych launcherów, nie launcher)', Array.isArray(releases) && releases.length === 1 && releases[0].tag_name === 'v0.1.99', releases.map((r) => r.tag_name).join(', '));
  const stub = releases[0];
  const stubAsset = (stub?.assets || []).find((x) => x.name.endsWith('.exe'));
  check('GitHub: instalator-komunikat jest mały (to nie launcher)', stubAsset && stubAsset.size < 200 * 1024, `${stubAsset?.size} B`);
  const files = await getJson(`https://api.github.com/repos/${REPO}/contents`);
  check('GitHub: w repozytorium zostaje tylko announcements.json', Array.isArray(files) && files.length === 1 && files[0].name === 'announcements.json', files.map?.((f) => f.name).join(', '));
  const notice = JSON.parse(await (await fetch(`https://api.github.com/repos/${REPO}/contents/announcements.json`, { headers: { ...UA, Accept: 'application/vnd.github.raw+json' } })).text());
  check('GitHub: przypięte ogłoszenie „Ten launcher jest przestarzały” z linkiem do launcher.locken.pl', notice.announcements?.length === 1 && notice.announcements[0].pinned && notice.announcements[0].link === 'https://launcher.locken.pl');
  // dane „własnego” latest.yml (lokalne, to samo trafia na VPS)
  const myYml = parseYml(fs.readFileSync(path.join(root, 'release', 'latest.yml'), 'utf8'));

  // 2. plik lokalny = opublikowany
  const buf = fs.readFileSync(local);
  const localSha = crypto.createHash('sha512').update(buf).digest('base64');
  check(`lokalny instalator ${V}: wersja w latest.yml, SHA-512 i rozmiar zgodne`, myYml.version === V && localSha === myYml.sha && buf.length === myYml.size, `${buf.length} B`);

  // 3. VPS: bramka zaproszeń
  const noKey = await Promise.all(['/updates/latest.yml', `/updates/${exeName}`, '/v1/announcements', '/blocklist.json'].map((p) => fetch(HOST + p).then((r) => r.status)));
  check('VPS bez klucza: latest.yml, instalator, ogłoszenia, lista blokad → 401', noKey.every((s) => s === 401), noKey.join(','));
  const page = await fetch(HOST + '/');
  const pageText = await page.text();
  check('VPS: strona pobierania (formularz) dostępna, certyfikat HTTPS poprawny', page.status === 200 && /<form method="post" action="\/download"/.test(pageText));
  const badPost = await fetch(HOST + '/download', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=CROWN-AAAA-AAAA-AAAA-AAAA' });
  check('VPS: pobranie ze złym kluczem → 401', badPost.status === 401, `HTTP ${badPost.status}`);

  if (KEY) {
    const vYmlRes = await fetch(`${HOST}/updates/latest.yml`, { headers: inv });
    const vYml = parseYml(await vYmlRes.text());
    check(`VPS z kluczem: latest.yml = ${V}, ten sam instalator (SHA-512 i rozmiar jak lokalnie)`, vYmlRes.status === 200 && vYml.version === V && vYml.sha === myYml.sha && vYml.size === myYml.size);
    const h = await fetch(`${HOST}/updates/${exeName}`, { method: 'HEAD', headers: inv });
    check('VPS z kluczem: instalator odpowiada, rozmiar zgodny', h.status === 200 && Number(h.headers.get('content-length')) === myYml.size, `HTTP ${h.status}, ${h.headers.get('content-length')} B`);
    const mapRes = await fetch(`${HOST}/updates/${exeName}.blockmap`, { headers: inv });
    const mapSize = (await mapRes.arrayBuffer()).byteLength;
    const ghMapSize = fs.statSync(path.join(root, 'release', `${exeName}.blockmap`)).size;
    check('VPS z kluczem: .blockmap dostępny i identyczny z lokalnym (pobieranie różnicowe)', mapRes.status === 200 && mapSize === ghMapSize, `${mapSize} B`);
    const dl = await fetch(HOST + '/download', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(KEY)}` });
    const disp = dl.headers.get('content-disposition') || '';
    const len = Number(dl.headers.get('content-length'));
    await dl.body?.cancel();
    check('VPS: pobranie ze strony z kluczem oddaje najnowszy instalator (załącznik)', dl.status === 200 && disp.includes(exeName) && len === myYml.size, `${disp}, ${len} B`);
  } else {
    console.log('--   pominięto sprawdzenia „z kluczem” (brak CROWN_INVITE_KEY)');
  }
  // SHA-512 pliku na dysku VPS (bez pobierania 113 MB)
  const remoteSha = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'anarchia', `openssl dgst -sha512 -binary /opt/crownlauncher/data/updates/${exeName} | base64 -w0`], { encoding: 'utf8' }).trim();
  check('VPS (dysk): SHA-512 instalatora = latest.yml', remoteSha === myYml.sha);
  const svc = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'anarchia', 'systemctl is-active crownlauncher caddy mc-anarchia'], { encoding: 'utf8' }).trim().split(/\s+/);
  check('VPS: usługi crownlauncher, caddy i mc-anarchia (serwer Minecrafta) aktywne', svc.length === 3 && svc.every((s) => s === 'active'), svc.join(','));

  // 4. zawartość paczki
  const asarFile = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  check('app.asar zbudowany w tym samym przebiegu co instalator (±15 min)', Math.abs(fs.statSync(asarFile).mtimeMs - fs.statSync(local).mtimeMs) < 15 * 60_000);
  const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => list.includes('/' + p);
  const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
  check(`paczka: package.json = ${V}`, JSON.parse(read('package.json')).version === V);
  const appCfg = read('src/main/core/app-config.js');
  check('app-config w paczce: GITHUB_REPO puste, serwer https://launcher.locken.pl, INVITE_REQUIRED: true',
    /^\s*GITHUB_REPO: '',/m.test(appCfg) && /^\s*ANNOUNCEMENTS_URL: 'https:\/\/launcher\.locken\.pl',/m.test(appCfg) && /^\s*INVITE_REQUIRED: true,/m.test(appCfg));
  check('paczka: invite.js, ekran zaproszenia, token poza linią poleceń, brak X-Minecraft-Token',
    has('src/main/core/invite.js') && /inviteGate/.test(read('src/renderer/js/app.js')) && /splitSecretArgs/.test(read('src/main/core/launch.js')) && !/X-Minecraft-Token/i.test(read('src/main/core/capes.js')));
  const inviteSrc = read('src/main/core/invite.js');
  check('0.1.21: klucz wiązany z komputerem (X-Crown-Device, zaszyfrowany deviceId, obsługa 409 „użyty na innym komputerze”)',
    /X-Crown-Device/.test(inviteSrc) && /function deviceId/.test(inviteSrc) && /usedElsewhere/.test(inviteSrc) && /'deviceId'/.test(read('src/main/core/config.js')));
  const updSrc = read('src/main/updater.js');
  check('0.1.21: komunikat aktualizatora przy 401 sprawdzany przed „latest.yml” (poprawka mylącego komunikatu)',
    updSrc.search(/\\b401\\b\|Unauthorized/) > 0 && updSrc.search(/\\b401\\b\|Unauthorized/) < updSrc.search(/latest\\\.yml\|HttpError/));
  check('paczka nie zawiera serwera, skryptów wydania, plików z kluczami', !list.some((p) => /^\/server\/|^\/scripts\/|\.crownlauncher-|\.env|\.last-release|invites\.json|keys\.json|dev-tests/.test(p)));
  const SECRET_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|crown_[A-Za-z0-9_-]{40,}|CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
  const leaked = list.filter((p) => /\.(js|json|html|css|md|yml|txt)$/i.test(p)).filter((p) => SECRET_RE.test(read(p.slice(1)).replace(/CROWN-XXXX-XXXX-XXXX-XXXX/g, '')));
  check('w plikach paczki nie ma wzorców tokenów ani kluczy (admin, zaproszenia, GitHub, JWT)', leaked.length === 0, leaked.join(', '));
  const manifest = JSON.parse(read('assets/mods/manifest.json')).mods;
  check('manifest: 11 jarów CrownClient', manifest.length === 11 && manifest.every((m) => has('assets/mods/' + m.file)));

  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((r) => !r).length}`);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
