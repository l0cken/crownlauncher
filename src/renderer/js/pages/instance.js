import { call } from '../api.js';
import { h, icon, mount, toast, confirmModal, openModal, fmtPlaytime, fmtSize } from '../dom.js';
import { state, instanceById, refreshInstances, onLeave, COLORS } from '../state.js';
import { navigate, tile, playButton } from '../components.js';
import { parseLogLine, rowClass } from '../log-format.js';
import { crashCard } from '../crash-report.js';

const tabByInstance = {};

/** Następne wejście na stronę instancji otwiera wskazaną zakładkę (np. konsolę po awarii). */
export function setInstanceTab(id, tab) {
  tabByInstance[id] = tab;
}

const TABS = [
  { id: 'mods', label: 'Mody', type: 'mod' },
  { id: 'resourcepacks', label: 'Paczki zasobów', type: 'resourcepack' },
  { id: 'shaders', label: 'Shadery', type: 'shader' },
  { id: 'settings', label: 'Ustawienia' },
  { id: 'console', label: 'Konsola' },
];

export function renderInstance({ params }) {
  const inst = instanceById(params.id);
  const page = h('div', { class: 'page' });
  if (!inst) {
    page.append(
      h('div', { class: 'empty' }, icon('alert', 40), h('h3', null, 'Nie znaleziono instancji'), h('a', { class: 'back', href: '#/instances' }, 'Wróć do listy')),
    );
    return page;
  }

  const memory = inst.memoryMb || state.config.memoryMb;
  page.append(
    h('a', { class: 'back', href: '#/instances' }, icon('back', 16), 'Instancje'),
    h(
      'div',
      { class: 'inst-head' },
      tile(inst, true),
      h(
        'div',
        { class: 'info' },
        h('h1', null, inst.name),
        h(
          'div',
          { class: 'chips' },
          h('span', { class: 'chip gold' }, `Minecraft ${inst.mcVersion}`),
          h(
            'span',
            { class: 'chip' },
            inst.loader === 'fabric' || inst.loader === 'vanilla'
              ? `Fabric${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}`
              : `${inst.loader} (nieobsługiwany)`,
          ),
          h('span', { class: 'chip' }, `${(memory / 1024).toFixed(1)} GB RAM`),
          h('span', { class: 'chip' }, icon('clock', 13), fmtPlaytime(inst.playTime)),
        ),
      ),
      h(
        'div',
        { class: 'acts' },
        h(
          'button',
          {
            class: 'btn icon',
            title: 'Otwórz folder gry',
            onclick: () => call('instances:open-folder', inst.id).catch((e) => toast(e.message, 'err')),
          },
          icon('folder', 18),
        ),
        playButton(inst, { large: true }),
      ),
    ),
  );

  const tabsEl = h('div', { class: 'tabs' });
  const panel = h('div');
  // ostatnia awaria (jeśli była): który mod ją wywołał
  const crashSlot = h('div');
  call('instances:crash', inst.id)
    .then((data) => {
      if (!data || !(data.suspects?.length || data.cause)) return;
      mount(
        crashSlot,
        crashCard(inst.id, data, {
          onChanged: () => window.dispatchEvent(new Event('crown-rerender')),
          onConsole: () => select('console'),
        }),
      );
    })
    .catch(() => {});
  page.append(crashSlot, tabsEl, panel);

  let selection = 0;
  const select = (id) => {
    const mine = ++selection;
    const alive = () => mine === selection;
    tabByInstance[inst.id] = id;
    mount(
      tabsEl,
      TABS.map((t) => h('button', { class: t.id === id ? 'active' : '', onclick: () => select(t.id) }, t.label)),
    );
    const tab = TABS.find((t) => t.id === id);
    if (tab.type) renderContent(panel, inst, tab, alive);
    else if (id === 'settings') renderSettings(panel, inst);
    else renderConsole(panel, inst);
  };
  select(tabByInstance[inst.id] || 'mods');
  return page;
}

async function renderContent(panel, inst, tab, alive) {
  mount(panel, h('div', { class: 'skeleton' }));
  let items = [];
  try {
    items = await call('content:list', inst.id, tab.type);
  } catch (e) {
    toast(e.message, 'err');
  }
  if (!alive()) return; // użytkownik zdążył przełączyć zakładkę

  const isMods = tab.type === 'mod';
  const cached = isMods ? updateCache.get(inst.id) : null;
  const updateByFile = new Map((cached?.list || []).map((u) => [u.file.replace(/\.disabled$/i, ''), u]));
  const reload = () => renderContent(panel, inst, tab, alive);

  // sprawdzenie aktualizacji w Modrinth (przy pierwszym wejściu w sesji samo, potem na przycisk)
  const checkBtn = isMods
    ? h(
        'button',
        {
          class: 'btn sm',
          title: 'Sprawdź w Modrinth, czy są nowsze wersje modów',
          onclick: () => checkUpdates(false),
        },
        icon('refresh', 15),
        'Sprawdź aktualizacje',
      )
    : null;
  function checkUpdates(silent) {
    if (!isMods || checkBtn?.disabled) return Promise.resolve();
    if (checkBtn) checkBtn.disabled = true;
    const job = call('content:updates', inst.id)
      .then((found) => {
        updateCache.set(inst.id, { at: Date.now(), list: found });
        if (!silent) {
          toast(found.length ? `Dostępne aktualizacje modów: ${found.length}.` : 'Wszystkie mody są aktualne.');
        }
      })
      .catch((e) => {
        updateCache.set(inst.id, { at: Date.now(), list: [] });
        if (!silent) toast(e.message, 'err');
      });
    // wynik trafia do pamięci podręcznej także wtedy, gdy użytkownik zdążył opuścić stronę
    updateCache.set(inst.id, { at: Date.now(), list: cached?.list || [], pending: job });
    job.then(() => {
      if (alive()) reload();
    });
    return job;
  }
  const updateAllBtn =
    isMods && updateByFile.size
      ? h(
          'button',
          {
            class: 'btn primary sm',
            onclick: async () => {
              updateAllBtn.disabled = true;
              try {
                const r = await call('content:update-all', inst.id);
                updateCache.delete(inst.id);
                const parts = [];
                if (r.updated.length) parts.push(`zaktualizowano: ${r.updated.join(', ')}`);
                if (r.deduped?.length) parts.push(`usunięto starsze kopie: ${r.deduped.map((d) => d.file).join(', ')}`);
                if (r.failed.length) parts.push(`nie udało się: ${r.failed.map((f) => `${f.title} (${f.error})`).join('; ')}`);
                toast(parts.join('. ') || 'Nic do aktualizacji.', r.failed.length ? 'err' : 'ok', 9000);
                reload();
              } catch (e) {
                toast(e.message, 'err');
                updateAllBtn.disabled = false;
              }
            },
          },
          icon('download', 15),
          `Aktualizuj wszystko (${updateByFile.size})`,
        )
      : null;

  const head = h(
    'div',
    { class: 'row', style: { marginBottom: '14px', gap: '8px' } },
    h('div', { class: 'grow hint' }, `${items.length} ${items.length === 1 ? 'element' : 'elementów'}`),
    checkBtn,
    updateAllBtn,
    h(
      'button',
      {
        class: 'btn primary sm',
        onclick: () => navigate(`#/browse?type=${tab.type}&instance=${inst.id}`),
      },
      icon('plus', 15),
      'Dodaj z Modrinth',
    ),
  );

  const list = h('div', { class: 'list' });

  for (const it of items) {
    const toggle = h('button', {
      class: `switch${it.enabled ? ' on' : ''}`,
      title: it.enabled ? 'Wyłącz' : 'Włącz',
      onclick: async () => {
        try {
          await call('content:toggle', inst.id, tab.type, it.file);
          reload();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    });
    const del = it.bundled ? null : h(
      'button',
      {
        class: 'btn icon ghost',
        title: 'Usuń',
        onclick: async () => {
          if (!(await confirmModal({ title: 'Usuń plik', message: `Usunąć „${it.title}”?`, confirmLabel: 'Usuń', danger: true }))) return;
          try {
            await call('content:delete', inst.id, tab.type, it.file);
            reload();
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      },
      icon('trash', 17),
    );
    const upd = updateByFile.get(it.file.replace(/\.disabled$/i, ''));
    const updBtn = upd
      ? h(
          'button',
          {
            class: 'btn sm primary',
            title: `Zaktualizuj do ${upd.latest.number}${upd.latest.type !== 'release' ? ` (${upd.latest.type})` : ''}`,
            onclick: async () => {
              updBtn.disabled = true;
              try {
                const res = await call('content:update', inst.id, it.file);
                const c = updateCache.get(inst.id);
                if (c) c.list = c.list.filter((u) => u.file !== upd.file);
                const dupes = (res.deduped || []).map((d) => d.file).join(', ');
                toast(
                  res.updated
                    ? `Zaktualizowano „${it.title}” do ${upd.latest.number}.${dupes ? ` Usunięto starszą kopię: ${dupes}.` : ''}`
                    : `„${it.title}” ma już najnowszą wersję.`,
                );
                reload();
              } catch (e) {
                toast(e.message, 'err', 7000);
                updBtn.disabled = false;
              }
            },
          },
          icon('download', 14),
          'Aktualizuj',
        )
      : null;
    list.append(
      h(
        'div',
        { class: `card item${it.enabled ? '' : ' off'}` },
        it.icon
          ? h('img', { class: 'pic', src: it.icon, alt: '', loading: 'lazy' })
          : h('div', { class: 'pic' }, (it.title[0] || '?').toUpperCase()),
        h(
          'div',
          { class: 'body' },
          h(
            'div',
            { class: 'ttl' },
            it.title,
            it.versionNumber ? h('small', null, it.versionNumber) : null,
            it.bundled ? h('span', { class: 'chip gold', title: 'Dodawany automatycznie przez CrownLauncher' }, 'CrownLauncher') : null,
            upd ? h('span', { class: 'chip ok', title: `Nowsza wersja: ${upd.latest.number}` }, `→ ${upd.latest.number}`) : null,
          ),
          h('div', { class: 'desc' }, `${it.file.replace(/\.disabled$/, '')}${it.size ? ` · ${fmtSize(it.size)}` : ''}`),
        ),
        updBtn,
        toggle,
        del,
      ),
    );
  }

  mount(
    panel,
    head,
    items.length
      ? list
      : h(
          'div',
          { class: 'empty' },
          icon('box', 40),
          h('h3', null, 'Pusto'),
          h('div', null, 'Dodaj coś z Modrinth albo wrzuć pliki ręcznie do folderu gry.'),
        ),
  );

  if (isMods && cached?.pending) {
    // sprawdzenie z poprzedniej wizyty jeszcze trwa - narysuj wynik, gdy się skończy
    cached.pending.then(() => {
      if (alive()) reload();
    });
  } else if (isMods && !cached && items.length) {
    checkUpdates(true); // jedno automatyczne sprawdzenie na sesję
  }

  // Pliki spoza launchera (np. z importu paczki) rozpoznajemy w tle po sumie SHA-1: dostają nazwy i ikony
  // z Modrinth, a przeglądarka wie, że już je masz.
  const pending = items.filter((i) => !i.projectId && !i.unmatched).length;
  if (pending && !identifying.has(inst.id)) {
    identifying.add(inst.id);
    const note = head.firstChild;
    const base = note.textContent;
    note.textContent = `${base} · rozpoznaję ${pending} ${pending === 1 ? 'plik' : 'plików'} w Modrinth…`;
    call('content:identify', inst.id)
      .then((r) => {
        if (r.identified && alive()) reload();
        else if (note.isConnected) note.textContent = base;
      })
      .catch(() => {
        if (note.isConnected) note.textContent = base;
      })
      .finally(() => identifying.delete(inst.id));
  }
}

const identifying = new Set();
const updateCache = new Map(); // id instancji -> { at, list } (wynik sprawdzenia aktualizacji modów)

/** Najlepszy zestaw optymalizacji dla wersji Minecrafta tej instancji (na życzenie; może zmienić renderer). */
function optimizeCard(inst) {
  const renderer = inst.perfRenderer === 'vulkanmod' ? 'VulkanMod (Vulkan)' : inst.perfRenderer === 'other' ? 'własny renderer' : 'Sodium (OpenGL)';
  const btn = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        btn.disabled = true;
        try {
          const r = await call('instances:optimize', inst.id);
          const parts = [];
          if (r.removed?.length) parts.push(`usunięto ${r.removed.length}: ${r.removed.join(', ')}`);
          if (r.added?.length) parts.push(`dodano ${r.added.length}: ${r.added.join(', ')}`);
          if (r.failed?.length) parts.push(`nie udało się: ${r.failed.map((f) => `${f.title} (${f.error})`).join('; ')}`);
          const renderer = r.renderer === 'vulkanmod' ? 'VulkanMod' : 'Sodium';
          toast(
            parts.length ? `Pakiet CrownClient — ${parts.join('. ')}. Renderer: ${renderer}.` : 'Instancja ma już cały pakiet dla tej wersji Minecrafta.',
            r.failed?.length ? 'err' : 'ok',
            12000,
          );
          await refreshInstances();
          window.dispatchEvent(new Event('crown-rerender'));
        } catch (e) {
          toast(e.message, 'err', 7000);
          btn.disabled = false;
        }
      },
    },
    icon('zap', 16),
    'Optymalizuj',
  );
  return h(
    'div',
    { class: 'card settings-card' },
    h('h3', null, 'Pakiet CrownClient'),
    h(
      'p',
      { style: { marginBottom: '12px', lineHeight: 1.5 } },
      `Pakiet modów (optymalizacje i wygoda) w najnowszych wydaniach z Modrinth dla Minecrafta ${inst.mcVersion}; mody bez wydania dla tej wersji są pomijane. Renderer: poniżej 26.2 VulkanMod + Not Enough Vulkan zamiast Sodium (gdzie VulkanMod ma wydanie), od 26.2 Sodium. „Optymalizuj” dokłada brakujące mody i może zamienić renderer. Obecnie: ${inst.perfModsApplied ? renderer : 'jeszcze nie zastosowano'}.`,
    ),
    btn,
  );
}

let exporting = false;

/** Eksport instancji do pliku .mrpack (mody, configi, paczki zasobów, shadery, opcjonalnie światy). */
async function exportInstance(inst, { worlds }) {
  if (exporting) {
    toast('Trwa już eksport innej instancji.', 'err');
    return;
  }
  exporting = true;
  const text = h('div', null, 'Przygotowanie…');
  let modal = null;
  // okno „Zapisz jako” otwiera proces główny; modal z postępem pokazujemy dopiero po wyborze pliku (pierwsze zdarzenie postępu)
  const onProgress = (e) => {
    const d = e.detail;
    if (d.id !== inst.id) return;
    if (!modal) {
      modal = openModal({ title: 'Eksport instancji', closable: false, body: h('div', { class: 'row' }, h('span', { class: 'spin' }), text) });
    }
    text.textContent = d.total ? `Pakuję ${d.current}/${d.total}: ${d.text.replace(/^Pakuję: /, '')}` : d.text;
  };
  try {
    document.addEventListener('export-progress', onProgress);
    const out = await call('instances:export', inst.id, { worlds });
    modal?.close();
    if (!out) return; // anulowano okno zapisu
    const skipped = out.skipped.secrets + out.skipped.other;
    openModal({
      title: 'Instancja wyeksportowana',
      body: h(
        'div',
        { class: 'stack' },
        h('p', null, `Plików w paczce: ${out.files} (${fmtSize(out.bytes)}${out.worlds ? ', ze światami' : ''}).`),
        h('div', { class: 'hint' }, out.path),
        h(
          'p',
          { class: 'hint' },
          'Plik .mrpack zaimportujesz w CrownLauncherze (Instancje → Importuj .mrpack), w Modrinth App i w Prism Launcher. ' +
            'Ustawienia launchera (nick, konta, pamięć RAM) nie są w paczce.',
        ),
        skipped
          ? h(
              'p',
              { class: 'hint' },
              `Pominięte pliki: ${skipped}${out.skipped.secrets ? ` (w tym ${out.skipped.secrets} wyglądających na poufne: tokeny, klucze, hasła)` : ''}.`,
            )
          : null,
      ),
      actions: [
        h('button', { class: 'btn', onclick: () => call('shell:show-export').catch((e) => toast(e.message, 'err')) }, icon('folder', 16), 'Pokaż w folderze'),
      ],
    });
  } catch (e) {
    modal?.close();
    toast(e.message, 'err');
  } finally {
    document.removeEventListener('export-progress', onProgress);
    exporting = false;
  }
}

function exportCard(inst) {
  let worlds = false;
  const sw = h('button', {
    class: 'switch',
    onclick: () => {
      worlds = !worlds;
      sw.classList.toggle('on', worlds);
    },
  });
  return h(
    'div',
    { class: 'card settings-card' },
    h('h3', null, 'Eksport instancji'),
    h(
      'p',
      null,
      'Zapisuje mody, konfiguracje, paczki zasobów, shadery i ustawienia gry do jednego pliku .mrpack - jako kopię zapasową albo do przeniesienia na inny komputer lub wysłania znajomemu.',
    ),
    h('div', { class: 'row' }, h('label', { class: 'grow label' }, 'Dołącz światy (zapisane gry)'), sw),
    h('div', { class: 'hint' }, 'Światy zwiększają paczkę, a import czyta ją w pamięci - przy bardzo dużych światach eksportuj bez nich.'),
    h(
      'div',
      null,
      h(
        'button',
        { class: 'btn', onclick: () => exportInstance(inst, { worlds }) },
        icon('download', 16),
        'Eksportuj do pliku .mrpack',
      ),
    ),
  );
}

function renderSettings(panel, inst) {
  const form = {
    name: inst.name,
    memoryMb: inst.memoryMb || state.config.memoryMb,
    useDefaultMemory: !inst.memoryMb,
    jvmArgs: inst.jvmArgs || '',
    javaPath: inst.javaPath || '',
    color: inst.color,
  };

  const memLabel = h('span', { class: 'chip gold' });
  const paintMem = () => {
    memLabel.textContent = form.useDefaultMemory
      ? `domyślna (${(state.config.memoryMb / 1024).toFixed(1)} GB)`
      : `${(form.memoryMb / 1024).toFixed(1)} GB`;
  };
  paintMem();

  const swatches = h('div', { class: 'swatches' });
  const paintSwatches = () =>
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
  paintSwatches();

  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        try {
          await call('instances:update', inst.id, {
            name: form.name.trim(),
            memoryMb: form.useDefaultMemory ? 0 : form.memoryMb,
            jvmArgs: form.jvmArgs,
            javaPath: form.javaPath.trim(),
            color: form.color,
          });
          await refreshInstances();
          toast('Zapisano ustawienia instancji.');
          // przerysuj widok, żeby odświeżyć nagłówek
          window.dispatchEvent(new Event('crown-rerender'));
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    },
    'Zapisz zmiany',
  );

  mount(
    panel,
    h(
      'div',
      { class: 'card settings-card' },
      h('div', { class: 'field' }, h('label', null, 'Nazwa'), h('input', { class: 'input', value: form.name, maxlength: 40, oninput: (e) => (form.name = e.target.value) })),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'row' }, h('label', { class: 'grow label' }, 'Pamięć RAM'), memLabel),
        h('input', {
          type: 'range',
          min: 1024,
          max: 16384,
          step: 512,
          value: form.memoryMb,
          oninput: (e) => {
            form.memoryMb = Number(e.target.value);
            form.useDefaultMemory = false;
            paintMem();
          },
        }),
        h(
          'div',
          null,
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                form.useDefaultMemory = true;
                paintMem();
              },
            },
            'Użyj domyślnej z ustawień',
          ),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Dodatkowe argumenty JVM'),
        h('input', { class: 'input', placeholder: '-XX:+UseZGC', value: form.jvmArgs, oninput: (e) => (form.jvmArgs = e.target.value) }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Własna Java (opcjonalnie)'),
        h('input', { class: 'input', placeholder: 'Puste = Java pobrana automatycznie', value: form.javaPath, oninput: (e) => (form.javaPath = e.target.value) }),
        h('div', { class: 'hint' }, 'Ścieżka do pliku java (java.exe w Windows). Zostaw puste, aby launcher użył właściwej wersji Javy dla tej wersji Minecrafta.'),
      ),
      h('div', { class: 'field' }, h('label', null, 'Kolor'), swatches),
      h('div', { class: 'row' }, save, h('div', { class: 'grow' })),
    ),
    optimizeCard(inst),
    exportCard(inst),
    h(
      'div',
      { class: 'card settings-card' },
      h('h3', null, 'Strefa niebezpieczna'),
      h('p', null, 'Usunięcie instancji kasuje jej mody, ustawienia i światy. Tej operacji nie można cofnąć.'),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            const ok = await confirmModal({
              title: 'Usuń instancję',
              message: `Na pewno usunąć „${inst.name}” razem ze wszystkimi światami i modami?`,
              confirmLabel: 'Usuń instancję',
              danger: true,
            });
            if (!ok) return;
            try {
              await call('instances:delete', inst.id);
              await refreshInstances();
              toast('Instancja została usunięta.');
              navigate('#/instances');
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        },
        icon('trash', 16),
        'Usuń instancję',
      ),
    ),
  );
}

// filtr poziomów: klasa na konsoli ukrywa wiersze poniżej wybranego poziomu
const CONSOLE_FILTERS = [
  { id: '', label: 'Wszystko' },
  { id: 'f-warn', label: 'Ostrzeżenia i błędy' },
  { id: 'f-err', label: 'Tylko błędy' },
];
let consoleFilter = '';

function renderConsole(panel, inst) {
  const box = h('div', { class: `console ${consoleFilter}` });
  const MAX = 1500;
  let level = 'INFO'; // poziom ostatniego zdarzenia: ślady stosu i linie bez znacznika go dziedziczą

  const add = (lines) => {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    for (const line of lines) {
      const parsed = parseLogLine(line, level);
      level = parsed.level; // zdarzenie ustala poziom; linie bez znacznika (ślad stosu) go dziedziczą

      box.append(
        h(
          'div',
          { class: rowClass(parsed) },
          ...parsed.segments.map((s) => (s.c ? h('span', { class: s.c }, s.t) : document.createTextNode(s.t))),
          parsed.segments.length ? null : ' ',
        ),
      );
    }
    while (box.childNodes.length > MAX) box.firstChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };

  const seg = h('div', { class: 'seg' });
  const paintSeg = () =>
    mount(
      seg,
      CONSOLE_FILTERS.map((f) =>
        h(
          'button',
          {
            class: consoleFilter === f.id ? 'active' : '',
            onclick: () => {
              consoleFilter = f.id;
              box.className = `console ${f.id}`;
              paintSeg();
              box.scrollTop = box.scrollHeight;
            },
          },
          f.label,
        ),
      ),
    );
  paintSeg();

  mount(
    panel,
    h(
      'div',
      { class: 'row', style: { marginBottom: '12px', gap: '10px', flexWrap: 'wrap' } },
      h('div', { class: 'grow hint' }, 'Wyjście gry na żywo — kolory: błędy na czerwono, ostrzeżenia na żółto, komunikaty launchera na złoto.'),
      seg,
      h(
        'button',
        { class: 'btn sm', onclick: () => navigator.clipboard.writeText([...box.childNodes].map((n) => n.textContent).join('\n')).then(() => toast('Skopiowano konsolę do schowka.')) },
        'Kopiuj',
      ),
    ),
    box,
  );

  call('instances:logs', inst.id).then((lines) => {
    if (!lines.length) lines = ['Konsola jest pusta. Uruchom grę, aby zobaczyć jej logi.'];
    add(lines);
  });
  const listener = (e) => {
    if (e.detail.id === inst.id) add(e.detail.lines);
  };
  document.addEventListener('game-log', listener);
  onLeave(() => document.removeEventListener('game-log', listener));
}
