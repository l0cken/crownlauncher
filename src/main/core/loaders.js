const path = require('path');
const paths = require('./paths');
const { fetchJson, exists, writeJson } = require('./util');

const FABRIC_META = 'https://meta.fabricmc.net/v2';

// Launcher obsługuje tylko Fabric (CrownClient i peleryny są modami Fabrica).
const LOADERS = ['fabric'];

async function listLoaderVersions(loader, mc) {
  if (loader !== 'fabric') return [];
  const data = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`);
  return data.map((d) => ({ version: d.loader.version, stable: Boolean(d.loader.stable) }));
}

async function ensureProfileJson(baseUrl, prefix, mc, loaderVersion) {
  const predicted = `${prefix}-loader-${loaderVersion}-${mc}`;
  const file = path.join(paths.versionDir(predicted), `${predicted}.json`);
  if (await exists(file)) return predicted;
  const profile = await fetchJson(
    `${baseUrl}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`,
  );
  await writeJson(path.join(paths.versionDir(profile.id), `${profile.id}.json`), profile);
  return profile.id;
}

/**
 * Zapewnia pliki loadera dla instancji i zwraca id wersji do uruchomienia.
 */
async function ensureLoader(instance, javaExe, onProgress = () => {}) {
  const { loader, mcVersion: mc, loaderVersion } = instance;
  if (loader === 'fabric') return ensureProfileJson(FABRIC_META, 'fabric', mc, loaderVersion);
  throw new Error(
    `Loader „${loader}” nie jest już obsługiwany — launcher działa tylko z Fabric. Utwórz nową instancję.`,
  );
}

module.exports = { LOADERS, listLoaderVersions, ensureLoader };
