const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = 'C:/Users/meabx/Desktop/CrownLauncher/src/main/core/';

let n = 0;
const ok = (t) => console.log(`OK  ${++n}. ${t}`);

// ---- atrapa serwerów Minecrafta (global fetch) -----------------------------------------------------------
const skinPng = require(root + 'cape-art.js').encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(200));
const MS_UUID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const state = {
  profile: {
    id: MS_UUID,
    name: 'PremiumGracz',
    skins: [{ id: 's1', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/aaa111', variant: 'CLASSIC' }],
    capes: [{ id: 'cape-1', state: 'INACTIVE', alias: 'Migrator' }],
  },
  premium: { // sesja Mojang dla nicku (konto offline)
    NickPremium: { id: 'ffeeddccbbaa99887766554433221100', name: 'NickPremium', skinUrl: 'http://textures.minecraft.net/texture/bbb222', model: 'slim' },
  },
  calls: [],
  tokenOk: true,
};

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  state.calls.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
  const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'api.minecraftservices.com') {
    if (u.pathname === '/minecraft/profile') return state.tokenOk ? json(200, state.profile) : json(401, {});
    const m = /^\/minecraft\/profile\/lookup\/name\/(.+)$/.exec(u.pathname);
    if (m) {
      const p = state.premium[decodeURIComponent(m[1])];
      return p ? json(200, { id: p.id, name: p.name }) : json(404, { errorMessage: 'not found' });
    }
  }
  if (u.host === 'sessionserver.mojang.com') {
    const id = u.pathname.split('/').pop();
    const p = Object.values(state.premium).find((x) => x.id === id);
    if (!p) return json(404, {});
    const textures = p.skinUrl ? { SKIN: { url: p.skinUrl, ...(p.model === 'slim' ? { metadata: { model: 'slim' } } : {}) } } : {};
    return json(200, { id, name: p.name, properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({ textures })).toString('base64') }] });
  }
  if (u.host === 'textures.minecraft.net') return new Response(skinPng, { status: 200 });
  return json(404, {});
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-official-'));
  require(root + 'paths.js').init(dir);
  const config = require(root + 'config.js');
  const auth = require(root + 'auth.js');
  const skins = require(root + 'skins.js');

  const accounts = {
    ms: { id: 'ms1', type: 'microsoft', username: 'PremiumGracz', uuid: '11111111-2222-3333-4444-555555555555' },
    off: { id: 'off1', type: 'offline', username: 'NickPremium', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    off2: { id: 'off2', type: 'offline', username: 'KtosInny', uuid: '12345678-1234-1234-1234-123456789abc' },
  };
  let selected = 'ms1';
  auth.listPublic = () => ({ accounts: Object.values(accounts), selected });
  auth.getLaunchAccount = async () => ({ accessToken: 'tok', username: accounts.ms.username });

  // ---- konto Microsoft: skin + model + pierwszy odczyt ----
  let p = await skins.accountProfile();
  assert.strictEqual(p.available, true);
  assert.strictEqual(p.name, 'PremiumGracz');
  assert.strictEqual(p.model, 'classic');
  assert.strictEqual(p.skin.variant, 'classic');
  assert.match(p.skin.dataUrl, /^data:image\/png;base64,/);
  assert.strictEqual(p.defaultSkin, false);
  assert.strictEqual(p.change.first, true);
  assert.strictEqual(p.change.any, false, 'pierwszy odczyt niczego nie zgłasza');
  ok('konto Microsoft: aktywny skin, model classic (Steve), pierwszy odczyt bez „zmiany”');

  // ---- bez zmian ----
  p = await skins.accountProfile();
  assert.strictEqual(p.change.any, false);
  assert.strictEqual(p.change.first, false);
  const texturesBefore = state.calls.filter((c) => c.includes('textures.minecraft.net')).length;
  await skins.accountProfile();
  assert.strictEqual(state.calls.filter((c) => c.includes('textures.minecraft.net')).length, texturesBefore, 'tekstura z cache');
  ok('kolejny odczyt: brak zmiany, tekstura nie jest pobierana ponownie');

  // ---- zmiana modelu w oficjalnym Minecrafcie: Steve -> Alex ----
  state.profile.skins[0].variant = 'SLIM';
  p = await skins.accountProfile();
  assert.strictEqual(p.model, 'slim');
  assert.strictEqual(p.skin.variant, 'slim');
  assert.deepStrictEqual({ any: p.change.any, skin: p.change.skin, model: p.change.model, cape: p.change.cape }, { any: true, skin: false, model: true, cape: false });
  assert.strictEqual(p.change.previousModel, 'classic');
  p = await skins.accountProfile();
  assert.strictEqual(p.change.any, false, 'zmiana zgłoszona jednokrotnie');
  ok('zmiana Steve → Alex w oficjalnym Minecrafcie: wykryty model slim, zgłoszona raz');

  // ---- zmiana skina (nowy plik) ----
  state.profile.skins[0] = { id: 's2', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/ccc333', variant: 'SLIM' };
  p = await skins.accountProfile();
  assert.strictEqual(p.change.skin, true);
  assert.strictEqual(p.change.model, false);
  assert.strictEqual(p.change.any, true);
  ok('zmiana skina (nowa tekstura): wykryta');

  // ---- zmiana peleryny konta ----
  state.profile.capes[0].state = 'ACTIVE';
  p = await skins.accountProfile();
  assert.strictEqual(p.change.cape, true);
  assert.strictEqual(p.capes.find((c) => c.active).id, 'cape-1');
  ok('zmiana aktywnej peleryny konta: wykryta');

  // ---- zmiana zrobiona z launchera: quiet nie zgłasza ----
  state.profile.skins[0] = { id: 's3', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/ddd444', variant: 'CLASSIC' };
  p = await skins.accountProfile({ quiet: true });
  assert.strictEqual(p.change.any, false);
  assert.strictEqual(p.model, 'classic');
  p = await skins.accountProfile();
  assert.strictEqual(p.change.any, false, 'po quiet stan jest zapisany');
  ok('zmiana wykonana z launchera (quiet) nie jest zgłaszana jako zmiana w Minecrafcie');

  // ---- stan zapisany na dysku (przeżywa restart) ----
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(saved.skinSeen['11111111-2222-3333-4444-555555555555']);
  assert.strictEqual(saved.skinSeen['11111111-2222-3333-4444-555555555555'].model, 'classic');
  ok('ostatnio widziany skin zapisany w config.json (wykrywanie zmian działa też po restarcie)');

  // ---- konto bez własnego skina: model domyślny z UUID ----
  state.profile.skins = [];
  p = await skins.accountProfile({ quiet: true });
  assert.strictEqual(p.skin, null);
  assert.strictEqual(p.defaultSkin, true);
  assert.ok(['classic', 'slim'].includes(p.model));
  ok(`konto bez własnego skina: domyślny skin, model z UUID (${p.model})`);

  // ---- konto offline: skin premium o tym samym nicku ----
  selected = 'off1';
  p = await skins.accountProfile();
  assert.strictEqual(p.available, false);
  assert.strictEqual(p.reason, 'offline');
  assert.strictEqual(p.official.found, true);
  assert.strictEqual(p.official.model, 'slim');
  assert.strictEqual(p.official.skin.variant, 'slim');
  assert.strictEqual(p.official.name, 'NickPremium');
  assert.strictEqual(p.official.change.first, true);
  ok('konto offline: czyta skin i model (slim/Alex) gracza premium o tym samym nicku');

  // cache nicku: drugi odczyt w ciągu minuty nie pyta sesji Mojang
  const before = state.calls.filter((c) => c.includes('sessionserver')).length;
  await skins.accountProfile();
  assert.strictEqual(state.calls.filter((c) => c.includes('sessionserver')).length, before);
  ok('konto offline: odczyt w ciągu minuty korzysta z cache (limit zapytań sesji Mojang)');

  // ---- konto offline bez konta premium ----
  selected = 'off2';
  p = await skins.accountProfile();
  assert.strictEqual(p.official.found, false);
  assert.strictEqual(p.official.skin, null);
  assert.strictEqual(p.official.defaultSkin, true);
  assert.ok(['classic', 'slim'].includes(p.official.model));
  ok(`konto offline bez konta premium: domyślny skin wg UUID (${p.official.model}), bez błędu`);

  // ---- błąd sesji ----
  selected = 'ms1';
  state.tokenOk = false;
  await assert.rejects(() => skins.accountProfile(), /Sesja Microsoft wygasła/);
  state.tokenOk = true;
  ok('wygasła sesja: czytelny błąd');

  // ---- lookupByName po refaktoryzacji ----
  const r = await skins.lookupByName('NickPremium');
  assert.strictEqual(r.name, 'NickPremium');
  assert.strictEqual(r.variant, 'slim');
  await assert.rejects(() => skins.lookupByName('Nieznany_1'), /Nie ma gracza/);
  state.premium.BezSkina = { id: '00112233445566778899aabbccddeeff', name: 'BezSkina', skinUrl: '', model: 'classic' };
  await assert.rejects(() => skins.lookupByName('BezSkina'), /domyślny skin/);
  await assert.rejects(() => skins.lookupByName('zły nick'), /Nick/);
  ok('pobieranie skina po nicku nadal działa (znaleziony, brak gracza, domyślny skin, zły nick)');

  // ---- config nie ma już kluczy po skinach ----
  assert.ok(!('skinByName' in config.get()));
  console.log(`\nWSZYSTKO OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(String(e.stack).split('\n').slice(0, 7).join('\n')); process.exit(1); });
