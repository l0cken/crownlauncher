import { call } from '../api.js';
import { h, icon, mount, fmtNumber, fmtAgo } from '../dom.js';
import { state, currentAccount, lastInstance } from '../state.js';
import { navigate, instanceCard, playButton, openCreateInstance, instanceMeta } from '../components.js';
import { openProjectModal } from './browse.js';
import { serverRow } from './servers.js';
import { newsSection } from './news.js';

export function renderHome() {
  const page = h('div', { class: 'page' });
  const account = currentAccount();
  const last = lastInstance();

  const actions = [];
  let heading;
  let sub;
  if (last) {
    heading = last.name;
    sub = `${instanceMeta(last)} · ${fmtAgo(last.lastPlayed)}`;
    actions.push(
      playButton(last, { large: true }),
      h('button', { class: 'btn lg', onclick: () => navigate(`#/instance/${last.id}`) }, 'Zarządzaj'),
    );
  } else {
    heading = 'Zacznij swoją przygodę';
    sub = 'Utwórz pierwszą instancję — wybierz wersję od 1.21.4 do 26.3 i loader modów, resztą zajmie się CrownLauncher.';
    actions.push(
      h('button', { class: 'btn primary lg', onclick: openCreateInstance }, icon('plus', 20), 'Nowa instancja'),
    );
  }

  page.append(
    h(
      'div',
      { class: 'hero' },
      h(
        'div',
        null,
        h('div', { class: 'eyebrow' }, last ? `Witaj, ${account?.username || 'graczu'}` : 'Witaj w CrownLauncher'),
        h('h1', null, heading),
        h('p', null, sub),
        h('div', { class: 'actions' }, actions),
      ),
      h('img', { src: '../../assets/logo-512.png', alt: '' }),
    ),
  );

  // newsy (Mojang + Modrinth)
  page.append(newsSection());

  // szybkie dołączanie do serwerów
  if (state.servers.length) {
    page.append(
      h(
        'div',
        { class: 'section-title' },
        'Szybkie dołączanie',
        h('a', { href: '#/servers', style: { color: 'var(--gold)', textDecoration: 'none' } }, 'Wszystkie serwery'),
      ),
      h('div', { class: 'list' }, state.servers.slice(0, 3).map((s) => serverRow(s, { compact: true }))),
    );
  }

  // instancje
  const recent = state.instances.slice(0, 3);
  page.append(
    h(
      'div',
      { class: 'section-title' },
      'Twoje instancje',
      state.instances.length
        ? h('a', { href: '#/instances', style: { color: 'var(--gold)', textDecoration: 'none' } }, 'Zobacz wszystkie')
        : null,
    ),
    h(
      'div',
      { class: 'grid' },
      recent.map(instanceCard),
      h('button', { class: 'new-card', onclick: openCreateInstance }, icon('plus', 26), 'Nowa instancja'),
    ),
  );

  // popularne w Modrinth
  const popular = h('div', { class: 'grid' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' })));
  page.append(
    h(
      'div',
      { class: 'section-title' },
      'Popularne w Modrinth',
      h('a', { href: '#/browse', style: { color: 'var(--gold)', textDecoration: 'none' } }, 'Przeglądaj'),
    ),
    popular,
  );
  call('modrinth:search', {
    type: 'mod',
    versions: state.versions.map((v) => v.id),
    sort: 'downloads',
    limit: 8,
  })
    .then((data) =>
      mount(
        popular,
        data.hits.map((hit) =>
          h(
            'div',
            { class: 'card item click', onclick: () => openProjectModal(hit) },
            hit.icon
              ? h('img', { class: 'pic', src: hit.icon, alt: '', loading: 'lazy' })
              : h('div', { class: 'pic' }, hit.title[0]),
            h(
              'div',
              { class: 'body' },
              h('div', { class: 'ttl' }, hit.title),
              h('div', { class: 'tags', style: { marginTop: '4px' } }, h('span', { class: 'stat' }, icon('download', 13), fmtNumber(hit.downloads))),
            ),
          ),
        ),
      ),
    )
    .catch(() =>
      mount(popular, h('div', { class: 'hint' }, 'Nie udało się pobrać listy z Modrinth (sprawdź internet).')),
    );

  return page;
}
