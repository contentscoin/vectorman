import type { VectorizeOptions } from './types.js';

/**
 * Named starting points tuned to what people actually make.
 *
 * The settings interact in ways that are not obvious from their names, so a
 * preset is usually a better starting point than a slider. The notable
 * interaction: `denoise` drives both label smoothing and the default minimum
 * region area, so raising it for a JPEG both softens staircases and sweeps away
 * compression speckle at once.
 */

export interface Preset {
  id: string;
  label: string;
  /** Who this is for and what it trades away. */
  description: string;
  options: VectorizeOptions;
}

export const PRESETS: Preset[] = [
  {
    id: 'logo',
    label: 'Logo & wordmark',
    description:
      'Few colors, hard edges, exact brand hex values preserved. Corners stay sharp so type and geometric marks do not soften.',
    options: {
      maxColors: 6,
      detail: 62,
      smoothing: 45,
      denoise: 35,
      colorMergeThreshold: 7,
      background: 'auto',
      precision: 2,
    },
  },
  {
    id: 'sticker',
    label: 'Sticker & decal',
    description:
      'Clean outer silhouette with speckle removed, ready for a cut line. Slightly heavier despeckling because a cutter cannot follow a 3px island.',
    options: {
      maxColors: 8,
      detail: 52,
      smoothing: 62,
      denoise: 60,
      colorMergeThreshold: 8,
      background: 'auto',
      precision: 2,
    },
  },
  {
    id: 'apparel',
    label: 'Apparel graphic',
    description:
      'Balanced for screen printing and DTG: colors separated per layer, node count kept low so the file opens fast in a shop RIP.',
    options: {
      maxColors: 7,
      detail: 50,
      smoothing: 60,
      denoise: 55,
      colorMergeThreshold: 9,
      background: 'auto',
      precision: 2,
    },
  },
  {
    id: 'lineart',
    label: 'Line art & silhouette',
    description:
      'Two or three tones, detail pushed high so thin strokes survive. Recovers strokes as single centreline paths with a stroke weight, instead of two parallel outlines — far fewer nodes, editable weight, and a usable toolpath for a plotter or laser.',
    options: {
      // Detail sits at 66 rather than the 74 this preset used before centreline
      // recovery existed. High detail was protecting thin strokes from being
      // simplified away, which centrelines now handle structurally. Measured on the
      // line-art fixture, dropping to 66 leaves the centrelines untouched at ~19
      // nodes while any region that stays filled falls from 228 nodes to 49, because
      // a tighter epsilon was making the outlines follow the pixel staircase.
      maxColors: 3,
      detail: 66,
      smoothing: 55,
      denoise: 30,
      colorMergeThreshold: 12,
      background: 'auto',
      precision: 2,
      strokeMode: 'auto',
    },
  },
  {
    id: 'centerline',
    label: 'Centreline / plotter',
    description:
      'Everything thin becomes a stroked centreline, with the bar lowered so shorter and chunkier marks convert too. For pen plotters, vinyl cutters in line mode, and laser engraving where you want the tool to follow the middle of a line rather than cut around it.',
    options: {
      maxColors: 3,
      detail: 66,
      smoothing: 60,
      denoise: 30,
      colorMergeThreshold: 12,
      background: 'auto',
      precision: 2,
      strokeMode: 'force',
    },
  },
  {
    id: 'ai-art',
    label: 'AI illustration',
    description:
      'For flat-prompted AI output, which tends to carry more palette variation than it appears to. Allows more colors and merges near-duplicates harder.',
    options: {
      maxColors: 12,
      detail: 55,
      smoothing: 65,
      denoise: 50,
      colorMergeThreshold: 6,
      background: 'auto',
      precision: 2,
    },
  },
  {
    id: 'pixel-art',
    label: 'Pixel art',
    description:
      'Traced literally: no smoothing, no denoising, no simplification. Every pixel becomes a crisp square edge.',
    options: {
      maxColors: 16,
      detail: 100,
      smoothing: 0,
      denoise: 0,
      colorMergeThreshold: 0,
      background: 'auto',
      maxDimension: 4096,
      precision: 0,
    },
  },
  {
    id: 'poster',
    label: 'Poster & wall art',
    description:
      'More colors for layered flat illustration, with generous smoothing for organic shapes. Not for photographs.',
    options: {
      maxColors: 10,
      detail: 58,
      smoothing: 70,
      denoise: 45,
      colorMergeThreshold: 5,
      background: 'keep',
      precision: 2,
    },
  },
];

export const DEFAULT_PRESET_ID = 'logo';

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Preset options merged with explicit overrides, which always win. */
export function resolvePreset(id: string, overrides: VectorizeOptions = {}): VectorizeOptions {
  const preset = getPreset(id);
  if (!preset) {
    throw new Error(
      `Unknown preset "${id}". Available: ${PRESETS.map((p) => p.id).join(', ')}`
    );
  }
  return { ...preset.options, ...overrides };
}
