// Pomiar skrajnych żądań wielozakresowych na PRAWDZIWYM Cloudflare (środowisko testowe): 1000 zakresów rozrzuconych po całym instalatorze,
// zakresy skupione, jeden ogromny; poprawność względem lokalnej kopii instalatora z release/ oraz czas CPU i czas całkowity z `wrangler tail`.
// Użycie: node cloudflare/scripts/multirange-remote.js [--base https://adres]
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBase, connect, root } = require('./lib/client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tailFile = path.join(os.tmpdir(), `crown-tail-mr-${process.pid}.json`);

function parseTail() {
  const t = fs.readFileSync(tailFile, 'utf8');
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') { depth--; if (depth === 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch { /* ucięty */ } } }
  }
  return out;
}

function parseByteranges(buf, ct) {
  const b = Buffer.from(`--${/boundary=([^\s;]+)/.exec(ct)[1]}`);
  const parts = [];
  let pos = buf.indexOf(b);
  while (pos !== -1) {
    const next = buf.indexOf(b, pos + b.length);
    const seg = buf.subarray(pos + b.length, next === -1 ? buf.length : next);
    if (seg.subarray(0, 2).toString() === '--') break;
    const he = seg.indexOf('\r\n\r\n');
    let body = seg.subarray(he + 4);
    if (next !== -1) body = body.subarray(0, body.length - 2);
    const cr = /Content-Range: bytes (\d+)-(\d+)\/(\d+)/.exec(seg.subarray(0, he).toString());
    parts.push({ start: Number(cr[1]), end: Number(cr[2]), body });
    pos = next;
  }
  return parts;
}

(async () => {
  const base = resolveBase(process.argv.slice(2));
  const admin = await connect(base);
  const local = fs.readFileSync(path.join(root, 'release', 'CrownLauncher-Setup-0.1.34.exe'));
  const name = 'CrownLauncher-Setup-0.1.34.exe';
  const tail = spawn(process.execPath, [path.join(root, 'cloudflare', 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'tail', 'crownlauncher-test', '--format', 'json'], { cwd: path.join(root, 'cloudflare'), stdio: ['ignore', fs.openSync(tailFile, 'w'), 'ignore'] });
  await sleep(10_000);

  const cases = [
    ['1000 zakresów po 1 KB, co 100 KB (rozrzucone po całym pliku)', Array.from({ length: 1000 }, (_, i) => [i * 100_000, i * 100_000 + 1023])],
    ['200 zakresów po 4 KB, co 500 KB', Array.from({ length: 200 }, (_, i) => [i * 500_000 + 11, i * 500_000 + 4106])],
    ['36 zakresów po 64 KB z lukami 3 MB', Array.from({ length: 36 }, (_, i) => [i * 3_000_000, i * 3_000_000 + 65_535])],
    ['2 duże zakresy (po 40 MB)', [[0, 40_000_000 - 1], [50_000_000, 90_000_000 - 1]]],
  ];
  const windows = [];
  for (const [label, ranges] of cases) {
    const from = Date.now() - 2000;
    const t0 = Date.now();
    const res = await fetch(`${base}/updates/${name}`, { headers: admin.headers({ Range: `bytes=${ranges.map(([a, b]) => `${a}-${b}`).join(', ')}` }) });
    const buf = Buffer.from(await res.arrayBuffer());
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let verdict;
    if (res.status !== 206) verdict = `HTTP ${res.status}`;
    else {
      const parts = parseByteranges(buf, res.headers.get('content-type'));
      const good = parts.length === ranges.length && parts.every((p, i) => p.start === ranges[i][0] && p.end === ranges[i][1] && p.body.equals(local.subarray(p.start, p.end + 1)));
      const payload = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
      verdict = `${good ? 'OK' : 'BŁĄD'}: ${parts.length}/${ranges.length} części zgodnych z lokalną kopią, ${(buf.length / 1048576).toFixed(2)} MB w odpowiedzi (dane ${(payload / 1048576).toFixed(2)} MB), Content-Length ${res.headers.get('content-length')}`;
    }
    console.log(`▸ ${label}\n    ${verdict}; ${secs} s`);
    windows.push({ label, from, to: Date.now() + 4000 });
  }
  await sleep(10_000);
  spawnSync('taskkill', ['/PID', String(tail.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
  const events = parseTail();
  console.log('\nCzas CPU i czas całkowity wywołań (wrangler tail):');
  for (const w of windows) {
    const evs = events.filter((e) => e.eventTimestamp >= w.from && e.eventTimestamp <= w.to && e.event && e.event.request && /\/updates\//.test(e.event.request.url));
    const line = (model) => {
      const l = evs.filter((e) => e.executionModel === model);
      return l.length ? `${model}: CPU ${Math.max(...l.map((e) => e.cpuTime))} ms, czas ${Math.max(...l.map((e) => e.wallTime))} ms, wynik ${[...new Set(l.map((e) => e.outcome))].join(',')}` : `${model}: brak zdarzenia`;
    };
    console.log(`  ${w.label}\n      ${line('stateless')} | ${line('durableObject')}`);
  }
  fs.rmSync(tailFile, { force: true });
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
