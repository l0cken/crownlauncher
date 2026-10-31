/**
 * Logika serwera CrownLaunchera na Cloudflare: port server/server.js (te same trasy, nagłówki i komunikaty).
 * Działa wewnątrz Durable Objecta (state.js), więc kod jest synchroniczny jak w wersji Node:
 *   - dokumenty JSON (invites.json, keys.json, players.json, announcements.json, event.json, sesje panelu) w storage.kv,
 *   - pliki w R2: updates/<plik>, events/<id>/<rodzaj>/<ścieżka>, capes/<nick>.png (skrót SHA-1 plików wydarzenia w kv: evf:…).
 * Zmiany względem VPS-a: instalator większy niż 100 MB wgrywa się częściami (POST/PUT/DELETE /v1/updates/<plik>?uploads|uploadId),
 * sesje i bilety panelu leżą w kv (DO bywa wyłączany między żądaniami), limity żądań są w pamięci (przy ataku DO jest rozgrzany),
 * pierwszy klucz admin pochodzi z sekretu BOOTSTRAP_ADMIN_KEY (zamiast CLI).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { SITE_PAGE, SITE_PAGE_ERROR } from './assets.generated.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const httpError = (status, message, close = false) => Object.assign(new Error(message), { status, close });

const MAX_BODY = 32 * 1024;
const MAX_STORED = 200;
const LIMITS = { title: 80, text: 2000, url: 500 };
const LEVELS = ['info', 'important', 'event'];
const MB = 1024 * 1024;

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 znaki bez łatwych do pomylenia (0/O, 1/I)
const INVITE_RE = /^[A-HJ-NP-Z2-9]{16}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_USES_LIMIT = 1000;
const PLAY_NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const PLAY_TTL_DEFAULT_MS = 5 * 60_000; // sesja gry wygasa tyle po ostatnim zgłoszeniu launchera (zgłasza co minutę)
const PLAY_MAX_PER_DEVICE = 4; // tyle nicków naraz z jednego komputera i klucza (np. dwa konta odpalone obok siebie)
const EVENT_ID_RE = /^[a-z0-9-]{1,32}$/;
const DEFAULT_EVENTS = { igrzyska: { title: 'IGRZYSKA ŚMIERCI' } };
const EVENT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ +()\[\]-]{0,118}$/;
const EVENT_KINDS = {
  mods: { ext: /\.jar$/i, max: 300 * MB, zip: true, label: 'Mod: plik .jar o prostej nazwie.' },
  resourcepacks: { ext: /\.zip$/i, max: 300 * MB, zip: true, label: 'Texturepack: plik .zip o prostej nazwie.' },
  shaderpacks: { ext: /\.(zip|txt)$/i, zipExt: /\.zip$/i, max: 300 * MB, label: 'Shaderpack: plik .zip (albo .txt z ustawieniami) o prostej nazwie.' },
  config: {
    ext: /\.(json5?|toml|properties|txt|cfg|conf|ini|ya?ml|xml|snbt|csv|mcmeta)$/i,
    max: 5 * MB,
    nested: true,
    enforce: true,
    label: 'Config: plik .json/.toml/.properties/.txt/.cfg… (do 4 poziomów folderów, proste nazwy).',
  },
  root: {
    names: ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'],
    max: 5 * MB,
    enforce: false,
    label: 'Plik gry: options.txt, optionsof.txt, optionsshaders.txt albo servers.dat.',
  },
};
const EVENT_KIND_RE = Object.keys(EVENT_KINDS).join('|');

const UPDATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(exe|AppImage|blockmap|yml)$/;
// wersje launchera do pobrania: plik wskazany w latest.yml (Windows, instalator .exe) albo latest-linux.yml (Linux, AppImage)
const INSTALLER_KINDS = { windows: { yml: 'latest.yml', ext: '.exe' }, linux: { yml: 'latest-linux.yml', ext: '.AppImage' } };
const MAX_UPDATE_BYTES = 400 * MB;
const MAX_PART_BYTES = 64 * MB;
// aktualizacje różnicowe (Range z wieloma zakresami): do 1000 zakresów w żądaniu, a odczytów z R2 najwyżej MAX_WINDOWS na odpowiedź
// (limit subżądań na jedno wywołanie Workera) - bliskie zakresy łączymy w okna, luki między nimi są czytane i odrzucane po stronie serwera
const MAX_RANGES = 1000;
const MAX_WINDOWS = 30;
const MERGE_GAP = 1024 * 1024;

const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const MAX_CAPE_BYTES = 1024 * 1024;
const MAX_CAPES = 5000;
const PRESENCE_DAYS = 60;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PROOF_TTL_MS = 10 * 60_000;

// Avatary kont przez serwer: launcher prosi o twarz gracza własny serwer, a ten pobiera ją z mc-heads.net - serwis widzi wtedy adres
// serwera, a nie adres IP gracza. Identyfikator to nick albo UUID (z kreskami lub bez); rozmiar zaokrąglamy w górę do jednego z kilku
// (więcej trafień w pamięci podręcznej); odpowiedź serwisu musi być małym PNG.
const AVATAR_ID_RE = /^(?:[A-Za-z0-9_]{1,16}|[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const AVATAR_SIZES = [32, 64, 128, 256];
const AVATAR_DEFAULT_SIZE = 128;
const AVATAR_MAX_BYTES = 64 * 1024;
const AVATAR_OK_TTL_MS = 6 * 3600_000;
const AVATAR_FAIL_TTL_MS = 10 * 60_000;
const AVATAR_MAX_CACHED = 300;
const avatarSize = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AVATAR_DEFAULT_SIZE;
  return AVATAR_SIZES.find((s) => s >= n) || AVATAR_SIZES[AVATAR_SIZES.length - 1];
};

const PANEL_SESSION_MS = 8 * 3600_000;
const PANEL_TICKET_MS = 60_000;
const RELEASED_MESSAGE = 'Ten komputer został odłączony od klucza przez administratora. Wpisz klucz ponownie, aby go użyć.';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/** Pierwsze n bajtów strumienia + strumień „od początku” (do sprawdzenia nagłówka PK bez buforowania całości). */
async function peek(body, n) {
  const reader = body.getReader();
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  const head = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, n);
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream };
}

export function createApp({ kv, bucket, env }) {
  const INVITE_ONLY = env.INVITE_ONLY === '1';
  const REQUIRE_DEVICE = env.REQUIRE_DEVICE === '1';
  const PLAY_TTL_MS = Math.max(1000, Number(env.PLAY_TTL_MS) || PLAY_TTL_DEFAULT_MS); // PLAY_TTL_MS - tylko testy
  const MC_HASJOINED_URL = env.MC_HASJOINED_URL || 'https://sessionserver.mojang.com/session/minecraft/hasJoined';
  const AVATAR_UPSTREAM = String(env.AVATAR_UPSTREAM || 'https://mc-heads.net').replace(/\/+$/, ''); // AVATAR_UPSTREAM - tylko testy

  // ---- storage ------------------------------------------------------------------
  const readJson = (name, fallback) => {
    const v = kv.get(name);
    return v === undefined ? fallback : v;
  };
  const writeJson = (name, data) => kv.put(name, data);

  const loadKeys = () => readJson('keys.json', []);
  const loadAnnouncements = () => readJson('announcements.json', []);
  const loadInvites = () => readJson('invites.json', []).map(normalizeInviteEntry);
  const loadPlayers = () => readJson('players.json', {});
  const savePlayers = (players) => writeJson('players.json', players);

  /** Pierwszy klucz admin (zamiast CLI create-key): sekret BOOTSTRAP_ADMIN_KEY, tylko gdy nie ma żadnego klucza. */
  let bootstrapChecked = false;
  function bootstrap() {
    if (bootstrapChecked) return;
    bootstrapChecked = true;
    if (!env.BOOTSTRAP_ADMIN_KEY || loadKeys().length) return;
    writeJson('keys.json', [{ id: randomBytes(4).toString('hex'), name: 'Bootstrap', role: 'admin', hash: sha256(env.BOOTSTRAP_ADMIN_KEY), createdAt: new Date().toISOString() }]);
  }

  // ---- zaproszenia --------------------------------------------------------------
  /** „crown-abcd efgh…” → „ABCDEFGH…” (wielkość liter, myślniki i spacje nie mają znaczenia). */
  const normalizeInvite = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CROWN/, '');

  function newInviteKey() {
    let s = '';
    for (let i = 0; i < 16; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
    return s; // 80 bitów
  }

  const formatInvite = (norm) => `CROWN-${norm.match(/.{4}/g).join('-')}`;

  function findInvite(raw) {
    const norm = normalizeInvite(raw);
    if (!INVITE_RE.test(norm)) return null;
    const given = Buffer.from(sha256(norm), 'hex');
    let found = null;
    for (const inv of loadInvites()) {
      const stored = Buffer.from(inv.hash, 'hex');
      if (!inv.revoked && stored.length === given.length && timingSafeEqual(stored, given)) found = inv;
    }
    return found;
  }

  const deviceHash = (device) => sha256(`crown-device:${device}`);

  /** Wpis zaproszenia w aktualnym formacie (dawne wpisy: jeden deviceHash, bez limitu i wygaśnięcia). */
  function normalizeInviteEntry(e) {
    if (!Array.isArray(e.devices)) {
      e.devices = e.deviceHash
        ? [{ hash: e.deviceHash, firstAt: e.activatedAt || e.createdAt, lastAt: e.lastSeenAt || e.activatedAt || e.createdAt }]
        : [];
      delete e.deviceHash;
      delete e.activatedAt;
    }
    if (!Number.isInteger(e.maxUses) || e.maxUses < 0) e.maxUses = 1;
    if (!e.expiresAt) e.expiresAt = null;
    if (typeof e.note !== 'string') e.note = '';
    if (typeof e.profile !== 'string') e.profile = '';
    if (!Array.isArray(e.released)) e.released = [];
    if (typeof e.capes !== 'boolean') e.capes = false;
    if (!Array.isArray(e.capeNicks)) e.capeNicks = [];
    if (typeof e.disableClient !== 'boolean') e.disableClient = false;
    return e;
  }

  const isExpired = (inv) => Boolean(inv.expiresAt) && Date.parse(inv.expiresAt) <= Date.now();

  /** revoked | expired | unused (nikt jeszcze nie użył) | full (wszystkie użycia zajęte) | activated */
  function inviteStatus(inv) {
    if (inv.revoked) return 'revoked';
    if (isExpired(inv)) return 'expired';
    if (!inv.devices.length) return 'unused';
    if (inv.maxUses > 0 && inv.devices.length >= inv.maxUses) return 'full';
    return 'activated';
  }

  const usedMessage = (inv) =>
    inv.maxUses === 1
      ? 'Ten klucz został już użyty na innym komputerze. Poproś administratora o nowy klucz.'
      : `Ten klucz został już użyty na maksymalnej liczbie komputerów (${inv.maxUses}). Poproś administratora o nowy klucz.`;

  function parseInviteFields(body, { create = false } = {}) {
    const values = {};
    if (create || body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) return { error: 'Podaj nick albo nazwę osoby.' };
      if (name.length > 40) return { error: 'Nazwa może mieć maks. 40 znaków.' };
      values.name = name;
    }
    if (body.note !== undefined) {
      const note = String(body.note ?? '').trim();
      if (note.length > 200) return { error: 'Notatka może mieć maks. 200 znaków.' };
      values.note = note;
    }
    if (body.profile !== undefined) {
      // '' = pełny dostęp do launchera; id wydarzenia = klucz „kodu wydarzenia” (np. igrzyska)
      const profile = String(body.profile ?? '').trim().toLowerCase();
      if (profile && !EVENT_ID_RE.test(profile)) return { error: 'Niepoprawny profil klucza.' };
      if (profile && !eventExists(profile)) return { error: `Nie ma wydarzenia „${profile}”.` };
      values.profile = profile;
    }
    if (body.capes !== undefined) {
      if (typeof body.capes !== 'boolean') return { error: 'Dostęp do peleryn: włączony albo wyłączony.' };
      values.capes = body.capes;
    }
    if (body.disableClient !== undefined) {
      if (typeof body.disableClient !== 'boolean') return { error: 'Wyłączanie CrownClienta: dozwolone albo nie.' };
      values.disableClient = body.disableClient;
    }
    if (body.maxUses !== undefined && body.maxUses !== null) {
      const n = Number(body.maxUses);
      if (!Number.isInteger(n) || n < 0 || n > MAX_USES_LIMIT) return { error: `Liczba użyć: od 1 do ${MAX_USES_LIMIT} (0 = bez limitu).` };
      values.maxUses = n;
    }
    if (body.expiresInDays !== undefined && body.expiresInDays !== null && body.expiresInDays !== '') {
      const d = Number(body.expiresInDays);
      if (!Number.isInteger(d) || d < 1 || d > 3650) return { error: 'Ważność: od 1 do 3650 dni.' };
      values.expiresAt = new Date(Date.now() + d * 86400_000).toISOString();
    } else if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') values.expiresAt = null;
      else {
        const t = Date.parse(String(body.expiresAt));
        if (Number.isNaN(t) || t > Date.parse('2100-01-01T00:00:00Z')) return { error: 'Niepoprawna data wygaśnięcia.' };
        values.expiresAt = new Date(t).toISOString();
      }
    }
    return { values };
  }

  function createInvite(name, fields = {}) {
    const norm = newInviteKey();
    const invites = loadInvites();
    const entry = {
      id: randomBytes(4).toString('hex'),
      name,
      note: fields.note || '',
      hash: sha256(norm),
      createdAt: new Date().toISOString(),
      maxUses: fields.maxUses ?? 1,
      expiresAt: fields.expiresAt || null,
      profile: fields.profile || '',
      capes: fields.capes === true,
      capeNicks: [],
      disableClient: fields.disableClient === true,
      devices: [],
    };
    invites.push(entry);
    writeJson('invites.json', invites);
    return { entry, key: formatInvite(norm) };
  }

  /** Zmienia wpis zaproszenia (bez await między odczytem a zapisem). Zwraca wpis albo null; mutate zwracające false nic nie zapisuje. */
  function updateInvite(id, mutate) {
    const all = loadInvites();
    const entry = all.find((x) => x.id === id);
    if (!entry) return null;
    if (mutate(entry, all) !== false) writeJson('invites.json', all);
    return entry;
  }

  /** Zapamiętuje, kiedy klucz i ten komputer byli ostatnio użyci (zapis co najwyżej raz na godzinę - sprawdzamy to w danych, nie w pamięci). */
  function touchInvite(inv, hash = '') {
    const now = Date.now();
    const recent = (iso) => now - (Date.parse(iso) || 0) < 3_600_000;
    const dev = hash ? inv.devices.find((x) => x.hash === hash) : null;
    if (recent(inv.lastSeenAt) && (!dev || recent(dev.lastAt))) return;
    updateInvite(inv.id, (e) => {
      const iso = new Date(now).toISOString();
      e.lastSeenAt = iso;
      const d = hash && e.devices.find((x) => x.hash === hash);
      if (d) d.lastAt = iso;
    });
  }

  const hasFeature = (req, name) => String(req?.headers?.['x-crown-features'] || '').split(',').some((f) => f.trim() === name);

  /**
   * Sprawdza klucz zaproszenia dla komputera. `req` (opcjonalnie) niesie nagłówki launchera: X-Crown-Features z „release”
   * (launcher potrafi pokazać ekran z kluczem po odłączeniu) i X-Crown-Entry: 1 (gracz właśnie sam wpisał klucz).
   */
  function checkInvite(rawKey, rawDevice, req = null) {
    const inv = rawKey ? findInvite(rawKey) : null;
    if (!inv) return { ok: false, status: 401, error: 'Nieprawidłowy lub unieważniony klucz zaproszenia.' };
    if (isExpired(inv)) return { ok: false, status: 401, error: 'Ten klucz wygasł. Poproś administratora o nowy klucz.', expired: true };
    const device = String(rawDevice || '');
    if (!device) {
      if (REQUIRE_DEVICE) {
        return { ok: false, status: 401, error: 'Ten launcher jest przestarzały. Wejdź na stronę launchera i pobierz nowy.' };
      }
      if (inv.devices.length) return { ok: false, status: 409, error: usedMessage(inv) };
      touchInvite(inv);
      return { ok: true, inv, activated: false }; // launcher sprzed wiązania kluczy
    }
    if (!DEVICE_RE.test(device)) return { ok: false, status: 401, error: 'Niepoprawny identyfikator komputera.' };
    const hash = deviceHash(device);
    // „Zwolnij” w panelu: komputer jest odłączony od klucza (patrz komentarz w server/server.js)
    if ((inv.released || []).includes(hash)) {
      if (hasFeature(req, 'release') && req.headers['x-crown-entry'] !== '1') return { ok: false, status: 401, error: RELEASED_MESSAGE, released: true };
      updateInvite(inv.id, (e) => { e.released = (e.released || []).filter((h) => h !== hash); });
    }
    if (!inv.devices.some((d) => d.hash === hash)) {
      let added = false;
      updateInvite(inv.id, (e) => {
        if (e.devices.some((d) => d.hash === hash)) {
          added = true;
          return false;
        }
        if (e.maxUses === 0 || e.devices.length < e.maxUses) {
          const iso = new Date().toISOString();
          e.devices.push({ hash, firstAt: iso, lastAt: iso });
          added = true;
          return true;
        }
        return false;
      });
      if (!added) return { ok: false, status: 409, error: usedMessage(inv) };
    }
    touchInvite(inv, hash);
    return { ok: true, inv, activated: true };
  }

  // ---- bramka serwera gry: sesje graczy z launchera ----------------------------------
  // Launcher zgłasza grę (POST /v1/play) przy starcie i co minutę, dopóki proces gry działa. Plugin na proxy Minecrafta
  // (CrownGate) pyta GET /v1/gate/check?nick=… kluczem bramki i wpuszcza tylko graczy z aktywną sesją, której klucz zaproszenia
  // jest nadal ważny (unieważnienie, wygaśnięcie i „Zwolnij” działają od razu przy następnym wejściu).
  // Sesja „z wydarzenia” (np. instancja IGRZYSKA ŚMIERCI) to osobny wpis `playev:<nick>:<wydarzenie>`: zgłasza ją tylko klucz z
  // profilem tego wydarzenia (kod wydarzenia), a plugin proxy może wymagać właśnie jej (GET /v1/gate/check?event=…). Zwykła sesja
  // (`play:<nick>`) powstaje przy każdym starcie gry, więc gracz grający z innej instancji nie przejdzie bramki wydarzenia.
  const playKey = (nick) => `play:${nick.toLowerCase()}`;
  const playEventKey = (nick, event) => `playev:${nick.toLowerCase()}:${event}`;

  function activePlays() {
    const now = Date.now();
    const out = [];
    for (const [k, v] of kv.list({ prefix: 'play:' })) {
      if (v.exp < now) kv.delete(k);
      else out.push(v);
    }
    return out;
  }

  function activeEventPlays() {
    const now = Date.now();
    const out = [];
    for (const [k, v] of kv.list({ prefix: 'playev:' })) {
      if (v.exp < now) kv.delete(k);
      else out.push(v);
    }
    return out;
  }

  /** Powód odmowy dla sesji (klucz unieważniony, wygasły, komputer zwolniony) albo '' gdy klucz nadal jest ważny. */
  function sessionProblem(p) {
    if (p.inviteId) {
      const inv = loadInvites().find((x) => x.id === p.inviteId);
      if (!inv || inv.revoked) return 'revoked';
      if (isExpired(inv)) return 'expired';
      if (p.dev && (inv.released || []).includes(p.dev)) return 'released';
    } else if (p.keyId) {
      const k = loadKeys().find((x) => x.id === p.keyId);
      if (!k || k.revoked) return 'revoked';
    }
    return '';
  }

  /**
   * Czy nick ma teraz prawo wejść na serwer: aktywna sesja launchera + ważny klucz, z którego ją zgłoszono. Z `event` wymagana jest
   * sesja z instancji tego wydarzenia (inaczej `wrong-instance` - gracz gra z CrownLaunchera, ale nie z tej instancji).
   */
  function gateVerdict(nick, event = '') {
    const now = Date.now();
    const p = kv.get(playKey(nick));
    if (!p || p.exp < now) return { allowed: false, reason: 'no-session' };
    const problem = sessionProblem(p);
    if (problem) return { allowed: false, reason: problem };
    if (!event) return { allowed: true, by: p.by, since: p.at };
    const e = kv.get(playEventKey(nick, event));
    if (!e || e.exp < now) return { allowed: false, reason: 'wrong-instance' };
    const eventProblem = sessionProblem(e);
    if (eventProblem) return { allowed: false, reason: eventProblem };
    return { allowed: true, by: e.by, since: e.at, event };
  }

  /** Klucz bramki (jedyny, pokazywany raz przy utworzeniu; na dysku tylko skrót) – ma go plugin na proxy. */
  function gateKeyValid(given) {
    const gate = readJson('gate.json', null);
    if (!gate || typeof given !== 'string' || given.length < 20 || given.length > 200) return false;
    const a = Buffer.from(sha256(given), 'hex');
    const b = Buffer.from(gate.hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- wydarzenia ---------------------------------------------------------------
  const eventExists = (id) => Boolean(DEFAULT_EVENTS[id]) || kv.get(`event:${id}`) !== undefined;

  /** Ścieżka pliku wydarzenia względem katalogu rodzaju ('sub/x.json') albo '' gdy niepoprawna dla tego rodzaju. */
  function eventRel(kind, raw) {
    const spec = EVENT_KINDS[kind];
    if (!spec || typeof raw !== 'string' || !raw || raw.length > 200) return '';
    const parts = raw.split('/');
    if (parts.length > (spec.nested ? 4 : 1) || !parts.every((p) => EVENT_FILE_RE.test(p))) return '';
    const last = parts[parts.length - 1];
    if (spec.names) return spec.names.includes(last) ? raw : '';
    return spec.ext.test(last) ? raw : '';
  }

  function eventMeta(id) {
    const saved = readJson(`event:${id}`, {});
    const enforce = {};
    for (const [k, v] of Object.entries(saved.enforce && typeof saved.enforce === 'object' ? saved.enforce : {})) {
      if (typeof v === 'boolean' && /^(config|root)\//.test(k)) enforce[k] = v;
    }
    return {
      title: String(saved.title || DEFAULT_EVENTS[id]?.title || id).slice(0, 60),
      mcVersion: String(saved.mcVersion || ''),
      loader: 'fabric',
      crownClient: saved.crownClient !== false,
      note: String(saved.note || '').slice(0, 300),
      enforce,
    };
  }

  /** Pliki wydarzenia: { mods, resourcepacks, shaderpacks, config, root } - [{name,size,sha1[,enforce]}] po nazwie. */
  function eventFiles(id) {
    const meta = eventMeta(id);
    const out = {};
    let updatedAt = 0;
    for (const kind of Object.keys(EVENT_KINDS)) {
      const spec = EVENT_KINDS[kind];
      const prefix = `evf:${id}:${kind}:`;
      const rows = [];
      for (const [k, v] of kv.list({ prefix })) rows.push({ name: k.slice(prefix.length), ...v });
      out[kind] = rows
        .filter((r) => eventRel(kind, r.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => {
          updatedAt = Math.max(updatedAt, r.mtime || 0);
          const entry = { name: r.name, size: r.size, sha1: r.sha1 };
          if ('enforce' in spec) {
            const flag = meta.enforce[`${kind}/${r.name}`];
            entry.enforce = typeof flag === 'boolean' ? flag : spec.enforce;
          }
          return entry;
        });
    }
    return { ...out, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null };
  }

  function eventManifest(id) {
    const { enforce: _flags, ...meta } = eventMeta(id);
    const files = eventFiles(id);
    const out = { id, ...meta, updatedAt: files.updatedAt };
    for (const kind of Object.keys(EVENT_KINDS)) out[kind] = files[kind];
    return out;
  }

  const eventReady = (m) => Boolean(m.mcVersion && Object.keys(EVENT_KINDS).some((k) => m[k].length));

  /** Zapis pliku wydarzenia strumieniem do R2 z liczeniem SHA-1 w locie (limit rozmiaru zależy od rodzaju). */
  async function receiveEventFile(req, eventId, kind, rel) {
    const spec = EVENT_KINDS[kind];
    const size = Number(req.headers['content-length']);
    if (!Number.isInteger(size) || size < 0) throw httpError(400, 'Wymagany nagłówek Content-Length.');
    if (size === 0) throw httpError(400, 'Pusty plik.');
    if (size > spec.max) throw httpError(413, `Plik jest zbyt duży (maks. ${Math.round(spec.max / MB)} MB).`, true);
    const { head, stream } = await peek(req.raw.body, 4);
    // .jar i .zip to archiwa ZIP - nagłówek „PK”
    const needsZip = spec.zip || (spec.zipExt && spec.zipExt.test(rel));
    if (needsZip && (head[0] !== 0x50 || head[1] !== 0x4b)) throw httpError(400, 'To nie jest archiwum ZIP/JAR.');
    try {
      const digest = new crypto.DigestStream('SHA-1');
      const [a, b] = stream.tee();
      const fixed = new FixedLengthStream(size);
      const put = bucket.put(`events/${eventId}/${kind}/${rel}`, fixed.readable);
      await Promise.all([a.pipeTo(fixed.writable), b.pipeTo(digest), put]);
      kv.put(`evf:${eventId}:${kind}:${rel}`, { size, sha1: hex(await digest.digest), mtime: Date.now() });
    } catch (e) {
      if (e.status) throw e;
      throw httpError(500, 'Nie udało się zapisać pliku.');
    }
    return send(201, { ok: true, name: rel, size, event: eventManifest(eventId) });
  }

  /**
   * Duże pliki wydarzenia (> 100 MB nie przejdą jednym żądaniem przez Cloudflare), tak samo jak aktualizacje: POST …?uploads →
   * {uploadId}; PUT …?uploadId=ID&part=N (do 64 MB; pierwsza część sprawdza nagłówek „PK”); POST …?uploadId=ID {parts} → 201
   * (SHA-1 liczy serwer, strumieniem z R2 - nie ufamy sumie od klienta); DELETE …?uploadId=ID przerywa.
   */
  async function receiveEventMultipart(req, eventId, kind, rel, url) {
    const spec = EVENT_KINDS[kind];
    const objKey = `events/${eventId}/${kind}/${rel}`;
    const params = url.searchParams;
    const uploadId = params.get('uploadId');
    const needsZip = spec.zip || (spec.zipExt && spec.zipExt.test(rel));
    if (req.method === 'POST' && params.has('uploads')) {
      const mpu = await bucket.createMultipartUpload(objKey, { httpMetadata: { contentType: 'application/octet-stream' } });
      return send(201, { uploadId: mpu.uploadId });
    }
    if (!uploadId || !/^[A-Za-z0-9._~+/=-]{8,512}$/.test(uploadId)) return send(400, { error: 'Niepoprawny uploadId.' });
    const mpu = bucket.resumeMultipartUpload(objKey, uploadId);
    if (req.method === 'PUT') {
      const part = Number(params.get('part'));
      if (!Number.isInteger(part) || part < 1 || part > 10000) return send(400, { error: 'Numer części: od 1 do 10000.' });
      const data = await readLimited(req.raw, MAX_PART_BYTES, 'Część jest zbyt duża.');
      if (!data.length) return send(400, { error: 'Pusta część.' });
      if (part === 1 && needsZip && (data[0] !== 0x50 || data[1] !== 0x4b)) return send(400, { error: 'To nie jest archiwum ZIP/JAR.' });
      const uploaded = await mpu.uploadPart(part, data);
      return send(200, { partNumber: uploaded.partNumber, etag: uploaded.etag });
    }
    if (req.method === 'DELETE') {
      await mpu.abort();
      return send(204);
    }
    if (req.method !== 'POST') return send(404, { error: 'Nie znaleziono.' });
    const body = await readBody(req);
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (!parts.length || parts.length > 10000 || !parts.every((p) => Number.isInteger(p.partNumber) && typeof p.etag === 'string')) {
      return send(400, { error: 'Podaj listę części {partNumber, etag}.' });
    }
    const done = await mpu.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
    if (done.size > spec.max || done.size === 0) {
      await bucket.delete(objKey);
      return send(done.size ? 413 : 400, { error: done.size ? `Plik jest zbyt duży (maks. ${Math.round(spec.max / MB)} MB).` : 'Pusty plik.' });
    }
    const obj = await bucket.get(objKey);
    const digest = new crypto.DigestStream('SHA-1');
    await obj.body.pipeTo(digest);
    kv.put(`evf:${eventId}:${kind}:${rel}`, { size: done.size, sha1: hex(await digest.digest), mtime: Date.now() });
    return send(201, { ok: true, name: rel, size: done.size, event: eventManifest(eventId) });
  }

  // ---- avatary kont (przekaźnik do mc-heads.net) ---------------------------------------------------
  const avatarCache = new Map(); // "id:rozmiar" -> { at, png | null }
  const avatarInflight = new Map(); // "id:rozmiar" -> Promise<png | null>

  /** Czyta ciało odpowiedzi, ale najwyżej `max` bajtów (więcej = null). */
  async function readCapped(res, max) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  async function loadAvatar(id, size) {
    try {
      // do serwisu nie dokładamy niczego z żądania gracza (adres IP, nagłówki, klucz) - tylko ścieżkę i neutralny User-Agent;
      // przekierowań nie podążamy (odpowiedź ma przyjść z tego jednego adresu)
      const res = await fetch(`${AVATAR_UPSTREAM}/avatar/${encodeURIComponent(id)}/${size}`, {
        headers: { 'User-Agent': 'CrownLauncher-avatars', Accept: 'image/png' },
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        cf: { cacheEverything: true, cacheTtl: 6 * 3600 },
      });
      if (res.status !== 200 || !res.body) return null;
      const buf = await readCapped(res, AVATAR_MAX_BYTES);
      const png = buf && buf.length >= 45 && buf.subarray(0, 8).equals(PNG_SIG) && buf.readUInt32BE(8) === 13 && buf.toString('ascii', 12, 16) === 'IHDR';
      return png && buf.readUInt32BE(16) <= 1024 && buf.readUInt32BE(20) <= 1024 ? buf : null;
    } catch {
      return null; // serwis nie odpowiada: launcher pokaże własny zastępnik
    }
  }

  /** PNG twarzy gracza (z pamięci podręcznej albo z serwisu) albo null. Jedno pobranie naraz na obrazek. */
  function avatarPng(id, size) {
    const cacheKey = `${id.toLowerCase()}:${size}`;
    const hit = avatarCache.get(cacheKey);
    if (hit && Date.now() - hit.at < (hit.png ? AVATAR_OK_TTL_MS : AVATAR_FAIL_TTL_MS)) return Promise.resolve(hit.png);
    let pending = avatarInflight.get(cacheKey);
    if (!pending) {
      pending = loadAvatar(id, size)
        .then((png) => {
          if (avatarCache.size >= AVATAR_MAX_CACHED) avatarCache.delete(avatarCache.keys().next().value);
          avatarCache.set(cacheKey, { at: Date.now(), png });
          return png;
        })
        .finally(() => avatarInflight.delete(cacheKey));
      avatarInflight.set(cacheKey, pending);
    }
    return pending;
  }

  // ---- HTTP ---------------------------------------------------------------------
  const buckets = new Map(); // ograniczanie liczby żądań: "klucz" -> { count, resetAt }
  function rateLimited(name, limit, windowMs = 60_000) {
    const now = Date.now();
    if (buckets.size > 2000) for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
    let b = buckets.get(name);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(name, b);
    }
    b.count += 1;
    return b.count > limit;
  }

  const clientIp = (req) => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  function authenticate(req) {
    const m = /^Bearer\s+(\S{10,200})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const given = Buffer.from(sha256(m[1]), 'hex');
    let found = null;
    for (const k of loadKeys()) {
      const stored = Buffer.from(k.hash, 'hex');
      if (!k.revoked && stored.length === given.length && timingSafeEqual(stored, given)) found = k;
    }
    return found;
  }

  /** Czy żądanie ma dostęp do zasobów prywatnych (INVITE_ONLY): klucz administracji (Bearer) albo ważny klucz zaproszenia. */
  function invited(req) {
    if (!INVITE_ONLY) return true;
    if (authenticate(req)) return true;
    const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
    req.inviteAccess = access;
    return access.ok;
  }

  function send(status, body, { headers = {} } = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Response(status === 204 || status === 304 ? null : payload, {
      status,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const sendHtml = (status, html) => new Response(html, { status, headers: HTML_HEADERS });
  const downloadPage = (error = '') => (error ? SITE_PAGE_ERROR[0] + esc(error) + SITE_PAGE_ERROR[1] : SITE_PAGE);

  /** Odpowiedź dla żądania bez prawa dostępu; nieudane próby liczymy osobno (ochrona przed zgadywaniem). */
  function denyInvite(ip, req) {
    if (rateLimited(`invite:${ip}`, 30)) return send(429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
    const a = req?.inviteAccess;
    if (a && !a.ok && a.status === 409) return send(409, { error: a.error });
    return send(401, { error: a?.error || 'Wymagany klucz zaproszenia.' });
  }

  /** Treść żądania do `max` bajtów (nagłówek Content-Length i faktyczny rozmiar). */
  async function readLimited(request, max, tooLargeMessage = 'Zbyt duże żądanie.') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > max) throw httpError(413, tooLargeMessage, true);
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        throw httpError(413, tooLargeMessage, true);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async function readBody(req) {
    const buf = await readLimited(req.raw, MAX_BODY);
    try {
      return JSON.parse(buf.toString('utf8') || '{}');
    } catch {
      throw httpError(400, 'Niepoprawny JSON.');
    }
  }

  async function readForm(req) {
    const buf = await readLimited(req.raw, 2048);
    return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  }

  function httpsUrl(value, field) {
    if (value === undefined || value === null || value === '') return '';
    const s = String(value).trim();
    if (s.length > LIMITS.url) throw httpError(400, `Pole „${field}” jest za długie.`);
    let u;
    try {
      u = new URL(s);
    } catch {
      throw httpError(400, `Pole „${field}” musi być poprawnym adresem URL.`);
    }
    if (u.protocol !== 'https:') throw httpError(400, `Pole „${field}” musi zaczynać się od https://`);
    return u.href;
  }

  function validateAnnouncement(body) {
    const title = String(body.title ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!title) throw httpError(400, 'Podaj tytuł ogłoszenia.');
    if (title.length > LIMITS.title) throw httpError(400, `Tytuł może mieć maks. ${LIMITS.title} znaków.`);
    if (text.length > LIMITS.text) throw httpError(400, `Treść może mieć maks. ${LIMITS.text} znaków.`);
    const level = body.level ?? 'info';
    if (!LEVELS.includes(level)) throw httpError(400, 'Niepoprawny rodzaj ogłoszenia.');
    const days = body.expiresInDays;
    if (days != null && days !== 0 && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      throw httpError(400, 'Czas wygaśnięcia: liczba dni od 1 do 365 albo brak.');
    }
    return {
      title,
      text,
      image: httpsUrl(body.image, 'obraz'),
      link: httpsUrl(body.link, 'link'),
      level,
      pinned: Boolean(body.pinned),
      expiresAt: days ? new Date(Date.now() + days * 86400_000).toISOString() : null,
    };
  }

  function publicView(a, key) {
    const out = {
      id: a.id, title: a.title, text: a.text, image: a.image, link: a.link, level: a.level, pinned: a.pinned,
      author: a.author, createdAt: a.createdAt, expiresAt: a.expiresAt,
    };
    if (key && (key.role === 'admin' || key.id === a.keyId)) out.canDelete = true;
    return out;
  }

  // ---- aktualizacje launchera (electron-updater, provider "generic") w R2 -----------------
  /** Nazwa najnowszego instalatora (Windows: .exe z latest.yml; `kind: 'linux'`: .AppImage z latest-linux.yml), albo '' gdy nic nie wgrano. */
  async function latestInstaller(kind = 'windows') {
    const { yml: ymlName, ext } = INSTALLER_KINDS[kind] || INSTALLER_KINDS.windows;
    const obj = await bucket.get(`updates/${ymlName}`);
    if (!obj) return '';
    const yml = await obj.text();
    const candidates = [
      /^path:\s*(.+)$/m.exec(yml)?.[1],
      ...[...yml.matchAll(/^\s*(?:- )?url:\s*(.+)$/gm)].map((m) => m[1]),
    ];
    for (const c of candidates) {
      const name = String(c || '').trim().replace(/^['"]|['"]$/g, '');
      if (UPDATE_FILE_RE.test(name) && name.endsWith(ext) && (await bucket.head(`updates/${name}`))) return name;
    }
    return '';
  }

  /**
   * Nagłówek `Range: bytes=a-b, c-d, …` (electron-updater prosi tak o zmienione bloki instalatora, do 1000 zakresów naraz).
   * Zwraca { ranges } (rosnące, rozłączne, w granicach pliku), 'unsatisfiable' albo null, gdy nagłówek jest niepoprawny albo
   * zakresy nachodzą na siebie / są nie po kolei - wtedy serwer ignoruje Range i oddaje cały plik (jak RFC 7233 pozwala).
   */
  function parseMultiRange(header, size) {
    const specs = header.slice('bytes='.length).split(',').map((s) => s.trim());
    if (specs.length < 2 || specs.length > MAX_RANGES) return null;
    const ranges = [];
    for (const s of specs) {
      const m = /^(\d*)-(\d*)$/.exec(s);
      if (!m || (!m[1] && !m[2])) return null;
      if (m[1] === '') {
        const n = Number(m[2]);
        if (n === 0) return null;
        ranges.push({ start: Math.max(0, size - n), end: size - 1 });
      } else {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (Number(m[2] || 0) && Number(m[2]) < start) return null; // „5-2” jest niepoprawne
        if (start >= size) continue; // niespełnialny zakres pomijamy
        ranges.push({ start, end });
      }
    }
    if (!ranges.length) return 'unsatisfiable';
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start <= ranges[i - 1].end) return null;
    return { ranges };
  }

  /**
   * Zakresy zebrane w okna odczytu z R2 (po jednym odczycie na okno). Luki do MERGE_GAP bajtów łączymy zawsze (odczyt jest tańszy niż
   * kolejne żądanie do R2); gdy okien nadal jest za dużo (MAX_WINDOWS), łączymy najmniejsze z pozostałych luk - to najmniej zbędnych
   * bajtów do przeczytania i odrzucenia. Luki wewnątrz okna są czytane z R2, ale do klienta nie idą.
   */
  function planWindows(ranges) {
    const gaps = ranges.slice(1).map((r, i) => ({ i, gap: r.start - ranges[i].end - 1 }));
    const merged = new Set(gaps.filter((g) => g.gap <= MERGE_GAP).map((g) => g.i));
    let count = ranges.length - merged.size;
    if (count > MAX_WINDOWS) {
      for (const g of gaps.filter((x) => !merged.has(x.i)).sort((a, b) => a.gap - b.gap)) {
        merged.add(g.i);
        if (--count <= MAX_WINDOWS) break;
      }
    }
    const windows = [];
    ranges.forEach((r, i) => {
      if (i > 0 && merged.has(i - 1)) {
        const w = windows[windows.length - 1];
        w.end = r.end;
        w.ranges.push(r);
      } else windows.push({ start: r.start, end: r.end, ranges: [r] });
    });
    return windows;
  }

  /** Odpowiedź 206 multipart/byteranges ze strumienia z R2 (dokładnie jedna część na zakres, w kolejności zapytania). */
  function multipartResponse(objKey, size, ranges, baseHeaders) {
    const boundary = crypto.randomUUID().replace(/-/g, '');
    const enc = new TextEncoder();
    const heads = ranges.map((r, i) => enc.encode(`${i ? '\r\n' : ''}--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${r.start}-${r.end}/${size}\r\n\r\n`));
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const length = heads.reduce((n, h) => n + h.length, 0) + ranges.reduce((n, r) => n + (r.end - r.start + 1), 0) + tail.length;
    const windows = planWindows(ranges);

    async function* body() {
      let part = 0;
      for (const w of windows) {
        const obj = await bucket.get(objKey, { range: { offset: w.start, length: w.end - w.start + 1 } });
        if (!obj) throw new Error('plik zniknął w trakcie odczytu');
        const reader = obj.body.getReader();
        let chunk = new Uint8Array(0);
        let off = 0;
        // następny kawałek strumienia, najwyżej `max` bajtów (null = koniec)
        const take = async (max) => {
          if (off >= chunk.length) {
            const { done, value } = await reader.read();
            if (done) return null;
            chunk = value;
            off = 0;
          }
          const piece = chunk.subarray(off, off + max);
          off += piece.length;
          return piece;
        };
        try {
          let pos = w.start;
          for (const r of w.ranges) {
            for (let skip = r.start - pos; skip > 0; ) {
              const piece = await take(skip);
              if (!piece) throw new Error('R2 zakończył odczyt za wcześnie');
              skip -= piece.length;
            }
            yield heads[part++];
            for (let left = r.end - r.start + 1; left > 0; ) {
              const piece = await take(left);
              if (!piece) throw new Error('R2 zakończył odczyt za wcześnie');
              left -= piece.length;
              yield piece;
            }
            pos = r.end + 1;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      yield tail;
    }

    const it = body();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        return it.return();
      },
    });
    // FixedLengthStream wymusza dokładną długość (i nagłówek Content-Length) - bez tego odpowiedź szłaby „chunked”
    const fixed = new FixedLengthStream(length);
    stream.pipeTo(fixed.writable).catch(() => {});
    return new Response(fixed.readable, { status: 206, headers: { ...baseHeaders, 'Content-Type': `multipart/byteranges; boundary=${boundary}` } });
  }

  async function serveUpdate(req, name, { attachment = false } = {}) {
    const objKey = `updates/${name}`;
    const head = await bucket.head(objKey);
    if (!head) return send(404, { error: 'Nie znaleziono pliku aktualizacji.' });
    const size = head.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const rangeHeader = req.headers.range || '';
    if (req.method !== 'HEAD' && /^bytes=[^,]*,/.test(rangeHeader)) {
      const multi = parseMultiRange(rangeHeader, size);
      if (multi === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (multi && multi.ranges.length === 1) {
        // po odrzuceniu niespełnialnych został jeden zakres - zwykła odpowiedź 206
        ({ start, end } = multi.ranges[0]);
        status = 206;
      } else if (multi) {
        return multipartResponse(objKey, size, multi.ranges, {
          'Accept-Ranges': 'bytes',
          'Cache-Control': INVITE_ONLY ? 'private, no-store' : 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
      }
    }
    const m = status === 206 ? null : /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      status = 206;
    }
    const length = end - start + 1;
    const headers = {
      'Content-Type': name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      // w trybie prywatnym pliki nie mogą trafić do współdzielonych cache'y (proxy, CDN)
      'Cache-Control': INVITE_ONLY ? 'private, no-store' : name.endsWith('.yml') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ...(attachment ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (req.method === 'HEAD') return new Response(null, { status, headers });
    const obj = await bucket.get(objKey, status === 206 ? { range: { offset: start, length } } : undefined);
    if (!obj) return send(404, { error: 'Nie znaleziono pliku aktualizacji.' });
    return new Response(obj.body, { status, headers });
  }

  /**
   * Wgrywanie plików aktualizacji (tylko klucz admin). Małe pliki: PUT /v1/updates/<plik> (jedno żądanie). Instalator >100 MB nie
   * przejdzie jednym żądaniem przez Cloudflare, więc częściami: POST …?uploads → {uploadId}; PUT …?uploadId=ID&part=N (kawałek,
   * np. 16 MiB) → {partNumber, etag}; POST …?uploadId=ID {parts:[{partNumber, etag}]} → 201; DELETE …?uploadId=ID przerywa.
   */
  async function receiveUpdate(req, name, key, url) {
    if (!key) return send(401, { error: 'Wymagany klucz dostępu.' });
    if (key.role !== 'admin') return send(403, { error: 'Aktualizacje może wgrywać tylko administrator.' });
    if (!UPDATE_FILE_RE.test(name)) return send(400, { error: 'Niedozwolona nazwa pliku aktualizacji.' });
    const objKey = `updates/${name}`;
    const params = url.searchParams;
    const uploadId = params.get('uploadId');
    const contentType = name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream';

    if (req.method === 'POST' && params.has('uploads')) {
      const mpu = await bucket.createMultipartUpload(objKey, { httpMetadata: { contentType } });
      return send(201, { uploadId: mpu.uploadId });
    }
    if (uploadId) {
      if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(uploadId)) return send(400, { error: 'Niepoprawny uploadId.' });
      const mpu = bucket.resumeMultipartUpload(objKey, uploadId);
      if (req.method === 'PUT') {
        const part = Number(params.get('part'));
        if (!Number.isInteger(part) || part < 1 || part > 10000) return send(400, { error: 'Numer części: od 1 do 10000.' });
        const data = await readLimited(req.raw, MAX_PART_BYTES, 'Część jest zbyt duża.');
        if (!data.length) return send(400, { error: 'Pusta część.' });
        const uploaded = await mpu.uploadPart(part, data);
        return send(200, { partNumber: uploaded.partNumber, etag: uploaded.etag });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const parts = Array.isArray(body.parts) ? body.parts : [];
        if (!parts.length || parts.length > 10000 || !parts.every((p) => Number.isInteger(p.partNumber) && typeof p.etag === 'string')) {
          return send(400, { error: 'Podaj listę części {partNumber, etag}.' });
        }
        const obj = await mpu.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
        if (obj.size > MAX_UPDATE_BYTES) {
          await bucket.delete(objKey);
          return send(413, { error: 'Plik jest zbyt duży.' });
        }
        return send(201, { file: name, size: obj.size });
      }
      if (req.method === 'DELETE') {
        await mpu.abort();
        return send(204);
      }
      return send(404, { error: 'Nie znaleziono.' });
    }
    if (req.method !== 'PUT') return send(404, { error: 'Nie znaleziono.' });
    const size = Number(req.headers['content-length']);
    if (!Number.isInteger(size) || size < 0) return send(400, { error: 'Wymagany nagłówek Content-Length.' });
    if (size === 0) return send(400, { error: 'Pusty plik.' });
    if (size > MAX_UPDATE_BYTES) throw httpError(413, 'Plik jest zbyt duży.', true);
    try {
      await bucket.put(objKey, req.raw.body, { httpMetadata: { contentType } });
    } catch {
      throw httpError(500, 'Nie udało się zapisać pliku.');
    }
    return send(201, { file: name, size });
  }

  // ---- peleryny graczy i obecność -----------------------------------------------
  /** Peleryna: 64×32 i wielokrotności 2:1 (do 2048 px), albo 22×17 / 46×22. Zwraca komunikat błędu albo ''. */
  function capeProblem(buf) {
    if (buf.length < 45 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'To nie jest plik PNG.';
    if (buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') return 'Uszkodzony plik PNG.';
    if (!buf.subarray(buf.length - 12).equals(IEND)) return 'Uszkodzony plik PNG (brak końca pliku).';
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const hd = w >= 64 && w <= 2048 && w % 64 === 0 && h === w / 2;
    const legacy = (w === 22 && h === 17) || (w === 46 && h === 22);
    if (!hd && !legacy) return `Peleryna musi mieć proporcje 2:1 (np. 64×32) albo 22×17 / 46×22 px (jest ${w}×${h}).`;
    return '';
  }

  /** Czy konto o tym nicku „dołączyło” do sesji Mojanga z podanym identyfikatorem (hasJoined). Każdy identyfikator działa raz. */
  async function verifyMojangProof(serverId, nick) {
    if (!/^[a-f0-9]{40}$/.test(serverId)) return false;
    const now = Date.now();
    for (const [k, until] of kv.list({ prefix: 'proof:' })) if (until < now) kv.delete(k);
    if (kv.get(`proof:${serverId}`) !== undefined) return false;
    kv.put(`proof:${serverId}`, now + PROOF_TTL_MS);
    try {
      const res = await fetch(`${MC_HASJOINED_URL}?username=${encodeURIComponent(nick)}&serverId=${serverId}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status !== 200) return false;
      const profile = await res.json();
      return String(profile.name || '').toLowerCase() === nick.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Sprawdza, czy żądający jest właścicielem nicka. Zwraca { players, entry, id } albo rzuca błąd HTTP. */
  async function authorizeNick(req, nick, key) {
    if (!NICK_RE.test(nick)) throw httpError(400, 'Nick: 1–16 znaków, litery, cyfry i podkreślnik.');
    const players = loadPlayers();
    const id = nick.toLowerCase();
    let entry = players[id];
    const admin = key?.role === 'admin';

    const secret = String(req.headers['x-crown-secret'] || '');
    const proofId = String(req.headers['x-crown-server-id'] || '');
    const secretOk = /^[A-Za-z0-9_-]{16,128}$/.test(secret);
    const secretHash = secretOk ? sha256(secret) : '';

    if (admin) {
      if (!entry) entry = players[id] = { nick, secretHash: '', premium: false, seenAt: 0, capeAt: 0 };
      return { players, entry, id };
    }
    if (proofId && (await verifyMojangProof(proofId, nick))) {
      // właściciel konta premium zawsze ma pierwszeństwo przed kimś, kto zajął nick sekretem
      entry = players[id] = { ...(entry || { seenAt: 0, capeAt: 0 }), nick, premium: true, secretHash: secretHash || entry?.secretHash || '' };
      return { players, entry, id };
    }
    if (!secretOk) throw httpError(401, 'Brak sekretu nicka (X-Crown-Secret).');
    if (entry?.premium) throw httpError(403, 'Ten nick należy do konta Microsoft - zaloguj się nim w launcherze, aby udostępnić pelerynę.');
    if (!entry) {
      entry = players[id] = { nick, secretHash, premium: false, seenAt: 0, capeAt: 0 };
    } else if (!entry.secretHash) {
      entry.secretHash = secretHash;
    } else if (
      entry.secretHash.length !== secretHash.length ||
      !timingSafeEqual(Buffer.from(entry.secretHash, 'hex'), Buffer.from(secretHash, 'hex'))
    ) {
      throw httpError(403, 'Ten nick jest już zajęty przez innego użytkownika launchera.');
    }
    return { players, entry, id };
  }

  async function serveCape(req, nick) {
    const objKey = `capes/${nick.toLowerCase()}.png`;
    if (req.method === 'HEAD') {
      const head = await bucket.head(objKey);
      if (!head) return send(404, { error: 'Brak peleryny.' });
      return new Response(null, { status: 200, headers: capeHeaders(head) });
    }
    const obj = await bucket.get(objKey);
    if (!obj) return send(404, { error: 'Brak peleryny.' });
    return new Response(obj.body, { status: 200, headers: capeHeaders(obj) });
  }

  const capeHeaders = (obj) => ({
    'Content-Type': 'image/png',
    'Content-Length': String(obj.size),
    'Cache-Control': 'public, max-age=120',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${obj.size}-${Math.floor(obj.uploaded.getTime())}"`,
  });

  function crownUsers() {
    const since = Date.now() - PRESENCE_DAYS * 86400_000;
    return Object.values(loadPlayers())
      .filter((p) => p.seenAt > since || p.capeAt > since)
      .map((p) => ({ name: `${p.nick}.png`, type: 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Zdejmuje peleryny podanych nicków (id = nick małymi literami); nick zostaje na liście graczy (korona), znika plik peleryny. */
  async function removeCapes(ids) {
    const list = (ids || []).filter((id) => /^[a-z0-9_]{1,16}$/.test(id));
    if (!list.length) return;
    const players = loadPlayers();
    for (const id of list) {
      await bucket.delete(`capes/${id}.png`);
      if (players[id]) players[id].capeAt = 0;
    }
    savePlayers(players);
  }

  // ---- panel administratora (strona /admin jest w worker.js; API /v1/admin/*) -------------
  function findAdminKey(raw) {
    const given = Buffer.from(sha256(String(raw || '')), 'hex');
    let found = null;
    for (const k of loadKeys()) {
      const stored = Buffer.from(k.hash, 'hex');
      if (!k.revoked && k.role === 'admin' && stored.length === given.length && timingSafeEqual(stored, given)) found = k;
    }
    return found;
  }

  function cookieOf(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return '';
  }

  function panelSession(req) {
    const sid = cookieOf(req, 'crown_panel');
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(sid)) return null;
    const s = kv.get(`sess:${sid}`);
    if (!s) return null;
    if (s.exp < Date.now()) {
      kv.delete(`sess:${sid}`);
      return null;
    }
    return s;
  }

  /** Administrator: klucz admin (Bearer) albo sesja panelu (ciasteczko + X-Crown-Panel). */
  function adminOf(req) {
    const key = authenticate(req);
    if (key && key.role === 'admin') return { name: key.name, via: 'key' };
    const s = panelSession(req);
    if (s && req.headers['x-crown-panel'] === '1' && req.headers['sec-fetch-site'] !== 'cross-site') return { name: s.name, via: 'session' };
    return null;
  }

  function purgeExpired(prefix) {
    const now = Date.now();
    for (const [k, v] of kv.list({ prefix })) if (v.exp < now) kv.delete(k);
  }

  function startSession(req, name) {
    purgeExpired('sess:');
    const sid = randomBytes(32).toString('base64url');
    kv.put(`sess:${sid}`, { exp: Date.now() + PANEL_SESSION_MS, name });
    const secure = new URL(req.raw.url).protocol === 'https:' || req.headers['x-forwarded-proto'] === 'https';
    return `crown_panel=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PANEL_SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  const publicInvite = (i) => ({
    id: i.id,
    name: i.name,
    note: i.note || '',
    status: inviteStatus(i),
    createdAt: i.createdAt,
    expiresAt: i.expiresAt || null,
    profile: i.profile || '',
    capes: Boolean(i.capes),
    disableClient: Boolean(i.disableClient),
    maxUses: i.maxUses,
    uses: i.devices.length,
    devices: i.devices.map((d) => ({ id: d.hash.slice(0, 8), firstAt: d.firstAt || null, lastAt: d.lastAt || null })),
    lastSeenAt: i.lastSeenAt || null,
    downloads: i.downloads || 0,
    lastDownloadAt: i.lastDownloadAt || null,
  });

  async function handleAdmin(req, route, ip, url) {
    if (route === 'POST /v1/admin/login') {
      if (rateLimited(`panel:${ip}`, 10)) return send(429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
      const body = await readBody(req);
      const k = findAdminKey(body.key);
      if (!k) return send(401, { error: 'Nieprawidłowy klucz administratora.' });
      return send(200, { ok: true, name: k.name }, { headers: { 'Set-Cookie': startSession(req, k.name) } });
    }
    if (route === 'POST /v1/admin/exchange') {
      if (rateLimited(`panel:${ip}`, 10)) return send(429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
      const body = await readBody(req);
      const ticketId = String(body.ticket || '');
      const t = /^[A-Za-z0-9_-]{16,64}$/.test(ticketId) ? kv.get(`tick:${ticketId}`) : undefined;
      if (t !== undefined) kv.delete(`tick:${ticketId}`);
      if (!t || t.exp < Date.now()) return send(401, { error: 'Bilet wygasł albo został już użyty.' });
      return send(200, { ok: true, name: t.name }, { headers: { 'Set-Cookie': startSession(req, t.name) } });
    }

    const admin = adminOf(req);
    if (!admin) return send(401, { error: 'Zaloguj się do panelu.' });

    if (route === 'POST /v1/admin/ticket') {
      if (admin.via !== 'key') return send(403, { error: 'Bilet wydaje tylko klucz administratora.' });
      purgeExpired('tick:');
      const ticket = randomBytes(24).toString('base64url');
      kv.put(`tick:${ticket}`, { exp: Date.now() + PANEL_TICKET_MS, name: admin.name });
      return send(200, { ticket, expiresIn: PANEL_TICKET_MS / 1000 });
    }
    if (route === 'POST /v1/admin/logout') {
      const sid = cookieOf(req, 'crown_panel');
      if (/^[A-Za-z0-9_-]{20,80}$/.test(sid)) kv.delete(`sess:${sid}`);
      return send(200, { ok: true }, { headers: { 'Set-Cookie': 'crown_panel=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' } });
    }
    if (route === 'GET /v1/admin/info') {
      return send(200, { installer: (await latestInstaller()) || null, linuxInstaller: (await latestInstaller('linux')) || null, inviteOnly: INVITE_ONLY, name: admin.name });
    }
    if (route === 'GET /v1/admin/invites') {
      const list = loadInvites().map(publicInvite).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return send(200, { invites: list });
    }
    if (route === 'POST /v1/admin/invites') {
      if (rateLimited(`mk:${admin.name}`, 60, 3_600_000)) return send(429, { error: 'Zbyt wiele nowych kluczy naraz.' });
      const body = await readBody(req);
      const parsed = parseInviteFields(body, { create: true });
      if (parsed.error) return send(400, { error: parsed.error });
      const { entry, key } = createInvite(parsed.values.name, parsed.values);
      return send(201, { ...publicInvite(entry), key });
    }
    // ---- pliki aktualizacji w R2: lista i usuwanie (porządki po starych instalatorach; migracja i weryfikacja) ----
    if (route === 'GET /v1/admin/updates') {
      const files = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix: 'updates/', cursor, limit: 1000 });
        for (const o of page.objects) files.push({ name: o.key.slice('updates/'.length), size: o.size, uploaded: o.uploaded.toISOString() });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return send(200, { files: files.sort((a, b) => a.name.localeCompare(b.name)) });
    }
    if (route === 'GET /v1/admin/capes') {
      const ids = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix: 'capes/', cursor, limit: 1000 });
        for (const o of page.objects) ids.push(o.key.slice('capes/'.length).replace(/\.png$/, ''));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return send(200, { capes: ids.sort() });
    }
    const updDel = /^DELETE \/v1\/admin\/updates\/([^/]+)$/.exec(route);
    if (updDel) {
      let name = '';
      try {
        name = decodeURIComponent(updDel[1]);
      } catch {
        /* niepoprawne kodowanie */
      }
      if (!UPDATE_FILE_RE.test(name)) return send(400, { error: 'Niedozwolona nazwa pliku aktualizacji.' });
      await bucket.delete(`updates/${name}`);
      return send(204);
    }
    // ---- klucze dostępu (zamiast CLI create-key / list-keys / revoke-key): tylko klucz admin w nagłówku, nie sesja panelu ----
    if (route === 'GET /v1/admin/keys') {
      if (admin.via !== 'key') return send(403, { error: 'Klucze zarządza tylko klucz administratora.' });
      return send(200, { keys: loadKeys().map((k) => ({ id: k.id, name: k.name, role: k.role, createdAt: k.createdAt, revoked: Boolean(k.revoked) })) });
    }
    if (route === 'POST /v1/admin/keys') {
      if (admin.via !== 'key') return send(403, { error: 'Klucze zarządza tylko klucz administratora.' });
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const role = body.role === undefined ? 'publisher' : body.role;
      if (!name || name.length > 60) return send(400, { error: 'Podaj nazwę osoby (do 60 znaków).' });
      if (!['publisher', 'admin'].includes(role)) return send(400, { error: 'Rola: publisher albo admin' });
      const key = `crown_${randomBytes(32).toString('base64url')}`;
      const entry = { id: randomBytes(4).toString('hex'), name, role, hash: sha256(key), createdAt: new Date().toISOString() };
      writeJson('keys.json', [...loadKeys(), entry]);
      return send(201, { id: entry.id, name, role, key }); // klucz pokazany tylko raz
    }
    const keyRevoke = /^POST \/v1\/admin\/keys\/([0-9a-f]{8})\/revoke$/.exec(route);
    if (keyRevoke) {
      if (admin.via !== 'key') return send(403, { error: 'Klucze zarządza tylko klucz administratora.' });
      const keys = loadKeys();
      const k = keys.find((x) => x.id === keyRevoke[1]);
      if (!k) return send(404, { error: 'Nie znaleziono klucza o takim id.' });
      k.revoked = true;
      writeJson('keys.json', keys);
      return send(200, { ok: true, id: k.id, name: k.name });
    }
    // ---- bramka serwera gry: klucz dla pluginu na proxy, podgląd i zdejmowanie sesji ----
    if (route === 'GET /v1/admin/gate') {
      const gate = readJson('gate.json', null);
      const now = Date.now();
      return send(200, {
        keySet: Boolean(gate),
        keyCreatedAt: gate ? gate.createdAt : null,
        ttl: PLAY_TTL_MS / 1000,
        sessions: activePlays().map((p) => ({
          nick: p.nick,
          by: p.by || '',
          since: new Date(p.at).toISOString(),
          expiresIn: Math.max(0, Math.round((p.exp - now) / 1000)),
          events: activeEventPlays().filter((e) => e.nick.toLowerCase() === p.nick.toLowerCase()).map((e) => e.event),
        })),
      });
    }
    if (route === 'POST /v1/admin/gate/key') {
      if (admin.via !== 'key') return send(403, { error: 'Klucz bramki wydaje tylko klucz administratora.' });
      const gateKey = `gate_${randomBytes(24).toString('base64url')}`;
      writeJson('gate.json', { hash: sha256(gateKey), createdAt: new Date().toISOString() });
      return send(201, { key: gateKey }); // pokazany tylko raz; nowy klucz unieważnia poprzedni
    }
    const playDel = /^DELETE \/v1\/admin\/play\/([A-Za-z0-9_]{3,16})$/.exec(route);
    if (playDel) {
      const had = kv.get(playKey(playDel[1])) !== undefined;
      kv.delete(playKey(playDel[1]));
      for (const [k] of kv.list({ prefix: `playev:${playDel[1].toLowerCase()}:` })) kv.delete(k); // także sesje z wydarzeń
      return send(had ? 200 : 404, had ? { ok: true } : { error: 'Ten nick nie ma sesji.' });
    }
    // znajduje zaproszenie po samym kluczu (CROWN-XXXX-…), jak CLI find-invite
    if (route === 'POST /v1/admin/invites/find') {
      const body = await readBody(req);
      const inv = findInvite(body.key);
      if (!inv) return send(404, { error: 'Nie znaleziono aktywnego zaproszenia o takim kluczu.' });
      return send(200, publicInvite(inv));
    }
    // surowe dokumenty stanu (kopie zapasowe, migracja z VPS-a, testy): tylko klucz admin w nagłówku
    const raw = /^(GET|PUT) \/v1\/admin\/raw\/([^/]+)$/.exec(route);
    if (raw) {
      if (admin.via !== 'key') return send(403, { error: 'Dokumenty stanu zmienia tylko klucz administratora.' });
      let name = '';
      try {
        name = decodeURIComponent(raw[2]);
      } catch {
        /* niepoprawne kodowanie */
      }
      if (!/^(?:(?:invites|keys|players|announcements|gate)\.json|blocklist\.json|event:[a-z0-9-]{1,32})$/.test(name)) return send(400, { error: 'Nieznany dokument.' });
      if (raw[1] === 'GET') return send(200, { value: readJson(name, null) });
      const body = JSON.parse((await readLimited(req.raw, 8 * MB)).toString('utf8') || '{}');
      if (!('value' in body)) return send(400, { error: 'Brak pola „value”.' });
      writeJson(name, body.value);
      return send(200, { ok: true });
    }
    // ---- wydarzenia: metadane i pliki (modyfikacje tylko administrator) ----
    if (route === 'GET /v1/admin/events') {
      const ids = new Set(Object.keys(DEFAULT_EVENTS));
      for (const [k] of kv.list({ prefix: 'event:' })) {
        const id = k.slice('event:'.length);
        if (EVENT_ID_RE.test(id)) ids.add(id);
      }
      return send(200, { events: [...ids].sort().map((id) => eventManifest(id)) });
    }
    const evAdmin = new RegExp(`^(POST|PUT|DELETE) /v1/admin/events/([a-z0-9-]{1,32})(?:/(${EVENT_KIND_RE})(?:/([^/]+))?)?$`).exec(route);
    if (evAdmin) {
      const [, method, eventId, kind, rawName] = evAdmin;
      if (!eventExists(eventId)) return send(404, { error: 'Nie ma takiego wydarzenia.' });
      if (method === 'POST' && !kind) {
        const body = await readBody(req);
        const cur = eventMeta(eventId);
        const next = { ...cur };
        if (body.title !== undefined) {
          next.title = String(body.title || '').trim().slice(0, 60);
          if (!next.title) return send(400, { error: 'Podaj nazwę wydarzenia.' });
        }
        if (body.mcVersion !== undefined) {
          next.mcVersion = String(body.mcVersion || '').trim();
          if (next.mcVersion && !/^\d+\.\d+(?:\.\d+)?$/.test(next.mcVersion)) return send(400, { error: 'Wersja Minecrafta w formacie 1.21.11.' });
        }
        if (body.crownClient !== undefined) next.crownClient = Boolean(body.crownClient);
        if (body.note !== undefined) next.note = String(body.note || '').slice(0, 300);
        if (body.enforce !== undefined) {
          // { "config/sodium-options.json": true, "root/options.txt": false } - czy plik ma być przywracany przy każdym starcie
          if (!body.enforce || typeof body.enforce !== 'object' || Array.isArray(body.enforce)) return send(400, { error: 'Niepoprawne ustawienia wymuszania.' });
          next.enforce = { ...cur.enforce };
          for (const [k, v] of Object.entries(body.enforce)) {
            const m = /^(config|root)\/(.+)$/.exec(k);
            if (!m || !eventRel(m[1], m[2]) || typeof v !== 'boolean') return send(400, { error: `Niepoprawne ustawienie wymuszania: ${String(k).slice(0, 60)}` });
            next.enforce[k] = v;
          }
        }
        writeJson(`event:${eventId}`, next);
        return send(200, { ok: true, event: eventManifest(eventId) });
      }
      // nazwa pliku: ostatni segment ścieżki (rodzaje płaskie) albo ?path=<ścieżka względna> (też configi w podfolderach)
      let name = '';
      if (rawName !== undefined) {
        try {
          name = decodeURIComponent(rawName);
        } catch {
          /* niepoprawne kodowanie */
        }
      } else {
        name = url.searchParams.get('path') || '';
      }
      const rel = kind ? eventRel(kind, name) : '';
      if (!rel) return send(400, { error: kind ? EVENT_KINDS[kind].label : 'Podaj rodzaj pliku wydarzenia.' });
      if (url.searchParams.has('uploads') || url.searchParams.has('uploadId')) return receiveEventMultipart(req, eventId, kind, rel, url);
      if (method === 'DELETE') {
        await bucket.delete(`events/${eventId}/${kind}/${rel}`);
        kv.delete(`evf:${eventId}:${kind}:${rel}`);
        // flaga wymuszania znika razem z plikiem
        const saved = readJson(`event:${eventId}`, null);
        if (saved && saved.enforce && `${kind}/${rel}` in saved.enforce) {
          delete saved.enforce[`${kind}/${rel}`];
          writeJson(`event:${eventId}`, saved);
        }
        return send(200, { ok: true, event: eventManifest(eventId) });
      }
      if (method === 'PUT') return receiveEventFile(req, eventId, kind, rel);
      return send(404, { error: 'Nie znaleziono.' });
    }

    const m = /^(POST|DELETE) \/v1\/admin\/invites\/([0-9a-f]{8})(?:\/(revoke|release|update))?$/.exec(route);
    if (m) {
      const [, method, id, action] = m;
      let entry = null;
      let goneCapes = []; // peleryny do zdjęcia: klucz stracił dostęp do peleryn albo został unieważniony
      if (method === 'POST' && action === 'revoke') {
        entry = updateInvite(id, (e) => {
          e.revoked = true;
          goneCapes = e.capeNicks || [];
          e.capeNicks = [];
        });
      } else if (method === 'POST' && action === 'release') {
        // bez treści: wszystkie komputery; { device: "<8 znaków>" }: tylko ten jeden
        const body = await readBody(req);
        const only = body.device ? String(body.device) : '';
        entry = updateInvite(id, (e) => {
          const gone = only ? e.devices.filter((d) => d.hash.startsWith(only)) : e.devices;
          e.devices = only ? e.devices.filter((d) => !d.hash.startsWith(only)) : [];
          // zwolnione komputery tracą klucz w launcherze (checkInvite), dopóki gracz nie wpisze go ponownie
          e.released = [...new Set([...(e.released || []), ...gone.map((d) => d.hash)])].slice(-200);
        });
      } else if (method === 'POST' && action === 'update') {
        const body = await readBody(req);
        const parsed = parseInviteFields(body);
        if (parsed.error) return send(400, { error: parsed.error });
        entry = updateInvite(id, (e) => {
          if (parsed.values.capes === false) {
            goneCapes = e.capeNicks || [];
            e.capeNicks = [];
          }
          Object.assign(e, parsed.values);
        });
      } else if (method === 'DELETE' && !action) {
        const all = loadInvites();
        entry = all.find((x) => x.id === id) || null;
        if (entry && !entry.revoked) return send(409, { error: 'Najpierw unieważnij klucz.' });
        if (entry) writeJson('invites.json', all.filter((x) => x.id !== id));
      } else return send(404, { error: 'Nie znaleziono.' });
      if (!entry) return send(404, { error: 'Nie znaleziono zaproszenia.' });
      await removeCapes(goneCapes);
      return send(200, { ok: true, invite: publicInvite(entry) });
    }
    return send(404, { error: 'Nie znaleziono.' });
  }

  // ---- routing --------------------------------------------------------------------
  async function route(request) {
    bootstrap();
    const url = new URL(request.url);
    const req = { method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), raw: request };
    const ip = clientIp(req);
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

    // pliki aktualizacji: w trybie prywatnym wymagają zaproszenia (bez limitu - pobieranie różnicowe wysyła wiele żądań)
    const pub = /^(GET|HEAD) \/updates\/([^/]+)$/.exec(route);
    if (pub) {
      let name = '';
      try {
        name = decodeURIComponent(pub[2]);
      } catch {
        /* niepoprawne kodowanie */
      }
      if (!UPDATE_FILE_RE.test(name)) return send(404, { error: 'Nie znaleziono.' });
      if (!invited(req)) return denyInvite(ip, req);
      return serveUpdate(req, name);
    }

    // strona pobierania: POST oddaje najnowszy instalator (klucz w ciele, nie w adresie)
    if (INVITE_ONLY && route === 'POST /download') {
      if (rateLimited(`dl:${ip}`, 20)) return sendHtml(429, downloadPage('Zbyt wiele prób. Spróbuj za minutę.'));
      const form = await readForm(req);
      const inv = findInvite(form.key);
      if (!inv) return sendHtml(401, downloadPage('Nieprawidłowy lub unieważniony klucz zaproszenia.'));
      if (isExpired(inv)) return sendHtml(401, downloadPage('Ten klucz wygasł. Poproś administratora o nowy klucz.'));
      touchInvite(inv);
      updateInvite(inv.id, (e) => {
        e.downloads = (e.downloads || 0) + 1;
        e.lastDownloadAt = new Date().toISOString();
      });
      const installer = await latestInstaller();
      if (!installer) return sendHtml(404, downloadPage('Instalator nie został jeszcze opublikowany.'));
      return serveUpdate(req, installer, { attachment: true });
    }

    // lista blokad antycheata (zamiast blocklist.json z GitHuba): dokument „blocklist.json” w storage
    if (route === 'GET /blocklist.json') {
      if (!invited(req)) return denyInvite(ip, req);
      const text = (() => {
        const v = kv.get('blocklist.json');
        return v === undefined ? '{}' : typeof v === 'string' ? v : JSON.stringify(v);
      })();
      return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
    }

    // peleryny i lista graczy z koroną są publiczne (czyta je gra, bez klucza); limit na adres IP
    const cape = /^(GET|HEAD) \/capes\/([A-Za-z0-9_]{1,16})\.png$/.exec(route);
    if (cape) {
      if (rateLimited(`cape:${ip}`, 600)) return send(429, { error: 'Zbyt wiele żądań.' });
      return serveCape(req, cape[2]);
    }
    if (route === 'GET /v1/crown-users') {
      if (rateLimited(`list:${ip}`, 120)) return send(429, { error: 'Zbyt wiele żądań.' });
      return send(200, crownUsers());
    }

    const key = authenticate(req);
    if (req.headers.authorization && !key) {
      // nieudane próby uwierzytelnienia liczymy osobno (ochrona przed zgadywaniem)
      if (rateLimited(`auth:${ip}`, 10)) return send(429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
      return send(401, { error: 'Nieprawidłowy lub unieważniony klucz dostępu.' });
    }
    // panel administratora ma osobny, hojniejszy limit (wgrywanie całego folderu config to setki zapytań)
    if (url.pathname.startsWith('/v1/admin/')) {
      if (rateLimited(`adm:${ip}`, 3000)) return send(429, { error: 'Zbyt wiele żądań.' });
      return handleAdmin(req, route, ip, url);
    }
    // pytanie pluginu na proxy, czy nick wchodzi z launchera: własny, wyższy limit (zalew prób wejścia nie może zablokować
    // sprawdzania prawdziwych graczy), a błędny klucz bramki liczymy osobno (ochrona przed zgadywaniem)
    if (route === 'GET /v1/gate/check') {
      if (!gateKeyValid(req.headers['x-crown-gate'])) {
        if (rateLimited(`gateauth:${ip}`, 10)) return send(429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
        return send(401, { error: 'Nieprawidłowy klucz bramki.' });
      }
      if (rateLimited('gatecheck', 3000)) return send(429, { error: 'Zbyt wiele żądań.' });
      const nick = url.searchParams.get('nick') || '';
      if (!PLAY_NICK_RE.test(nick)) return send(400, { error: 'Niepoprawny nick.' });
      const event = (url.searchParams.get('event') || '').toLowerCase();
      if (event && !EVENT_ID_RE.test(event)) return send(400, { error: 'Niepoprawne wydarzenie.' });
      return send(200, gateVerdict(nick, event));
    }

    if (rateLimited(`ip:${ip}`, 120)) return send(429, { error: 'Zbyt wiele żądań.' });

    // sprawdzenie klucza zaproszenia (launcher woła to przy wpisaniu klucza i co jakiś czas)
    if (route === 'GET /v1/invite') {
      if (key) return send(200, { ok: true, name: key.name, role: key.role, profile: '', capes: true, disableClient: true });
      // Kod wydarzenia działa tylko w launcherze, który zna tryb wydarzenia (X-Crown-Features: event) - starszy dałby pełny dostęp.
      const peekInv = findInvite(req.headers['x-crown-invite']);
      const features = String(req.headers['x-crown-features'] || '').split(',').map((f) => f.trim());
      if (peekInv && peekInv.profile && !features.includes('event')) {
        req.inviteAccess = { ok: false, status: 401, error: 'Ten kod wymaga nowszej wersji CrownLaunchera. Pobierz aktualny launcher ze strony i spróbuj ponownie.' };
        return denyInvite(ip, req);
      }
      const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
      if (!access.ok) {
        req.inviteAccess = access;
        return denyInvite(ip, req);
      }
      return send(200, { ok: true, name: access.inv.name, role: 'player', activated: access.activated, profile: access.inv.profile || '', capes: Boolean(access.inv.capes), disableClient: Boolean(access.inv.disableClient) });
    }

    // avatar konta przez serwer (mc-heads.net nie zobaczy adresu IP gracza): tylko z kluczem zaproszenia, osobny limit
    const avatarReq = /^GET \/v1\/avatar\/([A-Za-z0-9_-]{1,36})$/.exec(route);
    if (avatarReq) {
      if (!invited(req)) return denyInvite(ip, req);
      if (rateLimited(`avatar:${ip}`, 60)) return send(429, { error: 'Zbyt wiele żądań.' });
      if (!AVATAR_ID_RE.test(avatarReq[1])) return send(400, { error: 'Niepoprawny identyfikator gracza.' });
      const png = await avatarPng(avatarReq[1].replace(/-/g, ''), avatarSize(url.searchParams.get('size')));
      if (!png) return send(404, { error: 'Nie ma avatara tego gracza.' });
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }

    // ---- wydarzenia: lista plików i pliki dla kluczy z profilem wydarzenia (albo administratora) ----
    const ev = new RegExp(`^GET /v1/event/([a-z0-9-]{1,32})(/info|/file/(${EVENT_KIND_RE})(?:/([^/]+))?)?$`).exec(route);
    if (ev) {
      const [, eventId, tail, kind, rawName] = ev;
      if (!eventExists(eventId)) return send(404, { error: 'Nie ma takiego wydarzenia.' });
      if (!(key && key.role === 'admin')) {
        // zwykły klucz zaproszenia wystarcza tylko do „info”; pliki wymagają klucza z profilem tego wydarzenia
        const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
        if (!access.ok) {
          req.inviteAccess = access;
          return denyInvite(ip, req);
        }
        if (tail !== '/info' && access.inv.profile !== eventId) {
          return send(403, { error: 'To wydarzenie wymaga kodu dostępu. Wpisz kod Igrzysk.' });
        }
      }
      if (tail === '/info') {
        const m = eventManifest(eventId);
        return send(200, { id: eventId, title: m.title, ready: eventReady(m) });
      }
      if (!tail) return send(200, eventManifest(eventId));
      // nazwa: ostatni segment ścieżki (płaskie rodzaje) albo ?path=<ścieżka względna> (configi w podfolderach)
      let name = '';
      if (rawName !== undefined) {
        try {
          name = decodeURIComponent(rawName);
        } catch {
          /* niepoprawne kodowanie */
        }
      } else {
        name = url.searchParams.get('path') || '';
      }
      const rel = eventRel(kind, name);
      if (!rel || kv.get(`evf:${eventId}:${kind}:${rel}`) === undefined) return send(404, { error: 'Nie znaleziono pliku.' });
      const obj = await bucket.get(`events/${eventId}/${kind}/${rel}`);
      if (!obj) return send(404, { error: 'Nie znaleziono pliku.' });
      return new Response(obj.body, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    if (route === 'GET /v1/announcements') {
      if (!invited(req)) return denyInvite(ip, req);
      const now = Date.now();
      const list = loadAnnouncements()
        .filter((a) => !a.expiresAt || new Date(a.expiresAt).getTime() > now)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50)
        .map((a) => publicView(a, key));
      return send(200, { announcements: list });
    }

    if (route === 'GET /v1/me') {
      if (!key) return send(401, { error: 'Wymagany klucz dostępu.' });
      return send(200, { keyId: key.id, name: key.name, role: key.role });
    }

    const capePut = /^(PUT|DELETE) \/v1\/capes\/([A-Za-z0-9_]{1,16})$/.exec(route);
    if (capePut) {
      if (!invited(req)) return denyInvite(ip, req);
      // Wgrywanie peleryn tylko dla kluczy z dostępem do peleryn; zdjęcie własnej (DELETE) wolno każdemu. Klucze administracji
      // i tryb bez zaproszeń nie podlegają temu ograniczeniu.
      const capeInvite = INVITE_ONLY && !key ? req.inviteAccess?.inv : null;
      if (capePut[1] === 'PUT' && INVITE_ONLY && !key && !capeInvite?.capes) {
        return send(403, { error: 'Peleryny są dostępne tylko dla wybranych graczy. Poproś administratora o dostęp.' });
      }
      if (rateLimited(`capewrite:${ip}`, 30, 3_600_000)) return send(429, { error: 'Zbyt wiele zmian peleryn. Spróbuj za godzinę.' });
      const nick = capePut[2];
      let png = null;
      if (capePut[1] === 'PUT') {
        png = await readLimited(request, MAX_CAPE_BYTES, 'Plik jest zbyt duży.');
        const problem = capeProblem(png);
        if (problem) return send(400, { error: problem });
      }
      const { players, entry, id } = await authorizeNick(req, nick, key);
      if (png) {
        const taken = !(await bucket.head(`capes/${id}.png`));
        if (taken && Object.values(players).filter((p) => p.capeAt > 0).length >= MAX_CAPES) {
          return send(507, { error: 'Serwer peleryn jest pełny.' });
        }
        await bucket.put(`capes/${id}.png`, png, { httpMetadata: { contentType: 'image/png' } });
        entry.capeAt = Date.now();
        entry.seenAt = Math.max(entry.seenAt || 0, entry.capeAt);
        savePlayers(players);
        // zapamiętujemy, kto wgrał pelerynę - zdejmiemy ją, gdy klucz straci dostęp do peleryn albo zostanie unieważniony
        if (capeInvite) {
          updateInvite(capeInvite.id, (e) => {
            if ((e.capeNicks || []).includes(id)) return false;
            e.capeNicks = [...(e.capeNicks || []), id].slice(-10);
          });
        }
        return send(201, { nick: entry.nick, size: png.length });
      }
      await bucket.delete(`capes/${id}.png`);
      entry.capeAt = 0;
      savePlayers(players);
      return send(204);
    }

    if (route === 'POST /v1/presence') {
      if (!invited(req)) return denyInvite(ip, req);
      if (rateLimited(`presence:${ip}`, 60, 3_600_000)) return send(429, { error: 'Zbyt wiele żądań.' });
      const body = await readBody(req);
      const { players, entry } = await authorizeNick(req, String(body.nick || ''), key);
      entry.seenAt = Date.now();
      savePlayers(players);
      return send(204);
    }

    // sesja gry z launchera: zgłaszana przy starcie gry i co minutę (POST), zdejmowana po jej zamknięciu (DELETE ?nick=)
    if (route === 'POST /v1/play' || route === 'DELETE /v1/play') {
      if (!invited(req)) return denyInvite(ip, req);
      if (rateLimited(`play:${ip}`, 240)) return send(429, { error: 'Zbyt wiele żądań.' });
      const inv = INVITE_ONLY && !key ? req.inviteAccess?.inv : null;
      const device = String(req.headers['x-crown-device'] || '');
      const dev = DEVICE_RE.test(device) ? deviceHash(device) : '';
      const owner = inv ? `i:${inv.id}` : key ? `k:${key.id}` : '';
      if (req.method === 'DELETE') {
        const nick = url.searchParams.get('nick') || '';
        if (!PLAY_NICK_RE.test(nick)) return send(400, { error: 'Niepoprawny nick.' });
        const cur = kv.get(playKey(nick));
        if (cur && cur.owner === owner) kv.delete(playKey(nick)); // cudzej sesji nie ruszamy
        for (const [k, v] of kv.list({ prefix: `playev:${nick.toLowerCase()}:` })) if (v.owner === owner) kv.delete(k);
        return send(204);
      }
      const body = await readBody(req);
      const nick = String(body.nick || '');
      if (!PLAY_NICK_RE.test(nick)) return send(400, { error: 'Niepoprawny nick.' });
      const uuid = /^[0-9a-f-]{32,36}$/i.test(String(body.uuid || '')) ? String(body.uuid).toLowerCase() : '';
      // sesja z instancji wydarzenia: tylko klucz z profilem tego wydarzenia (kod wydarzenia) albo klucz administracji
      const event = String(body.event || '').trim().toLowerCase();
      if (event) {
        if (!EVENT_ID_RE.test(event) || !eventExists(event)) return send(400, { error: 'Nie ma takiego wydarzenia.' });
        if (inv && inv.profile !== event) return send(403, { error: 'Do gry w wydarzeniu potrzebny jest kod wydarzenia. Wpisz go w zakładce wydarzenia.' });
      }
      const now = Date.now();
      const active = activePlays();
      if (inv && active.filter((p) => p.owner === owner && p.dev === dev && p.nick.toLowerCase() !== nick.toLowerCase()).length >= PLAY_MAX_PER_DEVICE) {
        return send(429, { error: `Z jednego komputera można grać naraz na co najwyżej ${PLAY_MAX_PER_DEVICE} nickach.` });
      }
      const prev = kv.get(playKey(nick));
      const session = {
        nick,
        uuid,
        owner,
        inviteId: inv ? inv.id : '',
        keyId: key ? key.id : '',
        by: inv ? inv.name : key ? key.name : '',
        dev,
        at: prev && prev.exp >= now && prev.owner === owner ? prev.at : now,
        exp: now + PLAY_TTL_MS,
      };
      kv.put(playKey(nick), session); // każda gra z launchera jest też zwykłą sesją (wymagają jej pluginy bez „event”)
      if (event) {
        const prevEv = kv.get(playEventKey(nick, event));
        kv.put(playEventKey(nick, event), { ...session, event, at: prevEv && prevEv.exp >= now && prevEv.owner === owner ? prevEv.at : now });
      }
      return send(200, { ok: true, ttl: PLAY_TTL_MS / 1000 });
    }

    const upload = /^(PUT|POST|DELETE) \/v1\/updates\/([^/]+)$/.exec(route);
    if (upload) {
      let name = '';
      try {
        name = decodeURIComponent(upload[2]);
      } catch {
        /* niepoprawne kodowanie */
      }
      return receiveUpdate(req, name, key, url);
    }

    if (route === 'POST /v1/announcements') {
      if (!key) return send(401, { error: 'Wymagany klucz dostępu.' });
      if (rateLimited(`write:${key.id}`, 20)) return send(429, { error: 'Zbyt wiele ogłoszeń naraz. Spróbuj za minutę.' });
      const data = validateAnnouncement(await readBody(req));
      const entry = { id: randomBytes(5).toString('hex'), ...data, author: key.name, keyId: key.id, createdAt: new Date().toISOString() };
      let all = loadAnnouncements();
      all.push(entry);
      if (all.length > MAX_STORED) {
        // usuwamy najstarsze nieprzypięte
        all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt));
        all = all.slice(0, MAX_STORED);
      }
      writeJson('announcements.json', all);
      return send(201, { announcement: publicView(entry, key) });
    }

    const del = /^DELETE \/v1\/announcements\/([a-f0-9]{4,32})$/.exec(route);
    if (del) {
      if (!key) return send(401, { error: 'Wymagany klucz dostępu.' });
      const all = loadAnnouncements();
      const entry = all.find((a) => a.id === del[1]);
      if (!entry) return send(404, { error: 'Nie znaleziono ogłoszenia.' });
      if (key.role !== 'admin' && entry.keyId !== key.id) {
        return send(403, { error: 'Możesz usuwać tylko własne ogłoszenia.' });
      }
      writeJson('announcements.json', all.filter((a) => a.id !== entry.id));
      return send(204);
    }

    return send(404, { error: 'Nie znaleziono.' });
  }

  return {
    async handle(request) {
      try {
        return await route(request);
      } catch (e) {
        if (!e.status) console.error(e);
        return send(e.status || 500, { error: e.status ? e.message : 'Błąd serwera.' });
      }
    },
  };
}
