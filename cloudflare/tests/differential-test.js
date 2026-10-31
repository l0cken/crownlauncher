// PRAWDZIWY różnicowy pobieracz electron-updatera (GenericDifferentialDownloader + DataSplitter) na serwerze aktualizacji:
// stary instalator (0.1.33 z release/) + blockmapy → serwer musi odpowiedzieć na `Range: bytes=a-b, c-d, …` jako multipart/byteranges,
// a złożony plik ma mieć SHA-512 z latest.yml. Pokazuje też, ile bajtów poszło po sieci (zamiast pełnych 113 MB).
// Użycie: node cloudflare/tests/differential-test.js [--base https://adres | --target test] [--old <instalator>] [--old-blockmap <plik>]
// Klucz: tworzy PRÓBNY klucz zaproszenia (z nagłówkami jak launcher: X-Crown-Invite + X-Crown-Device) i na końcu go usuwa.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const root = path.join(__dirname, '..', '..');
const { resolveBase, connect, option } = require('../scripts/lib/client');
const { GenericDifferentialDownloader } = require(path.join(root, 'node_modules/electron-updater/out/differentialDownloader/GenericDifferentialDownloader'));
const { NodeHttpExecutor } = require(path.join(root, 'node_modules/builder-util/out/nodeHttpExecutor'));

const argv = process.argv.slice(2);
const oldFile = option(argv, '--old', path.join(root, 'release', 'CrownLauncher-Setup-0.1.33.exe'));
const oldBlockmap = option(argv, '--old-blockmap', `${oldFile}.blockmap`);

(async () => {
  const base = resolveBase(argv);
  const admin = await connect(base);
  const made = await (await admin.api('POST', '/v1/admin/invites', { name: 'TestRoznicowy', maxUses: 1 })).json();
  const headers = { 'X-Crown-Invite': made.key, 'X-Crown-Device': 'roznicowy-komputer-0123456789abcdef', 'X-Crown-Features': 'event,release' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-diff-'));
  let ok = false;
  try {
    const yml = await (await fetch(`${base}/updates/latest.yml`, { headers })).text();
    const version = /^version:\s*(.+)$/m.exec(yml)[1].trim();
    const name = /^path:\s*(.+)$/m.exec(yml)[1].trim();
    const size = Number(/^\s*size:\s*(\d+)/m.exec(yml)[1]);
    const sha512 = /^sha512:\s*(.+)$/m.exec(yml)[1].trim();
    console.log(`Serwer: ${base} — najnowsza ${version} (${name}, ${(size / 1048576).toFixed(1)} MB); stary plik: ${path.basename(oldFile)}`);
    assert.ok(fs.existsSync(oldFile) && fs.existsSync(oldBlockmap), 'brak starego instalatora/blockmapy lokalnie (release/)');

    const getBuf = async (p) => {
      const r = await fetch(`${base}${p}`, { headers });
      assert.strictEqual(r.status, 200, `${p}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const newBlockMap = JSON.parse(zlib.gunzipSync(await getBuf(`/updates/${name}.blockmap`)).toString());
    const oldBlockMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(oldBlockmap)).toString());

    const lines = [];
    const logger = { info: (m) => lines.push(String(m)), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
    const executor = new NodeHttpExecutor();
    const newFile = path.join(tmp, name);
    const t0 = Date.now();
    await new GenericDifferentialDownloader({ name, size, sha512 }, executor, {
      newUrl: new URL(`${base}/updates/${name}`),
      oldFile,
      newFile,
      logger,
      isUseMultipleRangeRequest: true, // tak ustawia provider generic electron-updatera
      requestHeaders: headers,
    }).download(oldBlockMap, newBlockMap);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    for (const l of lines) console.log(`  [updater] ${l}`);

    const got = crypto.createHash('sha512').update(fs.readFileSync(newFile)).digest('base64');
    assert.strictEqual(fs.statSync(newFile).size, size, 'rozmiar złożonego pliku');
    assert.strictEqual(got, sha512, 'SHA-512 złożonego pliku różni się od latest.yml');
    const plan = /To download: ([^(]+)\((\d+)%\)/.exec(lines.join('\n'));
    console.log(`\nOK  różnicowe pobranie (prawdziwy electron-updater): plik złożony w ${secs} s, SHA-512 zgodny z latest.yml; do pobrania ${plan ? `${plan[1].trim()} (${plan[2]}% pliku)` : '?'}`);
    ok = true;
  } finally {
    await admin.api('POST', `/v1/admin/invites/${made.id}/revoke`, {}).catch(() => {});
    await admin.api('DELETE', `/v1/admin/invites/${made.id}`).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
