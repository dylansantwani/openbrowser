#!/usr/bin/env node
/**
 * Generate the extension's icon PNGs.
 *
 * Icons are generated rather than committed as binaries so the artwork is
 * reviewable in a diff and trivially re-tunable. Chrome requires raster icons,
 * so an SVG is not an option, and pulling in an image library for four small
 * squares would not be a good trade — Node ships zlib, and PNG is a simple
 * enough container to write directly.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

// -----------------------------------------------------------------------------
// PNG encoding
// -----------------------------------------------------------------------------

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba width*height*4 */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // bytes 10-12: deflate compression, adaptive filtering, no interlace (all 0)

  // Each scanline is prefixed with its filter type. Filter 0 (none) keeps this
  // simple; deflate still compresses these flat-colour images well.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -----------------------------------------------------------------------------
// Artwork
// -----------------------------------------------------------------------------

const BRAND_FROM = [0x2f, 0x6f, 0xed]; // the accent blue used across the UI
const BRAND_TO = [0x8b, 0x5c, 0xf6];   // violet

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Signed distance to a rounded rectangle, used for anti-aliasing.
 * Negative inside, positive outside, in pixels.
 */
function roundedRectDistance(px, py, halfW, halfH, radius) {
  const dx = Math.abs(px) - (halfW - radius);
  const dy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Coverage from a signed distance, giving ~1px of anti-aliasing. */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/**
 * The mark: a rounded gradient tile with a cursor arrow knocked out of it.
 *
 * A pointer reads as "something is driving this browser" at every size, and
 * unlike a glyph or wordmark it stays legible down to 16px.
 */
function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const half = size / 2;
  const tileHalf = size * 0.46;
  const radius = size * 0.22;

  // Arrow geometry, in units of the icon size so it scales exactly.
  const arrow = [
    [0.36, 0.26],
    [0.72, 0.52],
    [0.53, 0.55],
    [0.62, 0.75],
    [0.52, 0.79],
    [0.44, 0.59],
    [0.30, 0.70],
  ].map(([x, y]) => [x * size, y * size]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const i = (y * size + x) * 4;

      const tile = coverage(roundedRectDistance(cx - half, cy - half, tileHalf, tileHalf, radius));
      if (tile <= 0) continue;

      // Diagonal gradient across the tile.
      const t = Math.min(1, Math.max(0, (cx + cy) / (size * 2)));
      let r = lerp(BRAND_FROM[0], BRAND_TO[0], t);
      let g = lerp(BRAND_FROM[1], BRAND_TO[1], t);
      let b = lerp(BRAND_FROM[2], BRAND_TO[2], t);

      // Knock the arrow out in white. Supersampled, because a hard polygon test
      // produces visibly jagged edges at 16px.
      const inside = arrowCoverage(cx, cy, arrow, size);
      if (inside > 0) {
        r = lerp(r, 255, inside);
        g = lerp(g, 255, inside);
        b = lerp(b, 255, inside);
      }

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(tile * 255);
    }
  }

  return rgba;
}

/** 3x3 supersampled polygon coverage. */
function arrowCoverage(cx, cy, polygon, size) {
  const step = 1 / 3;
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = cx - 0.5 + (sx + 0.5) * step;
      const py = cy - 0.5 + (sy + 0.5) * step;
      if (pointInPolygon(px, py, polygon)) hits++;
    }
  }
  // Small icons need a slightly fatter arrow to stay readable.
  const boost = size <= 32 ? 1.15 : 1;
  return Math.min(1, (hits / 9) * boost);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// -----------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(drawIcon(size), size, size);
  const path = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  process.stdout.write(`wrote ${path} (${png.length} bytes)\n`);
}
