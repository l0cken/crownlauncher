// Weryfikacja działającego serwera launchera (VPS albo Worker) tylko GET-ami i kluczem admin (nigdy kluczami graczy - nie wiążą komputerów):
// zdrowie, bramki 401, strona i panel (CSP, nagłówki), logo za bramką, aktualizacje (latest.yml, rozmiar instalatora, Range), lista koron,
// wydarzenie. Te same sprawdzenia przed i po przełączeniu DNS pozwalają porównać oba backendy.
// Użycie: node cloudflare/scripts/verify-live.js [--base https://adres | --target test]    (domyślnie: środowisko testowe)
// Dla VPS-a:  node cloudflare/scripts/verify-live.js --base https://launcher.locken.pl
const { resolveBase, connect } = require('./lib/client');

let failed = 0;
const check = (ok, what, extra = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failed++;
};

(async () => {
  const base = resolveBase(process.argv.slice(2));
  console.log(`Weryfikacja ${base}`);
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });
  const status = async (p, headers) => (await get(p, headers)).status;

  const health = await get('/health');
  check(health.status === 200 && (await health.json()).ok === true, '/health 200 {ok:true}');
  check((health.headers.get('strict-transport-security') || '').includes('max-age=31536000'), 'nagłówek HSTS (max-age=31536000)');

  // bramki: bez klucza nic prywatnego
  for (const p of ['/updates/latest.yml', '/v1/announcements', '/v1/invite', '/v1/admin/invites', '/v1/event/igrzyska/info']) {
    check((await status(p)) === 401, `bez klucza ${p} → 401`);
  }
  check((await fetch(`${base}/v1/capes/test`, { method: 'PUT', body: 'x' })).status === 401, 'bez klucza PUT /v1/capes/<nick> → 401');
  check((await fetch(`${base}/v1/updates/latest.yml`, { method: 'PUT', body: 'x' })).status === 401, 'bez klucza PUT /v1/updates/… → 401');

  // strona i panel
  const home = await get('/');
  const html = await home.text();
  check(home.status === 200 && /name="key"/.test(html) && !/<img/i.test(html), 'strona pobierania: formularz z kluczem, bez <img>');
  check(/script-src 'self'/.test(home.headers.get('content-security-policy') || '') && !/unsafe-inline/.test(home.headers.get('content-security-policy') || ''), 'strona: CSP bez unsafe-inline');
  const admin = await get('/admin');
  check(admin.status === 200 && /script-src 'self'/.test(admin.headers.get('content-security-policy') || ''), '/admin: CSP script-src self');
  for (const p of ['/site.css', '/site.js', '/admin/app.css', '/admin/app.js', '/favicon.png']) check((await status(p)) === 200, `zasób ${p} → 200`);
  check((await status('/logo.png')) === 404, '/logo.png bez nagłówków obrazu → 404');
  check((await status('/logo.png', { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'same-origin' })) === 200, '/logo.png jako obraz własnej strony → 200');

  // lista koron i peleryny są publiczne
  const crown = await get('/v1/crown-users');
  const users = crown.ok ? await crown.json() : [];
  check(crown.status === 200 && Array.isArray(users), `/v1/crown-users → 200 (${users.length} nicków)`);
  if (users.length) check((await status(`/capes/${users[0].name}`.toLowerCase())) < 500, `peleryna ${users[0].name} odpowiada bez błędu serwera`);

  // z kluczem admin
  const client = await connect(base);
  console.log(`  (klucz admin: ${client.label})`);
  const info = await (await client.api('GET', '/v1/admin/info')).json();
  check(Boolean(info.installer) && info.inviteOnly === true, `panel API: instalator „${info.installer}”, tryb prywatny`);
  const me = await (await client.api('GET', '/v1/invite')).json();
  check(me.role === 'admin' && me.capes === true && me.disableClient === true, '/v1/invite z kluczem admin → admin');
  const invites = (await (await client.api('GET', '/v1/admin/invites')).json()).invites;
  check(invites.length > 0, `lista zaproszeń: ${invites.length} kluczy (${invites.filter((i) => i.status === 'activated' || i.status === 'full').length} aktywowanych)`);

  const yml = await (await client.api('GET', '/updates/latest.yml')).text();
  const version = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const exe = /^path:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const size = Number(/^\s*size:\s*(\d+)/m.exec(yml)?.[1]);
  check(Boolean(version && exe && size), `latest.yml: wersja ${version}, ${exe}`);
  const head = await fetch(`${base}/updates/${exe}`, { method: 'HEAD', headers: client.headers() });
  check(head.status === 200 && Number(head.headers.get('content-length')) === size && head.headers.get('accept-ranges') === 'bytes', `HEAD instalatora: ${size} B, Accept-Ranges: bytes`);
  const part = await fetch(`${base}/updates/${exe}`, { headers: client.headers({ Range: 'bytes=1000-1999' }) });
  const partBytes = Buffer.from(await part.arrayBuffer());
  check(part.status === 206 && partBytes.length === 1000 && part.headers.get('content-range') === `bytes 1000-1999/${size}`, 'Range bytes=1000-1999 → 206, 1000 B, Content-Range');
  // informacja (nie błąd): czy serwer odpowiada na Range z wieloma zakresami jak potrzebuje electron-updater (aktualizacje różnicowe)
  const mp = await fetch(`${base}/updates/${exe}`, { headers: client.headers({ Range: 'bytes=0-99, 200-299' }) });
  const mpType = (mp.headers.get('content-type') || '').split(';')[0];
  await mp.body?.cancel().catch(() => {});
  console.log(`  INFO wielozakresowy Range (aktualizacje różnicowe): ${mp.status === 206 && mpType === 'multipart/byteranges' ? 'obsługiwany (206 multipart/byteranges)' : `nieobsługiwany (HTTP ${mp.status}, ${mpType}) — launcher pobiera pełny instalator`}`);
  const blk = await fetch(`${base}/updates/${exe}.blockmap`, { headers: client.headers() });
  check(blk.status === 200 && (await blk.arrayBuffer()).byteLength > 1000, 'blockmap instalatora (różnicowa aktualizacja) → 200');
  const ev = await (await client.api('GET', '/v1/event/igrzyska/info')).json();
  check(ev.id === 'igrzyska', `wydarzenie „${ev.title}”: ${ev.ready ? 'gotowe' : 'do przygotowania'}`);
  const manifest = await (await client.api('GET', '/v1/event/igrzyska')).json();
  check(Array.isArray(manifest.mods), `manifest wydarzenia: ${manifest.mods.length} modów, ${manifest.resourcepacks.length} texturepacków, ${manifest.config.length} configów`);

  console.log(failed ? `\n${failed} sprawdzeń NIE przeszło` : '\nWSZYSTKO OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('BŁĄD:', e.message);
  process.exit(1);
});
