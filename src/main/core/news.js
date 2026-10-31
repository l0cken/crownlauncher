const path = require('path');
const paths = require('./paths');
const announcements = require('./announcements');
const { readJson, writeJson, exists } = require('./util');

const TTL_MS = 5 * 60 * 1000;

let memory = null;
const cacheFile = () => path.join(paths.cache(), 'news.json');

/**
 * Newsy launchera = ogłoszenia z serwera ogłoszeń (publikowane kluczem dostępu).
 * Przypięte są na górze, reszta od najnowszych. Przy braku połączenia pokazujemy ostatnio zapisane.
 */
async function list({ force = false } = {}) {
  if (!force && memory && Date.now() - memory.at < TTL_MS) return memory.data;

  let items;
  try {
    items = await announcements.fetchItems();
  } catch (e) {
    if (await exists(cacheFile())) {
      const cached = await readJson(cacheFile());
      // z cache nie niesiemy uprawnień do usuwania (zależą od zalogowanego klucza)
      const safe = (cached.items || []).map((i) => ({ ...i, canDelete: false }));
      return { ...cached, items: safe, stale: true, announcementsError: e.message };
    }
    return { items: [], fetchedAt: Date.now(), stale: false, announcementsError: e.message };
  }

  items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.date) - new Date(a.date));
  const data = { items, fetchedAt: Date.now(), stale: false, announcementsError: '' };
  memory = { at: Date.now(), data };
  writeJson(cacheFile(), data).catch(() => {});
  return data;
}

/** Wymusza ponowne pobranie przy następnym odczycie (po publikacji, usunięciu, zmianie serwera). */
function invalidate() {
  memory = null;
}

module.exports = { list, invalidate };
