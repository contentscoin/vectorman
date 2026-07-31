/**
 * Engine check against realistic artwork.
 *
 * The synthetic suite in verify.mjs proves correctness on shapes with known exact
 * answers. This one runs the fixtures, which carry real anti-aliasing and real JPEG
 * ringing, and reports what actually comes out. Those two things are what separate
 * a tracer that works in a test from one that works on a client's file.
 *
 * Run: node scripts/make-fixtures.mjs && node scripts/verify-real.mjs
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  analyzeImage,
  emitSvg,
  resolvePreset,
  suggestMerges,
  vectorize,
} from '../packages/core/dist/index.js';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');

const FIXTURES = join(import.meta.dirname, '..', 'tmp', 'fixtures');
const OUT = join(import.meta.dirname, '..', 'tmp', 'real');
mkdirSync(OUT, { recursive: true });

if (!existsSync(FIXTURES)) {
  console.error('Fixtures missing. Run: node scripts/make-fixtures.mjs');
  process.exit(1);
}

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) console.log(`    \u2713 ${label}`);
  else {
    failures++;
    console.log(`    \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function load(name) {
  const buffer = readFileSync(join(FIXTURES, name));
  const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

const cases = [
  {
    file: 'logo.png',
    expect: 'flat art, exact brand colours preserved, sharp corners, few nodes',
    assertions: (image, result, analysis, svg) => {
      check(`analyzer says suitable (${analysis.suitability}, ${analysis.classification})`,
        ['excellent', 'good'].includes(analysis.suitability));
      check(`4 colour layers (got ${result.stats.colors})`, result.stats.colors === 4);
      check('brand navy #1d3557 preserved exactly', result.layers.some((l) => l.hex === '#1d3557'),
        result.layers.map((l) => l.hex).join(' '));
      check('brand red #e63946 preserved exactly', result.layers.some((l) => l.hex === '#e63946'));
      check(`node count stays low (${result.stats.nodes})`, result.stats.nodes < 120);
      check(`piece count matches the artwork (${result.stats.pieces})`, result.stats.pieces <= 6);
      check('background is transparent (no white layer)', !result.layers.some((l) => l.hex === '#ffffff'));
      check(`svg is compact (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`, Buffer.byteLength(svg) < 6000);
      // The triangle sits on the badge and the circle sits on the triangle, so the
      // badge layer must carry a hole for the triangle.
      const badge = result.layers.find((l) => l.hex === '#1d3557');
      check('badge layer has a hole punched by the triangle',
        badge.shapes.some((s) => s.contours.length > 1),
        `contours per shape: ${badge.shapes.map((s) => s.contours.length).join(',')}`);
    },
  },
  {
    file: 'sticker.png',
    expect: 'white background removed, enclosed shapes kept',
    assertions: (image, result, analysis, svg) => {
      check(`suitable (${analysis.suitability})`, ['excellent', 'good'].includes(analysis.suitability));
      check('white background removed', !result.layers.some((l) => l.hex === '#ffffff'));
      // The artwork uses exactly four colours over white. Anything extra is an
      // anti-aliasing blend that leaked into the palette.
      check(`4 colour layers, no anti-aliasing blends (got ${result.stats.colors})`,
        result.stats.colors === 4, result.layers.map((l) => l.hex).join(' '));
      check(`nodes reasonable (${result.stats.nodes})`, result.stats.nodes < 200);
      check('dark eyes survived as separate pieces',
        (result.layers.find((l) => l.hex === '#264653')?.shapes.length ?? 0) >= 2,
        `pieces: ${result.layers.find((l) => l.hex === '#264653')?.shapes.length}`);
    },
  },
  {
    file: 'lineart.png',
    preset: 'lineart',
    expect: 'strokes recovered as centrelines with the drawn weight',
    assertions: (image, result, analysis, svg) => {
      check(`classified as line art or flat art (${analysis.classification})`,
        ['line-art', 'flat-art'].includes(analysis.classification));
      check('ink layer present', result.layers.length >= 1);

      // The drawing has 5 stroke groups; thinning splits the crossed slash into
      // extra arms at its junctions, so somewhat more paths than strokes is correct.
      check(`centrelines recovered (${result.stats.strokes})`, result.stats.strokes >= 5);
      check('nothing left as a filled outline', result.stats.pieces === 0,
        `pieces ${result.stats.pieces}`);
      check(`recovered width matches the drawn 9px (${result.strokeReport.medianWidth})`,
        Math.abs((result.strokeReport.medianWidth ?? 0) - 9) < 0.5);
      check('nothing was blocked by a neighbouring colour',
        result.strokeReport.blockedByNeighbours === 0);

      // The point of the feature: an order-of-magnitude fewer nodes than the two
      // parallel outlines a fill produces.
      const filled = vectorize(image, resolvePreset('lineart', { strokeMode: 'off' }));
      check(
        `far fewer nodes than filled outlines (${filled.stats.nodes} -> ${result.stats.nodes})`,
        result.stats.nodes * 2 < filled.stats.nodes
      );
      check(
        `smaller file too (${(Buffer.byteLength(emitSvg(filled)) / 1024).toFixed(1)}K -> ${(Buffer.byteLength(svg) / 1024).toFixed(1)}K)`,
        Buffer.byteLength(svg) < Buffer.byteLength(emitSvg(filled))
      );
      check('svg uses stroke, not fill, for the ink', /fill="none" stroke="#111111"/.test(svg));
    },
  },
  {
    file: 'logo-noisy.jpg',
    expect: 'JPEG ringing suppressed; should land close to the clean original',
    assertions: (image, result, analysis, svg) => {
      check(`noise detected (${analysis.noiseEstimate.toFixed(3)})`, analysis.noiseEstimate > 0.1);
      check('denoise raised in response', (analysis.recommended.options.denoise ?? 0) >= 70);
      check('colour merging raised in response',
        (analysis.recommended.options.colorMergeThreshold ?? 0) >= 12);
      check(`speckle suppressed (${result.stats.pieces} pieces)`, result.stats.pieces <= 10);
      check(`node count controlled (${result.stats.nodes})`, result.stats.nodes < 150);
      check(`palette recovered to about 4 colours (got ${result.stats.colors})`,
        result.stats.colors >= 3 && result.stats.colors <= 5,
        result.layers.map((l) => l.hex).join(' '));
    },
  },
  {
    file: 'logo-blurry.png',
    expect: 'blur is detected and reported',
    assertions: (image, result, analysis) => {
      check(
        `soft edges detected (hard ${analysis.hardEdgeRatio.toFixed(3)} vs soft ${analysis.softEdgeRatio.toFixed(3)})`,
        analysis.hardEdgeRatio / (analysis.hardEdgeRatio + analysis.softEdgeRatio) < 0.12
      );
      check(
        'blur warning raised',
        analysis.findings.some((f) => /blurred or upscaled/.test(f.message)),
        analysis.findings.map((f) => f.message).join(' | ')
      );
    },
  },
  {
    file: 'photo.jpg',
    expect: 'refused',
    assertions: (image, result, analysis) => {
      check(`refused (${analysis.suitability}, score ${analysis.score})`, analysis.suitability === 'poor');
      check('classified as photo or gradient art',
        ['photo', 'gradient-art'].includes(analysis.classification), analysis.classification);
      check('has an error-level finding', analysis.findings.some((f) => f.level === 'error'));
    },
  },
  {
    file: 'pixelart.png',
    preset: 'pixel-art',
    expect: 'traced literally; the subject is not mistaken for a background',
    assertions: (image, result, analysis, svg) => {
      check(`pixel art recommended (${analysis.recommended.presetId})`,
        analysis.recommended.presetId === 'pixel-art');
      // The dark body reaches the top and bottom edges, but the artwork sits on
      // transparency, so nothing should be treated as a removable backdrop.
      check(`all 3 sprite colours kept (got ${result.stats.colors})`,
        result.stats.colors === 3, result.layers.map((l) => l.hex).join(' '));
      check('dark body survived', result.layers.some((l) => l.hex === '#264653'));
      check('all segments are straight lines',
        result.layers.every((l) =>
          l.shapes.every((s) => s.contours.every((c) => c.segments.every((seg) => seg.kind === 'line')))
        ));
      check('all coordinates land on integers',
        result.layers.every((l) =>
          l.shapes.every((s) =>
            s.contours.every((c) =>
              [c.start, ...c.segments.map((x) => x.to)].every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))
            )
          )
        ));
    },
  },
];

for (const testCase of cases) {
  const image = await load(testCase.file);
  const analysis = analyzeImage(image);
  const presetId = testCase.preset ?? analysis.recommended.presetId;
  const options = resolvePreset(presetId, testCase.preset ? {} : analysis.recommended.options);
  const result = vectorize(image, options);
  const svg = emitSvg(result, { pretty: true });
  writeFileSync(join(OUT, testCase.file.replace(/\.\w+$/, '.svg')), svg);

  console.log(
    `\n${testCase.file}  (${image.width}x${image.height}, preset "${presetId}")` +
      `\n  expect: ${testCase.expect}` +
      `\n  got: ${result.stats.colors} colors, ${result.stats.pieces} pieces, ` +
      `${result.stats.nodes} nodes (raw ${result.stats.nodesBeforeFitting}), ` +
      `${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB, ${result.stats.elapsedMs}ms` +
      `\n  palette: ${result.layers.map((l) => l.hex).join(' ')}`
  );
  testCase.assertions(image, result, analysis, svg);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`SVGs written to ${OUT}`);
if (failures > 0) process.exit(1);
