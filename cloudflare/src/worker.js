// Worker CrownLaunchera: zasoby statyczne (strona pobierania, panel, logo) i /health obsługuje sam, całą resztę oddaje
// jedynej instancji Durable Objecta (stan + logika, patrz app.js). Zasoby są wspólne z serwerem VPS (server/web/*).
export { CrownState } from './state.js';
import * as A from './assets.generated.js';

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const LOGO = bytes(A.LOGO_B64);
const FAVICON = bytes(A.FAVICON_B64);

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const PANEL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const text = (body, type) =>
  new Response(body, {
    headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });

// HSTS jak w Caddy na VPS-ie (Strict-Transport-Security: max-age=31536000) - dla odpowiedzi z Workera i z Durable Objecta
const withHsts = (res) => {
  if (res.headers.has('Strict-Transport-Security')) return res;
  const out = new Response(res.body, res);
  out.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return out;
};

export default {
  async fetch(request, env) {
    return withHsts(await handle(request, env));
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

  if (route === 'GET /health') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });

  if (route === 'GET /admin' || route === 'GET /admin/') {
    return new Response(A.PANEL_HTML, { headers: { ...HTML_HEADERS, 'Content-Security-Policy': PANEL_CSP } });
  }
  if (route === 'GET /admin/app.js') return text(A.PANEL_JS, 'text/javascript');
  if (route === 'GET /admin/app.css') return text(A.PANEL_CSS, 'text/css');
  if (route === 'GET /site.js') return text(A.SITE_JS, 'text/javascript');
  if (route === 'GET /site.css') return text(A.SITE_CSS, 'text/css');

  // Logo tylko jako obraz własnej strony (tło CSS): przeglądarka dokłada Sec-Fetch-Dest: image i Sec-Fetch-Site: same-origin,
  // a adres z paska, „otwórz w nowej karcie”, fetch i obce strony dostają 404. To utrudnienie, nie zabezpieczenie.
  if (route === 'GET /logo.png') {
    const vary = { Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const asPageImage = request.headers.get('sec-fetch-dest') === 'image' && request.headers.get('sec-fetch-site') === 'same-origin';
    if (!asPageImage) return Response.json({ error: 'Nie znaleziono.' }, { status: 404, headers: vary });
    return new Response(LOGO, { headers: { ...vary, 'Content-Type': 'image/png', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  }
  if (route === 'GET /favicon.png') {
    return new Response(FAVICON, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  }

  // strona pobierania instalatora (tylko tryb prywatny): formularz z kluczem zaproszenia
  if (env.INVITE_ONLY === '1' && (route === 'GET /' || route === 'GET /download')) {
    return new Response(A.SITE_PAGE, { headers: HTML_HEADERS });
  }

  // jedna, stała instancja: stan jest mały (klucze, gracze), a pojedynczy obiekt daje spójność bez wyścigów
  const stub = env.STATE.get(env.STATE.idFromName('main'));
  return stub.fetch(request);
}
