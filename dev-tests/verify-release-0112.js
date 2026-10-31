const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const root = 'C:/Users/meabx/Desktop/CrownLauncher';
const asar = require(root + '/node_modules/@electron/asar');
const AdmZip = require(root + '/node_modules/adm-zip');
const UA = { 'User-Agent': 'crown-verify', Accept: 'application/vnd.github+json' };
const V = '0.1.12';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  // 1. wydanie na GitHubie
  const rel = await (await fetch('https://api.github.com/repos/l0cken/crownlauncher/releases/latest', { headers: UA })).json();
  check(`najnowsze wydanie to v${V}`, rel.tag_name === `v${V}`, `tag=${rel.tag_name} draft=${rel.draft} prerelease=${rel.prerelease}`);
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
  check(`latest.yml: wersja ${V} (> 0.1.11, więc launchery się zaktualizują)`, ver === V, `version=${ver}`);
  check(`latest.yml wskazuje na instalator ${V}`, url === exeName, `url=${url}`);
  check('rozmiar w latest.yml = rozmiar pliku na GitHubie', exeAsset && size === exeAsset.size, `${size} vs ${exeAsset?.size}`);

  // 3. plik lokalny = opublikowany
  const local = path.join(root, 'release', exeName);
  if (fs.existsSync(local)) {
    const buf = fs.readFileSync(local);
    check('SHA-512 lokalnego instalatora = latest.yml (opublikowany plik to ten zbudowany)', crypto.createHash('sha512').update(buf).digest('base64') === sha);
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
  const list = asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => list.includes('/' + p);
  const read = (p) => asar.extractFile(asarFile, p.replace(/\//g, '\\')).toString('utf8');
  check(`paczka: package.json = ${V}`, JSON.parse(read('package.json')).version === V);

  // --- tylko Fabric ---
  const ld = read('src/main/core/loaders.js');
  check("loadery: tylko Fabric (LOADERS = ['fabric'])", ld.includes("const LOADERS = ['fabric']") && !/neoforged|minecraftforge|quiltmc/i.test(ld));
  check('UI: lista loaderów tylko Fabric', !/vanilla|quilt|neoforge|'forge'/i.test(read('src/renderer/js/state.js')));
  const inst = read('src/main/core/instances.js');
  check('dawne instancje Vanilla przechodzą na Fabric (useFabric, migrateVanilla)', /async function useFabric/.test(inst) && /function migrateVanilla/.test(inst));
  check('start gry: dawna Vanilla -> Fabric (currentInstance)', /currentInstance/.test(read('src/main/core/game.js')));
  check('lista instancji uruchamia migrację', /migrateVanilla/.test(read('src/main/ipc.js')));
  check('okno nowej instancji bez opcji Vanilla', !/'vanilla'/.test(read('src/renderer/js/components.js').replace(/inst\.loader === 'vanilla'/g, '')));

  // --- skiny: nic nie jest wstrzykiwane ---
  const capesjs = read('src/main/core/capes.js');
  check('capes.js: konfiguracja tylko pod peleryny (GameProfile)', /name: 'GameProfile', type: 'GameProfile'/.test(capesjs) && !/CrownSkins|skinSyncArgs|assignSkin|skinModelOf|selectSkin/.test(capesjs));
  check('app-config bez SKIN_SYNC, z CAPES_URL', !/SKIN_SYNC/.test(read('src/main/core/app-config.js')) && /CAPES_URL/.test(read('src/main/core/app-config.js')));
  check('ustawienia: „Peleryny i korona w grze”, bez „Skin dla wszystkich graczy serwera”', /Peleryny i korona w grze/.test(read('src/renderer/js/pages/settings.js')) && !/Skin dla wszystkich graczy serwera/.test(read('src/renderer/js/pages/settings.js')));
  check('strona Skiny: bez „Użyj w grze” dla skinów i bez „Skiny graczy”', !/openStaffSkins|skins:use|skins:assign|Skiny graczy/.test(read('src/renderer/js/pages/skins.js')));
  const skinsMain = read('src/main/core/skins.js');
  check('odczyt oficjalnego skina i modelu + wykrywanie zmian', /async function accountProfile/.test(skinsMain) && /function trackChange/.test(skinsMain) && /premiumByNick/.test(skinsMain) && /function defaultModel/.test(skinsMain));
  check('obserwator skina w interfejsie (skin-watch.js) i avatar z oficjalnego skina', has('src/renderer/js/skin-watch.js') && /headFor/.test(read('src/renderer/js/components.js')));
  check('import peleryn: dopasowanie formatu + dorysowanie elytr (cape-import.js)', has('src/renderer/js/cape-import.js') && /addElytra/.test(read('src/renderer/js/cape-import.js')) && /detectCapeLayout/.test(read('src/renderer/js/cape-import.js')));

  // --- elytry ---
  const art = read('src/main/core/cape-art.js');
  check('wbudowane peleryny: skrzydła elytr w kształcie z gry (maska WING)', /const WING = \[/.test(art) && /WING_X = 36/.test(art) && !/y % 16/.test(art));

  // --- tryb serwera peleryn ---
  check('klient serwera peleryn (publishCape, announcePresence, serverBase)', /async function publishCape/.test(capesjs) && /async function announcePresence/.test(capesjs) && /function serverBase/.test(capesjs));
  check('lista korony z serwera albo GitHuba (badgeListUrl w launch.js)', /badgeListUrl/.test(read('src/main/core/launch.js')));

  // --- jary CrownClient ---
  const manifest = JSON.parse(read('assets/mods/manifest.json')).mods;
  const expected = ['1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11', '26.1-26.1.2', '26.2', '26.3'];
  const files = manifest.map((m) => m.file);
  check('manifest: 11 jarów CrownClient 1.0.0 (1.21.4 … 26.3)', manifest.length === 11 && manifest.every((m) => m.id === 'crownclient' && String(m.version).startsWith('1.0.0')), manifest.map((m) => m.version).join(', '));
  check('jary: każda obsługiwana wersja ma plik w paczce', expected.every((v) => files.some((f) => f.includes(`+${v}.jar`))) && files.every((f) => has('assets/mods/' + f)));
  let jarBad = [];
  for (const m of manifest) {
    const zip = new AdmZip(asar.extractFile(asarFile, path.join('assets', 'mods', m.file)));
    const names = new Set(zip.getEntries().map((e) => e.entryName));
    const mix = zip.getEntry('crownclient.mixins.json')?.getData().toString('utf8') || '';
    const font = zip.getEntry('assets/crownclient/font/crown.json')?.getData().toString('utf8') || '';
    const problems = [];
    if (names.has('pl/meabx/crownclient/sync/SkinSync.class')) problems.push('SkinSync');
    if (names.has('pl/meabx/crownclient/mixin/ClientPacketListenerMixin.class') || /ClientPacketListenerMixin/.test(mix)) problems.push('ClientPacketListenerMixin');
    if (!['EntityRendererMixin', 'PlayerTabOverlayMixin'].every((x) => names.has(`pl/meabx/crownclient/mixin/${x}.class`) && mix.includes(x))) problems.push('brak miksynów korony');
    if (!/"type":\s*"space"/.test(font)) problems.push('brak wąskiego odstępu w czcionce');
    if (!names.has('assets/crownclient/textures/font/crown.png')) problems.push('brak tekstury korony');
    if (problems.length) jarBad.push(`${m.file}: ${problems.join(', ')}`);
  }
  check('każdy jar: miksyny korony, wąski odstęp w czcionce, bez SkinSync/ClientPacketListener', jarBad.length === 0, jarBad.join(' | '));
  const j4 = new AdmZip(asar.extractFile(asarFile, path.join('assets', 'mods', files.find((f) => f.includes('+1.21.4.jar')))));
  const fmj = JSON.parse(j4.getEntry('fabric.mod.json').getData().toString('utf8'));
  check('jar 1.21.4: fabric.mod.json wymaga Minecrafta 1.21.4', fmj.depends?.minecraft === '1.21.4', JSON.stringify(fmj.depends));

  // --- nic z poprzednich wersji nie zniknęło ---
  check('aktualizator, F5, anticheat, przypięty serwer nadal są', /autoDownload = false/.test(read('src/main/updater.js')) && /before-input-event/.test(read('src/main/main.js')) && has('src/main/core/anticheat.js') && has('src/main/core/pinned-servers.js'));
  check('logowanie Microsoft bez Azure i przełącznik kont nadal są', /00000000402b5328/.test(read('src/main/core/auth.js')) && /openAccountSwitcher/.test(read('src/renderer/js/app.js')));
  const cfg = read('src/main/core/app-config.js');
  check('app-config: GITHUB_REPO, Discord, KORONAMC.PL, CrownClient', /GITHUB_REPO:\s*'l0cken\/crownlauncher'/.test(cfg) && /DISCORD_CLIENT_ID:\s*'\s*\d{15,25}\s*'/.test(cfg) && /KORONAMC\.PL/.test(cfg) && /CLIENT_NAME:\s*'CrownClient'/.test(cfg));
  check('paczka nie zawiera tokenów ani plików serwera', !list.some((p) => /\.crownlauncher-gh-token|server\/server\.js|\.env/.test(p)));

  console.log(results.every(Boolean) ? '\nWSZYSTKO OK' : `\nNIEPOWODZENIA: ${results.filter((r) => !r).length}`);
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
