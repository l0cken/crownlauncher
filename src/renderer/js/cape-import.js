import { loadImage } from './skin-viewer.js';

/**
 * Układy tekstury peleryny, które spotyka się w internecie. Gra (CustomSkinLoader) oczekuje 64×32 albo jego
 * wielokrotności 2:1, więc inne układy przepisujemy na canvas w lewy górny róg - tak samo robi to Minecraft:
 *   64×32  standard (i HD: 128×64, 256×128, ...)
 *   46×22  OptiFine (i wielokrotności: 92×44, ...)  - to wycinek lewego górnego rogu 64×32
 *   22×17  stary format samej peleryny (i wielokrotności) - jw.
 */
const LAYOUTS = [
  { w: 64, h: 32, name: 'standardowy' },
  { w: 46, h: 22, name: 'OptiFine' },
  { w: 22, h: 17, name: 'stary' },
];

const MAX_SCALE = 32; // 2048×1024 - więcej nie ma sensu i tylko zjada pamięć karty graficznej

/**
 * Kształt zewnętrznej strony skrzydła elytr (10×20) - taki sam jak w src/main/core/cape-art.js (maska WING).
 * Skrzydło leży w teksturze od (36,2); strona wewnętrzna zostaje przezroczysta, jak w grze.
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

/** Czy w obszarze elytr (x 22–45, y 0–21 przy skali 1) jest jakikolwiek nieprzezroczysty piksel. */
function hasElytra(ctx, k) {
  const { data } = ctx.getImageData(22 * k, 0, 24 * k, 22 * k);
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

/** Dorysowuje skrzydła z zewnętrznej strony peleryny (10×16 od (1,1)), rozciągnięte do 20 wierszy. */
function addElytra(ctx, canvas, k) {
  ctx.imageSmoothingEnabled = false;
  for (let v = 0; v < WING.length; v++) {
    const sv = Math.floor(((v + 0.5) * 16) / WING.length);
    for (let u = 0; u < WING[v].length; u++) {
      if (WING[v][u] !== 'X') continue;
      ctx.drawImage(canvas, (1 + u) * k, (1 + sv) * k, k, k, (36 + u) * k, (2 + v) * k, k, k);
    }
  }
}

/** Zwraca { layout, scale } dla wymiarów pasujących do peleryny albo null. */
export function detectCapeLayout(width, height) {
  for (const layout of LAYOUTS) {
    if (width % layout.w !== 0) continue;
    const scale = width / layout.w;
    if (scale >= 1 && height === layout.h * scale) return { layout, scale };
  }
  return null;
}

export const isCapeSize = (width, height) => detectCapeLayout(width, height) !== null;

/**
 * Dopasowuje obraz do formatu peleryny gry. Zwraca { dataUrl, width, height, changed }:
 * `changed` mówi, czy zmienił się układ/rozmiar (inny format albo zbyt duży). Obraz zawsze przechodzi przez canvas,
 * więc do biblioteki trafia zwykły 8-bitowy PNG RGBA (bez trybów PNG, z którymi mogłoby mieć kłopot CustomSkinLoader).
 */
export async function normalizeCape(dataUrl) {
  const img = await loadImage(dataUrl);
  const found = detectCapeLayout(img.naturalWidth, img.naturalHeight);
  if (!found) {
    throw new Error(
      `To nie wygląda na pelerynę: ${img.naturalWidth}×${img.naturalHeight} px. ` +
        'Peleryna ma proporcje 2:1 (np. 64×32, 128×64) albo 46×22 (OptiFine) / 22×17 px.',
    );
  }
  const { layout, scale } = found;
  const target = Math.min(scale, MAX_SCALE);
  const changed = !(layout.w === 64 && scale === target);

  const canvas = document.createElement('canvas');
  canvas.width = 64 * target;
  canvas.height = 32 * target;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // przy zmniejszaniu (ponad 2048 px) skalujemy cały obraz, w pozostałych przypadkach wklejamy 1:1 w lewy górny róg
  const k = target / scale;
  ctx.drawImage(img, 0, 0, Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k));

  // plik bez skrzydeł elytr (np. 22×17 albo sama peleryna 64×32): bez nich elytry byłyby niewidoczne
  const elytraAdded = !hasElytra(ctx, target);
  if (elytraAdded) addElytra(ctx, canvas, target);

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    changed,
    elytraAdded,
  };
}
