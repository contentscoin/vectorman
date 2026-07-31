/**
 * Generate realistic test artwork.
 *
 * Synthetic-but-realistic input matters here: the shapes are rasterized from SVG
 * so they carry genuine anti-aliasing, and one fixture is deliberately saved as a
 * low-quality JPEG. Those two properties — soft edge ramps and compression
 * speckle — are what break naive tracers, so testing without them proves little.
 *
 * Run: node scripts/make-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const sharp = require('sharp');

const OUT = join(import.meta.dirname, '..', 'tmp', 'fixtures');
mkdirSync(OUT, { recursive: true });

/** A flat badge logo: hard corners, a counter (hole), transparent background. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect x="60" y="60" width="520" height="520" rx="96" fill="#1d3557"/>
  <path d="M320 150 L470 470 L170 470 Z" fill="#f1faee"/>
  <circle cx="320" cy="392" r="58" fill="#e63946"/>
  <rect x="150" y="510" width="340" height="34" rx="17" fill="#a8dadc"/>
</svg>`;

/** A flat sticker illustration on a solid white background, for background removal. */
const STICKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="#ffffff"/>
  <ellipse cx="300" cy="330" rx="190" ry="170" fill="#f4a261"/>
  <circle cx="300" cy="180" r="120" fill="#e76f51"/>
  <circle cx="258" cy="160" r="20" fill="#264653"/>
  <circle cx="342" cy="160" r="20" fill="#264653"/>
  <path d="M240 230 Q300 275 360 230" stroke="#264653" stroke-width="16" fill="none" stroke-linecap="round"/>
  <rect x="180" y="420" width="240" height="40" rx="20" fill="#2a9d8f"/>
</svg>`;

/** Line art: a single ink colour with thin strokes, on transparency. */
const LINEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <g stroke="#111111" stroke-width="9" fill="none" stroke-linecap="round">
    <circle cx="300" cy="300" r="210"/>
    <path d="M150 340 Q300 470 450 340"/>
    <path d="M215 240 l0 -50"/>
    <path d="M385 240 l0 -50"/>
    <path d="M120 120 L200 200"/>
  </g>
</svg>`;

async function fromSvg(name, svg, encode) {
  const pipeline = sharp(Buffer.from(svg));
  const buffer = await (encode ? encode(pipeline) : pipeline.png()).toBuffer();
  const path = join(OUT, name);
  writeFileSync(path, buffer);
  const meta = await sharp(buffer).metadata();
  console.log(`  ${name.padEnd(18)} ${meta.width}x${meta.height} ${meta.format} ${(buffer.length / 1024).toFixed(1)} KB`);
  return path;
}

function rawImage(width, height, paint) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } });
}

console.log('Writing fixtures:');

await fromSvg('logo.png', LOGO_SVG);
await fromSvg('sticker.png', STICKER_SVG);
await fromSvg('lineart.png', LINEART_SVG);

// Same logo through aggressive JPEG compression: block ringing around every edge,
// plus the alpha channel flattened away. This is the "client sent me a JPEG" case.
await fromSvg('logo-noisy.jpg', LOGO_SVG, (p) =>
  p.flatten({ background: '#ffffff' }).jpeg({ quality: 22, chromaSubsampling: '4:2:0' })
);

// A smooth gradient mesh with no flat regions at all: the analyzer should refuse it.
await (async () => {
  const width = 480;
  const height = 480;
  const buffer = await rawImage(width, height, (x, y) => {
    const a = 128 + 90 * Math.sin(x / 61) * Math.cos(y / 47);
    const b = 128 + 90 * Math.sin((x + y) / 83);
    const c = 128 + 70 * Math.cos(x / 39 + y / 55);
    return [a, b, c, 255];
  })
    .jpeg({ quality: 88 })
    .toBuffer();
  writeFileSync(join(OUT, 'photo.jpg'), buffer);
  console.log(`  ${'photo.jpg'.padEnd(18)} ${width}x${height} jpeg ${(buffer.length / 1024).toFixed(1)} KB`);
})();

// A blurred, upscaled logo. Exists to confirm the blur warning still fires after
// the heuristic was relaxed to stop it flagging clean flat art.
await fromSvg('logo-blurry.png', LOGO_SVG, (p) =>
  p.resize(160, 160).blur(3).resize(640, 640, { kernel: 'cubic' }).png()
);

// Small, hard-edged pixel art: no anti-aliasing anywhere, so it must be traced literally.
await (async () => {
  const size = 32;
  const palette = [
    [0, 0, 0, 0],
    [38, 70, 83, 255],
    [231, 111, 81, 255],
    [244, 162, 97, 255],
  ];
  const sprite = [
    '....11111111....',
    '..111111111111..',
    '.11122111112211.',
    '.11122111112211.',
    '.1111111111111 1',
    '.1113333333311 1',
    '..111333333111..',
    '....11111111....',
  ];
  const buffer = await rawImage(size, size, (x, y) => {
    const row = sprite[Math.floor(y / 4)] ?? '';
    const ch = row[Math.floor(x / 2)] ?? '.';
    const index = ch === '.' || ch === ' ' ? 0 : Number(ch);
    return palette[index] ?? palette[0];
  })
    .png()
    .toBuffer();
  writeFileSync(join(OUT, 'pixelart.png'), buffer);
  console.log(`  ${'pixelart.png'.padEnd(18)} ${size}x${size} png ${(buffer.length / 1024).toFixed(1)} KB`);
})();

console.log(`\nFixtures in ${OUT}`);
