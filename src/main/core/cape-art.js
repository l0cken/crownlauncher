const zlib = require('zlib');

/**
 * Wbudowane peleryny CrownClient, rysowane programowo (bez plików graficznych w instalatorze).
 * Format tekstury peleryny Minecrafta 64×32:
 *   (1,1)–(10,16)  zewnętrzna strona (widoczna z tyłu gracza)    (12,1)–(21,16) wewnętrzna strona
 *   (1,0) góra, (11,0) dół, (0,1) i (11,1) boki
 *   (22,0)–(45,21) skrzydła elytr - ta sama tekstura służy do elytr. Widoczna jest tylko zewnętrzna strona
 *   skrzydła (36,2)–(45,21); jej kształt (maska WING) odtwarza skrzydło z gry.
 */

const W = 64;
const H = 32;

// ---- koder PNG -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Koduje RGBA (width*height*4) do PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bitów na kanał
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtr: brak
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- rysowanie ---------------------------------------------------------------------------------

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const shade = (c, f) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));

const GOLD = hex('#f2b01e');
const GOLD_LIGHT = hex('#ffd35a');
const GOLD_DARK = hex('#a8710a');

// Korona 8×5 (G = złoto, J = klejnot)
const CROWN = ['G..GG..G', 'G.GGGG.G', 'GGGGGGGG', 'GGJGGJGG', 'GGGGGGGG'];

/**
 * Kształt zewnętrznej strony skrzydła elytr (10×20, X = jest piksel), taki jak w teksturze elytr z gry:
 * ukośne cięcie w prawym górnym i lewym dolnym rogu. Bez niego skrzydła wychodzą jak prostokątne płachty.
 * Tę samą maskę ma renderer/js/cape-import.js (dla własnych peleryn bez skrzydeł).
 */
const WING = [
  'XXXXXX....',
  'XXXXXXX...',
  'XXXXXXXX..',
  'XXXXXXXX..',
  'XXXXXXXX..',
  'XXXXXXXXX.',
  'XXXXXXXXX.',
  'XXXXXXXXX.',
  'XXXXXXXXX.',
  'XXXXXXXXXX',
  'XXXXXXXXXX',
  'XXXXXXXXXX',
  'XXXXXXXXXX',
  'XXXXXXXXXX',
  '.XXXXXXXXX',
  '.XXXXXXXXX',
  '.XXXXXXXXX',
  '..XXXXXXXX',
  '..XXXXXXXX',
  '...XXXXXXX',
];
const WING_W = 10;
const WING_H = 20;
const WING_X = 36; // lewy górny róg zewnętrznej strony w teksturze 64×32 (box 10×20×2 z texOffs 22,0)
const WING_Y = 2;

// Deterministyczne gwiazdy (x, y) dla peleryny "Północ"
const STARS = [[2, 2], [7, 1], [4, 4], [8, 6], [1, 8], [5, 9], [7, 11], [2, 13], [6, 14], [3, 6], [8, 3]];

/** Każdy projekt zwraca kolor piksela zewnętrznej strony (x: 0–9, y: 0–15) i kolor obrzeża. */
const DESIGNS = [
  {
    id: 'crown',
    name: 'Korona',
    trim: GOLD,
    pixel(x, y) {
      let c = mix(hex('#1a1b22'), hex('#0d0e12'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return GOLD;
      if (x === 1 || x === 8 || y === 1 || y === 14) c = shade(c, 1.25);
      const cx = x - 1;
      const cy = y - 4;
      if (cx >= 0 && cx < 8 && cy >= 0 && cy < 5) {
        const k = CROWN[cy][cx];
        if (k === 'J') return hex('#e34242');
        if (k === 'G') return cy === 0 || cx === 0 ? GOLD_LIGHT : cy === 4 ? GOLD_DARK : GOLD;
      }
      // obszycie pod koroną: dwa złote pasy
      if (y === 11 && x >= 1 && x <= 8) return GOLD_DARK;
      if (y === 13 && x >= 3 && x <= 6) return GOLD;
      return c;
    },
  },
  {
    id: 'gold',
    name: 'Złoto',
    trim: hex('#8a5a00'),
    pixel(x, y) {
      let c = mix(GOLD_LIGHT, hex('#c98a0b'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return hex('#8a5a00');
      if ((x + y) % 9 === 0 || (x + y) % 9 === 1) c = shade(c, 1.12);
      return c;
    },
  },
  {
    id: 'midnight',
    name: 'Północ',
    trim: hex('#0a0f26'),
    pixel(x, y) {
      let c = mix(hex('#0b1230'), hex('#1f3478'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return hex('#0a0f26');
      const star = STARS.findIndex(([sx, sy]) => sx === x && sy === y);
      if (star >= 0) c = star % 3 === 0 ? GOLD_LIGHT : hex('#ffffff');
      return c;
    },
  },
  {
    id: 'crimson',
    name: 'Karmazyn',
    trim: hex('#3a0510'),
    pixel(x, y) {
      let c = mix(hex('#7a0f1f'), hex('#c4162f'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return hex('#3a0510');
      if (x === 4 || x === 5) c = y % 4 === 0 ? GOLD_DARK : GOLD;
      return c;
    },
  },
  {
    id: 'emerald',
    name: 'Szmaragd',
    trim: hex('#073a22'),
    pixel(x, y) {
      let c = mix(hex('#0d4a2e'), hex('#1fa463'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return hex('#073a22');
      if ((x + y) % 4 === 0) c = shade(c, 1.28);
      if ((x - y + 16) % 8 === 0) c = shade(c, 0.78);
      return c;
    },
  },
  {
    id: 'royal',
    name: 'Królewska',
    trim: GOLD_DARK,
    pixel(x, y) {
      let c = mix(hex('#2a1056'), hex('#5b2bb5'), y / 15);
      if (x === 0 || x === 9 || y === 0 || y === 15) return GOLD;
      // złote jodełki
      const d = Math.abs(x - 4.5);
      if (y >= 3 && y <= 12 && (y + Math.round(d * 2)) % 4 === 0 && d < 4) c = GOLD;
      return c;
    },
  },
];

function paint(design) {
  const rgba = new Uint8Array(W * H * 4);
  const put = (x, y, c, a = 255) => {
    const i = (y * W + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = a;
  };

  // strona zewnętrzna (1,1) i wewnętrzna (12,1) - ciemniejsza
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 10; x++) {
      const c = design.pixel(x, y);
      put(1 + x, 1 + y, c);
      put(12 + x, 1 + y, shade(c, 0.6));
    }
  }
  // góra, dół i boki w kolorze obrzeża
  for (let x = 0; x < 10; x++) {
    put(1 + x, 0, design.trim);
    put(11 + x, 0, shade(design.trim, 0.8));
  }
  for (let y = 0; y < 16; y++) {
    put(0, 1 + y, design.trim);
    put(11, 1 + y, design.trim);
  }
  // skrzydła elytr: zewnętrzna strona (36,2) 10×20 w kształcie skrzydła, z wzorem peleryny rozciągniętym
  // z 16 do 20 wierszy (obrzeże zostaje na brzegach). Strona wewnętrzna zostaje przezroczysta, jak w grze.
  for (let v = 0; v < WING_H; v++) {
    for (let u = 0; u < WING_W; u++) {
      if (WING[v][u] !== 'X') continue;
      put(WING_X + u, WING_Y + v, design.pixel(u, Math.floor(((v + 0.5) * 16) / WING_H)));
    }
  }
  return rgba;
}

const cache = new Map();

/** PNG 64×32 wbudowanej peleryny albo null, gdy nie ma takiego projektu. */
function render(id) {
  const design = DESIGNS.find((d) => d.id === id);
  if (!design) return null;
  if (!cache.has(id)) cache.set(id, encodePng(W, H, paint(design)));
  return cache.get(id);
}

module.exports = { DESIGNS, render, encodePng };
