import { estimateNoise } from './image/preprocess.js';
import type { RasterImage, VectorizeOptions } from './types.js';

/**
 * Image suitability analysis.
 *
 * Tracing rewards flat, defined shapes. On a photograph it cannot succeed — not
 * because the implementation is weak, but because a photograph has no regions to
 * find. Saying so up front is more useful than returning 40 layers of mush, and
 * it is the same judgement a designer makes by eye before deciding whether to
 * trace or redraw.
 *
 * The classification rests on how color changes between neighbouring pixels:
 *
 *  - **Flat pixels** (no change) dominate logos and flat illustration.
 *  - **Soft transitions** (a small change) mean anti-aliasing when rare, and
 *    gradients or photographic content when abundant.
 *  - **Hard transitions** (a large change) are real shape edges.
 *
 * A logo is mostly flat with a thin outline of soft pixels around hard edges. A
 * photograph is almost entirely soft, with hardly any flat pixels anywhere.
 */

export type Suitability = 'excellent' | 'good' | 'fair' | 'poor';

export type Classification = 'flat-art' | 'line-art' | 'gradient-art' | 'photo' | 'unknown';

export interface Finding {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface ImageAnalysis {
  width: number;
  height: number;

  hasAlpha: boolean;
  /** Share of pixels that are fully or mostly transparent. */
  transparentRatio: number;

  /** Distinct opaque colors, up to `uniqueColorLimit`. */
  uniqueColors: number;
  /** True when the count hit the scan limit, so the real number is higher. */
  uniqueColorsCapped: boolean;

  flatRatio: number;
  softEdgeRatio: number;
  hardEdgeRatio: number;

  /**
   * 0-1 compression noise estimate. Exactly 0 for clean vector-derived art no
   * matter how heavily anti-aliased. Shares its definition with the pipeline's
   * denoise gate, so this number explains what the pipeline will actually do.
   */
  noiseEstimate: number;

  classification: Classification;
  suitability: Suitability;
  /** 0-100. Above 70 traces cleanly; below 35 is not worth attempting. */
  score: number;

  findings: Finding[];

  recommended: {
    presetId: string;
    options: VectorizeOptions;
    /** Why these settings, in one line. */
    rationale: string;
  };
}

const UNIQUE_COLOR_LIMIT = 20000;

/** Chebyshev distance in RGB below which a transition counts as soft. */
const SOFT_THRESHOLD = 10;
/** Above this a transition is a real edge. */
const HARD_THRESHOLD = 40;

export function analyzeImage(image: RasterImage): ImageAnalysis {
  const { width, height, data } = image;
  const total = width * height;

  if (total === 0) {
    throw new Error('Cannot analyze an empty image');
  }

  // Sample stride keeps analysis fast on large uploads while staying
  // representative; edge statistics are ratios, so subsampling is unbiased.
  const stride = total > 1_500_000 ? 3 : total > 400_000 ? 2 : 1;

  const uniqueColors = new Set<number>();
  let capped = false;

  let transparent = 0;
  let opaqueSampled = 0;
  let flat = 0;
  let soft = 0;
  let hard = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = y * width + x;
      const o = index * 4;

      if (data[o + 3] < 128) {
        transparent++;
        continue;
      }
      opaqueSampled++;

      if (!capped) {
        uniqueColors.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
        if (uniqueColors.size >= UNIQUE_COLOR_LIMIT) capped = true;
      }

      // Largest channel difference against the right and lower neighbours.
      let maxDifference = 0;
      if (x + 1 < width) {
        maxDifference = Math.max(maxDifference, channelDistance(data, o, o + 4));
      }
      if (y + 1 < height) {
        maxDifference = Math.max(maxDifference, channelDistance(data, o, o + width * 4));
      }

      if (maxDifference === 0) flat++;
      else if (maxDifference <= SOFT_THRESHOLD) soft++;
      else if (maxDifference >= HARD_THRESHOLD) hard++;
    }
  }

  const sampled = opaqueSampled + transparent;
  const transparentRatio = sampled > 0 ? transparent / sampled : 0;
  const denominator = opaqueSampled > 0 ? opaqueSampled : 1;

  const flatRatio = flat / denominator;
  const softEdgeRatio = soft / denominator;
  const hardEdgeRatio = hard / denominator;
  // Same measurement the pipeline gates denoising on, so the reported number and
  // the recommended setting cannot drift apart.
  const noiseEstimate = estimateNoise(image);

  const uniqueColorCount = uniqueColors.size;

  const classification = classify(flatRatio, softEdgeRatio, uniqueColorCount, capped);
  const { score, suitability } = scoreImage(
    classification,
    flatRatio,
    softEdgeRatio,
    uniqueColorCount,
    capped,
    width,
    height
  );

  const findings = buildFindings({
    classification,
    width,
    height,
    flatRatio,
    softEdgeRatio,
    hardEdgeRatio,
    noiseEstimate,
    uniqueColorCount,
    capped,
    transparentRatio,
  });

  const recommended = recommend(classification, uniqueColorCount, capped, noiseEstimate, width, height);

  return {
    width,
    height,
    hasAlpha: transparentRatio > 0.001,
    transparentRatio: round(transparentRatio, 4),
    uniqueColors: uniqueColorCount,
    uniqueColorsCapped: capped,
    flatRatio: round(flatRatio, 4),
    softEdgeRatio: round(softEdgeRatio, 4),
    hardEdgeRatio: round(hardEdgeRatio, 4),
    noiseEstimate: round(noiseEstimate, 4),
    classification,
    suitability,
    score,
    findings,
    recommended,
  };
}

function channelDistance(data: Uint8ClampedArray, a: number, b: number): number {
  return Math.max(
    Math.abs(data[a] - data[b]),
    Math.abs(data[a + 1] - data[b + 1]),
    Math.abs(data[a + 2] - data[b + 2])
  );
}

function classify(
  flatRatio: number,
  softEdgeRatio: number,
  uniqueColors: number,
  capped: boolean
): Classification {
  // Photographs are overwhelmingly soft transitions with almost no flat area.
  if (flatRatio < 0.2 && softEdgeRatio > 0.55) return 'photo';
  if (capped && flatRatio < 0.35) return 'photo';

  if (flatRatio >= 0.6) {
    // Very few colors and a lot of flat area: inked drawing or silhouette.
    if (uniqueColors <= 8) return 'line-art';
    return 'flat-art';
  }

  if (flatRatio >= 0.3) {
    if (softEdgeRatio > 0.45 || uniqueColors > 4000) return 'gradient-art';
    return 'flat-art';
  }

  if (softEdgeRatio > 0.4) return 'gradient-art';
  return 'unknown';
}

function scoreImage(
  classification: Classification,
  flatRatio: number,
  softEdgeRatio: number,
  uniqueColors: number,
  capped: boolean,
  width: number,
  height: number
): { score: number; suitability: Suitability } {
  let score: number;

  switch (classification) {
    case 'line-art':
      score = 92;
      break;
    case 'flat-art':
      score = 70 + Math.round(flatRatio * 25);
      break;
    case 'gradient-art':
      score = 45 + Math.round(flatRatio * 25) - Math.round(softEdgeRatio * 15);
      break;
    case 'photo':
      score = 12;
      break;
    default:
      score = 45;
      break;
  }

  // Resolution penalty: a tracer cannot recover shapes that were never sampled.
  const shortest = Math.min(width, height);
  if (shortest < 64) score -= 25;
  else if (shortest < 128) score -= 12;
  else if (shortest < 200) score -= 5;

  if (capped && classification !== 'photo') score -= 8;

  score = Math.max(0, Math.min(100, score));

  const suitability: Suitability =
    score >= 80 ? 'excellent' : score >= 62 ? 'good' : score >= 35 ? 'fair' : 'poor';

  return { score, suitability };
}

interface FindingInput {
  classification: Classification;
  width: number;
  height: number;
  flatRatio: number;
  softEdgeRatio: number;
  hardEdgeRatio: number;
  noiseEstimate: number;
  uniqueColorCount: number;
  capped: boolean;
  transparentRatio: number;
}

function buildFindings(input: FindingInput): Finding[] {
  const findings: Finding[] = [];

  switch (input.classification) {
    case 'photo':
      findings.push({
        level: 'error',
        message:
          'This looks like a photograph or photoreal art. Tracing needs flat, defined shapes; ' +
          'a photograph has none, so the result will be a stack of blobby colour bands. Redraw it instead.',
      });
      break;
    case 'gradient-art':
      findings.push({
        level: 'warning',
        message:
          'Gradients or soft shading detected. Each band becomes its own flat shape, which ' +
          'reads as posterisation. Raising the colour count softens the banding but multiplies the layers.',
      });
      break;
    case 'line-art':
      findings.push({
        level: 'info',
        message:
          'Line art or silhouette: few colours and large flat areas. This traces very cleanly, and ' +
          'thin strokes can be recovered as centrelines with a stroke weight rather than as filled outlines.',
      });
      break;
    case 'flat-art':
      findings.push({
        level: 'info',
        message: 'Flat artwork with defined shapes. Ideal input for tracing.',
      });
      break;
    default:
      findings.push({
        level: 'warning',
        message: 'Could not classify this image confidently. Try it and inspect the result.',
      });
      break;
  }

  const shortest = Math.min(input.width, input.height);
  if (shortest < 64) {
    findings.push({
      level: 'error',
      message: `Only ${input.width}x${input.height}px. Edges are too coarse to recover reliable shapes. Find a larger source.`,
    });
  } else if (shortest < 200) {
    findings.push({
      level: 'warning',
      message: `Low resolution (${input.width}x${input.height}px). Expect softened corners and lost fine detail.`,
    });
  }

  if (input.noiseEstimate > 0.35) {
    findings.push({
      level: 'warning',
      message:
        'Heavy speckle, typical of a re-saved JPEG. Denoise is doing real work here; lowering it will ' +
        'produce hundreds of stray shapes.',
    });
  }

  // Blur detection compares hard edges against *other transitions*, not against the
  // whole image. Measured as a share of all pixels it produces false positives on
  // exactly the input that traces best: a large, simple logo is mostly flat area, so
  // its crisp edges are a tiny fraction of it. What actually distinguishes a blurred
  // source is that its transitions are overwhelmingly soft.
  const transitions = input.hardEdgeRatio + input.softEdgeRatio;
  if (
    transitions > 0.02 &&
    input.hardEdgeRatio / transitions < 0.12 &&
    input.classification !== 'photo'
  ) {
    findings.push({
      level: 'warning',
      message:
        'Edges are soft rather than crisp, which usually means the source was blurred or upscaled. ' +
        'Shape boundaries will be approximate.',
    });
  }

  if (input.capped) {
    findings.push({
      level: 'info',
      message: `More than ${UNIQUE_COLOR_LIMIT.toLocaleString('en-US')} distinct colours. They will be reduced to the palette size you choose.`,
    });
  } else if (input.uniqueColorCount <= 24) {
    findings.push({
      level: 'info',
      message: `Only ${input.uniqueColorCount} distinct colours, so they can be preserved exactly rather than re-quantised.`,
    });
  }

  if (input.transparentRatio > 0.05) {
    findings.push({
      level: 'info',
      message: `Already has transparency (${Math.round(input.transparentRatio * 100)}% of the canvas), which is carried through to the SVG.`,
    });
  }

  return findings;
}

/**
 * Turn measurements into settings.
 *
 * The noise-dependent part is calibrated on a 4-colour logo re-saved at JPEG
 * quality 22. Sweeping the settings on it showed that `colorMergeThreshold` is by
 * far the strongest lever, not `denoise`: at the default threshold of 8 the result
 * was 58 speckle pieces, and at 12 it was 4 pieces — the same as tracing the clean
 * original. The reason is that ringing produces clusters that are perceptually
 * near-identical to the real colours, so they have to be merged in the palette
 * rather than filtered in the pixels.
 *
 * Capping the palette matters for the same reason: on a degraded source, extra
 * palette headroom is spent on artifacts instead of content.
 */
function recommend(
  classification: Classification,
  uniqueColors: number,
  capped: boolean,
  noiseEstimate: number,
  width: number,
  height: number
): ImageAnalysis['recommended'] {
  const veryNoisy = noiseEstimate > 0.5;
  const noisy = noiseEstimate > 0.15;

  const denoise = veryNoisy ? 85 : noisy ? 70 : noiseEstimate > 0.05 ? 45 : 30;
  const noiseOptions: VectorizeOptions = noisy
    ? { denoise, colorMergeThreshold: veryNoisy ? 14 : 12 }
    : { denoise };
  const noiseNote = noisy
    ? ' Compression artifacts detected, so near-duplicate colours are merged harder to stop ringing becoming speckle shapes.'
    : '';

  // A tiny image with a tiny palette is almost certainly pixel art, where any
  // smoothing is a bug rather than a feature.
  if (uniqueColors <= 32 && Math.max(width, height) <= 256) {
    return {
      presetId: 'pixel-art',
      options: { maxColors: Math.max(2, Math.min(32, uniqueColors)) },
      rationale:
        'Small canvas with a tiny palette reads as pixel art, so it is traced literally with no smoothing.',
    };
  }

  switch (classification) {
    case 'line-art':
      return {
        presetId: 'lineart',
        options: { maxColors: Math.max(2, Math.min(4, uniqueColors)), ...noiseOptions },
        rationale:
          'Few colours and large flat areas: high detail keeps thin strokes intact, and thin ' +
          'regions are recovered as single centreline paths rather than pairs of parallel outlines.' +
          noiseNote,
      };
    case 'flat-art': {
      const isLogoLike = uniqueColors <= 24 && !capped;
      return {
        presetId: isLogoLike ? 'logo' : 'ai-art',
        options: {
          maxColors: isLogoLike ? Math.max(2, Math.min(8, uniqueColors)) : noisy ? 6 : 10,
          ...noiseOptions,
        },
        rationale:
          (isLogoLike
            ? 'Small intentional palette, so exact colours are preserved and corners kept sharp.'
            : 'Flat artwork with palette spread from anti-aliasing; near-duplicate colours are merged harder.') +
          noiseNote,
      };
    }
    case 'gradient-art':
      return {
        presetId: 'poster',
        options: { maxColors: noisy ? 10 : 12, ...noiseOptions },
        rationale:
          'Shading present: more colours reduce banding, at the cost of more layers.' + noiseNote,
      };
    case 'photo':
      return {
        presetId: 'poster',
        options: { maxColors: 16, denoise: 60, colorMergeThreshold: 8 },
        rationale:
          'Not suitable for tracing. These settings produce a posterised interpretation, not a faithful vector.',
      };
    default:
      return {
        presetId: 'logo',
        options: noiseOptions,
        rationale:
          'Balanced defaults, since the image could not be classified confidently.' + noiseNote,
      };
  }
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
