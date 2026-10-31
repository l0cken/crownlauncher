import { call, on } from './api.js';
import { h, icon, mount, toast, openModal, closeAllModals } from './dom.js';
import {
  state,
  notify,
  resetSubscriptions,
  refreshInstances,
  refreshAccounts,
  refreshConfig,
  refreshServers,
  currentAccount,
  dataChanged,
  onData,
  onDataGlobal,
} from './state.js';
import { avatar, navigate, importMrpack } from './components.js';
import { startMicrosoftLogin } from './ms-login.js';
import { openAccountSwitcher } from './account-switcher.js';
import { renderHome } from './pages/home.js';
import { renderInstances } from './pages/instances.js';
import { setInstanceTab, renderInstance } from './pages/instance.js';
import { renderBrowse } from './pages/browse.js';
import { renderServers } from './pages/servers.js';
import { renderSkins, openImageImportFromFile } from './pages/skins.js';
import { startOfficialSkinWatch, refreshOfficialSkin } from './skin-watch.js';
import { showCrash } from './crash-report.js';
import { renderSettings } from './pages/settings.js';
import { renderEvent } from './pages/event.js';

const ROUTES = [
  { pattern: /^\/home$/, nav: 'home', render: renderHome },
  { pattern: /^\/instances$/, nav: 'instances', render: renderInstances },
  { pattern: /^\/instance\/([^/]+)$/, nav: 'instances', render: renderInstance, params: ['id'] },
  { pattern: /^\/servers$/, nav: 'servers', render: renderServers },
  { pattern: /^\/skins$/, nav: 'skins', render: renderSkins },
  { pattern: /^\/browse$/, nav: 'browse', render: renderBrowse },
  { pattern: /^\/settings$/, nav: 'settings', render: renderSettings },
  { pattern: /^\/event$/, nav: 'event', render: renderEvent },
];

const NAV_HOME = { id: 'home', label: 'Start', icon: 'home', href: '#/home' };
const NAV_REST = [
  { id: 'instances', label: 'Instancje', icon: 'grid', href: '#/instances' },
  { id: 'servers', label: 'Serwery', icon: 'server', href: '#/servers' },
  { id: 'skins', label: 'Skiny', icon: 'smile', href: '#/skins' },
  { id: 'browse', label: 'Modrinth', icon: 'compass', href: '#/browse' },
  { id: 'settings', label: 'Ustawienia', icon: 'sliders', href: '#/settings' },
];
// w trybie wydarzenia (jedynym kluczem gracza jest kod wydarzenia) te zakładki są zablokowane
const EVENT_MODE_LOCKED = new Set(['instances', 'servers', 'skins', 'browse']);

/**
 * Menu: Start, [IGRZYSKA ŚMIERCI - nad „Instancje”, gdy serwer ma wydarzenie], Instancje…
 * W trybie wydarzenia Startu nie ma (oferuje tylko zablokowane akcje): wydarzenie jest pierwszą pozycją.
 */
function navItems() {
  const items = state.restricted ? [] : [NAV_HOME];
  if (state.event?.available) items.push({ id: 'event', label: state.event.title || 'IGRZYSKA ŚMIERCI', icon: 'heart', href: '#/event' });
  return [...items, ...NAV_REST];
}

const content = h('main', { class: 'content' });
const navEl = h('nav', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
const accountEl = h('div');
const updateEl = h('div');

// Automatyczne aktualizacje: pobieranie dzieje się w tle, tu tylko informujemy i pozwalamy zrestartować.
// Przycisk „Sprawdź aktualizacje” jest zawsze pod ręką; wynik ręcznego sprawdzenia pokazujemy komunikatem.
let lastUpdate = null;
let manualCheck = false; // użytkownik kliknął przycisk i czeka na wynik

const UPDATE_RESULT = {
  none: ['Masz najnowszą wersję.', 'ok'],
  available: ['Jest nowa wersja launchera — kliknij „Pobierz” w panelu bocznym.', 'ok'],
  downloading: ['Aktualizacja jest właśnie pobierana.', 'ok'],
  ready: ['Aktualizacja jest pobrana — zaraz się zainstaluje i launcher uruchomi się sam.', 'ok'],
};

function announceUpdateResult(s) {
  if (!manualCheck || !s) return;
  const known = UPDATE_RESULT[s.state];
  if (known) toast(known[0], known[1]);
  else if (s.state === 'disabled') toast(s.reason || 'Aktualizacje są wyłączone.', 'err');
  else if (s.state === 'error') toast(`Nie udało się sprawdzić aktualizacji: ${s.error}`, 'err');
  else return; // 'checking' / 'idle' - czekamy na wynik
  manualCheck = false;
}

async function checkForUpdates() {
  if (manualCheck) return;
  const before = lastUpdate;
  manualCheck = true;
  paintUpdate({ state: 'checking' });
  try {
    const s = await call('update:check');
    paintUpdate(s);
  } catch (e) {
    manualCheck = false;
    toast(e.message, 'err');
    paintUpdate(before);
  }
}

function paintUpdate(s) {
  lastUpdate = s;
  announceUpdateResult(s);

  const busy = manualCheck || s?.state === 'checking';
  const checkBtn = h(
    'button',
    {
      class: 'btn ghost sm',
      style: { width: '100%', marginBottom: '8px' },
      disabled: busy,
      title: 'Sprawdź, czy jest nowa wersja launchera',
      onclick: checkForUpdates,
    },
    busy ? h('span', { class: 'spin', style: { width: '12px', height: '12px' } }) : icon('refresh', 14),
    busy ? 'Sprawdzam…' : 'Sprawdź aktualizacje',
  );

  // jeden, wyraźny przycisk: „Pobierz” → pobiera, instaluje i sam uruchamia nową wersję
  const downloadBtn = h(
    'button',
    {
      class: 'btn primary sm',
      style: { width: '100%', fontWeight: '800' },
      onclick: () => call('update:download').catch((e) => toast(e.message, 'err')),
    },
    icon('download', 15),
    'Pobierz',
  );

  if (s?.state === 'available') {
    mount(
      updateEl,
      h(
        'div',
        { class: 'update-card ready' },
        h('div', { class: 'update-title' }, icon('zap', 14), 'Dostępna aktualizacja'),
        downloadBtn,
        h('div', { class: 'hint', style: { marginTop: '6px', fontSize: '11px' } }, 'Po pobraniu launcher sam się zainstaluje i uruchomi.'),
      ),
    );
  } else if (s?.state === 'downloading') {
    const pct = s.percent ?? 0;
    mount(
      updateEl,
      h(
        'div',
        { class: 'update-card' },
        h('div', { class: 'update-title' }, h('span', { class: 'spin', style: { width: '12px', height: '12px' } }), `Pobieranie aktualizacji${pct ? ` ${pct}%` : ''}`),
        h('div', { class: 'update-bar' }, h('div', { class: 'update-fill', style: { width: `${pct}%` } })),
      ),
    );
  } else if (s?.state === 'ready') {
    // zwykle widoczne ułamek sekundy: instalacja i start startują automatycznie
    mount(
      updateEl,
      h(
        'div',
        { class: 'update-card ready' },
        h('div', { class: 'update-title' }, h('span', { class: 'spin', style: { width: '12px', height: '12px' } }), 'Instaluję i uruchamiam…'),
        h(
          'button',
          {
            class: 'btn primary sm',
            style: { width: '100%', fontWeight: '800' },
            onclick: () => call('update:install').catch((e) => toast(e.message, 'err')),
          },
          'Uruchom ponownie',
        ),
      ),
    );
  } else {
    mount(updateEl, checkBtn);
  }
}

function titlebar() {
  const winBtn = (cls, ico, channel, title) =>
    h('button', { class: cls, title, onclick: () => call(channel) }, icon(ico, 15));
  return h(
    'div',
    { class: 'titlebar' },
    h('div', { class: 'brand' }, h('img', { src: '../../assets/logo-512.png', alt: '' }), 'CrownLauncher'),
    h(
      'div',
      { class: 'winctl' },
      winBtn('', 'minus', 'win:minimize', 'Minimalizuj'),
      winBtn('', 'square', 'win:toggle-maximize', 'Maksymalizuj'),
      winBtn('close', 'x', 'win:close', 'Zamknij'),
    ),
  );
}

/**
 * Prywatna dystrybucja: dopóki launcher nie ma ważnego klucza zaproszenia, pokazuje tylko ekran z jego wpisaniem
 * (z paskiem tytułu, żeby dało się zamknąć okno). Zwraca, gdy klucz został przyjęty albo nie jest wymagany.
 */
async function inviteGate() {
  const s = await call('invite:status').catch(() => ({ required: false }));
  if (!s.required || s.active) return;

  await new Promise((resolve) => {
    const input = h('input', {
      class: 'input',
      placeholder: 'CROWN-XXXX-XXXX-XXXX-XXXX',
      maxlength: 40,
      spellcheck: false,
      autocomplete: 'off',
      style: { textAlign: 'center', letterSpacing: '1px' },
    });
    const error = h('div', { style: { color: 'var(--err)', minHeight: '20px', marginTop: '10px', fontSize: '13px' } });
    const btn = h('button', { class: 'btn primary', style: { width: '100%', marginTop: '14px', fontWeight: '800' } }, 'Dalej');
    const submit = async () => {
      btn.disabled = true;
      error.textContent = '';
      try {
        await call('invite:set', input.value);
        resolve();
      } catch (e) {
        error.textContent = e.message;
        btn.disabled = false;
      }
    };
    btn.onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    mount(
      document.getElementById('app'),
      titlebar(),
      h(
        'div',
        { style: { flex: 1, display: 'grid', placeItems: 'center', padding: '24px' } },
        h(
          'div',
          { class: 'card', style: { width: 'min(420px, 100%)', padding: '28px', textAlign: 'center' } },
          h('img', { src: '../../assets/logo-512.png', width: 84, height: 84, alt: '', style: { marginBottom: '10px' } }),
          h('h2', { style: { margin: '0 0 6px' } }, 'Launcher tylko dla zaproszonych'),
          s.lost
            ? h(
                'div',
                { class: 'lock-notice', style: { margin: '0 0 14px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(255, 93, 108, 0.1)', border: '1px solid rgba(255, 93, 108, 0.4)', color: 'var(--err)', fontWeight: 600, lineHeight: 1.4 } },
                s.lost,
              )
            : null,
          h(
            'p',
            { style: { margin: '0 0 16px', color: 'var(--muted)', lineHeight: 1.5 } },
            'Wpisz klucz zaproszenia, który dostałeś od administratora. Wpisujesz go raz — launcher zapamięta go zaszyfrowanego.',
          ),
          input,
          error,
          btn,
        ),
      ),
    );
    input.focus();
  });
}

function buildShell() {
  const app = document.getElementById('app');

  mount(
    app,
    titlebar(),
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'sidebar' },
        h(
          'div',
          { class: 'side-brand' },
          h('img', { src: '../../assets/logo-512.png', alt: '' }),
          h('div', { class: 'name' }, 'CrownLauncher'),
        ),
        navEl,
        h('div', { class: 'side-spacer' }),
        updateEl,
        accountEl,
      ),
      content,
    ),
  );
}

function paintNav(active) {
  mount(
    navEl,
    navItems().map((n) => {
      const locked = state.restricted && EVENT_MODE_LOCKED.has(n.id);
      if (locked) {
        return h(
          'a',
          {
            class: 'nav-item locked',
            href: '#/event',
            title: 'Zablokowane w trybie Igrzysk śmierci',
            onclick: (e) => {
              e.preventDefault();
              toast('Ta zakładka jest zablokowana w trybie Igrzysk śmierci.', 'err');
            },
          },
          icon(n.icon, 19),
          n.label,
          h('span', { style: { marginLeft: 'auto', opacity: 0.8 } }, icon('lock', 14)),
        );
      }
      return h('a', { class: `nav-item${n.id === active ? ' active' : ''}`, href: n.href }, icon(n.icon, 19), n.label);
    }),
  );
}

function paintAccount() {
  const acc = currentAccount();
  mount(
    accountEl,
    h(
      'button',
      { class: 'account-chip', title: 'Przełącz konto', onclick: () => openAccountSwitcher() },
      avatar(acc, 34),
      h(
        'div',
        { style: { minWidth: 0 } },
        h('div', { class: 'nm' }, acc ? acc.username : 'Dodaj konto'),
        h('div', { class: 'tp' }, acc ? (acc.type === 'microsoft' ? 'Microsoft' : 'Offline') : 'Brak konta'),
      ),
    ),
  );
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, qs = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function route() {
  const { path, query } = parseHash();
  let matched = null;
  let params = {};
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (m) {
      matched = r;
      (r.params || []).forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      break;
    }
  }
  if (!matched) {
    location.hash = '#/home';
    return;
  }
  // tryb wydarzenia: zablokowane zakładki (i Start, który oferuje tylko zablokowane akcje) nie otwierają się
  // nawet przez ręczną zmianę adresu
  if (state.restricted && (matched.nav === 'home' || EVENT_MODE_LOCKED.has(matched.nav))) {
    location.hash = '#/event';
    return;
  }
  resetSubscriptions();
  closeAllModals();
  paintNav(matched.nav);
  mount(content, matched.render({ params, query }));
  content.scrollTop = 0;

  // listy instancji odświeżamy po zmianie danych (np. czas gry po zamknięciu Minecrafta)
  if (matched.render === renderHome || matched.render === renderInstances) {
    onData(() => {
      const scroll = content.scrollTop;
      mount(content, matched.render({ params, query }));
      content.scrollTop = scroll;
    });
  }
}

function wireEvents() {
  on('instance:state', ({ id, state: st }) => {
    if (st === 'idle') {
      delete state.states[id];
      delete state.progress[id];
      refreshInstances();
    } else {
      state.states[id] = st;
    }
    notify();
  });
  on('install:progress', (p) => {
    state.progress[p.id] = p;
    notify();
  });
  on('game:log', ({ id, lines }) => {
    document.dispatchEvent(new CustomEvent('game-log', { detail: { id, lines } }));
  });
  // awaria z rozpoznanym winowajcą (mod / pamięć / sterownik): okno z przyciskiem „Wyłącz ten mod”
  const crashShown = new Set();
  on('game:crash', (c) => {
    crashShown.add(c.id);
    const isEvent = String(c.id).startsWith('event-'); // wydarzenie: bez konsoli i bez nazw modów
    showCrash(c.id, c, {
      onConsole: isEvent
        ? null
        : () => {
            setInstanceTab(c.id, 'console');
            navigate(`#/instance/${c.id}`);
            window.dispatchEvent(new Event('crown-rerender'));
          },
      onRetry: () => call('instances:launch', c.id).catch((e) => toast(e.message, 'err')),
    });
  });
  on('game:exit', ({ id, code }) => {
    refreshOfficialSkin().catch(() => {}); // po grze: czy w międzyczasie zmienił się skin konta
    if (crashShown.delete(id)) return; // winowajca już pokazany w oknie awarii
    if (code !== 0 && code !== -1) {
      toast(
        String(id).startsWith('event-')
          ? 'Gra zakończyła się błędem. Użyj „Sprawdź pliki” w zakładce wydarzenia i spróbuj ponownie.'
          : `Gra zakończyła się błędem (kod ${code}). Szczegóły w zakładce „Konsola” instancji.`,
        'err',
      );
    }
  });
  on('instance:error', ({ message }) => toast(message, 'err'));
  on('anticheat:alert', ({ message }) => toast(message, 'err'));
  // klucz zaproszenia unieważniony albo wygasł: wracamy do ekranu z kluczem (trwająca gra działa dalej)
  // powrót do okna launchera: od razu sprawdzamy klucz (odłączenie komputera w panelu widać natychmiast, bez czekania na nadzór)
  window.addEventListener('focus', () => {
    call('invite:status').catch(() => {});
  });
  on('invite:lost', () => {
    toast('Twój klucz zaproszenia przestał być ważny.', 'err');
    // po przeładowaniu ekran blokady wyjaśnia powód (przez proces główny: location.reload() blokuje will-navigate)
    setTimeout(() => call('win:reload').catch(() => {}), 1200);
  });
  paintUpdate(null); // przycisk „Sprawdź aktualizacje” jest od razu, jeszcze przed odpowiedzią procesu głównego
  on('update:state', paintUpdate);
  call('update:status').then(paintUpdate).catch(() => {});
  on('modrinth:progress', (detail) => {
    document.dispatchEvent(new CustomEvent('modrinth-progress', { detail }));
  });
  on('instances:export-progress', (detail) => {
    document.dispatchEvent(new CustomEvent('export-progress', { detail }));
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('crown-rerender', route);
  onDataGlobal(paintAccount);
}

// Przeciągnięcie pliku .mrpack na okno launchera importuje paczkę modów.
function wireDragAndDrop() {
  // Elementy interfejsu (logo, ikony, linki, obrazki) nie mogą być przeciągane - to też
  // zapobiega fałszywemu pokazywaniu nakładki "Upuść plik" przy przeciąganiu logo.
  document.addEventListener('dragstart', (e) => e.preventDefault());

  const zone = h(
    'div',
    { class: 'dropzone' },
    icon('download', 48),
    h('div', { class: 'dz-title' }, 'Upuść plik .mrpack albo skin / pelerynę .png'),
    h('div', null, 'Paczka modów stanie się nową instancją, a skin lub peleryna trafi do biblioteki'),
  );
  document.body.append(zone);

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    zone.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('show');
    const files = [...e.dataTransfer.files];
    const packs = files.filter((f) => /\.mrpack$/i.test(f.name));
    const images = files.filter((f) => /\.png$/i.test(f.name));
    if (!packs.length && !images.length) {
      toast('Obsługiwane są pliki .mrpack (paczki modów) i .png (skiny i peleryny).', 'err');
      return;
    }
    if (images.length) await openImageImportFromFile(images[0]);
    for (const file of packs) await importMrpack(window.crown.pathForFile(file));
  });
}

function openWelcome({ microsoft = false } = {}) {
  const input = h('input', { class: 'input', placeholder: 'Twój nick w grze', maxlength: 16 });
  const submit = async () => {
    try {
      await call('accounts:add-offline', input.value);
      await refreshAccounts();
      startOfficialSkinWatch();
      modal.close();
      route();
      toast(microsoft ? 'Konto utworzone. Możesz też zalogować się przez Microsoft w Ustawieniach.' : 'Konto utworzone. Miłej gry!');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  const modal = openModal({
    title: 'Witaj w CrownLauncher',
    body: [
      h('div', { style: { textAlign: 'center', marginBottom: '14px' } }, h('img', { src: '../../assets/logo-512.png', width: 84, height: 84, alt: '' })),
      h(
        'p',
        { style: { marginTop: 0, color: 'var(--muted)', lineHeight: 1.5 } },
        microsoft
          ? 'Podaj nick, którego chcesz używać w grze, albo zaloguj się kontem Microsoft.'
          : 'Podaj nick, którego chcesz używać w grze. Możesz go później zmienić w Ustawieniach.',
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Nick'), input),
    ],
    actions: [
      microsoft
        ? h(
            'button',
            {
              class: 'btn',
              onclick: () =>
                startMicrosoftLogin(() => {
                  modal.close();
                  route();
                }),
            },
            icon('user', 16),
            'Zaloguj przez Microsoft',
          )
        : null,
      h('button', { class: 'btn primary', onclick: submit }, 'Zaczynamy'),
    ],
  });
  input.focus();
}

async function boot() {
  state.info = await call('app:info');
  await refreshConfig();

  await inviteGate(); // tylko w prywatnej dystrybucji: najpierw klucz zaproszenia

  // profil klucza: kod wydarzenia jako jedyny klucz = tryb ograniczony; wydarzenie (zakładka) dostępne dla każdego z kluczem.
  // Dopiero teraz wiadomo, które dane wolno pobrać: w trybie wydarzenia serwery i wersje gry są zablokowane.
  const inv = await call('invite:status').catch(() => ({}));
  state.restricted = Boolean(inv.profile);
  state.event = await call('event:info').catch(() => ({ available: false }));

  await Promise.all([refreshAccounts(), refreshInstances(), state.restricted ? Promise.resolve() : refreshServers()]);
  if (!state.restricted) {
    try {
      state.versions = await call('versions:list');
    } catch (e) {
      toast(`Nie udało się pobrać listy wersji Minecrafta: ${e.message}`, 'err');
    }
  }
  state.states = await call('instances:states');
  if (state.restricted && !/^#\/(event|settings)/.test(location.hash)) location.hash = '#/event';

  buildShell();
  paintAccount();
  wireEvents();
  wireDragAndDrop();
  route();
  dataChanged();
  // oficjalny skin konta: odczyt w tle i wykrywanie zmian zrobionych w Minecrafcie (skiny w grze są nietknięte)
  if (state.accounts.length && !state.restricted) startOfficialSkinWatch();
  if (!state.accounts.length) {
    // przycisk Microsoft pokazujemy tylko, gdy launcher ma skonfigurowaną aplikację Microsoft
    const ms = await call('accounts:ms-status').catch(() => ({ configured: false }));
    openWelcome({ microsoft: ms.configured });
  }
}

boot().catch((e) => {
  document.getElementById('app').textContent = `Błąd uruchomienia: ${e.message}`;
});
