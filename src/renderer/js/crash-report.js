import { call } from './api.js';
import { h, icon, openModal, toast } from './dom.js';

/**
 * Wynik analizy awarii (crash-analyzer.js) i automatycznej naprawy (crash-fixer.js).
 * `data`: { summary, suspects: [{ id, name, file, version, reason }], cause, code,
 *           fixed: [{ action: 'disabled'|'updated'|'installed', id, name, file, note, requiredBy }] }
 */

const FIX_LABEL = { disabled: 'Wyłączony', updated: 'Zaktualizowany', installed: 'Doinstalowany' };

function row(pic, title, version, text, ...actions) {
  return h(
    'div',
    { class: 'card item', style: { marginBottom: '8px' } },
    h('div', { class: 'pic' }, icon(pic, 20)),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'ttl' }, title, version ? h('small', null, version) : null),
      h('div', { class: 'desc', style: { whiteSpace: 'normal' } }, text),
    ),
    ...actions,
  );
}

/** Wiersz naprawy wykonanej przez launcher; wyłączenie można cofnąć jednym kliknięciem. */
function fixRow(instanceId, f, onChanged) {
  const text = f.action === 'disabled'
    ? `${FIX_LABEL.disabled}: ${f.note || 'psuł start gry'}`
    : `${FIX_LABEL[f.action]}: ${f.note}${f.requiredBy ? ` (wymaga go ${f.requiredBy})` : ''}`;
  let undo = null;
  if (f.action === 'disabled' && f.file) {
    undo = h(
      'button',
      {
        class: 'btn sm',
        title: 'Włącza mod z powrotem (gra może się znowu wysypać)',
        onclick: async () => {
          undo.disabled = true;
          try {
            await call('content:toggle', instanceId, 'mod', `${f.file}.disabled`);
            toast(`Włączono „${f.name}” z powrotem.`);
            onChanged?.();
          } catch (e) {
            toast(e.message, 'err');
            undo.disabled = false;
          }
        },
      },
      'Cofnij',
    );
  }
  return row('check', f.name, '', text, undo);
}

// instancja wydarzenia jest zablokowana: nie zmieniamy jej modów (launcher przywraca pliki z serwera)
const isEventInstance = (id) => String(id).startsWith('event-');

/** Wiersz podejrzanego, którego launcher nie naprawił sam (np. słabe wskazanie) - ręczne wyłączenie. */
function suspectRow(instanceId, s, onChanged) {
  const btn = s.file && !isEventInstance(instanceId)
    ? h(
        'button',
        {
          class: 'btn sm primary',
          title: 'Wyłącza plik moda (można go potem włączyć w zakładce Mody)',
          onclick: async () => {
            btn.disabled = true;
            try {
              await call('content:toggle', instanceId, 'mod', s.file);
              toast(`Wyłączono „${s.name}”. Możesz włączyć go ponownie w zakładce Mody.`);
              onChanged?.();
            } catch (e) {
              toast(e.message, 'err');
              btn.disabled = false;
            }
          },
        },
        'Wyłącz ten mod',
      )
    : null;
  return row('alert', s.name, s.version, s.reason, btn);
}

/** Zawartość: co naprawiono, co dalej podejrzane (albo przyczyna spoza modów). */
export function crashBody(instanceId, data, onChanged) {
  // instancja wydarzenia: bez wskazywania modów i bez przycisków - gracz nie widzi składu zestawu
  if (isEventInstance(instanceId)) {
    return [h('p', { style: { margin: 0, lineHeight: 1.5 } }, 'Gra zakończyła się błędem. Użyj „Sprawdź pliki” w zakładce wydarzenia i uruchom ją ponownie. Jeśli problem wraca, zgłoś go organizatorowi.')];
  }
  const parts = [];
  const fixed = data.fixed || [];
  const fixedIds = new Set(fixed.flatMap((f) => [f.id, f.file].filter(Boolean)));
  // podejrzani, których launcher nie ruszył (np. wskazani tylko przez ślad stosu)
  const open = (data.suspects || []).filter((s) => !fixedIds.has(s.id) && !fixedIds.has(s.file));
  const intro = { marginTop: 0, lineHeight: 1.5 };

  if (fixed.length) {
    parts.push(
      h('p', { style: intro }, fixed.length === 1 ? 'Znalazłem przyczynę i od razu to naprawiłem:' : 'Znalazłem przyczyny i od razu je naprawiłem:'),
      ...fixed.map((f) => fixRow(instanceId, f, onChanged)),
      h('p', { style: { lineHeight: 1.5 } }, 'Uruchom grę ponownie. Jeśli znów się wysypie, launcher sprawdzi to jeszcze raz.'),
    );
    if (open.length) {
      parts.push(h('p', { style: intro }, 'Inne możliwe przyczyny, których nie ruszałem:'), ...open.map((s) => suspectRow(instanceId, s, onChanged)));
    }
  } else if (open.length) {
    parts.push(
      h('p', { style: intro }, open.length === 1 ? 'Gra wywaliła się przez ten mod:' : 'Gra wywaliła się przez jeden z tych modów (najbardziej prawdopodobny na górze):'),
      ...open.map((s) => suspectRow(instanceId, s, onChanged)),
    );
  } else if (data.cause) {
    parts.push(h('p', { style: intro }, data.cause));
  } else {
    parts.push(h('p', { style: { marginTop: 0 } }, 'Nie udało się wskazać winowajcy. Szczegóły są w konsoli instancji.'));
  }
  return parts;
}

/** Okno po awarii gry. `onConsole` otwiera konsolę instancji, `onRetry` uruchamia grę ponownie. */
export function showCrash(instanceId, data, { onConsole, onRetry } = {}) {
  const fixedSomething = Boolean(data.fixed?.length);
  const modal = openModal({
    title: fixedSomething ? 'Naprawiłem awarię gry' : 'Gra się zawiesiła',
    body: crashBody(instanceId, data, () => modal.close()),
    actions: [
      h('button', { class: 'btn', onclick: () => modal.close() }, 'Zamknij'),
      onConsole
        ? h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                modal.close();
                onConsole();
              },
            },
            'Pokaż konsolę',
          )
        : null,
      fixedSomething && onRetry
        ? h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                modal.close();
                onRetry();
              },
            },
            'Uruchom ponownie',
          )
        : null,
    ],
  });
  return modal;
}

/** Karta na stronie instancji (do następnego uruchomienia). */
export function crashCard(instanceId, data, { onChanged, onConsole } = {}) {
  const fixedSomething = Boolean(data.fixed?.length);
  return h(
    'div',
    { class: 'card', style: { margin: '14px 0', padding: '14px 18px', borderColor: fixedSomething ? 'var(--ok)' : 'var(--err)' } },
    h(
      'div',
      { class: 'row', style: { marginBottom: '10px' } },
      icon(fixedSomething ? 'check' : 'alert', 20),
      h('div', { class: 'grow', style: { fontWeight: 700 } }, fixedSomething ? 'Ostatnia awaria została naprawiona automatycznie' : 'Ostatnie uruchomienie zakończyło się awarią'),
      onConsole ? h('button', { class: 'btn sm', onclick: onConsole }, 'Konsola') : null,
    ),
    ...crashBody(instanceId, data, onChanged),
  );
}
