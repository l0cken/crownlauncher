import { h, icon } from '../dom.js';
import { state } from '../state.js';
import { instanceCard, openCreateInstance, importMrpack } from '../components.js';

export function renderInstances() {
  const page = h('div', { class: 'page' });
  page.append(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', null, 'Instancje'),
        h('p', null, 'Każda instancja ma własne mody, ustawienia i światy. Plik .mrpack możesz też przeciągnąć na okno launchera.'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onclick: () => importMrpack() }, icon('download', 16), 'Importuj .mrpack'),
        h('button', { class: 'btn primary', onclick: openCreateInstance }, icon('plus', 16), 'Nowa instancja'),
      ),
    ),
  );

  if (!state.instances.length) {
    page.append(
      h(
        'div',
        { class: 'empty' },
        icon('box', 44),
        h('h3', null, 'Nie masz jeszcze żadnej instancji'),
        h('div', null, 'Utwórz pierwszą, aby zacząć grać, albo zaimportuj gotową paczkę modów (.mrpack).'),
      ),
    );
    return page;
  }

  page.append(
    h(
      'div',
      { class: 'grid' },
      state.instances.map(instanceCard),
      h('button', { class: 'new-card', onclick: openCreateInstance }, icon('plus', 26), 'Nowa instancja'),
    ),
  );
  return page;
}
