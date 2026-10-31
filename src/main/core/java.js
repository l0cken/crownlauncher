const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const paths = require('./paths');
const { fetchJson, downloadFile, exists, pool, isInside } = require('./util');

const RUNTIME_INDEX =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  const arch = process.arch;
  if (process.platform === 'win32') {
    return { x64: 'windows-x64', arm64: 'windows-arm64', ia32: 'windows-x86' }[arch] || 'windows-x64';
  }
  if (process.platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

function javaRelPath() {
  if (process.platform === 'win32') return path.join('bin', 'java.exe');
  if (process.platform === 'darwin') return path.join('jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join('bin', 'java');
}

const inflight = new Map();

/**
 * Zapewnia runtime Javy Mojanga (np. "java-runtime-delta") i zwraca ścieżkę do java.exe.
 * Pobiera tylko raz; kolejne wywołania zwracają od razu.
 */
function ensureJava(component, onProgress = () => {}) {
  if (!inflight.has(component)) {
    const p = install(component, onProgress).finally(() => inflight.delete(component));
    inflight.set(component, p);
  }
  return inflight.get(component);
}

async function install(component, onProgress) {
  const dir = paths.runtime(component);
  const exe = path.join(dir, javaRelPath());
  const marker = path.join(dir, '.crown-installed');
  if ((await exists(marker)) && (await exists(exe))) return exe;

  onProgress({ stage: 'Java', current: 0, total: 1 });
  const index = await fetchJson(RUNTIME_INDEX);
  let entry = index[platformKey()]?.[component]?.[0];
  if (!entry && platformKey() === 'windows-arm64') entry = index['windows-x64']?.[component]?.[0];
  if (!entry) {
    // np. Linux na ARM: Mojang buduje runtime tylko dla x64/x86 - wtedy działa Java zainstalowana w systemie
    throw new Error(
      `Mojang nie udostępnia runtime'u ${component} dla tej platformy (${platformKey()}). Zainstaluj Javę w systemie (JDK 21 albo nowszy; dla Minecrafta 26.x JDK 25) i wskaż ją w Ustawieniach → „Własna Java”.`,
    );
  }

  const manifest = await fetchJson(entry.manifest.url);
  const files = Object.entries(manifest.files);

  for (const [rel, f] of files) {
    if (f.type === 'directory') {
      const target = path.join(dir, rel);
      if (isInside(dir, target)) await fsp.mkdir(target, { recursive: true });
    }
  }

  const downloads = files.filter(([, f]) => f.type === 'file' && f.downloads?.raw);
  let done = 0;
  await pool(downloads, 12, async ([rel, f]) => {
    const dest = path.join(dir, rel);
    if (!isInside(dir, dest)) return;
    const raw = f.downloads.raw;
    await downloadFile(raw.url, dest, { sha1: raw.sha1, size: raw.size });
    if (f.executable && process.platform !== 'win32') await fsp.chmod(dest, 0o755);
    onProgress({ stage: 'Java', current: ++done, total: downloads.length });
  });

  // Linux/macOS: manifest runtime'u ma też dowiązania symboliczne (np. katalogi w legal/, biblioteki z numerem wersji w nazwie).
  // Cel dowiązania musi wskazywać na plik w tym samym runtime - inaczej wpis jest pomijany.
  if (process.platform !== 'win32') {
    for (const [rel, f] of files) {
      if (f.type !== 'link' || typeof f.target !== 'string') continue;
      const link = path.join(dir, rel);
      if (!isInside(dir, link) || !isInside(dir, path.resolve(path.dirname(link), f.target))) continue;
      await fsp.mkdir(path.dirname(link), { recursive: true });
      await fsp.rm(link, { force: true });
      await fsp.symlink(f.target, link);
    }
  }

  await fsp.writeFile(marker, entry.version?.name || 'ok', 'utf8');
  return exe;
}

module.exports = { ensureJava, javaRelPath };
