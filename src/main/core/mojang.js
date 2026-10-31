const os = require('os');
const path = require('path');
const paths = require('./paths');
const { fetchJson, downloadFile, exists, readJson, writeJson } = require('./util');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// Zakres wersji obsługiwanych przez launcher (włącznie).
const MIN_VERSION = '1.21.4';
const MAX_VERSION = '26.3';

let manifestCache = null;

async function getManifest() {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
  const file = path.join(paths.cache(), 'version_manifest_v2.json');
  try {
    const data = await fetchJson(MANIFEST_URL);
    await writeJson(file, data);
    manifestCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    // tryb offline: ostatnio zapisany manifest
    if (await exists(file)) {
      const data = await readJson(file);
      manifestCache = { at: Date.now() - 9 * 60 * 1000, data };
      return data;
    }
    throw e;
  }
}

// Wydania od MAX_VERSION w dół do MIN_VERSION (kolejność z manifestu: najnowsze pierwsze).
async function listVersions() {
  const manifest = await getManifest();
  const releases = manifest.versions.filter((v) => v.type === 'release');
  const hi = releases.findIndex((v) => v.id === MAX_VERSION);
  const lo = releases.findIndex((v) => v.id === MIN_VERSION);
  const slice = releases.slice(hi >= 0 ? hi : 0, lo >= 0 ? lo + 1 : undefined);
  return slice.map(({ id, releaseTime }) => ({ id, releaseTime }));
}

async function isSupportedVersion(id) {
  return (await listVersions()).some((v) => v.id === id);
}

async function getVanillaJson(id) {
  const file = path.join(paths.versionDir(id), `${id}.json`);
  if (await exists(file)) return readJson(file);
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Nieznana wersja Minecrafta: ${id}`);
  await downloadFile(entry.url, file, { sha1: entry.sha1 });
  return readJson(file);
}

// ---- reguły (rules) ----------------------------------------------------

function osName() {
  return { win32: 'windows', darwin: 'osx' }[process.platform] || process.platform;
}

function osArch() {
  return { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[process.arch] || process.arch;
}

function ruleMatches(rule, features = {}) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName()) return false;
    if (rule.os.arch && rule.os.arch !== osArch()) return false;
    if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) return false;
  }
  if (rule.features) {
    for (const [key, want] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== want) return false;
    }
  }
  return true;
}

// Brak reguł = dozwolone; w przeciwnym razie ostatnia pasująca reguła decyduje.
function rulesAllow(rules, features) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

// ---- dziedziczenie (inheritsFrom) -------------------------------------

function libKey(lib) {
  const [group, artifact, , classifier] = lib.name.split('@')[0].split(':');
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}

function mergeVersions(parent, child) {
  const seen = new Set();
  const libraries = [];
  // biblioteki dziecka mają pierwszeństwo przed rodzicem
  for (const lib of [...(child.libraries || []), ...(parent.libraries || [])]) {
    const key = libKey(lib);
    if (seen.has(key)) continue;
    seen.add(key);
    libraries.push(lib);
  }
  return {
    ...parent,
    ...child,
    libraries,
    arguments: {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    },
  };
}

/**
 * Wczytuje wersję o danym id (vanilla lub profil loadera) i scala łańcuch inheritsFrom.
 * Zwraca scalony JSON oraz id bazowej wersji vanilla (do pliku .jar klienta).
 */
async function resolveVersion(id) {
  const file = path.join(paths.versionDir(id), `${id}.json`);
  const raw = (await exists(file)) ? await readJson(file) : await getVanillaJson(id);
  if (!raw.inheritsFrom) return { ...raw, _baseId: raw.id };
  const parent = await resolveVersion(raw.inheritsFrom);
  const merged = mergeVersions(parent, raw);
  merged._baseId = parent._baseId;
  merged.id = raw.id;
  return merged;
}

module.exports = {
  MIN_VERSION,
  MAX_VERSION,
  getManifest,
  listVersions,
  isSupportedVersion,
  getVanillaJson,
  rulesAllow,
  resolveVersion,
  osName,
  osArch,
};
