const fs = require('fs');
const path = require('path');

let root = null;
const j = (...parts) => path.join(root, ...parts);

module.exports = {
  // Katalog danych sprowadzamy do ścieżki rzeczywistej (junctiony, wirtualizacja AppData itp.).
  // Fabric/Quilt porównują wpisy classpath z lokalizacją klas, więc ścieżki muszą być identyczne.
  init(rootDir) {
    fs.mkdirSync(rootDir, { recursive: true });
    root = fs.realpathSync.native(rootDir);
  },
  root: () => root,
  config: () => j('config.json'),
  servers: () => j('servers.json'),
  skins: () => j('skins'),
  skinLibrary: () => j('skins', 'library.json'),
  skinFile: (id) => j('skins', `${id}.png`),
  capes: () => j('capes'),
  capeLibrary: () => j('capes', 'library.json'),
  capeFile: (id) => j('capes', `${id}.png`),
  cache: () => j('cache'),
  libraries: () => j('libraries'),
  assets: () => j('assets'),
  versions: () => j('versions'),
  versionDir: (id) => j('versions', id),
  runtime: (component) => j('runtime', component),
  instances: () => j('instances'),
  instanceDir: (id) => j('instances', id),
  instanceFile: (id) => j('instances', id, 'instance.json'),
  contentIndex: (id) => j('instances', id, 'content.json'),
  gameDir: (id) => j('instances', id, 'game'),
  nativesDir: (id) => j('instances', id, 'natives'),
};
