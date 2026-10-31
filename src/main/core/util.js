const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'CrownLauncher/0.1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

// Zapis atomowy: najpierw plik tymczasowy, potem rename.
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Czytelny komunikat zamiast samego „HTTP 429” (nie wiadomo, który serwer i co dalej). */
function httpFailure(url, status) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* adres nie do sparsowania */
  }
  const who = host ? `Serwer ${host}` : 'Serwer';
  if (status === 429) return `${who} chwilowo ogranicza liczbę zapytań (HTTP 429) — spróbuj za minutę.`;
  return `${who} nie odpowiada poprawnie (HTTP ${status}).`;
}

async function fetchRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let wait = 600 * (i + 1);
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        // przy limicie zapytań serwer podaje, kiedy wrócić (Retry-After); czekamy tyle, ale nie wiecej niż 15 s
        const retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
        if (res.status === 429) wait = Math.min(15000, Math.max(wait * 3, retryAfter * 1000));
        throw Object.assign(new Error(httpFailure(url, res.status)), { status: res.status });
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(wait);
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts) {
  const res = await fetchRetry(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function hashFile(file, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Pobiera plik, jeśli go nie ma lub nie zgadza się suma/rozmiar.
 * Zwraca true, gdy faktycznie coś pobrano.
 */
async function downloadFile(url, dest, { sha1, size, checkHash = true } = {}) {
  if (await exists(dest)) {
    try {
      const st = await fsp.stat(dest);
      const sizeOk = size == null || st.size === size;
      if (sizeOk && (!sha1 || !checkHash || (await hashFile(dest)) === sha1)) return false;
    } catch {
      /* pobierz ponownie */
    }
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchRetry(url, {}, 2);
      if (!res.ok) throw new Error(`Pobieranie nie powiodło się (HTTP ${res.status}): ${url}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      if (sha1 && (await hashFile(tmp)) !== sha1) {
        throw new Error(`Niezgodna suma SHA-1: ${url}`);
      }
      await fsp.rename(tmp, dest);
      return true;
    } catch (e) {
      lastErr = e;
      await fsp.rm(tmp, { force: true });
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Wykonuje worker na elementach z limitem równoległości; przerywa po pierwszym błędzie.
async function pool(items, limit, worker) {
  let next = 0;
  let firstErr = null;
  const run = async () => {
    while (!firstErr) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx);
      } catch (e) {
        firstErr = firstErr || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (firstErr) throw firstErr;
}

// group:artifact:version[:classifier][@ext] -> ścieżka względna w repozytorium Mavena
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

// token Minecrafta / Microsoft to JWT (trzy segmenty base64url, pierwszy zaczyna się od „eyJ”)
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Zastępuje podane sekrety (np. token gry) oraz wszystko wyglądające na JWT napisem „<ukryte>”. */
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8 && out.includes(s)) out = out.split(s).join('<ukryte>');
  }
  return out.includes('eyJ') ? out.replace(JWT_RE, '<ukryte>') : out;
}

// Dzieli linię argumentów JVM z uwzględnieniem cudzysłowów.
function splitArgs(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Czy ścieżka `target` leży wewnątrz katalogu `base` (ochrona przed zip-slip).
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Komunikat błędu pliku po ludzku. Windows blokuje pliki, które ma otwarte uruchomiona gra (EBUSY), a także
 * odmawia dostępu (EPERM/EACCES) - zamiast „EBUSY: resource busy or locked, rename '…'” mówimy, co zrobić.
 */
function friendlyFsError(e) {
  const code = e && e.code;
  if (code === 'EBUSY') {
    return 'Ten plik jest teraz używany (najpewniej przez uruchomioną grę), więc Windows go zablokował. Zamknij grę i spróbuj ponownie.';
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return 'Brak dostępu do pliku - używa go inny program (np. uruchomiona gra) albo nie masz do niego uprawnień. Zamknij grę i spróbuj ponownie.';
  }
  return (e && e.message) || String(e);
}

module.exports = {
  USER_AGENT,
  friendlyFsError,
  sleep,
  exists,
  readJson,
  writeJson,
  fetchRetry,
  fetchJson,
  hashFile,
  downloadFile,
  pool,
  mavenPath,
  splitArgs,
  isInside,
  redact,
};
