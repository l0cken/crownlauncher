const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync('C:/Users/meabx/Desktop/CrownLauncher/src/renderer/js/log-format.js', 'utf8').replace(/export \{[^}]*\};?/, '');
const { parseLogLine, rowClass } = new Function(`${src}; return { parseLogLine, rowClass };`)();
const cls = (line, prev) => rowClass(parseLogLine(line, prev));
const segs = (line, prev) => parseLogLine(line, prev).segments;
const has = (arr, c, t) => arr.some((s) => (s.c || '').split(' ').includes(c) && (t === undefined || s.t === t));

// zwykłe wiersze logu
let p = parseLogLine('[08:22:41] [Render thread/INFO]: Setting user: L0cken');
assert.strictEqual(p.level, 'INFO');
assert.ok(has(p.segments, 't', '[08:22:41]') && has(p.segments, 'lv', 'INFO') && has(p.segments, 'th', '[Render thread'));
assert.strictEqual(cls('[08:22:41] [Render thread/INFO]: x'), 'ln lv-INFO');
p = parseLogLine('[08:22:34] [main/WARN]: Error loading class: me/jellysquid/Foo (java.lang.ClassNotFoundException: me/jellysquid/Foo)');
assert.strictEqual(p.level, 'WARN');
assert.ok(has(p.segments, 'exc', 'java.lang.ClassNotFoundException'), 'klasa wyjątku wyróżniona');
p = parseLogLine("[08:22:42] [Render thread/ERROR]: Failed to load config from 'C:\\x\\flashback.json'");
assert.strictEqual(p.level, 'ERROR');
assert.ok(has(p.segments, 'str'), 'cytowane w apostrofach');
// z nazwą źródła w nawiasie (log4j: [wątek/POZIOM] (Logger))
p = parseLogLine('[10:00:00] [Server thread/INFO] (Minecraft) Done (3.2s)!');
assert.strictEqual(p.level, 'INFO');
assert.ok(p.segments.some((s) => s.c === 'src' && s.t.trim() === '(Minecraft)'));

// launcher
p = parseLogLine('[CrownLauncher] Uruchamianie Granie (26.2, fabric)');
assert.ok(p.sys && has(p.segments, 'tag') && has(p.segments, 'sysmsg'));
assert.strictEqual(cls('[CrownLauncher] x'), 'ln sys');
p = parseLogLine('[CrownLauncher] ANTYCHEAT: wykryto wstrzyknięte biblioteki (x.dll) - zamykam grę.');
assert.ok(has(p.segments, 'msg') && p.segments.some((s) => /ERROR/.test(s.c || '')), 'komunikat antycheata jako błąd');

// ślady stosu dziedziczą poziom
const err = parseLogLine('[08:22:42] [Render thread/ERROR]: Failed to load config');
const frame = parseLogLine('\tat knot//com.google.gson.stream.JsonReader.unexpectedTokenError(JsonReader.java:1831)', err.level);
assert.strictEqual(frame.level, 'ERROR');
assert.strictEqual(rowClass(frame), 'ln lv-ERROR cont');
assert.ok(has(frame.segments, 'frame') && has(frame.segments, 'loc', 'JsonReader.java:1831'));
const cause = parseLogLine('Caused by: java.lang.IllegalStateException: boom', 'INFO');
assert.strictEqual(cause.level, 'ERROR');
assert.ok(has(cause.segments, 'cause', 'Caused by:') && has(cause.segments, 'exc', 'java.lang.IllegalStateException'));
assert.strictEqual(parseLogLine('\t... 14 more', 'ERROR').level, 'ERROR');
const head = parseLogLine('java.lang.RuntimeException: Mixin transformation failed', 'INFO');
assert.strictEqual(head.level, 'ERROR', 'nagłówek wyjątku bez znacznika to błąd');

// lista modów Fabrica
p = parseLogLine('- crownclient 1.0.0+26.2', 'INFO');
assert.ok(has(p.segments, 'modid', 'crownclient') && has(p.segments, 'ver', '1.0.0+26.2'));
assert.strictEqual(p.level, 'INFO');
// adresy
p = parseLogLine('[08:00:00] [main/INFO]: Download https://api.modrinth.com/v2/project/x ok');
assert.ok(has(p.segments, 'url', 'https://api.modrinth.com/v2/project/x'));
// pusta linia i zwykły tekst
assert.deepStrictEqual(parseLogLine('', 'INFO').segments.map((s) => s.t).join(''), '');
assert.strictEqual(parseLogLine('zwykły tekst', 'WARN').level, 'WARN');
// to, co się wyświetla, składa się dokładnie na oryginał (kopiowanie konsoli nie zmienia treści) - także bez dwukropka
const originals = [
  '[08:22:41] [Render thread/INFO]: Setting user: L0cken',
  '[08:22:41] [Render thread/INFO] Setting user: L0cken',
  '[10:00:00] [Server thread/INFO] (Minecraft) Done (3.2s)!',
  '[10:00:00]  [main/WARN]:  dwie spacje',
  '\tat net.fabricmc.Foo.bar(Foo.java:12)',
  'Caused by: java.io.IOException: x',
  '- sodium 0.8.14',
  '[CrownLauncher] test',
  'java.lang.RuntimeException: Mixin transformation failed',
  '',
];
for (const line of originals) {
  assert.strictEqual(parseLogLine(line, 'INFO').segments.map((s) => s.t).join(''), line, JSON.stringify(line));
}console.log('OK parser logów: wiersze, poziomy, launcher, ślady stosu (dziedziczenie poziomu), wyjątki, lista modów, adresy, wierność tekstu');