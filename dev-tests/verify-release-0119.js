// Weryfikacja opublikowanego wydania 0.1.19: stan GitHuba (jedno wydanie „CrownLauncher”), pliki, sumy i zawartość
// paczki (app.asar z win-unpacked, zbudowanego w tym samym przebiegu electron-buildera) - w tym poprawki
// bezpieczeństwa tokenów i prywatna dystrybucja (wyłączona domyślnie).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const UA = { 'User-Agent': 'crown-verify', Accept: 'application/vnd.github+json' };
const V = '0.1.19';
const PREV = '0.1.18';
const REPO = 'l0cken/crownlauncher';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const getJson = async (url) => (await fetch(url, { headers: UA })).json();

(async () => {
  // 1. stan GitHuba
  const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
  check('w repozytorium jest dokładnie jedno wydanie', Array.isArray(releases) && releases.length === 1, `liczba: ${releases.length}`);
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  check(`najnowsze wydanie to v${V}, opublikowane (nie wersja robocza)`, rel.tag_name === `v${V}` && !rel.draft && !rel.prerelease, `tag=${rel.tag_name} draft=${rel.draft}`);
  check('nazwa wydania to „CrownLauncher” (bez numeru)', rel.name === 'CrownLauncher', JSON.stringify(rel.name));
  check('opis wydania jest „pusty” (sam niewidoczny znak)', /^[\u200B\s]*$/.test(rel.body || ''), JSON.stringify(rel.body));
  const tags = await getJson(`https://api.github.com/repos/${REPO}/tags?per_page=100`);
  check(`stare tagi usunięte (zostaje tylko v${V})`, Array.isArray(tags) && tags.length === 1 && tags[0].name === `v${V}`, tags.map((t) => t.name).join(', '));

  const names = (rel.assets || []).map((a) => a.name);
  const exeName = `CrownLauncher-Setup-${V}.exe`;
  check('pliki wydania: exe, blockmap, latest.yml', [exeName, exeName + '.blockmap', 'latest.yml'].every((n) => names.includes(n)), names.join(', '));
  const exeAsset = (rel.assets || []).find((a) => a.name === exeName);
  check('wszystkie pliki w stanie "uploaded"', (rel.assets || []).every((a) => a.state === 'uploaded'));

  // 2. latest.yml
  const ymlAsset = (rel.assets || []).find((a) => a.name === 'latest.yml');
  const yml = await (await fetch(ymlAsset.browser_download_url, { headers: { 'User-Agent': 'crown-verify' } })).text();
  const ver = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const url = /^\s*-?\s*url:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const sha = /^\s*sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const size = Number(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1]);
  check(`latest.yml: wersja ${V} (> ${PREV}, więc launchery się zaktualizują)`, ver === V, `version=${ver}`);
  check(`latest.yml wskazuje na instalator ${V}`, url === exeName, `url=${url}`);
  check('rozmiar w latest.yml = rozmiar pliku na GitHubie', exeAsset && size === exeAsset.size, `${size} vs ${exeAsset?.size}`);

  // 3. plik lokalny = opublikowany
  const local = path.join(root, 'release', exeName);
  if (fs.existsSync(local)) {
    const buf = fs.readFileSync(local);
    check('SHA-512 lokalnego instalatora = latest.yml', crypto.createHash('sha512').update(buf).digest('base64') === sha);
    check('rozmiar lokalny = opublikowany', buf.length === exeAsset?.size, `${buf.length}`);
  } else {
    check('lokalny instalator istnieje', false, local);
  }

  // 4. adres pobierania
  const head = await fetch(exeAsset.browser_download_url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'crown-verify' } });
  check('adres pobierania instalatora odpowiada 200', head.status === 200, `HTTP ${head.status}, ${head.headers.get('content-length')} B`);
  const lastAsset = Math.max(...rel.assets.map((a) => Date.parse(a.updated_at)));
  check('wydanie opublikowane po wgraniu wszystkich plików (bez okna z 404)', Date.parse(rel.published_at) >= lastAsset - 1500, `published=${rel.published_at}`);

  // 5. zawartość paczki
  const asarFile = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  const asarStat = fs.statSync(asarFile);
  check('app.asar zbudowany w tym samym przebiegu co instalator (±15 min)', Math.abs(asarStat.mtimeMs - fs.statSync(local).mtimeMs) < 15 * 60_000, new Date(asarStat.mtimeMs).toISOString());
  const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => list.includes('/' + p);
  const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
  check(`paczka: package.json = ${V}`, JSON.parse(read('package.json')).version === V);

  // --- tokeny i sekrety (0.1.19) ---
  const auth = read('src/main/core/auth.js');
  check('auth: seal w Electronie bez DPAPI rzuca błąd (nie zapisuje jawnie), migrateSecrets', /nie zapisuję tokenu jawnym tekstem/.test(auth) && /function migrateSecrets/.test(auth));
  const capesjs = read('src/main/core/capes.js');
  check('peleryny: token Minecrafta nie idzie na serwer (brak X-Minecraft-Token), dowód przez sessionserver Mojanga', !/X-Minecraft-Token/i.test(capesjs) && /sessionserver\.mojang\.com\/session\/minecraft\/join/.test(capesjs) && /X-Crown-Server-Id/.test(capesjs));
  check('peleryny: serverId losuje launcher (randomBytes), sekrety nicków zapisane przez seal', /randomBytes\(20\)\.toString\('hex'\)/.test(capesjs) && /auth\.seal\(secret\)/.test(capesjs));
  const ann = read('src/main/core/announcements.js');
  check('ogłoszenia: klucz publikowania wiązany ze źródłem (keyUsable, publisherSource)', /function keyUsable/.test(ann) && /publisherSource: sourceId\(src\)/.test(ann) && /keyUsable\(cfg\) \? unseal/.test(ann));
  const cfgjs = read('src/main/core/config.js');
  check('config: publicView odcina konta, klucz publikowania, sekrety nicków i klucz zaproszenia', /PRIVATE_KEYS = \['accounts', 'publisherKey', 'publisherSource', 'capeSecrets', 'inviteKey', 'inviteOrigin'\]/.test(cfgjs) && /config\.publicView\(\)/.test(read('src/main/ipc.js')));
  const launch = read('src/main/core/launch.js');
  check('launch: token poza linią poleceń (@plik z klasą główną i --accessToken), sprzątanie, redakcja', /function splitSecretArgs/.test(launch) && /async function hideSecrets/.test(launch) && /scrubCrashFiles/.test(launch));
  const game = read('src/main/core/game.js');
  check('game: redakcja tokenu w logach, zamazanie hs_err po wyjściu, blokada startu bez zaproszenia', /redact\(text, secrets\)/.test(game) && /scrubCrashFiles\(command\.cwd, secrets, startedAt\)/.test(game) && /invite\.assertAllowed\(\)/.test(game));
  const ac = read('src/main/core/anticheat.js');
  check('anticheat: -XX:-UsePerfData, zakaz JMX/HeapDump, scrubEnv z sekretami', /'-XX:-UsePerfData'/.test(ac) && /com\\\.sun\\\.management/.test(ac) && /SECRET_ENV_RE/.test(ac));

  // --- prywatna dystrybucja: jest w paczce, ale wyłączona ---
  check('invite.js, strona/IPC/UI zaproszeń w paczce', has('src/main/core/invite.js') && /inviteGate/.test(read('src/renderer/js/app.js')) && /invite:status/.test(read('src/main/ipc.js')) && /function inviteCard/.test(read('src/renderer/js/pages/settings.js')));
  const appCfg = read('src/main/core/app-config.js');
  check('app-config: INVITE_REQUIRED: false (zaproszenia wyłączone), GITHUB_REPO nadal ustawione (kanał aktualizacji bez zmian)', /INVITE_REQUIRED: false/.test(appCfg) && /GITHUB_REPO: 'l0cken\/crownlauncher'/.test(appCfg));
  check('updater: klucz zaproszenia tylko do providera generic', /requestHeaders = source\.provider === 'generic' \? invite\.headersFor\(source\.url\) : null/.test(read('src/main/updater.js')));

  // --- wcześniejsze funkcje (smoke) ---
  check('crash-analyzer/crash-fixer, log-format, pakiet modów nadal w paczce', has('src/main/core/crash-analyzer.js') && has('src/main/core/crash-fixer.js') && has('src/renderer/js/log-format.js') && /PROFILE_VERSION = 3/.test(read('src/main/core/performance-mods.js')));
  const manifest = JSON.parse(read('assets/mods/manifest.json')).mods;
  check('manifest: 11 jarów CrownClient', manifest.length === 11 && manifest.every((m) => has('assets/mods/' + m.file)), `${manifest.length}`);
  check("commity launchera: opis „CrownLauncher”", /COMMIT_MESSAGE = 'CrownLauncher'/.test(ann));

  // --- w paczce nie ma sekretów ani rzeczy serwerowych ---
  check('paczka nie zawiera tokenów, serwera, skryptów wydania ani znacznika wydań', !list.some((p) => /\.crownlauncher-gh-token|^\/server\/|^\/scripts\/|\.env|\.last-release|invites\.json|keys\.json|blocklist\.json|dev-tests/.test(p)));
  const SECRET_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|crown_[A-Za-z0-9_-]{40,}|CROWN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
  // atrapa „CROWN-XXXX-XXXX-XXXX-XXXX” w polach formularza zaproszenia to nie klucz
  const PLACEHOLDER = /CROWN-XXXX-XXXX-XXXX-XXXX/g;
  const leaked = list
    .filter((p) => /\.(js|json|html|css|md|yml|txt)$/i.test(p))
    .filter((p) => SECRET_RE.test(read(p.slice(1)).replace(PLACEHOLDER, '')));
  check('w plikach tekstowych paczki nie ma wzorców tokenów (GitHub, JWT, klucze admin/zaproszeń)', leaked.length === 0, leaked.join(', '));

  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((r) => !r).length}`);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
