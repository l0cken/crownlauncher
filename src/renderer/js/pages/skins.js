import { call } from '../api.js';
import { h, icon, mount, toast, openModal, confirmModal, fmtAgo } from '../dom.js';
import { onLeave } from '../state.js';
import { navigate } from '../components.js';
import { createSkinViewer, loadImage, detectSlim, drawHead, drawCapeFace } from '../skin-viewer.js';
import { isCapeSize, normalizeCape } from '../cape-import.js';
import { refreshOfficialSkin, officialSkinOf, onOfficialSkin, officialProfile } from '../skin-watch.js';

const MODEL_LABEL = { classic: 'Klasyczny (Steve)', slim: 'Wąski (Alex)' };

// wybrany skin zapamiętujemy między wizytami: { type: 'lib', id } albo { type: 'account' }
let selected = null;
// peleryna, którą po ponownym narysowaniu strony pokazujemy w podglądzie (np. świeżo dodana)
let pendingCapePreview;
const imageCache = new Map();

function image(dataUrl) {
  if (!imageCache.has(dataUrl)) imageCache.set(dataUrl, loadImage(dataUrl));
  return imageCache.get(dataUrl);
}

function headCanvas(dataUrl, size = 56) {
  const canvas = h('canvas', { class: 'skin-head' });
  image(dataUrl).then((img) => drawHead(canvas, img, size)).catch(() => {});
  return canvas;
}

function capeCanvas(dataUrl, height = 96) {
  const canvas = h('canvas', { class: 'cape-face' });
  image(dataUrl).then((img) => drawCapeFace(canvas, img, height)).catch(() => {});
  return canvas;
}

function rerenderSkins() {
  if (location.hash === '#/skins') window.dispatchEvent(new Event('crown-rerender'));
  else navigate('#/skins');
}

// ---- panel administracji: gracze z koroną i peleryną widoczną dla wszystkich graczy launchera -------

function openStaffCapes(capes, onChanged) {
  const body = h('div');
  const nick = h('input', { class: 'input', placeholder: 'Nick gracza (dokładnie jak w grze)', maxlength: 16 });
  const select = h(
    'select',
    { class: 'select' },
    capes.map((c) => h('option', { value: c.id }, c.name)),
  );
  const assignBtn = h('button', { class: 'btn primary', onclick: assign }, icon('check', 16), 'Dodaj gracza');

  async function assign() {
    assignBtn.disabled = true;
    try {
      await call('capes:assign', nick.value.trim(), select.value);
      toast(`Dodano gracza ${nick.value.trim()}. Korona i peleryna pojawią się u graczy w ciągu kilku minut.`);
      nick.value = '';
      await paint();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'err');
    }
    assignBtn.disabled = false;
  }

  async function paint() {
    let rows = [];
    try {
      rows = await call('capes:assigned');
    } catch (e) {
      mount(body, h('div', { class: 'hint' }, e.message));
      return;
    }
    mount(
      body,
      rows.length
        ? h(
            'div',
            { class: 'list' },
            rows.map((r) =>
              h(
                'div',
                { class: 'card item' },
                h('img', { class: 'cape-face', src: r.url, alt: '', style: { height: '64px', imageRendering: 'pixelated', objectFit: 'none', objectPosition: '-6px -6px', width: '60px' } }),
                h('div', { class: 'body' }, h('div', { class: 'ttl' }, r.nick)),
                h(
                  'button',
                  {
                    class: 'btn icon ghost sm',
                    title: 'Usuń gracza z listy (korona i peleryna znikną)',
                    onclick: async () => {
                      try {
                        await call('capes:unassign', r.nick);
                        toast(`Usunięto gracza ${r.nick} z listy.`);
                        await paint();
                        onChanged?.();
                      } catch (e) {
                        toast(e.message, 'err');
                      }
                    },
                  },
                  icon('trash', 16),
                ),
              ),
            ),
          )
        : h('div', { class: 'hint' }, 'Na liście nie ma jeszcze nikogo.'),
    );
  }

  const modal = openModal({
    title: 'Gracze z koroną i peleryną',
    wide: true,
    body: [
      h(
        'p',
        { class: 'hint', style: { marginTop: 0, lineHeight: 1.5 } },
        'Gracz z tej listy ma koronę CrownClient przed nickiem (widzą ją wszyscy, którzy grają przez CrownLauncher) oraz pelerynę widoczną dla graczy launchera. Launcher nie wie sam, kto gra przez CrownLauncher — dodaj nick gracza tutaj. Wymaga zalogowania kluczem dostępu (jak ogłoszenia).',
      ),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-end', marginBottom: '14px' } }, h('div', { class: 'grow' }, nick), h('div', { class: 'grow' }, select), assignBtn),
      body,
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Zamknij')],
  });
  paint();
}

// ---- import skina (z pliku, nicku albo upuszczenia) -----------------------------

export async function openSkinImport({ dataUrl, name = '', variant }) {
  let img;
  try {
    img = await image(dataUrl);
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  const detected = detectSlim(img) ? 'slim' : 'classic';
  const form = { name: name || 'Mój skin', variant: variant || detected };

  const seg = h('div', { class: 'seg' });
  const paintSeg = () =>
    mount(
      seg,
      Object.entries(MODEL_LABEL).map(([id, label]) =>
        h(
          'button',
          {
            class: form.variant === id ? 'active' : '',
            onclick: () => {
              form.variant = id;
              paintSeg();
            },
          },
          label,
        ),
      ),
    );
  paintSeg();

  const saveBtn = h('button', { class: 'btn primary', onclick: submit }, 'Dodaj do biblioteki');
  async function submit() {
    saveBtn.disabled = true;
    try {
      const entry = await call('skins:add', { name: form.name, variant: form.variant, dataUrl });
      modal.close();
      selected = { type: 'lib', id: entry.id };
      toast(`Dodano skin „${entry.name}”.`);
      rerenderSkins();
    } catch (e) {
      toast(e.message, 'err');
      saveBtn.disabled = false;
    }
  }

  const nameInput = h('input', {
    class: 'input',
    value: form.name,
    maxlength: 32,
    oninput: (e) => (form.name = e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter') submit();
    },
  });

  const modal = openModal({
    title: 'Dodaj skin',
    body: [
      h(
        'div',
        { class: 'row', style: { marginBottom: '16px' } },
        headCanvas(dataUrl, 72),
        h('div', { class: 'grow' }, h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Nazwa'), nameInput)),
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Model ramion'), seg),
      h(
        'div',
        { class: 'hint', style: { marginTop: '8px' } },
        `Wykryty model: ${MODEL_LABEL[detected]}. Zmień, jeśli ramiona wyglądają niepoprawnie.`,
      ),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), saveBtn],
  });
  nameInput.focus();
  nameInput.select();
}

// ---- import peleryny (z pliku albo upuszczenia) ---------------------------------

/**
 * Dodaje pelerynę do biblioteki. Obraz dopasowujemy do formatu gry (OptiFine 46×22, 22×17, HD...), dzięki czemu
 * działają pliki z różnych źródeł, a nie tylko dokładnie 64×32.
 */
export async function importCape({ dataUrl, name = 'Peleryna' }) {
  try {
    const fitted = await normalizeCape(dataUrl);
    const entry = await call('capes:add', { name, dataUrl: fitted.dataUrl });
    pendingCapePreview = entry.id;
    const notes = [];
    if (fitted.changed) notes.push(`dopasowana do ${fitted.width}×${fitted.height}`);
    if (fitted.elytraAdded) notes.push('plik nie miał skrzydeł elytr — dorysowano je z peleryny');
    toast(`Dodano pelerynę „${entry.name}”${notes.length ? ` (${notes.join('; ')})` : ''}.`, 'ok', notes.length ? 6500 : 4200);
    rerenderSkins();
  } catch (e) {
    toast(e.message, 'err', 7000);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
    reader.readAsDataURL(file);
  });
}

/** PNG upuszczony na okno launchera: skin (64×64) albo peleryna (proporcje 2:1, 46×22, 22×17). */
export async function openImageImportFromFile(file) {
  if (file.size > 8 * 1024 * 1024) {
    toast('Plik jest za duży (maks. 8 MB).', 'err');
    return;
  }
  let dataUrl;
  let img;
  try {
    dataUrl = await readFileAsDataUrl(file);
    img = await image(dataUrl);
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  const name = file.name.replace(/\.png$/i, '');
  const { width, height } = img;

  if (width === 64 && height === 64) {
    openSkinImport({ dataUrl, name });
  } else if (width === 64 && height === 32) {
    // 64×32 to i stary skin, i standardowa peleryna - pytamy
    const modal = openModal({
      title: 'Skin czy peleryna?',
      body: h('p', { class: 'hint', style: { marginTop: 0, lineHeight: 1.5 } }, 'Plik 64×32 px może być starym skinem albo peleryną. Co z nim zrobić?'),
      actions: [
        h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              modal.close();
              openSkinImport({ dataUrl, name });
            },
          },
          'Skin',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              modal.close();
              importCape({ dataUrl, name });
            },
          },
          'Peleryna',
        ),
      ],
    });
  } else if (isCapeSize(width, height)) {
    importCape({ dataUrl, name });
  } else {
    toast(`Nie rozpoznaję pliku (${width}×${height} px). Skin ma 64×64 px, a peleryna proporcje 2:1 (np. 64×32) albo 46×22 / 22×17 px.`, 'err', 7000);
  }
}

async function pickFile() {
  try {
    const picked = await call('skins:pick');
    if (picked) openSkinImport({ dataUrl: picked.dataUrl, name: picked.fileName.replace(/\.png$/i, '') });
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function pickCape() {
  try {
    const picked = await call('capes:pick');
    if (picked) await importCape({ dataUrl: picked.dataUrl, name: picked.fileName.replace(/\.png$/i, '') });
  } catch (e) {
    toast(e.message, 'err', 7000);
  }
}

function openLookup() {
  const input = h('input', { class: 'input', placeholder: 'Nick gracza, np. Notch', maxlength: 16 });
  const btn = h('button', { class: 'btn primary', onclick: go }, icon('download', 16), 'Pobierz skin');
  async function go() {
    btn.disabled = true;
    try {
      const res = await call('skins:lookup', input.value);
      modal.close();
      openSkinImport({ dataUrl: res.dataUrl, name: res.name, variant: res.variant });
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  const modal = openModal({
    title: 'Pobierz skin po nicku',
    body: [
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Nick'), input),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Skin trafi do Twojej biblioteki — możesz go potem ustawić na koncie Microsoft.'),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), btn],
  });
  input.focus();
}

// ---- strona -----------------------------------------------------------------

export function renderSkins() {
  const page = h('div', { class: 'page' });
  const canvas = h('canvas', { class: 'skin-canvas' });
  const viewer = createSkinViewer(canvas);
  canvas.skinViewer = viewer; // uchwyt dla testów wizualnych
  onLeave(() => viewer?.destroy());

  let library = [];
  let profile = officialProfile(); // wynik skins:profile (ostatni odczyt, jeśli już jest)
  let profileError = '';
  let capeState = null; // wynik capes:state
  let capePreview = pendingCapePreview; // undefined: jeszcze nie wybrano, null: bez peleryny, tekst: id peleryny
  pendingCapePreview = undefined;
  let staff = false; // zalogowany kluczem dostępu (administracja)
  let assigned = { assigned: false }; // czy administracja nadała pelerynę temu nickowi

  // odczyty w tle (po powrocie do okna, co kilka minut) odświeżają stronę od razu
  const unsubscribe = onOfficialSkin((p) => {
    profile = p;
    profileError = '';
    paintAll();
  });
  onLeave(unsubscribe);

  const stageInfo = h('div');
  const side = h('div');

  // zwykły, jednolity skin do podglądu peleryny, gdy gracz nie ma jeszcze żadnego skina
  let fallbackSkin = null;
  function defaultSkin() {
    if (!fallbackSkin) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d');
      const rect = (col, x, y, w, hh) => {
        g.fillStyle = col;
        g.fillRect(x, y, w, hh);
      };
      rect('#c6926d', 0, 0, 32, 16); // głowa
      rect('#3a8f9f', 16, 16, 24, 16); // tułów
      rect('#c6926d', 40, 16, 16, 16); // prawa ręka
      rect('#3a3f9a', 0, 16, 16, 16); // prawa noga
      rect('#3a3f9a', 16, 48, 16, 16); // lewa noga
      rect('#c6926d', 32, 48, 16, 16); // lewa ręka
      g.fillStyle = '#2b2118';
      g.fillRect(8, 8, 2, 2); // oczy
      g.fillRect(14, 8, 2, 2);
      fallbackSkin = { variant: 'classic', dataUrl: c.toDataURL('image/png') };
    }
    return fallbackSkin;
  }

  /** Oficjalny skin konta (albo premium o tym samym nicku dla konta offline) w postaci wpisu do podglądu. */
  const officialEntry = () => {
    const s = officialSkinOf(profile);
    if (!s) return null;
    const online = Boolean(profile?.available);
    return {
      type: 'account',
      name: online ? `Skin konta ${s.name}` : `Skin premium o nicku ${s.name}`,
      variant: s.model || s.variant,
      dataUrl: s.dataUrl,
      online,
    };
  };

  const current = () => {
    if (selected?.type === 'lib') {
      const lib = library.find((e) => e.id === selected.id);
      if (lib) return { type: 'lib', ...lib };
    }
    return officialEntry() || (library[0] ? { type: 'lib', ...library[0] } : null);
  };

  async function showInViewer() {
    const cur = current() || defaultSkin();
    if (!viewer) return;
    try {
      viewer.setSkin(await image(cur.dataUrl), cur.variant);
      const capeId = capePreview === undefined ? capeState?.selected || null : capePreview;
      const cape = capeId ? capeState?.capes.find((c) => c.id === capeId) : null;
      viewer.setCape(cape ? await image(cape.dataUrl) : null);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function paintStage() {
    const cur = current();
    if (!cur) {
      mount(
        stageInfo,
        h('div', { class: 'hint', style: { textAlign: 'center', padding: '10px 0' } }, 'Brak skina do pokazania. Dodaj skin do biblioteki — pelerynę możesz wybrać już teraz, podgląd pokaże ją na zwykłym skinie.'),
      );
      return;
    }
    const account = profile?.available ? profile : null;
    const actions = [];

    if (cur.type === 'lib') {
      const seg = h(
        'div',
        { class: 'seg', style: { width: '100%' } },
        Object.entries(MODEL_LABEL).map(([id, label]) =>
          h(
            'button',
            {
              class: cur.variant === id ? 'active' : '',
              style: { flex: 1 },
              onclick: async () => {
                try {
                  await call('skins:update', cur.id, { variant: id });
                  cur.variant = id;
                  const entry = library.find((e) => e.id === cur.id);
                  if (entry) entry.variant = id;
                  paintStage();
                  paintLibrary();
                  showInViewer();
                } catch (e) {
                  toast(e.message, 'err');
                }
              },
            },
            label,
          ),
        ),
      );
      const applyBtn = h(
        'button',
        {
          class: 'btn primary',
          style: { width: '100%' },
          disabled: !account,
          title: account ? '' : 'Wymaga zalogowanego konta Microsoft',
          onclick: async () => {
            applyBtn.disabled = true;
            try {
              await call('skins:apply', cur.id);
              toast('Skin ustawiony na koncie Microsoft. W grze zobaczysz go po ponownym dołączeniu do serwera lub świata.');
              selected = null;
              await loadProfile({ quiet: true });
            } catch (e) {
              toast(e.message, 'err');
            }
            applyBtn.disabled = !profile?.available;
          },
        },
        icon('check', 16),
        'Ustaw na koncie Microsoft',
      );
      actions.push(
        seg,
        applyBtn,
        h(
          'div',
          { class: 'hint', style: { lineHeight: 1.5 } },
          account
            ? 'Skin w grze jest zawsze taki, jaki ma konto — launcher go nie podmienia. Po ustawieniu na koncie zobaczą go wszyscy.'
            : 'Skin z biblioteki można ustawić tylko na koncie Microsoft. W grze skin zostaje taki, jaki daje konto albo serwer.',
        ),
        h(
          'div',
          { class: 'row', style: { gap: '8px' } },
          h(
            'button',
            { class: 'btn sm grow', onclick: () => renameSkin(cur) },
            icon('edit', 15),
            'Zmień nazwę',
          ),
          h(
            'button',
            {
              class: 'btn sm danger grow',
              onclick: async () => {
                const ok = await confirmModal({
                  title: 'Usuń skin',
                  message: `Usunąć „${cur.name}” z biblioteki?`,
                  confirmLabel: 'Usuń',
                  danger: true,
                });
                if (!ok) return;
                await call('skins:remove', cur.id);
                selected = null;
                await loadLibrary();
              },
            },
            icon('trash', 15),
            'Usuń',
          ),
        ),
      );
    } else {
      actions.push(
        h(
          'button',
          {
            class: 'btn',
            style: { width: '100%' },
            onclick: () => openSkinImport({ dataUrl: cur.dataUrl, name: officialSkinOf(profile)?.name || 'Skin', variant: cur.variant }),
          },
          icon('download', 16),
          'Zapisz w bibliotece',
        ),
      );
      if (cur.online) {
        actions.push(
          h(
            'button',
            {
              class: 'btn danger',
              style: { width: '100%' },
              onclick: async () => {
                const ok = await confirmModal({
                  title: 'Przywróć domyślny skin',
                  message: 'Usunąć własny skin z konta Microsoft i wrócić do domyślnego?',
                  confirmLabel: 'Przywróć',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await call('skins:reset');
                  toast('Przywrócono domyślny skin konta.');
                  selected = null;
                  await loadProfile({ quiet: true });
                } catch (e) {
                  toast(e.message, 'err');
                }
              },
            },
            'Przywróć domyślny skin',
          ),
        );
      }
    }

    const defaultSkinChip = cur.type === 'account' && (profile?.available ? profile.defaultSkin : profile?.official?.defaultSkin);
    mount(
      stageInfo,
      h('div', { class: 'ttl', style: { fontSize: '17px', fontWeight: 700, margin: '4px 0 8px' } }, cur.name),
      h(
        'div',
        { class: 'row wrap', style: { gap: '6px', marginBottom: '14px' } },
        h('span', { class: 'chip gold' }, MODEL_LABEL[cur.variant]),
        cur.type === 'account' && cur.online ? h('span', { class: 'chip ok' }, 'Aktywny na koncie') : null,
        defaultSkinChip ? h('span', { class: 'chip' }, 'Domyślny skin') : null,
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, actions),
    );
  }

  function renameSkin(cur) {
    const input = h('input', { class: 'input', value: cur.name, maxlength: 32 });
    const save = async () => {
      try {
        await call('skins:update', cur.id, { name: input.value });
        modal.close();
        await loadLibrary();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    const modal = openModal({
      title: 'Zmień nazwę skina',
      body: h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Nazwa'), input),
      actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), h('button', { class: 'btn primary', onclick: save }, 'Zapisz')],
    });
    input.focus();
    input.select();
  }

  const refreshBtn = () =>
    h('button', { class: 'btn sm', title: 'Sprawdź teraz, czy skin się zmienił', onclick: () => loadProfile() }, icon('refresh', 15), 'Odśwież');

  function accountCard() {
    if (!profile && !profileError) {
      return h('div', { class: 'card settings-card' }, h('div', { class: 'skeleton', style: { height: '48px' } }));
    }
    if (profileError) {
      return h(
        'div',
        { class: 'card settings-card' },
        h('h3', null, 'Konto Microsoft'),
        h('p', { style: { marginBottom: '12px' } }, profileError),
        h('button', { class: 'btn sm', onclick: () => loadProfile() }, icon('refresh', 15), 'Spróbuj ponownie'),
      );
    }
    if (!profile.available && profile.reason !== 'offline') {
      return h(
        'div',
        { class: 'card settings-card' },
        h('h3', null, 'Brak konta'),
        h('p', { style: { marginBottom: '14px' } }, 'Dodaj konto w Ustawieniach.'),
        h('button', { class: 'btn sm', onclick: () => navigate('#/settings') }, 'Przejdź do ustawień'),
      );
    }

    if (!profile.available) {
      // konto offline: nie ma oficjalnego skina, więc pokazujemy skin gracza premium o tym samym nicku (jeśli jest)
      const o = profile.official || {};
      const entry = officialEntry();
      let line;
      if (o.error) line = `Nie udało się sprawdzić oficjalnego skina: ${o.error}`;
      else if (o.found) {
        line = `Konto premium o nicku ${o.name} ma ${o.defaultSkin ? 'domyślny' : 'własny'} skin — ${MODEL_LABEL[o.model]}.`;
      } else {
        line = `Nie ma konta premium o nicku ${profile.name}. Bez skina z serwera gra pokaże domyślny: ${MODEL_LABEL[o.model] || MODEL_LABEL.classic}.`;
      }
      return h(
        'div',
        { class: 'card settings-card' },
        h(
          'div',
          { class: 'row' },
          entry ? headCanvas(entry.dataUrl, 48) : h('div', { class: 'pic' }, icon('user', 22)),
          h(
            'div',
            { class: 'grow' },
            h('h3', { style: { marginBottom: '2px' } }, `Konto offline (${profile.name})`),
            h('div', { class: 'hint', style: { lineHeight: 1.5 } }, line),
          ),
          refreshBtn(),
        ),
        h(
          'div',
          { class: 'hint', style: { marginTop: '12px', lineHeight: 1.5 } },
          'Konto offline nie ma własnego skina — w grze skin zależy od serwera. Launcher niczego nie podmienia; wyżej widzisz tylko to, co mówi o tym nicku oficjalny Minecraft.',
        ),
      );
    }

    const capes = profile.capes;
    return h(
      'div',
      { class: 'card settings-card' },
      h(
        'div',
        { class: 'row' },
        profile.skin ? headCanvas(profile.skin.dataUrl, 48) : h('div', { class: 'pic' }, icon('user', 22)),
        h(
          'div',
          { class: 'grow' },
          h('h3', { style: { marginBottom: '2px' } }, profile.name),
          h(
            'div',
            { class: 'hint' },
            `${profile.defaultSkin ? 'Domyślny skin konta' : 'Aktywny skin'}: ${MODEL_LABEL[profile.model]}`,
          ),
          profile.checkedAt
            ? h('div', { class: 'hint', style: { fontSize: '12px' } }, `Sprawdzono ${fmtAgo(profile.checkedAt)}`)
            : null,
        ),
        profile.skin
          ? h(
              'button',
              {
                class: `btn sm${selected?.type !== 'lib' ? ' primary' : ''}`,
                onclick: () => {
                  selected = { type: 'account' };
                  paintAll();
                },
              },
              'Pokaż w podglądzie',
            )
          : null,
        refreshBtn(),
      ),
      h(
        'div',
        { class: 'hint', style: { marginTop: '10px', lineHeight: 1.5 } },
        'Skin i jego model (Steve/Alex) są czytane z oficjalnego konta. Zmiana zrobiona w Minecrafcie albo na minecraft.net pojawi się tutaj sama.',
      ),
      capes.length
        ? h(
            'div',
            { style: { marginTop: '16px' } },
            h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Peleryna konta'),
            h(
              'div',
              { class: 'seg' },
              h(
                'button',
                { class: capes.some((c) => c.active) ? '' : 'active', onclick: () => chooseCape(null) },
                'Brak',
              ),
              capes.map((c) =>
                h('button', { class: c.active ? 'active' : '', onclick: () => chooseCape(c.id) }, c.alias),
              ),
            ),
          )
        : h('div', { class: 'hint', style: { marginTop: '12px' } }, 'To konto nie ma żadnych peleryn.'),
    );
  }

  async function chooseCape(id) {
    try {
      await call('skins:cape', id);
      toast(id ? 'Ustawiono pelerynę.' : 'Ukryto pelerynę.');
      await loadProfile({ quiet: true });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  const libraryBox = h('div');
  function paintLibrary() {
    const cur = current();
    mount(
      libraryBox,
      h(
        'div',
        { class: 'skin-grid' },
        library.map((e) =>
          h(
            'div',
            {
              class: `card skin-card${cur?.type === 'lib' && cur.id === e.id ? ' sel' : ''}`,
              onclick: () => {
                selected = { type: 'lib', id: e.id };
                paintAll();
              },
            },
            headCanvas(e.dataUrl, 56),
            h('div', { class: 'nm' }, e.name),
            h('div', { class: 'hint' }, e.variant === 'slim' ? 'Wąski' : 'Klasyczny'),
          ),
        ),
        h('button', { class: 'new-card skin-new', onclick: pickFile }, icon('plus', 24), 'Dodaj skin'),
      ),
    );
  }

  // ---- peleryny CrownClient ----
  function capesSection() {
    if (!capeState) {
      return h('div', { class: 'card settings-card' }, h('div', { class: 'skeleton', style: { height: '90px' } }));
    }
    // peleryny są tylko dla wybranych graczy (dostęp nadaje administrator w panelu) - bez dostępu nie ma tej sekcji
    if (capeState.allowed === false) return null;
    const selectedId = capeState.selected || null;
    const previewId = capePreview === undefined ? selectedId : capePreview;
    const previewCape = capeState.capes.find((c) => c.id === previewId) || null;
    const canUse = Boolean(capeState.account);

    const card = (c) =>
      h(
        'div',
        {
          class: `card cape-card${previewId === c.id ? ' sel' : ''}`,
          title: c.name,
          onclick: () => {
            capePreview = c.id;
            paintAll();
          },
        },
        capeCanvas(c.dataUrl, 80),
        h('div', { class: 'nm' }, c.name),
        selectedId === c.id ? h('span', { class: 'chip ok' }, 'W grze') : null,
      );
    const none = h(
      'div',
      {
        class: `card cape-card${previewId === null ? ' sel' : ''}`,
        onclick: () => {
          capePreview = null;
          paintAll();
        },
      },
      h('div', { class: 'cape-none' }, icon('x', 22)),
      h('div', { class: 'nm' }, 'Brak'),
      !selectedId ? h('span', { class: 'chip ok' }, 'W grze') : null,
    );

    const actions = [];
    if (previewId !== selectedId) {
      actions.push(
        h(
          'button',
          {
            class: 'btn primary grow',
            disabled: !canUse,
            title: canUse ? '' : 'Najpierw dodaj konto w Ustawieniach',
            onclick: async () => {
              try {
                const r = await call('capes:select', previewId);
                if (!previewId) toast('Peleryna zdjęta.');
                else if (r?.shared) toast('Peleryna ustawiona — od teraz widzą ją wszyscy gracze launchera (w grze po następnym uruchomieniu).');
                else if (r?.error) toast(`Peleryna będzie widoczna u Ciebie od następnego uruchomienia, ale nie udało się jej udostępnić innym: ${r.error}`, 'err', 8000);
                else toast('Peleryna będzie widoczna w grze od następnego uruchomienia.');
                await loadCapes();
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          },
          icon('check', 16),
          previewId ? 'Użyj w grze' : 'Zdejmij pelerynę',
        ),
      );
    }
    if (previewCape && !previewCape.builtin) {
      actions.push(
        h(
          'button',
          {
            class: 'btn danger',
            onclick: async () => {
              const ok = await confirmModal({ title: 'Usuń pelerynę', message: `Usunąć „${previewCape.name}” z biblioteki?`, confirmLabel: 'Usuń', danger: true });
              if (!ok) return;
              await call('capes:remove', previewCape.id).catch((e) => toast(e.message, 'err'));
              capePreview = undefined;
              await loadCapes();
            },
          },
          icon('trash', 16),
          'Usuń',
        ),
      );
    }

    // administracja: jednym kliknięciem nadaje pelerynę własnemu nickowi (widoczną dla użytkowników launchera)
    if (staff && !capeState.selfService && canUse && previewId) {
      actions.push(
        h(
          'button',
          {
            class: 'btn',
            title: `Zapisuje pelerynę w repozytorium dla nicku ${capeState.account.username}`,
            onclick: async () => {
              try {
                await call('capes:assign', capeState.account.username, previewId);
                toast(`Peleryna nadana nickowi ${capeState.account.username}. Inni użytkownicy launchera zobaczą ją w ciągu kilku minut.`);
                await loadCapes();
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          },
          icon('user', 16),
          assigned.assigned ? 'Zaktualizuj dla wszystkich' : 'Pokaż wszystkim',
        ),
      );
    }
    if (staff && !capeState.selfService && canUse && assigned.assigned) {
      actions.push(
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                await call('capes:unassign', capeState.account.username);
                toast('Peleryna przestała być widoczna dla innych.');
                await loadCapes();
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          },
          'Ukryj przed innymi',
        ),
      );
    }

    const visibility = (() => {
      if (capeState.selfService) {
        return 'Peleryna, którą wybierzesz, trafia na serwer peleryn i od razu jest widoczna dla wszystkich graczy launchera (własne pliki też). Gracze spoza launchera jej nie widzą.';
      }
      if (assigned.assigned) {
        return 'Ta peleryna jest nadana Twojemu nickowi — widzą ją wszyscy gracze używający launchera. Gracze spoza launchera jej nie widzą.';
      }
      if (staff) {
        return 'Teraz widzisz ją tylko Ty. Kliknij „Pokaż wszystkim”, żeby zobaczyli ją pozostali gracze launchera.';
      }
      return capeState.shared
        ? 'Teraz widzisz ją tylko Ty. Żeby widzieli ją inni gracze launchera, administracja musi ją nadać Twojemu nickowi.'
        : 'Peleryna jest widoczna w grze u Ciebie.';
    })();

    return h(
      'div',
      { class: 'card settings-card' },
      h(
        'div',
        { class: 'row', style: { marginBottom: '12px' } },
        h('h3', { class: 'grow', style: { margin: 0 } }, 'Peleryny'),
        staff && !capeState.selfService ? h('button', { class: 'btn sm', onclick: () => openStaffCapes(capeState.capes, loadCapes) }, icon('user', 15), 'Gracze z koroną') : null,
        h('button', { class: 'btn sm', onclick: pickCape }, icon('plus', 15), 'Dodaj własną'),
      ),
      h('div', { class: 'cape-grid' }, none, capeState.capes.map(card)),
      actions.length ? h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, actions) : null,
      assigned.assigned
        ? h('div', { class: 'chip gold', style: { marginTop: '12px' } }, icon('check', 13), 'Widoczna dla wszystkich graczy launchera')
        : null,
      h('div', { class: 'hint', style: { marginTop: '10px', lineHeight: 1.5 } }, visibility),
    );
  }

  async function loadCapes() {
    try {
      capeState = await call('capes:state');
      staff = Boolean((await call('announce:status').catch(() => null))?.loggedIn);
      assigned = await call('capes:mine').catch(() => ({ assigned: false }));
    } catch (e) {
      toast(e.message, 'err');
    }
    paintAll();
  }

  function paintAll() {
    paintStage();
    paintLibrary();
    mount(
      side,
      accountCard(),
      capesSection(),
      h('div', { class: 'section-title', style: { marginTop: '8px' } }, 'Twoja biblioteka'),
      libraryBox,
    );
    showInViewer();
  }

  async function loadLibrary() {
    try {
      library = await call('skins:list');
    } catch (e) {
      toast(e.message, 'err');
    }
    paintAll();
  }

  async function loadProfile({ quiet = false } = {}) {
    profileError = '';
    try {
      profile = await refreshOfficialSkin({ quiet });
    } catch (e) {
      profile = null;
      profileError = e.message;
    }
    paintAll();
  }

  page.append(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', null, 'Skiny i peleryny'),
        h('p', null, 'Podgląd 3D skina konta (z modelem Steve/Alex), biblioteka skinów i peleryny. Skiny w grze zostają takie, jakie są — launcher podmienia tylko peleryny.'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onclick: openLookup }, icon('search', 16), 'Pobierz po nicku'),
        h('button', { class: 'btn primary', onclick: pickFile }, icon('plus', 16), 'Dodaj skin'),
      ),
    ),
    h(
      'div',
      { class: 'skins-layout' },
      h(
        'div',
        { class: 'card skin-stage' },
        viewer
          ? canvas
          : h('div', { class: 'empty' }, icon('alert', 32), h('h3', null, 'Brak obsługi WebGL'), 'Podgląd 3D jest niedostępny.'),
        stageInfo,
      ),
      side,
    ),
  );

  paintAll();
  loadLibrary();
  loadProfile();
  loadCapes();
  return page;
}
