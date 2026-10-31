import { call } from './api.js';
import { h, icon, mount, toast, openModal, fmtAgo } from './dom.js';
import { state, live, notify, loaderLabel, LOADERS, COLORS, refreshInstances } from './state.js';
import { headFor } from './skin-watch.js';

export function navigate(hash) {
  location.hash = hash;
}

export function tile(inst, large = false) {
  const initial = (inst.name.trim()[0] || '?').toUpperCase();
  return h(
    'div',
    {
      class: `tile${large ? ' lg' : ''}`,
      style: { background: `linear-gradient(135deg, ${inst.color}, ${inst.color}99 55%, #000a)` },
    },
    initial,
  );
}

export function instanceMeta(inst) {
  // dawna Vanilla przechodzi na Fabric przy pierwszym odczycie listy / starcie gry
  const loader =
    inst.loader === 'fabric' || inst.loader === 'vanilla'
      ? `Fabric${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}`
      : `${inst.loader} (nieobsługiwany)`;
  return `${loader} · ${inst.mcVersion}`;
}

// ---- avatary kont ------------------------------------------------------------------------------------------
// Twarz konta: z oficjalnego skina odczytanego przez launcher (headFor), a dla pozostałych kont z mc-heads.net - ale przez serwer
// launchera (accounts:avatar), więc ten serwis nie poznaje adresu IP gracza. Interfejs nigdy nie ładuje obrazka z cudzego serwera;
// do czasu odpowiedzi (albo gdy jej nie będzie) pokazujemy lokalny zastępnik z inicjałem.

const AVATAR_RETRY_MS = 10 * 60 * 1000; // bez obrazka (brak serwera, klucza, konta w serwisie) pytamy ponownie dopiero po tym czasie
const avatarFaces = new Map(); // id konta -> { dataUrl | null, at }
const avatarWaiting = new Map(); // id konta -> Set<img> czekających na obrazek

const xmlText = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Lokalny zastępnik avatara: kolorowy kwadrat z inicjałem (kolor zależy od nicku). Data URL, bez żadnego połączenia. */
export function placeholderAvatar(account) {
  const name = String(account?.username || '').trim() || '?';
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const color = COLORS[hash % COLORS.length];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const ink = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#14110a' : '#ffffff';
  const initial = xmlText([...name][0].toUpperCase());
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    `<rect width="64" height="64" fill="${color}"/>` +
    `<text x="32" y="44" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="${ink}">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Prosi proces główny o twarz konta; gdy przyjdzie, podmienia obrazki, które na nią czekają (jedno pytanie na konto naraz). */
function wantAvatar(account, img) {
  const waiting = avatarWaiting.get(account.id);
  if (waiting) {
    waiting.add(img);
    return;
  }
  const set = new Set([img]);
  avatarWaiting.set(account.id, set);
  call('accounts:avatar', account.id)
    .then((dataUrl) => dataUrl || null, () => null)
    .then((dataUrl) => {
      avatarFaces.set(account.id, { dataUrl, at: Date.now() });
      avatarWaiting.delete(account.id);
      if (dataUrl) for (const el of set) el.src = dataUrl;
    });
}

export function avatar(account, size = 34) {
  // twarz z oficjalnego skina odczytanego przez launcher (aktualna od razu)
  const own = headFor(account);
  const entry = account ? avatarFaces.get(account.id) : null;
  const face = own || entry?.dataUrl || '';
  const img = h('img', { class: 'avatar', width: size, height: size, alt: '', src: face || placeholderAvatar(account) });
  if (own) img.style.imageRendering = 'pixelated';
  const settled = entry && (entry.dataUrl || Date.now() - entry.at < AVATAR_RETRY_MS);
  if (account && !face && !settled) wantAvatar(account, img);
  return img;
}

/** Przycisk GRAJ / postęp instalacji / ZATRZYMAJ - sam odświeża się na podstawie stanu. */
export function playButton(inst, { large = false } = {}) {
  const fill = h('span', { class: 'fill' });
  const label = h('span', { class: 'plabel' });
  const btn = h('button', { class: `btn play ${large ? 'lg' : ''}` }, fill, label);

  const render = () => {
    const st = state.states[inst.id];
    const p = state.progress[inst.id];
    btn.classList.remove('busy', 'primary', 'danger');
    btn.disabled = false;
    btn.title = '';
    if (st === 'installing') {
      btn.classList.add('busy');
      btn.disabled = true;
      const pct = p?.total ? Math.round((p.current / p.total) * 100) : 0;
      fill.style.width = p?.total ? `${pct}%` : '0';
      btn.title = p ? `${p.stage}${p.total ? ` ${p.current}/${p.total}` : ''}` : '';
      mount(
        label,
        h('span', { class: 'spin' }),
        p ? `${shortStage(p.stage)}${p.total ? ` ${pct}%` : '…'}` : 'Przygotowanie…',
      );
    } else if (st === 'running') {
      btn.classList.add('danger');
      fill.style.width = '0';
      mount(label, icon('stop', 16), 'Zatrzymaj');
    } else {
      btn.classList.add('primary');
      fill.style.width = '0';
      mount(label, icon('play', large ? 20 : 16), 'GRAJ');
    }
  };

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const st = state.states[inst.id];
    try {
      if (st === 'running') {
        await call('instances:stop', inst.id);
      } else if (!st) {
        state.states[inst.id] = 'installing';
        state.progress[inst.id] = null;
        notify();
        await call('instances:launch', inst.id);
      }
    } catch (err) {
      delete state.states[inst.id];
      notify();
      toast(err.message, 'err');
    }
  });

  live(render);
  return btn;
}

function shortStage(stage) {
  return stage
    .replace('Pobieranie danych wersji', 'Dane wersji')
    .replace('Pobieranie klienta gry', 'Klient gry')
    .replace('Pobieranie bibliotek', 'Biblioteki')
    .replace('Pobieranie zasobów gry', 'Zasoby gry')
    .replace('Pobieranie instalatora', 'Instalator')
    .replace('Instalowanie', 'Instalacja');
}

export function instanceCard(inst) {
  return h(
    'div',
    { class: 'card inst-card', onclick: () => navigate(`#/instance/${inst.id}`) },
    h(
      'div',
      { class: 'top' },
      tile(inst),
      h('div', { class: 'info' }, h('div', { class: 'nm' }, inst.name), h('div', { class: 'meta' }, instanceMeta(inst))),
    ),
    h('div', { class: 'foot' }, h('span', { class: 'lp' }, fmtAgo(inst.lastPlayed)), playButton(inst)),
  );
}

// ---- tworzenie instancji ----

export function openCreateInstance() {
  const supported = state.versions;
  if (!supported.length) {
    toast('Lista wersji Minecrafta jest niedostępna - sprawdź połączenie z internetem.', 'err');
    return;
  }
  const form = {
    name: 'Nowa instancja',
    mc: supported[0].id,
    loader: 'fabric',
    loaderVersion: '',
    memory: state.config.memoryMb,
    memoryTouched: false,
    color: COLORS[0],
  };
  const cache = new Map(); // `${loader}:${mc}` -> [{version, stable}]
  let busy = false;

  const nameInput = h('input', {
    class: 'input',
    value: form.name,
    maxlength: 40,
    oninput: (e) => (form.name = e.target.value),
  });
  const versionSelect = h(
    'select',
    {
      class: 'select',
      onchange: (e) => {
        form.mc = e.target.value;
        refreshLoaders();
      },
    },
    supported.map((v) => h('option', { value: v.id }, v.id)),
  );
  const loaderSeg = h('div', { class: 'seg' });
  const loaderVersionField = h('div', { class: 'field' });
  const memLabel = h('span', { class: 'chip gold' });
  const memRange = h('input', {
    type: 'range',
    min: 1024,
    max: 16384,
    step: 512,
    value: form.memory,
    oninput: (e) => {
      form.memory = Number(e.target.value);
      form.memoryTouched = true;
      memLabel.textContent = `${(form.memory / 1024).toFixed(1)} GB`;
    },
  });
  memLabel.textContent = `${(form.memory / 1024).toFixed(1)} GB`;
  const swatches = h('div', { class: 'swatches' });
  const createBtn = h('button', { class: 'btn primary', onclick: submit }, 'Utwórz instancję');

  function paintSwatches() {
    mount(
      swatches,
      COLORS.map((c) =>
        h('div', {
          class: `swatch${c === form.color ? ' active' : ''}`,
          style: { background: c },
          onclick: () => {
            form.color = c;
            paintSwatches();
          },
        }),
      ),
    );
  }

  function paintLoaders() {
    mount(
      loaderSeg,
      LOADERS.map((l) => {
        const list = cache.get(`${l.id}:${form.mc}`);
        const unavailable = list && list.length === 0;
        return h(
          'button',
          {
            class: form.loader === l.id ? 'active' : '',
            disabled: unavailable,
            title: unavailable ? `Brak ${l.label} dla ${form.mc}` : '',
            onclick: () => {
              form.loader = l.id;
              paintLoaders();
              paintLoaderVersion();
            },
          },
          l.label,
        );
      }),
    );
  }

  function paintLoaderVersion() {
    const list = cache.get(`${form.loader}:${form.mc}`) || [];
    if (!list.some((v) => v.version === form.loaderVersion)) {
      form.loaderVersion = (list.find((v) => v.stable) || list[0])?.version || '';
    }
    mount(
      loaderVersionField,
      h('label', null, `Wersja ${loaderLabel(form.loader)}`),
      h(
        'select',
        { class: 'select', value: form.loaderVersion, onchange: (e) => (form.loaderVersion = e.target.value) },
        list.length
          ? list.map((v) => h('option', { value: v.version }, `${v.version}${v.stable ? '' : '  (beta)'}`))
          : h('option', { value: '' }, 'Ładowanie…'),
      ),
    );
  }

  async function refreshLoaders() {
    const mc = form.mc;
    paintLoaders();
    await Promise.all(
      LOADERS.map(async (l) => {
        const key = `${l.id}:${mc}`;
        if (cache.has(key)) return;
        try {
          cache.set(key, await call('loaders:list', l.id, mc));
        } catch {
          cache.set(key, []);
        }
      }),
    );
    if (form.mc !== mc) return;
    // brak Fabrica dla tej wersji: nie da się utworzyć instancji, więc nie udajemy, że się da
    createBtn.disabled = (cache.get(`${form.loader}:${mc}`) || []).length === 0;
    createBtn.title = createBtn.disabled ? `Brak Fabrica dla Minecrafta ${mc}` : '';
    paintLoaders();
    paintLoaderVersion();
  }

  async function submit() {
    if (busy) return;
    if (!form.name.trim()) return toast('Podaj nazwę instancji.', 'err');
    busy = true;
    createBtn.disabled = true;
    try {
      const inst = await call('instances:create', {
        name: form.name,
        mcVersion: form.mc,
        loader: form.loader,
        loaderVersion: form.loaderVersion,
        memoryMb: form.memoryTouched ? form.memory : 0,
        color: form.color,
      });
      modal.close();
      await refreshInstances();
      toast(`Utworzono instancję „${inst.name}”. Pobieram pliki gry w tle…`);
      navigate(`#/instance/${inst.id}`);
    } catch (e) {
      toast(e.message, 'err');
      busy = false;
      createBtn.disabled = false;
    }
  }

  paintSwatches();
  paintLoaders();
  paintLoaderVersion();
  const modal = openModal({
    title: 'Nowa instancja',
    body: [
      h('div', { class: 'field' }, h('label', null, 'Nazwa'), nameInput),
      h('div', { class: 'row' }, [
        h('div', { class: 'field grow' }, h('label', null, 'Wersja Minecrafta'), versionSelect),
      ]),
      h('div', { class: 'field' }, h('label', null, 'Loader modów'), loaderSeg),
      loaderVersionField,
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'row' }, h('label', { class: 'grow label' }, 'Pamięć RAM'), memLabel),
        memRange,
      ),
      h('div', { class: 'field' }, h('label', null, 'Kolor'), swatches),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), createBtn],
  });
  nameInput.focus();
  nameInput.select();
  refreshLoaders();
}

// ---- import paczki .mrpack z dysku ----

let importing = false;

/** Importuje plik .mrpack jako nową instancję (bez argumentu otwiera okno wyboru pliku). */
export async function importMrpack(filePath) {
  if (importing) {
    toast('Trwa już import innej paczki.', 'err');
    return;
  }
  importing = true;
  let modal = null;
  const onProgress = (e) => {
    if (e.detail.projectId === 'local' && text.isConnected) text.textContent = e.detail.text;
  };
  const text = h('div', null, 'Przygotowanie…');
  try {
    if (!filePath) {
      filePath = await call('modrinth:pick-mrpack');
      if (!filePath) return;
    }
    modal = openModal({
      title: 'Import paczki modów',
      closable: false,
      body: h('div', { class: 'row' }, h('span', { class: 'spin' }), text),
    });
    document.addEventListener('modrinth-progress', onProgress);
    const inst = await call('modrinth:import-mrpack', filePath);
    modal.close();
    await refreshInstances();
    toast(`Zaimportowano paczkę jako instancję „${inst.name}”. Pobieram pliki gry w tle…`);
    navigate(`#/instance/${inst.id}`);
  } catch (e) {
    modal?.close();
    toast(e.message, 'err');
  } finally {
    document.removeEventListener('modrinth-progress', onProgress);
    importing = false;
  }
}

// ---- wybór instancji (np. do instalacji moda) ----

export function pickInstance({ title = 'Wybierz instancję', filter = () => true, onPick }) {
  const candidates = state.instances.filter(filter);
  const list = candidates.length
    ? h(
        'div',
        { class: 'list' },
        candidates.map((inst) =>
          h(
            'div',
            {
              class: 'card item click',
              onclick: () => {
                modal.close();
                onPick(inst);
              },
            },
            tile(inst),
            h('div', { class: 'body' }, h('div', { class: 'ttl' }, inst.name), h('div', { class: 'desc' }, instanceMeta(inst))),
          ),
        ),
      )
    : h(
        'div',
        { class: 'empty' },
        icon('box', 36),
        h('h3', null, 'Brak pasujących instancji'),
        h('div', null, 'Utwórz instancję z loaderem modów (np. Fabric), aby instalować do niej mody.'),
      );
  const modal = openModal({
    title,
    body: list,
    actions: [
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            modal.close();
            openCreateInstance();
          },
        },
        icon('plus', 16),
        'Nowa instancja',
      ),
    ],
  });
}
