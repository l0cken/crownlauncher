const fsp = require('fs').promises;
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');
const { ZipWriter } = require('./zip-writer');
const LAUNCHER_VERSION = require('../../../package.json').version;

/**
 * Eksport instancji do pliku .mrpack (format paczek Modrinth): plik jest zwykłym ZIP-em z modrinth.index.json i folderem
 * overrides/ z zawartością folderu gry. Taką paczkę zaimportuje CrownLauncher (Instancje → Importuj), Modrinth App i Prism
 * Launcher, a przy okazji to kopia zapasowa instancji.
 *
 * Wszystkie pliki trafiają do overrides/ (także mody): launcher nie zna adresów pobierania modów, więc paczka jest samowystarczalna
 * i działa bez sieci. W zamian jest większa niż „odchudzona” paczka z listą linków.
 *
 * Co NIE trafia do paczki: dzienniki i raporty awarii, zrzuty ekranu, pamięć podręczna i dane techniczne (.fabric, .mixin.out…),
 * dane zarządzane przez launcher (CustomSkinLoader - peleryny) oraz pliki wyglądające na poufne (tokeny, klucze, hasła) - mody
 * czasem trzymają takie dane w configach, a paczka jest do wysyłania innym ludziom. Światy (saves) tylko na życzenie.
 * Ustawienia samego launchera (nick, konta, pamięć RAM, ścieżka Javy) nie są częścią paczki.
 * Instancji wydarzenia (zablokowanej) nie da się eksportować - jej zestaw plików jest zamknięty.
 */

// foldery na najwyższym poziomie folderu gry, które pomijamy zawsze (nazwy porównywane bez rozróżniania wielkości liter)
const SKIP_DIRS = new Set([
  'logs', 'crash-reports', 'screenshots', 'quickplay', 'downloads', 'webcache', 'webcache2', 'debug', 'server-resource-packs',
  '.fabric', '.mixin.out', '.cache', 'customskinloader', 'essential', 'saves', 'backups', 'cache', 'mod_data_cache',
]);
const SKIP_FILES =
  /^(?:hs_err_pid\d+\.log|replay_pid\d+\.log|usercache\.json|usernamecache\.json|realms_persistence\.json|launcher_profiles\.json|servers\.dat_old|\.ds_store|thumbs\.db|desktop\.ini|\.crown.*)$/i;
// pliki, które wyglądają na poufne (tokeny, klucze, hasła, dane logowania) - pomijamy w całym drzewie
const SECRET_FILE = /(?:token|secret|passw|credential|api[-_]?key|\.pem$|\.key$|\.p12$|\.pfx$|\.keystore$|id_rsa|\.env$)/i;
const CONTENT_TOPS = new Set(['mods', 'resourcepacks', 'shaderpacks', 'saves']);
// mody zarządzane przez launcher (peleryny) - launcher dołoży je sam przy starcie gry
const MANAGED_MOD = /customskinloader/i;

const MAX_BYTES = Number(process.env.CROWN_EXPORT_MAX_BYTES) || 1.5 * 1024 ** 3; // paczkę czyta import w pamięci - nie przesadzamy
const MAX_FILES = 60_000;

const safeFileName = (name) => String(name || 'instancja').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'instancja';

/** Proponowana nazwa pliku (bez folderu). */
const suggestedName = (instance) => `${safeFileName(instance.name)}.mrpack`;

/** Zbiera pliki do paczki: [{ rel (z ukośnikami), abs, size, mtime }] + liczniki pominiętych. */
async function collect(gameDir, { worlds = false, skipPaths = [] } = {}) {
  const files = [];
  const skipped = { secrets: 0, other: 0 };
  const skipAbs = new Set(skipPaths.map((p) => path.resolve(p).toLowerCase()));
  let truncated = false;

  async function walk(dir, relDir, top) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // brak folderu gry albo brak dostępu - paczka będzie pusta
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      const low = e.name.toLowerCase();
      if (e.isSymbolicLink()) {
        skipped.other++; // dowiązanie mogłoby wyprowadzić poza folder gry
        continue;
      }
      if (e.isDirectory()) {
        if (!relDir && SKIP_DIRS.has(low) && !(worlds && low === 'saves')) continue;
        await walk(abs, rel, top || low);
        continue;
      }
      if (!e.isFile()) continue;
      if (skipAbs.has(abs.toLowerCase())) continue;
      if (SKIP_FILES.test(e.name)) continue;
      if (relDir === 'mods' && MANAGED_MOD.test(e.name)) continue;
      // pliki poufne pomijamy w configach i resztą folderu gry; nie w modach/paczkach (nazwa jara to nie dane) i nie w światach
      if (!CONTENT_TOPS.has(top) && SECRET_FILE.test(e.name)) {
        skipped.secrets++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const st = await fsp.stat(abs);
      files.push({ rel, abs, size: st.size, mtime: st.mtime });
    }
  }
  await walk(gameDir, '', '');
  if (truncated) throw new Error(`Instancja ma za dużo plików do eksportu (limit ${MAX_FILES}). Wyeksportuj bez światów.`);
  return { files, skipped };
}

/** Zawartość modrinth.index.json dla instancji. */
function buildIndex(instance, { date = new Date() } = {}) {
  const dependencies = { minecraft: instance.mcVersion };
  if ((instance.loader === 'fabric' || instance.loader === 'vanilla') && instance.loaderVersion) {
    dependencies['fabric-loader'] = instance.loaderVersion;
  }
  const stamp = date.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: `export-${stamp}`,
    name: String(instance.name).slice(0, 80),
    summary: `Eksport z CrownLaunchera ${LAUNCHER_VERSION}`,
    files: [],
    dependencies,
  };
}

/**
 * Eksportuje instancję `id` do pliku `dest` (.mrpack). `worlds: true` dołącza światy (saves). `onProgress({ current, total, text })`.
 * Zwraca { path, files, bytes (rozmiar pliku), dataBytes (rozmiar danych), skipped, worlds }.
 */
async function exportInstance(id, dest, { worlds = false, onProgress } = {}) {
  const instance = await instances.get(id);
  if (instance.locked) throw new Error('Instancji wydarzenia nie można eksportować - jej zestaw plików jest zamknięty.');
  if (typeof dest !== 'string' || !dest.trim()) throw new Error('Nie wybrano pliku docelowego.');
  dest = path.resolve(/\.mrpack$/i.test(dest) ? dest : `${dest}.mrpack`);
  const gameDir = paths.gameDir(id);

  onProgress?.({ current: 0, total: 0, text: 'Przeglądam pliki instancji…' });
  const { files, skipped } = await collect(gameDir, { worlds, skipPaths: [dest, `${dest}.part`] });
  const dataBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (dataBytes > MAX_BYTES) {
    throw new Error(
      `Instancja jest za duża na eksport (${(dataBytes / 1024 ** 3).toFixed(1)} GB, limit ${(MAX_BYTES / 1024 ** 3).toFixed(1)} GB).` +
        `${worlds ? ' Wyeksportuj bez światów.' : ''}`,
    );
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const zip = await ZipWriter.create(dest);
  try {
    await zip.addBuffer('modrinth.index.json', `${JSON.stringify(buildIndex(instance), null, 2)}\n`);
    let done = 0;
    for (const f of files) {
      onProgress?.({ current: done, total: files.length, text: `Pakuję: ${f.rel}` });
      try {
        await zip.addFile(`overrides/${f.rel}`, f.abs, { mtime: f.mtime });
      } catch (e) {
        if (e.code === 'ENOENT') {
          skipped.other++; // plik zniknął w trakcie (np. gra zapisała i usunęła plik tymczasowy)
          continue;
        }
        throw e;
      }
      done++;
    }
    const res = await zip.finish();
    onProgress?.({ current: files.length, total: files.length, text: 'Gotowe' });
    return { path: dest, files: done, bytes: res.bytes, dataBytes, skipped, worlds: Boolean(worlds) };
  } catch (e) {
    await zip.abort();
    throw e;
  }
}

module.exports = { exportInstance, collect, buildIndex, suggestedName, safeFileName, MAX_BYTES };
