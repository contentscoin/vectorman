/**
 * Centreline tracing on the real line-art fixture.
 *
 * This is the case the feature exists for. Traced as fills, an inked drawing comes
 * back as two parallel outlines per stroke: correct, but useless as a toolpath and
 * several times the nodes. The comparison below is the whole argument.
 *
 * Run: node scripts/measure-strokes.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { analyzeImage, emitSvg, resolvePreset, vectorize } from '../packages/core/dist/index.js';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');

const FIXTURES = join(import.meta.dirname, '..', 'tmp', 'fixtures');
const OUT = join(import.meta.dirname, '..', 'tmp', 'strokes');
mkdirSync(OUT, { recursive: true });

async function load(name) {
  const { data, info } = await sharp(readFileSync(join(FIXTURES, name)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

const image = await load('lineart.png');
console.log(`lineart.png ${image.width}x${image.height}`);
console.log(`analyzer recommends: ${analyzeImage(image).recommended.presetId}\n`);

const header = 'variant                 colors pieces strokes nodes    svg  width  blocked';
console.log(header);
console.log('-'.repeat(header.length));

const variants = [
  ['lineart, fills only', resolvePreset('lineart', { strokeMode: 'off' })],
  ['lineart (auto)', resolvePreset('lineart')],
  ['centerline (force)', resolvePreset('centerline')],
];

for (const [label, options] of variants) {
  const result = vectorize(image, options);
  const svg = emitSvg(result, { pretty: true });
  writeFileSync(join(OUT, `lineart-${label.replace(/[^a-z]+/gi, '-')}.svg`), svg);

  console.log(
    `${label.padEnd(23)} ${String(result.stats.colors).padStart(6)} ` +
      `${String(result.stats.pieces).padStart(6)} ${String(result.stats.strokes).padStart(7)} ` +
      `${String(result.stats.nodes).padStart(5)} ${(Buffer.byteLength(svg) / 1024).toFixed(1).padStart(6)}K ` +
      `${String(result.strokeReport.medianWidth ?? '-').padStart(6)} ` +
      `${String(result.strokeReport.blockedByNeighbours).padStart(8)}`
  );
}

console.log(`\nSVGs in ${OUT}`);
