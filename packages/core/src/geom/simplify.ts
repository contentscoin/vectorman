import type { Point } from '../types.js';

/**
 * Polyline simplification.
 *
 * The tracer emits a staircase: an exact, axis-aligned outline of the pixel
 * region. A 45-degree edge arrives as dozens of 1px steps, each a real vertex.
 * Ramer-Douglas-Peucker removes them, because every step deviates from the ideal
 * straight line by at most half a pixel, so any epsilon above ~0.5 collapses the
 * staircase while leaving genuine shape features untouched.
 *
 * Running this *before* curve fitting matters. Fitting the raw staircase would
 * either reproduce the steps as wiggles or need such a loose tolerance that real
 * detail dissolves too.
 */

/** Perpendicular distance from `p` to the infinite line through `a` and `b`. */
function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const cross = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x));
  return cross / Math.sqrt(lengthSquared);
}

/**
 * RDP on an open polyline. Iterative, so deeply recursive inputs (a long spiral)
 * cannot overflow the stack.
 */
export function simplifyPolyline(points: Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n <= 2 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    let maxDistance = -1;
    let index = -1;
    const a = points[first];
    const b = points[last];

    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], a, b);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (maxDistance > epsilon && index > first && index < last) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * RDP on a closed loop.
 *
 * A closed loop has no natural endpoints, and picking arbitrary ones biases the
 * result: whichever two vertices are chosen are guaranteed to survive, which can
 * pin a vertex in the middle of a smooth arc. Two mutually distant extreme
 * points are chosen instead, since those are almost always genuine features of
 * the silhouette.
 */
export function simplifyClosed(points: Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n <= 3 || epsilon <= 0) return points.slice();

  // Anchor 1: the vertex farthest from the centroid.
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let anchorA = 0;
  let bestDistance = -1;
  for (let i = 0; i < n; i++) {
    const d = (points[i].x - cx) ** 2 + (points[i].y - cy) ** 2;
    if (d > bestDistance) {
      bestDistance = d;
      anchorA = i;
    }
  }

  // Anchor 2: the vertex farthest from anchor 1.
  let anchorB = anchorA;
  bestDistance = -1;
  for (let i = 0; i < n; i++) {
    const d = (points[i].x - points[anchorA].x) ** 2 + (points[i].y - points[anchorA].y) ** 2;
    if (d > bestDistance) {
      bestDistance = d;
      anchorB = i;
    }
  }

  if (anchorA === anchorB) return points.slice();

  const first = Math.min(anchorA, anchorB);
  const second = Math.max(anchorA, anchorB);

  const arcOne = points.slice(first, second + 1);
  const arcTwo = points.slice(second).concat(points.slice(0, first + 1));

  const simplifiedOne = simplifyPolyline(arcOne, epsilon);
  const simplifiedTwo = simplifyPolyline(arcTwo, epsilon);

  // Both arcs include the shared anchors; drop the duplicates at the joins.
  return simplifiedOne.slice(0, -1).concat(simplifiedTwo.slice(0, -1));
}

/** Drop vertices that lie on the straight line between their neighbours. */
export function removeCollinear(points: Point[], tolerance = 1e-9): Point[] {
  const n = points.length;
  if (n <= 3) return points.slice();

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const previous = points[(i - 1 + n) % n];
    const current = points[i];
    const next = points[(i + 1) % n];
    const cross =
      (current.x - previous.x) * (next.y - previous.y) -
      (current.y - previous.y) * (next.x - previous.x);
    if (Math.abs(cross) > tolerance) out.push(current);
  }

  return out.length >= 3 ? out : points.slice();
}

/** Total length of a closed polygon's perimeter. */
export function perimeter(points: Point[]): number {
  let total = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}
