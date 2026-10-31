const net = require('net');
const dns = require('dns').promises;
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const nbt = require('./nbt');
const instances = require('./instances');
const appConfig = require('./app-config');
const { readJson, writeJson } = require('./util');

const DEFAULT_PORT = 25565;
const ADDRESS_RE = /^(?:[A-Za-z0-9._-]{1,253}|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

// "Host.Example.com:25565" i "host.example.com" to ten sam serwer
const addressKey = (address) => String(address || '').trim().toLowerCase().replace(/:25565$/, '');

// ---- serwery przypięte (PINNED_SERVERS w app-config.js) --------------------------------
//
// Są zawsze pierwsze na liście, nie da się ich usunąć ani zmienić im nazwy/adresu - można tylko
// wskazać instancję do dołączania. Pilnuje tego proces główny, więc nie da się tego obejść z UI.

const pinnedConfig = () => (Array.isArray(appConfig.PINNED_SERVERS) ? appConfig.PINNED_SERVERS : []).filter((p) => p && p.ip);
const pinnedId = (p) => `pinned-${crypto.createHash('sha1').update(addressKey(p.ip)).digest('hex').slice(0, 8)}`;

/** Dokłada przypięte serwery na początek listy; z zapisanych usuwa ich duplikaty (zachowując wybraną instancję). */
function withPinned(stored) {
  const pinned = pinnedConfig();
  if (!pinned.length) return stored.filter((s) => !s.pinned);
  const keys = new Set(pinned.map((p) => addressKey(p.ip)));
  const head = pinned.map((p) => {
    const prev = stored.find((s) => s.id === pinnedId(p)) || stored.find((s) => addressKey(s.address) === addressKey(p.ip));
    return { id: pinnedId(p), name: p.name || p.ip, address: p.ip, instanceId: prev?.instanceId || '', pinned: true };
  });
  return [...head, ...stored.filter((s) => !s.pinned && !keys.has(addressKey(s.address)))];
}

// ---- zapis listy serwerów ----------------------------------------------

async function load() {
  let stored = [];
  try {
    const data = await readJson(paths.servers());
    if (Array.isArray(data.servers)) stored = data.servers;
  } catch {
    /* brak pliku = pusta lista */
  }
  return withPinned(stored);
}

async function save(servers) {
  await writeJson(paths.servers(), { servers });
}

function validateAddress(address) {
  address = String(address || '').trim();
  const m = ADDRESS_RE.exec(address);
  if (!m) throw new Error('Niepoprawny adres serwera (np. mc.example.com lub mc.example.com:25570).');
  const port = /:(\d+)$/.exec(address);
  if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) throw new Error('Port musi mieścić się w zakresie 1–65535.');
  return address;
}

async function add({ name, address, instanceId = '' }) {
  address = validateAddress(address);
  const servers = await load();
  if (servers.some((s) => s.pinned && addressKey(s.address) === addressKey(address))) {
    throw new Error('Ten serwer jest już na liście jako przypięty.');
  }
  const server = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || '').trim() || address,
    address,
    instanceId: instanceId || '',
  };
  servers.push(server);
  await save(servers);
  return server;
}

async function update(id, patch) {
  const servers = await load();
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error('Nie znaleziono serwera.');
  if (server.pinned) {
    // przypięty: nazwa i adres są narzucone przez launcher, zmienić można tylko instancję
    if ('instanceId' in patch) server.instanceId = patch.instanceId || '';
  } else {
    if ('address' in patch) {
      const address = validateAddress(patch.address);
      if (servers.some((s) => s.pinned && addressKey(s.address) === addressKey(address))) {
        throw new Error('Ten adres należy do serwera przypiętego w launcherze.');
      }
      server.address = address;
    }
    if ('name' in patch) server.name = String(patch.name || '').trim() || server.address;
    if ('instanceId' in patch) server.instanceId = patch.instanceId || '';
  }
  await save(servers);
  return server;
}

async function remove(id) {
  const servers = await load();
  const server = servers.find((s) => s.id === id);
  if (server?.pinned) throw new Error(`Serwer „${server.name}” jest przypięty przez launcher i nie można go usunąć.`);
  await save(servers.filter((s) => s.id !== id));
}

// ---- import z servers.dat instancji ---------------------------------------

const MAX_SERVERS_DAT = 2 * 1024 * 1024;

async function readInstanceServers(instanceId) {
  const file = path.join(paths.gameDir(instanceId), 'servers.dat');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > MAX_SERVERS_DAT) return [];
  const root = nbt.parse(await fsp.readFile(file));
  const list = Array.isArray(root.servers) ? root.servers : [];
  return list
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ name: String(s.name ?? '').trim(), address: String(s.ip ?? '').trim() }))
    .filter((s) => s.address);
}

/** Zwraca instancje, w których jest plik servers.dat, wraz z liczbą zapisanych serwerów. */
async function scanInstances() {
  const out = [];
  for (const inst of await instances.list()) {
    try {
      const found = await readInstanceServers(inst.id);
      if (found.length) out.push({ instanceId: inst.id, name: inst.name, mcVersion: inst.mcVersion, count: found.length });
    } catch {
      /* uszkodzony servers.dat - pomijamy instancję */
    }
  }
  return out;
}

/** Importuje serwery z podanych instancji; pomija duplikaty i niepoprawne adresy. */
async function importFromInstances(instanceIds) {
  const current = await load();
  const known = new Set(current.map((s) => addressKey(s.address)));
  const result = { found: 0, added: 0, duplicates: 0, invalid: 0, skippedInstances: 0 };

  for (const id of instanceIds) {
    let found;
    try {
      found = await readInstanceServers(id);
    } catch {
      result.skippedInstances++;
      continue;
    }
    for (const s of found) {
      result.found++;
      let address;
      try {
        address = validateAddress(s.address);
      } catch {
        result.invalid++;
        continue;
      }
      const key = addressKey(address);
      if (known.has(key)) {
        result.duplicates++;
        continue;
      }
      known.add(key);
      current.push({
        id: crypto.randomBytes(6).toString('hex'),
        name: s.name || address,
        address,
        instanceId: id,
      });
      result.added++;
    }
  }
  if (result.added) await save(current);
  return result;
}

// ---- Server List Ping --------------------------------------------------

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

// Zwraca { value, size } albo null, gdy bufor jest jeszcze niepełny.
function readVarInt(buf, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('Niepoprawny VarInt');
}

function parseAddress(address) {
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(address);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const idx = address.lastIndexOf(':');
  if (idx > 0) return { host: address.slice(0, idx), port: Number(address.slice(idx + 1)) };
  return { host: address, port: null };
}

async function resolveTarget(address) {
  const { host, port } = parseAddress(address);
  if (port) return { host, port, connectHost: host };
  // brak portu -> rekord SRV _minecraft._tcp (tak robi klient gry)
  try {
    const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (srv.length) return { host, port: srv[0].port, connectHost: srv[0].name };
  } catch {
    /* brak SRV - port domyślny */
  }
  return { host, port: DEFAULT_PORT, connectHost: host };
}

function flattenChat(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenChat).join('');
  return (node.text || '') + (Array.isArray(node.extra) ? node.extra.map(flattenChat).join('') : '');
}

function cleanMotd(description) {
  return flattenChat(description)
    .replace(/§./g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
}

function describeError(e) {
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'Nie znaleziono hosta';
  if (e.code === 'ECONNREFUSED') return 'Połączenie odrzucone';
  if (e.code === 'ETIMEDOUT') return 'Przekroczono czas oczekiwania';
  return e.message || 'Błąd połączenia';
}

/** Odpytuje serwer protokołem Server List Ping. Nigdy nie rzuca - zwraca { online:false, error }. */
async function ping(address, timeoutMs = 5000) {
  let target;
  try {
    target = await resolveTarget(validateAddress(address));
  } catch (e) {
    return { online: false, error: describeError(e) };
  }

  return new Promise((resolve) => {
    const socket = net.connect({ host: target.connectHost, port: target.port });
    let buf = Buffer.alloc(0);
    let status = null;
    let sentAt = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const succeed = (latency) => {
      const json = status;
      const sample = (json.players?.sample || []).map((p) => p.name).filter(Boolean).slice(0, 12);
      const favicon =
        typeof json.favicon === 'string' && json.favicon.startsWith('data:image/png;base64,') ? json.favicon : '';
      finish({
        online: true,
        motd: cleanMotd(json.description),
        version: json.version?.name || '',
        protocol: json.version?.protocol ?? null,
        players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0, sample },
        favicon,
        latency,
      });
    };

    const timer = setTimeout(() => {
      if (status) succeed(Date.now() - sentAt);
      else finish({ online: false, error: 'Przekroczono czas oczekiwania' });
    }, timeoutMs);

    socket.on('error', (e) => finish({ online: false, error: describeError(e) }));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(target.host, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      const handshake = Buffer.concat([varInt(0x00), varInt(769), varInt(hostBuf.length), hostBuf, port, varInt(1)]);
      sentAt = Date.now();
      socket.write(Buffer.concat([varInt(handshake.length), handshake]));
      socket.write(Buffer.from([0x01, 0x00])); // status request
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const len = readVarInt(buf, 0);
          if (!len || buf.length < len.size + len.value) return;
          const body = buf.subarray(len.size, len.size + len.value);
          buf = buf.subarray(len.size + len.value);
          const id = readVarInt(body, 0);

          if (!status && id.value === 0x00) {
            const strLen = readVarInt(body, id.size);
            const start = id.size + strLen.size;
            status = JSON.parse(body.subarray(start, start + strLen.value).toString('utf8'));
            // pomiar opóźnienia osobnym pakietem ping/pong
            sentAt = Date.now();
            const payload = Buffer.alloc(8);
            payload.writeBigInt64BE(BigInt(sentAt));
            const packet = Buffer.concat([varInt(0x01), payload]);
            socket.write(Buffer.concat([varInt(packet.length), packet]));
          } else if (status && id.value === 0x01) {
            return succeed(Date.now() - sentAt);
          }
        }
      } catch (e) {
        finish({ online: false, error: 'Nieprawidłowa odpowiedź serwera' });
      }
    });
    socket.on('close', () => {
      if (status) succeed(Date.now() - sentAt);
      else finish({ online: false, error: 'Serwer zamknął połączenie' });
    });
  });
}

module.exports = {
  load,
  add,
  update,
  remove,
  ping,
  validateAddress,
  scanInstances,
  importFromInstances,
};
