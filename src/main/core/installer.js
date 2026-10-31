const fsp = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const config = require('./config');
const mojang = require('./mojang');
const { ensureJava } = require('./java');
const { ensureLoader } = require('./loaders');
const { downloadFile, exists, readJson, pool, mavenPath, isInside } = require('./util');

const ASSET_HOST = 'https://resources.download.minecraft.net';

// Zamienia wpisy "libraries" na listę plików do pobrania (po zastosowaniu reguł systemowych).
function collectLibraries(merged) {
  const list = [];
  for (const lib of merged.libraries || []) {
    if (!mojang.rulesAllow(lib.rules)) continue;
    const dl = lib.downloads;

    // starszy format natywnych bibliotek (classifiers) - w 1.21.4+ nie występuje, ale loadery mogą go użyć
    const nativeKey = lib.natives?.[mojang.osName()];
    if (nativeKey) {
      const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const nat = dl?.classifiers?.[classifier];
      if (nat) {
        list.push({ ...nat, native: true, extract: lib.extract || {} });
      }
    }

    if (dl?.artifact) {
      list.push({ path: dl.artifact.path, url: dl.artifact.url, sha1: dl.artifact.sha1, size: dl.artifact.size });
    } else if (!dl && lib.name) {
      // styl Mavena (Fabric/Quilt): name + bazowy url
      const rel = mavenPath(lib.name);
      const base = lib.url || 'https://libraries.minecraft.net/';
      list.push({
        path: rel,
        url: base.endsWith('/') ? base + rel : `${base}/${rel}`,
        sha1: lib.sha1,
        size: lib.size,
      });
    }
  }
  return list;
}

async function extractNatives(file, targetDir, exclude = []) {
  const zip = new AdmZip(file);
  await fsp.mkdir(targetDir, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (exclude.some((p) => entry.entryName.startsWith(p))) continue;
    const dest = path.join(targetDir, entry.entryName);
    if (!isInside(targetDir, dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, entry.getData());
  }
}

/**
 * Przygotowuje wszystko, czego potrzebuje instancja do startu: Javę, loader,
 * bibliotekę, jar klienta i zasoby. Zwraca dane potrzebne do zbudowania polecenia.
 */
async function prepare(instance, onProgress = () => {}) {
  const emit = (stage, current = 0, total = 0, detail) => onProgress({ stage, current, total, detail });

  emit('Pobieranie danych wersji');
  const vanilla = await mojang.getVanillaJson(instance.mcVersion);
  const component = vanilla.javaVersion?.component || 'java-runtime-delta';

  // własna Java (instancja albo ustawienia) zastępuje runtime Mojanga - nie pobieramy wtedy niepotrzebnie runtime'u
  const customJava = String(instance.javaPath || config.get().javaPath || '').trim();
  const javaExe = customJava && (await exists(customJava)) ? customJava : await ensureJava(component, (p) => onProgress(p));
  const versionId = await ensureLoader(instance, javaExe, (p) => onProgress(p));
  const merged = await mojang.resolveVersion(versionId);

  // jar klienta
  const baseId = merged._baseId;
  const clientJar = path.join(paths.versionDir(baseId), `${baseId}.jar`);
  const client = merged.downloads?.client;
  if (client) {
    emit('Pobieranie klienta gry');
    await downloadFile(client.url, clientJar, { sha1: client.sha1, size: client.size });
  } else if (!(await exists(clientJar))) {
    throw new Error(`Brak pliku klienta dla wersji ${baseId}.`);
  }

  // biblioteki
  const libs = collectLibraries(merged);
  let done = 0;
  emit('Pobieranie bibliotek', 0, libs.length);
  await pool(libs, 16, async (lib) => {
    const dest = path.join(paths.libraries(), lib.path);
    if (lib.url) await downloadFile(lib.url, dest, { sha1: lib.sha1, size: lib.size });
    emit('Pobieranie bibliotek', ++done, libs.length);
  });

  // natywne biblioteki w starym stylu -> rozpakuj do katalogu natives
  const nativesDir = paths.nativesDir(instance.id);
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const lib of libs.filter((l) => l.native)) {
    await extractNatives(path.join(paths.libraries(), lib.path), nativesDir, lib.extract.exclude || ['META-INF/']);
  }
  // nowe wersje oczekują podkatalogów w ${natives_directory}
  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
    await fsp.mkdir(path.join(nativesDir, sub), { recursive: true });
  }

  // zasoby (dźwięki, tekstury językowe itd.)
  const assetIndex = merged.assetIndex;
  const indexFile = path.join(paths.assets(), 'indexes', `${assetIndex.id}.json`);
  await downloadFile(assetIndex.url, indexFile, { sha1: assetIndex.sha1, size: assetIndex.size });
  const index = await readJson(indexFile);
  const objects = Object.values(index.objects || {});
  const unique = [...new Map(objects.map((o) => [o.hash, o])).values()];
  done = 0;
  emit('Pobieranie zasobów gry', 0, unique.length);
  await pool(unique, 24, async (obj) => {
    const prefix = obj.hash.slice(0, 2);
    const dest = path.join(paths.assets(), 'objects', prefix, obj.hash);
    await downloadFile(`${ASSET_HOST}/${prefix}/${obj.hash}`, dest, {
      sha1: obj.hash,
      size: obj.size,
      checkHash: false,
    });
    emit('Pobieranie zasobów gry', ++done, unique.length);
  });

  // konfiguracja logowania log4j
  let loggingArg = null;
  const logging = merged.logging?.client;
  if (logging?.file) {
    const logFile = path.join(paths.assets(), 'log_configs', logging.file.id);
    await downloadFile(logging.file.url, logFile, { sha1: logging.file.sha1, size: logging.file.size });
    loggingArg = logging.argument.replace('${path}', logFile);
  }

  const classpath = [
    ...libs.filter((l) => !l.native).map((l) => path.join(paths.libraries(), l.path)),
    clientJar,
  ];

  return {
    merged,
    versionId,
    javaExe,
    clientJar,
    classpath: [...new Set(classpath)],
    nativesDir,
    assetIndexId: assetIndex.id,
    loggingArg,
  };
}

module.exports = { prepare };
