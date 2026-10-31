// Minimalne okno Electrona z podanym adresem (OPEN_URL) - do testów interfejsów www (panel /admin) w prawdziwym Chromium.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { contextIsolation: true } });
  win.loadURL(process.env.OPEN_URL);
});
app.on('window-all-closed', () => app.quit());
