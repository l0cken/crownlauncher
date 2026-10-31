// Generuje cloudflare/src/assets.generated.js ze wspólnych plików serwera (server/web/*, server/site.js, server/panel.js),
// żeby strona pobierania i panel miały jedno źródło dla VPS-a i dla Workera. Uruchamiane przez wrangler (`build.command`).
const fs = require('fs');
const path = require('path');

const server = path.join(__dirname, '..', '..', 'server');
const site = require(path.join(server, 'site.js'));
const panel = require(path.join(server, 'panel.js'));

// strona pobierania z komunikatem błędu: renderujemy ją z znacznikiem i dzielimy, a w Workerze wstawiamy zmienioną treść
const MARK = '\u0000';
const withError = site.page(MARK).split(MARK);
if (withError.length !== 2) throw new Error('site.page: nie znaleziono miejsca na komunikat błędu');

const b64 = (file) => fs.readFileSync(path.join(server, 'web', file)).toString('base64');
const lines = [
  '// PLIK GENEROWANY przez scripts/build-assets.js - nie edytuj (źródło: server/web/*, server/site.js, server/panel.js)',
  `export const SITE_CSS = ${JSON.stringify(site.css)};`,
  `export const SITE_JS = ${JSON.stringify(site.js)};`,
  `export const SITE_PAGE = ${JSON.stringify(site.page(''))};`,
  `export const SITE_PAGE_ERROR = ${JSON.stringify(withError)};`,
  `export const PANEL_HTML = ${JSON.stringify(panel.html)};`,
  `export const PANEL_CSS = ${JSON.stringify(panel.css)};`,
  `export const PANEL_JS = ${JSON.stringify(panel.js)};`,
  `export const LOGO_B64 = ${JSON.stringify(b64('logo.png'))};`,
  `export const FAVICON_B64 = ${JSON.stringify(b64('favicon.png'))};`,
  '',
];
fs.writeFileSync(path.join(__dirname, '..', 'src', 'assets.generated.js'), lines.join('\n'));
console.log('assets.generated.js: OK');
