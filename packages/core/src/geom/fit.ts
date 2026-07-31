import type { Point, Segment } from '../types.js';

/**
 * Cubic Bezier fitting, after Philip Schneider's "An Algorithm for Automatically
 * Fitting Digitized Curves" (Graphics Gems, 1990), adapted for closed contours
 * with corner constraints.
 *
 * This is the step that produces the headline property: a low node count. The
 * naive alternative — emitting one segment per simplified vertex — yields paths
 * that are technically vectors but miserable to edit, because dragging any
 * anchor only moves a tiny facet of what looks like a smooth curve.
 *
 * The method:
 *
 *  1. Assume the arc is one cubic. Endpoints and end *tangent directions* are
 *     fixed; only the two control-point magnitudes are unknown, so the least
 *     squares problem is a 2x2 solve.
 *  2. Measure the worst deviation. If it is within tolerance, done.
 *  3. If it is close, refine the parameterization with Newton-Raphson (chord
 *     length is a poor guess on curves that speed up and slow down) and retry.
 *  4. Otherwise split at the worst point and recurse on both halves, joining
 *     them with a shared tangent so the result stays C1 continuous.
 *
 * Tangent continuity is broken *only* at detected corners, which is what makes
 * the output behave like a hand-drawn path under editing.
 */

export type BezierCurve = [Point, Point, Point, Point];

/** Newton-Raphson attempts before giving up and splitting. */
const MAX_REPARAM_ITERATIONS = 6;

/** Multiple of the tolerance within which refining is preferred over splitting. */
const REPARAM_WINDOW = 4;

/** Safety valve against pathological inputs producing unbounded output. */
const MAX_CURVES_PER_ARC = 512;

export interface FitOptions {
  /** Maximum allowed deviation, in pixels, between the fitted curve and the input. */
  tolerance: number;
  /**
   * A fitted cubic whose control points sit within this distance of the chord is
   * emitted as a straight line instead. Straight edges are extremely common in
   * logos and type, and a line is both smaller and easier to edit than a cubic
   * pretending to be one.
   */
  lineTolerance: number;
}

/**
 * Fit a closed contour, preserving the given corner indices as hard vertices.
 *
 * Returns the start point plus the segment list, ready for SVG emission. The
 * closing segment back to the start point is included; the path is closed with
 * `Z` and the final `to` equals `start`.
 */
export function fitClosedContour(
  points: Point[],
  corners: number[],
  options: FitOptions
): { start: Point; segments: Segment[] } | null {
  const n = points.length;
  if (n < 3) return null;

  if (corners.length === 0) {
    return fitSmoothClosed(points, options);
  }

  const ordered = [...corners].sort((a, b) => a - b);
  const start = points[ordered[0]];
  const segments: Segment[] = [];

  for (let c = 0; c < ordered.length; c++) {
    const from = ordered[c];
    const to = ordered[(c + 1) % ordered.length];
    const arc = extractArc(points, from, to);
    if (arc.length < 2) continue;

    const tangentStart = arcTangent(arc, 0, 1);
    const tangentEnd = arcTangent(arc, arc.length - 1, -1);
    const curves = fitArc(arc, tangentStart, tangentEnd, options);
    appendCurves(segments, curves, options);
  }

  if (segments.length === 0) return null;
  return { start, segments };
}

/**
 * Fit an open polyline, preserving the given interior corner indices.
 *
 * Used for shared boundaries between two color regions. The endpoints are hard
 * constraints: they sit on junctions where a third region meets, and every
 * boundary meeting there must agree on the exact point or a pinhole appears.
 */
export function fitOpenPolyline(
  points: Point[],
  corners: number[],
  options: FitOptions
): { start: Point; segments: Segment[] } | null {
  const n = points.length;
  if (n < 2) return null;

  if (n === 2) {
    return { start: points[0], segments: [{ kind: 'line', to: points[1] }] };
  }

  const breaks: number[] = [0];
  for (const c of [...corners].sort((a, b) => a - b)) {
    if (c > 0 && c < n - 1 && c !== breaks[breaks.length - 1]) breaks.push(c);
  }
  breaks.push(n - 1);

  const segments: Segment[] = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    const arc = points.slice(breaks[i], breaks[i + 1] + 1);
    if (arc.length < 2) continue;
    const tangentStart = arcTangent(arc, 0, 1);
    const tangentEnd = arcTangent(arc, arc.length - 1, -1);
    const curves = fitArc(arc, tangentStart, tangentEnd, options);
    appendCurves(segments, curves, options);
  }

  if (segments.length === 0) return null;
  return { start: points[0], segments };
}

/**
 * A contour with no corners is a fully smooth loop. Any seam we pick is
 * artificial, so the start and end tangents are tied to each other to keep C1
 * continuity across it — otherwise a visible crease appears at an arbitrary spot.
 */
function fitSmoothClosed(
  points: Point[],
  options: FitOptions
): { start: Point; segments: Segment[] } | null {
  const n = points.length;
  const seam = 0;

  const arc: Point[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) arc[i] = points[(seam + i) % n];

  const previous = points[(seam - 1 + n) % n];
  const next = points[(seam + 1) % n];
  let tangent = normalize({ x: next.x - previous.x, y: next.y - previous.y });
  if (!tangent) tangent = arcTangent(arc, 0, 1);

  const curves = fitArc(arc, tangent, { x: -tangent.x, y: -tangent.y }, options);
  const segments: Segment[] = [];
  appendCurves(segments, curves, options);

  if (segments.length === 0) return null;
  return { start: points[seam], segments };
}

/** Inclusive vertex run from `from` to `to`, wrapping around the loop. */
function extractArc(points: Point[], from: number, to: number): Point[] {
  const n = points.length;
  const arc: Point[] = [points[from]];
  let i = from;
  // A single-corner contour wraps all the way around back to itself.
  do {
    i = (i + 1) % n;
    arc.push(points[i]);
  } while (i !== to);
  return arc;
}

/**
 * Unit tangent at an arc endpoint, pointing inward along the arc.
 *
 * Averaged over roughly a pixel and a half of arc length: taking only the first
 * segment makes the tangent hostage to a single short facet, which visibly
 * kinks the curve right at the corner it was supposed to anchor.
 */
function arcTangent(arc: Point[], index: number, direction: 1 | -1): Point {
  const origin = arc[index];
  let accumulated = 0;
  let i = index;
  const limit = Math.min(4, arc.length - 1);

  for (let k = 0; k < limit; k++) {
    const next = i + direction;
    if (next < 0 || next >= arc.length) break;
    accumulated += Math.hypot(arc[next].x - arc[i].x, arc[next].y - arc[i].y);
    i = next;
    if (accumulated >= 1.5) break;
  }

  const tangent = normalize({ x: arc[i].x - origin.x, y: arc[i].y - origin.y });
  return tangent ?? { x: direction, y: 0 };
}

interface WorkItem {
  first: number;
  last: number;
  tangentStart: Point;
  tangentEnd: Point;
}

/**
 * Iterative driver for the recursive fit. An explicit stack keeps a very long,
 * highly detailed contour from overflowing the call stack, and lets us cap the
 * output size.
 */
function fitArc(
  arc: Point[],
  tangentStart: Point,
  tangentEnd: Point,
  options: FitOptions
): BezierCurve[] {
  const results: Array<{ order: number; curve: BezierCurve }> = [];
  const stack: WorkItem[] = [
    { first: 0, last: arc.length - 1, tangentStart, tangentEnd },
  ];

  while (stack.length > 0) {
    const item = stack.pop() as WorkItem;
    const { first, last } = item;

    if (results.length >= MAX_CURVES_PER_ARC) {
      results.push({ order: first, curve: straightCurve(arc[first], arc[last], item) });
      continue;
    }

    const count = last - first + 1;

    if (count < 2) continue;

    if (count === 2) {
      results.push({ order: first, curve: straightCurve(arc[first], arc[last], item) });
      continue;
    }

    let u = chordLengthParameterize(arc, first, last);
    let curve = generateBezier(arc, first, last, u, item.tangentStart, item.tangentEnd);
    let { maxError, splitPoint } = computeMaxError(arc, first, last, curve, u);

    if (maxError < options.tolerance) {
      results.push({ order: first, curve });
      continue;
    }

    if (maxError < options.tolerance * REPARAM_WINDOW) {
      let settled = false;
      for (let iteration = 0; iteration < MAX_REPARAM_ITERATIONS; iteration++) {
        const refined = reparameterize(arc, first, last, u, curve);
        const candidate = generateBezier(
          arc,
          first,
          last,
          refined,
          item.tangentStart,
          item.tangentEnd
        );
        const measured = computeMaxError(arc, first, last, candidate, refined);
        u = refined;
        curve = candidate;
        maxError = measured.maxError;
        splitPoint = measured.splitPoint;
        if (maxError < options.tolerance) {
          results.push({ order: first, curve });
          settled = true;
          break;
        }
      }
      if (settled) continue;
    }

    // Split. Clamp so both halves keep at least two points and progress is made.
    let split = splitPoint;
    if (split <= first) split = first + 1;
    if (split >= last) split = last - 1;
    if (split <= first || split >= last) {
      results.push({ order: first, curve });
      continue;
    }

    const centerTangent = computeCenterTangent(arc, split);

    // Push the second half first so the stack pops in ascending order.
    stack.push({
      first: split,
      last,
      tangentStart: { x: -centerTangent.x, y: -centerTangent.y },
      tangentEnd: item.tangentEnd,
    });
    stack.push({
      first,
      last: split,
      tangentStart: item.tangentStart,
      tangentEnd: centerTangent,
    });
  }

  results.sort((a, b) => a.order - b.order);
  return results.map((r) => r.curve);
}

/** Degenerate two-point case: a cubic laid along the chord, honouring tangents. */
function straightCurve(from: Point, to: Point, item: WorkItem): BezierCurve {
  const third = Math.hypot(to.x - from.x, to.y - from.y) / 3;
  return [
    from,
    { x: from.x + item.tangentStart.x * third, y: from.y + item.tangentStart.y * third },
    { x: to.x + item.tangentEnd.x * third, y: to.y + item.tangentEnd.y * third },
    to,
  ];
}

/**
 * Least-squares solve for the two interior control points.
 *
 * Endpoints and tangent *directions* are fixed, leaving only the two magnitudes
 * (how far each control point travels along its tangent) as unknowns. That
 * reduces the fit to a 2x2 normal-equation solve, which is both fast and stable.
 */
function generateBezier(
  points: Point[],
  first: number,
  last: number,
  u: Float64Array,
  tangentStart: Point,
  tangentEnd: Point
): BezierCurve {
  const count = last - first + 1;
  const v0 = points[first];
  const v3 = points[last];

  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i < count; i++) {
    const t = u[i];
    const b0 = bernstein0(t);
    const b1 = bernstein1(t);
    const b2 = bernstein2(t);
    const b3 = bernstein3(t);

    const a0x = tangentStart.x * b1;
    const a0y = tangentStart.y * b1;
    const a1x = tangentEnd.x * b2;
    const a1y = tangentEnd.y * b2;

    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;

    const p = points[first + i];
    const tmpX = p.x - (v0.x * (b0 + b1) + v3.x * (b2 + b3));
    const tmpY = p.y - (v0.y * (b0 + b1) + v3.y * (b2 + b3));

    x0 += a0x * tmpX + a0y * tmpY;
    x1 += a1x * tmpX + a1y * tmpY;
  }

  const determinant = c00 * c11 - c01 * c01;

  let alphaStart: number;
  let alphaEnd: number;

  if (Math.abs(determinant) < 1e-12) {
    alphaStart = 0;
    alphaEnd = 0;
  } else {
    alphaStart = (x0 * c11 - x1 * c01) / determinant;
    alphaEnd = (c00 * x1 - c01 * x0) / determinant;
  }

  const chord = Math.hypot(v3.x - v0.x, v3.y - v0.y);

  // Negative magnitudes would fold the control point behind its endpoint,
  // producing a cusp. Fall back to the Wu/Barsky third-of-chord heuristic.
  if (alphaStart < 1e-6 || alphaEnd < 1e-6) {
    const third = chord / 3;
    alphaStart = third;
    alphaEnd = third;
  }

  // Runaway magnitudes cause huge loops that still satisfy the sampled error.
  const cap = chord * 3 + 1;
  if (alphaStart > cap) alphaStart = cap;
  if (alphaEnd > cap) alphaEnd = cap;

  return [
    v0,
    { x: v0.x + tangentStart.x * alphaStart, y: v0.y + tangentStart.y * alphaStart },
    { x: v3.x + tangentEnd.x * alphaEnd, y: v3.y + tangentEnd.y * alphaEnd },
    v3,
  ];
}

/**
 * Initial parameter guess from cumulative chord length, normalized to [0,1].
 * Cheap and usually within a few percent of the true arc-length parameter.
 */
function chordLengthParameterize(points: Point[], first: number, last: number): Float64Array {
  const count = last - first + 1;
  const u = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const a = points[first + i - 1];
    const b = points[first + i];
    u[i] = u[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = u[count - 1];
  if (total > 0) {
    for (let i = 1; i < count; i++) u[i] /= total;
  } else {
    for (let i = 1; i < count; i++) u[i] = i / (count - 1);
  }
  u[count - 1] = 1;
  return u;
}

/**
 * One Newton-Raphson step per sample, moving each parameter toward the point on
 * the curve actually closest to its sample. Chord-length parameterization is
 * uniform in distance along the *polyline*, not along the curve, and that
 * mismatch alone can push a perfectly fittable arc over tolerance.
 */
function reparameterize(
  points: Point[],
  first: number,
  last: number,
  u: Float64Array,
  curve: BezierCurve
): Float64Array {
  const count = last - first + 1;
  const out = new Float64Array(count);

  const d1: Point[] = [
    { x: (curve[1].x - curve[0].x) * 3, y: (curve[1].y - curve[0].y) * 3 },
    { x: (curve[2].x - curve[1].x) * 3, y: (curve[2].y - curve[1].y) * 3 },
    { x: (curve[3].x - curve[2].x) * 3, y: (curve[3].y - curve[2].y) * 3 },
  ];
  const d2: Point[] = [
    { x: (d1[1].x - d1[0].x) * 2, y: (d1[1].y - d1[0].y) * 2 },
    { x: (d1[2].x - d1[1].x) * 2, y: (d1[2].y - d1[1].y) * 2 },
  ];

  for (let i = 0; i < count; i++) {
    const p = points[first + i];
    const t = u[i];

    const onCurve = evaluateBezier(curve, t);
    const firstDerivative = evaluateQuadratic(d1, t);
    const secondDerivative = evaluateLinear(d2, t);

    const dx = onCurve.x - p.x;
    const dy = onCurve.y - p.y;

    const numerator = dx * firstDerivative.x + dy * firstDerivative.y;
    const denominator =
      firstDerivative.x * firstDerivative.x +
      firstDerivative.y * firstDerivative.y +
      dx * secondDerivative.x +
      dy * secondDerivative.y;

    let refined = Math.abs(denominator) < 1e-12 ? t : t - numerator / denominator;

    // Parameters must stay ordered inside [0,1]; a wild step would scramble the fit.
    if (!Number.isFinite(refined)) refined = t;
    refined = Math.max(0, Math.min(1, refined));
    out[i] = refined;
  }

  out[0] = 0;
  out[count - 1] = 1;

  // Enforce monotonicity so a bad step cannot invert the sample order.
  for (let i = 1; i < count; i++) {
    if (out[i] < out[i - 1]) out[i] = out[i - 1];
  }

  return out;
}

function computeMaxError(
  points: Point[],
  first: number,
  last: number,
  curve: BezierCurve,
  u: Float64Array
): { maxError: number; splitPoint: number } {
  const count = last - first + 1;
  let maxError = 0;
  let splitPoint = first + Math.floor(count / 2);

  for (let i = 1; i < count - 1; i++) {
    const onCurve = evaluateBezier(curve, u[i]);
    const p = points[first + i];
    const distance = Math.hypot(onCurve.x - p.x, onCurve.y - p.y);
    if (distance > maxError) {
      maxError = distance;
      splitPoint = first + i;
    }
  }

  return { maxError, splitPoint };
}

/**
 * Tangent at an interior split point, pointing *backwards* along the curve.
 *
 * The direction convention is easy to get wrong and expensive when it is: end
 * tangents always point back into their own segment. So this value is used
 * directly as the first half's end tangent, and negated for the second half's
 * start tangent. Flipping the sign pushes both control points away from the
 * curve at the join, which blows the error past tolerance, triggers another
 * split, and recurses until there is one segment per input point.
 */
function computeCenterTangent(points: Point[], center: number): Point {
  const before = points[center - 1];
  const after = points[center + 1];
  const tangent = normalize({ x: before.x - after.x, y: before.y - after.y });
  if (tangent) return tangent;

  const fallback = normalize({
    x: before.x - points[center].x,
    y: before.y - points[center].y,
  });
  return fallback ?? { x: -1, y: 0 };
}

function evaluateBezier(curve: BezierCurve, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * t * mt * mt;
  const c = 3 * t * t * mt;
  const d = t * t * t;
  return {
    x: a * curve[0].x + b * curve[1].x + c * curve[2].x + d * curve[3].x,
    y: a * curve[0].y + b * curve[1].y + c * curve[2].y + d * curve[3].y,
  };
}

function evaluateQuadratic(control: Point[], t: number): Point {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * t * mt;
  const c = t * t;
  return {
    x: a * control[0].x + b * control[1].x + c * control[2].x,
    y: a * control[0].y + b * control[1].y + c * control[2].y,
  };
}

function evaluateLinear(control: Point[], t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * control[0].x + t * control[1].x,
    y: mt * control[0].y + t * control[1].y,
  };
}

function normalize(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  if (length < 1e-9) return null;
  return { x: v.x / length, y: v.y / length };
}

function bernstein0(t: number): number {
  const mt = 1 - t;
  return mt * mt * mt;
}
function bernstein1(t: number): number {
  const mt = 1 - t;
  return 3 * t * mt * mt;
}
function bernstein2(t: number): number {
  return 3 * t * t * (1 - t);
}
function bernstein3(t: number): number {
  return t * t * t;
}

/**
 * Convert fitted curves into segments, downgrading effectively-straight cubics
 * to lines. Logos and lettering are full of straight edges, and a line is
 * smaller in the file and far more predictable to edit than a cubic that merely
 * looks straight.
 */
function appendCurves(segments: Segment[], curves: BezierCurve[], options: FitOptions): void {
  for (const curve of curves) {
    const [p0, c1, c2, p3] = curve;
    if (isEffectivelyStraight(p0, c1, c2, p3, options.lineTolerance)) {
      segments.push({ kind: 'line', to: p3 });
    } else {
      segments.push({ kind: 'cubic', c1, c2, to: p3 });
    }
  }
}

function isEffectivelyStraight(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  tolerance: number
): boolean {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return true;

  const deviation = (p: Point) => Math.abs(dx * (p.y - p0.y) - dy * (p.x - p0.x)) / chord;
  if (deviation(c1) > tolerance || deviation(c2) > tolerance) return false;

  // Also require the control points to project inside the chord, otherwise the
  // curve overshoots its endpoints while staying on the line.
  const projection = (p: Point) => ((p.x - p0.x) * dx + (p.y - p0.y) * dy) / (chord * chord);
  const t1 = projection(c1);
  const t2 = projection(c2);
  return t1 > -0.05 && t1 < 1.05 && t2 > -0.05 && t2 < 1.05;
}
