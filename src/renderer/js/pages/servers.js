import { call } from '../api.js';
import { h, icon, mount, toast, openModal, confirmModal } from '../dom.js';
import { state, instanceById, refreshServers, live, notify } from '../state.js';
import { pickInstance, openCreateInstance, tile } from '../components.js';

const rerender = () => window.dispatchEvent(new Event('crown-rerender'));

// "Paper 1.21.4", "1.21.4" itp. -> ["1.21.4"]
function versionTokens(name) {
  return String(name || '').match(/\d+\.\d+(?:\.\d+)?/g) || [];
}

function matchingInstances(status) {
  if (!status?.online || !status.version) return [];
  const tokens = versionTokens(status.version);
  // "1.21" oznacza całą rodzinę 1.21.x, dokładne "1.21.4" tylko tę wersję
  return state.instances.filter((i) => tokens.some((t) => i.mcVersion === t || i.mcVersion.startsWith(`${t}.`)));
}

/** Instancja, której użyjemy do dołączenia: przypisana ręcznie albo jedyna pasująca wersją. */
function resolveInstance(server, status) {
  const assigned = server.instanceId ? instanceById(server.instanceId) : null;
  if (assigned) return assigned;
  const matches = matchingInstances(status);
  return matches.length === 1 ? matches[0] : null;
}

async function launchWith(inst, server) {
  if (state.states[inst.id]) {
    toast(`Instancja „${inst.name}” jest już uruchomiona lub w trakcie przygotowania.`, 'err');
    return;
  }
  state.states[inst.id] = 'installing';
  state.progress[inst.id] = null;
  notify();
  try {
    await call('instances:launch', inst.id, { server: server.address });
    toast(`Uruchamiam „${inst.name}” i dołączam do ${server.name}…`);
  } catch (e) {
    delete state.states[inst.id];
    notify();
    toast(e.message, 'err');
  }
}

/** Szybkie dołączanie: uruchamia instancję i od razu łączy z serwerem. */
export async function joinServer(server, status) {
  if (!state.instances.length) {
    toast('Najpierw utwórz instancję, w której chcesz zagrać.', 'err');
    openCreateInstance();
    return;
  }
  const inst = resolveInstance(server, status);
  if (inst) return launchWith(inst, server);

  const hint = status?.online && status.version ? ` (serwer: ${status.version})` : '';
  pickInstance({
    title: `Dołącz do „${server.name}”${hint}`,
    onPick: async (picked) => {
      try {
        await call('servers:update', server.id, { instanceId: picked.id });
        server.instanceId = picked.id;
        refreshServers();
      } catch {
        /* zapamiętanie wyboru jest opcjonalne */
      }
      launchWith(picked, server);
    },
  });
}

// ---- wiersz serwera ------------------------------------------------------

export function serverRow(server, { compact = false } = {}) {
  let status = null;
  const pic = h('div', { class: 'pic' }, icon('server', 22));
  const motd = h('div', { class: 'desc one' }, 'Sprawdzam serwer…');
  const tags = h('div', { class: 'tags' });
  const joinLabel = h('span', { class: 'plabel' });
  const joinBtn = h(
    'button',
    { class: 'btn primary sm', onclick: () => joinServer(server, status) },
    joinLabel,
  );

  const renderJoin = () => {
    const inst = resolveInstance(server, status);
    const st = inst ? state.states[inst.id] : null;
    joinBtn.disabled = Boolean(st);
    if (st === 'installing') {
      const p = state.progress[inst.id];
      const pct = p?.total ? ` ${Math.round((p.current / p.total) * 100)}%` : '…';
      mount(joinLabel, h('span', { class: 'spin' }), `Przygotowanie${pct}`);
    } else if (st === 'running') {
      mount(joinLabel, 'W grze');
    } else {
      mount(joinLabel, icon('zap', 15), 'Dołącz');
    }
  };

  const paint = () => {
    const inst = resolveInstance(server, status);
    const chips = [];
    if (!status) {
      chips.push(h('span', { class: 'chip' }, h('span', { class: 'spin', style: { width: '11px', height: '11px' } }), 'Sprawdzam'));
    } else if (status.online) {
      chips.push(
        h('span', { class: 'chip ok' }, `${status.players.online}/${status.players.max} graczy`),
        h('span', { class: 'chip' }, `${status.latency} ms`),
        status.version ? h('span', { class: 'chip' }, status.version) : null,
      );
      mount(motd, status.motd || 'Brak opisu serwera');
      motd.title = status.players.sample.length ? `Online: ${status.players.sample.join(', ')}` : '';
      if (status.favicon) {
        const img = h('img', { class: 'pic fav', src: status.favicon, alt: '' });
        pic.replaceWith(img);
      }
    } else {
      chips.push(h('span', { class: 'chip bad' }, 'Offline'));
      mount(motd, status.error || 'Nie udało się połączyć');
    }
    chips.push(
      inst
        ? h('span', { class: 'chip gold' }, `Instancja: ${inst.name}`)
        : status?.online && !compact
          ? h('span', { class: 'chip' }, 'Wybierz instancję przy dołączaniu')
          : null,
    );
    if (server.pinned) chips.unshift(h('span', { class: 'chip gold', title: 'Serwer przypięty przez launcher - zawsze na górze, nie można go usunąć' }, icon('lock', 11), 'Przypięty'));
    mount(tags, chips);
    renderJoin();
  };

  async function check() {
    status = null;
    paint();
    try {
      status = await call('servers:ping', server.address);
    } catch (e) {
      status = { online: false, error: e.message };
    }
    paint();
  }

  const actions = [joinBtn];
  if (!compact) {
    actions.push(
      h('button', { class: 'btn icon ghost sm', title: 'Edytuj', onclick: () => openServerModal(server) }, icon('edit', 16)),
    );
    // przypiętego serwera nie da się usunąć - przycisku po prostu nie ma
    if (!server.pinned) {
      actions.push(
        h(
          'button',
          {
            class: 'btn icon ghost sm',
            title: 'Usuń',
            onclick: async () => {
              const ok = await confirmModal({
                title: 'Usuń serwer',
                message: `Usunąć „${server.name}” z listy?`,
                confirmLabel: 'Usuń',
                danger: true,
              });
              if (!ok) return;
              try {
                await call('servers:remove', server.id);
                await refreshServers();
                rerender();
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          },
          icon('trash', 16),
        ),
      );
    }
  }

  const row = h(
    'div',
    { class: 'card item' },
    pic,
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'ttl' }, server.name, h('small', null, server.address)),
      motd,
      tags,
    ),
    h('div', { class: 'row', style: { gap: '6px' } }, actions),
  );

  live(renderJoin);
  check();
  return row;
}

// ---- dodawanie / edycja --------------------------------------------------

export function openServerModal(server = null) {
  const locked = Boolean(server?.pinned); // przypięty: nazwa i adres są narzucone przez launcher
  const form = {
    name: server?.name || '',
    address: server?.address || '',
    instanceId: server?.instanceId || '',
  };
  const saveBtn = h('button', { class: 'btn primary', onclick: submit }, server ? 'Zapisz' : 'Dodaj serwer');

  async function submit() {
    saveBtn.disabled = true;
    try {
      if (server) await call('servers:update', server.id, locked ? { instanceId: form.instanceId } : form);
      else await call('servers:add', form);
      modal.close();
      await refreshServers();
      toast(server ? 'Zapisano serwer.' : 'Dodano serwer.');
      rerender();
    } catch (e) {
      toast(e.message, 'err');
      saveBtn.disabled = false;
    }
  }

  const addressInput = h('input', {
    class: 'input',
    placeholder: 'np. mc.example.com lub mc.example.com:25570',
    value: form.address,
    disabled: locked,
    oninput: (e) => (form.address = e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter') submit();
    },
  });

  const modal = openModal({
    title: server ? 'Edytuj serwer' : 'Dodaj serwer',
    body: [
      locked
        ? h('p', { class: 'hint', style: { marginTop: 0 } }, icon('lock', 13), ' Ten serwer jest przypięty przez launcher: zawsze jest na górze listy i nie można go usunąć ani zmienić jego adresu. Możesz wybrać tylko instancję do dołączania.')
        : null,
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Adres serwera'),
        addressInput,
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Nazwa (opcjonalnie)'),
        h('input', {
          class: 'input',
          placeholder: 'Domyślnie adres serwera',
          value: form.name,
          maxlength: 40,
          disabled: locked,
          oninput: (e) => (form.name = e.target.value),
        }),
      ),
      h(
        'div',
        { class: 'field', style: { marginBottom: 0 } },
        h('label', null, 'Instancja do dołączania'),
        h(
          'select',
          { class: 'select', value: form.instanceId, onchange: (e) => (form.instanceId = e.target.value) },
          h('option', { value: '' }, 'Wybierz automatycznie (według wersji serwera)'),
          state.instances.map((i) => h('option', { value: i.id }, `${i.name} — ${i.mcVersion}`)),
        ),
        h('div', { class: 'hint' }, 'Przycisk „Dołącz” uruchomi tę instancję i od razu połączy z serwerem.'),
      ),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), saveBtn],
  });
  addressInput.focus();
}

// ---- import z instancji ---------------------------------------------------

function plural(n, one, few, many) {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

export async function openImportServers() {
  const body = h('div', null, h('div', { class: 'skeleton' }));
  const actions = [];
  const modal = openModal({ title: 'Importuj serwery z instancji', body, actions });

  async function doImport(ids) {
    try {
      const r = await call('servers:import', ids);
      modal.close();
      await refreshServers();
      const parts = [];
      if (r.added) parts.push(`Dodano ${r.added} ${plural(r.added, 'serwer', 'serwery', 'serwerów')}`);
      if (r.duplicates) parts.push(`${r.duplicates} już ${plural(r.duplicates, 'był', 'były', 'było')} na liście`);
      if (r.invalid) parts.push(`${r.invalid} z niepoprawnym adresem pominięto`);
      toast(parts.length ? `${parts.join(', ')}.` : 'Nie znaleziono serwerów do zaimportowania.', r.added ? 'ok' : 'err');
      rerender();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  let found = [];
  try {
    found = await call('servers:scan');
  } catch (e) {
    mount(body, h('div', { class: 'empty' }, icon('alert', 32), h('h3', null, 'Nie udało się przeszukać instancji'), e.message));
    return;
  }

  if (!found.length) {
    mount(
      body,
      h(
        'div',
        { class: 'empty' },
        icon('server', 40),
        h('h3', null, 'Brak serwerów do zaimportowania'),
        h('div', null, 'Żadna instancja nie ma jeszcze zapisanych serwerów. Plik servers.dat powstaje, gdy dodasz serwer w grze (Multiplayer → Dodaj serwer).'),
      ),
    );
    return;
  }

  mount(
    body,
    h('p', { class: 'hint', style: { marginTop: 0 } }, 'Wybierz instancję. Zaimportowane serwery zostaną przypisane do niej, więc „Dołącz” uruchomi właściwą wersję z modami.'),
    h(
      'div',
      { class: 'list' },
      found.map((f) => {
        const inst = instanceById(f.instanceId);
        return h(
          'div',
          { class: 'card item' },
          inst ? tile(inst) : null,
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'ttl' }, f.name, h('small', null, f.mcVersion)),
            h('div', { class: 'desc' }, `${f.count} ${plural(f.count, 'zapisany serwer', 'zapisane serwery', 'zapisanych serwerów')}`),
          ),
          h('button', { class: 'btn primary sm', onclick: () => doImport([f.instanceId]) }, icon('download', 15), 'Importuj'),
        );
      }),
    ),
  );
  if (found.length > 1) {
    mount(
      modal.el.querySelector('footer') || modal.el.appendChild(h('footer')),
      h(
        'button',
        { class: 'btn', onclick: () => doImport(found.map((f) => f.instanceId)) },
        'Importuj ze wszystkich instancji',
      ),
    );
  }
}

// ---- strona ----------------------------------------------------------------

export function renderServers() {
  const page = h('div', { class: 'page' });
  page.append(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', null, 'Serwery'),
        h('p', null, 'Zapisane serwery ze statusem na żywo. „Dołącz” uruchamia instancję i od razu wchodzi na serwer.'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onclick: rerender, title: 'Odśwież status serwerów' }, icon('refresh', 16)),
        h('button', { class: 'btn', onclick: openImportServers }, icon('download', 16), 'Importuj z instancji'),
        h('button', { class: 'btn primary', onclick: () => openServerModal() }, icon('plus', 16), 'Dodaj serwer'),
      ),
    ),
  );

  if (!state.servers.length) {
    page.append(
      h(
        'div',
        { class: 'empty' },
        icon('server', 44),
        h('h3', null, 'Nie masz jeszcze zapisanych serwerów'),
        h('div', { style: { marginBottom: '16px' } }, 'Dodaj adres serwera, a CrownLauncher pokaże jego status i pozwoli wejść jednym kliknięciem.'),
        h(
          'div',
          { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn', onclick: openImportServers }, icon('download', 16), 'Importuj z instancji'),
          h('button', { class: 'btn primary', onclick: () => openServerModal() }, icon('plus', 16), 'Dodaj pierwszy serwer'),
        ),
      ),
    );
    return page;
  }

  page.append(h('div', { class: 'list' }, state.servers.map((s) => serverRow(s))));
  return page;
}
