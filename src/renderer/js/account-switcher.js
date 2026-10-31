import { call } from './api.js';
import { h, icon, mount, toast, openModal, confirmModal } from './dom.js';
import { state, refreshAccounts } from './state.js';
import { avatar } from './components.js';
import { startMicrosoftLogin } from './ms-login.js';

/**
 * Przełącznik kont w launcherze: lista zapisanych kont (offline i Microsoft), przełączanie jednym kliknięciem,
 * dodawanie konta Microsoft (kod urządzenia, bez rejestracji w Azure) i konta offline, usuwanie.
 * Wybrane konto jest używane przy następnym uruchomieniu gry.
 */
export function openAccountSwitcher() {
  const list = h('div', { class: 'list', style: { gap: '8px' } });
  const hint = h('div', { class: 'hint', style: { marginTop: '12px' } });
  const nick = h('input', {
    class: 'input',
    placeholder: 'Nick konta offline (3–16 znaków)',
    maxlength: 16,
    onkeydown: (e) => {
      if (e.key === 'Enter') addOffline();
    },
  });

  const running = () => Object.values(state.states || {}).includes('running');

  async function switchTo(account) {
    try {
      await call('accounts:select', account.id);
      await refreshAccounts();
      paint();
      toast(`Teraz grasz jako ${account.username}.`);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function addOffline() {
    try {
      await call('accounts:add-offline', nick.value);
      nick.value = '';
      await refreshAccounts();
      paint();
      toast('Dodano konto offline.');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function removeAccount(account) {
    const ok = await confirmModal({
      title: 'Usuń konto',
      message: `Usunąć konto ${account.username} z launchera?`,
      confirmLabel: 'Usuń',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('accounts:remove', account.id);
      await refreshAccounts();
      paint();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function paint() {
    mount(
      list,
      state.accounts.length
        ? state.accounts.map((a) => {
            const active = a.id === state.selectedAccount;
            return h(
              'div',
              {
                class: `acct-row${active ? ' sel' : ''}`,
                style: { cursor: active ? 'default' : 'pointer' },
                onclick: () => {
                  if (!active) switchTo(a);
                },
              },
              avatar(a, 36),
              h(
                'div',
                { class: 'grow' },
                h('div', { style: { fontWeight: 700 } }, a.username),
                h('div', { class: 'hint' }, a.type === 'microsoft' ? 'Konto Microsoft (premium)' : 'Konto offline'),
              ),
              active
                ? h('span', { class: 'chip gold' }, icon('check', 12), 'Aktywne')
                : h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); switchTo(a); } }, 'Przełącz'),
              h(
                'button',
                {
                  class: 'btn icon ghost sm',
                  title: 'Usuń konto',
                  onclick: (e) => {
                    e.stopPropagation();
                    removeAccount(a);
                  },
                },
                icon('trash', 16),
              ),
            );
          })
        : h('div', { class: 'hint' }, 'Brak kont. Zaloguj się kontem Microsoft albo dodaj konto offline.'),
    );
    hint.textContent = running()
      ? 'Uruchomiona gra zostaje przy starym koncie — zmiana zadziała od następnego uruchomienia.'
      : 'Wybrane konto zostanie użyte przy następnym uruchomieniu gry.';
  }
  paint();

  const modal = openModal({
    title: 'Konta',
    body: [
      list,
      hint,
      h('div', { class: 'divider' }),
      h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Dodaj konto offline'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, nick), h('button', { class: 'btn', onclick: addOffline }, icon('plus', 16), 'Dodaj')),
    ],
    actions: [
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            startMicrosoftLogin(() => {
              paint();
            }),
        },
        icon('user', 16),
        'Zaloguj przez Microsoft',
      ),
      h('button', { class: 'btn', onclick: () => modal.close() }, 'Zamknij'),
    ],
  });
  return modal;
}
