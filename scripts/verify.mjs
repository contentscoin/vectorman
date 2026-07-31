/**
 * Engine verification harness.
 *
 * Generates synthetic artwork with known-correct answers and checks what the
 * engine actually produces. Synthetic input is the point: for a 200px square we
 * know the outline is exactly 4 nodes, so "4 nodes" is a pass and "37 nodes" is a
 * specific, diagnosable failure.
 *
 * Run: node scripts/verify.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  vectorize,
  emitSvg,
  analyzeImage,
  resolvePreset,
  exportPdf,
  exportEps,
  exportDxf,
  suggestMerges,
} from '../packages/core/dist/index.js';

const OUT_DIR = join(import.meta.dirname, '..', 'tmp', 'verify');
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function raster(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { width, height, data };
}

function setPixel(image, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const o = (y * image.width + x) * 4;
  image.data[o] = r;
  image.data[o + 1] = g;
  image.data[o + 2] = b;
  image.data[o + 3] = a;
}

function fillRect(image, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPixel(image, x, y, color);
  }
}

function fillDisc(image, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(image, x, y, color);
    }
  }
}

function save(name, svg) {
  writeFileSync(join(OUT_DIR, name), svg);
}

// Count anchors across all contours of a result.
function countNodes(result) {
  let n = 0;
  for (const layer of result.layers) {
    for (const shape of layer.shapes) {
      for (const contour of shape.contours) n += contour.segments.length;
    }
  }
  return n;
}

/**
 * Anchor points of a contour. The final segment closes back onto `start`, so that
 * duplicate is dropped — otherwise every corner count is off by one.
 */
function contourAnchors(contour) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && Math.abs(last.x - pts[0].x) < 1e-9 && Math.abs(last.y - pts[0].y) < 1e-9) {
    pts.pop();
  }
  return pts;
}

function uniqueAnchors(result) {
  const seen = new Map();
  for (const layer of result.layers) {
    for (const shape of layer.shapes) {
      for (const contour of shape.contours) {
        for (const p of contourAnchors(contour)) {
          seen.set(`${p.x.toFixed(6)},${p.y.toFixed(6)}`, p);
        }
      }
    }
  }
  return [...seen.values()];
}

console.log('\n=== 1. Solid square: exact 4-node outline ===');
{
  const image = raster(200, 200);
  fillRect(image, 40, 40, 120, 120, [230, 57, 70]);

  const result = vectorize(image, { maxColors: 4, background: 'auto' });
  save('square.svg', emitSvg(result, { pretty: true }));

  check('one color layer', result.layers.length === 1, `got ${result.layers.length}`);
  check('one piece', result.stats.pieces === 1, `got ${result.stats.pieces}`);
  check('exactly 4 nodes', result.stats.nodes === 4, `got ${result.stats.nodes}`);
  check(
    'color preserved exactly',
    result.layers[0]?.hex === '#e63946',
    `got ${result.layers[0]?.hex}`
  );
  check('all segments are lines', result.layers[0].shapes[0].contours[0].segments.every((s) => s.kind === 'line'));

  const svg = emitSvg(result);
  check('svg has viewBox 0 0 200 200', svg.includes('viewBox="0 0 200 200"'));
  check('svg has one path', (svg.match(/<path/g) || []).length === 1);
}

console.log('\n=== 2. Disc: low node count, smooth curves ===');
{
  const image = raster(300, 300);
  fillDisc(image, 150, 150, 110, [29, 53, 87]);

  const result = vectorize(image, { maxColors: 3 });
  save('disc.svg', emitSvg(result, { pretty: true }));

  const nodes = result.stats.nodes;
  check('one piece', result.stats.pieces === 1, `got ${result.stats.pieces}`);
  check(`node count is low (got ${nodes})`, nodes >= 4 && nodes <= 16);
  check(
    `node reduction vs raw trace (${result.stats.nodesBeforeFitting} -> ${nodes})`,
    nodes < result.stats.nodesBeforeFitting / 10
  );
  check('uses cubic curves', result.layers[0].shapes[0].contours[0].segments.some((s) => s.kind === 'cubic'));
}

console.log('\n=== 3. Ring: hole detection and winding ===');
{
  const image = raster(300, 300);
  fillDisc(image, 150, 150, 120, [42, 157, 143]);
  fillDisc(image, 150, 150, 60, [0, 0, 0, 0]);

  const result = vectorize(image, { maxColors: 3 });
  save('ring.svg', emitSvg(result, { pretty: true }));

  const shape = result.layers[0]?.shapes[0];
  check('one piece', result.stats.pieces === 1, `got ${result.stats.pieces}`);
  check('two contours (outline + hole)', shape?.contours.length === 2, `got ${shape?.contours.length}`);
  if (shape?.contours.length === 2) {
    check('outer contour wound positive', shape.contours[0].signedArea > 0);
    check('hole wound negative', shape.contours[1].signedArea < 0);
    check('hole is smaller than outline', Math.abs(shape.contours[1].signedArea) < Math.abs(shape.contours[0].signedArea));
  }
}

console.log('\n=== 4. Adjacent colors: shared boundary must be identical (no seams) ===');
{
  const image = raster(200, 120);
  fillRect(image, 0, 0, 100, 120, [230, 57, 70]);
  fillRect(image, 100, 0, 100, 120, [29, 53, 87]);

  const result = vectorize(image, { maxColors: 4, background: 'keep' });
  save('split.svg', emitSvg(result, { pretty: true }));

  check('two color layers', result.layers.length === 2, `got ${result.layers.length}`);
  check('two pieces', result.stats.pieces === 2, `got ${result.stats.pieces}`);
  check('4 nodes per rectangle', result.stats.nodes === 8, `got ${result.stats.nodes}`);

  // Both rectangles must contain the exact same shared edge x = 100.
  const seamPoints = new Set();
  for (const p of uniqueAnchors(result)) {
    if (Math.abs(p.x - 100) < 1e-9) seamPoints.add(`${p.x},${p.y}`);
  }
  check(
    `shared edge lands exactly on x=100 at both ends (${[...seamPoints].join(' ')})`,
    seamPoints.size === 2 && seamPoints.has('100,0') && seamPoints.has('100,120')
  );
}

console.log('\n=== 5. Three-region junction: single shared point ===');
{
  // Left half one color, right half split top/bottom: a T junction at (100, 60).
  const image = raster(200, 120);
  fillRect(image, 0, 0, 100, 120, [244, 162, 97]);
  fillRect(image, 100, 0, 100, 60, [231, 111, 81]);
  fillRect(image, 100, 60, 100, 60, [38, 70, 83]);

  const result = vectorize(image, { maxColors: 4, background: 'keep' });
  save('junction.svg', emitSvg(result, { pretty: true }));

  check('three color layers', result.layers.length === 3, `got ${result.layers.length}`);
  check('three pieces', result.stats.pieces === 3, `got ${result.stats.pieces}`);

  // Every region touching the junction must place an anchor on the identical
  // point. If they disagree even slightly, a pinhole opens between three colors.
  const perLayer = result.layers.map((layer) =>
    layer.shapes
      .flatMap((s) => s.contours)
      .some((c) =>
        contourAnchors(c).some((p) => Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y - 60) < 1e-9)
      )
  );
  check(
    `all three regions place an anchor on the exact junction (${perLayer.filter(Boolean).length}/3)`,
    perLayer.every(Boolean)
  );
}

console.log('\n=== 6. Checkerboard: diagonal touching regions stay separate ===');
{
  const image = raster(80, 80);
  const cell = 10;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const dark = (x + y) % 2 === 0;
      fillRect(image, x * cell, y * cell, cell, cell, dark ? [20, 20, 20] : [240, 240, 240]);
    }
  }

  const result = vectorize(image, { maxColors: 2, background: 'keep', denoise: 0, detail: 100, smoothing: 0 });
  save('checker.svg', emitSvg(result, { pretty: true }));

  check('two colors', result.layers.length === 2, `got ${result.layers.length}`);
  check('64 separate pieces', result.stats.pieces === 64, `got ${result.stats.pieces}`);
  check('4 nodes per cell', result.stats.nodes === 64 * 4, `got ${result.stats.nodes}`);
}

console.log('\n=== 7. Background removal produces transparency ===');
{
  const image = raster(240, 240, [255, 255, 255, 255]);
  fillDisc(image, 120, 120, 80, [42, 157, 143]);

  const auto = vectorize(image, { maxColors: 4, background: 'auto' });
  const kept = vectorize(image, { maxColors: 4, background: 'keep' });
  save('bg-removed.svg', emitSvg(auto, { pretty: true }));

  check('auto drops the white backdrop', auto.layers.length === 1, `got ${auto.layers.length} layers`);
  check('keep retains it', kept.layers.length === 2, `got ${kept.layers.length} layers`);
  check('no white layer remains', !auto.layers.some((l) => l.hex === '#ffffff'));
}

console.log('\n=== 8. Enclosed background-colored area survives removal ===');
{
  // A ring with a white centre: the outer white must go, the inner white must stay.
  const image = raster(240, 240, [255, 255, 255, 255]);
  fillDisc(image, 120, 120, 90, [38, 70, 83]);
  fillDisc(image, 120, 120, 40, [255, 255, 255]);

  const result = vectorize(image, { maxColors: 4, background: 'auto' });
  save('enclosed-bg.svg', emitSvg(result, { pretty: true }));

  const white = result.layers.find((l) => l.hex === '#ffffff');
  check('inner white region is preserved', Boolean(white), 'white layer missing entirely');
  if (white) {
    check('only the enclosed white remains (1 piece)', white.shapes.length === 1, `got ${white.shapes.length}`);
  }
}

console.log('\n=== 9. Downscale path keeps output in source coordinates ===');
{
  const image = raster(3000, 1500);
  fillRect(image, 500, 300, 2000, 900, [231, 111, 81]);

  const result = vectorize(image, { maxColors: 3, maxDimension: 600 });
  check('reports source dimensions', result.width === 3000 && result.height === 1500);
  check('traced at reduced size', result.stats.tracedWidth === 600, `got ${result.stats.tracedWidth}`);

  const anchors = result.layers[0].shapes[0].contours[0];
  const xs = [anchors.start, ...anchors.segments.map((s) => s.to)].map((p) => p.x);
  const maxX = Math.max(...xs);
  check(`geometry scaled back to source space (maxX ${maxX.toFixed(1)} ~ 2500)`, Math.abs(maxX - 2500) < 12);
}

console.log('\n=== 10. Determinism ===');
{
  const image = raster(200, 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      setPixel(image, x, y, [(x * 7) % 256, (y * 11) % 256, (x * y) % 256, 255]);
    }
  }
  const a = emitSvg(vectorize(image, { maxColors: 6 }));
  const b = emitSvg(vectorize(image, { maxColors: 6 }));
  check('identical output across runs', a === b, `${a.length} vs ${b.length} bytes`);
}

console.log('\n=== 11. Analyzer verdicts ===');
{
  const flat = raster(400, 400, [255, 255, 255, 255]);
  fillDisc(flat, 200, 200, 150, [230, 57, 70]);
  fillRect(flat, 50, 50, 80, 80, [29, 53, 87]);
  const flatAnalysis = analyzeImage(flat);
  check(
    `flat art scores well (${flatAnalysis.score}, ${flatAnalysis.classification})`,
    flatAnalysis.score >= 70 && ['flat-art', 'line-art'].includes(flatAnalysis.classification)
  );

  // Pseudo photograph: smooth noise in every direction, no flat area.
  const photo = raster(400, 400);
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      const v = 128 + 60 * Math.sin(x / 17) * Math.cos(y / 23) + 12 * Math.sin(x / 3.1 + y / 2.7);
      setPixel(photo, x, y, [v, v * 0.8 + 20, 255 - v * 0.6, 255]);
    }
  }
  const photoAnalysis = analyzeImage(photo);
  check(
    `photo-like input is rejected (${photoAnalysis.score}, ${photoAnalysis.classification})`,
    photoAnalysis.suitability === 'poor' || photoAnalysis.classification === 'photo'
  );
  check(
    'rejection includes an actionable finding',
    photoAnalysis.findings.some((f) => f.level === 'error')
  );

  const tiny = raster(40, 40, [255, 255, 255, 255]);
  fillDisc(tiny, 20, 20, 12, [0, 0, 0]);
  const tinyAnalysis = analyzeImage(tiny);
  check(
    'tiny image warns about resolution',
    tinyAnalysis.findings.some((f) => /resolution|too coarse|px/i.test(f.message))
  );
}

console.log('\n=== 12. Color merge suggestions and re-merge ===');
{
  const image = raster(200, 200, [0, 0, 0, 0]);
  fillRect(image, 0, 0, 100, 200, [230, 57, 70]);
  fillRect(image, 100, 0, 100, 200, [232, 59, 72]); // near-identical on purpose

  const result = vectorize(image, { maxColors: 4, colorMergeThreshold: 0, background: 'keep' });
  check('two near-identical colors kept when threshold is 0', result.layers.length === 2, `got ${result.layers.length}`);

  const suggestions = suggestMerges(result, 8);
  check('merge suggested for near-duplicates', suggestions.length >= 1, `got ${suggestions.length}`);
  if (suggestions.length) {
    check(`deltaE is small (${suggestions[0].deltaE})`, suggestions[0].deltaE < 8);
  }

  const merged = vectorize(image, { maxColors: 4, colorMergeThreshold: 8, background: 'keep' });
  check('threshold merges them into one layer', merged.layers.length === 1, `got ${merged.layers.length}`);
  check(
    `node count drops after merge (${result.stats.nodes} -> ${merged.stats.nodes})`,
    merged.stats.nodes < result.stats.nodes
  );
}

console.log('\n=== 13. Export formats ===');
{
  const image = raster(200, 200, [0, 0, 0, 0]);
  fillDisc(image, 100, 100, 70, [42, 157, 143]);
  fillRect(image, 20, 20, 40, 40, [230, 57, 70]);
  const result = vectorize(image, { maxColors: 4 });

  const svg = emitSvg(result);
  const pdf = exportPdf(result);
  const eps = exportEps(result);
  const dxf = exportDxf(result);

  save('shapes.svg', svg);
  save('shapes.pdf', pdf);
  save('shapes.eps', eps);
  save('shapes.dxf', dxf);

  check('svg well formed', svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
  check('pdf header and trailer', pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  check('pdf xref offset points at xref', (() => {
    const match = /startxref\s+(\d+)/.exec(pdf);
    if (!match) return false;
    return pdf.slice(Number(match[1]), Number(match[1]) + 4) === 'xref';
  })());
  check('pdf object offsets are correct', (() => {
    const lines = pdf.slice(pdf.indexOf('xref')).split('\n');
    // entries start after "xref" and "0 N", skipping the free entry
    const entries = lines.slice(3).filter((l) => /^\d{10} 00000 n/.test(l));
    if (entries.length < 4) return false;
    return entries.every((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      return pdf.startsWith(`${i + 1} 0 obj`, offset);
    });
  })());
  check('pdf contains curve operators', / c\n| c$/m.test(pdf));
  check('eps header and bounding box', eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0') && /%%BoundingBox: 0 0 150 150/.test(eps));
  check('eps ends correctly', eps.trimEnd().endsWith('%%EOF'));
  check('dxf sections present', dxf.includes('ENTITIES') && dxf.trimEnd().endsWith('EOF'));
  check('dxf has closed polylines', dxf.includes('POLYLINE') && dxf.includes('SEQEND'));
  check('dxf layer names carry hex', /PV_\d\d_[0-9a-f]{6}/.test(dxf));
}

console.log('\n=== 14. Presets all run ===');
{
  const image = raster(240, 240, [255, 255, 255, 255]);
  fillDisc(image, 120, 120, 80, [42, 157, 143]);
  fillRect(image, 20, 20, 50, 50, [230, 57, 70]);

  for (const id of ['logo', 'sticker', 'apparel', 'lineart', 'ai-art', 'pixel-art', 'poster']) {
    try {
      const result = vectorize(image, resolvePreset(id));
      const svg = emitSvg(result);
      check(
        `${id}: ${result.stats.colors} colors, ${result.stats.pieces} pieces, ${result.stats.nodes} nodes`,
        result.layers.length > 0 && svg.includes('<path')
      );
    } catch (error) {
      check(`${id} runs`, false, String(error));
    }
  }
}

console.log('\n=== 15. Edge cases ===');
{
  const oneByOne = raster(1, 1, [255, 0, 0, 255]);
  const single = vectorize(oneByOne, { maxColors: 2, background: 'keep' });
  check('1x1 image produces one 4-node square', single.stats.nodes === 4, `got ${single.stats.nodes}`);

  const empty = raster(50, 50, [0, 0, 0, 0]);
  const none = vectorize(empty, { maxColors: 2 });
  check('fully transparent image produces no layers', none.layers.length === 0);
  check('empty result still emits valid svg', emitSvg(none).includes('</svg>'));

  const thin = raster(100, 100, [0, 0, 0, 0]);
  fillRect(thin, 10, 50, 80, 1, [0, 0, 0]);
  const line = vectorize(thin, { maxColors: 2, denoise: 0, minArea: 1 });
  check('1px line survives', line.layers.length === 1 && line.stats.pieces === 1, `layers ${line.layers.length}, pieces ${line.stats.pieces}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`Artifacts written to ${OUT_DIR}`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
