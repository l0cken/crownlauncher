import { call, on } from './api.js';
import { h, icon, mount, toast, openModal } from './dom.js';
import { refreshAccounts, refreshConfig } from './state.js';

const AZURE_APPS_URL = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
const MOJANG_APPROVAL_URL = 'https://aka.ms/AppRegInfo';

const openLink = (url) => call('shell:open-external', url).catch((e) => toast(e.message, 'err'));

async function copy(text, what = 'Skopiowano.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Nie udało się skopiować do schowka.', 'err');
  }
}

/** Pole z wartością do skopiowania (np. nazwa aplikacji w kreatorze). */
function copyable(value) {
  return h(
    'button',
    { class: 'copyable', title: 'Kliknij, aby skopiować', onclick: () => copy(value, `Skopiowano: ${value}`) },
    value,
    icon('check', 13),
  );
}

// ---- logowanie ---------------------------------------------------------------------------

async function runLogin(onDone) {
  const status = h('div', { class: 'row', style: { gap: '10px', marginTop: '14px' } }, h('span', { class: 'spin' }), 'Łączenie z Microsoft…');
  const body = h('div', null, status);
  const closeLabel = h('span', null, 'Anuluj');
  const closeBtn = h('button', { class: 'btn', onclick: () => modal.close() }, closeLabel);
  let finished = false;

  const modal = openModal({
    title: 'Logowanie Microsoft',
    body,
    closable: false,
    actions: [closeBtn],
    onClose: () => {
      if (!finished) call('accounts:ms-cancel').catch(() => {});
    },
  });

  let ticker = null;
  const off = on('accounts:ms-code', ({ userCode, verificationUri, expiresIn }) => {
    const left = h('span', null);
    const deadline = Date.now() + (expiresIn || 900) * 1000;
    const tick = () => {
      const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      left.textContent = `kod ważny jeszcze ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    ticker = setInterval(tick, 1000);

    mount(
      body,
      h('p', { style: { marginTop: 0, lineHeight: 1.5 } }, 'Otworzyliśmy stronę logowania Microsoft w przeglądarce. Wpisz tam poniższy kod i zatwierdź logowanie.'),
      h('div', { class: 'code-box' }, userCode),
      h(
        'div',
        { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
        h('button', { class: 'btn sm', onclick: () => copy(userCode, 'Skopiowano kod.') }, icon('check', 14), 'Kopiuj kod'),
        h('button', { class: 'btn sm', onclick: () => openLink(verificationUri) }, icon('external', 14), 'Otwórz stronę ponownie'),
      ),
      h(
        'div',
        { class: 'row hint', style: { justifyContent: 'center', gap: '10px', marginTop: '16px' } },
        h('span', { class: 'spin', style: { borderColor: 'rgba(255,255,255,.15)', borderTopColor: 'var(--gold)' } }),
        'Czekam na zatwierdzenie…',
        left,
      ),
    );
  });

  try {
    const account = await call('accounts:ms-login');
    finished = true;
    modal.close();
    await refreshAccounts();
    toast(`Zalogowano jako ${account.username}.`);
    onDone();
  } catch (e) {
    finished = true;
    if (/anulowane/i.test(e.message) || !modal.el.isConnected) return;
    // błąd pokazujemy w oknie (bywa długi, np. o zatwierdzeniu aplikacji przez Mojang)
    mount(
      body,
      h(
        'div',
        { class: 'empty', style: { padding: '14px 8px' } },
        icon('alert', 36),
        h('h3', null, 'Nie udało się zalogować'),
        h('div', { style: { lineHeight: 1.5, userSelect: 'text' } }, e.message),
      ),
    );
    closeLabel.textContent = 'Zamknij';
  } finally {
    off();
    clearInterval(ticker);
  }
}

/** Przycisk „Zaloguj przez Microsoft”: jeśli trzeba, najpierw uruchamia kreator konfiguracji. */
export async function startMicrosoftLogin(onDone = () => {}) {
  let status;
  try {
    status = await call('accounts:ms-status');
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  if (!status.configured) {
    openMicrosoftSetup({ onConfigured: () => runLogin(onDone) });
    return;
  }
  runLogin(onDone);
}

// ---- kreator konfiguracji (jednorazowo) ------------------------------------------------------

function step(number, title, ...content) {
  return h(
    'div',
    { class: 'wiz-step' },
    h('div', { class: 'wiz-num' }, String(number)),
    h('div', { class: 'wiz-body' }, h('div', { class: 'wiz-title' }, title), ...content),
  );
}

export function openMicrosoftSetup({ onConfigured } = {}) {
  const input = h('input', { class: 'input', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: 'false' });
  const result = h('div', { class: 'hint', style: { marginTop: '8px', minHeight: '18px' } });
  const saveBtn = h('button', { class: 'btn primary', onclick: save }, icon('check', 16), 'Sprawdź i zapisz');

  async function save() {
    const id = input.value.trim();
    saveBtn.disabled = true;
    mount(result, h('span', { class: 'spin', style: { marginRight: '8px', borderColor: 'rgba(255,255,255,.15)', borderTopColor: 'var(--gold)' } }), 'Sprawdzam aplikację w Microsoft…');
    try {
      await call('accounts:ms-check', id);
      await call('config:set', { msClientId: id });
      await refreshConfig();
      modal.close();
      toast('Zapisano Client ID. Teraz zaloguj się kontem Microsoft.');
      onConfigured?.();
    } catch (e) {
      mount(result, h('span', { style: { color: 'var(--err)' } }, e.message));
      saveBtn.disabled = false;
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });

  const modal = openModal({
    title: 'Własny Client ID Microsoft (opcjonalnie)',
    wide: true,
    body: [
      h(
        'p',
        { class: 'hint', style: { marginTop: 0, lineHeight: 1.5 } },
        'Domyślnie launcher loguje kontem Microsoft bez żadnej konfiguracji. Ten kreator jest tylko dla osób, które chcą używać własnej, zarejestrowanej aplikacji Azure (darmowe, ok. 3 minut) zamiast wbudowanego logowania.',
      ),
      step(
        1,
        'Zarejestruj aplikację w Azure',
        h('button', { class: 'btn sm', onclick: () => openLink(AZURE_APPS_URL) }, icon('external', 14), 'Otwórz Azure Portal'),
        h(
          'div',
          { class: 'hint', style: { marginTop: '8px', lineHeight: 1.6 } },
          'Zaloguj się kontem Microsoft, kliknij ',
          h('b', null, 'New registration'),
          ' i ustaw: Name ',
          copyable('CrownLauncher'),
          '; Supported account types: ',
          h('b', null, '„…and personal Microsoft accounts”'),
          ' (albo „Personal Microsoft accounts only”). Redirect URI zostaw puste. Kliknij Register.',
        ),
      ),
      step(
        2,
        'Włącz publiczny klient',
        h(
          'div',
          { class: 'hint', style: { lineHeight: 1.6 } },
          'W aplikacji wejdź w ',
          h('b', null, 'Authentication'),
          ' → ',
          h('b', null, 'Settings'),
          ' (Advanced settings) → ',
          h('b', null, 'Allow public client flows = Yes'),
          ' → Save.',
        ),
      ),
      step(
        3,
        'Wklej Application (client) ID',
        h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Znajdziesz go na stronie Overview aplikacji.'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, input), saveBtn),
        result,
      ),
      step(
        4,
        'Zgłoś aplikację do Mojang',
        h(
          'div',
          { class: 'hint', style: { lineHeight: 1.6 } },
          'Od 2023 Mojang akceptuje tylko zatwierdzone aplikacje. Bez tego logowanie przejdzie przez Microsoft, ale Minecraft je odrzuci. Wypełnij formularz i poczekaj na akceptację (zwykle kilka dni roboczych). Do tego czasu używaj konta offline.',
        ),
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => openLink(MOJANG_APPROVAL_URL) }, icon('external', 14), 'Otwórz formularz Mojang'),
      ),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Zamknij')],
  });
  input.focus();
}
