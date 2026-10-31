/**
 * Podział linii logu gry na kolorowane fragmenty (bez DOM - sama logika, żeby dało się ją testować).
 *
 * Rozpoznawane są:
 *  - wiersze logu:  [HH:MM:SS] [wątek/POZIOM]: wiadomość   (log4j / format launchera)
 *  - wiersze launchera: [CrownLauncher] ...
 *  - ślady stosu: "at pakiet.Klasa.metoda(Plik.java:12)", "Caused by: ...", "... 10 more"
 *  - nagłówki wyjątków: java.lang.IllegalStateException: ...
 *  - lista modów Fabrica: "- crownclient 1.0.0+26.2"
 * W wiadomościach wyróżniane są adresy URL, nazwy w apostrofach (np. mody) i klasy wyjątków.
 */

// grupy: 1 czas, 2 odstęp, 3 wątek, 4 poziom, 5 źródło w nawiasie (z odstępem), 6 separator, 7 treść - składają się dokładnie na oryginał
const LOG_RE = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\](\s*)\[([^\]]*?)\/(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]((?:\s*\([^)]*\))?)(\s*:?\s?)(.*)$/;
const SYS_RE = /^\[CrownLauncher\]\s?(.*)$/;
const FRAME_RE = /^(\s*)at\s+([^\s(]+)\((.*)\)\s*$/;
const MORE_RE = /^\s*\.\.\.\s+\d+\s+(?:more|common frames omitted)\s*$/;
const CAUSE_RE = /^(\s*)(Caused by:|Suppressed:)\s*(.*)$/;
const EXC_HEAD_RE = /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:Exception|Error|Throwable)\b/;
const MODLINE_RE = /^(\s*)-\s+([\w.\-]+)\s+(\S+)\s*$/;

// fragmenty wiadomości: adres, nazwa w apostrofach, klasa wyjątku, ścieżka pliku
const INLINE_RE = /(https?:\/\/[^\s)'"]+)|('[^'\n]{1,70}')|((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:Exception|Error|Throwable))\b/g;

/** Rozbija tekst na fragmenty { t, c } (c = klasa CSS albo ''). */
function inline(text, base = '') {
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: base });
    const cls = m[1] ? 'url' : m[2] ? 'str' : 'exc';
    out.push({ t: m[0], c: cls });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: base });
  return out.length ? out : [{ t: text, c: base }];
}

/**
 * Parsuje jedną linię. `prev` - poziom poprzedniego zdarzenia (linie bez znacznika, np. ślad stosu,
 * dziedziczą go, żeby filtr błędów nie rozrywał wyjątków).
 * Zwraca { level, sys, segments: [{ t, c }] }.
 */
function parseLogLine(line, prev = 'INFO') {
  const text = String(line ?? '');

  const sys = SYS_RE.exec(text);
  if (sys) {
    const body = sys[1];
    const alert = /nie jest już obsługiwany|nie wystartował|awari|błąd/i.test(body);
    return {
      level: prev,
      sys: true,
      segments: [{ t: '[CrownLauncher]', c: 'tag' }, { t: ' ' }, ...inline(body, alert ? 'msg ERROR' : 'sysmsg')],
    };
  }

  const log = LOG_RE.exec(text);
  if (log) {
    const [, time, gap, thread, level, source, sep, rest] = log;
    const segments = [
      { t: `[${time}]`, c: 't' },
      { t: gap },
      { t: `[${thread}`, c: 'th' },
      { t: '/', c: 't' },
      { t: level, c: `lv ${level}` },
      { t: ']', c: 'th' },
    ];
    if (source) segments.push({ t: source, c: 'src' });
    if (sep) segments.push({ t: sep, c: 't' });
    segments.push(...inline(rest, `msg ${level}`));
    return { level, sys: false, segments };
  }

  // linie bez znacznika: ślad stosu, nagłówek wyjątku, lista modów - dziedziczą poziom poprzedniego zdarzenia
  const frame = FRAME_RE.exec(text);
  if (frame) {
    return {
      level: prev,
      sys: false,
      cont: true,
      segments: [
        { t: frame[1] },
        { t: 'at ', c: 't' },
        { t: frame[2], c: 'frame' },
        { t: '(', c: 't' },
        { t: frame[3], c: 'loc' },
        { t: ')', c: 't' },
      ],
    };
  }
  if (MORE_RE.test(text)) return { level: prev, sys: false, cont: true, segments: [{ t: text, c: 't' }] };

  const cause = CAUSE_RE.exec(text);
  if (cause) {
    return {
      level: 'ERROR',
      sys: false,
      cont: true,
      segments: [{ t: cause[1] }, { t: cause[2], c: 'cause' }, { t: ' ' }, ...inline(cause[3], 'msg ERROR')],
    };
  }
  if (EXC_HEAD_RE.test(text.trim())) {
    return { level: prev === 'INFO' || prev === 'DEBUG' || prev === 'TRACE' ? 'ERROR' : prev, sys: false, cont: true, segments: inline(text, 'msg ERROR') };
  }
  const mod = MODLINE_RE.exec(text);
  if (mod) {
    return {
      level: prev,
      sys: false,
      cont: true,
      segments: [{ t: mod[1] }, { t: '- ', c: 't' }, { t: mod[2], c: 'modid' }, { t: ' ' }, { t: mod[3], c: 'ver' }],
    };
  }
  return { level: prev, sys: false, cont: true, segments: inline(text, prev === 'INFO' ? '' : `msg ${prev}`) };
}

/** Klasy CSS wiersza. */
function rowClass(parsed) {
  const lv = parsed.sys ? 'sys' : `lv-${parsed.level}`;
  return `ln ${lv}${parsed.cont ? ' cont' : ''}`;
}

export { parseLogLine, rowClass };
