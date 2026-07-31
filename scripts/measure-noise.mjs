/**
 * Compare candidate noise metrics on the fixtures, so the denoise gate is set from
 * measurement rather than guesswork.
 *
 * The requirement is a metric that separates clean anti-aliased art (must NOT be
 * filtered, because a median filter shifts junctions and chamfers corners) from
 * JPEG-compressed art (must be filtered, because ringing becomes speckle shapes).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { estimateNoise } from '../packages/core/dist/index.js';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');
const FIXTURES = join(import.meta.dirname, '..', 'tmp', 'fixtures');

async function load(name) {
  const { data, info } = await sharp(readFileSync(join(FIXTURES, name)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}

const luma = (d, o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];

/**
 * Candidate B: overshoot / local-extremum rate.
 *
 * A clean anti-aliased edge is a monotone ramp, so every interior pixel lies
 * between its neighbours. JPEG ringing overshoots past both flat levels, which
 * makes the pixel a local extremum. That difference is the discriminator.
 */
function overshootRate(image, margin = 4) {
  const { width, height, data } = image;
  let extremal = 0;
  let considered = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = (y * width + x) * 4;
      if (data[c + 3] < 250) continue;

      let low = Infinity;
      let high = -Infinity;
      let transparent = false;
      for (let dy = -1; dy <= 1 && !transparent; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const o = ((y + dy) * width + (x + dx)) * 4;
          if (data[o + 3] < 250) { transparent = true; break; }
          const v = luma(data, o);
          if (v < low) low = v;
          if (v > high) high = v;
        }
      }
      if (transparent) continue;

      considered++;
      const v = luma(data, c);
      if (v > high + margin || v < low - margin) extremal++;
    }
  }

  return considered > 0 ? extremal / considered : 0;
}

/** Candidate C: how much a 3x3 median would change the image, over all pixels. */
function medianDelta(image) {
  const { width, height, data } = image;
  let total = 0;
  let samples = 0;
  const buf = new Array(9);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = (y * width + x) * 4;
      if (data[c + 3] < 250) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * width + (x + dx)) * 4;
          if (data[o + 3] < 250) continue;
          buf[n++] = luma(data, o);
        }
      }
      if (n < 9) continue;
      const sorted = buf.slice(0, n).sort((a, b) => a - b);
      total += Math.abs(luma(data, c) - sorted[Math.floor(n / 2)]);
      samples++;
    }
  }

  return samples > 0 ? total / samples : 0;
}

const files = ['logo.png', 'sticker.png', 'lineart.png', 'logo-noisy.jpg', 'photo.jpg', 'pixelart.png'];
const want = {
  'logo.png': 'clean  -> must NOT filter',
  'sticker.png': 'clean  -> must NOT filter',
  'lineart.png': 'clean  -> must NOT filter',
  'logo-noisy.jpg': 'NOISY  -> must filter',
  'photo.jpg': 'photo  -> filtering is harmless',
  'pixelart.png': 'clean  -> must NOT filter',
};

console.log('file              A:flat-area  B:overshoot  C:medianDelta   target');
console.log('-'.repeat(78));
for (const file of files) {
  const image = await load(file);
  const a = estimateNoise(image);
  const b = overshootRate(image);
  const c = medianDelta(image);
  console.log(
    `${file.padEnd(17)} ${a.toFixed(4).padStart(10)} ${b.toFixed(4).padStart(12)} ${c.toFixed(3).padStart(13)}   ${want[file]}`
  );
}
