import { call, on } from '../api.js';
import { h, icon, mount, toast } from '../dom.js';
import { state, live, onLeave } from '../state.js';

/**
 * Zakładka „IGRZYSKA ŚMIERCI”: zamknięty zestaw plików z serwera.
 *  - bez kodu: pole na kod wydarzenia (gracz z pełnym dostępem wpisuje go tu i nic mu nie blokuje),
 *  - z kodem: „Zagraj” i „Sprawdź pliki”. Zawartości zestawu (nazw modów, paczek, configów) gracz tu nie widzi -
 *    launcher przy każdym starcie przywraca dokładnie pliki z serwera.
 */
export function renderEvent() {
  const page = h('div', { class: 'page' });
  let st = null;
  let busy = null; // { text, percent }

  const off = on('event:progress', (p) => {
    if (p.stage === 'download' && p.total) busy = { text: 'Pobieram pliki wydarzenia…', percent: Math.round((p.current / p.total) * 100) };
    else if (p.stage === 'manifest') busy = { text: 'Sprawdzam pliki na serwerze…', percent: 0 };
    paintBody();
  });
  onLeave(off);

  async function load() {
    try {
      st = await call('event:state');
    } catch (e) {
      st = { available: false, error: e.message };
    }
    paintBody();
  }

  const body = h('div');
  page.append(body);

  const running = () => ['running', 'installing'].includes(state.states[st?.instanceId]);

  async function unlock(input, btn) {
    btn.disabled = true;
    try {
      await call('event:redeem', input.value);
      toast('Kod przyjęty — Igrzyska śmierci odblokowane.');
      await load();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  }

  async function play() {
    busy = { text: 'Przygotowuję pliki…', percent: 0 };
    paintBody();
    try {
      await call('event:sync');
      busy = null;
      paintBody();
      await call('instances:launch', st.instanceId);
      toast('Uruchamiam Igrzyska śmierci…');
    } catch (e) {
      busy = null;
      toast(e.message, 'err');
      await load();
    }
  }

  async function checkFiles() {
    busy = { text: 'Sprawdzam pliki…', percent: 0 };
    paintBody();
    try {
      await call('event:sync');
      toast('Pliki zgadzają się z serwerem.');
    } catch (e) {
      toast(e.message, 'err');
    }
    busy = null;
    await load();
  }

  function paintBody() {
    if (!st) {
      mount(body, h('div', { class: 'hint' }, 'Wczytuję…'));
      return;
    }
    const title = st.title || 'IGRZYSKA ŚMIERCI';

    if (!st.available) {
      mount(body, h('div', { class: 'card', style: { padding: '24px' } }, h('h2', null, title), h('p', { class: 'hint' }, st.error || 'Wydarzenie jest teraz niedostępne.')));
      return;
    }

    if (!st.hasAccess) {
      const input = h('input', { class: 'input', placeholder: 'CROWN-XXXX-XXXX-XXXX-XXXX', maxlength: 40, spellcheck: false, autocomplete: 'off', style: { textAlign: 'center', letterSpacing: '1px' } });
      const btn = h('button', { class: 'btn primary', style: { width: '100%', marginTop: '12px', fontWeight: '800' } }, icon('lock', 16), 'Odblokuj');
      btn.onclick = () => unlock(input, btn);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') unlock(input, btn);
      });
      mount(
        body,
        h(
          'div',
          { class: 'card', style: { maxWidth: '520px', margin: '40px auto', padding: '30px', textAlign: 'center' } },
          h('div', { style: { fontSize: '40px', marginBottom: '6px' } }, '💀'),
          h('h1', { style: { margin: '0 0 6px', fontSize: '26px' } }, title),
          h('p', { style: { margin: '0 0 18px', color: 'var(--muted)', lineHeight: 1.5 } }, 'Aby dołączyć do wydarzenia, wpisz kod od organizatora.'),
          input,
          btn,
        ),
      );
      input.focus();
      return;
    }

    const ready = st.ready && st.mcVersion && st.files > 0;
    const playBtn = running()
      ? h('button', { class: 'btn danger', onclick: () => call('instances:stop', st.instanceId).catch((e) => toast(e.message, 'err')) }, icon('stop', 16), 'Zatrzymaj')
      : h('button', { class: 'btn primary', style: { fontWeight: '800' }, disabled: !ready || Boolean(busy), onclick: play }, icon('play', 16), 'Zagraj');

    mount(
      body,
      h(
        'div',
        { class: 'row', style: { alignItems: 'center', marginBottom: '16px', gap: '14px', flexWrap: 'wrap' } },
        h(
          'div',
          { class: 'grow' },
          h('h1', { style: { margin: 0, fontSize: '26px' } }, title),
          h(
            'div',
            { class: 'row', style: { gap: '8px', marginTop: '6px' } },
            st.mcVersion ? h('span', { class: 'chip gold' }, `Minecraft ${st.mcVersion}`) : null,
            h('span', { class: 'chip' }, 'Fabric'),
            h('span', { class: 'chip ok' }, st.via === 'primary' ? 'Dostęp: kod wydarzenia' : 'Kod wpisany'),
          ),
        ),
        h('button', { class: 'btn', disabled: Boolean(busy) || running(), onclick: checkFiles, title: 'Porównaj pliki z serwerem i przywróć brakujące' }, icon('refresh', 16), 'Sprawdź pliki'),
        playBtn,
      ),
      busy
        ? h(
            'div',
            { class: 'card', style: { padding: '14px 16px', marginBottom: '14px' } },
            h('div', { style: { fontWeight: 700, marginBottom: '8px' } }, busy.text),
            h('div', { class: 'update-bar' }, h('div', { class: 'update-fill', style: { width: `${busy.percent}%` } })),
          )
        : null,
      st.error ? h('div', { class: 'card', style: { padding: '14px 16px', marginBottom: '14px', borderColor: 'var(--err)', color: 'var(--err)' } }, st.error) : null,
      !ready && !st.error
        ? h('div', { class: 'card', style: { padding: '14px 16px', marginBottom: '14px' } }, 'Organizator jeszcze nie przygotował plików wydarzenia. Zajrzyj tu później.')
        : null,
      h(
        'div',
        { class: 'card', style: { padding: '14px 16px', marginBottom: '14px', display: 'flex', gap: '12px', alignItems: 'center' } },
        icon('lock', 18),
        h('div', { class: 'hint', style: { lineHeight: 1.5 } }, 'Pliki wydarzenia są zablokowane i przywracane przy każdym starcie gry — nie da się ich zmienić.'),
      ),
    );
  }

  live(() => {
    if (st) paintBody();
  });
  load();
  return page;
}
