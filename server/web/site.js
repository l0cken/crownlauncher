// Strona pobierania: tylko wygoda (formatowanie klucza, blokada przycisku). Bez tego skryptu formularz też działa.
(() => {
  'use strict';
  // logo (.logo ma pointer-events: none, więc zdarzenia trafiają do rodzica): na jego polu bez menu kontekstowego i przeciągania
  const onLogo = (e) => [...document.querySelectorAll('.logo')].some((n) => {
    const r = n.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
  for (const type of ['contextmenu', 'dragstart']) document.addEventListener(type, (e) => { if (onLogo(e)) e.preventDefault(); });

  const input = document.getElementById('key');
  const form = document.getElementById('f');
  if (!input || !form) return;

  /** „crownabcdefgh…” albo „abcd efgh…” -> „CROWN-ABCD-EFGH-…” (maks. 16 znaków klucza). */
  function format(raw) {
    let s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.startsWith('CROWN')) s = s.slice(5);
    s = s.slice(0, 16);
    const groups = s.match(/.{1,4}/g) || [];
    return groups.length ? 'CROWN-' + groups.join('-') : '';
  }

  input.addEventListener('input', () => {
    const start = input.selectionStart;
    const before = input.value;
    const next = format(before);
    if (next !== before) {
      input.value = next;
      // kursor na końcu przy pisaniu; przy edycji w środku zostaje blisko dawnego miejsca
      const atEnd = start === null || start >= before.length;
      const pos = atEnd ? next.length : Math.min(start, next.length);
      input.setSelectionRange(pos, pos);
    }
  });

  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text) return;
    e.preventDefault();
    input.value = format(text);
    input.dispatchEvent(new Event('input'));
  });

  form.addEventListener('submit', (e) => {
    input.value = format(input.value) || input.value;
    // blokada dopiero po zbudowaniu zawartości formularza (zablokowany przycisk nie wchodzi do wysyłanych pól)
    const button = document.getElementById('go');
    if (button) {
      const label = button.textContent;
      setTimeout(() => {
        button.disabled = true;
        button.textContent = 'Pobieranie…';
        // plik pobiera się jako załącznik i strona zostaje - po chwili przywracamy przycisk
        setTimeout(() => {
          button.disabled = false;
          button.textContent = label;
        }, 6000);
      }, 0);
    }
  });
})();
