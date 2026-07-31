/**
 * Measure the sample images and write the numbers the landing page displays.
 *
 * The page claims specific counts for each sample. Those counts are produced here,
 * by running the real engine over the real files at build time, so the marketing
 * figures cannot drift away from what the product actually does. If a change makes
 * the tracer worse, the landing page says so.
 *
 * Run: node scripts/measure-samples.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { analyzeImage, emitSvg, resolvePreset, vectorize } from '../packages/core/dist/index.js';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');

const SAMPLES_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'public', 'samples');
const OUT_FILE = join(import.meta.dirname, '..', 'apps', 'web', 'src', 'lib', 'sample-stats.json');

/** Presets pinned per sample, matching what the studio auto-selects. */
const PINNED = { 'pixelart.png': 'pixel-art', 'lineart.png': 'lineart' };

const files = readdirSync(SAMPLES_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
const stats = {};

for (const file of files) {
  const buffer = readFileSync(join(SAMPLES_DIR, file));
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };

  const analysis = analyzeImage(image);
  const presetId = PINNED[file] ?? analysis.recommended.presetId;
  const result = vectorize(
    image,
    resolvePreset(presetId, PINNED[file] ? {} : analysis.recommended.options)
  );
  const svg = emitSvg(result);

  stats[file] = {
    width: result.width,
    height: result.height,
    sourceBytes: buffer.byteLength,
    preset: presetId,
    colors: result.stats.colors,
    pieces: result.stats.pieces,
    strokes: result.stats.strokes,
    strokeWidth: result.strokeReport.medianWidth,
    nodes: result.stats.nodes,
    nodesBeforeFitting: result.stats.nodesBeforeFitting,
    svgBytes: Buffer.byteLength(svg, 'utf8'),
    elapsedMs: result.stats.elapsedMs,
    suitability: analysis.suitability,
    classification: analysis.classification,
    score: analysis.score,
    palette: result.layers.map((l) => l.hex),
    // The traced SVG itself, so the page can show the actual output rather than a
    // screenshot of it.
    svg,
  };

  console.log(
    `${file.padEnd(18)} ${presetId.padEnd(11)} ${String(result.stats.colors).padStart(2)} colors  ` +
      `${String(result.stats.pieces).padStart(3)} pieces  ` +
      `${String(result.stats.strokes).padStart(3)} strokes  ` +
      `${String(result.stats.nodes).padStart(4)} nodes  ` +
      `${(Buffer.byteLength(svg) / 1024).toFixed(1)}K`
  );
}

writeFileSync(OUT_FILE, JSON.stringify(stats, null, 2) + '\n');
console.log(`\nWrote ${OUT_FILE}`);
