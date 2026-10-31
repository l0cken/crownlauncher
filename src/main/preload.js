const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Dozwolone są tylko kanały w formacie "przestrzeń:akcja".
const CHANNEL = /^[a-z]+:[a-z-]+$/;

contextBridge.exposeInMainWorld('crown', {
  invoke(channel, ...args) {
    if (!CHANNEL.test(channel)) return Promise.reject(new Error(`Niedozwolony kanał: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, callback) {
    if (!CHANNEL.test(channel)) throw new Error(`Niedozwolony kanał: ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // ścieżka pliku upuszczonego na okno (File.path zostało usunięte z Electrona)
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
});
