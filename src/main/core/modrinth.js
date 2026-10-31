const fsp = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const mojang = require('./mojang');
const instances = require('./instances');
const modCheck = require('./mod-check');
const { fetchJson, downloadFile, pool, isInside, hashFile, exists } = require('./util');

const API = 'https://api.modrinth.com/v2';

// Klucze zależności w .mrpack: tylko Fabric jest obsługiwany; pozostałe loadery są rozpoznawane po to,
// żeby dać czytelny błąd zamiast cichego zignorowania ("paczka na Forge" nie ma wylądować jako Fabric).
const LOADER_KEYS = { 'fabric-loader': 'fabric' };
const UNSUPPORTED_LOADER_KEYS = { 'quilt-loader': 'Quilt', neoforge: 'NeoForge', forge: 'Forge' };

function compatibleLoaders(loader) {
  return [loader];
}

async function search({ query = '', type = 'mod', versions = [], loader = '', sort = 'relevance', offset = 0, limit = 20 }) {
  const facets = [[`project_type:${type}`]];
  if (versions.length) facets.push(versions.map((v) => `versions:${v}`));
  if (loader && (type === 'mod' || type === 'modpack')) {
    facets.push(compatibleLoaders(loader).map((l) => `categories:${l}`));
  }
  if (type === 'mod') facets.push(['client_side:required', 'client_side:optional']);

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    index: sort,
    offset: String(offset),
    limit: String(limit),
  });
  const data = await fetchJson(`${API}/search?${params}`);
  return {
    total: data.total_hits,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url || '',
      author: h.author,
      downloads: h.downloads,
      follows: h.follows,
      categories: h.display_categories || h.categories || [],
      type: h.project_type,
      updated: h.date_modified,
    })),
  };
}

async function project(idOrSlug) {
  const p = await cachedJson(`${API}/project/${encodeURIComponent(idOrSlug)}`);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    icon: p.icon_url || '',
    type: p.project_type,
    downloads: p.downloads,
    follows: p.followers,
    categories: p.categories,
    gameVersions: p.game_versions,
    loaders: p.loaders,
    gallery: (p.gallery || []).map((g) => g.url).slice(0, 4),
    links: {
      page: `https://modrinth.com/${p.project_type}/${p.slug}`,
      source: p.source_url || '',
      issues: p.issues_url || '',
    },
  };
}

// Krótka pamięć podręczna odczytów: te same zapytania (np. lista wersji moda przy kilku instalacjach) nie
// bombardują Modrinth - serwer ma limit zapytań na minutę i odpowiada HTTP 429.
const readCache = new Map();
const READ_TTL_MS = 90 * 1000;

async function cachedJson(url) {
  const hit = readCache.get(url);
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.value;
  const value = await fetchJson(url);
  if (readCache.size > 300) readCache.clear();
  readCache.set(url, { at: Date.now(), value });
  return value;
}

async function projectVersions(projectId, { loaders, gameVersions } = {}) {
  const params = new URLSearchParams();
  if (loaders?.length) params.set('loaders', JSON.stringify(loaders));
  if (gameVersions?.length) params.set('game_versions', JSON.stringify(gameVersions));
  const q = params.toString();
  return cachedJson(`${API}/project/${encodeURIComponent(projectId)}/version${q ? `?${q}` : ''}`);
}

function simplifyVersion(v) {
  return {
    id: v.id,
    name: v.name,
    number: v.version_number,
    type: v.version_type,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    published: v.date_published,
    downloads: v.downloads,
  };
}

async function listVersions(projectId, { loader, mcVersion, type }) {
  const loaders = type === 'mod' || type === 'modpack' ? (loader ? compatibleLoaders(loader) : []) : [];
  const versions = await projectVersions(projectId, {
    loaders,
    gameVersions: mcVersion ? [mcVersion] : [],
  });
  return versions.map(simplifyVersion);
}

async function pickVersion(projectId, instance, type) {
  const loaders = type === 'mod' ? compatibleLoaders(instance.loader) : [];
  const list = await projectVersions(projectId, { loaders, gameVersions: [instance.mcVersion] });
  const chosen = list.find((v) => v.version_type === 'release') || list[0];
  if (!chosen) {
    const suffix = type === 'mod' ? ` (${instance.loader})` : '';
    throw new Error(`Brak wersji zgodnej z ${instance.mcVersion}${suffix}.`);
  }
  return chosen;
}

async function installVersion({ instance, version, type, meta, visited, installed, onProgress }) {
  const folder = instances.contentDir(instance.id, type);
  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw new Error('Ta wersja nie zawiera plików.');
  if (path.basename(file.filename) !== file.filename) throw new Error('Niepoprawna nazwa pliku w paczce.');

  onProgress?.({ text: `Pobieranie: ${meta.title || file.filename}` });
  const dest = path.join(folder, file.filename);
  await downloadFile(file.url, dest, {
    sha1: file.hashes?.sha1,
    size: file.size,
  });

  const index = await instances.readIndex(instance.id);
  // usuń poprzednią wersję tego samego projektu
  for (const [name, m] of Object.entries(index)) {
    if (m.projectId === version.project_id && name !== file.filename) {
      await fsp.rm(path.join(folder, name), { force: true });
      await fsp.rm(path.join(folder, `${name}.disabled`), { force: true });
      delete index[name];
    }
  }
  index[file.filename] = {
    projectId: version.project_id,
    versionId: version.id,
    versionNumber: version.version_number,
    title: meta.title || file.filename,
    slug: meta.slug || '',
    icon: meta.icon || '',
    type,
    sha1: file.hashes?.sha1 || '',
    size: file.size || 0,
  };
  await instances.writeIndex(instance.id, index);
  installed.push({ title: meta.title || file.filename, file: file.filename });

  if (type !== 'mod') return;
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    if (visited.has(dep.project_id)) continue;
    visited.add(dep.project_id);

    const current = await instances.readIndex(instance.id);
    if (Object.values(current).some((m) => m.projectId === dep.project_id)) continue;

    const depProject = await fetchJson(`${API}/project/${dep.project_id}`);
    const depVersion = dep.version_id
      ? await fetchJson(`${API}/version/${dep.version_id}`)
      : await pickVersion(dep.project_id, instance, 'mod');
    await installVersion({
      instance,
      version: depVersion,
      type: 'mod',
      meta: { title: depProject.title, slug: depProject.slug, icon: depProject.icon_url || '' },
      visited,
      installed,
      onProgress,
    });
  }
}

// ---- rozpoznawanie zainstalowanych plików (po sumie SHA-1) --------------------------------------

const CONTENT_EXT = { mod: /\.jar$/i, resourcepack: /\.zip$/i, shader: /\.zip$/i };

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Zamienia pliki (type, filename, sha1) na wpisy indeksu instancji z danymi z Modrinth:
 * projekt, wersja, tytuł i ikona. Dzięki temu lista modów ma ładne nazwy i ikony, a przeglądarka
 * wie, co już jest zainstalowane.
 */
async function identifyByHashes(instanceId, entries) {
  if (!entries.length) return { identified: 0, unknown: 0 };

  const hashes = [...new Set(entries.map((e) => e.sha1))];
  const found = {};
  for (const part of chunks(hashes, 100)) {
    const res = await fetchJson(`${API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: part, algorithm: 'sha1' }),
    });
    Object.assign(found, res);
  }

  const projectIds = [...new Set(Object.values(found).map((v) => v.project_id))];
  const projects = {};
  for (const part of chunks(projectIds, 50)) {
    const list = await fetchJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(part))}`);
    for (const p of list) projects[p.id] = p;
  }

  const index = await instances.readIndex(instanceId);
  let identified = 0;
  let unknown = 0;
  for (const e of entries) {
    const v = found[e.sha1];
    if (v) {
      const p = projects[v.project_id];
      index[e.filename] = {
        projectId: v.project_id,
        versionId: v.id,
        versionNumber: v.version_number,
        title: p?.title || index[e.filename]?.title || e.filename,
        slug: p?.slug || '',
        icon: p?.icon_url || '',
        type: e.type,
        sha1: e.sha1,
        size: e.size,
      };
      identified++;
    } else {
      // plik spoza Modrinth - zapamiętujemy, żeby nie liczyć sumy przy każdym otwarciu
      index[e.filename] = { ...(index[e.filename] || {}), sha1: e.sha1, size: e.size, unmatched: true };
      unknown++;
    }
  }
  await instances.writeIndex(instanceId, index);
  return { identified, unknown };
}

/**
 * Usuwa z indeksu wpisy „duchy”: instancja ma wpis (np. nowa wersja moda), ale pliku nie ma w folderze (ani
 * jako `.disabled`) - ktoś go skasował albo instalacja się nie dokończyła. Taki wpis udawał „już zainstalowane”:
 * „Aktualizuj” nic nie pobierało, a sprawdzenie aktualizacji znów pokazywało to samo.
 */
async function pruneGhosts(instanceId) {
  const index = await instances.readIndex(instanceId);
  let changed = false;
  for (const [name, meta] of Object.entries(index)) {
    const type = meta?.type;
    if (!CONTENT_EXT[type]) continue;
    const dir = instances.contentDir(instanceId, type);
    if ((await exists(path.join(dir, name))) || (await exists(path.join(dir, `${name}.disabled`)))) continue;
    delete index[name];
    changed = true;
  }
  if (changed) await instances.writeIndex(instanceId, index);
  return changed;
}

/** Rozpoznaje w instancji pliki, których jeszcze nie znamy (mody, paczki zasobów, shadery). */
async function identifyInstance(instanceId) {
  await pruneGhosts(instanceId);
  const index = await instances.readIndex(instanceId);
  const entries = [];

  for (const [type, ext] of Object.entries(CONTENT_EXT)) {
    const dir = instances.contentDir(instanceId, type);
    let files = [];
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const base = f.name.replace(/\.disabled$/i, '');
      if (!ext.test(base)) continue;
      const known = index[base];
      const full = path.join(dir, f.name);
      const size = (await fsp.stat(full)).size;
      if (known?.projectId && known.size === size) continue; // już rozpoznany
      if (known?.unmatched && known.size === size) continue; // sprawdzony, nie ma go w Modrinth
      if (known?.projectId && !known.size) {
        // wpis z instalacji przez launcher - uzupełnij tylko rozmiar, bez ponownego pytania Modrinth
        index[base] = { ...known, size };
        continue;
      }
      entries.push({ type, filename: base, sha1: await hashFile(full, 'sha1'), size });
    }
  }
  await instances.writeIndex(instanceId, index);
  return identifyByHashes(instanceId, entries);
}

/** Identyfikatory projektów zainstalowanych w instancji (po typach). */
async function installedProjects(instanceId, { identify = true } = {}) {
  let result = { identified: 0, unknown: 0 };
  if (identify) {
    try {
      result = await identifyInstance(instanceId);
    } catch {
      /* brak internetu - korzystamy z tego, co już wiemy */
    }
  }
  const index = await instances.readIndex(instanceId);
  const out = { mod: [], resourcepack: [], shader: [] };
  for (const meta of Object.values(index)) {
    if (meta.projectId && out[meta.type]) out[meta.type].push(meta.projectId);
  }
  return { ...out, ...result };
}

/** Instaluje mod / paczkę zasobów / shader do instancji (mody razem z wymaganymi zależnościami). */
async function installContent({ instanceId, projectId, versionId, type, title, slug, icon }, onProgress) {
  const instance = await instances.get(instanceId);
  if (type === 'mod' && instance.loader !== 'fabric') {
    throw new Error('Mody można instalować tylko w instancjach Fabric.');
  }

  // Najpierw rozpoznaj to, co już leży w folderze (np. po imporcie paczki) - żeby nie dublować.
  try {
    await identifyInstance(instanceId);
  } catch {
    /* offline: zostaje sam indeks */
  }
  // „już zainstalowane” tylko wtedy, gdy plik naprawdę leży w folderze (po pruneGhosts w identifyInstance)
  const folder = instances.contentDir(instanceId, type);
  let already = null;
  for (const entry of Object.entries(await instances.readIndex(instanceId))) {
    if (entry[1].projectId !== projectId) continue;
    if ((await exists(path.join(folder, entry[0]))) || (await exists(path.join(folder, `${entry[0]}.disabled`)))) {
      already = entry;
      break;
    }
  }

  const version = versionId
    ? await fetchJson(`${API}/version/${versionId}`)
    : await pickVersion(projectId, instance, type);

  if (already && already[1].versionId === version.id) {
    return { installed: [], already: true, title: already[1].title || title };
  }

  const installed = [];
  await installVersion({
    instance,
    version,
    type,
    meta: { title, slug, icon },
    visited: new Set([projectId]),
    installed,
    onProgress,
  });
  // dwa jary tego samego moda (np. stara wersja spoza indeksu albo fork pod inną nazwą) zawieszają start gry
  let deduped = [];
  if (type === 'mod') {
    try {
      deduped = await modCheck.dedupe(instanceId);
    } catch {
      /* kontrola jest dodatkowa */
    }
  }
  return { installed, deduped };
}

/** Importuje paczkę modów (.mrpack) z Modrinth jako nową instancję. */
async function installModpack({ projectId, versionId, title }, onProgress) {
  let version;
  if (versionId) {
    version = await fetchJson(`${API}/version/${versionId}`);
  } else {
    // najnowsza wersja paczki, która celuje w obsługiwany przez launcher Minecraft
    const supported = new Set((await mojang.listVersions()).map((v) => v.id));
    const compatible = (await projectVersions(projectId, {})).filter((v) =>
      v.game_versions.some((g) => supported.has(g)),
    );
    version = compatible.find((v) => v.version_type === 'release') || compatible[0];
  }
  if (!version) {
    throw new Error(`Ta paczka nie ma wersji dla Minecrafta ${mojang.MIN_VERSION} – ${mojang.MAX_VERSION}.`);
  }

  const file = version.files.find((f) => f.primary) || version.files[0];
  const packFile = path.join(paths.cache(), 'modpacks', file.filename);
  onProgress?.({ text: 'Pobieranie paczki modów' });
  await downloadFile(file.url, packFile, { sha1: file.hashes?.sha1, size: file.size });
  return importMrpackFile(packFile, { fallbackName: title }, onProgress);
}

// Zgodnie ze specyfikacją .mrpack pliki wolno pobierać tylko z tych hostów (po HTTPS).
const PACK_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);

function checkPackUrl(raw, filePath) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Niepoprawny adres pobierania w paczce: ${filePath}`);
  }
  if (url.protocol !== 'https:' || !PACK_HOSTS.has(url.hostname)) {
    throw new Error(`Paczka próbuje pobierać pliki z niedozwolonego hosta (${url.hostname}): ${filePath}`);
  }
  return url.href;
}

/**
 * Tworzy nową instancję z pliku .mrpack leżącego na dysku
 * (pobranego z Modrinth, wyeksportowanego z innego launchera albo dostarczonego przez znajomego).
 */
async function importMrpackFile(packFile, { fallbackName = 'Paczka modów' } = {}, onProgress) {
  let zip;
  let index;
  try {
    zip = new AdmZip(packFile);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('brak modrinth.index.json');
    index = JSON.parse(indexEntry.getData().toString('utf8'));
  } catch (e) {
    throw new Error(`To nie jest poprawny plik .mrpack (${e.message}).`);
  }
  if (index.formatVersion !== 1 || index.game !== 'minecraft') {
    throw new Error('Nieobsługiwany format paczki .mrpack (oczekiwano formatVersion 1 dla Minecrafta).');
  }

  const deps = index.dependencies || {};
  const mc = deps.minecraft;
  if (!mc) throw new Error('Paczka nie podaje wersji Minecrafta.');
  if (!(await mojang.isSupportedVersion(mc))) {
    throw new Error(
      `Ta paczka wymaga Minecrafta ${mc}, a CrownLauncher obsługuje ${mojang.MIN_VERSION} – ${mojang.MAX_VERSION}.`,
    );
  }
  for (const [key, label] of Object.entries(UNSUPPORTED_LOADER_KEYS)) {
    if (deps[key]) {
      throw new Error(`Ta paczka wymaga loadera ${label}, a CrownLauncher obsługuje tylko Fabric.`);
    }
  }
  // paczka bez loadera (np. czysta paczka zasobów) też staje się instancją Fabric - loader dobierze się sam
  let loader = 'fabric';
  let loaderVersion = '';
  for (const [key, name] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) {
      loader = name;
      loaderVersion = deps[key];
    }
  }

  onProgress?.({ text: 'Tworzenie instancji' });
  const instance = await instances.create({
    name: String(index.name || fallbackName).trim().slice(0, 40) || fallbackName,
    mcVersion: mc,
    loader,
    loaderVersion,
  });
  const gameDir = paths.gameDir(instance.id);

  // pliki z paczki
  const files = (index.files || []).filter((f) => f.env?.client !== 'unsupported');
  let done = 0;
  try {
    await pool(files, 8, async (f) => {
      const dest = path.join(gameDir, f.path);
      if (!isInside(gameDir, dest)) throw new Error(`Niebezpieczna ścieżka w paczce: ${f.path}`);
      const raw = (f.downloads || [])[0];
      if (!raw) throw new Error(`Brak adresu pobierania: ${f.path}`);
      if (!f.hashes?.sha1) throw new Error(`Brak sumy SHA-1 w paczce: ${f.path}`);
      await downloadFile(checkPackUrl(raw, f.path), dest, { sha1: f.hashes.sha1, size: f.fileSize });
      onProgress?.({ text: `Pobieranie modów ${++done}/${files.length}` });
    });

    // overrides (konfiguracje, paczki zasobów itd.)
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const m = /^(overrides|client-overrides)\/(.+)$/.exec(entry.entryName);
      if (!m || entry.header.size > 1024 ** 3) continue;
      const dest = path.join(gameDir, m[2]);
      if (!isInside(gameDir, dest)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
    }

    // gotowa paczka ma własny, dobrany zestaw modów - nie dokładamy do niej niczego od siebie
    await instances.update(instance.id, { perfModsApplied: true });
  } catch (e) {
    await instances.remove(instance.id).catch(() => {});
    throw e;
  }

  // Zapisz, jakimi projektami z Modrinth są pliki paczki (nazwa, ikona, "zainstalowano").
  // Sumy SHA-1 znamy z indeksu paczki, więc nie trzeba ich liczyć. Błąd sieci nie psuje importu.
  try {
    onProgress?.({ text: 'Rozpoznawanie modów' });
    const known = [];
    for (const f of files) {
      const dir = f.path.split('/')[0];
      const type = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' }[dir];
      if (!type || f.path.split('/').length !== 2) continue;
      known.push({ type, filename: path.basename(f.path), sha1: f.hashes.sha1, size: f.fileSize });
    }
    await identifyByHashes(instance.id, known);
    // pliki z overrides (jeśli są) rozpozna się przy pierwszym otwarciu zakładki
  } catch {
    /* zostanie rozpoznane później */
  }

  return instance;
}

// ---- aktualizacje zainstalowanych modów --------------------------------------------------------------------

const CHANNEL_RANK = { release: 3, beta: 2, alpha: 1 };
const rank = (type) => CHANNEL_RANK[type] || 0;

/** Wiele projektów naraz (jedno zapytanie). Zwraca mapę slug/id -> { id, slug, title, icon }. */
async function projects(idsOrSlugs) {
  const out = {};
  const list = [...new Set(idsOrSlugs)];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const data = await fetchJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`);
    for (const p of data) {
      const info = { id: p.id, slug: p.slug, title: p.title, icon: p.icon_url || '' };
      out[p.id] = info;
      out[p.slug] = info;
    }
  }
  return out;
}

/**
 * Które z zainstalowanych modów (rozpoznanych w Modrinth) mają nowszą wersję dla gry tej instancji.
 * Nowsza wersja musi być co najmniej tak stabilna jak obecna (z wydania nie przeskakujemy na alphę).
 * Mody ukryte i zarządzane przez launcher (CustomSkinLoader) nie są sprawdzane.
 */
async function checkUpdates(instanceId) {
  readCache.clear(); // sprawdzenie ma pokazać aktualny stan Modrinth, nie wynik sprzed chwili
  const instance = await instances.get(instanceId);
  if (instance.loader !== 'fabric') return [];
  try {
    await identifyInstance(instanceId);
  } catch {
    /* offline: sprawdzamy to, co jest w indeksie */
  }
  const index = await instances.readIndex(instanceId);
  const dir = instances.contentDir(instanceId, 'mod');
  const present = new Set((await fsp.readdir(dir).catch(() => [])).map((f) => f.replace(/\.disabled$/i, '')));
  const mods = Object.entries(index).filter(
    ([file, m]) => m.projectId && m.versionId && present.has(file) && !/customskinloader/i.test(`${file} ${m.slug || ''}`),
  );

  // jedno zbiorcze zapytanie (SHA-1) mówi, które mody są już w najnowszej wersji - dla nich nie pytamy osobno
  const latestByHash = {};
  const hashes = [...new Set(mods.map(([, m]) => m.sha1).filter(Boolean))];
  for (const part of chunks(hashes, 100)) {
    try {
      const res = await fetchJson(`${API}/version_files/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: part, algorithm: 'sha1', loaders: ['fabric'], game_versions: [instance.mcVersion] }),
      });
      Object.assign(latestByHash, res);
    } catch {
      /* zostaje sprawdzanie osobno dla każdego moda */
    }
  }

  const updates = [];
  await pool(mods, 3, async ([file, m]) => {
    if (m.sha1 && latestByHash[m.sha1]?.id === m.versionId) return; // już najnowsza
    let list;
    try {
      list = await projectVersions(m.projectId, { loaders: ['fabric'], gameVersions: [instance.mcVersion] });
    } catch {
      return; // brak sieci dla jednego projektu nie przerywa sprawdzania pozostałych
    }
    if (!list.length) return;
    const currentIdx = list.findIndex((v) => v.id === m.versionId);
    const current = currentIdx >= 0 ? list[currentIdx] : null;
    const minRank = current ? rank(current.version_type) : 1;
    // najnowsze wydanie co najmniej tak stabilne jak obecne (lista jest od najnowszego)
    const candidates = list.filter((v) => rank(v.version_type) >= minRank);
    // znana obecna wersja: najnowsza nie mniej stabilna od niej; nieznana: najlepsze wydanie (release > beta > alpha)
    const best = current
      ? candidates[0]
      : list.find((v) => v.version_type === 'release') || list.find((v) => v.version_type === 'beta') || list[0];

    if (!best || best.id === m.versionId) return;
    // gdy obecna wersja jest na liście, nowsza musi stać przed nią (nie proponujemy cofania)
    if (currentIdx >= 0 && list.indexOf(best) >= currentIdx) return;
    const file0 = best.files.find((f) => f.primary) || best.files[0];
    if (file0?.hashes?.sha1 && file0.hashes.sha1 === m.sha1) return;
    updates.push({
      file,
      projectId: m.projectId,
      title: m.title || file,
      icon: m.icon || '',
      slug: m.slug || '',
      current: m.versionNumber || '',
      latest: { id: best.id, number: best.version_number, type: best.version_type, published: best.date_published },
    });
  });
  return updates.sort((a, b) => a.title.localeCompare(b.title));
}

/** Aktualizuje jeden mod do wskazanej (albo najnowszej zgodnej) wersji; zachowuje stan włączony/wyłączony. */
async function updateMod(instanceId, file, versionId = '') {
  const dir = instances.contentDir(instanceId, 'mod');
  const base = file.replace(/\.disabled$/i, '');
  const index = await instances.readIndex(instanceId);
  const meta = index[base];
  if (!meta?.projectId) throw new Error('Ten mod nie jest rozpoznany w Modrinth - nie da się go zaktualizować.');
  const wasDisabled = await fsp
    .access(path.join(dir, `${base}.disabled`))
    .then(() => true)
    .catch(() => false);

  let target = versionId;
  if (!target) {
    const found = (await checkUpdates(instanceId)).find((u) => u.file === base);
    if (!found) return { updated: false, title: meta.title || base };
    target = found.latest.id;
  }
  const res = await installContent({
    instanceId,
    projectId: meta.projectId,
    versionId: target,
    type: 'mod',
    title: meta.title,
    slug: meta.slug,
    icon: meta.icon,
  });
  // plik tej wersji już leżał w folderze - nic nie pobrano, więc nie raportujemy „zaktualizowano”
  if (res.already) return { updated: false, title: meta.title || base, installed: [], deduped: [] };
  if (wasDisabled) {
    // nowy plik jest włączony - przywracamy stan sprzed aktualizacji
    const after = await instances.readIndex(instanceId);
    const fresh = Object.entries(after).find(([name, m]) => m.projectId === meta.projectId && name !== base);
    if (fresh) await instances.toggleContent(instanceId, 'mod', fresh[0]).catch(() => {});
  }
  return { updated: true, title: meta.title || base, installed: res.installed || [], deduped: res.deduped || [] };
}

/** Aktualizuje wszystkie mody, dla których jest nowsza wersja. Błędy pojedynczych modów nie przerywają reszty. */
async function updateAll(instanceId) {
  const list = await checkUpdates(instanceId);
  const updated = [];
  const failed = [];
  const deduped = [];
  for (const u of list) {
    try {
      const r = await updateMod(instanceId, u.file, u.latest.id);
      if (r.updated) updated.push(u.title);
      deduped.push(...(r.deduped || []));
    } catch (e) {
      failed.push({ title: u.title, error: e.message });
    }
  }
  return { updated, failed, deduped };
}

module.exports = {
  search,
  project,
  projects,
  checkUpdates,
  updateMod,
  updateAll,
  listVersions,
  installContent,
  installModpack,
  importMrpackFile,
  identifyInstance,
  installedProjects,
};
