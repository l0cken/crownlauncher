#!/usr/bin/env node
/**
 * Kopiuje zbudowane jary modów do assets/mods/ i generuje manifest.json, z którego launcher
 * wie, który plik pasuje do której wersji Minecrafta.
 *
 *   node scripts/sync-bundled-mods.js "C:\Users\...\account-switcher\build\libs"
 *
 * Bezpieczeństwo: jar nie może zawierać danych logowania (tokenów, accounts.json) - skrypt to sprawdza,
 * zanim cokolwiek trafi do instalatora.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const source = path.resolve(process.argv[2] || '');
const target = path.join(__dirname, '..', 'assets', 'mods');
if (!process.argv[2] || !fs.existsSync(source)) {
  console.error('Użycie: node scripts/sync-bundled-mods.js <katalog z jarami>');
  process.exit(1);
}

// pliki o nazwach typowych dla zapisanych danych logowania (dokładne nazwy, np. accounts.json)
const SUSPICIOUS_FILE = /(^|\/)(accounts?|tokens?|session|sessions|credentials?|auth|launcher_accounts?|launcher_profiles)\.(json|dat|txt|properties|toml|ya?ml)$/i;
const SUSPICIOUS_TEXT = /accessToken|access_token|refresh_token|"token"\s*:|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;

function inspect(file) {
  const zip = new AdmZip(file);
  const meta = zip.getEntry('fabric.mod.json');
  if (!meta) throw new Error('brak fabric.mod.json');
  const json = JSON.parse(meta.getData().toString('utf8'));

  for (const e of zip.getEntries()) {
    if (e.isDirectory || /\.class$/.test(e.entryName) || e.entryName.startsWith('META-INF/jars/')) continue;
    if (SUSPICIOUS_FILE.test(e.entryName)) throw new Error(`podejrzany plik w jarze: ${e.entryName}`);
    if (e.header.size < 2_000_000 && SUSPICIOUS_TEXT.test(e.getData().toString('utf8'))) {
      throw new Error(`dane logowania w pliku: ${e.entryName}`);
    }
  }

  let icon = '';
  const iconPath = typeof json.icon === 'string' ? json.icon : '';
  const iconEntry = iconPath && zip.getEntry(iconPath);
  if (iconEntry && iconEntry.header.size < 100_000) {
    icon = `data:image/png;base64,${iconEntry.getData().toString('base64')}`;
  }
  return { json, icon };
}

fs.mkdirSync(target, { recursive: true });
for (const f of fs.readdirSync(target)) {
  if (f.endsWith('.jar')) fs.rmSync(path.join(target, f));
}

const mods = [];
for (const name of fs.readdirSync(source).filter((f) => f.endsWith('.jar')).sort()) {
  const full = path.join(source, name);
  try {
    const { json, icon } = inspect(full);
    const buf = fs.readFileSync(full);
    fs.writeFileSync(path.join(target, name), buf);
    mods.push({
      id: json.id,
      title: json.name || json.id,
      version: json.version,
      file: name,
      minecraft: json.depends?.minecraft ?? '*',
      loaders: ['fabric', 'quilt'],
      sha1: crypto.createHash('sha1').update(buf).digest('hex'),
      size: buf.length,
      authors: (json.authors || []).map((a) => (typeof a === 'string' ? a : a.name)),
      icon,
    });
    console.log(`✓ ${name}  (${json.id} ${json.version}, minecraft ${JSON.stringify(json.depends?.minecraft)}, autor: ${(json.authors || []).join(', ')})`);
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    process.exit(1);
  }
}

fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ mods }, null, 2));
console.log(`\nZapisano ${mods.length} jar(ów) i manifest w ${target}`);
