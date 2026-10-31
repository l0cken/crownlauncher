/**
 * Strona pobierania launchera (GET / i /download): pole na klucz zaproszenia. Style, skrypt i logo to pliki z
 * server/web/ (CSP: script-src 'self', bez inline). Skrypt tylko poprawia wygodę (formatowanie klucza) - strona
 * działa też bez niego.
 */
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, 'web', name), 'utf8');
let logo = null;
let favicon = null;
try {
  logo = fs.readFileSync(path.join(__dirname, 'web', 'logo.png'));
  favicon = fs.readFileSync(path.join(__dirname, 'web', 'favicon.png'));
} catch {
  /* bez logo strona nadal działa */
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(error = '') {
  return `<!doctype html>
<html lang="pl"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<title>CrownLauncher — pobierz</title>
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/site.css">
</head><body>
<div class="glow" aria-hidden="true"></div>
<main class="wrap">
  <header class="brand">
    <span class="logo" aria-hidden="true"></span>
    <span>CrownLauncher</span>
    <a class="admin-btn" href="/admin" title="Panel administratora: klucze zaproszeń">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Panel kluczy
    </a>
  </header>

  <section class="card hero">
    <p class="eyebrow">Launcher Minecrafta</p>
    <h1>Tylko dla <span class="gold">zaproszonych</span></h1>
    <p class="lead">Wpisz klucz zaproszenia od administratora, aby pobrać launcher.</p>

    <form method="post" action="/download" autocomplete="off" id="f">
      <label for="key">Klucz zaproszenia</label>
      <div class="row">
        <input id="key" name="key" placeholder="CROWN-XXXX-XXXX-XXXX-XXXX" maxlength="40" required autofocus
               spellcheck="false" autocapitalize="characters" inputmode="text">
      </div>
      <div class="dl">
        <button type="submit" id="go">Pobierz instalator</button>
      </div>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="hint">Klucz działa na ograniczonej liczbie komputerów — nie podawaj go dalej.</p>'}
    </form>

    <ol class="steps">
      <li><b>Pobierz</b><span>launcher po wpisaniu klucza</span></li>
      <li><b>Uruchom</b><span>pobrany instalator</span></li>
      <li><b>Wpisz klucz</b><span>przy pierwszym starcie</span></li>
    </ol>
  </section>

  <section class="features">
    <div class="feat"><i>⛏</i><b>Mody i instancje</b><span>Fabric, Minecraft 1.21.4 – 26.3, import paczek Modrinth</span></div>
    <div class="feat"><i>⚡</i><b>Wydajność</b><span>Pakiet optymalizujący z Sodium lub VulkanMod</span></div>
    <div class="feat"><i>🛠</i><b>Naprawa awarii</b><span>Launcher sam wskazuje i wyłącza zepsuty mod</span></div>
    <div class="feat"><i>👑</i><b>CrownClient</b><span>Korona przed nickiem i własne peleryny</span></div>
  </section>

  <footer>Windows 10 / 11 (64-bit) · aktualizacje przez launcher</footer>
</main>
<script src="/site.js"></script>
</body></html>`;
}

module.exports = { page, css: read('site.css'), js: read('site.js'), logo, favicon };
