const fsp = require('fs').promises;
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');
const modrinth = require('./modrinth');
const { readJson, writeJson } = require('./util');

/**
 * Automatyczne naprawianie awarii na podstawie wyniku crash-analyzer.js.
 *
 * Dla każdego pewnego podejrzanego (komunikat Fabric Loadera, błąd mixinu, punkt wejścia, raport awarii)
 * launcher próbuje po kolei:
 *   1. brakująca zależność        -> doinstalowanie jej z Modrinth,
 *   2. zależność jest za stara    -> aktualizacja tej zależności (np. Fabric API),
 *   3. zły mod / zła wersja gry   -> nowsza wersja tego moda (jeśli Modrinth ma),
 *   4. nic nie pomaga             -> wyłączenie moda (plik dostaje .disabled; da się cofnąć).
 * Niezgodność z Javą albo z innym modem od razu kończy się wyłączeniem. Loader, Fabric API, renderer
 * (Sodium/VulkanMod) i CrownClient nie są wyłączane - wtedy schodzi druga strona konfliktu.
 * Ślady stosu (słabe wskazanie) niczego nie naprawiają - są tylko podpowiedzią w oknie awarii.
 */

const MIN_SCORE = 85; // próg „pewności”: raport awarii (85) i wyżej
const MAX_FIXES = 6;
const PROTECTED = new Set([
  'fabric-api', 'fabricloader', 'fabric-loader', 'java', 'minecraft', 'crownclient', 'customskinloader', 'sodium', 'vulkanmod',
]);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const historyFile = (instanceId) => path.join(paths.instanceDir(instanceId), 'crash-fixes.json');

/** Co launcher już naprawiał w tej instancji (żeby nie krążyć: doinstaluj -> awaria -> wyłącz -> doinstaluj…). */
async function loadHistory(instanceId) {
  try {
    const data = await readJson(historyFile(instanceId));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveHistory(instanceId, history) {
  try {
    await writeJson(historyFile(instanceId), history);
  } catch {
    /* historia jest dodatkiem */
  }
}

const baseName = (file) => String(file || '').replace(/\.disabled$/i, '');

async function disable(ctx, target, why) {
  const exists = await fsp
    .access(path.join(ctx.modsDir, target.file))
    .then(() => true)
    .catch(() => false);
  if (!exists) return null;
  await instances.toggleContent(ctx.instanceId, 'mod', target.file);
  ctx.history[target.id] = { ...(ctx.history[target.id] || {}), disabled: true, file: target.file, at: Date.now() };
  return { action: 'disabled', id: target.id, name: target.name, file: target.file, note: why };
}

/** Wyłączany jest podejrzany; gdy jest chroniony (renderer, loader), drugi mod konfliktu. */
function pickTarget(s) {
  if (s.file && !PROTECTED.has(s.id)) return { id: s.id, name: s.name, file: s.file };
  if (s.other?.file && !PROTECTED.has(s.other.id)) return { id: s.other.id, name: s.other.title || s.other.id, file: s.other.file };
  return null;
}

async function updatesOnce(ctx) {
  if (!ctx.updates) {
    ctx.updates = modrinth.checkUpdates(ctx.instanceId).catch(() => []);
  }
  return ctx.updates;
}

async function updateFile(ctx, id, file, name) {
  if (!file || (PROTECTED.has(id) && id !== 'fabric-api')) return null;
  if (ctx.history[id]?.updated) return null; // już raz aktualizowany, a dalej się sypie - wtedy wyłączamy
  const list = await updatesOnce(ctx);
  const found = list.find((u) => u.file === baseName(file));
  if (!found) return null;
  try {
    await modrinth.updateMod(ctx.instanceId, baseName(file), found.latest.id);
  } catch {
    return null;
  }
  ctx.history[id] = { ...(ctx.history[id] || {}), updated: true, at: Date.now() };
  // plik moda się zmienił - kolejne wyszukiwania aktualizacji muszą go zobaczyć od nowa
  ctx.updates = null;
  return { action: 'updated', id, name, file: baseName(file), note: `zaktualizowano do wersji ${found.latest.number}` };
}

async function installDependency(ctx, dep) {
  if (ctx.history[dep.id]?.installed || ctx.history[dep.id]?.disabled) return null;
  let hits;
  try {
    hits = (await modrinth.search({ query: dep.title || dep.id, versions: [ctx.instance.mcVersion], loader: 'fabric', limit: 8 })).hits;
  } catch {
    return null;
  }
  const want = new Set([norm(dep.id), norm(dep.title)]);
  const hit = hits.find((h) => want.has(norm(h.slug)) || want.has(norm(h.title)));
  if (!hit) return null;
  try {
    await modrinth.installContent({ instanceId: ctx.instanceId, projectId: hit.id, type: 'mod', title: hit.title, slug: hit.slug, icon: hit.icon });
  } catch {
    return null;
  }
  ctx.history[dep.id] = { ...(ctx.history[dep.id] || {}), installed: true, at: Date.now() };
  ctx.updates = null;
  return { action: 'installed', id: dep.id, name: hit.title, file: '', note: 'doinstalowano brakujący mod' };
}

async function fixOne(ctx, s) {
  const kinds = new Set(s.kinds?.length ? s.kinds : [s.kind]);
  const hard = kinds.has('java') || kinds.has('incompatible'); // aktualizacja tego nie naprawia

  if (kinds.has('dependency') && s.dep) {
    const r = await installDependency(ctx, s.dep);
    if (r) return { ...r, requiredBy: s.name };
  }
  if (kinds.has('dependency-version') && s.dep?.tooOld) {
    const r = await updateFile(ctx, s.dep.id, s.dep.file, s.dep.title || s.dep.id);
    if (r) return { ...r, requiredBy: s.name };
  }
  if (!hard) {
    const r = await updateFile(ctx, s.id, s.file, s.name);
    if (r) return r;
  }
  const target = pickTarget(s);
  if (!target) return null;
  return disable(ctx, target, s.reason);
}

/**
 * Naprawia awarię. Zwraca { fixed: [{ action, id, name, file, note, requiredBy? }], skipped: [{ id, name, why }] }.
 * `fixed[].action`: 'disabled' | 'updated' | 'installed'.
 */
async function fix(instanceId, analysis) {
  const out = { fixed: [], skipped: [] };
  const sure = (analysis.suspects || []).filter((s) => s.score >= MIN_SCORE);
  if (!sure.length) return out;
  const instance = await instances.get(instanceId);
  const ctx = {
    instanceId,
    instance,
    modsDir: instances.contentDir(instanceId, 'mod'),
    history: await loadHistory(instanceId),
    updates: null,
  };
  const touched = new Set();
  for (const s of sure) {
    if (out.fixed.length >= MAX_FIXES) break;
    if (touched.has(s.file || s.id)) continue;
    let r = null;
    try {
      r = await fixOne(ctx, s);
    } catch {
      r = null;
    }
    if (r) {
      touched.add(s.file || s.id);
      if (r.file) touched.add(r.file);
      out.fixed.push(r);
    } else {
      out.skipped.push({
        id: s.id,
        name: s.name,
        why: PROTECTED.has(s.id) ? 'to mod, którego launcher nie wyłącza samodzielnie (renderer albo loader)' : 'nie udało się go naprawić ani wyłączyć',
      });
    }
  }
  if (out.fixed.length) await saveHistory(instanceId, ctx.history);
  return out;
}

/** Zdanie do konsoli: „Wyłączono: A (powód); zaktualizowano: B…”. */
function describe(result) {
  if (!result?.fixed?.length) return '';
  const label = { disabled: 'Wyłączono', updated: 'Zaktualizowano', installed: 'Doinstalowano' };
  return result.fixed
    .map((f) => `${label[f.action]} ${f.name}${f.requiredBy ? ` (wymaga go ${f.requiredBy})` : ''}${f.action === 'disabled' && f.note ? ` — ${f.note}` : ''}`)
    .join('; ');
}

module.exports = { fix, describe, PROTECTED, MIN_SCORE };
