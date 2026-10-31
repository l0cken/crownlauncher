// Weryfikacja wydania 0.1.20 (prywatna dystrybucja): GitHub (wydanie przejściowe), serwer https://launcher.locken.pl
// (VPS „anarchia”: pliki, SHA-512, bramka zaproszeń, strona pobierania) i zawartość paczki.
// Klucz zaproszenia z env CROWN_INVITE_KEY (sprawdzenia „z kluczem”); SHA-512 pliku na VPS przez `ssh anarchia`.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const UA = { 'User-Agent': 'crown-verify', Accept: 'application/vnd.github+json' };
const V = '0.1.20';
const REPO = 'l0cken/crownlauncher';
const HOST = 'https://launcher.locken.pl';
const KEY = process.env.CROWN_INVITE_KEY || '';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const getJson = async (url) => (await fetch(url, { headers: UA })).json();
const inv = KEY ? { 'X-Crown-Invite': KEY } : {};
const parseYml = (yml) => ({
  version: /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  url: /^\s*-?\s*url:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  sha: /^\s*sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim(),
  size: Number(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1]),
});

(async () => {
  const exeName = `CrownLauncher-Setup-${V}.exe`;
  const local = path.join(root, 'release', exeName);

  // 1. GitHub: wydanie przejściowe (launchery 0.1.19 odpytują GitHuba)
  const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
  check('GitHub: dokładnie jedno wydanie (stare usunięte)', Array.isArray(releases) && releases.length === 1, `liczba: ${releases.length}`);
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  check(`GitHub: najnowsze to v${V}, opublikowane`, rel.tag_name === `v${V}` && !rel.draft && !rel.prerelease, `tag=${rel.tag_name}`);
  check('GitHub: nazwa „CrownLauncher”, pusty opis', rel.name === 'CrownLauncher' && /^[\u200B\s]*$/.test(rel.body || ''));
  const tags = await getJson(`https://api.github.com/repos/${REPO}/tags?per_page=100`);
  check(`GitHub: zostaje tylko tag v${V}`, Array.isArray(tags) && tags.length === 1 && tags[0].name === `v${V}`, tags.map((t) => t.name).join(', '));
  const names = (rel.assets || []).map((a) => a.name);
  check('GitHub: exe, blockmap, latest.yml w stanie „uploaded”', [exeName, exeName + '.blockmap', 'latest.yml'].every((n) => names.includes(n)) && rel.assets.every((a) => a.state === 'uploaded'), names.join(', '));
  const exeAsset = rel.assets.find((a) => a.name === exeName);
  const ghYml = parseYml(await (await fetch(rel.assets.find((a) => a.name === 'latest.yml').browser_download_url, { headers: { 'User-Agent': 'crown-verify' } })).text());
  check(`GitHub latest.yml: wersja ${V}, instalator ${exeName}, rozmiar zgodny`, ghYml.version === V && ghYml.url === exeName && ghYml.size === exeAsset?.size, `size=${ghYml.size}`);
  const head = await fetch(exeAsset.browser_download_url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'crown-verify' } });
  check('GitHub: adres pobierania instalatora 200', head.status === 200, `HTTP ${head.status}`);

  // 2. plik lokalny = opublikowany
  const buf = fs.readFileSync(local);
  const localSha = crypto.createHash('sha512').update(buf).digest('base64');
  check('lokalny instalator: SHA-512 i rozmiar = latest.yml (GitHub)', localSha === ghYml.sha && buf.length === ghYml.size, `${buf.length} B`);

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
    check(`VPS z kluczem: latest.yml = ${V}, ten sam instalator (SHA-512 i rozmiar jak na GitHubie)`, vYmlRes.status === 200 && vYml.version === V && vYml.sha === ghYml.sha && vYml.size === ghYml.size);
    const h = await fetch(`${HOST}/updates/${exeName}`, { method: 'HEAD', headers: inv });
    check('VPS z kluczem: instalator odpowiada, rozmiar zgodny', h.status === 200 && Number(h.headers.get('content-length')) === ghYml.size, `HTTP ${h.status}, ${h.headers.get('content-length')} B`);
    const mapRes = await fetch(`${HOST}/updates/${exeName}.blockmap`, { headers: inv });
    const mapSize = (await mapRes.arrayBuffer()).byteLength;
    const ghMapSize = rel.assets.find((a) => a.name === `${exeName}.blockmap`)?.size;
    check('VPS z kluczem: .blockmap dostępny i identyczny rozmiar jak na GitHubie (pobieranie różnicowe)', mapRes.status === 200 && mapSize === ghMapSize, `${mapSize} B`);
    const dl = await fetch(HOST + '/download', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(KEY)}` });
    const disp = dl.headers.get('content-disposition') || '';
    const len = Number(dl.headers.get('content-length'));
    await dl.body?.cancel();
    check('VPS: pobranie ze strony z kluczem oddaje najnowszy instalator (załącznik)', dl.status === 200 && disp.includes(exeName) && len === ghYml.size, `${disp}, ${len} B`);
  } else {
    console.log('--   pominięto sprawdzenia „z kluczem” (brak CROWN_INVITE_KEY)');
  }
  // SHA-512 pliku na dysku VPS (bez pobierania 113 MB)
  const remoteSha = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'anarchia', `openssl dgst -sha512 -binary /opt/crownlauncher/data/updates/${exeName} | base64 -w0`], { encoding: 'utf8' }).trim();
  check('VPS (dysk): SHA-512 instalatora = latest.yml', remoteSha === ghYml.sha);
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
