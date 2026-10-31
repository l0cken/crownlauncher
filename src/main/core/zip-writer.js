const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * Strumieniowy zapis archiwum ZIP (eksport instancji). adm-zip składa całe archiwum w pamięci, a instancja z modami i światami
 * potrafi mieć gigabajty - tu każdy plik płynie z dysku przez kompresję prosto do pliku wyjściowego, więc zużycie pamięci nie
 * zależy od rozmiaru danych.
 *
 * Format: zwykły ZIP (bez ZIP64) z deskryptorami danych - rozmiary i suma CRC trafiają za dane, bo przy strumieniu nie są znane z
 * góry - oraz nazwami w UTF-8 (bit 11). Czytają go adm-zip, unzip, 7-Zip, Eksplorator Windows i Java. Granice klasycznego ZIP-a
 * (4 GB i 65 535 wpisów) przekroczone = wyjątek, a nie uszkodzone archiwum.
 *
 * Plik powstaje pod nazwą `<cel>.part` i dostaje docelową nazwę dopiero po zapisaniu spisu treści (`finish`), więc przerwany
 * eksport nie zostawia na dysku niepełnego pliku .mrpack.
 */

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

// zlib.crc32 jest w Node 20.15+/22.2+; tablica to zapas dla starszych środowisk
let CRC_TABLE = null;
function crc32Fallback(buf, prev = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32Fallback;

/** Data i czas w formacie MS-DOS (ZIP nie zna lat poza 1980–2107; czas ma dokładność 2 s). */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Pliki, które już są skompresowane: szybki poziom, żeby nie tracić czasu na ~0% zysku
const COMPRESSED_RE = /\.(?:jar|zip|mrpack|png|jpe?g|ogg|mp3|mp4|webp|gz|7z|rar|xz|zst|nbt|mca)$/i;

class ZipWriter {
  constructor(dest, fh) {
    this.dest = dest;
    this.part = `${dest}.part`;
    this.fh = fh;
    this.pos = 0;
    this.entries = [];
    this.names = new Set();
    this.closed = false;
  }

  /** Otwiera `<dest>.part` do zapisu (istniejący plik tymczasowy jest nadpisywany). */
  static async create(dest) {
    const fh = await fsp.open(`${dest}.part`, 'w');
    return new ZipWriter(dest, fh);
  }

  async _write(buf) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.pos + off);
      off += bytesWritten;
    }
    this.pos += buf.length;
  }

  _begin(name, mtime) {
    if (this.closed) throw new Error('Archiwum jest już zamknięte.');
    name = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.split('/').some((p) => p === '..' || p === '.')) throw new Error(`Niepoprawna nazwa wpisu: ${name}`);
    if (this.names.has(name)) throw new Error(`Powtórzony wpis w archiwum: ${name}`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error(`Za dużo plików w archiwum (limit ${MAX_ENTRIES}).`);
    if (this.pos > MAX_U32 - 1024 * 1024) throw new Error('Archiwum przekroczyło 4 GB (limit zwykłego ZIP-a).');
    this.names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(mtime);
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // wersja potrzebna do rozpakowania
    header.writeUInt16LE(0x0808, 6); // bit 3: deskryptor danych po plikach, bit 11: nazwy UTF-8
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC i rozmiary (14-26) są 0 - trafią do deskryptora za danymi
    header.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(header, 30);
    return { name, nameBuf, time, date, header, offset: this.pos };
  }

  async _finishEntry(meta, crc, csize, usize) {
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(csize, 8);
    desc.writeUInt32LE(usize, 12);
    await this._write(desc);
    this.entries.push({ ...meta, crc: crc >>> 0, csize, usize });
  }

  /** Dodaje wpis z bufora (np. modrinth.index.json). */
  async addBuffer(name, data, { mtime } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (buf.length > MAX_U32) throw new Error(`Wpis ${name} jest za duży.`);
    const meta = this._begin(name, mtime);
    await this._write(meta.header);
    const packed = zlib.deflateRawSync(buf, { level: 6 });
    if (packed.length > MAX_U32) throw new Error(`Wpis ${name} jest za duży.`);
    await this._write(packed);
    await this._finishEntry(meta, crc32(buf), packed.length, buf.length);
  }

  /** Dodaje plik z dysku strumieniowo. Zwraca liczbę zapisanych bajtów danych (przed kompresją). */
  async addFile(name, source, { mtime } = {}) {
    const st = await fsp.stat(source);
    if (!st.isFile()) throw new Error(`To nie jest plik: ${source}`);
    const meta = this._begin(name, mtime || st.mtime);
    await this._write(meta.header);

    let crc = 0;
    let usize = 0;
    let csize = 0;
    const input = fs.createReadStream(source);
    // suma kontrolna i rozmiar liczone na danych źródłowych (przed kompresją), w locie
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc = crc32(chunk, crc);
        usize += chunk.length;
        cb(null, chunk);
      },
    });
    const deflate = zlib.createDeflateRaw({ level: COMPRESSED_RE.test(name) ? 1 : 6 });
    const sink = new Writable({
      write: (chunk, _enc, cb) => {
        csize += chunk.length;
        this._write(chunk).then(() => cb(), cb);
      },
    });
    await pipeline(input, tap, deflate, sink);
    if (usize > MAX_U32 || csize > MAX_U32) throw new Error(`Plik ${name} jest za duży na zwykły ZIP (limit 4 GB).`);
    await this._finishEntry(meta, crc, csize, usize);
    return usize;
  }

  /** Zapisuje spis treści, zamyka plik i nadaje mu docelową nazwę. */
  async finish() {
    if (this.closed) throw new Error('Archiwum jest już zamknięte.');
    const cdStart = this.pos;
    for (const e of this.entries) {
      const h = Buffer.alloc(46 + e.nameBuf.length);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(0x031e, 4); // utworzone w systemie Unix, wersja 3.0 - dzięki temu działają prawa w polu atrybutów
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // zwykły plik rw-r--r--
      h.writeUInt32LE(e.offset, 42);
      e.nameBuf.copy(h, 46);
      await this._write(h);
    }
    const cdSize = this.pos - cdStart;
    if (cdStart > MAX_U32 || this.pos > MAX_U32) throw new Error('Archiwum przekroczyło 4 GB (limit zwykłego ZIP-a).');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await this._write(end);
    this.closed = true;
    await this.fh.close();
    await fsp.rename(this.part, this.dest);
    return { entries: this.entries.length, bytes: this.pos };
  }

  /** Przerywa zapis i usuwa plik tymczasowy (bezpieczne do wielokrotnego wołania). */
  async abort() {
    if (!this.closed) {
      this.closed = true;
      await this.fh.close().catch(() => {});
    }
    await fsp.rm(this.part, { force: true }).catch(() => {});
  }
}

module.exports = { ZipWriter, crc32, crc32Fallback };
