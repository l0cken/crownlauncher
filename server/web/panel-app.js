// Panel administratora CrownLaunchera: klucze zaproszeń (liczba użyć, wygaśnięcie, notatka), komputery, edycja.
// Cała treść wstawiana jest przez textContent (nic z serwera nie trafia do innerHTML).
(() => {
  'use strict';
  const app = document.getElementById('app');

  // logo (.logo ma pointer-events: none, więc zdarzenia trafiają do rodzica): na jego polu bez menu kontekstowego i przeciągania
  const onLogo = (e) => [...document.querySelectorAll('.logo')].some((n) => {
    const r = n.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
  for (const type of ['contextmenu', 'dragstart']) document.addEventListener(type, (e) => { if (onLogo(e)) e.preventDefault(); });

  // ---------------------------------------------------------------- pomocnicze
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v; // CSSOM: dozwolone przy style-src 'self' (atrybut style z HTML byłby zablokowany)
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crown-Panel': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* brak treści */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || 'Błąd serwera (HTTP ' + res.status + ').');
      e.status = res.status;
      throw e;
    }
    return data;
  }

  const dtf = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
  const df = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium' });
  const fmt = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
  const fmtDay = (iso) => (iso ? df.format(new Date(iso)) : '—');

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (n === 1) return one;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
    return many;
  }

  /** „za 5 dni”, „3 godz. temu”, „przed chwilą” */
  function relative(iso) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const future = diff > 0;
    const min = Math.round(abs / 60000);
    const h = Math.round(abs / 3600000);
    const d = Math.round(abs / 86400000);
    let text;
    if (min < 1) return future ? 'za chwilę' : 'przed chwilą';
    if (min < 60) text = min + ' min';
    else if (h < 48) text = h + ' godz.';
    else text = d + ' ' + plural(d, 'dzień', 'dni', 'dni');
    return future ? 'za ' + text : text + ' temu';
  }

  function toast(message, kind) {
    let host = document.querySelector('.toasts');
    if (!host) { host = el('div', { class: 'toasts' }); document.body.append(host); }
    const t = el('div', { class: 'toast ' + (kind || 'ok') }, message);
    host.append(t);
    setTimeout(() => t.remove(), 4200);
  }

  /** Okno modalne. Zwraca { close, body }. */
  function modal(title, bodyNodes, actions) {
    const overlay = el('div', { class: 'overlay' });
    const box = el('div', { class: 'modal', role: 'dialog' }, el('h3', null, title), bodyNodes, el('footer', null, actions));
    overlay.append(box);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    return { close, box };
  }

  function confirmBox(title, message, okLabel, danger) {
    return new Promise((resolve) => {
      const ok = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, okLabel);
      const cancel = el('button', { class: 'btn' }, 'Anuluj');
      const m = modal(title, el('p', { class: 'muted', style: 'margin:0' }, message), [cancel, ok]);
      ok.addEventListener('click', () => { m.close(); resolve(true); });
      cancel.addEventListener('click', () => { m.close(); resolve(false); });
    });
  }

  /** Przełącznik z gotowych opcji: { el, get, set }. */
  function segmented(options, initial, onChange) {
    let value = initial;
    const wrap = el('div', { class: 'seg' });
    const buttons = options.map((o) => {
      const b = el('button', { type: 'button' }, o.label);
      b.addEventListener('click', () => { value = o.value; paint(); if (onChange) onChange(value); });
      return [o, b];
    });
    const paint = () => buttons.forEach(([o, b]) => b.classList.toggle('on', o.value === value));
    buttons.forEach(([, b]) => wrap.append(b));
    paint();
    return { el: wrap, get: () => value, set: (v) => { value = v; paint(); if (onChange) onChange(value); } };
  }

  const endOfDay = (yyyyMmDd) => {
    const [y, m, d] = yyyyMmDd.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).toISOString();
  };

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = 'Skopiowano ✓';
      setTimeout(() => { button.textContent = old; }, 1500);
    } catch {
      window.prompt('Skopiuj ręcznie (Ctrl+C):', text);
    }
  }

  const STATUS = {
    unused: 'Nieużyty',
    activated: 'Aktywny',
    full: 'Wykorzystany',
    expired: 'Wygasł',
    revoked: 'Unieważniony',
  };
  const usesLabel = (i) => i.uses + ' / ' + (i.maxUses === 0 ? '∞' : i.maxUses);

  // ---------------------------------------------------------------- logowanie
  function loginView(message) {
    const input = el('input', { type: 'password', placeholder: 'Klucz administratora (crown_…)', autocomplete: 'off', autofocus: true });
    const err = el('div', { class: 'err' }, message || '');
    const go = async () => {
      err.textContent = '';
      try {
        await api('POST', '/v1/admin/login', { key: input.value });
        input.value = '';
        await start();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    app.replaceChildren(el('div', { class: 'card login' },
      el('span', { class: 'logo', 'aria-hidden': 'true' }),
      el('h1', null, 'CrownLauncher — panel'),
      el('p', null, 'Zaloguj się kluczem administratora. Na komputerze, z którego wydajesz launcher, wygodniej: npm run panel (loguje bez wpisywania klucza).'),
      input, err,
      el('button', { class: 'btn primary', style: 'width:100%;margin-top:8px', onclick: go }, 'Zaloguj')));
    input.focus();
  }

  // ---------------------------------------------------------------- panel
  const state = { invites: [], info: {}, events: [], q: '', filter: 'all', open: new Set(), timer: null, created: null };
  let ui = null;

  async function load() {
    const [a, b, c] = await Promise.all([api('GET', '/v1/admin/invites'), api('GET', '/v1/admin/info'), api('GET', '/v1/admin/events')]);
    state.invites = a.invites;
    state.info = b;
    state.events = c.events;
  }

  async function start() {
    clearInterval(state.timer);
    try {
      await load();
    } catch (e) {
      if (e.status === 401) return loginView('');
      app.replaceChildren(el('p', { class: 'boot err' }, e.message));
      return;
    }
    build();
    state.timer = setInterval(async () => {
      if (document.hidden || document.querySelector('.overlay')) return;
      try { await load(); paint(); } catch { /* sesja wygasła - następna akcja pokaże logowanie */ }
    }, 20000);
  }

  /** Po akcji administratora: dane z serwera i pełne przemalowanie (także sekcji wydarzeń). */
  async function refresh() {
    await load();
    if (ui) ui.eventsSig = null;
    paint();
  }

  function build() {
    // --- formularz nowego klucza ---
    const nameInput = el('input', { type: 'text', placeholder: 'Nick gracza, np. B3rusek', maxlength: 40, autocomplete: 'off' });
    const noteInput = el('input', { type: 'text', placeholder: 'np. kolega z serwera (opcjonalnie)', maxlength: 200, autocomplete: 'off' });
    const dateInput = el('input', { type: 'date' });
    const dateRow = el('div', { class: 'date-row' }, dateInput);
    const uses = segmented(
      [{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 5, label: '5' }, { value: 10, label: '10' }, { value: 0, label: '∞' }],
      1);
    const expiry = segmented(
      [{ value: 'never', label: 'Bez limitu' }, { value: 1, label: '1 dzień' }, { value: 7, label: '7 dni' },
        { value: 30, label: '30 dni' }, { value: 90, label: '90 dni' }, { value: 'date', label: 'Data…' }],
      'never',
      (v) => dateRow.classList.toggle('show', v === 'date'));
    const profile = segmented(profileOptions(), '');
    const capes = el('input', { type: 'checkbox' });
    const noClient = el('input', { type: 'checkbox' });
    const err = el('div', { class: 'err' });
    const createBtn = el('button', { class: 'btn primary', type: 'button' }, 'Utwórz klucz');

    const create = async () => {
      err.textContent = '';
      const body = { name: nameInput.value, note: noteInput.value, maxUses: uses.get(), profile: profile.get(), capes: capes.checked, disableClient: noClient.checked };
      const ex = expiry.get();
      if (typeof ex === 'number') body.expiresInDays = ex;
      else if (ex === 'date') {
        if (!dateInput.value) { err.textContent = 'Wybierz datę wygaśnięcia.'; return; }
        body.expiresAt = endOfDay(dateInput.value);
      }
      createBtn.disabled = true;
      try {
        const r = await api('POST', '/v1/admin/invites', body);
        state.created = r;
        nameInput.value = '';
        noteInput.value = '';
        capes.checked = false;
        noClient.checked = false;
        toast('Klucz utworzony.');
        await refresh();
      } catch (e) {
        err.textContent = e.message;
      } finally {
        createBtn.disabled = false;
      }
    };
    createBtn.addEventListener('click', create);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

    // --- listy / filtry ---
    const search = el('input', { type: 'search', placeholder: 'Szukaj po nicku lub notatce…' });
    search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); paint(); });
    const filter = segmented(
      [{ value: 'all', label: 'Wszystkie' }, { value: 'unused', label: 'Nieużyte' }, { value: 'active', label: 'Aktywne' },
        { value: 'expired', label: 'Wygasłe' }, { value: 'revoked', label: 'Unieważnione' }],
      'all',
      (v) => { state.filter = v; paint(); });

    ui = {
      stats: el('div', { class: 'stats' }),
      created: el('div'),
      list: el('div', { class: 'list' }),
      count: el('span', { class: 'muted small' }),
      installer: el('span', { class: 'chip' }),
      events: el('div'),
    };

    const logout = el('button', { class: 'btn sm', onclick: async () => {
      try { await api('POST', '/v1/admin/logout'); } catch { /* i tak wylogowujemy */ }
      clearInterval(state.timer);
      state.created = null;
      loginView('');
    } }, 'Wyloguj');

    app.replaceChildren(el('div', { class: 'shell' },
      el('div', { class: 'top' },
        el('div', { class: 'brand' },
          el('span', { class: 'logo', 'aria-hidden': 'true' }),
          el('div', null, el('h1', null, 'CrownLauncher'), el('p', null, 'Klucze zaproszeń'))),
        el('div', { class: 'chips' }, ui.installer, el('span', { class: 'chip' }, state.info.name || 'admin'), logout)),
      ui.stats,
      el('div', { class: 'card' },
        el('h2', null, 'Nowy klucz'),
        el('div', { class: 'form' },
          el('div', { class: 'field' }, el('label', null, 'Gracz'), nameInput),
          el('div', { class: 'field' }, el('label', null, 'Notatka'), noteInput),
          el('div', { class: 'field' },
            el('label', null, 'Liczba użyć (komputerów)'), uses.el,
            el('div', { class: 'help' }, 'Każdy komputer, na którym klucz zostanie użyty w launcherze, zajmuje jedno użycie. ∞ = bez limitu.')),
          el('div', { class: 'field' },
            el('label', null, 'Ważny'), expiry.el, dateRow,
            el('div', { class: 'help' }, 'Po tej dacie klucz przestaje działać — także u osób, które już go aktywowały.')),
          el('div', { class: 'field full' },
            el('label', null, 'Rodzaj klucza'), profile.el,
            el('div', { class: 'help' }, 'Pełny dostęp = cały launcher. „Kod: …” = launcher ograniczony do wydarzenia (zablokowane Instancje, Serwery, Skiny i Modrinth); gracz z pełnym dostępem wpisuje taki kod w zakładce wydarzenia i nic mu nie blokuje.')),
          el('div', { class: 'field full' },
            el('label', null, 'Peleryny'),
            el('label', { style: CHECK_LABEL }, capes, 'Daj dostęp do peleryn (zakładka Skiny)'),
            el('div', { class: 'help' }, 'Bez tego gracz nie widzi sekcji „Peleryny” w launcherze i nie może wgrać własnej peleryny. Dostęp możesz włączyć i wyłączyć później (Edytuj albo przycisk przy kluczu).')),
          el('div', { class: 'field full' },
            el('label', null, 'CrownClient'),
            el('label', { style: CHECK_LABEL }, noClient, 'Pozwól wyłączyć CrownClient (Ustawienia → Launcher)'),
            el('div', { class: 'help' }, 'Domyślnie peleryny i korona CrownClient (przed nickiem) są zawsze włączone. Z tym polem gracz dostaje w Ustawieniach → Launcher przełącznik „Peleryny i korona w grze” i może je wyłączyć.'))),
        el('div', { class: 'row', style: 'margin-top:16px' }, createBtn, err)),
      ui.created,
      el('div', { class: 'card' },
        el('div', { class: 'toolbar' },
          el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Klucze'), ui.count),
          search),
        el('div', { style: 'margin-bottom:14px' }, filter.el),
        ui.list),
      ui.events));
    paint();
  }

  function paint() {
    if (!ui) return;
    const all = state.invites;
    const soon = all.filter((i) => i.expiresAt && !['revoked', 'expired'].includes(i.status) && Date.parse(i.expiresAt) - Date.now() < 7 * 86400000);
    const active = all.filter((i) => ['activated', 'full'].includes(i.status));
    const seats = all.reduce((n, i) => n + i.uses, 0);
    ui.stats.replaceChildren(
      stat(all.length, 'Wszystkie klucze', 'gold'),
      stat(active.length, 'Aktywne', 'ok'),
      stat(all.filter((i) => i.status === 'unused').length, 'Nieużyte', ''),
      stat(soon.length, 'Wygasają w 7 dni', soon.length ? 'warn' : ''));
    ui.installer.textContent = state.info.installer ? 'Instalator: ' + state.info.installer : 'Brak wgranego instalatora';

    // wynik ostatniego tworzenia (klucz widać tylko do odświeżenia strony)
    ui.created.replaceChildren();
    if (state.created) {
      const c = state.created;
      const parts = [];
      parts.push(c.maxUses === 0 ? 'bez limitu komputerów' : c.maxUses + ' ' + plural(c.maxUses, 'komputer', 'komputery', 'komputerów'));
      parts.push(c.expiresAt ? 'ważny do ' + fmtDay(c.expiresAt) : 'bez daty wygaśnięcia');
      const message =
        'Zaproszenie do CrownLaunchera (' + c.name + ')\n' +
        '1. Wejdź na ' + location.origin + '/ i wpisz klucz, aby pobrać instalator.\n' +
        '2. Zainstaluj launcher i przy pierwszym uruchomieniu wpisz ten sam klucz.\n' +
        'Klucz: ' + c.key + '\n' +
        'Klucz działa na: ' + parts.join(', ') + '. Nie podawaj go dalej.';
      const b1 = el('button', { class: 'btn primary sm' }, 'Kopiuj klucz');
      const b2 = el('button', { class: 'btn sm' }, 'Kopiuj wiadomość dla gracza');
      const b3 = el('button', { class: 'btn sm' }, 'Zamknij');
      b1.addEventListener('click', () => copy(c.key, b1));
      b2.addEventListener('click', () => copy(message, b2));
      b3.addEventListener('click', () => { state.created = null; paint(); });
      ui.created.append(el('div', { class: 'card created' },
        el('div', { class: 'muted small' }, 'Nowy klucz dla: ' + c.name + ' · ' + parts.join(' · ')),
        el('div', { class: 'key' }, c.key),
        el('div', { class: 'help' }, 'Pokazany tylko teraz — serwer zapamiętuje wyłącznie skrót. Po odświeżeniu strony nie da się go odczytać.'),
        el('div', { class: 'row', style: 'margin-top:12px' }, b1, b2, b3)));
    }

    const matches = (i) => {
      if (state.filter === 'unused' && i.status !== 'unused') return false;
      if (state.filter === 'active' && !['activated', 'full'].includes(i.status)) return false;
      if (state.filter === 'expired' && i.status !== 'expired') return false;
      if (state.filter === 'revoked' && i.status !== 'revoked') return false;
      if (state.q && !(i.name.toLowerCase().includes(state.q) || (i.note || '').toLowerCase().includes(state.q))) return false;
      return true;
    };
    const rows = all.filter(matches);
    ui.count.textContent = rows.length === all.length ? all.length + ' ' + plural(all.length, 'klucz', 'klucze', 'kluczy') + ' · ' + seats + ' użyć' : rows.length + ' z ' + all.length;
    paintEvents();
    ui.list.replaceChildren(...(rows.length ? rows.map(item) : [el('div', { class: 'empty' }, all.length ? 'Brak kluczy pasujących do filtra.' : 'Nie ma jeszcze żadnych kluczy — utwórz pierwszy powyżej.')]));
  }

  function stat(value, label, cls) {
    return el('div', { class: 'stat ' + cls }, el('div', { class: 'v' }, String(value)), el('div', { class: 'l' }, label));
  }

  function item(i) {
    const act = (label, cls, fn) => {
      const b = el('button', { class: 'btn sm ' + (cls || ''), type: 'button' }, label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await fn(); } catch (e) { if (e && e.message) toast(e.message, 'err'); } finally { b.disabled = false; }
      });
      return b;
    };
    const buttons = [];
    if (i.status !== 'revoked') buttons.push(act('Edytuj', '', async () => editDialog(i)));
    if (i.status !== 'revoked' && !i.profile) {
      // jedno kliknięcie: dostęp do peleryn (zakładka Skiny); wyłączenie zdejmuje też peleryny wgrane tym kluczem
      buttons.push(act(i.capes ? 'Wyłącz peleryny' : 'Włącz peleryny', '', async () => {
        if (i.capes) {
          const ok = await confirmBox('Wyłączyć peleryny?', 'Gracz „' + i.name + '” straci sekcję „Peleryny” w launcherze (przy najbliższym sprawdzeniu klucza, w ciągu kilku minut), a jego peleryna zniknie u innych graczy od razu.', 'Wyłącz', true);
          if (!ok) return;
        }
        await api('POST', '/v1/admin/invites/' + i.id + '/update', { capes: !i.capes });
        toast(i.capes ? 'Peleryny wyłączone.' : 'Peleryny włączone.');
        await refresh();
      }));
      // jedno kliknięcie: gracz dostaje (albo traci) przełącznik „Peleryny i korona w grze” w Ustawieniach
      buttons.push(act(i.disableClient ? 'Zabierz wyłączanie CrownClient' : 'Pozwól wyłączać CrownClient', '', async () => {
        if (i.disableClient) {
          const ok = await confirmBox('Zabrać możliwość wyłączenia CrownClient?', 'Gracz „' + i.name + '” straci przełącznik „Peleryny i korona w grze” w Ustawieniach, a peleryny i korona włączą mu się z powrotem (przy najbliższym starcie gry).', 'Zabierz', true);
          if (!ok) return;
        }
        await api('POST', '/v1/admin/invites/' + i.id + '/update', { disableClient: !i.disableClient });
        toast(i.disableClient ? 'Gracz nie może już wyłączyć CrownClient.' : 'Gracz może wyłączyć CrownClient (Ustawienia → Launcher).');
        await refresh();
      }));
    }
    if (i.uses > 0) {
      buttons.push(act((state.open.has(i.id) ? 'Ukryj' : 'Komputery') + ' (' + i.uses + ')', '', async () => {
        if (state.open.has(i.id)) state.open.delete(i.id); else state.open.add(i.id);
        paint();
      }));
    }
    if (i.status !== 'revoked') {
      buttons.push(act('Unieważnij', 'danger', async () => {
        const ok = await confirmBox('Unieważnić klucz?', 'Klucz „' + i.name + '” przestanie działać na serwerze od razu (aktualizacje, ogłoszenia, pobranie). ' + 'Launcher tej osoby zablokuje się przy najbliższym sprawdzeniu klucza: przy starcie gry albo w ciągu kilku minut ' + '(w starszych wersjach launchera do 6 godzin). Trwającej gry to nie przerywa.', 'Unieważnij', true);
        if (!ok) return;
        await api('POST', '/v1/admin/invites/' + i.id + '/revoke');
        toast('Klucz unieważniony.');
        await refresh();
      }));
    } else {
      buttons.push(act('Usuń z listy', '', async () => {
        await api('DELETE', '/v1/admin/invites/' + i.id);
        toast('Usunięto z listy.');
        await refresh();
      }));
    }

    const limited = i.maxUses > 0;
    const pct = limited ? Math.min(100, Math.round((i.uses / i.maxUses) * 100)) : 100;
    const expiryNode = i.expiresAt
      ? el('div', null,
          el('div', { class: i.status === 'expired' ? 'uses' : '' }, fmtDay(i.expiresAt)),
          el('div', { class: 'muted small' }, relative(i.expiresAt)))
      : el('div', { class: 'muted' }, 'bez limitu');
    const activity = el('div', null,
      el('div', null, i.lastSeenAt ? relative(i.lastSeenAt) : 'jeszcze nieużyty'),
      el('div', { class: 'muted small' }, 'utworzony ' + fmtDay(i.createdAt) + (i.downloads ? ' · pobrań: ' + i.downloads : '')));

    const tags = [];
    if (i.profile) tags.push(el('span', { class: 'badge event' }, eventTitle(i.profile)));
    if (i.capes && !i.profile) tags.push(el('span', { class: 'badge event' }, 'Peleryny'));
    if (i.disableClient && !i.profile) tags.push(el('span', { class: 'badge event' }, 'Może wyłączyć CrownClient'));

    const line = el('div', { class: 'line' },
      el('div', null,
        el('div', { class: 'name' }, i.name),
        // znaczki pod nazwą, w zawijanym rzędzie: długi znaczek nie wystaje poza kolumnę na sąsiedni (status)
        tags.length ? el('div', { class: 'tags' }, tags) : null,
        i.note ? el('div', { class: 'note' }, i.note) : null),
      el('div', null, el('span', { class: 'badge ' + i.status }, STATUS[i.status] || i.status)),
      el('div', null,
        el('div', { class: 'col-l' }, 'Użycia'),
        el('div', { class: 'uses' }, usesLabel(i)),
        el('div', { class: 'bar' + (limited ? '' : ' inf') }, el('i', { style: 'width:' + pct + '%' }))),
      el('div', null, el('div', { class: 'col-l' }, 'Wygasa'), expiryNode),
      el('div', null, el('div', { class: 'col-l' }, 'Aktywność'), activity),
      el('div', { class: 'acts' }, buttons));

    const box = el('div', { class: 'item ' + i.status }, line);
    if (state.open.has(i.id) && i.devices.length) {
      box.append(el('div', { class: 'devices' }, i.devices.map((d, n) => {
        const release = el('button', { class: 'btn sm', type: 'button' }, 'Zwolnij');
        release.addEventListener('click', async () => {
          const ok = await confirmBox('Zwolnić ten komputer?', 'Launcher na tym komputerze zostanie wylogowany z klucza „' + i.name + '” przy najbliższym sprawdzeniu (przy starcie gry albo w ciągu kilku minut) i poprosi o wpisanie klucza od nowa — to zajmie użycie klucza, jeśli będzie wolne. Użycie jest od razu wolne dla innego komputera. Launchery sprzed tej zmiany łączą się z kluczem ponownie same.', 'Zwolnij', true);
          if (!ok) return;
          try {
            await api('POST', '/v1/admin/invites/' + i.id + '/release', { device: d.id });
            toast('Komputer zwolniony.');
            await refresh();
          } catch (e) { toast(e.message, 'err'); }
        });
        return el('div', { class: 'dev' },
          el('div', null, 'Komputer ' + (n + 1) + ' · ', el('code', null, d.id),
            el('div', { class: 'muted small' }, 'pierwszy raz: ' + fmt(d.firstAt) + ' · ostatnio: ' + (d.lastAt ? relative(d.lastAt) : '—'))),
          release);
      })));
    }
    return box;
  }

  // ---------------------------------------------------------------- wydarzenia
  const CHECK_LABEL = 'text-transform:none;letter-spacing:0;display:flex;gap:8px;align-items:center;cursor:pointer;font-size:14px';
  const eventTitle = (id) => ((state.events.find((e) => e.id === id) || {}).title || id);
  const profileOptions = () => [{ value: '', label: 'Pełny dostęp' }, ...state.events.map((e) => ({ value: e.id, label: 'Kod: ' + e.title }))];

  const EVENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'root'];
  const EVENT_ROOT_NAMES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'];
  // jak na serwerze (autorytatywna walidacja jest tam); tutaj tylko, żeby obce pliki z folderu config liczyć jako „pominięte”
  const CONFIG_EXT = /\.(json5?|toml|properties|txt|cfg|conf|ini|ya?ml|xml|snbt|csv|mcmeta)$/i;
  const asConfig = (name) => (CONFIG_EXT.test(name) && name.split('/').length <= 4 ? { kind: 'config', name } : null);
  const EVENT_LABEL = { mods: 'Mody', resourcepacks: 'Texturepacki', shaderpacks: 'Shaderpacki', config: 'Configi', root: 'Opcje i pliki gry' };
  const eventFileCount = (ev) => EVENT_KINDS.reduce((n, k) => n + (ev[k] || []).length, 0);

  // Cloudflare przyjmuje maks. 100 MB w jednym żądaniu - większe pliki idą częściami (R2 multipart). window.__crownSingleMax /
  // __crownPartSize pozwalają testom zbić progi (nie ma ich w zwykłym użyciu).
  const singleMax = () => Number(window.__crownSingleMax) || 90 * 1024 * 1024;
  const partSize = () => Number(window.__crownPartSize) || 16 * 1024 * 1024;

  async function eventCall(method, url, body, type) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': type || 'application/octet-stream', 'X-Crown-Panel': '1' },
      body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* brak treści */ }
    return { res, data };
  }

  /** Wgrywa plik wydarzenia częściami (serwery bez tej funkcji, np. stary VPS, odpowiadają 404 - wtedy zwraca false). */
  async function uploadEventParts(url, name, file) {
    const fail = (r) => new Error(name + ': ' + ((r.data && r.data.error) || 'błąd serwera (HTTP ' + r.res.status + ')'));
    const start = await eventCall('POST', url + '&uploads');
    if (start.res.status === 404) return false;
    if (start.res.status !== 201) throw fail(start);
    const id = '&uploadId=' + encodeURIComponent(start.data.uploadId);
    const parts = [];
    try {
      for (let pos = 0, n = 1; pos < file.size; pos += partSize(), n++) {
        const chunk = file.slice(pos, pos + partSize());
        let r;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            r = await eventCall('PUT', url + id + '&part=' + n, chunk);
          } catch (e) {
            r = { res: { status: 0 }, data: { error: e.message } };
          }
          if (r.res.ok) break;
          if (attempt === 3 || (r.res.status >= 400 && r.res.status < 500)) throw fail(r);
        }
        parts.push({ partNumber: r.data.partNumber, etag: r.data.etag });
      }
      const done = await eventCall('POST', url + id, JSON.stringify({ parts }), 'application/json');
      if (!done.res.ok) throw fail(done);
    } catch (e) {
      await eventCall('DELETE', url + id).catch(() => {}); // porzucone części nie zostają w R2
      throw e;
    }
    return true;
  }

  /** Wgrywa plik wydarzenia surowym PUT-em (duże: częściami); ścieżka (także configi w podfolderach) idzie w parametrze ?path=. */
  async function uploadEventFile(eventId, kind, name, file) {
    const url = '/v1/admin/events/' + eventId + '/' + kind + '?path=' + encodeURIComponent(name);
    if (file.size > singleMax() && (await uploadEventParts(url, name, file))) return;
    const r = await eventCall('PUT', url, file);
    if (!r.res.ok) throw new Error(name + ': ' + ((r.data && r.data.error) || 'błąd serwera (HTTP ' + r.res.status + ')'));
  }

  /**
   * Gdzie trafia plik z folderu (ścieżka bez wybranego folderu): config/…, mods/x.jar, resourcepacks/x.zip,
   * shaderpacks/x, options.txt itd. w katalogu głównym. null = pomijany (np. saves/, logs/).
   */
  function classifyPath(parts) {
    const [first] = parts;
    if (parts.length === 1) return EVENT_ROOT_NAMES.includes(first) ? { kind: 'root', name: first } : null;
    if (['mods', 'resourcepacks', 'shaderpacks'].includes(first) && parts.length === 2) return { kind: first, name: parts[1] };
    if (first === 'config') return asConfig(parts.slice(1).join('/'));
    return null;
  }

  /** Pojedyncze pliki z pickera „configi / options”: pliki gry do katalogu głównego, reszta do config. */
  const classifyLoose = (name) => (EVENT_ROOT_NAMES.includes(name) ? { kind: 'root', name } : asConfig(name));

  function paintEvents() {
    if (!ui || !ui.events) return;
    // Odświeżanie w tle nie przemalowuje sekcji, gdy nic się nie zmieniło albo admin akurat coś wpisuje / wgrywa.
    const sig = JSON.stringify([state.events, state.invites.map((i) => [i.profile, i.status])]);
    if (ui.events.childNodes.length && ui.eventsSig !== null) {
      if (sig === ui.eventsSig) return;
      if (ui.events.contains(document.activeElement) || ui.uploading) return;
    }
    ui.eventsSig = sig;
    ui.events.replaceChildren(...state.events.map((ev) => {
      const title = el('input', { type: 'text', value: ev.title, maxlength: 60 });
      const mc = el('input', { type: 'text', value: ev.mcVersion || '', placeholder: 'np. 1.21.11', maxlength: 12 });
      const crown = el('input', { type: 'checkbox' });
      crown.checked = ev.crownClient !== false;
      const save = el('button', { class: 'btn sm', type: 'button' }, 'Zapisz ustawienia');
      save.addEventListener('click', async () => {
        try {
          await api('POST', '/v1/admin/events/' + ev.id, { title: title.value, mcVersion: mc.value, crownClient: crown.checked });
          toast('Zapisano ustawienia wydarzenia.');
          await refresh();
        } catch (e) { toast(e.message, 'err'); }
      });

      // --- wgrywanie: przyciski dla rodzajów plików i dla całych folderów ---
      const status = el('div', { class: 'muted small' });
      const buttons = [];
      /** items: [{ kind, name, file }]; błędy pojedynczych plików nie przerywają reszty. */
      async function uploadAll(items, skipped = 0) {
        if (!items.length) {
          toast(skipped ? 'Żaden z wybranych plików nie pasuje do wydarzenia (' + skipped + ' pominięto).' : 'Nie wybrano plików.', 'err');
          return;
        }
        buttons.forEach((b) => { b.disabled = true; });
        ui.uploading = true;
        const failures = [];
        let done = 0;
        try {
          for (const it of items) {
            status.textContent = 'Wgrywam ' + (done + failures.length + 1) + '/' + items.length + ': ' + it.name + '…';
            try {
              await uploadEventFile(ev.id, it.kind, it.name, it.file);
              done += 1;
            } catch (e) {
              failures.push(e.message);
            }
          }
        } finally {
          status.textContent = '';
          buttons.forEach((b) => { b.disabled = false; });
          ui.uploading = false;
        }
        const parts = ['Wgrano plików: ' + done + '.'];
        if (skipped) parts.push('Pominięto: ' + skipped + ' (nieobsługiwany typ albo folder).');
        if (failures.length) parts.push('Błędy (' + failures.length + '): ' + failures.slice(0, 3).join(' · ') + (failures.length > 3 ? ' …' : ''));
        toast(parts.join(' '), failures.length ? 'err' : 'ok');
        await refresh();
      }

      const picker = (label, { accept, directory = false, primary = false }, toItems) => {
        const input = el('input', { type: 'file', multiple: true, style: 'display:none' });
        if (accept) input.setAttribute('accept', accept);
        if (directory) input.setAttribute('webkitdirectory', '');
        const btn = el('button', { class: 'btn sm' + (primary ? ' primary' : ''), type: 'button' }, label);
        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', async () => {
          const files = [...input.files];
          input.value = '';
          const items = [];
          let skipped = 0;
          for (const f of files) {
            const target = toItems(f);
            if (target) items.push({ ...target, file: f });
            else skipped += 1;
          }
          await uploadAll(items, skipped);
        });
        buttons.push(btn);
        return el('span', null, btn, input);
      };

      const uploadRow = el('div', { class: 'row', style: 'margin:18px 0 6px' },
        picker('Dodaj mody (.jar)', { accept: '.jar', primary: true }, (f) => (/\.jar$/i.test(f.name) ? { kind: 'mods', name: f.name } : null)),
        picker('Dodaj texturepacki (.zip)', { accept: '.zip', primary: true }, (f) => (/\.zip$/i.test(f.name) ? { kind: 'resourcepacks', name: f.name } : null)),
        picker('Dodaj shaderpacki (.zip)', { accept: '.zip,.txt' }, (f) => (/\.(zip|txt)$/i.test(f.name) ? { kind: 'shaderpacks', name: f.name } : null)),
        picker('Dodaj configi / options…', {}, (f) => classifyLoose(f.name)),
        picker('Dodaj folder (config albo cały .minecraft)…', { directory: true }, (f) => {
          const rel = (f.webkitRelativePath || f.name).split('/');
          const top = rel[0];
          const rest = rel.slice(1);
          if (!rest.length) return classifyLoose(f.name);
          // wybrany folder „config” - wszystko w nim to configi; inaczej szukamy config/, mods/, options.txt… w środku
          return top === 'config' ? asConfig(rest.join('/')) : classifyPath(rest);
        }),
        status);

      // --- listy plików z usuwaniem i (dla configów i opcji) przełącznikiem wymuszania ---
      const fileList = (kind) => {
        const items = ev[kind] || [];
        const body = items.length ? items.map((f) => {
          const del = el('button', { class: 'btn sm danger', type: 'button' }, 'Usuń');
          del.addEventListener('click', async () => {
            const ok = await confirmBox('Usunąć plik?', 'Plik „' + f.name + '” zniknie z wydarzenia. Mody, texturepacki i shaderpacki launcher graczy usunie przy najbliższym starcie gry; configi i opcje zostają u graczy tak, jak są.', 'Usuń', true);
            if (!ok) return;
            try {
              await api('DELETE', '/v1/admin/events/' + ev.id + '/' + kind + '?path=' + encodeURIComponent(f.name));
              toast('Plik usunięty.');
              await refresh();
            } catch (e) { toast(e.message, 'err'); }
          });
          let toggle = null;
          if (typeof f.enforce === 'boolean') {
            const box = el('input', { type: 'checkbox', title: 'Wymuszaj: plik wraca do wersji z serwera przy każdym starcie gry. Bez tego gracz dostaje go raz i po każdej Twojej zmianie, a w międzyczasie może go zmieniać.' });
            box.checked = f.enforce;
            box.addEventListener('change', async () => {
              try {
                await api('POST', '/v1/admin/events/' + ev.id, { enforce: { [kind + '/' + f.name]: box.checked } });
                toast(box.checked ? 'Plik będzie wymuszany przy każdym starcie.' : 'Plik jest teraz ustawieniem startowym (gracz może go zmieniać).');
                await refresh();
              } catch (e) { toast(e.message, 'err'); box.checked = !box.checked; }
            });
            toggle = el('label', { class: 'muted small', style: 'display:flex;gap:6px;align-items:center;cursor:pointer;white-space:nowrap' }, box, 'wymuszaj');
          }
          return el('div', { class: 'dev' },
            el('div', { style: 'min-width:0;overflow-wrap:anywhere' }, f.name, el('div', { class: 'muted small' }, (f.size / 1048576 >= 0.1 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'))),
            el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, toggle, del));
        }) : el('div', { class: 'muted small' }, 'Brak plików.');
        return el('div', { style: 'flex:1;min-width:280px' },
          el('div', { class: 'muted small', style: 'margin-bottom:6px;font-weight:700' }, EVENT_LABEL[kind] + ' (' + items.length + ')'),
          el('div', { style: 'max-height:340px;overflow:auto' }, body));
      };

      const keys = state.invites.filter((i) => i.profile === ev.id && i.status !== 'revoked');
      const ready = ev.mcVersion && eventFileCount(ev) > 0;
      return el('div', { class: 'card' },
        el('div', { class: 'toolbar' },
          el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Wydarzenie: ' + ev.title),
            el('span', { class: 'badge ' + (ready ? 'activated' : 'unused') }, ready ? 'Gotowe' : 'Do przygotowania'),
            el('span', { class: 'muted small' }, keys.length + ' ' + plural(keys.length, 'aktywny kod', 'aktywne kody', 'aktywnych kodów')))),
        el('p', { class: 'muted small', style: 'margin:0 0 14px' },
          'Mody, texturepacki i shaderpacki to zamknięty zestaw — launcher gracza przy każdym starcie usuwa wszystko spoza listy. ' +
          'Configi i opcje: „wymuszaj” = wracają do Twojej wersji przy każdym starcie; bez tego (domyślnie options.txt) gracz dostaje plik raz i po każdej Twojej zmianie, a w międzyczasie może go zmieniać. ' +
          'Foldery mods, resourcepacks, shaderpacks, config i downloads są u gracza ukryte w Eksploratorze.'),
        el('div', { class: 'form' },
          el('div', { class: 'field' }, el('label', null, 'Nazwa'), title),
          el('div', { class: 'field' }, el('label', null, 'Wersja Minecrafta (Fabric)'), mc),
          el('div', { class: 'field full' },
            el('label', { style: 'text-transform:none;letter-spacing:0;display:flex;gap:8px;align-items:center;cursor:pointer;font-size:14px' }, crown, 'Dołącz CrownClienta (korona przed nickiem)'),
            el('div', { class: 'row', style: 'margin-top:10px' }, save))),
        uploadRow,
        el('div', { class: 'muted small', style: 'margin:0 0 12px' }, 'Folder: wybierz „config” (wszystko w nim to configi) albo cały .minecraft / folder instancji — trafią tylko config/, mods/, resourcepacks/, shaderpacks/ i options.txt, servers.dat; reszta jest pomijana.'),
        el('div', { class: 'row', style: 'align-items:flex-start;gap:18px' }, EVENT_KINDS.map(fileList)));
    }));
  }

  // ---------------------------------------------------------------- edycja klucza
  function editDialog(i) {
    const name = el('input', { type: 'text', value: i.name, maxlength: 40 });
    const note = el('input', { type: 'text', value: i.note || '', maxlength: 200 });
    const unlimited = i.maxUses === 0;
    const uses = el('input', { type: 'number', min: 1, max: 1000, value: unlimited ? 1 : i.maxUses });
    const inf = el('input', { type: 'checkbox' });
    inf.checked = unlimited;
    const syncInf = () => { uses.disabled = inf.checked; };
    inf.addEventListener('change', syncInf);
    syncInf();
    const dateInput = el('input', { type: 'date' });
    const dateRow = el('div', { class: 'date-row' }, dateInput);
    const expiry = segmented(
      [{ value: 'keep', label: 'Bez zmian' }, { value: 'never', label: 'Bez limitu' }, { value: 7, label: '+7 dni' },
        { value: 30, label: '+30 dni' }, { value: 'date', label: 'Data…' }],
      'keep',
      (v) => dateRow.classList.toggle('show', v === 'date'));
    const profile = segmented(profileOptions(), i.profile || '');
    const capes = el('input', { type: 'checkbox' });
    capes.checked = Boolean(i.capes);
    const noClient = el('input', { type: 'checkbox' });
    noClient.checked = Boolean(i.disableClient);
    const err = el('div', { class: 'err' });
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Zapisz');
    const cancel = el('button', { class: 'btn', type: 'button' }, 'Anuluj');

    const body = el('div', null,
      el('div', { class: 'field' }, el('label', null, 'Gracz'), name),
      el('div', { class: 'field' }, el('label', null, 'Notatka'), note),
      el('div', { class: 'field' },
        el('label', null, 'Liczba użyć (komputerów)'),
        el('div', { class: 'row' }, el('div', { style: 'width:110px' }, uses), el('label', { style: 'margin:0;text-transform:none;letter-spacing:0;display:flex;gap:7px;align-items:center;cursor:pointer' }, inf, 'bez limitu')),
        el('div', { class: 'help' }, 'Zajęte teraz: ' + i.uses + '. Zmniejszenie limitu nie wyrzuca komputerów, które już używają klucza.')),
      el('div', { class: 'field' },
        el('label', null, 'Wygasa'),
        el('div', { class: 'muted small', style: 'margin-bottom:8px' }, i.expiresAt ? 'Teraz: ' + fmt(i.expiresAt) + ' (' + relative(i.expiresAt) + ')' : 'Teraz: bez limitu'),
        expiry.el, dateRow),
      el('div', { class: 'field' }, el('label', null, 'Rodzaj klucza'), profile.el),
      el('div', { class: 'field' },
        el('label', null, 'Peleryny'),
        el('label', { style: CHECK_LABEL }, capes, 'Dostęp do peleryn (zakładka Skiny)'),
        el('div', { class: 'help' }, 'Wyłączenie zdejmuje też peleryny wgrane tym kluczem.')),
      el('div', { class: 'field' },
        el('label', null, 'CrownClient'),
        el('label', { style: CHECK_LABEL }, noClient, 'Pozwól wyłączyć CrownClient (Ustawienia → Launcher)'),
        el('div', { class: 'help' }, 'Gracz dostaje w Ustawieniach przełącznik „Peleryny i korona w grze”. Odebranie dostępu włącza je z powrotem.')),
      err);
    const m = modal('Edytuj klucz', body, [cancel, save]);
    cancel.addEventListener('click', m.close);
    save.addEventListener('click', async () => {
      err.textContent = '';
      const payload = { name: name.value, note: note.value, maxUses: inf.checked ? 0 : Number(uses.value), profile: profile.get(), capes: capes.checked, disableClient: noClient.checked };
      const ex = expiry.get();
      if (ex === 'never') payload.expiresAt = null;
      else if (typeof ex === 'number') payload.expiresInDays = ex;
      else if (ex === 'date') {
        if (!dateInput.value) { err.textContent = 'Wybierz datę wygaśnięcia.'; return; }
        payload.expiresAt = endOfDay(dateInput.value);
      }
      save.disabled = true;
      try {
        await api('POST', '/v1/admin/invites/' + i.id + '/update', payload);
        m.close();
        toast('Zapisano zmiany.');
        await refresh();
      } catch (e) {
        err.textContent = e.message;
        save.disabled = false;
      }
    });
    name.focus();
  }

  // ---------------------------------------------------------------- start: bilet z „npm run panel” albo sesja z ciasteczka
  (async () => {
    const ticket = new URLSearchParams(location.search).get('ticket');
    if (ticket) {
      history.replaceState(null, '', '/admin');
      try {
        await api('POST', '/v1/admin/exchange', { ticket });
      } catch {
        return loginView('Bilet wygasł albo został już użyty — zaloguj się kluczem.');
      }
    }
    start();
  })();
})();
