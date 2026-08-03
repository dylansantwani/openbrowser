/**
 * Animated GIF encoder (GIF89a + LZW), written for the service worker.
 *
 * Recording a short animation is genuinely useful — showing a hover state, a
 * transition, or a multi-step flow in one attachment says more than five
 * stills. There is no built-in GIF encoder in the platform and pulling in a
 * library would break the project's zero-dependency promise, so it is here.
 *
 * Colour handling is a fixed 6x6x6 cube plus a 40-step grey ramp. Screen
 * recordings are mostly flat UI colours and text, which that palette handles
 * well; a per-frame median-cut would look marginally better on photographs and
 * cost far more code and time than the use case justifies.
 */

/** 216-colour RGB cube + 40 greys = 256 entries. */
const PALETTE = buildPalette();

function buildPalette() {
  const colors = [];
  const levels = [0, 51, 102, 153, 204, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) colors.push([r, g, b]);
    }
  }
  // Greys matter disproportionately for UI: text, borders, and shadows all
  // live here, and the cube only offers six grey steps.
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i / 39) * 255);
    colors.push([v, v, v]);
  }
  return colors;
}

/**
 * Nearest palette index, cached.
 *
 * The cache is what makes this fast enough: a 640x360 frame is 230k pixels, and
 * a full 256-entry search per pixel would take seconds. Real screenshots use a
 * few thousand distinct colours, so the cache hits almost every time.
 */
const colorCache = new Map();

function nearestColor(r, g, b) {
  // Quantise to 5 bits per channel before caching — visually indistinguishable
  // here, and it collapses anti-aliasing noise into shared cache entries.
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const cached = colorCache.get(key);
  if (cached !== undefined) return cached;

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i];
    // Weighted to match human luminance sensitivity; plain Euclidean distance
    // visibly favours the wrong greens.
    const dr = (r - pr) * 0.3;
    const dg = (g - pg) * 0.59;
    const db = (b - pb) * 0.11;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
      if (distance === 0) break;
    }
  }

  if (colorCache.size < 40_000) colorCache.set(key, best);
  return best;
}

/** Growable little-endian byte buffer. */
class ByteWriter {
  constructor() {
    this.bytes = [];
  }
  byte(v) {
    this.bytes.push(v & 0xff);
  }
  short(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }
  string(s) {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
  }
  raw(arr) {
    for (const v of arr) this.bytes.push(v & 0xff);
  }
  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * LZW compression, GIF variant.
 *
 * Differs from plain LZW in three ways that all matter: codes are packed
 * least-significant-bit first, the dictionary resets via an explicit clear code
 * once it fills, and output is chunked into sub-blocks of at most 255 bytes.
 */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const resetDict = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };

  emit(clearCode);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k; // cheaper than string keys, and collision-free here
    const existing = dict.get(key);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    emit(prefix);
    dict.set(key, nextCode++);

    if (nextCode > 1 << codeSize) {
      if (codeSize < 12) {
        codeSize++;
      } else {
        emit(clearCode);
        resetDict();
      }
    }
    prefix = k;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);

  return out;
}

/** Split compressed data into GIF's length-prefixed sub-blocks. */
function writeSubBlocks(writer, data) {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    writer.byte(chunk.length);
    writer.raw(chunk);
  }
  writer.byte(0); // block terminator
}

/**
 * Encode ImageBitmaps into an animated GIF.
 *
 * @param {ImageBitmap[]} bitmaps
 * @param {{width?: number, delayMs?: number, loop?: boolean}} opts
 * @returns {Promise<string>} base64 GIF
 */
export async function encodeGif(bitmaps, { width = 640, delayMs = 400, loop = true } = {}) {
  if (!bitmaps.length) throw new Error('no frames to encode');

  const scale = Math.min(1, width / bitmaps[0].width);
  const outWidth = Math.max(1, Math.round(bitmaps[0].width * scale));
  const outHeight = Math.max(1, Math.round(bitmaps[0].height * scale));

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const writer = new ByteWriter();

  // --- Header + logical screen descriptor ---
  writer.string('GIF89a');
  writer.short(outWidth);
  writer.short(outHeight);
  writer.byte(0xf7); // global colour table, 8 bits per channel, 256 entries
  writer.byte(0);    // background colour index
  writer.byte(0);    // default pixel aspect ratio

  for (const [r, g, b] of PALETTE) writer.raw([r, g, b]);

  // --- Netscape looping extension ---
  if (loop) {
    writer.raw([0x21, 0xff, 0x0b]);
    writer.string('NETSCAPE2.0');
    writer.raw([0x03, 0x01, 0x00, 0x00, 0x00]); // loop forever
  }

  const delayCentiseconds = Math.max(2, Math.round(delayMs / 10));

  for (const bitmap of bitmaps) {
    ctx.clearRect(0, 0, outWidth, outHeight);
    ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
    const { data } = ctx.getImageData(0, 0, outWidth, outHeight);

    const indices = new Uint8Array(outWidth * outHeight);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      indices[p] = nearestColor(data[i], data[i + 1], data[i + 2]);
    }

    // --- Graphic control extension (per-frame delay) ---
    writer.raw([0x21, 0xf9, 0x04, 0x00]);
    writer.short(delayCentiseconds);
    writer.raw([0x00, 0x00]);

    // --- Image descriptor ---
    writer.byte(0x2c);
    writer.short(0);
    writer.short(0);
    writer.short(outWidth);
    writer.short(outHeight);
    writer.byte(0); // no local colour table, not interlaced

    const minCodeSize = 8;
    writer.byte(minCodeSize);
    writeSubBlocks(writer, lzwEncode(indices, minCodeSize));

    // Yield between frames so a long recording cannot starve the service
    // worker's event loop and get it killed mid-encode.
    await new Promise((r) => setTimeout(r, 0));
  }

  writer.byte(0x3b); // trailer

  return bytesToBase64(writer.toUint8Array());
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
