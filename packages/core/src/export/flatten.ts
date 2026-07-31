import type { Contour, Point } from '../types.js';

/**
 * Bezier flattening.
 *
 * Needed for formats that have no curve primitive worth using — DXF in
 * particular, where cutting and CAM software expects polylines. Flattening is
 * adaptive rather than fixed-step: a fixed number of samples per curve either
 * wastes points on gentle arcs or visibly facets tight ones, and on a cut file
 * that faceting becomes a physical defect in the material.
 */

/** Recursion cap. 2^10 segments is far beyond what any sane tolerance requires. */
const MAX_DEPTH = 10;

/**
 * Flatten a contour into a closed polygon.
 *
 * `tolerance` is the maximum allowed deviation in user units. 0.1 is a good
 * default for cutting: below the mechanical accuracy of any hobby cutter, and
 * well below what is visible in print.
 */
export function flattenContour(contour: Contour, tolerance = 0.1): Point[] {
  const points: Point[] = [contour.start];
  let cursor = contour.start;

  for (const segment of contour.segments) {
    if (segment.kind === 'line') {
      points.push(segment.to);
      cursor = segment.to;
      continue;
    }

    subdivideCubic(cursor, segment.c1, segment.c2, segment.to, tolerance, 0, points);
    cursor = segment.to;
  }

  // Drop a duplicated closing point; the polygon is implicitly closed.
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      points.pop();
    }
  }

  return points;
}

/**
 * Split until the curve is flat enough, measured as the distance of the control
 * points from the chord. That is a standard and cheap conservative bound on the
 * true deviation, and unlike arc-length sampling it needs no integration.
 */
function subdivideCubic(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  tolerance: number,
  depth: number,
  out: Point[]
): void {
  if (depth >= MAX_DEPTH || isFlatEnough(p0, c1, c2, p3, tolerance)) {
    out.push(p3);
    return;
  }

  // de Casteljau split at t = 0.5.
  const p01 = midpoint(p0, c1);
  const p12 = midpoint(c1, c2);
  const p23 = midpoint(c2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const mid = midpoint(p012, p123);

  subdivideCubic(p0, p01, p012, mid, tolerance, depth + 1, out);
  subdivideCubic(mid, p123, p23, p3, tolerance, depth + 1, out);
}

function isFlatEnough(p0: Point, c1: Point, c2: Point, p3: Point, tolerance: number): boolean {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const chordLengthSquared = dx * dx + dy * dy;

  if (chordLengthSquared < 1e-12) {
    // Degenerate chord: fall back to how far the control points stray.
    return (
      Math.hypot(c1.x - p0.x, c1.y - p0.y) <= tolerance &&
      Math.hypot(c2.x - p0.x, c2.y - p0.y) <= tolerance
    );
  }

  const d1 = Math.abs((c1.x - p0.x) * dy - (c1.y - p0.y) * dx);
  const d2 = Math.abs((c2.x - p0.x) * dy - (c2.y - p0.y) * dx);
  const limit = tolerance * Math.sqrt(chordLengthSquared);

  return d1 <= limit && d2 <= limit;
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
