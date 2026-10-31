import { call } from '../api.js';
import { h, icon, mount, toast, openModal, fmtNumber } from '../dom.js';
import { state, instanceById, refreshInstances, onLeave } from '../state.js';
import { navigate, pickInstance } from '../components.js';

const TYPES = [
  { id: 'mod', label: 'Mody', one: 'mod' },
  { id: 'modpack', label: 'Paczki modów', one: 'paczkę modów' },
  { id: 'resourcepack', label: 'Paczki zasobów', one: 'paczkę zasobów' },
  { id: 'shader', label: 'Shadery', one: 'shader' },
];

const SORTS = [
  ['relevance', 'Trafność'],
  ['downloads', 'Najczęściej pobierane'],
  ['follows', 'Najczęściej obserwowane'],
  ['newest', 'Najnowsze'],
  ['updated', 'Ostatnio aktualizowane'],
];

// stan wyszukiwarki zachowujemy między wizytami na stronie
const S = { type: 'mod', query: '', sort: 'downloads', instanceId: '' };

function projectPic(hit) {
  return hit.icon
    ? h('img', { class: 'pic', src: hit.icon, alt: '', loading: 'lazy' })
    : h('div', { class: 'pic' }, (hit.title[0] || '?').toUpperCase());
}

/** Instalacja projektu z Modrinth (mod / paczka zasobów / shader / paczka modów). */
export async function installHit(hit, { instanceId, button, onInstalled } = {}) {
  let installedNow = false;
  const setBusy = (busy, text) => {
    if (!button) return;
    button.disabled = busy;
    mount(button, busy ? h('span', { class: 'spin' }) : icon('download', 15), text || (busy ? 'Instaluję…' : 'Zainstaluj'));
  };

  const onProgress = (e) => {
    if (e.detail.projectId === hit.id) setBusy(true, e.detail.text);
  };
  document.addEventListener('modrinth-progress', onProgress);
  const finish = () => document.removeEventListener('modrinth-progress', onProgress);

  try {
    if (hit.type === 'modpack') {
      setBusy(true, 'Pobieram paczkę…');
      const inst = await call('modrinth:install-modpack', { projectId: hit.id, title: hit.title });
      await refreshInstances();
      toast(`Zaimportowano paczkę „${inst.name}” jako nową instancję.`);
      navigate(`#/instance/${inst.id}`);
      return;
    }

    let target = instanceId ? instanceById(instanceId) : null;
    if (!target) {
      finish();
      pickInstance({
        title: `Zainstaluj „${hit.title}” w…`,
        filter: (inst) => hit.type !== 'mod' || inst.loader === 'fabric',
        onPick: (inst) => installHit(hit, { instanceId: inst.id, button, onInstalled }),
      });
      return;
    }

    setBusy(true);
    const res = await call('modrinth:install', {
      instanceId: target.id,
      projectId: hit.id,
      type: hit.type,
      title: hit.title,
      slug: hit.slug,
      icon: hit.icon,
    });
    if (res.already) {
      toast(`„${hit.title}” jest już zainstalowany w ${target.name}.`);
    } else {
      const deps = res.installed.length - 1;
      toast(
        `Zainstalowano „${hit.title}” w ${target.name}${deps > 0 ? ` (+ ${deps} wymaganych zależności)` : ''}.`,
      );
    }
    installedNow = true;
    onInstalled?.();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    finish();
    if (!installedNow) setBusy(false);
  }
}

export async function openProjectModal(hit, { instanceId, installed = false } = {}) {
  const body = h('div', null, h('div', { class: 'skeleton' }));
  const installBtn = h(
    'button',
    {
      class: `btn ${installed ? '' : 'primary'}`,
      disabled: installed,
      onclick: () =>
        installHit(hit, {
          instanceId,
          button: installBtn,
          onInstalled: () => {
            installBtn.disabled = true;
            installBtn.classList.remove('primary');
            mount(installBtn, icon('check', 16), 'Zainstalowano');
          },
        }),
    },
    icon(installed ? 'check' : 'download', 16),
    installed ? 'Zainstalowano' : 'Zainstaluj',
  );
  const linkBtn = h('button', { class: 'btn' }, icon('external', 16), 'Modrinth');
  openModal({
    title: hit.title,
    body,
    wide: true,
    actions: [linkBtn, installBtn],
  });

  try {
    const p = await call('modrinth:project', hit.id);
    linkBtn.onclick = () => call('shell:open-external', p.links.page).catch((e) => toast(e.message, 'err'));
    const supported = new Set(state.versions.map((v) => v.id));
    const mcVersions = p.gameVersions.filter((v) => supported.has(v));
    mount(
      body,
      p.gallery[0]
        ? h('img', {
            src: p.gallery[0],
            alt: '',
            style: { width: '100%', maxHeight: '260px', objectFit: 'cover', borderRadius: '12px', marginBottom: '16px' },
          })
        : null,
      h(
        'div',
        { class: 'row', style: { marginBottom: '14px' } },
        projectPic(p),
        h(
          'div',
          { class: 'grow' },
          h('div', { style: { color: 'var(--muted)' } }, hit.author ? `autor: ${hit.author}` : p.type),
          h(
            'div',
            { class: 'row wrap', style: { gap: '14px', marginTop: '4px' } },
            h('span', { class: 'stat' }, icon('download', 14), `${fmtNumber(p.downloads)} pobrań`),
            h('span', { class: 'stat' }, icon('heart', 14), `${fmtNumber(p.follows)} obserwujących`),
          ),
        ),
      ),
      h('p', { style: { margin: '0 0 16px', lineHeight: 1.55, userSelect: 'text' } }, p.description),
      h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Kategorie i loadery'),
      h(
        'div',
        { class: 'row wrap', style: { gap: '6px', marginBottom: '16px' } },
        [...new Set([...p.categories, ...p.loaders])].slice(0, 14).map((c) => h('span', { class: 'chip' }, c)),
      ),
      h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Obsługiwane wersje (1.21.4 – 26.3)'),
      h(
        'div',
        { class: 'row wrap', style: { gap: '6px' } },
        mcVersions.length
          ? mcVersions.map((v) => h('span', { class: 'chip gold' }, v))
          : h('span', { class: 'hint' }, 'Brak potwierdzonej zgodności z wersjami obsługiwanymi przez launcher.'),
      ),
    );
  } catch (e) {
    mount(body, h('div', { class: 'empty' }, icon('alert', 32), h('h3', null, 'Nie udało się wczytać projektu'), e.message));
  }
}

export function renderBrowse({ query }) {
  if (query.type && TYPES.some((t) => t.id === query.type)) S.type = query.type;
  if (query.instance !== undefined) S.instanceId = query.instance;
  if (S.instanceId && !instanceById(S.instanceId)) S.instanceId = '';

  const page = h('div', { class: 'page' });
  const results = h('div', { class: 'list' });
  const moreWrap = h('div', { style: { textAlign: 'center', marginTop: '16px' } });
  const summary = h('div', { class: 'hint' });
  let offset = 0;
  let total = 0;
  let token = 0;
  let debounce = null;
  onLeave(() => clearTimeout(debounce));

  const typeSeg = h('div', { class: 'seg' });
  const paintTypes = () =>
    mount(
      typeSeg,
      TYPES.map((t) =>
        h(
          'button',
          {
            class: S.type === t.id ? 'active' : '',
            onclick: () => {
              S.type = t.id;
              paintTypes();
              run(true);
            },
          },
          t.label,
        ),
      ),
    );

  const searchInput = h('input', {
    class: 'input',
    placeholder: 'Szukaj w Modrinth…',
    value: S.query,
    oninput: (e) => {
      S.query = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => run(true), 350);
    },
  });
  const sortSelect = h(
    'select',
    {
      class: 'select',
      value: S.sort,
      style: { width: '220px' },
      onchange: (e) => {
        S.sort = e.target.value;
        run(true);
      },
    },
    SORTS.map(([id, label]) => h('option', { value: id }, label)),
  );
  const instSelect = h(
    'select',
    {
      class: 'select',
      value: S.instanceId,
      style: { width: '260px' },
      onchange: (e) => {
        S.instanceId = e.target.value;
        run(true);
      },
    },
    h('option', { value: '' }, 'Wszystkie wersje (1.21.4 – 26.3)'),
    state.instances.map((i) =>
      h('option', { value: i.id }, `${i.name} — Fabric ${i.mcVersion}`),
    ),
  );

  // projekty już zainstalowane w wybranej instancji (rozpoznane po sumie SHA-1 plików)
  let installedIds = new Set();
  const marks = new Map(); // id projektu -> funkcja pokazująca/ukrywająca stan "zainstalowano"
  let installedToken = 0;

  async function refreshInstalled() {
    const mine = ++installedToken;
    installedIds = new Set();
    if (S.instanceId && S.type !== 'modpack') {
      try {
        const r = await call('content:installed', S.instanceId);
        if (mine !== installedToken) return;
        installedIds = new Set(r[S.type] || []);
      } catch {
        /* bez oznaczeń */
      }
    }
    for (const [id, paint] of marks) paint(installedIds.has(id));
  }

  function hitItem(hit) {
    const btn = h(
      'button',
      {
        class: 'btn primary sm',
        onclick: (e) => {
          e.stopPropagation();
          installHit(hit, { instanceId: S.instanceId, button: btn, onInstalled: () => {
            installedIds.add(hit.id);
            paint(true);
          } });
        },
      },
      icon('download', 15),
      'Zainstaluj',
    );
    const badge = h('span', { class: 'chip ok', style: { display: 'none' } }, icon('check', 12), 'Zainstalowano');

    function paint(on) {
      badge.style.display = on ? '' : 'none';
      btn.disabled = on;
      btn.classList.toggle('primary', !on);
      mount(btn, on ? icon('check', 15) : icon('download', 15), on ? 'Zainstalowano' : 'Zainstaluj');
    }
    marks.set(hit.id, paint);
    if (installedIds.has(hit.id)) paint(true);

    return h(
      'div',
      {
        class: 'card item click',
        onclick: () => openProjectModal(hit, { instanceId: S.instanceId, installed: installedIds.has(hit.id) }),
      },
      projectPic(hit),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'ttl' }, hit.title, h('small', null, `autor: ${hit.author}`)),
        h('div', { class: 'desc' }, hit.description),
        h(
          'div',
          { class: 'tags' },
          badge,
          h('span', { class: 'stat' }, icon('download', 13), fmtNumber(hit.downloads)),
          h('span', { class: 'stat' }, icon('heart', 13), fmtNumber(hit.follows)),
          hit.categories.slice(0, 4).map((c) => h('span', { class: 'chip' }, c)),
        ),
      ),
      btn,
    );
  }

  async function run(reset) {
    const mine = ++token;
    if (reset) {
      offset = 0;
      marks.clear();
      mount(results, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' })));
      mount(moreWrap);
      refreshInstalled(); // równolegle z wyszukiwaniem; oznaczenia dopisują się, gdy będą gotowe
    }
    const inst = S.instanceId ? instanceById(S.instanceId) : null;
    try {
      const data = await call('modrinth:search', {
        query: S.query.trim(),
        type: S.type,
        versions: inst ? [inst.mcVersion] : state.versions.map((v) => v.id),
        loader: inst ? inst.loader : '',
        sort: S.sort,
        offset,
        limit: 20,
      });
      if (mine !== token) return;
      total = data.total;
      if (reset) mount(results);
      if (!data.hits.length && reset) {
        mount(
          results,
          h('div', { class: 'empty' }, icon('search', 36), h('h3', null, 'Nic nie znaleziono'), 'Spróbuj zmienić frazę lub filtry.'),
        );
      }
      results.append(...data.hits.map(hitItem));
      offset += data.hits.length;
      summary.textContent = `${fmtNumber(total)} wyników`;
      mount(
        moreWrap,
        offset < total
          ? h('button', { class: 'btn', onclick: () => run(false) }, 'Pokaż więcej')
          : null,
      );
    } catch (e) {
      if (mine !== token) return;
      mount(
        results,
        h('div', { class: 'empty' }, icon('alert', 36), h('h3', null, 'Nie udało się połączyć z Modrinth'), e.message),
      );
    }
  }

  paintTypes();
  page.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'Modrinth'), h('p', null, 'Przeglądaj i instaluj mody, paczki zasobów i shadery prosto do swoich instancji.')),
      summary,
    ),
    h('div', { class: 'row wrap', style: { marginBottom: '14px' } }, typeSeg, h('div', { class: 'grow' }), instSelect),
    h('div', { class: 'row', style: { marginBottom: '18px' } }, h('div', { class: 'grow' }, searchInput), sortSelect),
    results,
    moreWrap,
  );
  run(true);
  return page;
}
