// Wybór backendu dla testów serwera: domyślnie server/server.js (Node), a z CROWN_BACKEND=cf - Worker na `wrangler dev`
// przez cloudflare/tests/server-shim.js (ten sam interfejs: zmienne środowiskowe, CLI, komunikat o starcie).
// Uruchomienie testu na Workerze:  CROWN_BACKEND=cf node dev-tests/<test>.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const CF = process.env.CROWN_BACKEND === 'cf';

/** Dokumenty stanu serwera (invites.json, announcements.json…): plik w DATA_DIR (Node) albo API admina Workera (cf). */
function docs(dataDir, base) {
  // dokumenty wydarzeń: „event:<id>” = events/<id>/event.json (Node) albo dokument event:<id> (Worker)
  const fileOf = (name) => (name.startsWith('event:') ? path.join(dataDir, 'events', name.slice(6), 'event.json') : path.join(dataDir, name));
  const bootKey = () => fs.readFileSync(path.join(dataDir, '.cf-boot-key'), 'utf8').trim();
  const call = async (method, name, body) => {
    const res = await fetch(`${base}/v1/admin/raw/${encodeURIComponent(name)}`, {
      method,
      headers: { Authorization: `Bearer ${bootKey()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`raw ${method} ${name}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    async read(name) {
      if (!CF) return JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
      return (await call('GET', name)).value;
    },
    /** Zawartość tak, jak leży „na dysku” (do sprawdzenia, że nie ma tam jawnych kluczy). */
    async readText(name) {
      if (!CF) return fs.readFileSync(fileOf(name), 'utf8');
      return JSON.stringify((await call('GET', name)).value);
    },
    async write(name, value) {
      if (!CF) return fs.writeFileSync(fileOf(name), JSON.stringify(value));
      await call('PUT', name, { value });
    },
  };
}

/** Usuwa katalog danych serwera; po zabiciu backendu Cloudflare pliki bywają jeszcze chwilę zablokowane przez wrangler/workerd. */
function rmDir(dir) {
  for (let i = 0; i < 60; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  CF,
  rmDir,
  serverEntry: CF ? path.join(root, 'cloudflare', 'tests', 'server-shim.js') : path.join(root, 'server', 'server.js'),
  /** liczba obrotów pętli czekania na start serwera (po 150 ms): `wrangler dev` startuje wolniej niż Node */
  startLoops: CF ? 400 : 40,
  docs,
};
