const zlib = require('zlib');

const MAX_DEPTH = 32;
const MAX_LIST = 100000;

/**
 * Minimalny parser NBT (Named Binary Tag) do odczytu plików Minecrafta, np. servers.dat.
 * Zwraca zwykłe obiekty JS: compound -> object, list -> array, long -> BigInt.
 * Automatycznie rozpakowuje gzip.
 */
function parse(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);

  let pos = 0;
  const need = (n) => {
    if (n < 0 || pos + n > buf.length) throw new Error('Uszkodzony plik NBT');
  };
  const i8 = () => {
    need(1);
    return buf.readInt8(pos++);
  };
  const i16 = () => {
    need(2);
    const v = buf.readInt16BE(pos);
    pos += 2;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = buf.readInt32BE(pos);
    pos += 4;
    return v;
  };
  const i64 = () => {
    need(8);
    const v = buf.readBigInt64BE(pos);
    pos += 8;
    return v;
  };
  const f32 = () => {
    need(4);
    const v = buf.readFloatBE(pos);
    pos += 4;
    return v;
  };
  const f64 = () => {
    need(8);
    const v = buf.readDoubleBE(pos);
    pos += 8;
    return v;
  };
  const str = () => {
    need(2);
    const len = buf.readUInt16BE(pos);
    pos += 2;
    need(len);
    const s = buf.toString('utf8', pos, pos + len);
    pos += len;
    return s;
  };
  const length = () => {
    const len = i32();
    if (len < 0 || len > MAX_LIST) throw new Error('Uszkodzony plik NBT (długość listy)');
    return len;
  };

  function payload(type, depth) {
    if (depth > MAX_DEPTH) throw new Error('Uszkodzony plik NBT (zbyt głębokie zagnieżdżenie)');
    switch (type) {
      case 1:
        return i8();
      case 2:
        return i16();
      case 3:
        return i32();
      case 4:
        return i64();
      case 5:
        return f32();
      case 6:
        return f64();
      case 7: {
        const len = length();
        need(len);
        const out = buf.subarray(pos, pos + len);
        pos += len;
        return out;
      }
      case 8:
        return str();
      case 9: {
        const itemType = i8();
        const len = length();
        const out = [];
        for (let i = 0; i < len; i++) out.push(payload(itemType, depth + 1));
        return out;
      }
      case 10: {
        const out = {};
        for (;;) {
          const t = i8();
          if (t === 0) return out;
          const name = str();
          out[name] = payload(t, depth + 1);
        }
      }
      case 11: {
        const len = length();
        const out = [];
        for (let i = 0; i < len; i++) out.push(i32());
        return out;
      }
      case 12: {
        const len = length();
        const out = [];
        for (let i = 0; i < len; i++) out.push(i64());
        return out;
      }
      default:
        throw new Error(`Nieznany typ NBT: ${type}`);
    }
  }

  const rootType = i8();
  if (rootType !== 10) throw new Error('Plik NBT nie zaczyna się od compounda');
  str(); // nazwa roota (zwykle pusta)
  return payload(10, 0);
}

// ---- wersja z zachowaniem typów (do odczytu i ZAPISU plików, np. servers.dat) ----------------------

/**
 * Parsuje NBT do drzewa węzłów { t: typ, v: wartość }; compound = Map<string, węzeł>,
 * list = { it: typ elementów, items: [wartości] }. Pozwala zapisać plik bez utraty typów.
 */
function parseTyped(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let pos = 0;
  const need = (n) => {
    if (n < 0 || pos + n > buf.length) throw new Error('Uszkodzony plik NBT');
  };
  const str = () => {
    need(2);
    const len = buf.readUInt16BE(pos);
    pos += 2;
    need(len);
    const s = buf.toString('utf8', pos, pos + len);
    pos += len;
    return s;
  };
  const num = (size, read) => {
    need(size);
    const v = buf[read](pos);
    pos += size;
    return v;
  };
  const length = () => {
    const len = num(4, 'readInt32BE');
    if (len < 0 || len > MAX_LIST) throw new Error('Uszkodzony plik NBT (długość listy)');
    return len;
  };

  function value(type, depth) {
    if (depth > MAX_DEPTH) throw new Error('Uszkodzony plik NBT (zbyt głębokie zagnieżdżenie)');
    switch (type) {
      case 1:
        return num(1, 'readInt8');
      case 2:
        return num(2, 'readInt16BE');
      case 3:
        return num(4, 'readInt32BE');
      case 4:
        return num(8, 'readBigInt64BE');
      case 5:
        return num(4, 'readFloatBE');
      case 6:
        return num(8, 'readDoubleBE');
      case 7: {
        const len = length();
        need(len);
        const out = Buffer.from(buf.subarray(pos, pos + len));
        pos += len;
        return out;
      }
      case 8:
        return str();
      case 9: {
        const it = num(1, 'readInt8');
        const len = length();
        const items = [];
        for (let i = 0; i < len; i++) items.push(value(it, depth + 1));
        return { it, items };
      }
      case 10: {
        const map = new Map();
        for (;;) {
          const t = num(1, 'readInt8');
          if (t === 0) return map;
          const name = str();
          map.set(name, { t, v: value(t, depth + 1) });
        }
      }
      case 11: {
        const len = length();
        const out = [];
        for (let i = 0; i < len; i++) out.push(num(4, 'readInt32BE'));
        return out;
      }
      case 12: {
        const len = length();
        const out = [];
        for (let i = 0; i < len; i++) out.push(num(8, 'readBigInt64BE'));
        return out;
      }
      default:
        throw new Error(`Nieznany typ NBT: ${type}`);
    }
  }

  if (num(1, 'readInt8') !== 10) throw new Error('Plik NBT nie zaczyna się od compounda');
  const name = str();
  return { name, tag: { t: 10, v: value(10, 0) } };
}

/** Zapisuje drzewo z parseTyped z powrotem do bajtów (nieskompresowane NBT). */
function serialize(root) {
  const chunks = [];
  const byte = (n) => chunks.push(Buffer.from([n & 0xff]));
  const buf = (size, fn, v) => {
    const b = Buffer.alloc(size);
    b[fn](v);
    chunks.push(b);
  };
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    buf(2, 'writeUInt16BE', b.length);
    chunks.push(b);
  };

  function write(type, v) {
    switch (type) {
      case 1:
        return byte(v);
      case 2:
        return buf(2, 'writeInt16BE', v);
      case 3:
        return buf(4, 'writeInt32BE', v);
      case 4:
        return buf(8, 'writeBigInt64BE', BigInt(v));
      case 5:
        return buf(4, 'writeFloatBE', v);
      case 6:
        return buf(8, 'writeDoubleBE', v);
      case 7:
        buf(4, 'writeInt32BE', v.length);
        return chunks.push(Buffer.from(v));
      case 8:
        return str(v);
      case 9:
        byte(v.items.length ? v.it : v.it || 0);
        buf(4, 'writeInt32BE', v.items.length);
        for (const item of v.items) write(v.it, item);
        return undefined;
      case 10:
        for (const [name, node] of v) {
          byte(node.t);
          str(name);
          write(node.t, node.v);
        }
        return byte(0);
      case 11:
        buf(4, 'writeInt32BE', v.length);
        for (const n of v) buf(4, 'writeInt32BE', n);
        return undefined;
      case 12:
        buf(4, 'writeInt32BE', v.length);
        for (const n of v) buf(8, 'writeBigInt64BE', BigInt(n));
        return undefined;
      default:
        throw new Error(`Nieznany typ NBT: ${type}`);
    }
  }

  byte(10);
  str(root.name || '');
  write(10, root.tag.v);
  return Buffer.concat(chunks);
}

module.exports = { parse, parseTyped, serialize };
