// Weryfikacja opublikowanego wydania 0.1.18: stan GitHuba (jedno wydanie „CrownLauncher”), pliki, sumy i zawartość
// paczki (app.asar z win-unpacked, zbudowanego w tym samym przebiegu electron-buildera).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const AdmZip = require(root + '/node_modules/adm-zip');
const UA = { 'User-Agent': 'crown-verify', Accept: 'application/vnd.github+json' };
const V = '0.1.18';
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
  check('opis wydania jest „pusty” (sam niewidoczny znak, bez komunikatu commita)', /^[\u200B\s]*$/.test(rel.body || ''), JSON.stringify(rel.body));
  const tags = await getJson(`https://api.github.com/repos/${REPO}/tags?per_page=100`);
  check('stare tagi usunięte (zostaje tylko v' + V + ')', Array.isArray(tags) && tags.length === 1 && tags[0].name === `v${V}`, tags.map((t) => t.name).join(', '));

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
  check(`latest.yml: wersja ${V} (> 0.1.17, więc launchery się zaktualizują)`, ver === V, `version=${ver}`);
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

  // --- awarie: analiza + automatyczna naprawa ---
  check('crash-analyzer.js i crash-fixer.js w paczce', has('src/main/core/crash-analyzer.js') && has('src/main/core/crash-fixer.js'));
  const analyzer = read('src/main/core/crash-analyzer.js');
  check('analizator zwraca rodzaj problemu (kind/dep/other)', /kinds: \[\.\.\.s\.kinds\]/.test(analyzer) && /dependency-version/.test(analyzer));
  const fixer = read('src/main/core/crash-fixer.js');
  check('naprawa: doinstaluj / zaktualizuj / wyłącz, ochrona renderera i loadera', /installDependency/.test(fixer) && /updateFile/.test(fixer) && /async function disable/.test(fixer) && /'vulkanmod'/.test(fixer) && /'fabric-api'/.test(fixer));
  const game = read('src/main/core/game.js');
  check('game.js: naprawa po awarii za przełącznikiem autoFixCrashes, zdarzenie game:crash z fixed', /crashFixer\.fix/.test(game) && /autoFixCrashes/.test(game) && /game:crash'.*fixed/.test(game));
  check('config: autoFixCrashes domyślnie włączone', /autoFixCrashes: true/.test(read('src/main/core/config.js')));
  check('ustawienia: przełącznik „Naprawiaj awarie automatycznie”', /Naprawiaj awarie automatycznie/.test(read('src/renderer/js/pages/settings.js')));
  const report = read('src/renderer/js/crash-report.js');
  check('okno awarii: „Cofnij”, „Uruchom ponownie”, „Naprawiłem awarię gry”', /Cofnij/.test(report) && /Uruchom ponownie/.test(report) && /Naprawiłem awarię gry/.test(report));
  check('app.js: onRetry uruchamia grę ponownie', /onRetry/.test(read('src/renderer/js/app.js')));

  // --- konsola ---
  check('kolorowa konsola: log-format.js + klasy poziomów w styles.css', has('src/renderer/js/log-format.js') && /\.console \.ln\.lv-ERROR/.test(read('src/renderer/styles.css')) && /\.console \.ln\.lv-WARN/.test(read('src/renderer/styles.css')) && /export \{ parseLogLine, rowClass \}/.test(read('src/renderer/js/log-format.js')));

  // --- błąd EBUSY i gra uruchomiona ---
  const ipc = read('src/main/ipc.js');
  check('ipc: ensureGameClosed dla toggle/delete/update modów, friendlyFsError w handle', /ensureGameClosed\(id, 'włączysz lub wyłączysz mod'\)/.test(ipc) && /ensureGameClosed\(id, 'usuniesz mod'\)/.test(ipc) && /friendlyFsError\(e\)/.test(ipc));
  check('util: friendlyFsError (EBUSY po polsku)', /function friendlyFsError/.test(read('src/main/core/util.js')) && /Zamknij grę i spróbuj ponownie/.test(read('src/main/core/util.js')));

  // --- wpisy-duchy i „Aktualizuj wszystko” ---
  const mr = read('src/main/core/modrinth.js');
  check('modrinth: pruneGhosts w identifyInstance, „już zainstalowane” tylko gdy plik jest na dysku', /async function pruneGhosts/.test(mr) && /await pruneGhosts\(instanceId\)/.test(mr) && /exists\(path\.join\(folder, entry\[0\]\)\)/.test(mr));
  check('modrinth: updateMod nie raportuje sukcesu, gdy nic nie pobrano', /if \(res\.already\) return \{ updated: false/.test(mr) && /if \(r\.updated\) updated\.push/.test(mr));

  // --- neutralne opisy commitów ---
  const ann = read('src/main/core/announcements.js');
  const capesjs = read('src/main/core/capes.js');
  check("commity launchera mają opis „CrownLauncher” (bez nicków i tytułów)", /COMMIT_MESSAGE = 'CrownLauncher'/.test(ann) && /message: announcements\.COMMIT_MESSAGE/.test(capesjs) && !/Peleryna dla|Usunięto pelerynę|Ogłoszenie: \$\{/.test(ann + capesjs));

  // --- jary CrownClient i brak skinów ---
  const manifest = JSON.parse(read('assets/mods/manifest.json')).mods;
  const files = manifest.map((m) => m.file);
  check('manifest: 11 jarów CrownClient', manifest.length === 11 && files.every((f) => has('assets/mods/' + f)), `${manifest.length}`);
  let jarBad = [];
  for (const m of manifest) {
    const zip = new AdmZip(asar.extractFile(asarFile, path.join('assets', 'mods', m.file)));
    const n = new Set(zip.getEntries().map((e) => e.entryName));
    if (n.has('pl/meabx/crownclient/sync/SkinSync.class')) jarBad.push(`${m.file}: SkinSync`);
    if (!n.has('pl/meabx/crownclient/mixin/EntityRendererMixin.class') || !n.has('pl/meabx/crownclient/mixin/PlayerTabOverlayMixin.class')) jarBad.push(`${m.file}: brak miksynów`);
  }
  check('jary: miksyny korony są, SkinSync nie ma', jarBad.length === 0, jarBad.join(' | '));
  check('capes.js: tylko peleryny (bez wstrzykiwania skinów)', /name: 'GameProfile', type: 'GameProfile'/.test(capesjs) && !/CrownSkins|skinSyncArgs|assignSkin/.test(capesjs));
  check('tylko Fabric (LOADERS = [\'fabric\'])', /const LOADERS = \['fabric'\]/.test(read('src/main/core/loaders.js')));

  // --- pakiet modów / aktualizacje / 429 (z wcześniejszych wersji nadal są) ---
  check('pakiet modów v3 + VulkanMod poniżej 26.2', /PROFILE_VERSION = 3/.test(read('src/main/core/performance-mods.js')) && /VULKAN_FAMILY/.test(read('src/main/core/performance-mods.js')));
  check('fetchRetry z Retry-After (429)', /Retry-After/i.test(read('src/main/core/util.js')));
  check('paczka nie zawiera tokenów, serwera ani znacznika wydań', !list.some((p) => /\.crownlauncher-gh-token|server\/server\.js|\.env|\.last-release/.test(p)));

  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((r) => !r).length}`);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
