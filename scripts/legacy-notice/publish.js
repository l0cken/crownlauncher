#!/usr/bin/env node
/**
 * Publikuje na GitHubie „aktualizację” dla starych launcherów (patrz notice.nsi): malutki instalator-komunikat jako
 * wydanie o wysokiej wersji. Stary launcher (GitHub-mode, <= 0.1.19) widzi nowszą wersję, pobiera ją i uruchamia -
 * zamiast instalować cokolwiek instalator pokazuje okno „pobierz nowy launcher ze strony” i otwiera stronę.
 *
 *   node scripts/legacy-notice/publish.js            buduje i publikuje wydanie v0.1.99
 *   node scripts/legacy-notice/publish.js --remove   usuwa to wydanie i tag (repozytorium znów bez wydań)
 *
 * Repozytorium: GITHUB_REPO z --repo albo domyślnie l0cken/crownlauncher. Token GitHub: GH_TOKEN albo plik
 * %USERPROFILE%\.crownlauncher-gh-token (DPAPI, jak scripts/release.js) - nigdy nie jest wypisywany.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = '0.1.99';
const TAG = `v${VERSION}`;
const EXE = `CrownLauncher-Setup-${VERSION}.exe`;
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const REPO = opt('--repo', 'l0cken/crownlauncher');
const API = process.env.CROWN_GITHUB_API || 'https://api.github.com';
const UPLOADS = process.env.CROWN_GITHUB_UPLOADS || 'https://uploads.github.com';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function storedToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const file = path.join(process.env.USERPROFILE || os.homedir(), '.crownlauncher-gh-token');
  if (process.platform !== 'win32' || !fs.existsSync(file)) return '';
  const script =
    '$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:CROWN_TOKEN_FILE).Trim(); ' +
    '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, CROWN_TOKEN_FILE: file },
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

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

const token = storedToken();
if (!token) fail('Brak tokenu GitHub (GH_TOKEN albo plik %USERPROFILE%\\.crownlauncher-gh-token).');

async function api(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${API}/repos/${REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CrownLauncher-legacy-notice',
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* puste */
  }
  return { status: res.status, ok: res.ok, json };
}

(async () => {
  const list = await api('GET', '/releases?per_page=100');
  if (list.status === 404) fail(`Brak dostępu do ${REPO} - token musi obejmować to repozytorium.`);
  if (!list.ok) fail(`GitHub zwrócił HTTP ${list.status} przy odczycie wydań.`);

  const existing = list.json.filter((r) => r.tag_name === TAG);
  for (const r of existing) {
    const del = await api('DELETE', `/releases/${r.id}`);
    if (!del.ok && del.status !== 404) fail(`Nie udało się usunąć dotychczasowego wydania ${TAG} (HTTP ${del.status}).`);
  }
  if (existing.length || args.includes('--remove')) await api('DELETE', `/git/refs/tags/${TAG}`); // tag mógł zostać po wydaniu
  if (args.includes('--remove')) {
    console.log(`✓ Usunięto wydanie ${TAG} z ${REPO}.`);
    return;
  }

  // 1. budowa instalatora-komunikatu
  const makensis = findMakensis();
  if (!makensis) fail('Brak makensis.exe w cache electron-buildera (zbuduj launcher raz: npm run dist).');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-legacy-'));
  const exePath = path.join(work, EXE);
  const build = spawnSync(makensis, ['-V1', `-DOUT=${exePath}`, path.join(__dirname, 'notice.nsi')], { encoding: 'utf8' });
  if (build.status !== 0) fail(`makensis nie powiódł się:\n${build.stdout}${build.stderr}`);
  const body = fs.readFileSync(exePath);
  const sha = crypto.createHash('sha512').update(body).digest('base64');
  const yml =
    `version: ${VERSION}\nfiles:\n  - url: ${EXE}\n    sha512: ${sha}\n    size: ${body.length}\n` +
    `path: ${EXE}\nsha512: ${sha}\nreleaseDate: '${new Date().toISOString()}'\n`;

  // 2. wydanie (opublikowane, najnowsze) - nazwa i opis jak w każdym wydaniu launchera
  const created = await api('POST', '/releases', {
    body: { tag_name: TAG, name: 'CrownLauncher', body: '​', draft: false, prerelease: false, make_latest: 'true' },
  });
  if (!created.ok) fail(`Nie udało się utworzyć wydania (HTTP ${created.status}): ${created.json?.message || ''}`);
  const id = created.json.id;

  // 3. pliki: najpierw instalator, na końcu latest.yml
  for (const [name, data] of [[EXE, body], ['latest.yml', Buffer.from(yml, 'utf8')]]) {
    const up = await api('POST', `${UPLOADS}/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(name)}`, {
      body: data,
      raw: true,
      headers: { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' },
    });
    if (!up.ok) fail(`Nie udało się wgrać ${name} (HTTP ${up.status}): ${up.json?.message || ''}`);
    console.log(`  wgrano ${name} (${data.length} B)`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n✓ Opublikowano ${TAG} w ${REPO}: https://github.com/${REPO}/releases/tag/${TAG}`);
  console.log('  Stare launchery zobaczą „nową wersję” - po kliknięciu „Pobierz” dostaną okno z adresem strony.');
})().catch((e) => fail(e.message));
