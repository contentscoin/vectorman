import type { Point, Segment } from '../types.js';

/**
 * Segment-list utilities.
 *
 * Reversal is the important one. Because a boundary between two color regions is
 * fitted exactly once and then used by both sides, one of those two uses needs
 * the geometry walked backwards. Reversing the *fitted* segments (rather than
 * refitting the reversed input) is what guarantees the two regions share
 * bit-identical geometry, which is why the output has no seams.
 */

export interface Polypath {
  start: Point;
  segments: Segment[];
}

export function reversePolypath(path: Polypath): Polypath {
  const anchors: Point[] = [path.start];
  for (const segment of path.segments) anchors.push(segment.to);

  const segments: Segment[] = [];
  for (let i = path.segments.length - 1; i >= 0; i--) {
    const segment = path.segments[i];
    const previousAnchor = anchors[i];
    if (segment.kind === 'line') {
      segments.push({ kind: 'line', to: previousAnchor });
    } else {
      // Control points swap: the one nearer the old end becomes the one nearer
      // the new start.
      segments.push({ kind: 'cubic', c1: segment.c2, c2: segment.c1, to: previousAnchor });
    }
  }

  return { start: anchors[anchors.length - 1], segments };
}

export function countAnchors(segments: Segment[]): number {
  return segments.length;
}

export function polypathEnd(path: Polypath): Point {
  return path.segments.length === 0
    ? path.start
    : path.segments[path.segments.length - 1].to;
}

/** Shoelace signed area. Positive is clockwise in a y-down coordinate system. */
export function shoelace(points: Point[]): number {
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
