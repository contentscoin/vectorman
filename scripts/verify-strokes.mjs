/**
 * Centreline tracing verification.
 *
 * Synthetic strokes with known geometry, so the answers are checkable rather than
 * merely plausible: a 200px horizontal bar 9px thick must come back as one path of
 * width ~9 running along y = its centre, and a cross must come back as paths that
 * meet at the crossing.
 *
 * Run: node scripts/verify-strokes.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitSvg, exportDxf, exportEps, exportPdf, vectorize } from '../packages/core/dist/index.js';

const OUT = join(import.meta.dirname, '..', 'tmp', 'strokes');
mkdirSync(OUT, { recursive: true });

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) console.log(`  \u2713 ${label}`);
  else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function raster(w, h, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { width: w, height: h, data };
}
function setPixel(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0];
  img.data[o + 1] = c[1];
  img.data[o + 2] = c[2];
  img.data[o + 3] = c[3] ?? 255;
}
function fillRect(img, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPixel(img, x, y, c);
}
function strokeDisc(img, cx, cy, radius, thickness, c) {
  const outer = radius + thickness / 2;
  const inner = radius - thickness / 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= outer && d >= inner) setPixel(img, x, y, c);
    }
  }
}

const INK = [17, 17, 17];
const strokeAnchors = (stroke) => [stroke.start, ...stroke.segments.map((s) => s.to)];

console.log('\n=== 1. Horizontal bar becomes one centreline ===');
{
  const image = raster(240, 120);
  fillRect(image, 20, 56, 200, 9, INK);

  const filled = vectorize(image, { maxColors: 2, strokeMode: 'off' });
  const stroked = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  writeFileSync(join(OUT, 'bar.svg'), emitSvg(stroked, { pretty: true }));

  check('filled mode still produces a filled outline', filled.stats.pieces === 1 && filled.stats.strokes === 0);
  check(`auto mode recovers exactly one centreline (${stroked.stats.strokes})`, stroked.stats.strokes === 1);
  check('the filled region is gone', stroked.stats.pieces === 0, `pieces ${stroked.stats.pieces}`);

  const stroke = stroked.layers[0].strokes[0];
  check(`recovered width is about 9px (${stroke.width.toFixed(2)})`, Math.abs(stroke.width - 9) <= 0.5);

  const anchors = strokeAnchors(stroke);
  check(`centreline is 2 nodes (${anchors.length})`, anchors.length === 2);
  check(
    `centreline sits on the bar's midline y=60.5 (${anchors.map((p) => p.y.toFixed(1)).join(',')})`,
    anchors.every((p) => Math.abs(p.y - 60.5) < 1.5)
  );
  check(
    `centreline spans the bar (${anchors.map((p) => p.x.toFixed(0)).join('..')})`,
    Math.abs(Math.min(...anchors.map((p) => p.x)) - 20) < 6 &&
      Math.abs(Math.max(...anchors.map((p) => p.x)) - 220) < 6
  );

  check(
    `node count collapses vs the filled outline (${filled.stats.nodes} -> ${stroked.stats.nodes})`,
    stroked.stats.nodes < filled.stats.nodes
  );

  const svg = emitSvg(stroked);
  check('svg marks it as a stroke, not a fill', /fill="none" stroke="#111111"/.test(svg));
  check('svg carries the recovered width', /stroke-width="[89](\.\d+)?"/.test(svg), svg.slice(0, 400));
  check('svg uses round caps', /stroke-linecap="round"/.test(svg));
  check('open centreline path is not closed with Z', !/ Z"/.test(svg.split('stroke=')[1] ?? ''));
}

console.log('\n=== 2. A blob is left alone ===');
{
  const image = raster(200, 200);
  fillRect(image, 40, 40, 120, 120, INK);

  const result = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  check('square stays a filled shape', result.stats.pieces === 1 && result.stats.strokes === 0);
  check('report explains nothing was converted', result.strokeReport.converted === 0);
  check('still exactly 4 nodes', result.stats.nodes === 4, String(result.stats.nodes));
}

console.log('\n=== 3. Cross: junction is shared, strokes meet ===');
{
  const image = raster(200, 200);
  fillRect(image, 20, 96, 160, 8, INK);
  fillRect(image, 96, 20, 8, 160, INK);

  const result = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  writeFileSync(join(OUT, 'cross.svg'), emitSvg(result, { pretty: true }));

  check(`crossing splits into 4 arms (${result.stats.strokes})`, result.stats.strokes === 4);
  check('one region, so one conversion', result.strokeReport.converted === 1);

  // Every arm must terminate at the centre; otherwise the drawn cross has a gap.
  const ends = result.layers[0].strokes.flatMap((s) => {
    const a = strokeAnchors(s);
    return [a[0], a[a.length - 1]];
  });
  const atCentre = ends.filter((p) => Math.hypot(p.x - 100, p.y - 100) < 6);
  check(`all 4 arms reach the centre (${atCentre.length} of 8 endpoints)`, atCentre.length === 4);

  const widths = result.layers[0].strokes.map((s) => s.width);
  check(
    `widths agree across arms (${widths.map((w) => w.toFixed(1)).join(', ')})`,
    Math.max(...widths) - Math.min(...widths) < 0.01
  );
}

console.log('\n=== 4. Ring becomes a closed centreline ===');
{
  const image = raster(260, 260);
  strokeDisc(image, 130, 130, 90, 8, INK);

  const filled = vectorize(image, { maxColors: 2, strokeMode: 'off' });
  const result = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  writeFileSync(join(OUT, 'ring.svg'), emitSvg(result, { pretty: true }));

  check(`one centreline (${result.stats.strokes})`, result.stats.strokes === 1);
  const stroke = result.layers[0].strokes[0];
  check('it is marked closed', stroke.closed === true);
  check(`width about 8px (${stroke.width.toFixed(2)})`, Math.abs(stroke.width - 8) <= 0.5);

  const anchors = strokeAnchors(stroke);
  const radii = anchors.map((p) => Math.hypot(p.x - 130, p.y - 130));
  check(
    `centreline follows radius 90 (${Math.min(...radii).toFixed(1)}-${Math.max(...radii).toFixed(1)})`,
    radii.every((r) => Math.abs(r - 90) < 3)
  );
  // A ring is the best case for the theoretical bound: two concentric outlines
  // collapse into one path, so at most half the nodes.
  check(
    `at most half the nodes of the two outlines (${filled.stats.nodes} -> ${result.stats.nodes})`,
    result.stats.nodes <= filled.stats.nodes / 2
  );
  check(`and one path instead of two (${filled.stats.pieces} piece -> 1 stroke)`, result.stats.strokes === 1);
  check('closed centreline is closed with Z', /Z"/.test(emitSvg(result)));
}

console.log('\n=== 5. Safety: a stroke on a filled background stays filled ===');
{
  // The bar borders a second colour, so converting it would move that shared edge
  // and open a seam. It must stay a filled outline.
  const image = raster(240, 120, [255, 255, 255, 255]);
  fillRect(image, 20, 56, 200, 9, INK);

  const result = vectorize(image, { maxColors: 3, strokeMode: 'auto', background: 'keep' });
  check('nothing was converted', result.strokeReport.converted === 0);
  check(
    `the blocked region is reported (${result.strokeReport.blockedByNeighbours})`,
    result.strokeReport.blockedByNeighbours >= 1
  );
  check('the bar is still filled', result.stats.pieces >= 2 && result.stats.strokes === 0);

  // With the background dropped, the same bar is free to become a centreline.
  const removed = vectorize(image, { maxColors: 3, strokeMode: 'auto', background: 'remove' });
  check(
    `dropping the background unblocks it (${removed.stats.strokes} strokes)`,
    removed.stats.strokes === 1
  );
}

console.log('\n=== 6. strokeMode off is the default and changes nothing ===');
{
  const image = raster(240, 120);
  fillRect(image, 20, 56, 200, 9, INK);

  const bare = vectorize(image, { maxColors: 2 });
  const explicit = vectorize(image, { maxColors: 2, strokeMode: 'off' });
  check('default is off', bare.resolvedOptions.strokeMode === 'off');
  check('output identical to explicit off', emitSvg(bare) === emitSvg(explicit));
  check('report says off', bare.strokeReport.mode === 'off' && bare.strokeReport.converted === 0);
}

console.log('\n=== 7. force lowers the bar but keeps the safety rule ===');
{
  // 3:1 — too square for auto at the default of 5, but past force's 2.5.
  const image = raster(160, 160);
  fillRect(image, 40, 60, 90, 30, INK);

  const auto = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  const forced = vectorize(image, { maxColors: 2, strokeMode: 'force' });
  check('auto leaves it filled', auto.stats.strokes === 0);
  check(`force converts it (${forced.stats.strokes})`, forced.stats.strokes === 1);

  const guarded = vectorize(raster(160, 160, [255, 255, 255, 255]), {
    maxColors: 2,
    strokeMode: 'force',
    background: 'keep',
  });
  check('force still cannot break a shared edge', guarded.stats.strokes === 0);
}

console.log('\n=== 8. Exports carry strokes ===');
{
  const image = raster(240, 240);
  fillRect(image, 20, 116, 200, 9, INK);
  strokeDisc(image, 120, 60, 34, 7, [230, 57, 70]);

  const result = vectorize(image, { maxColors: 3, strokeMode: 'auto' });
  const svg = emitSvg(result, { pretty: true });
  const pdf = exportPdf(result);
  const eps = exportEps(result);
  const dxf = exportDxf(result);

  writeFileSync(join(OUT, 'mixed.svg'), svg);
  writeFileSync(join(OUT, 'mixed.pdf'), pdf);
  writeFileSync(join(OUT, 'mixed.eps'), eps);
  writeFileSync(join(OUT, 'mixed.dxf'), dxf);

  check(`two centrelines recovered (${result.stats.strokes})`, result.stats.strokes === 2);
  check('svg has two stroke groups', (svg.match(/fill="none" stroke=/g) || []).length === 2);

  check('pdf sets a stroke colour with RG', / RG\n/.test(pdf));
  check('pdf sets a line width with w', /\d w\n/.test(pdf));
  check('pdf strokes with S', /\nS\n/.test(pdf));
  check('pdf sets round caps', /1 J 1 j/.test(pdf));

  check('eps sets a line width', /setlinewidth/.test(eps));
  check('eps strokes', /\ns\n/.test(eps));
  check('eps sets round caps', /1 setlinecap/.test(eps));

  check('dxf has an open polyline for the bar', /\n70\n0\n/.test(dxf));
  check('dxf names stroke layers with their width', /PV_\d\d_[0-9a-f]{6}_W\d+p\d\d/.test(dxf));
}

console.log('\n=== 9. Stroke report is accurate ===');
{
  const image = raster(240, 240);
  fillRect(image, 20, 40, 200, 8, INK);
  fillRect(image, 20, 100, 200, 8, INK);
  fillRect(image, 60, 150, 120, 60, INK); // a blob, must not convert

  const result = vectorize(image, { maxColors: 2, strokeMode: 'auto' });
  check(`two regions converted (${result.strokeReport.converted})`, result.strokeReport.converted === 2);
  check(`blob still filled (${result.stats.pieces} pieces)`, result.stats.pieces === 1);
  check(`median width reported (${result.strokeReport.medianWidth})`,
    result.strokeReport.medianWidth !== null && Math.abs(result.strokeReport.medianWidth - 8) <= 0.5);
  check('mode echoed', result.strokeReport.mode === 'auto');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`Artifacts in ${OUT}`);
if (failures > 0) process.exit(1);
