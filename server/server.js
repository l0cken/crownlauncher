#!/usr/bin/env node
/**
 * Serwer ogłoszeń CrownLaunchera - bez zależności, dane w plikach JSON.
 *
 *   node server/server.js                       uruchom serwer (domyślnie 127.0.0.1:8787)
 *   node server/server.js create-key "Nazwa" [publisher|admin]
 *   node server/server.js list-keys
 *   node server/server.js revoke-key <id>
 *
 * Aktualizacje launchera: GET /updates/<plik> (publicznie), PUT /v1/updates/<plik> (klucz admin).
 *
 * Peleryny graczy (bez kluczy dostępu - każdy użytkownik launchera udostępnia własną):
 *   GET    /capes/<Nick>.png        publicznie (CustomSkinLoader czyta stąd pelerynę po nicku)
 *   PUT    /v1/capes/<Nick>         PNG w treści; nagłówek X-Crown-Secret (sekret nicka)
 *   DELETE /v1/capes/<Nick>         zdejmuje pelerynę (ten sam sekret)
 *   POST   /v1/presence             {"nick": "..."} - „gram przez CrownLauncher” (korona przed nickiem)
 *   GET    /v1/crown-users          lista nicków z koroną ([{ "name": "Nick.png" }], jak listing GitHuba)
 *   GET    /v1/avatar/<nick|uuid>?size=   twarz gracza z mc-heads.net pobrana przez serwer, żeby serwis nie znał adresu IP gracza
 *                                   (INVITE_ONLY: wymaga zaproszenia; PNG, rozmiar 32/64/128/256, odpowiedzi w pamięci podręcznej)
 * Własność nicka: konto premium dowodzi jej wymianą z sessionserverem Mojanga (nagłówek X-Crown-Server-Id:
 * launcher losuje identyfikator i zgłasza go Mojangowi swoim tokenem, serwer pyta Mojanga przez hasJoined) -
 * token Minecrafta NIGDY nie trafia na ten serwer. Konto offline dowodzi sekretem zapisanym przy pierwszym
 * użyciu nicka. Nick przypisany do konta premium nie da się już przejąć sekretem. Administrator (klucz admin)
 * może usuwać cudze peleryny.
 *
 * Prywatna dystrybucja (INVITE_ONLY=1) - launcher tylko dla zaproszonych graczy:
 *   node server/server.js create-invite "Nazwa"     klucz zaproszenia (jeden na gracza, pokazany raz)
 *   node server/server.js list-invites | revoke-invite <id>
 *   GET  /  albo /download           strona z polem na klucz; POST /download oddaje najnowszy instalator
 *   GET  /updates/<plik>             wymaga zaproszenia (nagłówek X-Crown-Invite) albo klucza admin
 *   GET  /v1/invite                  sprawdza klucz zaproszenia -> { ok, name }
 *   GET  /blocklist.json             lista blokad antycheata (plik DATA_DIR/blocklist.json)
 *   GET  /admin                      panel administratora (klucze zaproszeń: utwórz, unieważnij, zwolnij komputer)
 *   Klucz zaproszenia wiąże się z pierwszym komputerem (nagłówek X-Crown-Device); REQUIRE_DEVICE=1 odrzuca
 *   launchery bez tego nagłówka. CLI: create-invite, list-invites, revoke-invite <id>, release-invite <id>.
 *   Wydarzenia (np. igrzyska): klucz z profilem = kod wydarzenia (create-invite --profile igrzyska, set-profile <id>
 *   <profil|->, find-invite <KLUCZ>); pliki wydarzenia (mody .jar, texturepacki .zip) wgrywa się w panelu
 *   (PUT /v1/admin/events/<id>/<mods|resourcepacks>/<plik>), a launcher gracza z kodem pobiera je z /v1/event/<id>.
 *   Ogłoszenia, zapis peleryn i obecność też wymagają zaproszenia. Publiczne zostają GET /capes/<nick>.png
 *   i /v1/crown-users - czyta je sama gra, która nie ma jak dołączyć klucza.
 *   Peleryny (zakładka Skiny) są tylko dla wybranych: klucz ma pole „capes” (panel: „Peleryny”; CLI: create-invite
 *   --capes, set-capes <id> <on|off>). Bez niego PUT /v1/capes/<nick> zwraca 403; zdjęcie własnej peleryny (DELETE)
 *   wolno zawsze. Wyłączenie dostępu albo unieważnienie klucza zdejmuje peleryny wgrane tym kluczem.
 *   Wyłączanie wbudowanego CrownClienta (Ustawienia → Launcher) jest tylko dla wybranych: pole „disableClient” na
 *   kluczu (panel; CLI: create-invite --disable-client, set-disable-client <id> <on|off>); /v1/invite zwraca je launcherowi.
 *
 * Zmienne środowiskowe: PORT, HOST, DATA_DIR, TRUST_PROXY=1 (gdy stoi za reverse proxy), INVITE_ONLY=1,
 * MC_HASJOINED_URL (tylko testy).
 * Serwer mówi czystym HTTP - w internecie wystaw go przez HTTPS (reverse proxy / hosting z TLS).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const panel = require('./panel');
const site = require('./site');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const MAX_BODY = 32 * 1024;
const MAX_STORED = 200;
const LIMITS = { title: 80, text: 2000, url: 500 };
const LEVELS = ['info', 'important', 'event'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const ANN_FILE = path.join(DATA_DIR, 'announcements.json');
const CAPES_DIR = path.join(DATA_DIR, 'capes');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

// ---- storage --------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MC_HASJOINED_URL = process.env.MC_HASJOINED_URL || 'https://sessionserver.mojang.com/session/minecraft/hasJoined';
const loadKeys = () => readJson(KEYS_FILE, []);
const loadAnnouncements = () => readJson(ANN_FILE, []);

// ---- zaproszenia (prywatna dystrybucja) -------------------------------------------------------
//
// INVITE_ONLY=1: instalator, aktualizacje, ogłoszenia, lista blokad i zapis peleryn wymagają klucza
// zaproszenia (nagłówek X-Crown-Invite) albo klucza administracji. Klucz zaproszenia jest jeden na gracza
// i da się go unieważnić osobno; serwer trzyma tylko jego skrót. Peleryny (GET /capes/<nick>.png) i lista koron
// zostają publiczne - czyta je sama gra, która nie ma jak dołączyć klucza.
const INVITE_ONLY = process.env.INVITE_ONLY === '1';
// REQUIRE_DEVICE=1: klucze działają tylko z launcherem, który wiąże je z komputerem (starsze wersje dostają odmowę)
const REQUIRE_DEVICE = process.env.REQUIRE_DEVICE === '1';
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const loadInvites = () => readJson(INVITES_FILE, []).map(normalizeInviteEntry);
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 znaki bez łatwych do pomylenia (0/O, 1/I)
const INVITE_RE = /^[A-HJ-NP-Z2-9]{16}$/;

/** „crown-abcd efgh…” → „ABCDEFGH…” (wielkość liter, myślniki i spacje nie mają znaczenia). */
const normalizeInvite = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CROWN/, '');

function newInviteKey() {
  let s = '';
  for (let i = 0; i < 16; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
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
    if (!inv.revoked && stored.length === given.length && crypto.timingSafeEqual(stored, given)) found = inv;
  }
  return found;
}

// ---- klucz zaproszenia: limit użyć (komputerów), wygaśnięcie, notatka --------------------------------
//
// Każdy komputer, na którym launcher użyje klucza (nagłówek X-Crown-Device z losowym identyfikatorem instalacji),
// zajmuje jedno „użycie”. Klucz ma limit użyć (domyślnie 1; 0 = bez limitu) i opcjonalną datę wygaśnięcia - po niej
// przestaje działać wszędzie. Ten sam komputer używa klucza dowolnie długo. Administrator może zwolnić jeden komputer
// albo wszystkie (np. po reinstalacji Windowsa). Launcher sprzed wiązania (bez X-Crown-Device) działa tylko dopóki
// klucz nie został z żadnym komputerem związany.

const DEVICE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const deviceHash = (device) => sha256(`crown-device:${device}`);
const MAX_USES_LIMIT = 1000;

// ---- wydarzenia (np. „Igrzyska śmierci”): zamknięty zestaw modów, texturepacków i ustawień -----------------
//
// DATA_DIR/events/<id>/event.json + mods/*.jar + resourcepacks/*.zip + shaderpacks/*.(zip|txt) + config/<ścieżka>
// + root/(options.txt|servers.dat|…). Klucz zaproszenia z profilem = id wydarzenia („kod wydarzenia”) daje dostęp do
// plików tego wydarzenia (zwykły klucz - nie). Launcher synchronizuje instancję wydarzenia z listą z serwera: mody,
// texturepacki i shaderpacki co do pliku (reszta jest usuwana), a configi i pliki gry jako nakładkę - wymuszaną przy
// każdym starcie albo ustawianą jako domyślną (flaga `enforce`, gracz może wtedy zmienić plik do następnej zmiany).
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const EVENT_ID_RE = /^[a-z0-9-]{1,32}$/;
const DEFAULT_EVENTS = { igrzyska: { title: 'IGRZYSKA ŚMIERCI' } };
const EVENT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ +()\[\]-]{0,118}$/;
const MB = 1024 * 1024;
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

const eventExists = (id) => Boolean(DEFAULT_EVENTS[id]) || fs.existsSync(path.join(EVENTS_DIR, id));

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
  const saved = readJson(path.join(EVENTS_DIR, id, 'event.json'), {});
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

const sha1Cache = new Map(); // ścieżka|rozmiar|mtime -> sha1
function fileSha1(file, st) {
  const k = `${file}|${st.size}|${st.mtimeMs}`;
  let v = sha1Cache.get(k);
  if (!v) {
    v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    sha1Cache.set(k, v);
  }
  return v;
}

function listEventDir(dir, prefix, depth, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // brak katalogu = pusta lista
  }
  for (const ent of entries) {
    if (ent.isDirectory() && depth < 3) listEventDir(path.join(dir, ent.name), `${prefix}${ent.name}/`, depth + 1, out);
    else if (ent.isFile()) out.push(`${prefix}${ent.name}`);
  }
}

/**
 * Lista plików wydarzenia: { mods, resourcepacks, shaderpacks, config, root } - każda to [{name,size,sha1[,enforce]}]
 * posortowana po nazwie (config: ścieżka względna z „/”). `enforce` mają tylko config i root.
 */
function eventFiles(id) {
  const meta = eventMeta(id);
  const out = {};
  let updatedAt = 0;
  for (const kind of Object.keys(EVENT_KINDS)) {
    const spec = EVENT_KINDS[kind];
    const dir = path.join(EVENTS_DIR, id, kind);
    const names = [];
    listEventDir(dir, '', spec.nested ? 0 : 3, names); // rodzaje płaskie: bez schodzenia do podfolderów
    out[kind] = names
      .filter((n) => eventRel(kind, n))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const file = path.join(dir, ...name.split('/'));
        const st = fs.statSync(file);
        updatedAt = Math.max(updatedAt, st.mtimeMs);
        const entry = { name, size: st.size, sha1: fileSha1(file, st) };
        if ('enforce' in spec) {
          const flag = meta.enforce[`${kind}/${name}`];
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

/** Czy wydarzenie ma cokolwiek do pobrania i wersję gry (gotowe dla graczy). */
const eventReady = (m) => Boolean(m.mcVersion && Object.keys(EVENT_KINDS).some((k) => m[k].length));

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
  if (typeof e.profile !== 'string') e.profile = ''; // '' = pełny dostęp, inaczej id wydarzenia (np. „igrzyska”)
  if (!Array.isArray(e.released)) e.released = []; // skróty komputerów zwolnionych przez administratora (patrz checkInvite)
  if (typeof e.capes !== 'boolean') e.capes = false; // dostęp do peleryn (zakładka Skiny); dawne klucze go nie mają - nadaje się go w panelu
  if (!Array.isArray(e.capeNicks)) e.capeNicks = []; // nicki, których peleryny wgrał ten klucz (do zdjęcia, gdy dostęp zniknie)
  if (typeof e.disableClient !== 'boolean') e.disableClient = false; // czy gracz może wyłączyć wbudowanego CrownClienta (Ustawienia → Launcher)
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

/**
 * Walidacja pól z panelu / CLI: { name, note, maxUses (0 = bez limitu), expiresAt (ISO albo null), expiresInDays }.
 * Zwraca { values } z polami, które podano, albo { error }.
 */
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
    id: crypto.randomBytes(4).toString('hex'),
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
  writeJson(INVITES_FILE, invites);
  return { entry, key: formatInvite(norm) };
}

/**
 * Zmienia wpis zaproszenia w pliku (atomowo - bez await między odczytem a zapisem). Zwraca wpis albo null.
 * Gdy mutate zwróci false, nic nie jest zapisywane.
 */
function updateInvite(id, mutate) {
  const all = loadInvites();
  const entry = all.find((x) => x.id === id);
  if (!entry) return null;
  if (mutate(entry, all) !== false) writeJson(INVITES_FILE, all);
  return entry;
}

const lastTouch = new Map();
/** Zapamiętuje, kiedy klucz i ten komputer byli ostatnio użyci (zapis co najwyżej raz na godzinę). */
function touchInvite(inv, hash = '') {
  const now = Date.now();
  const k = `${inv.id}:${hash}`;
  if (now - (lastTouch.get(k) || 0) < 3_600_000) return;
  lastTouch.set(k, now);
  updateInvite(inv.id, (e) => {
    const iso = new Date(now).toISOString();
    e.lastSeenAt = iso;
    const d = hash && e.devices.find((x) => x.hash === hash);
    if (d) d.lastAt = iso;
  });
}

/** Wynik sprawdzenia zaproszenia: { ok } albo { ok:false, status, error }. Zajmuje „użycie” przy pierwszym użyciu na komputerze. */
const RELEASED_MESSAGE = 'Ten komputer został odłączony od klucza przez administratora. Wpisz klucz ponownie, aby go użyć.';
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
  // „Zwolnij” w panelu: komputer jest odłączony od klucza. Launcher z obsługą tego (feature „release”) dostaje odmowę
  // przy kolejnym sprawdzeniu i pokazuje ekran z kluczem; ponowne, jawne wpisanie klucza (X-Crown-Entry) przyłącza go
  // z powrotem (zajmuje użycie). Starsze launchery nie znają tego komunikatu - dla nich komputer wiąże się sam, jak dotąd.
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

// ---- bramka serwera gry: sesje graczy z launchera ----------------------------------------------
// Launcher zgłasza grę (POST /v1/play) przy starcie i co minutę, dopóki proces gry działa. Plugin na proxy Minecrafta
// (CrownGate) pyta GET /v1/gate/check?nick=… kluczem bramki i wpuszcza tylko graczy z aktywną sesją, której klucz zaproszenia
// jest nadal ważny (unieważnienie, wygaśnięcie i „Zwolnij” działają od razu przy następnym wejściu).
// Sesje trzymamy w pamięci (wygasają po minutach, a launcher odnawia je co minutę, więc restart serwera niczego nie psuje).
const PLAY_NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const PLAY_TTL_MS = Math.max(1000, Number(process.env.PLAY_TTL_MS) || 5 * 60_000); // PLAY_TTL_MS - tylko testy
const PLAY_MAX_PER_DEVICE = 4; // tyle nicków naraz z jednego komputera i klucza (np. dwa konta odpalone obok siebie)
const GATE_FILE = path.join(DATA_DIR, 'gate.json');
const plays = new Map(); // nick małymi literami -> sesja
// Sesja „z wydarzenia” (np. instancja IGRZYSKA ŚMIERCI) to osobny wpis: zgłasza ją tylko klucz z profilem tego wydarzenia (kod
// wydarzenia), a plugin proxy może wymagać właśnie jej (GET /v1/gate/check?event=…). Zwykła sesja powstaje przy każdym starcie gry,
// więc gracz grający z innej instancji nie przejdzie bramki wydarzenia.
const playEvents = new Map(); // "nick małymi:wydarzenie" -> sesja

function activePlays() {
  const now = Date.now();
  for (const [k, v] of plays) if (v.exp < now) plays.delete(k);
  return [...plays.values()];
}

function activeEventPlays() {
  const now = Date.now();
  for (const [k, v] of playEvents) if (v.exp < now) playEvents.delete(k);
  return [...playEvents.values()];
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
  const p = plays.get(nick.toLowerCase());
  if (!p || p.exp < now) return { allowed: false, reason: 'no-session' };
  const problem = sessionProblem(p);
  if (problem) return { allowed: false, reason: problem };
  if (!event) return { allowed: true, by: p.by, since: p.at };
  const e = playEvents.get(`${nick.toLowerCase()}:${event}`);
  if (!e || e.exp < now) return { allowed: false, reason: 'wrong-instance' };
  const eventProblem = sessionProblem(e);
  if (eventProblem) return { allowed: false, reason: eventProblem };
  return { allowed: true, by: e.by, since: e.at, event };
}

/** Klucz bramki (jedyny, pokazywany raz przy utworzeniu; na dysku tylko skrót) – ma go plugin na proxy. */
function gateKeyValid(given) {
  const gate = readJson(GATE_FILE, null);
  if (!gate || typeof given !== 'string' || given.length < 20 || given.length > 200) return false;
  const a = Buffer.from(sha256(given), 'hex');
  const b = Buffer.from(gate.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- CLI: zarządzanie kluczami ---------------------------------------------------

function cli(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'create-key') {
    const name = (args[0] || '').trim();
    const role = args[1] || 'publisher';
    if (!name) throw new Error('Użycie: create-key "Nazwa osoby" [publisher|admin]');
    if (!['publisher', 'admin'].includes(role)) throw new Error('Rola: publisher albo admin');
    const key = `crown_${crypto.randomBytes(32).toString('base64url')}`;
    const keys = loadKeys();
    const entry = { id: crypto.randomBytes(4).toString('hex'), name, role, hash: sha256(key), createdAt: new Date().toISOString() };
    keys.push(entry);
    writeJson(KEYS_FILE, keys);
    console.log(`Utworzono klucz dla: ${name} (${role}), id: ${entry.id}`);
    console.log('Klucz (pokazany tylko raz, przekaż go osobie bezpiecznym kanałem):\n');
    console.log(`  ${key}\n`);
    return true;
  }
  if (cmd === 'list-keys') {
    const keys = loadKeys();
    if (!keys.length) console.log('Brak kluczy.');
    for (const k of keys) {
      console.log(`${k.id}  ${k.role.padEnd(9)} ${k.revoked ? '[unieważniony] ' : ''}${k.name}  (${k.createdAt.slice(0, 10)})`);
    }
    return true;
  }
  if (cmd === 'revoke-key') {
    const keys = loadKeys();
    const key = keys.find((k) => k.id === args[0]);
    if (!key) throw new Error('Nie znaleziono klucza o takim id.');
    key.revoked = true;
    writeJson(KEYS_FILE, keys);
    console.log(`Unieważniono klucz ${key.id} (${key.name}).`);
    return true;
  }
  if (cmd === 'create-invite') {
    const name = (args[0] || '').trim();
    if (!name) throw new Error('Użycie: create-invite "Nazwa osoby"');
    // opcjonalnie: --uses N (limit komputerów, 0 = bez limitu), --days N (wygasa po N dniach), --note "tekst"
    const flag = (n) => {
      const i = args.indexOf(n);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const parsed = parseInviteFields({
      name,
      maxUses: flag('--uses'),
      expiresInDays: flag('--days'),
      note: flag('--note'),
      profile: flag('--profile'), // np. igrzyska: kod wydarzenia zamiast pełnego dostępu
      capes: args.includes('--capes') ? true : undefined, // dostęp do peleryn (zakładka Skiny)
      disableClient: args.includes('--disable-client') ? true : undefined, // gracz może wyłączyć CrownClienta
    }, { create: true });
    if (parsed.error) throw new Error(parsed.error);
    const { entry, key } = createInvite(name, parsed.values);
    console.log(`Utworzono zaproszenie dla: ${name}, id: ${entry.id}`);
    console.log('Klucz zaproszenia (pokazany tylko raz, przekaż go tej jednej osobie bezpiecznym kanałem):\n');
    console.log(`  ${key}\n`);
    console.log('Osoba pobiera instalator ze strony głównej serwera i wpisuje ten sam klucz przy pierwszym uruchomieniu.');
    console.log(`Limit użyć (komputerów): ${entry.maxUses === 0 ? 'bez limitu' : entry.maxUses}; wygasa: ${entry.expiresAt ? entry.expiresAt.slice(0, 10) : 'nigdy'}.`);
    return true;
  }
  if (cmd === 'list-invites') {
    const invites = loadInvites();
    if (!invites.length) console.log('Brak zaproszeń.');
    for (const i of invites) {
      const seen = i.lastSeenAt ? `ostatnio: ${i.lastSeenAt.slice(0, 16).replace('T', ' ')}` : 'jeszcze nieużyte';
      const label = { unused: 'nieużyty', activated: 'aktywowany', full: 'wykorzystany', expired: 'wygasły', revoked: 'unieważnione' }[inviteStatus(i)];
      const uses = `${i.devices.length}/${i.maxUses === 0 ? '∞' : i.maxUses}`;
      const exp = i.expiresAt ? `, do ${i.expiresAt.slice(0, 10)}` : '';
      const profile = (i.profile ? `, kod wydarzenia: ${i.profile}` : '') + (i.capes ? ', peleryny' : '') + (i.disableClient ? ', może wyłączyć CrownClienta' : '');
      console.log(`${i.id}  [${label}] ${i.name}  (użycia ${uses}${exp}${profile}; utworzone ${i.createdAt.slice(0, 10)}, ${seen})`);
    }
    return true;
  }
  if (cmd === 'find-invite') {
    // znajduje zaproszenie po samym kluczu (np. CROWN-XXXX-…); wypisuje id, nazwę, status i profil
    const inv = findInvite(args[0]);
    if (!inv) throw new Error('Nie znaleziono aktywnego zaproszenia o takim kluczu.');
    console.log(`${inv.id}  ${inv.name}  [${inviteStatus(inv)}]  profil: ${inv.profile || 'pełny dostęp'}  użycia: ${inv.devices.length}/${inv.maxUses === 0 ? '∞' : inv.maxUses}`);
    return true;
  }
  if (cmd === 'set-profile') {
    // set-profile <id> <profil|->  - np. igrzyska; „-” przywraca pełny dostęp
    const parsed = parseInviteFields({ profile: args[1] === '-' ? '' : args[1] });
    if (parsed.error) throw new Error(parsed.error);
    const entry = updateInvite(args[0], (e) => { e.profile = parsed.values.profile; });
    if (!entry) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    console.log(`Profil zaproszenia ${entry.id} (${entry.name}): ${entry.profile || 'pełny dostęp'}.`);
    return true;
  }
  if (cmd === 'set-capes') {
    // set-capes <id> <on|off>  - dostęp do peleryn; „off” zdejmuje też peleryny wgrane tym kluczem
    if (!['on', 'off'].includes(args[1])) throw new Error('Użycie: set-capes <id> <on|off>');
    const on = args[1] === 'on';
    let gone = [];
    const entry = updateInvite(args[0], (e) => {
      if (!on) {
        gone = e.capeNicks || [];
        e.capeNicks = [];
      }
      e.capes = on;
    });
    if (!entry) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    removeCapes(gone);
    console.log(`Peleryny dla zaproszenia ${entry.id} (${entry.name}): ${on ? 'włączone' : 'wyłączone'}.`);
    return true;
  }
  if (cmd === 'set-disable-client') {
    // set-disable-client <id> <on|off>  - czy gracz może wyłączyć wbudowanego CrownClienta (Ustawienia → Launcher)
    if (!['on', 'off'].includes(args[1])) throw new Error('Użycie: set-disable-client <id> <on|off>');
    const entry = updateInvite(args[0], (e) => { e.disableClient = args[1] === 'on'; });
    if (!entry) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    console.log(`Wyłączanie CrownClienta dla zaproszenia ${entry.id} (${entry.name}): ${entry.disableClient ? 'dozwolone' : 'niedozwolone'}.`);
    return true;
  }
  if (cmd === 'release-invite') {
    const inv = loadInvites().find((i) => i.id === args[0]);
    if (!inv) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    updateInvite(inv.id, (e) => {
      e.released = [...new Set([...(e.released || []), ...e.devices.map((d) => d.hash)])].slice(-200);
      e.devices = [];
    });
    console.log(`Zwolniono komputery dla zaproszenia ${inv.id} (${inv.name}) - klucz można aktywować od nowa.`);
    return true;
  }
  if (cmd === 'revoke-invite') {
    const invites = loadInvites();
    const inv = invites.find((i) => i.id === args[0]);
    if (!inv) throw new Error('Nie znaleziono zaproszenia o takim id (list-invites).');
    const gone = inv.capeNicks || [];
    inv.revoked = true;
    inv.capeNicks = [];
    writeJson(INVITES_FILE, invites);
    removeCapes(gone);
    console.log(`Unieważniono zaproszenie ${inv.id} (${inv.name}). Przestanie działać od następnego zapytania.`);
    return true;
  }
  return false;
}

// ---- HTTP -----------------------------------------------------------------------------

const buckets = new Map(); // ograniczanie liczby żądań: "klucz" -> { count, resetAt }
function rateLimited(bucket, limit, windowMs = 60_000) {
  const now = Date.now();
  let b = buckets.get(bucket);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(bucket, b);
  }
  b.count += 1;
  return b.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 60_000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function authenticate(req) {
  const m = /^Bearer\s+(\S{10,200})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const given = Buffer.from(sha256(m[1]), 'hex');
  let found = null;
  for (const k of loadKeys()) {
    const stored = Buffer.from(k.hash, 'hex');
    if (!k.revoked && stored.length === given.length && crypto.timingSafeEqual(stored, given)) found = k;
  }
  return found;
}

/**
 * Czy żądanie ma dostęp do zasobów prywatnych (INVITE_ONLY): klucz administracji (Bearer) albo ważny klucz
 * zaproszenia (X-Crown-Invite). Bez INVITE_ONLY wszystko jest publiczne, jak dotąd.
 */
function invited(req) {
  if (!INVITE_ONLY) return true;
  if (authenticate(req)) return true;
  // klucz zaproszenia jest związany z jednym komputerem (X-Crown-Device) - patrz checkInvite
  const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
  req.inviteAccess = access;
  return access.ok;
}

/** Odpowiedź dla żądania bez prawa dostępu; nieudane próby liczymy osobno (ochrona przed zgadywaniem). */
function denyInvite(res, ip, req) {
  if (rateLimited(`invite:${ip}`, 30)) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
  const a = req?.inviteAccess;
  if (a && !a.ok && a.status === 409) return send(res, 409, { error: a.error });
  return send(res, 401, { error: a?.error || 'Wymagany klucz zaproszenia.' });
}

function send(res, status, body, { close = false, headers = {} } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return; // nadmiarowe dane odrzucamy bez buforowania
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Zbyt duże żądanie.'), { status: 413, close: true }));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Niepoprawny JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function httpsUrl(value, field) {
  if (value === undefined || value === null || value === '') return '';
  const s = String(value).trim();
  if (s.length > LIMITS.url) throw Object.assign(new Error(`Pole „${field}” jest za długie.`), { status: 400 });
  let u;
  try {
    u = new URL(s);
  } catch {
    throw Object.assign(new Error(`Pole „${field}” musi być poprawnym adresem URL.`), { status: 400 });
  }
  if (u.protocol !== 'https:') throw Object.assign(new Error(`Pole „${field}” musi zaczynać się od https://`), { status: 400 });
  return u.href;
}

function validateAnnouncement(body) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  const title = String(body.title ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!title) throw fail('Podaj tytuł ogłoszenia.');
  if (title.length > LIMITS.title) throw fail(`Tytuł może mieć maks. ${LIMITS.title} znaków.`);
  if (text.length > LIMITS.text) throw fail(`Treść może mieć maks. ${LIMITS.text} znaków.`);
  const level = body.level ?? 'info';
  if (!LEVELS.includes(level)) throw fail('Niepoprawny rodzaj ogłoszenia.');
  const days = body.expiresInDays;
  if (days != null && days !== 0 && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
    throw fail('Czas wygaśnięcia: liczba dni od 1 do 365 albo brak.');
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
    id: a.id,
    title: a.title,
    text: a.text,
    image: a.image,
    link: a.link,
    level: a.level,
    pinned: a.pinned,
    author: a.author,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
  if (key && (key.role === 'admin' || key.id === a.keyId)) out.canDelete = true;
  return out;
}

// ---- aktualizacje launchera (electron-updater, provider "generic") ----------------------

const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const UPDATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(exe|AppImage|blockmap|yml)$/;
const MAX_UPDATE_BYTES = 400 * 1024 * 1024;
// wersje launchera do pobrania: plik wskazany w latest.yml (Windows, instalator .exe) albo latest-linux.yml (Linux, AppImage)
const INSTALLER_KINDS = { windows: { yml: 'latest.yml', ext: '.exe' }, linux: { yml: 'latest-linux.yml', ext: '.AppImage' } };

/** Nazwa najnowszego instalatora (Windows: .exe z latest.yml; `kind: 'linux'`: .AppImage z latest-linux.yml), albo '' gdy nic nie wgrano. */
function latestInstaller(kind = 'windows') {
  const { yml: ymlName, ext } = INSTALLER_KINDS[kind] || INSTALLER_KINDS.windows;
  let yml = '';
  try {
    yml = fs.readFileSync(path.join(UPDATES_DIR, ymlName), 'utf8');
  } catch {
    return '';
  }
  const candidates = [
    /^path:\s*(.+)$/m.exec(yml)?.[1],
    ...[...yml.matchAll(/^\s*(?:- )?url:\s*(.+)$/gm)].map((m) => m[1]),
  ];
  for (const c of candidates) {
    const name = String(c || '').trim().replace(/^['"]|['"]$/g, '');
    if (UPDATE_FILE_RE.test(name) && name.endsWith(ext) && fs.existsSync(path.join(UPDATES_DIR, name))) return name;
  }
  return '';
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/** Strona pobierania (patrz server/site.js): pole na klucz zaproszenia; klucz idzie w POST, nie w adresie ani w logach. */
function downloadPage(error = '') {
  return site.page(error);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { ...HTML_HEADERS, 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

/** Treść formularza (application/x-www-form-urlencoded), do 2 KB. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2048) reject(Object.assign(new Error('Zbyt duże żądanie.'), { status: 413, close: true }));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

function serveUpdate(req, res, name, { attachment = false } = {}) {
  const file = path.join(UPDATES_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Nie znaleziono pliku aktualizacji.' });
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
    }
    const headers = {
      'Content-Type': name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      // w trybie prywatnym pliki nie mogą trafić do współdzielonych cache'y (proxy, CDN)
      'Cache-Control': INVITE_ONLY ? 'private, no-store' : name.endsWith('.yml') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ...(attachment ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

async function receiveUpdate(req, res, name, key) {
  if (!key) return send(res, 401, { error: 'Wymagany klucz dostępu.' });
  if (key.role !== 'admin') return send(res, 403, { error: 'Aktualizacje może wgrywać tylko administrator.' });
  if (!UPDATE_FILE_RE.test(name)) return send(res, 400, { error: 'Niedozwolona nazwa pliku aktualizacji.' });

  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const tmp = path.join(UPDATES_DIR, `.${crypto.randomBytes(6).toString('hex')}.part`);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPDATE_BYTES) cb(Object.assign(new Error('Plik jest zbyt duży.'), { status: 413, close: true }));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp));
    if (size === 0) throw Object.assign(new Error('Pusty plik.'), { status: 400 });
    fs.renameSync(tmp, path.join(UPDATES_DIR, name));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e.status ? e : Object.assign(new Error('Nie udało się zapisać pliku.'), { status: 500 });
  }
  return send(res, 201, { file: name, size });
}

// ---- avatary kont (przekaźnik do mc-heads.net) -----------------------------------------------------
//
// Launcher prosi o twarz gracza własny serwer, a ten pobiera ją z mc-heads.net - serwis widzi wtedy adres serwera, a nie adres IP
// gracza. Do serwisu nie dokładamy niczego z żądania gracza (adres IP, nagłówki, klucz). Identyfikator to nick albo UUID (z
// kreskami lub bez); rozmiar zaokrąglamy w górę do jednego z kilku (więcej trafień w pamięci podręcznej); odpowiedź musi być małym PNG.
const AVATAR_UPSTREAM = String(process.env.AVATAR_UPSTREAM || 'https://mc-heads.net').replace(/\/+$/, ''); // AVATAR_UPSTREAM - tylko testy
const AVATAR_ID_RE = /^(?:[A-Za-z0-9_]{1,16}|[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const AVATAR_SIZES = [32, 64, 128, 256];
const AVATAR_DEFAULT_SIZE = 128;
const AVATAR_MAX_BYTES = 64 * 1024;
const AVATAR_OK_TTL_MS = 6 * 3600_000;
const AVATAR_FAIL_TTL_MS = 10 * 60_000;
const AVATAR_MAX_CACHED = 300;
const avatarCache = new Map(); // "id:rozmiar" -> { at, png | null }
const avatarInflight = new Map(); // "id:rozmiar" -> Promise<png | null>

function avatarSize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AVATAR_DEFAULT_SIZE;
  return AVATAR_SIZES.find((s) => s >= n) || AVATAR_SIZES[AVATAR_SIZES.length - 1];
}

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
    // przekierowań nie podążamy: odpowiedź ma przyjść z tego jednego adresu
    const res = await fetch(`${AVATAR_UPSTREAM}/avatar/${encodeURIComponent(id)}/${size}`, {
      headers: { 'User-Agent': 'CrownLauncher-avatars', Accept: 'image/png' },
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
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

// ---- peleryny graczy i obecność ---------------------------------------------------------------

const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const MAX_CAPE_BYTES = 1024 * 1024;
const MAX_CAPES = 5000;
const PRESENCE_DAYS = 60;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

// nick (małymi literami) -> { nick, secretHash, premium, seenAt, capeAt }
const loadPlayers = () => readJson(PLAYERS_FILE, {});
const savePlayers = (players) => writeJson(PLAYERS_FILE, players);

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

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > max) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Plik jest zbyt duży.'), { status: 413, close: true }));
      } else chunks.push(c);
    });
    req.on('end', () => !tooLarge && resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// identyfikatory dowodów już użyte (jednorazowe): serverId -> do kiedy pamiętamy
const usedProofs = new Map();
const PROOF_TTL_MS = 10 * 60_000;
const MAX_PROOFS = 10_000;

/**
 * Czy konto o tym nicku „dołączyło” do sesji Mojanga z podanym identyfikatorem (sessionserver, hasJoined).
 * Launcher losuje identyfikator i zgłasza go Mojangowi własnym tokenem - serwer nie dostaje tokenu w ogóle,
 * więc nie ma co wyciec, a przejęty serwer nie może działać „jako gracz”. Każdy identyfikator działa raz.
 */
async function verifyMojangProof(serverId, nick) {
  if (!/^[a-f0-9]{40}$/.test(serverId)) return false;
  const now = Date.now();
  if (usedProofs.size > 1000) for (const [id, until] of usedProofs) if (until < now) usedProofs.delete(id);
  if (usedProofs.has(serverId) || usedProofs.size >= MAX_PROOFS) return false;
  usedProofs.set(serverId, now + PROOF_TTL_MS);
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

/**
 * Sprawdza, czy żądający jest właścicielem nicka. Zwraca { players, entry } albo rzuca błąd HTTP.
 * Przy pierwszym użyciu nicka zapisuje sekret (konto offline) albo oznacza nick jako premium.
 */
async function authorizeNick(req, nick, key) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!NICK_RE.test(nick)) throw fail(400, 'Nick: 1–16 znaków, litery, cyfry i podkreślnik.');
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
  if (!secretOk) throw fail(401, 'Brak sekretu nicka (X-Crown-Secret).');
  if (entry?.premium) throw fail(403, 'Ten nick należy do konta Microsoft - zaloguj się nim w launcherze, aby udostępnić pelerynę.');
  if (!entry) {
    entry = players[id] = { nick, secretHash, premium: false, seenAt: 0, capeAt: 0 };
  } else if (!entry.secretHash) {
    entry.secretHash = secretHash;
  } else if (
    entry.secretHash.length !== secretHash.length ||
    !crypto.timingSafeEqual(Buffer.from(entry.secretHash, 'hex'), Buffer.from(secretHash, 'hex'))
  ) {
    throw fail(403, 'Ten nick jest już zajęty przez innego użytkownika launchera.');
  }
  return { players, entry, id };
}

function serveCape(req, res, nick) {
  const file = path.join(CAPES_DIR, `${nick.toLowerCase()}.png`);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Brak peleryny.' });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=120',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${st.size}-${Math.floor(st.mtimeMs)}"`,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function crownUsers() {
  const since = Date.now() - PRESENCE_DAYS * 86400_000;
  return Object.values(loadPlayers())
    .filter((p) => p.seenAt > since || p.capeAt > since)
    .map((p) => ({ name: `${p.nick}.png`, type: 'file' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Zdejmuje peleryny podanych nicków (id = nick małymi literami): klucz stracił dostęp do peleryn albo został
 * unieważniony. Nick zostaje na liście graczy (korona), znika tylko plik peleryny.
 */
function removeCapes(ids) {
  const list = (ids || []).filter((id) => /^[a-z0-9_]{1,16}$/.test(id));
  if (!list.length) return;
  const players = loadPlayers();
  for (const id of list) {
    fs.rmSync(path.join(CAPES_DIR, `${id}.png`), { force: true });
    if (players[id]) players[id].capeAt = 0;
  }
  savePlayers(players);
}

// ---- panel administratora (strona /admin + API /v1/admin/*) ---------------------------------------
//
// Logowanie: klucz admin wpisany w formularzu albo jednorazowy bilet (60 s) z `npm run panel`, który wymienia się na
// sesję w ciasteczku (HttpOnly, SameSite=Strict, 8 h). Operacje z ciasteczkiem wymagają nagłówka X-Crown-Panel
// (ochrona przed CSRF). Skrypty mogą używać klucza admin w nagłówku Authorization.

const PANEL_SESSION_MS = 8 * 3600_000;
const PANEL_TICKET_MS = 60_000;
const panelSessions = new Map(); // sid -> { exp, name }
const panelTickets = new Map(); // bilet -> { exp, name }

function findAdminKey(raw) {
  const given = Buffer.from(sha256(String(raw || '')), 'hex');
  let found = null;
  for (const k of loadKeys()) {
    const stored = Buffer.from(k.hash, 'hex');
    if (!k.revoked && k.role === 'admin' && stored.length === given.length && crypto.timingSafeEqual(stored, given)) found = k;
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
  const s = sid ? panelSessions.get(sid) : null;
  if (!s) return null;
  if (s.exp < Date.now()) {
    panelSessions.delete(sid);
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

function startSession(req, name) {
  const now = Date.now();
  for (const [id, v] of panelSessions) if (v.exp < now) panelSessions.delete(id);
  const sid = crypto.randomBytes(32).toString('base64url');
  panelSessions.set(sid, { exp: now + PANEL_SESSION_MS, name });
  const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
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

/** Zapis pliku wydarzenia strumieniem do pliku tymczasowego, potem rename (limit rozmiaru zależy od rodzaju). */
async function receiveEventFile(req, res, eventId, kind, rel) {
  const spec = EVENT_KINDS[kind];
  const target = path.join(EVENTS_DIR, eventId, kind, ...rel.split('/'));
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.part`);
  let size = 0;
  let head = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      if (size > spec.max) cb(Object.assign(new Error(`Plik jest zbyt duży (maks. ${Math.round(spec.max / MB)} MB).`), { status: 413, close: true }));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp));
    if (size === 0) throw Object.assign(new Error('Pusty plik.'), { status: 400 });
    // .jar i .zip to archiwa ZIP - nagłówek „PK”
    const needsZip = spec.zip || (spec.zipExt && spec.zipExt.test(rel));
    if (needsZip && (head[0] !== 0x50 || head[1] !== 0x4b)) throw Object.assign(new Error('To nie jest archiwum ZIP/JAR.'), { status: 400 });
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e.status ? e : Object.assign(new Error('Nie udało się zapisać pliku.'), { status: 500 });
  }
  return send(res, 201, { ok: true, name: rel, size, event: eventManifest(eventId) });
}

async function handleAdmin(req, res, route, ip) {
  if (route === 'POST /v1/admin/login') {
    if (rateLimited(`panel:${ip}`, 10)) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
    const body = await readBody(req);
    const k = findAdminKey(body.key);
    if (!k) return send(res, 401, { error: 'Nieprawidłowy klucz administratora.' });
    return send(res, 200, { ok: true, name: k.name }, { headers: { 'Set-Cookie': startSession(req, k.name) } });
  }
  if (route === 'POST /v1/admin/exchange') {
    if (rateLimited(`panel:${ip}`, 10)) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
    const body = await readBody(req);
    const t = panelTickets.get(String(body.ticket || ''));
    panelTickets.delete(String(body.ticket || ''));
    if (!t || t.exp < Date.now()) return send(res, 401, { error: 'Bilet wygasł albo został już użyty.' });
    return send(res, 200, { ok: true, name: t.name }, { headers: { 'Set-Cookie': startSession(req, t.name) } });
  }

  const admin = adminOf(req);
  if (!admin) return send(res, 401, { error: 'Zaloguj się do panelu.' });

  if (route === 'POST /v1/admin/ticket') {
    if (admin.via !== 'key') return send(res, 403, { error: 'Bilet wydaje tylko klucz administratora.' });
    const now = Date.now();
    for (const [id, v] of panelTickets) if (v.exp < now) panelTickets.delete(id);
    const ticket = crypto.randomBytes(24).toString('base64url');
    panelTickets.set(ticket, { exp: now + PANEL_TICKET_MS, name: admin.name });
    return send(res, 200, { ticket, expiresIn: PANEL_TICKET_MS / 1000 });
  }
  if (route === 'POST /v1/admin/logout') {
    panelSessions.delete(cookieOf(req, 'crown_panel'));
    return send(res, 200, { ok: true }, { headers: { 'Set-Cookie': 'crown_panel=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' } });
  }
  if (route === 'GET /v1/admin/info') {
    return send(res, 200, { installer: latestInstaller() || null, linuxInstaller: latestInstaller('linux') || null, inviteOnly: INVITE_ONLY, name: admin.name });
  }
  if (route === 'GET /v1/admin/invites') {
    const list = loadInvites().map(publicInvite).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return send(res, 200, { invites: list });
  }
  if (route === 'POST /v1/admin/invites') {
    if (rateLimited(`mk:${admin.name}`, 60, 3_600_000)) return send(res, 429, { error: 'Zbyt wiele nowych kluczy naraz.' });
    const body = await readBody(req);
    const parsed = parseInviteFields(body, { create: true });
    if (parsed.error) return send(res, 400, { error: parsed.error });
    const { entry, key } = createInvite(parsed.values.name, parsed.values);
    return send(res, 201, { ...publicInvite(entry), key });
  }
  // ---- wydarzenia: metadane i pliki (modyfikacje tylko administrator) ----
  if (route === 'GET /v1/admin/events') {
    const ids = new Set(Object.keys(DEFAULT_EVENTS));
    try {
      for (const d of fs.readdirSync(EVENTS_DIR)) if (EVENT_ID_RE.test(d)) ids.add(d);
    } catch {
      /* brak katalogu */
    }
    return send(res, 200, { events: [...ids].sort().map((id) => eventManifest(id)) });
  }
  const evAdmin = new RegExp(`^(POST|PUT|DELETE) /v1/admin/events/([a-z0-9-]{1,32})(?:/(${EVENT_KIND_RE})(?:/([^/]+))?)?$`).exec(route);
  if (evAdmin) {
    const [, method, eventId, kind, rawName] = evAdmin;
    if (!eventExists(eventId)) return send(res, 404, { error: 'Nie ma takiego wydarzenia.' });
    if (method === 'POST' && !kind) {
      const body = await readBody(req);
      const dir = path.join(EVENTS_DIR, eventId);
      fs.mkdirSync(dir, { recursive: true });
      const cur = eventMeta(eventId);
      const next = { ...cur };
      if (body.title !== undefined) {
        next.title = String(body.title || '').trim().slice(0, 60);
        if (!next.title) return send(res, 400, { error: 'Podaj nazwę wydarzenia.' });
      }
      if (body.mcVersion !== undefined) {
        next.mcVersion = String(body.mcVersion || '').trim();
        if (next.mcVersion && !/^\d+\.\d+(?:\.\d+)?$/.test(next.mcVersion)) return send(res, 400, { error: 'Wersja Minecrafta w formacie 1.21.11.' });
      }
      if (body.crownClient !== undefined) next.crownClient = Boolean(body.crownClient);
      if (body.note !== undefined) next.note = String(body.note || '').slice(0, 300);
      if (body.enforce !== undefined) {
        // { "config/sodium-options.json": true, "root/options.txt": false } - czy plik ma być przywracany przy każdym starcie
        if (!body.enforce || typeof body.enforce !== 'object' || Array.isArray(body.enforce)) return send(res, 400, { error: 'Niepoprawne ustawienia wymuszania.' });
        next.enforce = { ...cur.enforce };
        for (const [k, v] of Object.entries(body.enforce)) {
          const m = /^(config|root)\/(.+)$/.exec(k);
          if (!m || !eventRel(m[1], m[2]) || typeof v !== 'boolean') return send(res, 400, { error: `Niepoprawne ustawienie wymuszania: ${String(k).slice(0, 60)}` });
          next.enforce[k] = v;
        }
      }
      writeJson(path.join(dir, 'event.json'), next);
      return send(res, 200, { ok: true, event: eventManifest(eventId) });
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
      name = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    }
    const rel = kind ? eventRel(kind, name) : '';
    if (!rel) return send(res, 400, { error: kind ? EVENT_KINDS[kind].label : 'Podaj rodzaj pliku wydarzenia.' });
    if (method === 'DELETE') {
      const base = path.join(EVENTS_DIR, eventId, kind);
      const target = path.join(base, ...rel.split('/'));
      fs.rmSync(target, { force: true });
      // puste foldery configu sprzątamy, a flaga wymuszania znika razem z plikiem
      for (let d = path.dirname(target); d !== base && d.startsWith(base); d = path.dirname(d)) {
        try {
          fs.rmdirSync(d);
        } catch {
          break;
        }
      }
      const metaFile = path.join(EVENTS_DIR, eventId, 'event.json');
      const saved = readJson(metaFile, null);
      if (saved && saved.enforce && `${kind}/${rel}` in saved.enforce) {
        delete saved.enforce[`${kind}/${rel}`];
        writeJson(metaFile, saved);
      }
      return send(res, 200, { ok: true, event: eventManifest(eventId) });
    }
    if (method === 'PUT') return receiveEventFile(req, res, eventId, kind, rel);
    return send(res, 404, { error: 'Nie znaleziono.' });
  }

  // ---- bramka serwera gry: klucz dla pluginu na proxy, podgląd i zdejmowanie sesji ----
  if (route === 'GET /v1/admin/gate') {
    const gate = readJson(GATE_FILE, null);
    const now = Date.now();
    return send(res, 200, {
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
    if (admin.via !== 'key') return send(res, 403, { error: 'Klucz bramki wydaje tylko klucz administratora.' });
    const gateKey = `gate_${crypto.randomBytes(24).toString('base64url')}`;
    writeJson(GATE_FILE, { hash: sha256(gateKey), createdAt: new Date().toISOString() });
    return send(res, 201, { key: gateKey }); // pokazany tylko raz; nowy klucz unieważnia poprzedni
  }
  const playDel = /^DELETE \/v1\/admin\/play\/([A-Za-z0-9_]{3,16})$/.exec(route);
  if (playDel) {
    const had = plays.delete(playDel[1].toLowerCase());
    for (const k of [...playEvents.keys()]) if (k.startsWith(`${playDel[1].toLowerCase()}:`)) playEvents.delete(k); // także sesje z wydarzeń
    return send(res, had ? 200 : 404, had ? { ok: true } : { error: 'Ten nick nie ma sesji.' });
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
      if (parsed.error) return send(res, 400, { error: parsed.error });
      entry = updateInvite(id, (e) => {
        if (parsed.values.capes === false) {
          goneCapes = e.capeNicks || [];
          e.capeNicks = [];
        }
        Object.assign(e, parsed.values);
      });
    }
    else if (method === 'DELETE' && !action) {
      const all = loadInvites();
      entry = all.find((x) => x.id === id) || null;
      if (entry && !entry.revoked) return send(res, 409, { error: 'Najpierw unieważnij klucz.' });
      if (entry) writeJson(INVITES_FILE, all.filter((x) => x.id !== id));
    } else return send(res, 404, { error: 'Nie znaleziono.' });
    if (!entry) return send(res, 404, { error: 'Nie znaleziono zaproszenia.' });
    removeCapes(goneCapes);
    return send(res, 200, { ok: true, invite: publicInvite(entry) });
  }
  return send(res, 404, { error: 'Nie znaleziono.' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

  if (route === 'GET /health') return send(res, 200, { ok: true });

  // pliki aktualizacji są publiczne (bez limitu - pobieranie różnicowe wysyła wiele żądań)
  const pub = /^(GET|HEAD) \/updates\/([^/]+)$/.exec(route);
  if (pub) {
    let name = '';
    try {
      name = decodeURIComponent(pub[2]);
    } catch {
      /* niepoprawne kodowanie */
    }
    if (!UPDATE_FILE_RE.test(name)) return send(res, 404, { error: 'Nie znaleziono.' });
    if (!invited(req)) return denyInvite(res, ip, req); // tryb prywatny: bez zaproszenia nie ma ani latest.yml, ani instalatora
    return serveUpdate(req, res, name);
  }

  // panel administratora: szkielet strony jest publiczny, dane tylko z sesją (API /v1/admin/*)
  const PANEL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  if (route === 'GET /admin' || route === 'GET /admin/') {
    res.writeHead(200, { ...HTML_HEADERS, 'Content-Security-Policy': PANEL_CSP, 'Content-Length': Buffer.byteLength(panel.html) });
    return res.end(panel.html);
  }
  if (route === 'GET /admin/app.js' || route === 'GET /admin/app.css') {
    const isJs = route.endsWith('.js');
    const body = isJs ? panel.js : panel.css;
    res.writeHead(200, {
      'Content-Type': `${isJs ? 'text/javascript' : 'text/css'}; charset=utf-8`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(body);
  }

  // zasoby wspólne dla strony pobierania i panelu: logo, style, skrypt strony pobierania
  // Logo tylko jako obraz własnej strony (tło CSS): przeglądarka dokłada Sec-Fetch-Dest: image i Sec-Fetch-Site: same-origin,
  // a wpisanie adresu, „otwórz w nowej karcie” (document) i obce strony dostają 404. To utrudnienie, nie zabezpieczenie (nagłówki da się podrobić).
  if (route === 'GET /logo.png') {
    const asPageImage = req.headers['sec-fetch-dest'] === 'image' && req.headers['sec-fetch-site'] === 'same-origin';
    const vary = { Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site' };
    if (!site.logo || !asPageImage) return send(res, 404, { error: 'Nie znaleziono.' }, { headers: vary });
    res.writeHead(200, { ...vary, 'Content-Type': 'image/png', 'Content-Length': site.logo.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    return res.end(site.logo);
  }
  // ikona karty (32 px) jest publiczna: przeglądarka pobiera ją sama, bez nagłówków strony (w Chromium Sec-Fetch-Dest: empty, Site: none), więc bramki nie przejdzie
  if (route === 'GET /favicon.png') {
    if (!site.favicon) return send(res, 404, { error: 'Nie znaleziono.' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': site.favicon.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return res.end(site.favicon);
  }
  if (route === 'GET /site.css' || route === 'GET /site.js') {
    const isJs = route.endsWith('.js');
    const body = isJs ? site.js : site.css;
    res.writeHead(200, {
      'Content-Type': `${isJs ? 'text/javascript' : 'text/css'}; charset=utf-8`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(body);
  }

  // strona pobierania instalatora (tylko tryb prywatny): formularz z kluczem zaproszenia
  if (INVITE_ONLY && (route === 'GET /' || route === 'GET /download')) return sendHtml(res, 200, downloadPage());
  if (INVITE_ONLY && route === 'POST /download') {
    if (rateLimited(`dl:${ip}`, 20)) return sendHtml(res, 429, downloadPage('Zbyt wiele prób. Spróbuj za minutę.'));
    const form = await readForm(req);
    const inv = findInvite(form.key);
    if (!inv) return sendHtml(res, 401, downloadPage('Nieprawidłowy lub unieważniony klucz zaproszenia.'));
    if (isExpired(inv)) return sendHtml(res, 401, downloadPage('Ten klucz wygasł. Poproś administratora o nowy klucz.'));
    touchInvite(inv);
    updateInvite(inv.id, (e) => {
      e.downloads = (e.downloads || 0) + 1;
      e.lastDownloadAt = new Date().toISOString();
    });
    const installer = latestInstaller();
    if (!installer) return sendHtml(res, 404, downloadPage('Instalator nie został jeszcze opublikowany.'));
    return serveUpdate(req, res, installer, { attachment: true });
  }

  // lista blokad antycheata (zamiast blocklist.json z GitHuba): plik DATA_DIR/blocklist.json, edytowany na serwerze
  if (route === 'GET /blocklist.json') {
    if (!invited(req)) return denyInvite(res, ip, req);
    const text = (() => {
      try {
        return fs.readFileSync(path.join(DATA_DIR, 'blocklist.json'), 'utf8');
      } catch {
        return '{}';
      }
    })();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(text);
  }

  // peleryny i lista graczy z koroną są publiczne (czyta je gra, bez klucza); limit na adres IP
  const cape = /^(GET|HEAD) \/capes\/([A-Za-z0-9_]{1,16})\.png$/.exec(route);
  if (cape) {
    if (rateLimited(`cape:${ip}`, 600)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    return serveCape(req, res, cape[2]);
  }
  if (route === 'GET /v1/crown-users') {
    if (rateLimited(`list:${ip}`, 120)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    return send(res, 200, crownUsers());
  }

  const key = authenticate(req);
  if (req.headers.authorization && !key) {
    // nieudane próby uwierzytelnienia liczymy osobno (ochrona przed zgadywaniem)
    if (rateLimited(`auth:${ip}`, 10)) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
    return send(res, 401, { error: 'Nieprawidłowy lub unieważniony klucz dostępu.' });
  }
  // panel administratora ma osobny, hojniejszy limit (wgrywanie całego folderu config to setki zapytań); logowanie
  // i tak ma własny, ostry limit prób
  if (url.pathname.startsWith('/v1/admin/')) {
    if (rateLimited(`adm:${ip}`, 3000)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    return handleAdmin(req, res, route, ip);
  }
  // pytanie pluginu na proxy, czy nick wchodzi z launchera: własny, wyższy limit (zalew prób wejścia nie może zablokować
  // sprawdzania prawdziwych graczy), a błędny klucz bramki liczymy osobno (ochrona przed zgadywaniem)
  if (route === 'GET /v1/gate/check') {
    if (!gateKeyValid(req.headers['x-crown-gate'])) {
      if (rateLimited(`gateauth:${ip}`, 10)) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za minutę.' });
      return send(res, 401, { error: 'Nieprawidłowy klucz bramki.' });
    }
    if (rateLimited('gatecheck', 3000)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    const nick = url.searchParams.get('nick') || '';
    if (!PLAY_NICK_RE.test(nick)) return send(res, 400, { error: 'Niepoprawny nick.' });
    const event = (url.searchParams.get('event') || '').toLowerCase();
    if (event && !EVENT_ID_RE.test(event)) return send(res, 400, { error: 'Niepoprawne wydarzenie.' });
    return send(res, 200, gateVerdict(nick, event));
  }

  if (rateLimited(`ip:${ip}`, 120)) return send(res, 429, { error: 'Zbyt wiele żądań.' });

  // sprawdzenie klucza zaproszenia (launcher woła to przy wpisaniu klucza i co jakiś czas)
  if (route === 'GET /v1/invite') {
    if (key) return send(res, 200, { ok: true, name: key.name, role: key.role, profile: '', capes: true, disableClient: true });
    // Kod wydarzenia działa tylko w launcherze, który zna tryb wydarzenia (nagłówek X-Crown-Features: event) - starszy
    // potraktowałby go jak zwykły klucz i dał pełny dostęp. Odrzucamy przed związaniem klucza z komputerem.
    const peek = findInvite(req.headers['x-crown-invite']);
    const features = String(req.headers['x-crown-features'] || '').split(',').map((f) => f.trim());
    if (peek && peek.profile && !features.includes('event')) {
      req.inviteAccess = { ok: false, status: 401, error: 'Ten kod wymaga nowszej wersji CrownLaunchera. Pobierz aktualny launcher ze strony i spróbuj ponownie.' };
      return denyInvite(res, ip, req);
    }
    const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
    if (!access.ok) {
      req.inviteAccess = access;
      return denyInvite(res, ip, req);
    }
    return send(res, 200, { ok: true, name: access.inv.name, role: 'player', activated: access.activated, profile: access.inv.profile || '', capes: Boolean(access.inv.capes), disableClient: Boolean(access.inv.disableClient) });
  }

  // avatar konta przez serwer (mc-heads.net nie zobaczy adresu IP gracza): tylko z kluczem zaproszenia, osobny limit
  const avatarReq = /^GET \/v1\/avatar\/([A-Za-z0-9_-]{1,36})$/.exec(route);
  if (avatarReq) {
    if (!invited(req)) return denyInvite(res, ip, req);
    if (rateLimited(`avatar:${ip}`, 60)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    if (!AVATAR_ID_RE.test(avatarReq[1])) return send(res, 400, { error: 'Niepoprawny identyfikator gracza.' });
    const png = await avatarPng(avatarReq[1].replace(/-/g, ''), avatarSize(url.searchParams.get('size')));
    if (!png) return send(res, 404, { error: 'Nie ma avatara tego gracza.' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return res.end(png);
  }

  // ---- wydarzenia: lista plików i pliki dla kluczy z profilem wydarzenia (albo administratora) ----
  const ev = new RegExp(`^GET /v1/event/([a-z0-9-]{1,32})(/info|/file/(${EVENT_KIND_RE})(?:/([^/]+))?)?$`).exec(route);
  if (ev) {
    const [, eventId, tail, kind, rawName] = ev;
    if (!eventExists(eventId)) return send(res, 404, { error: 'Nie ma takiego wydarzenia.' });
    if (!(key && key.role === 'admin')) {
      // zwykły klucz zaproszenia wystarcza tylko do „info”; pliki wymagają klucza z profilem tego wydarzenia
      const access = checkInvite(req.headers['x-crown-invite'], req.headers['x-crown-device'], req);
      if (!access.ok) {
        req.inviteAccess = access;
        return denyInvite(res, ip, req);
      }
      if (tail !== '/info' && access.inv.profile !== eventId) {
        return send(res, 403, { error: 'To wydarzenie wymaga kodu dostępu. Wpisz kod Igrzysk.' });
      }
    }
    if (tail === '/info') {
      const m = eventManifest(eventId);
      return send(res, 200, { id: eventId, title: m.title, ready: eventReady(m) });
    }
    if (!tail) return send(res, 200, eventManifest(eventId));
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
    if (!rel) return send(res, 404, { error: 'Nie znaleziono pliku.' });
    const file = path.join(EVENTS_DIR, eventId, kind, ...rel.split('/'));
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return send(res, 404, { error: 'Nie znaleziono pliku.' });
    }
    if (!st.isFile()) return send(res, 404, { error: 'Nie znaleziono pliku.' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return;
  }

  if (route === 'GET /v1/announcements') {
    if (!invited(req)) return denyInvite(res, ip, req);
    const now = Date.now();
    const list = loadAnnouncements()
      .filter((a) => !a.expiresAt || new Date(a.expiresAt).getTime() > now)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50)
      .map((a) => publicView(a, key));
    return send(res, 200, { announcements: list });
  }

  if (route === 'GET /v1/me') {
    if (!key) return send(res, 401, { error: 'Wymagany klucz dostępu.' });
    return send(res, 200, { keyId: key.id, name: key.name, role: key.role });
  }

  const capePut = /^(PUT|DELETE) \/v1\/capes\/([A-Za-z0-9_]{1,16})$/.exec(route);
  if (capePut) {
    if (!invited(req)) return denyInvite(res, ip, req);
    // Wgrywanie peleryn jest tylko dla kluczy z dostępem do peleryn (nadaje go administrator w panelu). Zdjęcie własnej
    // peleryny (DELETE) wolno każdemu - launcher bez dostępu sam sprząta po sobie. Klucze administracji i tryb bez
    // zaproszeń (INVITE_ONLY wyłączone) nie podlegają temu ograniczeniu.
    const capeInvite = INVITE_ONLY && !key ? req.inviteAccess?.inv : null;
    if (capePut[1] === 'PUT' && INVITE_ONLY && !key && !capeInvite?.capes) {
      return send(res, 403, { error: 'Peleryny są dostępne tylko dla wybranych graczy. Poproś administratora o dostęp.' });
    }
    if (rateLimited(`capewrite:${ip}`, 30, 3_600_000)) return send(res, 429, { error: 'Zbyt wiele zmian peleryn. Spróbuj za godzinę.' });
    const nick = capePut[2];
    let png = null;
    if (capePut[1] === 'PUT') {
      png = await readRaw(req, MAX_CAPE_BYTES);
      const problem = capeProblem(png);
      if (problem) return send(res, 400, { error: problem });
    }
    const { players, entry, id } = await authorizeNick(req, nick, key);
    fs.mkdirSync(CAPES_DIR, { recursive: true });
    const file = path.join(CAPES_DIR, `${id}.png`);
    if (png) {
      if (!fs.existsSync(file) && fs.readdirSync(CAPES_DIR).length >= MAX_CAPES) {
        return send(res, 507, { error: 'Serwer peleryn jest pełny.' });
      }
      fs.writeFileSync(file, png);
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
      return send(res, 201, { nick: entry.nick, size: png.length });
    }
    fs.rmSync(file, { force: true });
    entry.capeAt = 0;
    savePlayers(players);
    return send(res, 204);
  }

  if (route === 'POST /v1/presence') {
    if (!invited(req)) return denyInvite(res, ip, req);
    if (rateLimited(`presence:${ip}`, 60, 3_600_000)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    const body = await readBody(req);
    const { players, entry } = await authorizeNick(req, String(body.nick || ''), key);
    entry.seenAt = Date.now();
    savePlayers(players);
    return send(res, 204);
  }

  // sesja gry z launchera: zgłaszana przy starcie gry i co minutę (POST), zdejmowana po jej zamknięciu (DELETE ?nick=)
  if (route === 'POST /v1/play' || route === 'DELETE /v1/play') {
    if (!invited(req)) return denyInvite(res, ip, req);
    if (rateLimited(`play:${ip}`, 240)) return send(res, 429, { error: 'Zbyt wiele żądań.' });
    const inv = INVITE_ONLY && !key ? req.inviteAccess?.inv : null;
    const device = String(req.headers['x-crown-device'] || '');
    const dev = DEVICE_RE.test(device) ? deviceHash(device) : '';
    const owner = inv ? `i:${inv.id}` : key ? `k:${key.id}` : '';
    if (req.method === 'DELETE') {
      const nick = url.searchParams.get('nick') || '';
      if (!PLAY_NICK_RE.test(nick)) return send(res, 400, { error: 'Niepoprawny nick.' });
      const cur = plays.get(nick.toLowerCase());
      if (cur && cur.owner === owner) plays.delete(nick.toLowerCase()); // cudzej sesji nie ruszamy
      for (const [k, v] of playEvents) if (k.startsWith(`${nick.toLowerCase()}:`) && v.owner === owner) playEvents.delete(k);
      return send(res, 204);
    }
    const body = await readBody(req);
    const nick = String(body.nick || '');
    if (!PLAY_NICK_RE.test(nick)) return send(res, 400, { error: 'Niepoprawny nick.' });
    const uuid = /^[0-9a-f-]{32,36}$/i.test(String(body.uuid || '')) ? String(body.uuid).toLowerCase() : '';
    // sesja z instancji wydarzenia: tylko klucz z profilem tego wydarzenia (kod wydarzenia) albo klucz administracji
    const event = String(body.event || '').trim().toLowerCase();
    if (event) {
      if (!EVENT_ID_RE.test(event) || !eventExists(event)) return send(res, 400, { error: 'Nie ma takiego wydarzenia.' });
      if (inv && inv.profile !== event) return send(res, 403, { error: 'Do gry w wydarzeniu potrzebny jest kod wydarzenia. Wpisz go w zakładce wydarzenia.' });
    }
    const now = Date.now();
    const active = activePlays();
    if (inv && active.filter((p) => p.owner === owner && p.dev === dev && p.nick.toLowerCase() !== nick.toLowerCase()).length >= PLAY_MAX_PER_DEVICE) {
      return send(res, 429, { error: `Z jednego komputera można grać naraz na co najwyżej ${PLAY_MAX_PER_DEVICE} nickach.` });
    }
    const prev = plays.get(nick.toLowerCase());
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
    plays.set(nick.toLowerCase(), session); // każda gra z launchera jest też zwykłą sesją (wymagają jej pluginy bez „event”)
    if (event) {
      const evKey = `${nick.toLowerCase()}:${event}`;
      const prevEv = playEvents.get(evKey);
      playEvents.set(evKey, { ...session, event, at: prevEv && prevEv.exp >= now && prevEv.owner === owner ? prevEv.at : now });
    }
    return send(res, 200, { ok: true, ttl: PLAY_TTL_MS / 1000 });
  }

  const upload = /^PUT \/v1\/updates\/([^/]+)$/.exec(route);
  if (upload) {
    let name = '';
    try {
      name = decodeURIComponent(upload[1]);
    } catch {
      /* niepoprawne kodowanie */
    }
    return receiveUpdate(req, res, name, key);
  }

  if (route === 'POST /v1/announcements') {
    if (!key) return send(res, 401, { error: 'Wymagany klucz dostępu.' });
    if (rateLimited(`write:${key.id}`, 20)) return send(res, 429, { error: 'Zbyt wiele ogłoszeń naraz. Spróbuj za minutę.' });
    const data = validateAnnouncement(await readBody(req));
    const entry = {
      id: crypto.randomBytes(5).toString('hex'),
      ...data,
      author: key.name,
      keyId: key.id,
      createdAt: new Date().toISOString(),
    };
    let all = loadAnnouncements();
    all.push(entry);
    if (all.length > MAX_STORED) {
      // usuwamy najstarsze nieprzypięte
      all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt));
      all = all.slice(0, MAX_STORED);
    }
    writeJson(ANN_FILE, all);
    return send(res, 201, { announcement: publicView(entry, key) });
  }

  const del = /^DELETE \/v1\/announcements\/([a-f0-9]{4,32})$/.exec(route);
  if (del) {
    if (!key) return send(res, 401, { error: 'Wymagany klucz dostępu.' });
    const all = loadAnnouncements();
    const entry = all.find((a) => a.id === del[1]);
    if (!entry) return send(res, 404, { error: 'Nie znaleziono ogłoszenia.' });
    if (key.role !== 'admin' && entry.keyId !== key.id) {
      return send(res, 403, { error: 'Możesz usuwać tylko własne ogłoszenia.' });
    }
    writeJson(ANN_FILE, all.filter((a) => a.id !== entry.id));
    return send(res, 204);
  }

  return send(res, 404, { error: 'Nie znaleziono.' });
}

function main() {
  try {
    if (cli(process.argv.slice(2))) return;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        send(res, e.status || 500, { error: e.status ? e.message : 'Błąd serwera.' }, { close: Boolean(e.close) });
      }
      if (!e.status) console.error(e);
    });
  });
  server.requestTimeout = 10 * 60_000; // wgrywanie instalatora (~100 MB) może trwać dłużej niż JSON
  server.listen(PORT, HOST, () => {
    console.log(`Serwer ogłoszeń CrownLaunchera: http://${HOST}:${PORT}  (dane: ${DATA_DIR})`);
    if (!loadKeys().length) console.log('Brak kluczy - utwórz: node server/server.js create-key "Nazwa" admin');
  });
}

main();
