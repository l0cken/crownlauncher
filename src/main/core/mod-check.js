const fsp = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { satisfies } = require('./bundled-mods');
const instances = require('./instances');

/**
 * Kontrola zgodności modów Fabric przed startem gry - to, co zrobiłby Fabric Loader („Some of your mods are
 * incompatible…”), ale zanim gra się uruchomi i bez okna z błędem.
 *
 * Czytamy `fabric.mod.json` z każdego jara (i z jarów zagnieżdżonych - jar-in-jar, np. moduły Fabric API albo
 * natywne moduły C2ME) i sprawdzamy: wersję Minecrafta, wersję Javy, wersję loadera, zależności od innych modów
 * (z wersją) i deklaracje `breaks`.
 */

const cache = new Map(); // `${plik}:${rozmiar}:${mtime}` -> info

const stripBom = (s) => s.replace(/^﻿/, '');

function asSpec(value) {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value : '*';
}

function toMap(obj) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [id, spec] of Object.entries(obj)) out[id] = asSpec(spec);
  }
  return out;
}

function infoFromMeta(meta) {
  return {
    id: String(meta.id || ''),
    version: String(meta.version || ''),
    provides: Array.isArray(meta.provides) ? meta.provides.map(String) : [],
    depends: toMap(meta.depends),
    breaks: toMap(meta.breaks),
    nested: [],
  };
}

function readMeta(zip) {
  const entry = zip.getEntry('fabric.mod.json');
  if (!entry) return null;
  try {
    return JSON.parse(stripBom(entry.getData().toString('utf8')));
  } catch {
    return null;
  }
}

/** Informacje o modzie z jara (albo null, gdy to nie mod Fabric / plik uszkodzony). */
async function inspectJar(file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  const key = `${file}:${st.size}:${Math.floor(st.mtimeMs)}`;
  if (cache.has(key)) return cache.get(key);
  let info = null;
  try {
    const zip = new AdmZip(file);
    const meta = readMeta(zip);
    if (meta) {
      info = infoFromMeta(meta);
      for (const j of Array.isArray(meta.jars) ? meta.jars : []) {
        const entry = j?.file ? zip.getEntry(j.file) : null;
        if (!entry) continue;
        try {
          const nestedMeta = readMeta(new AdmZip(entry.getData()));
          if (nestedMeta) info.nested.push(infoFromMeta(nestedMeta));
        } catch {
          /* uszkodzony jar zagnieżdżony - pomijamy */
        }
      }
    }
  } catch {
    info = null;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, info);
  return info;
}

/** Wszystkie mody (jary) z katalogu mods instancji: Map plik -> info. Wyłączone (.disabled) są pomijane. */
async function scanDirectory(dir) {
  const out = new Map();
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!/\.jar$/i.test(f)) continue;
    const info = await inspectJar(path.join(dir, f));
    if (info) out.set(f, info);
  }
  return out;
}

/** Mapa id -> wersja wszystkiego, co jest dostępne (mody, moduły zagnieżdżone, aliasy `provides`). */
function providedIds(infos) {
  const provided = new Map();
  const add = (info) => {
    if (info.id) provided.set(info.id, info.version);
    for (const alias of info.provides) provided.set(alias, info.version);
  };
  for (const info of infos) {
    add(info);
    for (const n of info.nested) add(n);
  }
  return provided;
}

const BASE_IDS = new Set(['minecraft', 'java', 'fabricloader']);
// zapewnia je sam Fabric Loader (wbudowane) - nie ma ich w katalogu mods, a wersja jest nowsza niż w jarach
const LOADER_BUILTIN = new Set(['mixinextras', 'mixin']);

/**
 * Problemy tego moda w danym środowisku. `env`: { minecraft, java, fabricloader }; `provided`: wynik
 * providedIds() dla wszystkich modów instancji (także tego). Każdy problem: { text, kind, other } -
 * kind: 'depends' (zła wersja zależności/Minecrafta/Javy), 'missing' (brak wymaganego moda),
 * 'breaks' (deklarowana niezgodność z modem `other`).
 */
function problemsFor(info, env, provided) {
  const out = [];
  const check = (m, prefix) => {
    for (const [dep, spec] of Object.entries(m.depends)) {
      if (LOADER_BUILTIN.has(dep)) continue;
      const have = BASE_IDS.has(dep) ? env[dep] : provided.get(dep);
      if (have === undefined || have === null || have === '') {
        if (BASE_IDS.has(dep)) continue; // brak informacji o środowisku - nie zgadujemy
        out.push({ text: `${prefix}wymaga moda ${dep}, którego nie ma`, kind: 'missing', other: dep });
        continue;
      }
      if (!satisfies(String(have), spec)) {
        out.push({ text: `${prefix}wymaga ${dep} ${[].concat(spec).join(' lub ')} (jest ${have})`, kind: 'depends', other: dep });
      }
    }
    for (const [other, spec] of Object.entries(m.breaks)) {
      const have = provided.get(other);
      if (have !== undefined && other !== m.id && satisfies(String(have), spec)) {
        out.push({ text: `${prefix}jest niezgodny z modem ${other}`, kind: 'breaks', other });
      }
    }
  };
  check(info, '');
  for (const n of info.nested) check(n, `moduł ${n.id}: `);
  return out;
}

/** Sprawdza wskazane pliki w katalogu mods. Zwraca { bad: Map plik -> [problemy], all, provided }. */
async function validate(dir, files, env) {
  const all = await scanDirectory(dir);
  const provided = providedIds([...all.values()]);
  const bad = new Map();
  for (const f of files) {
    const info = all.get(f);
    if (!info) continue;
    const reasons = problemsFor(info, env, provided);
    if (reasons.length) bad.set(f, reasons);
  }
  return { bad, all, provided };
}

/** Porównanie wersji po liczbach (część przed „+”): 0.8.14+mc1.21 -> [0, 8, 14]. */
function compareVersions(a, b) {
  const nums = (v) => (String(v).split('+')[0].match(/\d+/g) || []).map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Usuwa zdublowane mody: dwa jary z tym samym `id` (stara i nowa wersja po aktualizacji, ModernFix i jego
 * fork itp.) - Fabric odmawia startu z „duplicate mod”. Zostaje najnowsza wersja (przy remisie nowszy plik),
 * reszta jest kasowana razem z wpisem w indeksie. Zwraca [{ id, file, version, kept, title }].
 */
async function dedupe(instanceId) {
  const dir = instances.contentDir(instanceId, 'mod');
  const all = await scanDirectory(dir);
  const byId = new Map();
  for (const [file, info] of all) {
    if (!info.id) continue;
    if (!byId.has(info.id)) byId.set(info.id, []);
    byId.get(info.id).push({ file, info });
  }
  const index = await instances.readIndex(instanceId);
  const removed = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const withTime = [];
    for (const x of list) {
      let mtime = 0;
      try {
        mtime = (await fsp.stat(path.join(dir, x.file))).mtimeMs;
      } catch {
        /* plik zniknął */
      }
      withTime.push({ ...x, mtime });
    }
    withTime.sort((a, b) => compareVersions(b.info.version, a.info.version) || b.mtime - a.mtime);
    const [keep, ...drop] = withTime;
    for (const d of drop) {
      try {
        await instances.deleteContent(instanceId, 'mod', d.file);
      } catch {
        continue;
      }
      removed.push({ id, file: d.file, version: d.info.version, kept: keep.file, title: index[d.file]?.title || id });
    }
  }
  return removed;
}

module.exports = { inspectJar, scanDirectory, providedIds, problemsFor, validate, dedupe, compareVersions };
