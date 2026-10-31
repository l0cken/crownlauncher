// Numer wersji wydania: odczyt, porównanie, podbicie w package.json i package-lock.json oraz znacznik ostatniego
// wydania (scripts/.last-release.json). Używane przez scripts/release.js w trybie GitHub i w trybie serwera.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const lockFile = path.join(root, 'package-lock.json');
const lastFile = path.join(__dirname, '.last-release.json');

const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').replace(/^v/, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compareVersions = (a, b) => {
  const x = parseVersion(a) || [0, 0, 0];
  const y = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const nextPatch = (v) => {
  const p = parseVersion(v) || [0, 0, 0];
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
};

const readLastReleased = () => {
  try {
    return String(JSON.parse(fs.readFileSync(lastFile, 'utf8')).version || '');
  } catch {
    return '';
  }
};

const markReleased = (version) => {
  try {
    fs.writeFileSync(lastFile, `${JSON.stringify({ version, at: new Date().toISOString() }, null, 2)}\n`);
  } catch {
    /* znacznik jest dodatkiem */
  }
};

/** Zmienia numer wersji w package.json i package-lock.json (dwa pierwsze wystąpienia w locku: pakiet główny). */
const writeVersion = (from, to) => {
  for (const [file, limit] of [[pkgFile, 1], [lockFile, 2]]) {
    if (!fs.existsSync(file)) continue;
    let count = 0;
    const text = fs.readFileSync(file, 'utf8').replace(new RegExp(`("version":\\s*)"${from.replace(/\./g, '\\.')}"`, 'g'), (m, pre) =>
      ++count <= limit ? `${pre}"${to}"` : m,
    );
    fs.writeFileSync(file, text);
  }
};

module.exports = { pkgFile, lockFile, lastFile, parseVersion, compareVersions, nextPatch, readLastReleased, markReleased, writeVersion };
