const fs = require('fs');
const path = require('path');
const { app, shell, dialog } = require('electron');
const paths = require('./core/paths');
const config = require('./core/config');
const mojang = require('./core/mojang');
const loaders = require('./core/loaders');
const instances = require('./core/instances');
const exporter = require('./core/export');
const auth = require('./core/auth');
const avatars = require('./core/avatars');
const servers = require('./core/servers');
const skins = require('./core/skins');
const news = require('./core/news');
const announcements = require('./core/announcements');
const invite = require('./core/invite');
const event = require('./core/event');
const restrictions = require('./core/restrictions');
const discord = require('./core/discord');
const capes = require('./core/capes');
const updater = require('./updater');
const bundledMods = require('./core/bundled-mods');
const performanceMods = require('./core/performance-mods');
const modrinth = require('./core/modrinth');
const game = require('./core/game');
const { friendlyFsError } = require('./core/util');
const pkg = require('../../package.json');

const COSMETICS_DENIED = new Error('Wyłączanie peleryn i korony (CrownClient) jest dostępne tylko dla wybranych graczy. Poproś administratora o dostęp.');

const CONFIG_KEYS = [
  'memoryMb', 'jvmArgs', 'javaPath', 'hideOnLaunch', 'discordPresence', 'optimizeJvm', 'optimizeMods', 'renderer', 'cosmetics', 'autoFixCrashes',
  'msClientId', 'announcementsUrl',
];

/**
 * Rejestruje kanały IPC. Każdy handler zwraca { ok, data } albo { ok:false, error },
 * dzięki czemu renderer dostaje czytelne komunikaty błędów.
 */
function register(ipcMain, { getWindow }) {
  const emit = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Postęp instalacji bywa bardzo częsty - ograniczamy do ~8 zdarzeń/s na instancję.
  const lastProgress = new Map();
  game.init((channel, payload) => {
    if (channel === 'install:progress') {
      const prev = lastProgress.get(payload.id);
      const now = Date.now();
      if (prev && prev.stage === payload.stage && now - prev.at < 120 && payload.current !== payload.total) return;
      lastProgress.set(payload.id, { stage: payload.stage, at: now });
    }
    if (channel === 'game:started' && config.get().hideOnLaunch) getWindow()?.minimize();
    if (channel === 'game:exit') {
      const win = getWindow();
      if (win && win.isMinimized()) win.restore();
      win?.focus();
    }
    emit(channel, payload);
  });

  // ograniczenia: tryb wydarzenia (jedyny klucz gracza to kod wydarzenia) i zablokowane instancje wydarzenia
  const restrictionContext = {
    get profile() {
      return config.get().inviteProfile || '';
    },
    eventInstanceId: event.instanceId(),
    isLocked: (id) => instances.isLocked(id),
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        const denied = await restrictions.check(channel, args, restrictionContext);
        if (denied) throw new Error(denied);
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: friendlyFsError(e) };
      }
    });
  };

  // Windows blokuje pliki modów, gdy gra jest uruchomiona - zamiast „EBUSY: resource busy or locked…” mówimy to wprost
  const ensureGameClosed = (id, what) => {
    if (game.states()[id]) {
      throw new Error(
        `Zamknij grę w tej instancji, zanim ${what}.${process.platform === 'win32' ? ' Dopóki gra działa, Windows blokuje pliki modów.' : ''}`,
      );
    }
  };

  // ---- aktualizacje launchera ----
  updater.setEmitter(emit);
  handle('update:status', () => updater.getState());
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('update:download', () => updater.download());

  // ---- aplikacja / okno ----
  handle('app:info', () => ({
    version: pkg.version,
    dataDir: paths.root(),
    platform: process.platform,
    secretStore: auth.storageKind(), // dpapi | keychain | keyring | basic | none (Linux bez pęku kluczy: basic)
    minVersion: mojang.MIN_VERSION,
    maxVersion: mojang.MAX_VERSION,
  }));
  handle('win:minimize', () => getWindow()?.minimize());
  handle('win:toggle-maximize', () => {
    const win = getWindow();
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle('win:close', () => getWindow()?.close());
  // przeładowanie interfejsu (np. po utracie klucza): location.reload() blokuje will-navigate z main.js
  handle('win:reload', () => {
    require('./core/news').invalidate();
    getWindow()?.webContents.reload();
  });
  handle('shell:open-external', (url) => {
    if (!/^https:\/\//i.test(String(url))) throw new Error('Dozwolone są tylko adresy https.');
    return shell.openExternal(url);
  });
  handle('shell:open-data-dir', () => shell.openPath(paths.root()));

  // ---- ustawienia ----
  // do renderera nie wysyłamy kont (tokeny), klucza publikowania ani sekretów nicków z serwera peleryn
  const publicConfig = () => ({ ...config.publicView(), discordAvailable: discord.available() });
  handle('config:get', () => publicConfig());
  handle('config:set', async (patch) => {
    const clean = {};
    for (const key of CONFIG_KEYS) if (key in patch) clean[key] = patch[key];
    if ('cosmetics' in clean) {
      // „Peleryny i korona w grze” są włączone u wszystkich; wyłączyć je mogą tylko klucze z dostępem nadanym w panelu
      clean.cosmetics = Boolean(clean.cosmetics);
      if (!clean.cosmetics && !(await clientState()).allowed) throw COSMETICS_DENIED;
    }
    if ('announcementsUrl' in clean) {
      clean.announcementsUrl = String(clean.announcementsUrl || '').trim();
      news.invalidate();
    }
    if ('discordPresence' in clean) {
      clean.discordPresence = Boolean(clean.discordPresence);
      if (!clean.discordPresence) discord.stop(); // wyłączenie działa od razu, także w trakcie gry
    }
    config.set(clean);
    return publicConfig();
  });

  // ---- wersje i loadery ----
  handle('versions:list', () => mojang.listVersions());
  handle('loaders:list', (loader, mc) => loaders.listLoaderVersions(loader, mc));

  // ---- instancje ----
  handle('instances:list', async () => {
    await instances.migrateVanilla().catch(() => {}); // dawne instancje Vanilla -> Fabric
    const all = await instances.list();
    // tryb wydarzenia: tylko instancja wydarzenia; pełny dostęp: instancje wydarzenia są w zakładce wydarzenia, nie na liście
    return config.get().inviteProfile ? all.filter((i) => i.id === event.instanceId()) : all.filter((i) => !i.locked);
  });
  handle('instances:create', async (data) => {
    const instance = await instances.create(data);
    await bundledMods.ensureBundledMods(instance);
    // instalacja w tle, żeby pierwszy start był szybki; błędy wyjdą przy uruchomieniu
    game.install(instance.id).catch((e) => emit('instance:error', { id: instance.id, message: e.message }));
    // mody optymalizujące też w tle (jednorazowo; przy starcie gry dokończą się, jeśli jeszcze trwają)
    performanceMods.ensure(instance).catch(() => {});
    return instance;
  });
  handle('instances:update', (id, patch) => instances.update(id, patch));
  // najlepszy zestaw optymalizacji dla wersji gry tej instancji (na życzenie; może zamienić Sodium <-> VulkanMod)
  handle('instances:optimize', async (id) => {
    if (game.states()[id]) throw new Error('Najpierw zamknij grę w tej instancji.');
    return performanceMods.optimize(id);
  });
  handle('instances:delete', async (id) => {
    game.stop(id);
    await instances.remove(id);
  });
  handle('instances:open-folder', async (id) => {
    await instances.get(id);
    return shell.openPath(paths.gameDir(id));
  });
  // eksport instancji do .mrpack (patrz core/export.js): okno „Zapisz jako”, potem pakowanie z postępem; null = anulowano
  let lastExport = '';
  handle('instances:export', async (id, opts = {}) => {
    const instance = await instances.get(id);
    ensureGameClosed(id, 'wyeksportujesz instancję');
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Eksportuj instancję',
      defaultPath: path.join(app.getPath('downloads'), exporter.suggestedName(instance)),
      filters: [{ name: 'Paczka modów Modrinth (.mrpack)', extensions: ['mrpack'] }],
    });
    if (res.canceled || !res.filePath) return null;
    let lastAt = 0;
    const out = await exporter.exportInstance(id, res.filePath, {
      worlds: Boolean(opts?.worlds),
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastAt < 120 && p.current !== p.total) return; // setki plików na sekundę: interfejs dostaje ~8 zdarzeń/s
        lastAt = now;
        emit('instances:export-progress', { id, current: p.current, total: p.total, text: p.text });
      },
    });
    lastExport = out.path;
    return out;
  });
  // „Pokaż w folderze” - tylko dla pliku, który właśnie wyeksportowaliśmy
  handle('shell:show-export', () => {
    if (!lastExport || !fs.existsSync(lastExport)) throw new Error('Nie ma pliku do pokazania.');
    shell.showItemInFolder(lastExport);
  });
  handle('instances:launch', (id, opts = {}) => game.launch(id, { server: opts?.server || '' }));
  handle('instances:stop', (id) => game.stop(id));
  handle('instances:states', () => game.states());
  handle('instances:logs', (id) => game.getLogs(id));
  handle('instances:crash', (id) => game.getLastCrash(id));

  // ---- zawartość instancji ----
  handle('content:list', (id, type) => instances.listContent(id, type));
  handle('content:identify', (id) => modrinth.identifyInstance(id));
  handle('content:installed', (id, opts = {}) =>
    modrinth.installedProjects(id, { identify: opts?.identify !== false }),
  );
  // aktualizacje modów (Modrinth): sprawdzenie, jeden mod, wszystkie
  handle('content:updates', (id) => modrinth.checkUpdates(id));
  handle('content:update', async (id, file) => {
    ensureGameClosed(id, 'zaktualizujesz mody');
    return modrinth.updateMod(id, file);
  });
  handle('content:update-all', async (id) => {
    ensureGameClosed(id, 'zaktualizujesz mody');
    return modrinth.updateAll(id);
  });
  handle('content:toggle', (id, type, file) => {
    if (type === 'mod') ensureGameClosed(id, 'włączysz lub wyłączysz mod');
    return instances.toggleContent(id, type, file);
  });
  handle('content:delete', (id, type, file) => {
    if (type === 'mod') ensureGameClosed(id, 'usuniesz mod');
    return instances.deleteContent(id, type, file);
  });

  // ---- serwery ----
  handle('servers:list', () => servers.load());
  handle('servers:add', (data) => servers.add(data));
  handle('servers:update', (id, patch) => servers.update(id, patch));
  handle('servers:remove', (id) => servers.remove(id));
  handle('servers:ping', (address) => servers.ping(address));
  handle('servers:scan', () => servers.scanInstances());
  handle('servers:import', (instanceIds) => {
    if (!Array.isArray(instanceIds) || !instanceIds.every((id) => typeof id === 'string')) {
      throw new Error('Niepoprawna lista instancji.');
    }
    return servers.importFromInstances(instanceIds);
  });

  // ---- newsy ----
  handle('news:list', (opts = {}) => news.list({ force: Boolean(opts?.force) }));

  // ---- wydarzenie (Igrzyska śmierci): kod dostępu, lista plików, synchronizacja instancji; patrz core/event.js ----
  handle('event:info', () => event.info());
  handle('event:state', () => event.state());
  handle('event:redeem', (code) => event.redeem(code));
  // postęp bez nazw plików (gracz nie widzi, co wchodzi w skład zestawu)
  handle('event:sync', async () => {
    try {
      return await event.sync((p) => emit('event:progress', { stage: p.stage, current: p.current, total: p.total }));
    } finally {
      // synchronizacja zostawia foldery otwarte; gdy gra nie działa (a to nie jest część startu gry), zamykamy je z powrotem
      const state = game.states()[event.instanceId()];
      if (state !== 'running' && state !== 'installing') await event.lockDirs(event.instanceId()).catch(() => {});
    }
  });
  // start launchera: instancje wydarzeń są zamknięte (gra nie może jeszcze działać)
  event.lockAll().catch(() => {});

  // ---- zaproszenie (prywatna dystrybucja; patrz core/invite.js) ----
  // interfejs jest odblokowany, gdy ostatnia odpowiedź dla niego miała active:true - od tego zależy, czy nadzór
  // ma wysłać „invite:lost”; nie wolno uzależniać tego od tego, co zdążył zobaczyć sam nadzór
  let uiUnlocked = false;
  // każda ścieżka, która zobaczy brak ważnego klucza (karta w Ustawieniach, start gry, nadzór), od razu odsyła interfejs
  // do ekranu z kluczem; stan „odblokowany” zdejmuje dopiero to powiadomienie, a nie sam odczyt statusu
  const noteStatus = (s) => {
    if (!s.required) return s;
    if (s.active) uiUnlocked = true;
    else if (uiUnlocked) {
      uiUnlocked = false;
      emit('invite:lost', {});
    }
    return s;
  };
  invite.onLost(() => noteStatus({ required: true, active: false }));
  const STATUS_MAX_AGE_MS = Math.min(invite.WATCH_MS, 15_000); // karta, ekran startowy i powrót do okna pytają serwer najwyżej co 15 s
  handle('invite:status', async () => noteStatus(await invite.status({ check: true, maxAgeMs: STATUS_MAX_AGE_MS })));
  // otwarty launcher: co minutę sprawdzamy klucz; gdy został unieważniony, wygasł albo komputer zwolniono w panelu,
  // interfejs wraca do ekranu z kluczem. Trwającej gry to nie przerywa - blokujemy kolejne starty.
  const watch = setInterval(async () => {
    try {
      noteStatus(await invite.status({ check: true, maxAgeMs: 0 }));
    } catch {
      /* nadzór nie może przeszkadzać */
    }
  }, invite.WATCH_MS);
  watch.unref?.();
  handle('invite:set', async (key) => {
    const s = await invite.submit(key);
    uiUnlocked = Boolean(s.active);
    return s;
  });
  handle('invite:clear', () => invite.clear());

  // ---- ogłoszenia (klucz dostępu) ----
  handle('announce:status', () => announcements.status());
  handle('announce:login', async (key) => {
    const s = await announcements.login(key);
    news.invalidate();
    return s;
  });
  handle('announce:logout', () => {
    const s = announcements.logout();
    news.invalidate();
    return s;
  });
  handle('announce:publish', async (data) => {
    const a = await announcements.publish({
      title: data?.title,
      text: data?.text,
      image: data?.image,
      link: data?.link,
      level: data?.level,
      pinned: data?.pinned,
      expiresInDays: data?.expiresInDays,
    });
    news.invalidate();
    return a;
  });
  handle('announce:remove', async (id) => {
    await announcements.remove(id);
    news.invalidate();
  });

  // ---- skiny ----
  handle('skins:list', () => skins.list());
  handle('skins:add', (data) => skins.add(data));
  handle('skins:update', (id, patch) => skins.update(id, patch));
  handle('skins:remove', (id) => skins.remove(id));
  handle('skins:pick', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Wybierz skin (PNG 64×64)',
      properties: ['openFile'],
      filters: [{ name: 'Skin Minecrafta', extensions: ['png'] }],
    });
    return res.canceled ? null : skins.readSkinFile(res.filePaths[0]);
  });
  handle('skins:lookup', (name) => skins.lookupByName(name));
  // oficjalny skin konta (Microsoft albo premium o tym samym nicku), jego model i wykryta zmiana
  handle('skins:profile', (opts) => skins.accountProfile({ quiet: Boolean(opts?.quiet) }));
  handle('skins:apply', (id) => skins.applyToAccount(id));
  handle('skins:reset', () => skins.resetAccountSkin());
  handle('skins:cape', (capeId) => skins.setCape(capeId));

  // ---- „Peleryny i korona w grze” (wyłączenie CrownClienta): tylko klucze z dostępem nadanym w panelu ----
  const clientState = async () => {
    try {
      noteStatus(await invite.status({ check: true, maxAgeMs: STATUS_MAX_AGE_MS })); // aktualny dostęp z serwera
    } catch {
      /* brak sieci: zostaje ostatnio zapisany stan */
    }
    return { allowed: invite.cosmeticsOffAllowed() };
  };
  handle('client:state', () => clientState());

  // ---- peleryny CrownClient (biblioteka, wybór, nadawanie przez administrację) ----
  handle('capes:state', async () => {
    // dostęp do peleryn nadaje administrator w panelu - przy wejściu na stronę pytamy serwer o aktualny stan klucza
    try {
      noteStatus(await invite.status({ check: true, maxAgeMs: STATUS_MAX_AGE_MS }));
    } catch {
      /* brak sieci: zostaje ostatnio zapisany stan */
    }
    return capes.state();
  });
  handle('capes:add', (data) => capes.add(data));
  handle('capes:remove', (id) => capes.remove(id));
  handle('capes:select', (id) => capes.select(id));
  handle('capes:pick', async () => {
    capes.requireAccess();
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Wybierz pelerynę (PNG 64×32)',
      properties: ['openFile'],
      filters: [{ name: 'Peleryna Minecrafta', extensions: ['png'] }],
    });
    return res.canceled ? null : capes.readCapeFile(res.filePaths[0]);
  });
  handle('capes:mine', () => {
    const acc = capes.currentAccount();
    return acc ? capes.assignedFor(acc.username) : { assigned: false };
  });
  handle('capes:assigned', () => capes.listAssigned());
  handle('capes:assign', (nick, id) => capes.assign(nick, id));
  handle('capes:unassign', (nick) => capes.unassign(nick));

  // ---- konta ----
  handle('accounts:list', () => auth.listPublic());
  // twarz konta (data URL albo null): pobiera ją serwer launchera, a nie launcher - mc-heads.net nie poznaje adresu IP gracza
  handle('accounts:avatar', (id) => avatars.forAccount(auth.listPublic().accounts.find((a) => a.id === id)));
  handle('accounts:add-offline', (name) => auth.addOffline(name));
  handle('accounts:remove', (id) => auth.remove(id));
  handle('accounts:select', (id) => auth.select(id));
  let msSignal = null;
  handle('accounts:ms-login', async () => {
    if (msSignal) msSignal.cancelled = true;
    const signal = { cancelled: false };
    msSignal = signal;
    try {
      return await auth.loginMicrosoft((code) => {
        emit('accounts:ms-code', code);
        shell.openExternal(code.verificationUri).catch(() => {});
      }, signal);
    } finally {
      if (msSignal === signal) msSignal = null;
    }
  });
  handle('accounts:ms-status', () => auth.msStatus());
  handle('accounts:ms-check', (clientId) => auth.checkClientId(clientId));
  handle('accounts:ms-cancel', () => {
    if (msSignal) msSignal.cancelled = true;
  });

  // ---- Modrinth ----
  handle('modrinth:search', (opts) => modrinth.search(opts));
  handle('modrinth:project', (id) => modrinth.project(id));
  handle('modrinth:versions', (id, opts) => modrinth.listVersions(id, opts));
  handle('modrinth:install', (opts) =>
    modrinth.installContent(opts, (p) => emit('modrinth:progress', { projectId: opts.projectId, ...p })),
  );
  handle('modrinth:pick-mrpack', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Wybierz paczkę modów (.mrpack)',
      properties: ['openFile'],
      filters: [{ name: 'Paczka modów Modrinth', extensions: ['mrpack'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('modrinth:import-mrpack', async (filePath) => {
    if (typeof filePath !== 'string' || !/\.mrpack$/i.test(filePath)) {
      throw new Error('Wybierz plik z rozszerzeniem .mrpack.');
    }
    const st = await fs.promises.stat(filePath).catch(() => null);
    if (!st?.isFile()) throw new Error('Nie znaleziono pliku .mrpack.');
    const instance = await modrinth.importMrpackFile(
      filePath,
      { fallbackName: path.basename(filePath).replace(/\.mrpack$/i, '') },
      (p) => emit('modrinth:progress', { projectId: 'local', ...p }),
    );
    game.install(instance.id).catch((e) => emit('instance:error', { id: instance.id, message: e.message }));
    return instance;
  });
  handle('modrinth:install-modpack', async (opts) => {
    const instance = await modrinth.installModpack(opts, (p) =>
      emit('modrinth:progress', { projectId: opts.projectId, ...p }),
    );
    game.install(instance.id).catch((e) => emit('instance:error', { id: instance.id, message: e.message }));
    return instance;
  });
}

module.exports = { register };
