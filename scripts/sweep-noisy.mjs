/**
 * Find settings that actually tame a compressed JPEG.
 *
 * The target is the same 4-colour logo saved at JPEG quality 22. A good result
 * recovers roughly 4 colours and a handful of pieces. A bad one returns dozens of
 * speckle pieces, each a separate shape a designer has to delete by hand.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { analyzeImage, emitSvg, vectorize } from '../packages/core/dist/index.js';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');

const { data, info } = await sharp(
  readFileSync(join(import.meta.dirname, '..', 'tmp', 'fixtures', 'logo-noisy.jpg'))
)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const image = {
  width: info.width,
  height: info.height,
  data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
};

const analysis = analyzeImage(image);
console.log(
  `noise ${analysis.noiseEstimate.toFixed(3)}, classification ${analysis.classification}, ` +
    `recommends ${analysis.recommended.presetId} ${JSON.stringify(analysis.recommended.options)}\n`
);

const header = 'maxColors denoise merge minArea  colors pieces  nodes    svg';
console.log(header);
console.log('-'.repeat(header.length));

for (const maxColors of [5, 6, 8]) {
  for (const denoise of [50, 70, 85]) {
    for (const merge of [8, 12, 16]) {
      for (const minArea of [undefined, 120]) {
        const result = vectorize(image, {
          maxColors,
          denoise,
          colorMergeThreshold: merge,
          minArea,
          detail: 55,
          smoothing: 62,
          background: 'auto',
        });
        const svg = emitSvg(result);
        console.log(
          `${String(maxColors).padStart(9)} ${String(denoise).padStart(7)} ${String(merge).padStart(5)} ` +
            `${String(minArea ?? 'auto').padStart(7)}  ${String(result.stats.colors).padStart(6)} ` +
            `${String(result.stats.pieces).padStart(6)} ${String(result.stats.nodes).padStart(6)} ` +
            `${(Buffer.byteLength(svg) / 1024).toFixed(1).padStart(6)}K  ${result.layers.map((l) => l.hex).join(' ')}`
        );
      }
    }
  }
}
