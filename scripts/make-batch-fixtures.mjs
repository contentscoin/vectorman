/**
 * Build the batch input folder.
 *
 * Deliberately hostile, because a batch tool is only worth trusting if it survives
 * the things a real folder contains:
 *
 *  - enough files that a parallel speedup is measurable rather than noise
 *  - a photograph, which must be skipped rather than converted into colour bands
 *  - a file that is not an image at all, which must fail alone
 *  - the same basename in two folders, which must not overwrite itself
 *  - a dot-directory, which must never be searched
 *
 * Run: node scripts/make-batch-fixtures.mjs
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'tmp', 'fixtures');
const IN = join(ROOT, 'tmp', 'batch-in');

if (!existsSync(FIXTURES)) {
  console.error('Source fixtures missing. Run: node scripts/make-fixtures.mjs');
  process.exit(1);
}

rmSync(IN, { recursive: true, force: true });
rmSync(join(ROOT, 'tmp', 'batch-out'), { recursive: true, force: true });
mkdirSync(join(IN, 'nested'), { recursive: true });
mkdirSync(join(IN, '.hidden'), { recursive: true });

const COPIES = 4;
const SOURCES = [
  'logo.png',
  'sticker.png',
  'lineart.png',
  'logo-noisy.jpg',
  'pixelart.png',
  'logo-blurry.png',
];

for (let i = 1; i <= COPIES; i++) {
  for (const file of SOURCES) {
    const dot = file.lastIndexOf('.');
    copyFileSync(join(FIXTURES, file), join(IN, `${file.slice(0, dot)}-${i}${file.slice(dot)}`));
  }
}

copyFileSync(join(FIXTURES, 'photo.jpg'), join(IN, 'photo.jpg'));
copyFileSync(join(FIXTURES, 'logo.png'), join(IN, 'nested', 'logo.png'));
copyFileSync(join(FIXTURES, 'sticker.png'), join(IN, 'nested', 'sticker.png'));
copyFileSync(join(FIXTURES, 'logo.png'), join(IN, '.hidden', 'should-not-be-found.png'));
writeFileSync(join(IN, 'broken.png'), 'this is not an image at all');

console.log(`Batch fixtures in ${IN}`);
console.log(`  ${COPIES * SOURCES.length} convertible images`);
console.log('  1 photograph (must be skipped)');
console.log('  1 non-image named .png (must fail alone)');
console.log('  2 images in nested/ with duplicate basenames');
console.log('  1 image in .hidden/ (must never be found)');
