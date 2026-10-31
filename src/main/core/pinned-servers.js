const fsp = require('fs').promises;
const path = require('path');
const nbt = require('./nbt');
const appConfig = require('./app-config');

const norm = (ip) => String(ip || '').trim().toLowerCase().replace(/:25565$/, '');

/**
 * Dba o to, by serwery z PINNED_SERVERS (app-config.js) były na samej górze listy serwerów w grze.
 * Reszta wpisów (własne serwery gracza, ikony itd.) zostaje nietknięta, tylko przesuwa się niżej.
 * Wywoływane przed każdym uruchomieniem gry; nie rzuca błędów (lista serwerów nie może blokować startu).
 */
async function ensurePinned(gameDir, pinned = appConfig.PINNED_SERVERS || []) {
  if (!pinned.length) return false;
  const file = path.join(gameDir, 'servers.dat');

  let before = null;
  let root = { name: '', tag: { t: 10, v: new Map() } };
  try {
    before = await fsp.readFile(file);
    root = nbt.parseTyped(before);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // uszkodzony plik: zachowaj kopię i zacznij od nowa
      await fsp.copyFile(file, `${file}.crown-backup`).catch(() => {});
    }
    before = null;
    root = { name: '', tag: { t: 10, v: new Map() } };
  }

  let list = root.tag.v.get('servers');
  if (!list || list.t !== 9) {
    list = { t: 9, v: { it: 10, items: [] } };
    root.tag.v.set('servers', list);
  }
  if (list.v.it !== 10) list.v = { it: 10, items: [] };

  const items = list.v.items;
  const isPinned = (entry) => pinned.some((p) => norm(entry.get('ip')?.v) === norm(p.ip));
  const head = pinned.map((p) => {
    const entry = items.find((e) => norm(e.get('ip')?.v) === norm(p.ip)) || new Map();
    entry.set('ip', { t: 8, v: p.ip });
    entry.set('name', { t: 8, v: p.name });
    return entry;
  });
  list.v.items = [...head, ...items.filter((e) => !isPinned(e))];

  const out = nbt.serialize(root);
  if (before && Buffer.compare(before, out) === 0) return false; // już jest jak trzeba

  await fsp.mkdir(gameDir, { recursive: true });
  const tmp = `${file}.crown.tmp`;
  await fsp.writeFile(tmp, out);
  await fsp.rename(tmp, file);
  return true;
}

module.exports = { ensurePinned };
