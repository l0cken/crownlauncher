const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const appConfig = require('./app-config');

/**
 * Discord Rich Presence: gdy ktoś gra, w jego profilu na Discordzie widać "Gra w CrownClient".
 * Nazwa po "Gra w" to nazwa aplikacji Discord (DISCORD_CLIENT_ID w app-config.js).
 *
 * Rozmawiamy bezpośrednio z lokalnym klientem Discorda przez jego potok IPC (discord-ipc-0..9),
 * więc nie potrzeba żadnych bibliotek ani logowania. Brak uruchomionego Discorda nie jest błędem -
 * launcher co jakiś czas ponawia próbę, dopóki trwa gra.
 */

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const MAX_PIPES = 10;
const MAX_FRAME = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 3000;
const RETRY_MS = 15_000;

const LOADER_LABEL = { fabric: 'Fabric' };
const norm = (ip) => String(ip || '').trim().toLowerCase().replace(/:25565$/, '');

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function defaultPipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  const plain = path.join(base, `discord-ipc-${i}`);
  if (process.platform !== 'linux') return plain;
  // Discord z Flatpaka, Snapa i Vencord/Canary trzyma gniazdo w podkatalogu katalogu uruchomieniowego
  for (const sub of ['', 'app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary', 'snap.discord', 'snap.discord-canary']) {
    const candidate = path.join(base, sub, `discord-ipc-${i}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return plain;
}

/**
 * Pojedyncze połączenie z Discordem. `set(activity)` ustawia status, `clear()` go zdejmuje.
 * Fabryka (a nie singleton), żeby dało się to przetestować na własnym potoku.
 */
function createPresence({ clientId, pipePath = defaultPipePath, retryMs = RETRY_MS } = {}) {
  let socket = null;
  let ready = false;
  let connecting = false;
  let blocked = false; // Discord odrzucił client id - nie ma sensu ponawiać
  let desired = null;
  let retryTimer = null;
  let generation = 0;
  let buffer = Buffer.alloc(0);

  const write = (op, payload) => {
    try {
      socket?.write(encode(op, payload));
    } catch {
      /* gniazdo zamknięte - obsłuży to zdarzenie close */
    }
  };

  function push() {
    if (!ready) return;
    // brak "activity" w args = zdjęcie statusu
    write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, ...(desired ? { activity: desired } : {}) },
      nonce: crypto.randomUUID(),
    });
  }

  function scheduleRetry() {
    if (retryTimer || !desired || blocked) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensure();
    }, retryMs);
    retryTimer.unref?.();
  }

  function onData(s, chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const len = buffer.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME) return s.destroy();
      if (buffer.length < 8 + len) return;
      const body = buffer.subarray(8, 8 + len);
      buffer = buffer.subarray(8 + len);

      if (op === OP.PING) {
        write(OP.PONG, JSON.parse(body.toString('utf8') || '{}'));
      } else if (op === OP.CLOSE) {
        blocked = true;
        s.destroy();
        return;
      } else if (op === OP.FRAME) {
        let msg = null;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          continue;
        }
        if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
          ready = true;
          push();
        }
      }
    }
  }

  function tryPipe(i, gen) {
    if (gen !== generation) return;
    if (i >= MAX_PIPES) {
      connecting = false;
      scheduleRetry();
      return;
    }
    const s = net.createConnection(pipePath(i));
    let opened = false;
    const timer = setTimeout(() => s.destroy(), CONNECT_TIMEOUT_MS);
    timer.unref?.();

    s.once('connect', () => {
      clearTimeout(timer);
      opened = true;
      connecting = false;
      socket = s;
      buffer = Buffer.alloc(0);
      write(OP.HANDSHAKE, { v: 1, client_id: String(clientId) });
    });
    s.on('data', (chunk) => {
      try {
        onData(s, chunk);
      } catch {
        s.destroy();
      }
    });
    s.on('error', () => {
      /* szczegóły w 'close' */
    });
    s.on('close', () => {
      clearTimeout(timer);
      if (!opened) return tryPipe(i + 1, gen);
      if (socket === s) {
        socket = null;
        ready = false;
      }
      scheduleRetry();
    });
  }

  function ensure() {
    if (!clientId || blocked || socket || connecting) return;
    connecting = true;
    generation += 1;
    tryPipe(0, generation);
  }

  return {
    get ready() {
      return ready;
    },
    set(activity) {
      if (!clientId) return;
      blocked = false;
      desired = activity;
      if (ready) push();
      else ensure();
    },
    clear() {
      desired = null;
      clearTimeout(retryTimer);
      retryTimer = null;
      generation += 1; // przerywa trwające próby łączenia
      connecting = false;
      if (ready) {
        push();
        socket?.end();
      } else {
        socket?.destroy();
      }
    },
  };
}

// ---- użycie w launcherze ---------------------------------------------------------------------

const presence = createPresence({
  clientId: String(appConfig.DISCORD_CLIENT_ID || '').trim(),
  pipePath: process.env.CROWN_DISCORD_PIPE_PREFIX ? (i) => `${process.env.CROWN_DISCORD_PIPE_PREFIX}${i}` : undefined,
});

const available = () => /^\d{15,25}$/.test(String(appConfig.DISCORD_CLIENT_ID || '').trim());

/**
 * Status gry. Adres serwera pokazujemy tylko dla serwera przypiętego przez launcher - prywatnych
 * adresów graczy nie wysyłamy do Discorda.
 */
function activityFor({ instance, server = '', startedAt = Date.now() }) {
  const name = appConfig.CLIENT_NAME || 'CrownClient';
  const pinned = (appConfig.PINNED_SERVERS || []).find((p) => server && norm(p.ip) === norm(server));
  const loader = LOADER_LABEL[instance.loader];
  const activity = {
    details: `Minecraft ${instance.mcVersion}${loader ? ` · ${loader}` : ''}`,
    state: pinned ? `Na serwerze ${pinned.name}` : 'W grze',
    timestamps: { start: Math.floor(startedAt / 1000) },
    instance: false,
  };
  if (appConfig.DISCORD_LARGE_IMAGE) {
    activity.assets = { large_image: appConfig.DISCORD_LARGE_IMAGE, large_text: name };
  }
  return activity;
}

function start(info) {
  if (!available()) return;
  presence.set(activityFor(info));
}

function stop() {
  presence.clear();
}

module.exports = { createPresence, activityFor, start, stop, available, encode };
