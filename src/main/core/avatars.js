const invite = require('./invite');
const { USER_AGENT } = require('./util');

/**
 * Avatary kont (twarz gracza przy koncie w panelu bocznym, przełączniku kont i ustawieniach).
 *
 * Obrazek pochodzi z mc-heads.net, ale launcher NIGDY nie łączy się z tym serwisem sam (serwis poznałby adres IP gracza): prosi
 * o niego własny serwer launchera (GET /v1/avatar/…, tylko z kluczem zaproszenia), który pobiera go dalej - mc-heads.net widzi
 * wtedy adres serwera, a nie adres gracza. Bez serwera, bez klucza zaproszenia albo przy błędzie nie ma obrazka, a interfejs rysuje
 * własny, lokalny zastępnik - nigdy zapasowego połączenia wprost.
 */

const SIZE = 128;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 64 * 1024;
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-f]{32}$/;

const cache = new Map(); // id konta w serwisie -> { at, dataUrl | null }
const inflight = new Map(); // id -> Promise<dataUrl | null>

/** O co prosimy serwis: konto Microsoft - o UUID, konto offline - o nick (jak dawniej); '' = nie ma o co. */
function idOf(account) {
  if (!account) return '';
  const username = String(account.username || '');
  if (account.type === 'microsoft') {
    const uuid = String(account.uuid || '').replace(/-/g, '').toLowerCase();
    if (UUID_RE.test(uuid)) return uuid;
  }
  return NICK_RE.test(username) ? username : '';
}

async function download(base, id) {
  const url = `${base}/v1/avatar/${encodeURIComponent(id)}?size=${SIZE}`;
  const headers = invite.headersFor(url);
  if (!headers['X-Crown-Invite']) return null; // bez klucza serwer i tak odmówi
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 45 || buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Twarz konta jako data URL albo null (konto bez obrazka, brak serwera/klucza, błąd sieci). Nie rzuca.
 * Wyniki są pamiętane (udane 6 h, nieudane 10 min), a to samo konto pobierane jednocześnie - raz.
 */
async function forAccount(account) {
  const id = idOf(account);
  const base = invite.required() ? invite.builtinServer() : '';
  if (!id || !base) return null;
  const key = `${base}|${id.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.dataUrl ? OK_TTL_MS : FAIL_TTL_MS)) return hit.dataUrl;
  if (inflight.has(key)) return inflight.get(key);
  const pending = download(base, id)
    .catch(() => null)
    .then((dataUrl) => {
      cache.set(key, { at: Date.now(), dataUrl });
      return dataUrl;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

module.exports = { forAccount, idOf, SIZE };
