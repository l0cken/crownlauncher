import { call, on } from '../api.js';
import { h, icon, mount, toast, confirmModal } from '../dom.js';
import { state, refreshAccounts, refreshConfig, onLeave } from '../state.js';
import { avatar } from '../components.js';
import { startMicrosoftLogin, openMicrosoftSetup } from '../ms-login.js';

async function saveConfig(patch) {
  try {
    state.config = await call('config:set', patch);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** Wiersz z przełącznikiem zapisującym wartość logiczną w ustawieniach (domyślnie włączone). */
function toggleRow(title, hint, key) {
  const sw = h('button', {
    class: `switch${state.config[key] !== false ? ' on' : ''}`,
    onclick: async () => {
      const next = state.config[key] === false;
      sw.classList.toggle('on', next);
      await saveConfig({ [key]: next });
    },
  });
  return h(
    'div',
    { class: 'row', style: { margin: '14px 0' } },
    h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, title), h('div', { class: 'hint' }, hint)),
    sw,
  );
}

function debounced(fn, ms = 500) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- aktualizacje launchera ----
function updatesCard() {
  const status = h('div', { class: 'hint' });
  const btn = h('button', { class: 'btn', onclick: () => run() }, icon('refresh', 16), 'Sprawdź aktualizacje');

  const describe = (s) => {
    switch (s?.state) {
      case 'checking':
        return 'Sprawdzam…';
      case 'available':
        return 'Jest nowa wersja launchera — kliknij „Pobierz” w panelu bocznym; po pobraniu sama się zainstaluje i uruchomi.';
      case 'downloading':
        return `Pobieram aktualizację${s.percent != null ? ` (${s.percent}%)` : ''}…`;
      case 'ready':
        return 'Aktualizacja jest pobrana — instaluję i uruchamiam launcher ponownie…';
      case 'none':
        return 'Masz najnowszą wersję.';
      case 'disabled':
        return s.reason || 'Automatyczne aktualizacje są wyłączone.';
      case 'error':
        return `Nie udało się sprawdzić aktualizacji: ${s.error}`;
      default:
        return 'Launcher sprawdza aktualizacje automatycznie przy starcie i co kilka godzin.';
    }
  };

  const paint = (s) => {
    status.textContent = describe(s);
    btn.disabled = s?.state === 'checking' || s?.state === 'downloading';
  };
  async function run() {
    try {
      paint({ state: 'checking' });
      paint(await call('update:check'));
    } catch (e) {
      paint({ state: 'error', error: e.message });
    }
  }
  call('update:status').then(paint).catch(() => {});
  const off = on('update:state', paint);
  onLeave(off);

  return h(
    'div',
    { class: 'card settings-card' },
    h('h3', null, 'Aktualizacje'),
    h('p', null, 'Gdy jest nowa wersja, kliknij „Pobierz” — launcher sam ją zainstaluje i uruchomi ponownie.'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, status), btn),
  );
}

// ---- „Peleryny i korona w grze” (wyłączenie CrownClienta): wiersz tylko dla graczy z dostępem nadanym w panelu ----
// u pozostałych peleryny i korona są zawsze włączone, a przełącznika nie ma
function cosmeticsRow() {
  const box = h('div');
  call('client:state')
    .then((s) => {
      if (!s?.allowed) return;
      mount(
        box,
        h('div', { class: 'divider' }),
        toggleRow(
          'Peleryny i korona w grze',
          'Launcher dokłada mod CustomSkinLoader, żeby wybrana peleryna (także nadana przez administrację) była widoczna w grze, i pokazuje koronę CrownClient przed nickiem. Wyłącz, jeśli nie chcesz ich w grze (działa od następnego uruchomienia gry). Tę opcję włączył Ci administrator.',
          'cosmetics',
        ),
      );
    })
    .catch(() => {});
  return box;
}

// ---- zaproszenie (prywatna dystrybucja) - karta widoczna tylko, gdy launcher wymaga klucza ----
function inviteCard() {
  const box = h('div');
  const card = h('div', { class: 'card settings-card', style: { display: 'none' } },
    h('h3', null, 'Zaproszenie'),
    h('p', null, 'Ten launcher jest tylko dla zaproszonych graczy. Klucz zaproszenia (od administratora) odblokowuje aktualizacje, ogłoszenia i uruchamianie gry.'),
    box,
  );

  async function paint() {
    let s;
    try {
      s = await call('invite:status');
    } catch {
      return;
    }
    if (!s.required) return;
    card.style.display = '';
    const key = h('input', { class: 'input', placeholder: 'CROWN-XXXX-XXXX-XXXX-XXXX', maxlength: 40, spellcheck: false, autocomplete: 'off' });
    const save = async () => {
      try {
        await call('invite:set', key.value);
        toast('Klucz zaproszenia zapisany.');
        paint();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    key.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    mount(
      box,
      s.active
        ? h(
            'div',
            { class: 'acct-row sel' },
            h('div', { class: 'pic', style: { width: '36px', height: '36px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'var(--panel-3)' } }, icon('check', 18)),
            h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, s.name || 'Zaproszony gracz'), h('div', { class: 'hint' }, 'Klucz zaproszenia jest ważny i zapisany zaszyfrowany na tym komputerze.')),
          )
        : h('div', { class: 'row' }, h('div', { class: 'grow' }, key), h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Zapisz klucz')),
    );
  }
  paint();
  return card;
}

// ---- ogłoszenia: serwer i klucz publikowania ----
function announcementsCard() {
  const box = h('div');
  const sourceHint = h('div', { class: 'hint' });
  const urlInput = h('input', {
    class: 'input',
    placeholder: 'twojlogin/crownlauncher',
    value: state.config.announcementsUrl || '',
    oninput: debounced(async (e) => {
      await saveConfig({ announcementsUrl: e.target.value.trim() });
      paint();
    }),
  });

  async function paint() {
    let s;
    try {
      s = await call('announce:status');
    } catch (e) {
      mount(box, h('div', { class: 'hint' }, e.message));
      return;
    }
    sourceHint.textContent = s.error
      ? s.error
      : s.builtin
        ? `Używane jest wbudowane źródło: ${s.repo || 'serwer ogłoszeń'}. Zostaw to pole puste.`
        : s.mode === 'github'
          ? `Czytam ogłoszenia z repozytorium ${s.repo} (plik announcements.json). Aktualizacje też stamtąd.`
          : s.mode === 'server'
            ? 'Używam własnego serwera ogłoszeń.'
            : 'Format: właściciel/repo (publiczne repozytorium GitHub) albo https://adres-serwera. Puste = brak ogłoszeń.';
    if (!s.configured) {
      mount(box);
      return;
    }
    if (s.loggedIn) {
      mount(
        box,
        h(
          'div',
          { class: 'acct-row sel' },
          h('div', { class: 'pic', style: { width: '36px', height: '36px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'var(--panel-3)' } }, icon('check', 18)),
          h(
            'div',
            { class: 'grow' },
            h('div', { style: { fontWeight: 700 } }, s.name),
            h('div', { class: 'hint' }, `${s.mode === 'github' ? 'GitHub · ' : ''}${s.role === 'admin' ? 'Administrator — może usuwać wszystkie ogłoszenia' : 'Publikujący — może dodawać i usuwać własne ogłoszenia'}`),
          ),
          h(
            'button',
            {
              class: 'btn sm',
              onclick: async () => {
                await call('announce:logout');
                toast('Wylogowano z publikowania ogłoszeń.');
                paint();
              },
            },
            'Wyloguj',
          ),
        ),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Na ekranie startowym pojawił się przycisk „Nowe ogłoszenie”.'),
      );
      return;
    }
    const github = s.mode === 'github';
    const key = h('input', {
      class: 'input',
      type: 'password',
      placeholder: github ? 'github_pat_…' : 'crown_…',
      autocomplete: 'off',
    });
    const login = async () => {
      try {
        const next = await call('announce:login', key.value);
        toast(`Zalogowano jako ${next.name}. Możesz publikować ogłoszenia z ekranu startowego.`);
        paint();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    key.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });
    mount(
      box,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, key), h('button', { class: 'btn primary', onclick: login }, icon('check', 16), 'Zaloguj kluczem')),
      github
        ? h(
            'div',
            { class: 'hint', style: { marginTop: '8px', lineHeight: 1.6 } },
            `Klucz dostępu to token GitHub. Poproś właściciela o dodanie Cię jako współpracownika repozytorium ${s.repo} (uprawnienie Write), potem utwórz token: `,
            h('b', null, 'Only select repositories'),
            ` → ${s.repo}, uprawnienie `,
            h('b', null, 'Contents: Read and write'),
            '. ',
            h('a', { href: '#', onclick: (e) => { e.preventDefault(); call('shell:open-external', 'https://github.com/settings/personal-access-tokens/new').catch((err) => toast(err.message, 'err')); } }, 'Utwórz token na GitHubie'),
            '. Token jest przechowywany zaszyfrowany na tym komputerze.',
          )
        : h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Klucz dostajesz od administratora serwera ogłoszeń. Jest przechowywany zaszyfrowany na tym komputerze.'),
    );
  }
  paint();

  return h(
    'div',
    { class: 'card settings-card' },
    h('h3', null, 'Ogłoszenia launchera'),
    h('p', null, 'Osoby z kluczem dostępu mogą publikować ogłoszenia widoczne dla wszystkich użytkowników w newsach na ekranie startowym.'),
    h('div', { class: 'field' }, h('label', null, 'Repozytorium GitHub (lub adres serwera)'), urlInput, sourceHint),
    box,
  );
}

export function renderSettings() {
  const page = h('div', { class: 'page' });
  const accountsBox = h('div');
  const cfg = state.config;

  // ---- konta ----
  const nickInput = h('input', {
    class: 'input',
    placeholder: 'Nick (3–16 znaków)',
    maxlength: 16,
    onkeydown: (e) => {
      if (e.key === 'Enter') addOffline();
    },
  });

  async function addOffline() {
    try {
      await call('accounts:add-offline', nickInput.value);
      nickInput.value = '';
      await refreshAccounts();
      paintAccounts();
      toast('Dodano konto offline.');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function paintAccounts() {
    mount(
      accountsBox,
      state.accounts.length
        ? state.accounts.map((a) =>
            h(
              'div',
              { class: `acct-row${a.id === state.selectedAccount ? ' sel' : ''}` },
              avatar(a, 34),
              h(
                'div',
                { class: 'grow' },
                h('div', { style: { fontWeight: 700 } }, a.username),
                h('div', { class: 'hint' }, a.type === 'microsoft' ? 'Konto Microsoft' : 'Konto offline'),
              ),
              a.id === state.selectedAccount
                ? h('span', { class: 'chip gold' }, 'Aktywne')
                : h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: async () => {
                        await call('accounts:select', a.id);
                        await refreshAccounts();
                        paintAccounts();
                      },
                    },
                    'Użyj',
                  ),
              h(
                'button',
                {
                  class: 'btn icon ghost sm',
                  title: 'Usuń konto',
                  onclick: async () => {
                    if (!(await confirmModal({ title: 'Usuń konto', message: `Usunąć konto ${a.username} z launchera?`, confirmLabel: 'Usuń', danger: true }))) return;
                    await call('accounts:remove', a.id);
                    await refreshAccounts();
                    paintAccounts();
                  },
                },
                icon('trash', 16),
              ),
            ),
          )
        : h('div', { class: 'hint', style: { marginBottom: '10px' } }, 'Brak kont. Dodaj konto offline poniżej.'),
    );
  }
  paintAccounts();

  // stan konfiguracji logowania Microsoft: brak / własny Client ID / wbudowany w launcher
  const msBox = h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap' } });
  const intro = h('p', null, 'Konta offline wystarczą do gry jednoosobowej i na serwerach bez weryfikacji (online-mode=false). Nick wpisujesz sam.');
  async function paintMicrosoft() {
    let s = { configured: false, source: null };
    try {
      s = await call('accounts:ms-status');
    } catch {
      /* zostaje „nieskonfigurowane” */
    }
    intro.textContent =
      'Przełączaj konta kliknięciem w panelu bocznym. Konto offline wystarcza do gry jednoosobowej i na serwerach bez weryfikacji, a do serwerów premium zaloguj się kontem Microsoft.';
    const setupLink = (label) =>
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openMicrosoftSetup({ onConfigured: paintMicrosoft }); } }, label);

    mount(
      msBox,
      h(
        'button',
        { class: 'btn primary', onclick: () => startMicrosoftLogin(paintAccounts) },
        icon('user', 16),
        'Zaloguj przez Microsoft',
      ),
      s.source === 'user'
        ? h('span', { class: 'hint' }, 'Używany własny Client ID. ', setupLink('Zmień'))
        : h('span', { class: 'hint' }, 'Bez rejestracji w Azure. ', setupLink('Dla zaawansowanych: własny Client ID')),
    );
  }
  paintMicrosoft();

  page.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Ustawienia'), h('p', null, 'Konta, pamięć, Java i zachowanie launchera.'))),

    h(
      'div',
      { class: 'card settings-card' },
      h('h3', null, 'Konta'),
      intro,
      accountsBox,
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('div', { class: 'grow' }, nickInput), h('button', { class: 'btn', onclick: addOffline }, icon('plus', 16), 'Dodaj offline')),
      h('div', { class: 'divider' }),
      msBox,
    ),

    h(
      'div',
      { class: 'card settings-card' },
      h('h3', null, 'Gra'),
      h('p', null, 'Domyślne wartości dla wszystkich instancji. Każda instancja może je nadpisać.'),
      (() => {
        const label = h('span', { class: 'chip gold' }, `${(cfg.memoryMb / 1024).toFixed(1)} GB`);
        const save = debounced((v) => saveConfig({ memoryMb: v }));
        return h(
          'div',
          { class: 'field' },
          h('div', { class: 'row' }, h('label', { class: 'grow label' }, 'Domyślna pamięć RAM'), label),
          h('input', {
            type: 'range',
            min: 1024,
            max: 16384,
            step: 512,
            value: cfg.memoryMb,
            oninput: (e) => {
              const v = Number(e.target.value);
              label.textContent = `${(v / 1024).toFixed(1)} GB`;
              save(v);
            },
          }),
        );
      })(),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Dodatkowe argumenty JVM'),
        h('input', {
          class: 'input',
          placeholder: '-XX:+UseZGC',
          value: cfg.jvmArgs,
          oninput: debounced((e) => saveConfig({ jvmArgs: e.target.value })),
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Własna Java (opcjonalnie)'),
        h('input', {
          class: 'input',
          placeholder: 'Puste = launcher sam pobierze właściwą Javę',
          value: cfg.javaPath,
          oninput: debounced((e) => saveConfig({ javaPath: e.target.value.trim() })),
        }),
        h('div', { class: 'hint' }, 'Minecraft 26.x wymaga Javy 25, a 1.21.x Javy 21 — launcher pobiera je automatycznie od Mojang.'),
      ),
    ),

    updatesCard(),

    inviteCard(),

    announcementsCard(),

    h(
      'div',
      { class: 'card settings-card' },
      h('h3', null, 'Launcher'),
      h(
        'div',
        { class: 'row', style: { margin: '14px 0' } },
        h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, 'Minimalizuj launcher podczas gry'), h('div', { class: 'hint' }, 'Okno wróci automatycznie po zamknięciu Minecrafta.')),
        (() => {
          const sw = h('button', {
            class: `switch${cfg.hideOnLaunch ? ' on' : ''}`,
            onclick: async () => {
              const next = !state.config.hideOnLaunch;
              sw.classList.toggle('on', next);
              await saveConfig({ hideOnLaunch: next });
            },
          });
          return sw;
        })(),
      ),
      cfg.discordAvailable
        ? [
            h('div', { class: 'divider' }),
            h(
              'div',
              { class: 'row', style: { margin: '14px 0' } },
              h(
                'div',
                { class: 'grow' },
                h('div', { style: { fontWeight: 700 } }, 'Pokazuj na Discordzie, że grasz w CrownClient'),
                h('div', { class: 'hint' }, 'W profilu pojawi się „Gra w CrownClient”, wersja Minecrafta i czas gry. Adresy prywatnych serwerów nie są wysyłane.'),
              ),
              (() => {
                const sw = h('button', {
                  class: `switch${cfg.discordPresence !== false ? ' on' : ''}`,
                  onclick: async () => {
                    const next = state.config.discordPresence === false;
                    sw.classList.toggle('on', next);
                    await saveConfig({ discordPresence: next });
                  },
                });
                return sw;
              })(),
            ),
          ]
        : null,
      h('div', { class: 'divider' }),
      toggleRow(
        'Dostrojona Java (mniej zacięć)',
        'Zoptymalizowane flagi JVM i garbage collector G1. Wyłącz, jeśli używasz własnych argumentów JVM.',
        'optimizeJvm',
      ),
      cosmeticsRow(),
      h('div', { class: 'divider' }),
      toggleRow(
        'Mody optymalizujące (Fabric)',
        'W nowej instancji Fabric dokłada z Modrinth pakiet CrownClient (Lithium, FerriteCore, ModernFix, Entity Culling, More Culling, Dynamic FPS, ScalableLux, Simple Voice Chat, Mod Menu i inne) w najnowszych wydaniach dla danej wersji gry, plus renderer: VulkanMod z Not Enough Vulkan (poniżej 26.2) albo Sodium.',
        'optimizeMods',
      ),
      h('div', { class: 'divider' }),
      toggleRow(
        'Naprawiaj awarie automatycznie',
        'Gdy gra się wysypie, launcher sprawdza przyczynę i od razu to naprawia: aktualizuje mod do wersji zgodnej z grą, doinstalowuje brakującą zależność albo wyłącza mod, który psuje start (da się to cofnąć w oknie awarii albo w zakładce Mody).',
        'autoFixCrashes',
      ),
      h('div', { class: 'divider' }),
      (() => {
        const sel = h(
          'select',
          {
            class: 'select',
            style: { maxWidth: '260px' },
            onchange: async (e) => saveConfig({ renderer: e.target.value }),
          },
          h('option', { value: 'auto', selected: state.config.renderer !== 'sodium' }, 'Automatycznie (VulkanMod)'),
          h('option', { value: 'sodium', selected: state.config.renderer === 'sodium' }, 'Zawsze Sodium (OpenGL)'),
        );
        return h(
          'div',
          { class: 'row', style: { margin: '14px 0' } },
          h(
            'div',
            { class: 'grow' },
            h('div', { style: { fontWeight: 700 } }, 'Renderer w nowych instancjach'),
            h(
              'div',
              { class: 'hint', style: { lineHeight: 1.5 } },
              'Automatycznie: VulkanMod tam, gdzie ma wydanie dla danej wersji (wymaga sterownika Vulkan). Od Minecrafta 26.2 Vulkan jest w opcjach gry, więc tam zawsze jest Sodium. Gdyby gra z VulkanMod nie wystartowała, launcher sam wraca do Sodium. Istniejące instancje zmienia przycisk „Optymalizuj” na ich stronie.',
            ),
          ),
          sel,
        );
      })(),
      h('div', { class: 'divider' }),
      h(
        'div',
        { class: 'row' },
        h(
          'div',
          { class: 'grow' },
          h('div', { style: { fontWeight: 700 } }, 'Folder danych'),
          h('div', { class: 'hint', style: { userSelect: 'text' } }, state.info.dataDir),
        ),
        h('button', { class: 'btn', onclick: () => call('shell:open-data-dir') }, icon('folder', 16), 'Otwórz'),
      ),
      h('div', { class: 'divider' }),
      h(
        'div',
        { class: 'hint' },
        `Obsługiwane wersje Minecrafta: ${state.info.minVersion} – ${state.info.maxVersion}`,
      ),
      h(
        'div',
        { class: 'hint', style: { marginTop: '10px', lineHeight: 1.5 } },
        'CrownLauncher jest nieoficjalnym launcherem. To nie jest oficjalny produkt Minecraft — nie jest zatwierdzony przez Mojang ani Microsoft i nie jest z nimi powiązany.',
      ),
    ),
  );

  // upewnij się, że konfiguracja jest świeża (np. po zmianie z innej strony)
  refreshConfig();
  return page;
}
