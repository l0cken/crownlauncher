import { call } from '../api.js';
import { h, icon, mount, toast, openModal, confirmModal, fmtDate } from '../dom.js';

const PAGE = 3; // jeden rząd; reszta po kliknięciu „Pokaż więcej”, żeby instancje były blisko góry

// Dane trzymamy w module, żeby powrót na ekran startowy nie pokazywał szkieletów.
let cache = null; // { items, stale, fetchedAt, announcementsError }
let publisher = { loggedIn: false };

const logoFallback = () => h('div', { class: 'news-img empty' }, h('img', { src: '../../assets/logo-512.png', alt: '' }));

function cover(item) {
  if (!item.image) return logoFallback();
  const img = h('img', { class: 'news-img', src: item.image, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(logoFallback()));
  return img;
}

const openLink = (url) => call('shell:open-external', url).catch((e) => toast(e.message, 'err'));

// ---- szczegóły ogłoszenia ------------------------------------------------------------

function openAnnouncement(item, onChanged) {
  const paragraphs = item.fullText.split(/\n{2,}/).map((p) => h('p', { class: 'notes-p' }, p));
  const actions = [];
  if (item.link) actions.push(h('button', { class: 'btn', onclick: () => openLink(item.link) }, icon('external', 16), 'Otwórz link'));
  if (item.canDelete) {
    actions.push(
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            const ok = await confirmModal({ title: 'Usuń ogłoszenie', message: `Usunąć „${item.title}” dla wszystkich użytkowników?`, confirmLabel: 'Usuń', danger: true });
            if (!ok) return;
            try {
              await call('announce:remove', item.annId);
              modal.close();
              toast('Usunięto ogłoszenie.');
              onChanged();
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        },
        icon('trash', 16),
        'Usuń',
      ),
    );
  }
  const modal = openModal({
    title: item.title,
    wide: true,
    body: [
      item.image ? h('img', { src: item.image, alt: '', style: { width: '100%', maxHeight: '260px', objectFit: 'cover', borderRadius: '12px', marginBottom: '14px' } }) : null,
      h(
        'div',
        { class: 'row wrap', style: { gap: '8px', marginBottom: '12px' } },
        h('span', { class: `chip${item.level === 'important' ? ' gold' : ''}` }, item.label),
        h('span', { class: 'chip' }, `od ${item.author}`),
        h('span', { class: 'chip' }, fmtDate(item.date)),
      ),
      h('div', { class: 'notes' }, paragraphs.length ? paragraphs : h('p', { class: 'notes-p hint' }, 'Brak dodatkowej treści.')),
    ],
    actions,
  });
}

// ---- publikowanie (dla osób z kluczem) ----------------------------------------------------

function openPublish(onPublished) {
  const form = { title: '', text: '', image: '', link: '', level: 'info', pinned: false, expiresInDays: 7 };
  const count = h('span', { class: 'hint' }, '0 / 2000');
  const publishBtn = h('button', { class: 'btn primary', onclick: submit }, icon('check', 16), 'Opublikuj');

  async function submit() {
    publishBtn.disabled = true;
    try {
      await call('announce:publish', {
        ...form,
        image: form.image.trim(),
        link: form.link.trim(),
        expiresInDays: form.expiresInDays || null,
      });
      modal.close();
      toast('Ogłoszenie opublikowane — zobaczą je wszyscy użytkownicy launchera.');
      onPublished();
    } catch (e) {
      toast(e.message, 'err');
      publishBtn.disabled = false;
    }
  }

  const switchEl = h('button', {
    class: 'switch',
    onclick: () => {
      form.pinned = !form.pinned;
      switchEl.classList.toggle('on', form.pinned);
    },
  });

  const modal = openModal({
    title: 'Nowe ogłoszenie',
    wide: true,
    body: [
      h('div', { class: 'field' }, h('label', null, 'Tytuł'), h('input', { class: 'input', maxlength: 80, placeholder: 'Krótki, wyraźny tytuł', oninput: (e) => (form.title = e.target.value) })),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'row' }, h('label', { class: 'grow label' }, 'Treść'), count),
        h('textarea', {
          class: 'input',
          rows: 5,
          maxlength: 2000,
          style: { resize: 'vertical' },
          placeholder: 'Co chcesz ogłosić? (akapity oddziel pustą linią)',
          oninput: (e) => {
            form.text = e.target.value;
            count.textContent = `${form.text.length} / 2000`;
          },
        }),
      ),
      h(
        'div',
        { class: 'row', style: { alignItems: 'flex-start' } },
        h('div', { class: 'field grow' }, h('label', null, 'Rodzaj'), h('select', { class: 'select', value: form.level, onchange: (e) => (form.level = e.target.value) },
          h('option', { value: 'info' }, 'Ogłoszenie'), h('option', { value: 'important' }, 'Ważne'), h('option', { value: 'event' }, 'Wydarzenie'))),
        h('div', { class: 'field grow' }, h('label', null, 'Wygasa po'), h('select', { class: 'select', value: String(form.expiresInDays), onchange: (e) => (form.expiresInDays = Number(e.target.value)) },
          h('option', { value: '1' }, '1 dniu'), h('option', { value: '7' }, '7 dniach'), h('option', { value: '30' }, '30 dniach'), h('option', { value: '0' }, 'Nigdy'))),
      ),
      h('div', { class: 'field' }, h('label', null, 'Obrazek (adres https, opcjonalnie)'), h('input', { class: 'input', placeholder: 'https://…/obrazek.png', oninput: (e) => (form.image = e.target.value) })),
      h('div', { class: 'field' }, h('label', null, 'Link „Czytaj więcej” (https, opcjonalnie)'), h('input', { class: 'input', placeholder: 'https://…', oninput: (e) => (form.link = e.target.value) })),
      h('div', { class: 'row' }, switchEl, h('div', null, h('div', { style: { fontWeight: 700 } }, 'Przypnij na górze'), h('div', { class: 'hint' }, 'Przypięte ogłoszenia są zawsze przed innymi.'))),
    ],
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Anuluj'), publishBtn],
  });
}

// ---- karty --------------------------------------------------------------------------------------

function newsCard(item, onChanged) {
  const badge = h(
    'span',
    { class: `chip${item.level === 'important' || item.level === 'event' ? ' gold' : ''}` },
    item.pinned ? icon('zap', 12) : null,
    item.label,
  );
  const del = item.canDelete
    ? h(
        'button',
        {
          class: 'btn icon ghost sm news-del',
          title: 'Usuń ogłoszenie',
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmModal({ title: 'Usuń ogłoszenie', message: `Usunąć „${item.title}” dla wszystkich użytkowników?`, confirmLabel: 'Usuń', danger: true });
            if (!ok) return;
            try {
              await call('announce:remove', item.annId);
              toast('Usunięto ogłoszenie.');
              onChanged();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        },
        icon('trash', 15),
      )
    : null;

  return h(
    'div',
    { class: `card news-card ann${item.level === 'important' ? ' important' : ''}`, onclick: () => openAnnouncement(item, onChanged) },
    cover(item),
    del,
    h(
      'div',
      { class: 'news-body' },
      h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, badge, h('span', { class: 'hint' }, `${item.author} · ${fmtDate(item.date)}`)),
      h('div', { class: 'news-title' }, item.title),
      item.text ? h('div', { class: 'news-text' }, item.text) : null,
    ),
  );
}

/**
 * Sekcja newsów na ekranie startowym: ogłoszenia launchera.
 * Gdy nie ma żadnych ogłoszeń, a użytkownik nie może publikować - sekcja jest ukryta.
 * Błąd pobierania pokazujemy każdemu: inaczej "nie widzę ogłoszeń" jest nie do odróżnienia od "ich nie ma".
 */
export function newsSection() {
  let shown = PAGE;
  const root = h('div');

  function paint() {
    const items = cache?.items || [];
    if (!items.length && !publisher.loggedIn && !cache?.announcementsError) {
      mount(root); // nic do pokazania
      return;
    }

    const tools = h(
      'div',
      { class: 'row', style: { gap: '8px' } },
      cache?.stale ? h('span', { class: 'hint' }, 'Brak połączenia — zapisane ogłoszenia') : null,
      publisher.loggedIn
        ? h('button', { class: 'btn primary sm', onclick: () => openPublish(() => load(true)) }, icon('plus', 15), 'Nowe ogłoszenie')
        : null,
      h('button', { class: 'btn icon ghost sm', title: 'Odśwież', onclick: () => load(true, false) }, icon('refresh', 15)),
    );

    const body = items.length
      ? [
          h('div', { class: 'news-grid' }, items.slice(0, shown).map((i) => newsCard(i, () => load(true)))),
          items.length > shown
            ? h('div', { style: { textAlign: 'center', marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => { shown += PAGE; paint(); } }, 'Pokaż więcej'))
            : null,
        ]
      : [
          h(
            'div',
            { class: 'hint', title: cache?.announcementsError || '' },
            cache?.announcementsError
              ? `Nie udało się pobrać ogłoszeń: ${cache.announcementsError}`
              : 'Brak ogłoszeń. Kliknij „Nowe ogłoszenie”, aby coś ogłosić użytkownikom launchera.',
          ),
        ];

    mount(root, h('div', { class: 'section-title' }, h('span', null, 'Newsy'), tools), body);
  }

  async function load(force = false, quiet = true) {
    try {
      cache = await call('news:list', { force });
      if (force && !quiet) toast('Odświeżono.');
    } catch (e) {
      if (!quiet) toast(e.message, 'err');
    }
    paint();
  }

  if (cache) paint();
  Promise.all([
    call('announce:status').then((s) => (publisher = s)).catch(() => {}),
    load(false),
  ]).then(paint);

  return root;
}
