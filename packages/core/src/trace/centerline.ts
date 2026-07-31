import { distanceTransform, maxInscribedRadius, type DistanceField } from '../image/distance.js';
import { analyzeCorners } from '../geom/corners.js';
import { fitClosedContour, fitOpenPolyline } from '../geom/fit.js';
import { removeCollinear, simplifyClosed, simplifyPolyline } from '../geom/simplify.js';
import type { Point, StrokePath } from '../types.js';
import { extractBranches, pruneSpurs, skeletonize } from './skeleton.js';

/**
 * Centreline tracing.
 *
 * A stroke traced as a filled region comes back as two parallel outlines with caps
 * on the ends. That is geometrically faithful and almost useless for the jobs line
 * art is actually for: a plotter or laser wants one path to follow, and a designer
 * wants one path whose weight they can change. It is also expensive — the sample
 * line-art fixture costs 228 nodes as outlines to describe about five strokes.
 *
 * So thin, elongated regions are converted into single stroked paths instead.
 *
 * ## Deciding what is a stroke
 *
 * The test compares a region's area against its largest inscribed circle:
 *
 *     elongation = area / (4 * maxRadius^2)
 *
 * The denominator is the area of the square that circumscribes that circle, which
 * makes the ratio scale-free. A disc scores about 0.79 no matter how big it is. A
 * stroke of width `w` and length `L` scores about `L / w`. So the threshold reads
 * directly as "how many times longer than it is wide", which is a property someone
 * can reason about, unlike a tuned constant.
 *
 * ## The safety condition
 *
 * Replacing a fill with a stroke changes where that colour's edge lies. If another
 * colour region shares that edge, a gap opens between them — exactly the seam the
 * planar tracer exists to prevent. So a region is only converted when its entire
 * boundary faces empty space. Ink on transparency qualifies; a stroke drawn across
 * a filled background does not, and stays a filled outline.
 */

export interface CenterlineOptions {
  /**
   * Minimum length-to-width ratio for a region to count as a stroke.
   * @default 5
   */
  minElongation: number;
  /**
   * Simplification epsilon for the traced centreline, in pixels.
   */
  epsilon: number;
  /** Curve-fitting tolerance in pixels. */
  tolerance: number;
  /** Turn angle above which a centreline vertex stays a hard corner. */
  cornerThreshold: number;
  /** Cubics flatter than this become straight lines. */
  lineTolerance: number;
  /**
   * Ignore regions whose inscribed radius exceeds this, in pixels. A very wide bar
   * is technically elongated but reads as a shape, and turning it into a stroke
   * loses its end caps and corners.
   * @default 40
   */
  maxStrokeRadius: number;
}

export interface CenterlineResult {
  paths: StrokePath[];
  /** Median stroke width across the region, in pixels. */
  width: number;
  /** The measured length-to-width ratio, for reporting. */
  elongation: number;
}

export interface StrokeCandidate {
  /** 1 inside the region. Must include a margin of background around it. */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  /** Source coordinate of mask pixel (0,0), so geometry can be translated back. */
  offsetX: number;
  offsetY: number;
  pixelCount: number;
}

/**
 * Test whether a region looks like a stroke, and if so trace its centreline.
 * Returns null when the region should stay a filled outline.
 */
export function traceCenterline(
  candidate: StrokeCandidate,
  options: CenterlineOptions
): CenterlineResult | null {
  const { mask, maskWidth, maskHeight, pixelCount } = candidate;
  if (pixelCount < 6) return null;

  const field = distanceTransform(mask, maskWidth, maskHeight);
  const radius = maxInscribedRadius(field);
  if (radius <= 0) return null;
  if (radius > options.maxStrokeRadius) return null;

  const elongation = pixelCount / (4 * radius * radius);
  if (elongation < options.minElongation) return null;

  const skeleton = skeletonize(mask, maskWidth, maskHeight);
  if (skeleton.count === 0) return null;

  // Pruning needs a width to scale its threshold to, but the accurate width
  // estimate needs the pruned skeleton length. So a rough figure from the distance
  // field goes first, and the width is refined once the spurs are gone.
  const roughWidth = roughWidthFromDistance(field, skeleton.pixels);
  if (roughWidth <= 0) return null;

  const branches = pruneSpurs(extractBranches(skeleton), roughWidth);
  if (branches.length === 0) return null;

  // Fit first, then measure. The width estimate below needs the length of the
  // *fitted* curve, not of the pixel chain, and the fit itself does not depend on
  // the width.
  const fittedPaths: Array<{ start: Point; segments: StrokePath['segments']; closed: boolean }> = [];
  let freeEnds = 0;

  for (const branch of branches) {
    // A single pixel carries no direction; a dot is better served by the filled
    // outline it already had than by a zero-length stroke.
    if (branch.points.length < 2) continue;

    const fitted = fitBranch(branch.points, branch.closed, options);
    if (!fitted) continue;

    if (!branch.closed) {
      if (branch.startDegree <= 1) freeEnds++;
      if (branch.endDegree <= 1) freeEnds++;
    }

    fittedPaths.push({ ...fitted, closed: branch.closed });
  }

  if (fittedPaths.length === 0) return null;

  const strokeWidth = estimateWidth(pixelCount, fittedPaths, freeEnds, radius, roughWidth);
  if (strokeWidth <= 0) return null;

  const paths: StrokePath[] = fittedPaths.map((path) => {
    translate(path, candidate.offsetX, candidate.offsetY);
    return { ...path, width: strokeWidth };
  });

  return { paths, width: strokeWidth, elongation };
}

function fitBranch(
  points: Point[],
  closed: boolean,
  options: CenterlineOptions
): { start: Point; segments: StrokePath['segments'] } | null {
  if (closed) {
    // Drop the repeated closing pixel so the loop is not fitted with a duplicate.
    const loop = points.slice(0, -1);
    if (loop.length < 3) return null;

    let working = loop;
    if (options.epsilon > 0) {
      working = removeCollinear(simplifyClosed(working, options.epsilon));
      if (working.length < 3) working = loop;
    }

    const { corners } = analyzeCorners(
      working,
      options.cornerThreshold,
      true,
      options.epsilon * 0.9
    );
    return fitClosedContour(working, corners, {
      tolerance: options.tolerance,
      lineTolerance: options.lineTolerance,
    });
  }

  let working = points;
  if (options.epsilon > 0) {
    working = simplifyPolyline(working, options.epsilon);
  }
  if (working.length < 2) return null;

  const { corners } = analyzeCorners(
    working,
    options.cornerThreshold,
    false,
    options.epsilon * 0.9
  );
  return fitOpenPolyline(working, corners, {
    tolerance: options.tolerance,
    lineTolerance: options.lineTolerance,
  });
}

/**
 * Rough stroke width from the distance field, sampled along the skeleton.
 *
 * Only used to scale the spur-pruning threshold. The median is taken rather than
 * the mean because junctions are systematically biased: where two strokes cross,
 * the inscribed circle fits the whole intersection and reports a radius well above
 * the true half-width. A mean would be dragged up by every crossing in the drawing.
 */
function roughWidthFromDistance(field: DistanceField, skeletonPixels: Uint8Array): number {
  const samples: number[] = [];

  for (let index = 0; index < skeletonPixels.length; index++) {
    if (!skeletonPixels[index]) continue;
    const value = field.squared[index];
    if (value > 0) samples.push(Math.sqrt(value));
  }

  if (samples.length === 0) return 0;

  samples.sort((a, b) => a - b);
  return Math.max(0.5, samples[samples.length >> 1] * 2 - 1);
}

/**
 * Stroke width as area divided by centreline length.
 *
 * A stroke's area is its width times its length by definition, so this inverts
 * cleanly — provided the length is measured well. Two corrections make it so:
 *
 *  - **Measure the fitted curve, not the pixel chain.** Summing 8-connected pixel
 *    steps overestimates a curve's length by several percent, because a staircase
 *    approximating an arc is longer than the arc. The fitted Béziers follow the true
 *    path, so their length is what the area should be divided by.
 *
 *  - **Add back the eroded end caps.** Thinning shortens a free end by roughly half
 *    the stroke width, since the cap has no ridge to leave behind. Without this a
 *    short stroke reads as too wide: a 200px bar loses about 9px of skeleton and
 *    comes out 5% heavy.
 *
 * Both corrections matter in opposite directions, which is why the earlier
 * single-estimator versions were biased whichever way the artwork happened to lean.
 */
function estimateWidth(
  pixelCount: number,
  paths: Array<{ start: Point; segments: StrokePath['segments'] }>,
  freeEnds: number,
  maxRadius: number,
  fallback: number
): number {
  let totalLength = 0;
  for (const path of paths) totalLength += polypathLength(path);

  if (totalLength < 2) return fallback;

  // Solve width from area = width * (length + freeEnds * width/2). Doing it by
  // iteration rather than algebraically keeps it obvious: two passes is plenty,
  // since the correction is a small fraction of the total.
  let width = pixelCount / totalLength;
  for (let pass = 0; pass < 2; pass++) {
    width = pixelCount / (totalLength + (freeEnds * width) / 2);
  }

  // The largest inscribed circle bounds any honest width, so this catches a
  // nearly-degenerate skeleton producing an absurd ratio.
  return Math.max(0.5, Math.min(width, maxRadius * 2 + 1));
}

/** Arc length of a fitted path, sampling cubics finely enough to be accurate. */
function polypathLength(path: { start: Point; segments: StrokePath['segments'] }): number {
  const SAMPLES = 12;
  let total = 0;
  let cursor = path.start;

  for (const segment of path.segments) {
    if (segment.kind === 'line') {
      total += Math.hypot(segment.to.x - cursor.x, segment.to.y - cursor.y);
      cursor = segment.to;
      continue;
    }

    let previous = cursor;
    for (let i = 1; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * t * mt * mt;
      const c = 3 * t * t * mt;
      const d = t * t * t;
      const point = {
        x: a * cursor.x + b * segment.c1.x + c * segment.c2.x + d * segment.to.x,
        y: a * cursor.y + b * segment.c1.y + c * segment.c2.y + d * segment.to.y,
      };
      total += Math.hypot(point.x - previous.x, point.y - previous.y);
      previous = point;
    }
    cursor = segment.to;
  }

  return total;
}

function translate(
  path: { start: Point; segments: StrokePath['segments'] },
  dx: number,
  dy: number
): void {
  if (dx === 0 && dy === 0) return;

  path.start = { x: path.start.x + dx, y: path.start.y + dy };
  for (const segment of path.segments) {
    segment.to = { x: segment.to.x + dx, y: segment.to.y + dy };
    if (segment.kind === 'cubic') {
      segment.c1 = { x: segment.c1.x + dx, y: segment.c1.y + dy };
      segment.c2 = { x: segment.c2.x + dx, y: segment.c2.y + dy };
    }
  }
}

/** Scale stroke geometry from traced space back to source space. */
export function scaleStrokePath(path: StrokePath, scaleX: number, scaleY: number): void {
  if (scaleX === 1 && scaleY === 1) return;

  path.start = { x: path.start.x * scaleX, y: path.start.y * scaleY };
  for (const segment of path.segments) {
    segment.to = { x: segment.to.x * scaleX, y: segment.to.y * scaleY };
    if (segment.kind === 'cubic') {
      segment.c1 = { x: segment.c1.x * scaleX, y: segment.c1.y * scaleY };
      segment.c2 = { x: segment.c2.x * scaleX, y: segment.c2.y * scaleY };
    }
  }
  // Width is a scalar, so a non-uniform scale has no single right answer. The
  // geometric mean is the standard compromise and is exact when the scale is uniform,
  // which it always is here apart from sub-pixel rounding.
  path.width *= Math.sqrt(scaleX * scaleY);
}
