const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const mojang = require('./mojang');
const { LOADERS, listLoaderVersions } = require('./loaders');
const { exists, readJson, writeJson } = require('./util');

const CONTENT_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const EDITABLE = ['name', 'memoryMb', 'jvmArgs', 'javaPath', 'color', 'lastPlayed', 'playTime', 'perfModsApplied', 'perfProfile', 'perfRenderer', 'perfVulkanFailed'];

function slugify(name) {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 32) || 'instancja';
}

async function list() {
  let dirs = [];
  try {
    dirs = await fsp.readdir(paths.instances(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      out.push(await readJson(paths.instanceFile(d.name)));
    } catch {
      /* uszkodzona instancja - pomiń */
    }
  }
  return out.sort((a, b) => (b.lastPlayed || b.createdAt || 0) - (a.lastPlayed || a.createdAt || 0));
}

async function get(id) {
  if (path.basename(id) !== id) throw new Error('Niepoprawne id instancji.');
  try {
    return await readJson(paths.instanceFile(id));
  } catch {
    throw new Error('Nie znaleziono instancji.');
  }
}

async function create({ name, mcVersion, loader = 'fabric', loaderVersion = '', memoryMb, color }) {
  name = String(name || '').trim();
  if (!name) throw new Error('Podaj nazwę instancji.');
  if (!LOADERS.includes(loader)) throw new Error(`Nieznany loader: ${loader}`);
  if (!(await mojang.isSupportedVersion(mcVersion))) {
    throw new Error(`Wersja ${mcVersion} nie jest obsługiwana (zakres ${mojang.MIN_VERSION} – ${mojang.MAX_VERSION}).`);
  }
  if (!loaderVersion) {
    const versions = await listLoaderVersions(loader, mcVersion);
    if (!versions.length) throw new Error(`Brak loadera ${loader} dla wersji ${mcVersion}.`);
    loaderVersion = (versions.find((v) => v.stable) || versions[0]).version;
  }

  let id = `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`;
  while (await exists(paths.instanceDir(id))) id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

  const instance = {
    id,
    name,
    mcVersion,
    loader,
    loaderVersion,
    memoryMb: Number(memoryMb) || 0, // 0 = domyślna z ustawień
    jvmArgs: '',
    javaPath: '',
    color: color || '#f2b01e',
    createdAt: Date.now(),
    lastPlayed: 0,
    playTime: 0,
  };
  await fsp.mkdir(paths.gameDir(id), { recursive: true });
  await writeJson(paths.instanceFile(id), instance);
  return instance;
}

/**
 * Instancja wydarzenia (np. Igrzyska śmierci): stałe id, zablokowana (`locked`) - launcher nie pozwala zmieniać jej
 * zawartości ani ustawień, a pliki są synchronizowane z serwerem przy każdym starcie (patrz event.js).
 */
async function createEvent({ id, event, name, mcVersion, crownClient = true }) {
  if (!(await mojang.isSupportedVersion(mcVersion))) {
    throw new Error(`Wersja ${mcVersion} nie jest obsługiwana (zakres ${mojang.MIN_VERSION} – ${mojang.MAX_VERSION}).`);
  }
  const versions = await listLoaderVersions('fabric', mcVersion);
  if (!versions.length) throw new Error(`Brak loadera Fabric dla wersji ${mcVersion}.`);
  const instance = {
    id,
    name: String(name || 'Wydarzenie'),
    mcVersion,
    loader: 'fabric',
    loaderVersion: (versions.find((v) => v.stable) || versions[0]).version,
    memoryMb: 0,
    jvmArgs: '',
    javaPath: '',
    color: '#ff5d6c',
    createdAt: Date.now(),
    lastPlayed: 0,
    playTime: 0,
    locked: true,
    event,
    noCrownClient: crownClient === false,
  };
  await fsp.mkdir(paths.gameDir(id), { recursive: true });
  await writeJson(paths.instanceFile(id), instance);
  return instance;
}

/** Zmiana pól instancji wydarzenia (nazwa, CrownClient) - tylko przez launcher, nie przez interfejs. */
async function setEventMeta(id, patch) {
  const instance = await get(id);
  Object.assign(instance, patch);
  await writeJson(paths.instanceFile(id), instance);
  return instance;
}

async function isLocked(id) {
  try {
    return Boolean((await get(id)).locked);
  } catch {
    return false;
  }
}

async function update(id, patch) {
  const instance = await get(id);
  for (const key of EDITABLE) {
    if (key in patch) instance[key] = patch[key];
  }
  if (!String(instance.name).trim()) throw new Error('Nazwa instancji nie może być pusta.');
  await writeJson(paths.instanceFile(id), instance);
  return instance;
}

/**
 * Dawna instancja Vanilla -> Fabric. Launcher działa już tylko z Fabricem (CrownClient, czyli korona przed
 * nickiem, i peleryny są modami Fabrica). Pliki gry, światy i ustawienia zostają; zmienia się tylko loader.
 */
async function useFabric(id) {
  const instance = await get(id);
  if (instance.loader === 'fabric') return instance;
  if (instance.loader !== 'vanilla') throw new Error(`Instancja używa loadera ${instance.loader}, którego nie da się przełączyć.`);
  const versions = await listLoaderVersions('fabric', instance.mcVersion);
  if (!versions.length) throw new Error(`Brak Fabrica dla Minecrafta ${instance.mcVersion}.`);
  instance.loader = 'fabric';
  instance.loaderVersion = (versions.find((v) => v.stable) || versions[0]).version;
  await writeJson(paths.instanceFile(id), instance);
  return instance;
}

let migration = null;

/**
 * Przełącza na Fabric wszystkie dawne instancje Vanilla. Raz na uruchomienie programu (brak sieci nie blokuje
 * listy instancji - przy starcie gry zostanie ponowiona próba).
 */
function migrateVanilla() {
  if (!migration) {
    migration = (async () => {
      let changed = 0;
      for (const inst of await list()) {
        if (inst.loader !== 'vanilla') continue;
        try {
          await useFabric(inst.id);
          changed++;
        } catch {
          /* bez sieci: spróbujemy przy starcie gry */
        }
      }
      return changed;
    })();
  }
  return migration;
}
async function remove(id) {
  await get(id);
  await fsp.rm(paths.instanceDir(id), { recursive: true, force: true });
}

// ---- zawartość (mody / paczki zasobów / shadery) ------------------------

async function readIndex(id) {
  try {
    return await readJson(paths.contentIndex(id));
  } catch {
    return {};
  }
}

async function writeIndex(id, index) {
  await writeJson(paths.contentIndex(id), index);
}

function contentDir(id, type) {
  const folder = CONTENT_DIRS[type];
  if (!folder) throw new Error(`Nieznany typ zawartości: ${type}`);
  return path.join(paths.gameDir(id), folder);
}

function safeName(file) {
  if (!file || path.basename(file) !== file) throw new Error('Niepoprawna nazwa pliku.');
  return file;
}

async function listContent(id, type) {
  const dir = contentDir(id, type);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const index = await readIndex(id);
  const out = [];
  for (const e of entries) {
    const enabled = !e.name.endsWith('.disabled');
    const base = enabled ? e.name : e.name.slice(0, -'.disabled'.length);
    const ext = path.extname(base).toLowerCase();
    const okFile = type === 'mod' ? ext === '.jar' : ext === '.zip';
    if (!(e.isFile() && okFile) && !(e.isDirectory() && type !== 'mod')) continue;
    const meta = index[base] || {};
    // CustomSkinLoader (rysowanie peleryn) jest zarządzany przez launcher - nie pokazujemy go na liście modów
    if (type === 'mod' && /customskinloader/i.test(`${base} ${meta.slug || ''}`)) continue;
    let size = 0;
    if (e.isFile()) size = (await fsp.stat(path.join(dir, e.name))).size;
    out.push({
      file: e.name,
      enabled,
      size,
      title: meta.title || base.replace(/\.(jar|zip)$/i, ''),
      icon: meta.icon || '',
      versionNumber: meta.versionNumber || '',
      projectId: meta.projectId || '',
      unmatched: Boolean(meta.unmatched),
      bundled: Boolean(meta.bundled),
      slug: meta.slug || '',
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function toggleContent(id, type, file) {
  safeName(file);
  const dir = contentDir(id, type);
  const from = path.join(dir, file);
  const to = file.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : `${from}.disabled`;
  await fsp.rename(from, to);
}

async function deleteContent(id, type, file) {
  safeName(file);
  const dir = contentDir(id, type);
  await fsp.rm(path.join(dir, file), { recursive: true, force: true });
  const base = file.endsWith('.disabled') ? file.slice(0, -'.disabled'.length) : file;
  const index = await readIndex(id);
  if (index[base]) {
    delete index[base];
    await writeIndex(id, index);
  }
}

module.exports = {
  CONTENT_DIRS,
  list,
  get,
  create,
  update,
  useFabric,
  createEvent,
  setEventMeta,
  isLocked,
  migrateVanilla,
  remove,
  readIndex,
  writeIndex,
  contentDir,
  listContent,
  toggleContent,
  deleteContent,
};
