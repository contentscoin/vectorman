/**
 * Sample images offered on the landing page.
 *
 * These are real PNG and JPG files traced by the same engine as any upload, not
 * pre-rendered results. The set is chosen to cover the interesting cases,
 * including the ones that go badly: a compressed JPEG and a photograph are
 * included on purpose so the honest verdict is reachable in one click.
 */

export interface Sample {
  file: string;
  label: string;
  note: string;
}

export const SAMPLES: Sample[] = [
  {
    file: 'logo.png',
    label: 'Logo',
    note: 'Flat badge mark: exact brand colors, sharp corners, a counter punched through',
  },
  {
    file: 'sticker.png',
    label: 'Sticker',
    note: 'Flat illustration on white — the background becomes transparency',
  },
  {
    file: 'lineart.png',
    label: 'Line art',
    note: 'Strokes recovered as single centreline paths with a stroke weight, not filled outlines',
  },
  {
    file: 'logo-noisy.jpg',
    label: 'Bad JPEG',
    note: 'The same logo at JPEG quality 22 — watch the denoise settings work',
  },
  {
    file: 'pixelart.png',
    label: 'Pixel art',
    note: 'Traced literally: every pixel becomes a crisp square edge',
  },
  {
    file: 'photo.jpg',
    label: 'Photo',
    note: 'A photograph, which cannot be traced usefully. The app says so.',
  },
];
