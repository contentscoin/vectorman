import type { Point } from '../types.js';

/**
 * Corner detection.
 *
 * Curve fitting must know which vertices are intentional corners and which are
 * just samples along a smooth arc. Get it wrong in one direction and a square
 * gets rounded shoulders; get it wrong in the other and a circle becomes a
 * polygon. Everything downstream depends on this classification, because corners
 * are the only places the fitter is allowed to break tangent continuity.
 *
 * Direction is measured over a *span of arc length* rather than from the two
 * adjacent vertices. After simplification, vertex spacing is uneven, and a pair
 * of short segments produces a wildly noisy angle. Accumulating roughly a pixel
 * and a half in each direction makes the measurement stable regardless of local
 * vertex density.
 */

const MIN_SPAN = 1.5;
const MAX_SPAN_VERTICES = 6;

export interface CornerAnalysis {
  /** Indices of vertices classified as hard corners, ascending. */
  corners: number[];
  /** Turn angle in degrees at each vertex. 0 = straight, 180 = full reversal. */
  turnAngles: Float64Array;
}

/**
 * Map a 0-100 smoothing setting to a turn-angle threshold in degrees.
 *
 * At 0 nearly every direction change is preserved, giving faithful polygonal
 * output for pixel art. At 100 only near-reversals survive, so organic shapes
 * become fully continuous curves. The default lands near 66 degrees, which sits
 * comfortably between a circle's per-vertex turn after simplification (well
 * under 30 degrees) and a square's 90 degree corner.
 */
export function cornerThresholdDegrees(smoothing: number): number {
  const s = Math.max(0, Math.min(100, smoothing)) / 100;
  return 8 + Math.pow(s, 0.9) * 92;
}

/**
 * Classify vertices as corners.
 *
 * `closed` controls whether the ends wrap. Open polylines occur when tracing
 * shared boundaries between two color regions: those have real endpoints (the
 * junctions where a third region meets), which are pinned by the caller and so
 * are never reported as corners here.
 */
export function analyzeCorners(
  points: Point[],
  thresholdDegrees: number,
  closed = true,
  minSpacing = 0
): CornerAnalysis {
  const n = points.length;
  const turnAngles = new Float64Array(n);
  const corners: number[] = [];

  if (n < 3) {
    return { corners, turnAngles };
  }

  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;

  for (let i = first; i <= last; i++) {
    const back = spanDirection(points, i, -1, closed);
    const forward = spanDirection(points, i, 1, closed);

    if (!back || !forward) {
      turnAngles[i] = 0;
      continue;
    }

    // `back` points from the earlier sample toward vertex i once negated.
    const incomingX = -back.x;
    const incomingY = -back.y;

    const dot = incomingX * forward.x + incomingY * forward.y;
    const cross = incomingX * forward.y - incomingY * forward.x;
    const angle = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI);

    turnAngles[i] = angle;
    if (angle >= thresholdDegrees) corners.push(i);
  }

  if (minSpacing <= 0 || corners.length < 2) {
    return { corners, turnAngles };
  }

  // Never let suppression act at the scale of the shape itself. On a 2px detail
  // the simplification epsilon can exceed the whole outline, which would collapse
  // all four corners of a single pixel into one and turn a square into a blob.
  const span = pathLength(points, closed);
  const spacing = Math.min(minSpacing, span / 8);

  return {
    corners:
      spacing > 0 ? suppressNearbyCorners(points, corners, turnAngles, spacing, closed) : corners,
    turnAngles,
  };
}

function pathLength(points: Point[], closed: boolean): number {
  let total = 0;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Keep only the strongest corner within any `minSpacing` window.
 *
 * Direction is measured over a span of arc length, so a single sharp corner also
 * raises the angle at the vertices flanking it. Without suppression one corner
 * becomes two or three, and the fitter then breaks tangent continuity several
 * times across what should be a single hard vertex — visible as a chamfered or
 * notched corner.
 *
 * `minSpacing` is tied to the simplification epsilon by the caller, so it is zero
 * when nothing was simplified. That matters for literal pixel-art tracing, where
 * every 1px staircase step is a genuine corner that must survive.
 */
function suppressNearbyCorners(
  points: Point[],
  corners: number[],
  turnAngles: Float64Array,
  minSpacing: number,
  closed: boolean
): number[] {
  if (corners.length < 2) return corners;

  const distance = (a: number, b: number) =>
    Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);

  // Strongest first, then greedily reject anything too close to an accepted corner.
  const ranked = [...corners].sort((a, b) => turnAngles[b] - turnAngles[a]);
  const accepted: number[] = [];

  for (const candidate of ranked) {
    let tooClose = false;
    for (const kept of accepted) {
      if (distance(candidate, kept) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(candidate);
  }

  // Endpoints of an open polyline are pinned by the caller and never suppressed.
  if (!closed) {
    for (const index of corners) {
      if ((index === 0 || index === points.length - 1) && !accepted.includes(index)) {
        accepted.push(index);
      }
    }
  }

  return accepted.sort((a, b) => a - b);
}

/**
 * Unit direction from vertex `i` toward vertices `step` away, accumulating until
 * the span is long enough to be meaningful. Returns null for a degenerate span.
 */
function spanDirection(points: Point[], i: number, step: number, closed: boolean): Point | null {
  const n = points.length;
  const origin = points[i];
  let accumulated = 0;
  let index = i;

  for (let k = 0; k < MAX_SPAN_VERTICES; k++) {
    let next = index + step;
    if (closed) {
      next = (next + n) % n;
    } else if (next < 0 || next >= n) {
      break;
    }
    accumulated += Math.hypot(points[next].x - points[index].x, points[next].y - points[index].y);
    index = next;
    if (accumulated >= MIN_SPAN) break;
    if (index === i) break;
  }

  const dx = points[index].x - origin.x;
  const dy = points[index].y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;

  return { x: dx / length, y: dy / length };
}
