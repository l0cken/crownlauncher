/**
 * Panel administratora serwera CrownLaunchera (strona /admin): wydawanie, edycja i unieważnianie kluczy zaproszeń.
 * Zasoby statyczne leżą w server/web/ (osobne pliki, nie inline - dzięki temu CSP ma script-src 'self' bez
 * 'unsafe-inline'). Dane panel pobiera z /v1/admin/*, które wymagają sesji albo klucza admin.
 */
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, 'web', name), 'utf8');

const html = `<!doctype html>
<html lang="pl"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<title>CrownLauncher — panel</title>
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/admin/app.css">
</head><body>
<div id="app"><p class="boot">Ładowanie…</p></div>
<script src="/admin/app.js"></script>
</body></html>`;

module.exports = { html, css: read('panel-app.css'), js: read('panel-app.js') };
