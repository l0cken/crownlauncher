// Przełączenie domeny launchera na Workera z minimalną przerwą: czeka, aż rekord DNS `launcher.locken.pl` zniknie z autorytatywnych
// serwerów nazw (usuwasz go w dashboardzie Cloudflare), i OD RAZU wdraża Workera produkcyjnego z trasą custom_domain (Cloudflare sam wtedy
// zakłada rekord z włączonym proxy). Potem czeka, aż domena odpowiada przez Cloudflare. Nic nie robi, dopóki rekord istnieje.
// Użycie: node cloudflare/scripts/cutover-attach.js [host] [--max-min 30]   (domyślnie launcher.locken.pl)
// Cofnięcie: patrz CUTOVER.md („Powrót na VPS”).
const { spawnSync } = require('child_process');
const path = require('path');

const host = process.argv.slice(2).find((a) => /^[a-z0-9.-]+$/.test(a)) || 'launcher.locken.pl';
const maxMin = Number(process.argv[process.argv.indexOf('--max-min') + 1]) || 30;
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

const zone = host.split('.').slice(-2).join('.');
const ns = (spawnSync('nslookup', ['-type=NS', zone, '1.1.1.1'], { encoding: 'utf8' }).stdout.match(/nameserver = (\S+)/i) || [])[1];
if (!ns) throw new Error(`Nie ustaliłem serwera nazw dla ${zone}`);

const recordExists = () => {
  const out = spawnSync('nslookup', [host, ns], { encoding: 'utf8' }).stdout || '';
  const m = /Name:\s+\S+\s+Address(?:es)?:\s+([0-9.]+)/i.exec(out);
  return m ? m[1] : null;
};

(async () => {
  const first = recordExists();
  log(`Serwer nazw ${ns}; rekord ${host}: ${first || 'brak'}`);
  if (!first) log('Rekordu już nie ma - wdrażam od razu.');
  else log('Czekam, aż usuniesz rekord A w dashboardzie Cloudflare (DNS → Records) …');
  const until = Date.now() + maxMin * 60_000;
  while (recordExists()) {
    if (Date.now() > until) throw new Error('Rekord nie został usunięty w limicie czasu - nic nie zmieniono.');
    await sleep(2000);
  }
  log('Rekord zniknął z serwerów nazw - wdrażam Workera z trasą domeny.');
  let deployed = false;
  for (let attempt = 1; attempt <= 6 && !deployed; attempt++) {
    const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--env', 'production'], { cwd: root, encoding: 'utf8' });
    const out = `${r.stdout}\n${r.stderr}`;
    deployed = r.status === 0 && out.includes(`${host} (custom domain)`);
    log(`wdrożenie, próba ${attempt}: ${deployed ? 'OK' : `błąd - ${(out.match(/Hostname[^\n]*|\[code: \d+\]/g) || [out.slice(-200)]).join(' ').slice(0, 220)}`}`);
    if (!deployed) await sleep(3000);
  }
  if (!deployed) throw new Error('Nie udało się wdrożyć trasy domeny - sprawdź wrangler i dashboard (rekord DNS jest USUNIĘTY, domena nie odpowiada!). Powrót: CUTOVER.md.');

  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res && res.status === 200 && res.headers.get('cf-ray')) {
      log(`https://${host}/health → 200 przez Cloudflare (cf-ray ${res.headers.get('cf-ray')}), ${((Date.now() - t0) / 1000).toFixed(0)} s po wdrożeniu`);
      break;
    }
    if (Date.now() - t0 > 180_000) throw new Error(`Domena nie odpowiada przez Cloudflare po 3 min (ostatni status: ${res ? res.status : 'brak'}).`);
    await sleep(2000);
  }
  log('GOTOWE: domena wskazuje na Workera.');
})().catch((e) => {
  console.error(`[${ts()}] BŁĄD: ${e.message}`);
  process.exit(1);
});
