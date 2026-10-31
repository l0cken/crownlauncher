// Podgląd 3D skina Minecrafta w czystym WebGL (bez bibliotek) + narzędzia do obróbki tekstury skina.

const VERT = `
attribute vec3 aPos;
attribute vec2 aUv;
attribute float aShade;
uniform mat4 uMvp;
varying vec2 vUv;
varying float vShade;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  vUv = aUv;
  vShade = aShade;
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
varying float vShade;
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (c.a < 0.5) discard;
  gl_FragColor = vec4(c.rgb * vShade, 1.0);
}`;

// ---- obróbka obrazów -------------------------------------------------------

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Nie udało się wczytać obrazu skina.'));
    img.src = src;
  });
}

// Kopiuje prostokąt z odbiciem poziomym (konwersja starych skinów 64x32 -> 64x64).
const LEGACY_RECTS = [
  [4, 16, 16, 32, 4, 4],
  [8, 16, 16, 32, 4, 4],
  [0, 20, 24, 32, 4, 12],
  [4, 20, 16, 32, 4, 12],
  [8, 20, 8, 32, 4, 12],
  [12, 20, 16, 32, 4, 12],
  [44, 16, -8, 32, 4, 4],
  [48, 16, -8, 32, 4, 4],
  [40, 20, 0, 32, 4, 12],
  [44, 20, -8, 32, 4, 12],
  [48, 20, -16, 32, 4, 12],
  [52, 20, -8, 32, 4, 12],
];

function setAlpha(data, x0, y0, x1, y1, alpha) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * 64 + x) * 4 + 3] = alpha;
}

/** Zwraca canvas 64x64 gotowy do użycia jako tekstura (z konwersją starego formatu). */
export function toSkinCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);

  const image = ctx.getImageData(0, 0, 64, 64);
  const data = image.data;
  const legacy = img.height === 32;

  if (legacy) {
    const src = new Uint8ClampedArray(data);
    for (const [x, y, ox, oy, w, h] of LEGACY_RECTS) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const s = ((y + j) * 64 + x + i) * 4;
          const d = ((y + oy + j) * 64 + x + ox + (w - 1 - i)) * 4;
          data[d] = src[s];
          data[d + 1] = src[s + 1];
          data[d + 2] = src[s + 2];
          data[d + 3] = src[s + 3];
        }
      }
    }
    // stary format nie miał przezroczystości hełmu: pełny prostokąt = brak nakładki
    let hasTransparency = false;
    for (let y = 0; y < 16 && !hasTransparency; y++) {
      for (let x = 32; x < 64; x++) {
        if (src[(y * 64 + x) * 4 + 3] < 128) {
          hasTransparency = true;
          break;
        }
      }
    }
    if (!hasTransparency) setAlpha(data, 32, 0, 64, 16, 0);
  }

  // warstwy bazowe zawsze są nieprzezroczyste (tak jak w grze)
  setAlpha(data, 0, 0, 32, 16, 255);
  setAlpha(data, 0, 16, 64, 32, 255);
  setAlpha(data, 16, 48, 48, 64, 255);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Skin typu "slim" (Alex) ma przezroczystą czwartą kolumnę ramion. */
export function detectSlim(img) {
  if (img.height !== 64) return false;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const regions = [
    [50, 16, 2, 4],
    [54, 20, 2, 12],
    [42, 48, 2, 4],
    [46, 52, 2, 12],
  ];
  return regions.every(([x, y, w, h]) => {
    const d = ctx.getImageData(x, y, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  });
}

/** Rysuje twarz skina (z nakładką) do podanego canvasa. */
export function drawHead(canvas, img, size = 56) {
  // całkowita krotność 8 px twarzy na pikselach ekranu - równe piksele przy każdym skalowaniu Windowsa
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.round((size * dpr) / 8));
  canvas.width = 8 * scale;
  canvas.height = 8 * scale;
  canvas.style.width = `${(8 * scale) / dpr}px`;
  canvas.style.height = `${(8 * scale) / dpr}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const skin = toSkinCanvas(img);
  ctx.drawImage(skin, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(skin, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
}

// ---- matematyka macierzy (kolumnowe 4x4) ---------------------------------

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function translate(x, y, z) {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function rotateX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotateY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

// ---- geometria modelu gracza -------------------------------------------------

const SHADE = { front: 0.9, back: 0.72, left: 0.8, right: 0.8, top: 1, bottom: 0.55 };
const EPS = 0.02; // lekkie cofnięcie UV, żeby nie łapać sąsiednich pikseli

// texH: wysokość tekstury (64 dla skina, 32 dla peleryny); swap: zamiana tekstur przodu i tyłu (peleryna:
// zewnętrzna strona, widoczna z tyłu gracza, leży w obszarze "przodu" tekstury).
function pushBox(out, { pos, size, uv, inflate = 0, texH = 64, swap = false }) {
  const [px, py, pz] = pos;
  const [w, h, d] = size;
  const [u, v] = uv;
  const x0 = px - inflate;
  const x1 = px + w + inflate;
  const y0 = py - inflate;
  const y1 = py + h + inflate;
  const z0 = pz - inflate;
  const z1 = pz + d + inflate;

  const face = (shade, corners, rx, ry, rw, rh) => {
    const uvs = [
      [rx + EPS, ry + EPS],
      [rx + rw - EPS, ry + EPS],
      [rx + rw - EPS, ry + rh - EPS],
      [rx + EPS, ry + rh - EPS],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...corners[i], uvs[i][0] / 64, uvs[i][1] / texH, shade);
  };

  const frontU = swap ? u + d + w + d : u + d;
  const backU = swap ? u + d : u + d + w + d;
  face(SHADE.front, [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]], frontU, v + d, w, h);
  face(SHADE.back, [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]], backU, v + d, w, h);
  face(SHADE.right, [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]], u, v + d, d, h);
  face(SHADE.left, [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], u + d + w, v + d, d, h);
  face(SHADE.top, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], u + d, v, w, d);
  face(SHADE.bottom, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], u + d + w, v, w, d);
}

function buildModel(slim) {
  const aw = slim ? 3 : 4;
  const parts = [
    { pos: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], ov: [32, 0], inflate: 0.5 }, // głowa
    { pos: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], ov: [16, 32], inflate: 0.25 }, // tułów
    { pos: [-4 - aw, 12, -2], size: [aw, 12, 4], uv: [40, 16], ov: [40, 32], inflate: 0.25 }, // prawa ręka
    { pos: [4, 12, -2], size: [aw, 12, 4], uv: [32, 48], ov: [48, 48], inflate: 0.25 }, // lewa ręka
    { pos: [-4, 0, -2], size: [4, 12, 4], uv: [0, 16], ov: [0, 32], inflate: 0.25 }, // prawa noga
    { pos: [0, 0, -2], size: [4, 12, 4], uv: [16, 48], ov: [0, 48], inflate: 0.25 }, // lewa noga
  ];
  const out = [];
  for (const p of parts) pushBox(out, { pos: p.pos, size: p.size, uv: p.uv });
  for (const p of parts) pushBox(out, { pos: p.pos, size: p.size, uv: p.ov, inflate: p.inflate });
  return new Float32Array(out);
}

/** Peleryna: pudełko 10×16×1 tuż za plecami, zawieszone na górnej krawędzi i lekko odchylone od pleców. */
function buildCape() {
  const out = [];
  pushBox(out, { pos: [-5, 8, -3.35], size: [10, 16, 1], uv: [0, 0], texH: 32, swap: true });
  const a = (9 * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const py = 24;
  const pz = -2.35;
  for (let i = 0; i < out.length; i += 6) {
    const dy = out[i + 1] - py;
    const dz = out[i + 2] - pz;
    out[i + 1] = py + dy * cos - dz * sin;
    out[i + 2] = pz + dy * sin + dz * cos;
  }
  return new Float32Array(out);
}

/**
 * Canvas z teksturą peleryny w układzie 64×32 (albo wielokrotności): obsługuje też stary format 22×17
 * i 46×22 (OptiFine), które leżą w lewym górnym rogu tekstury.
 */
export function toCapeCanvas(img) {
  const legacy = (img.width === 22 && img.height === 17) || (img.width === 46 && img.height === 22);
  const scale = legacy ? 1 : Math.max(1, Math.round(img.width / 64));
  const canvas = document.createElement('canvas');
  canvas.width = 64 * scale;
  canvas.height = 32 * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/** Rysuje zewnętrzną stronę peleryny (to, co widać z tyłu) do canvasa, w całkowitej krotności 10×16 px. */
export function drawCapeFace(canvas, img, height = 96) {
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.round((height * dpr) / 16));
  canvas.width = 10 * scale;
  canvas.height = 16 * scale;
  canvas.style.width = `${(10 * scale) / dpr}px`;
  canvas.style.height = `${(16 * scale) / dpr}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const src = toCapeCanvas(img);
  const k = src.width / 64;
  ctx.drawImage(src, 1 * k, 1 * k, 10 * k, 16 * k, 0, 0, canvas.width, canvas.height);
}

// ---- widok ----------------------------------------------------------------

/**
 * Tworzy interaktywny podgląd 3D na podanym canvasie (przeciąganie myszą obraca, kółko przybliża).
 * Zwraca null, gdy WebGL jest niedostępny.
 */
export function createSkinViewer(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
  if (!gl) return null;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const loc = {
    pos: gl.getAttribLocation(program, 'aPos'),
    uv: gl.getAttribLocation(program, 'aUv'),
    shade: gl.getAttribLocation(program, 'aShade'),
    mvp: gl.getUniformLocation(program, 'uMvp'),
    tex: gl.getUniformLocation(program, 'uTex'),
  };

  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const capeBuffer = gl.createBuffer();
  const capeTexture = gl.createTexture();
  let vertexCount = 0;
  let capeCount = 0;
  let ready = false;

  let yaw = -0.55;
  let pitch = 0.14;
  let zoom = 1;
  let dragging = false;
  let idleSince = 0;
  let destroyed = false;
  let waitingForDom = 0;

  function setSkin(img, variant = 'classic') {
    const data = buildModel(variant === 'slim');
    vertexCount = data.length / 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, toSkinCanvas(img));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    ready = true;
  }

  /** Ustawia pelerynę na plecach modelu; null ją zdejmuje. */
  function setCape(img) {
    if (!img) {
      capeCount = 0;
      return;
    }
    const data = buildCape();
    capeCount = data.length / 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, capeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, capeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, toCapeCanvas(img));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function frame(now) {
    if (destroyed) return;
    if (!canvas.isConnected) {
      // canvas bywa podpięty do DOM dopiero chwilę po utworzeniu
      if (++waitingForDom > 120) return;
      requestAnimationFrame(frame);
      return;
    }
    waitingForDom = 0;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    if (!dragging && now - idleSince > 1500) yaw += 0.008;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (ready && vertexCount) {
      gl.enable(gl.DEPTH_TEST);
      const dist = 62 / zoom;
      const proj = perspective((35 * Math.PI) / 180, w / h, 1, 300);
      const view = mul(translate(0, 0, -dist), mul(rotateX(pitch), mul(rotateY(yaw), translate(0, -16, 0))));
      gl.uniformMatrix4fv(loc.mvp, false, mul(proj, view));

      const stride = 6 * 4;
      const draw = (buf, tex, count) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc.pos);
        gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(loc.uv);
        gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(loc.shade);
        gl.vertexAttribPointer(loc.shade, 1, gl.FLOAT, false, stride, 20);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc.tex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      };
      draw(buffer, texture, vertexCount);
      if (capeCount) draw(capeBuffer, capeTexture, capeCount);
    }
    requestAnimationFrame(frame);
  }

  // ---- sterowanie myszą ----
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.012;
    pitch = Math.max(-0.9, Math.min(0.9, pitch + (e.clientY - lastY) * 0.008));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const stop = () => {
    dragging = false;
    idleSince = performance.now();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom = Math.max(0.6, Math.min(2.2, zoom * (e.deltaY < 0 ? 1.08 : 0.92)));
    },
    { passive: false },
  );

  requestAnimationFrame(frame);

  return {
    setSkin,
    setCape,
    /** Ustawia kąt widoku (radiany) i wstrzymuje automatyczny obrót na minutę. */
    setView(newYaw, newPitch = pitch) {
      yaw = newYaw;
      pitch = newPitch;
      idleSince = performance.now() + 60000;
    },
    destroy() {
      destroyed = true;
    },
  };
}
