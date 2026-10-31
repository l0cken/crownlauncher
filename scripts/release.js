#!/usr/bin/env node
/**
 * Wydanie aktualizacji launchera.
 *
 *  Tryb GitHub (GITHUB_REPO w src/main/core/app-config.js):
 *      $env:GH_TOKEN = "github_pat_..."                 # token z uprawnieniem Contents: Read and write
 *                                                       # (albo zapisany raz na stałe - README, „Zapisanie tokena”)
 *      npm run release                                  # buduje i publikuje wydanie w GitHub Releases
 *
 *  Wersja rośnie sama: gdy aktualna wersja z package.json jest już wydana (albo została wydana tym skryptem
 *  poprzednio), skrypt podbija numer patch w package.json i package-lock.json - launcher aktualizuje się tylko
 *  do WYŻSZEJ wersji. Wydanie nazywa się po prostu „CrownLauncher” (bez numeru, bez opisu), a po publikacji
 *  starsze wydania i ich tagi są usuwane - w repozytorium zostaje jedno, najnowsze.
 *
 *  Wydanie przejściowe (z GitHuba na własny serwer): w app-config.js GITHUB_REPO puste, ANNOUNCEMENTS_URL = adres
 *  serwera, INVITE_REQUIRED = true; potem:  npm run release -- --github właściciel/repo
 *  (wgrywa na GitHuba launcher, który po aktualizacji sam przejdzie na serwer; po przejściu graczy usuń wydanie).
 *
 *  Tryb serwera (własny server/server.js):
 *      CROWN_ADMIN_KEY=crown_...  [CROWN_SERVER=https://...]  npm run release
 *      (buduje, wgrywa pliki na serwer; latest.yml na końcu)
 *
 *  Linux (AppImage, tylko tryb serwera): zbuduj na Linuksie/WSL/Docker/CI  `CROWN_OUT_DIR=release npm run dist:linux`,
 *      potem tu:  npm run release -- --linux --skip-build   (wgrywa AppImage i latest-linux.yml; wersja ta sama co w wydaniu Windows)
 *
 * Opcje:  --skip-build   użyj już zbudowanych plików (tylko tryb serwera)
 *         --linux        wydanie dla Linuksa zamiast Windows (patrz wyżej)
 *         --dir <katalog>   katalog wyjściowy (domyślnie release)
 *         --keep-version    nie podbijaj wersji automatycznie (tryb GitHub)
 *         --keep-old        nie usuwaj starszych wydań po publikacji (tryb GitHub)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const appConfig = require(path.join(root, 'src/main/core/app-config'));
const versions = require('./version-util');
// Build testowy (przyjmuje flagi zdalnego debugowania - patrz electron-builder.config.js) nie może trafić do graczy.
if (process.env.CROWN_DEBUG_BUILD) {
  console.error('CROWN_DEBUG_BUILD jest ustawione - to zmienna tylko do testów. Usuń ją i wydaj ponownie (inaczej launcher gracza przyjmowałby flagi zdalnego debugowania).');
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = path.resolve(root, option('--dir', 'release'));

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function build(extraArgs = []) {
  console.log('→ Buduję instalator…');
  const r = spawnSync('npx', ['electron-builder', '--config', 'electron-builder.config.js', '--win', 'nsis', ...extraArgs], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CROWN_OUT_DIR: outDir },
  });
  if (r.status !== 0) fail('Budowanie nie powiodło się.');
}

/** Linux (AppImage): electron-builder składa go tylko na Linuksie (też WSL, Docker, CI) - w Windowsie podpowiadamy, co zrobić. */
function buildLinux() {
  if (process.platform !== 'linux') {
    fail(
      'AppImage buduje się na Linuksie (WSL, Docker albo CI), nie w Windowsie. Tam uruchom:\n' +
        '    CROWN_OUT_DIR=release npm run dist:linux\n' +
        '  a potem tutaj, w folderze z gotowymi plikami (release/CrownLauncher-<wersja>.AppImage i latest-linux.yml):\n' +
        '    npm run release -- --linux --skip-build',
    );
  }
  console.log('→ Buduję AppImage…');
  const r = spawnSync('npx', ['electron-builder', '--config', 'electron-builder.config.js', '--linux', 'AppImage'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CROWN_OUT_DIR: outDir, CROWN_TARGET: 'linux' },
  });
  if (r.status !== 0) fail('Budowanie AppImage nie powiodło się.');
}

// ---- tryb GitHub ---------------------------------------------------------------------------

/**
 * Token zapisany raz na komputerze (patrz README: „Zapisanie tokena”). Plik jest szyfrowany DPAPI Windowsa -
 * da się go odczytać tylko na tym koncie użytkownika i tym komputerze - więc po restarcie nie trzeba go wpisywać
 * od nowa, a nie leży w repozytorium ani jako zwykły tekst.
 */
function storedSecret(fileName) {
  if (process.platform !== 'win32') return '';
  const file = path.join(process.env.USERPROFILE || require('os').homedir(), fileName);
  if (!fs.existsSync(file)) return '';
  const script =
    '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_TOKEN_FILE).Trim(); ' +
    '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, CROWN_TOKEN_FILE: file },
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

const storedToken = () => storedSecret('.crownlauncher-gh-token'); // token GitHub (tryb GitHub)
const storedAdminKey = () => storedSecret('.crownlauncher-admin-key'); // klucz admin własnego serwera (tryb serwera)

// --github <właściciel/repo>: wydanie przejściowe - launcher zbudowany z adresem własnego serwera (GITHUB_REPO puste),
// ale wgrane jeszcze na GitHuba, żeby zainstalowane wcześniej launchery (odpytują GitHuba) mogły się zaktualizować
const githubRepo = String(option('--github', '') || appConfig.GITHUB_REPO || '').trim();
if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
  const token = process.env.GH_TOKEN || process.env.CROWN_GITHUB_TOKEN || storedToken();
  if (!token) {
    fail(
      'Brak tokenu GitHub. Ustaw GH_TOKEN (fine-grained token z uprawnieniem Contents: Read and write do ' +
        githubRepo +
        ') albo zapisz go raz na stałe - patrz README, „Zapisanie tokena”.',
    );
  }
  // Nazwa i opis wydania: tylko „CrownLauncher”. Opis jest niewidocznym znakiem (U+200B) - przy pustym opisie
  // GitHub wyświetla w jego miejscu komunikat commita (np. „Peleryna dla …”), a tego nie chcemy pokazywać.
  const RELEASE_NAME = 'CrownLauncher';
  const RELEASE_BODY = '​';
  const { pkgFile, lastFile, compareVersions, nextPatch, readLastReleased, writeVersion } = versions;

  (async () => {
    const api = (p, init = {}) =>
      fetch(`${process.env.CROWN_GITHUB_API || 'https://api.github.com'}/repos/${githubRepo}${p}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CrownLauncher-release',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });

    // Wydanie tworzymy sami jednym żądaniem - electron-builder potrafi wpaść w wyścig
    // ("Published releases must have a valid tag"), gdy kilka zadań tworzy je naraz.
    const list = await api('/releases?per_page=100');
    if (list.status === 401) fail('GitHub odrzucił token (401). Wygeneruj nowy token.');
    if (list.status === 404) fail(`Brak dostępu do ${githubRepo} - token musi obejmować to repozytorium.`);
    if (!list.ok) fail(`GitHub zwrócił HTTP ${list.status} przy odczycie wydań.`);
    const releases = await list.json();

    // Wersja musi rosnąć - launcher aktualizuje się tylko do WYŻSZEJ. Gdy ta z package.json jest już wydana
    // (jest opublikowana z latest.yml albo to skrypt wydał ją poprzednio), numer patch rośnie sam.
    let version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
    const publishedVersions = releases
      .filter((r) => !r.draft && r.assets?.some((a) => a.name === 'latest.yml'))
      .map((r) => String(r.tag_name).replace(/^v/, ''));
    const lastReleased = readLastReleased();
    const taken = [...publishedVersions, lastReleased].filter(Boolean);
    if (!flag('--keep-version') && taken.some((v) => compareVersions(v, version) >= 0)) {
      const highest = taken.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a), version);
      const bumped = nextPatch(highest);
      writeVersion(version, bumped);
      console.log(`  Wersja ${version} jest już wydana - podbijam na ${bumped}.`);
      version = bumped;
    }
    const tag = `v${version}`;
    console.log(`→ Wydanie ${version} do GitHub Releases (${githubRepo})`);
    const existing = releases.find((r) => r.tag_name === tag);

    if (existing && !existing.draft && existing.assets?.some((a) => a.name === 'latest.yml')) {
      fail(`Wersja ${version} jest już wydana (jest w niej latest.yml). Uruchom bez --keep-version, żeby podbić wersję.`);
    }

    // Wydanie powstaje jako WERSJA ROBOCZA (niewidoczna dla launcherów) i staje się publiczne dopiero po
    // wgraniu kompletu plików. Inaczej przez czas wgrywania (kilka minut) każdy, kto sprawdza aktualizacje,
    // widzi najnowsze wydanie bez latest.yml i dostaje błąd 404.
    let releaseId;
    if (existing) {
      releaseId = existing.id;
      if (!existing.draft) {
        const hide = await api(`/releases/${releaseId}`, { method: 'PATCH', body: JSON.stringify({ draft: true }) });
        if (!hide.ok) fail(`Nie udało się ukryć niedokończonego wydania (HTTP ${hide.status}).`);
        console.log('  Niedokończone wydanie wróciło do wersji roboczej - gracze go nie widzą.');
      } else {
        console.log('  Wersja robocza już istnieje - uzupełniam brakujące pliki.');
      }
    } else {
      const created = await api('/releases', {
        method: 'POST',
        body: JSON.stringify({ tag_name: tag, name: RELEASE_NAME, body: RELEASE_BODY, draft: true, prerelease: false }),
      });
      if (!created.ok) {
        const detail = await created.text();
        fail(`Nie udało się utworzyć wydania (HTTP ${created.status}). Czy token ma Contents: Read and write?\n${detail.slice(0, 300)}`);
      }
      releaseId = (await created.json()).id;
      console.log(`  Utworzono wersję roboczą ${tag} (ukrytą do czasu wgrania wszystkich plików).`);
    }

    if (flag('--no-upload')) {
      console.log('  (--no-upload: pomijam budowanie i wgrywanie)');
    } else {
      const r = spawnSync(
        'npx',
        ['electron-builder', '--config', 'electron-builder.config.js', '--win', 'nsis', '--publish', 'always'],
        { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token, CROWN_OUT_DIR: outDir, CROWN_PUBLISH_REPO: githubRepo } },
      );
      if (r.status !== 0) {
        fail('Wgrywanie plików nie powiodło się. Wydanie zostaje ukryte. Uruchom polecenie ponownie - uzupełni brakujące pliki.');
      }
    }

    // Publikujemy dopiero, gdy na GitHubie jest komplet wskazany przez latest.yml (z zgodnymi rozmiarami).
    const ymlFile = path.join(outDir, 'latest.yml');
    if (!fs.existsSync(ymlFile)) fail(`Brak ${ymlFile} - nie zbudowano aktualizacji. Wydanie zostaje ukryte.`);
    const names = [...fs.readFileSync(ymlFile, 'utf8').matchAll(/^\s*(?:- )?url:\s*(.+)$/gm)].map((m) =>
      m[1].trim().replace(/^['"]|['"]$/g, ''),
    );
    const required = new Map([['latest.yml', fs.statSync(ymlFile).size]]);
    for (const name of new Set(names)) {
      const local = path.join(outDir, name);
      if (fs.existsSync(local)) required.set(name, fs.statSync(local).size);
      else required.set(name, null);
      const map = `${name}.blockmap`;
      if (fs.existsSync(path.join(outDir, map))) required.set(map, fs.statSync(path.join(outDir, map)).size);
    }

    const state = await api(`/releases/${releaseId}`);
    if (!state.ok) fail(`Nie udało się odczytać wydania (HTTP ${state.status}).`);
    const remote = new Map(((await state.json()).assets || []).map((a) => [a.name, a]));
    const problems = [];
    for (const [name, size] of required) {
      const a = remote.get(name);
      if (!a || a.state !== 'uploaded' || !a.size) problems.push(`${name} (brak)`);
      else if (size != null && a.size !== size) problems.push(`${name} (rozmiar ${a.size} ≠ ${size})`);
    }
    if (problems.length) {
      fail(`Wydanie jest niekompletne, więc zostaje ukryte: ${problems.join(', ')}. Uruchom polecenie ponownie.`);
    }

    const pub = await api(`/releases/${releaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: RELEASE_NAME, body: RELEASE_BODY, draft: false, prerelease: false, make_latest: 'true' }),
    });
    if (!pub.ok) {
      const detail = await pub.text();
      fail(`Nie udało się opublikować wydania (HTTP ${pub.status}).\n${detail.slice(0, 300)}`);
    }
    // wersja jest „zajęta” od tej chwili: następne wydanie podbije numer samo
    try {
      fs.writeFileSync(lastFile, `${JSON.stringify({ version, at: new Date().toISOString() }, null, 2)}\n`);
    } catch {
      /* znacznik jest dodatkiem - wydanie i tak sprawdza GitHub */
    }
    console.log(`\n✓ Opublikowano ${version}: https://github.com/${githubRepo}/releases/tag/${tag}`);
    console.log('  Launchery pobiorą aktualizację same (po starcie i co kilka godzin).');

    // Starsze wydania znikają (razem z tagami) - w repozytorium zostaje jedno, najnowsze. Dopiero po publikacji
    // i tylko gdy GitHub potwierdza, że to nowe wydanie jest „najnowsze”.
    if (!flag('--keep-old')) {
      try {
        const latest = await api('/releases/latest');
        const latestTag = latest.ok ? (await latest.json()).tag_name : '';
        if (latestTag !== tag) {
          console.log(`  Pomijam sprzątanie starych wydań: GitHub wskazuje jako najnowsze „${latestTag || '?'}”, nie ${tag}.`);
        } else {
          let removed = 0;
          for (const r of releases) {
            if (r.id === releaseId) continue;
            const del = await api(`/releases/${r.id}`, { method: 'DELETE' });
            if (!del.ok && del.status !== 404) {
              console.log(`  Nie udało się usunąć wydania ${r.tag_name} (HTTP ${del.status}).`);
              continue;
            }
            if (r.tag_name && r.tag_name !== tag) {
              await api(`/git/refs/tags/${encodeURIComponent(r.tag_name)}`, { method: 'DELETE' }).catch(() => {});
            }
            removed++;
          }
          if (removed) console.log(`  Usunięto starsze wydania: ${removed}.`);
        }
      } catch (e) {
        console.log(`  Sprzątanie starych wydań nie powiodło się: ${e.message}`);
      }
    }
    process.exit(0);
  })().catch((e) => fail(e.message));
  return; // dalsza część dotyczy trybu serwera
}

// ---- tryb własnego serwera ----------------------------------------------------------------------

// --target cf-test (albo CROWN_RELEASE_TARGET): wgranie na testowego Workera Cloudflare (adres w cloudflare/wrangler.jsonc) kluczem z pliku
// %USERPROFILE%\.crownlauncher-cf-test-admin-key; nie oznacza wersji jako wydanej (.last-release.json zostaje bez zmian)
const releaseTarget = String(option('--target', process.env.CROWN_RELEASE_TARGET || '')).trim();
if (releaseTarget && releaseTarget !== 'cf-test') fail('--target: dozwolone tylko „cf-test” (testowy Worker Cloudflare).');
// adres testowego Workera jest losowy (nie do odgadnięcia) i leży tylko w cloudflare/wrangler.jsonc (pierwsza trasa najwyższego poziomu)
const stageHost = () => {
  const m = /"routes":\s*\[\{\s*"pattern":\s*"([a-z0-9.-]+)"/.exec(fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'wrangler.jsonc'), 'utf8'));
  if (!m) fail('Nie znaleziono adresu testowego Workera w cloudflare/wrangler.jsonc.');
  return `https://${m[1]}`;
};
const server = String(process.env.CROWN_SERVER || (releaseTarget === 'cf-test' ? stageHost() : appConfig.ANNOUNCEMENTS_URL) || '').replace(/\/+$/, '');
// klucz admin: zmienna środowiskowa albo plik zapisany raz na komputerze (szyfrowany DPAPI, jak token GitHub)
const key = process.env.CROWN_ADMIN_KEY || (releaseTarget === 'cf-test' ? storedSecret('.crownlauncher-cf-test-admin-key') : storedAdminKey());

if (!server) fail('Brak źródła aktualizacji. Ustaw GITHUB_REPO albo ANNOUNCEMENTS_URL w src/main/core/app-config.js (lub CROWN_SERVER).');
if (!key) {
  fail(
    'Brak klucza administratora. Ustaw zmienną środowiskową CROWN_ADMIN_KEY albo zapisz klucz raz na stałe ' +
      '(plik %USERPROFILE%\\.crownlauncher-admin-key szyfrowany DPAPI - patrz README).',
  );
}
if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(server)) {
  fail('Serwer musi mieć adres https:// (http:// tylko dla localhost) - klucz nie może iść jawnym tekstem.');
}

// Wersja musi rosnąć - launcher aktualizuje się tylko do WYŻSZEJ. Gdy ta z package.json została już wydana tym
// skryptem, numer patch rośnie sam (tak samo jak w trybie GitHub). Przy --skip-build budowa już istnieje, więc
// numeru nie ruszamy.
// --linux: wydanie dla Linuksa (AppImage + latest-linux.yml) - ta sama wersja co wydanie Windows (nie podbijamy numeru i nie oznaczamy
// jej jako „zajętej”: robi to wydanie Windows), a build robi się na Linuksie.
const linux = flag('--linux');
if (!linux && !flag('--skip-build') && !flag('--keep-version')) {
  const current = JSON.parse(fs.readFileSync(versions.pkgFile, 'utf8')).version;
  const last = versions.readLastReleased();
  if (last && versions.compareVersions(last, current) >= 0) {
    const bumped = versions.nextPatch(last);
    versions.writeVersion(current, bumped);
    console.log(`  Wersja ${current} jest już wydana - podbijam na ${bumped}.`);
  }
}

if (!flag('--skip-build')) {
  if (linux) buildLinux();
  else build();
}

const latest = path.join(outDir, linux ? 'latest-linux.yml' : 'latest.yml');
if (!fs.existsSync(latest)) fail(`Brak ${latest} - nie zbudowano aktualizacji.`);

// pliki wymienione w latest.yml + ich .blockmap
const yml = fs.readFileSync(latest, 'utf8');
const names = [...yml.matchAll(/^\s*(?:- )?url:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
const uploads = [];
for (const name of new Set(names)) {
  uploads.push(name);
  if (fs.existsSync(path.join(outDir, `${name}.blockmap`))) uploads.push(`${name}.blockmap`);
}
uploads.push(path.basename(latest)); // na końcu (latest.yml albo latest-linux.yml)

/** Jedno żądanie do serwera aktualizacji (klucz admin w nagłówku); `payload` to bufor albo strumień. Zwraca { status, body }. */
function call(method, urlString, headers, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers: { Authorization: `Bearer ${key}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (payload && typeof payload.pipe === 'function') payload.pipe(req);
    else req.end(payload);
  });
}

const detailOf = (body) => {
  try {
    return JSON.parse(body).error || body;
  } catch {
    return body; // surowa odpowiedź
  }
};

// Cloudflare przyjmuje maks. 100 MB w jednym żądaniu, a instalator ma ~113 MB - większe pliki idą częściami (R2 multipart).
// Starszy serwer (VPS) nie zna wgrywania częściami - wtedy zostaje jedno żądanie PUT.
const SINGLE_PUT_MAX = Number(process.env.CROWN_SINGLE_PUT_MAX) || 90 * 1024 * 1024;
const PART_SIZE = Number(process.env.CROWN_PART_SIZE) || 16 * 1024 * 1024;

async function putSingle(file, full, size) {
  const res = await call('PUT', `${server}/v1/updates/${encodeURIComponent(file)}`, { 'Content-Type': 'application/octet-stream', 'Content-Length': size }, fs.createReadStream(full));
  if (res.status !== 201) throw new Error(`${file}: HTTP ${res.status} ${detailOf(res.body)}`);
  return size;
}

async function putMultipart(file, full, size) {
  const base = `${server}/v1/updates/${encodeURIComponent(file)}`;
  const start = await call('POST', `${base}?uploads`, {});
  if (start.status === 401 || start.status === 403) throw new Error(`${file}: HTTP ${start.status} ${detailOf(start.body)}`); // zły klucz: bez próby wysyłania całego pliku
  if (start.status !== 201) return null; // serwer nie zna wgrywania częściami (np. VPS): zostaje jedno żądanie PUT
  const uploadId = JSON.parse(start.body).uploadId;
  const parts = [];
  const fd = fs.openSync(full, 'r');
  try {
    for (let pos = 0, n = 1; pos < size; pos += PART_SIZE, n++) {
      const len = Math.min(PART_SIZE, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await call('PUT', `${base}?uploadId=${encodeURIComponent(uploadId)}&part=${n}`, { 'Content-Type': 'application/octet-stream', 'Content-Length': len }, buf);
          if (res.status === 200) break;
        } catch (e) {
          res = { status: 0, body: e.message };
        }
        if (attempt === 3) throw new Error(`${file}: część ${n}: HTTP ${res.status} ${detailOf(res.body)}`);
      }
      parts.push(JSON.parse(res.body));
      process.stdout.write('.');
    }
    const done = await call('POST', `${base}?uploadId=${encodeURIComponent(uploadId)}`, { 'Content-Type': 'application/json' }, JSON.stringify({ parts }));
    if (done.status !== 201) throw new Error(`${file}: zakończenie wgrywania: HTTP ${done.status} ${detailOf(done.body)}`);
  } catch (e) {
    await call('DELETE', `${base}?uploadId=${encodeURIComponent(uploadId)}`, {}).catch(() => {}); // porzucone części nie zostają w R2
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return size;
}

async function put(file) {
  const full = path.join(outDir, file);
  if (!fs.existsSync(full)) throw new Error(`Brak pliku ${full}`);
  const size = fs.statSync(full).size;
  if (size > SINGLE_PUT_MAX) {
    const done = await putMultipart(file, full, size);
    if (done !== null) return done;
  }
  return putSingle(file, full, size);
}

(async () => {
  console.log(`→ Wgrywam na ${server}`);
  for (const file of uploads) {
    process.stdout.write(`  ${file} … `);
    const size = await put(file);
    console.log(`${(size / 1048576).toFixed(1)} MB ✓`);
  }
  const version = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  if (version && !releaseTarget && !linux) versions.markReleased(version); // wersja jest „zajęta”: następne wydanie podbije numer samo (nie dotyczy wgrania próbnego na cf-test)
  console.log(`\n✓ Opublikowano aktualizację${version ? ` ${version}` : ''}. Launchery sprawdzą ją w ciągu kilku godzin lub po uruchomieniu.`);
})().catch((e) => fail(e.message));
