import type { Point } from '../types.js';

/**
 * Skeletonization and skeleton graph extraction.
 *
 * Thinning reduces a filled stroke to a one-pixel-wide ridge running down its
 * middle, which is the path a pen or a laser should follow. The implementation is
 * Zhang-Suen (1984): two alternating sub-passes, each deleting boundary pixels
 * that satisfy conditions chosen so that connectivity and topology survive — a
 * ring stays a ring, and a line never breaks in half.
 *
 * The conditions are worth stating, because they are what makes the algorithm
 * safe rather than just an erosion:
 *
 *  - `2 <= B <= 6`, where B counts set neighbours. Below 2 the pixel is an
 *    endpoint and deleting it would shorten the line; above 6 it is interior.
 *  - `A == 1`, where A counts 0-to-1 transitions going around the neighbourhood.
 *    Exactly one transition means the set neighbours form a single connected arc,
 *    so removing the pixel cannot disconnect them.
 *  - The two product conditions delete from opposite sides on alternating passes,
 *    which keeps the result centred instead of eroding it toward one corner.
 *
 * Thinning inevitably produces spurs: a corner or a locally wide patch sprouts a
 * short branch that is an artifact of the medial axis, not a feature of the
 * drawing. Those are pruned afterwards, with the threshold scaled to the stroke
 * width, since that is the scale at which the artifacts appear.
 */

/** 8-neighbour offsets in Zhang-Suen order: P2..P9, starting north, clockwise. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // P2 N
  [1, -1], // P3 NE
  [1, 0], // P4 E
  [1, 1], // P5 SE
  [0, 1], // P6 S
  [-1, 1], // P7 SW
  [-1, 0], // P8 W
  [-1, -1], // P9 NW
];

export interface Skeleton {
  /** 1 where a skeleton pixel sits. Same dimensions as the input mask. */
  pixels: Uint8Array;
  width: number;
  height: number;
  count: number;
}

/**
 * Thin a binary mask to a one-pixel skeleton.
 *
 * The mask is not modified. Iteration stops when a full pass changes nothing, or
 * at `maxIterations` as a guard — each pass can only remove pixels, so the loop
 * always terminates, but the cap keeps a pathological input from being slow.
 */
export function skeletonize(
  mask: Uint8Array,
  width: number,
  height: number,
  maxIterations = 200
): Skeleton {
  const pixels = Uint8Array.from(mask);
  const doomed: number[] = [];

  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return pixels[y * width + x];
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let removed = 0;

    for (let step = 0; step < 2; step++) {
      doomed.length = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          if (!pixels[index]) continue;

          // Read the ring once; every condition below is a function of it.
          let setCount = 0;
          let transitions = 0;
          const ring: number[] = new Array(8);

          for (let n = 0; n < 8; n++) {
            const value = at(x + NEIGHBOURS[n][0], y + NEIGHBOURS[n][1]);
            ring[n] = value;
            setCount += value;
          }
          for (let n = 0; n < 8; n++) {
            if (ring[n] === 0 && ring[(n + 1) & 7] === 1) transitions++;
          }

          if (setCount < 2 || setCount > 6) continue;
          if (transitions !== 1) continue;

          const north = ring[0];
          const east = ring[2];
          const south = ring[4];
          const west = ring[6];

          if (step === 0) {
            if (north * east * south !== 0) continue;
            if (east * south * west !== 0) continue;
          } else {
            if (north * east * west !== 0) continue;
            if (north * south * west !== 0) continue;
          }

          doomed.push(index);
        }
      }

      // Deletion is deferred to the end of the sub-pass. Removing pixels while
      // scanning would let an earlier deletion change a later pixel's
      // neighbourhood, which breaks the connectivity guarantee the conditions rest on.
      for (const index of doomed) pixels[index] = 0;
      removed += doomed.length;
    }

    if (removed === 0) break;
  }

  let count = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i]) count++;

  return { pixels, width, height, count };
}

/**
 * Skeleton adjacency, with redundant diagonals removed.
 *
 * This is the subtle part of walking an 8-connected skeleton. Take a staircase step
 * — pixels at (0,0), (1,0) and (1,1). Every pair among them is 8-adjacent, including
 * (0,0) and (1,1) diagonally, so a naive neighbour query reports a 3-cycle where the
 * drawing has a simple line. A walk then jumps the diagonal, skips (1,0), and leaves
 * it stranded as a one-pixel branch. On a traced ring that produced hundreds of
 * fragments instead of one closed path.
 *
 * A diagonal is redundant exactly when the two pixels already connect through a
 * shared orthogonal neighbour that is also in the skeleton. Dropping those edges
 * turns the skeleton back into the simple curve it is meant to represent, and makes
 * the degree counts meaningful: a staircase interior becomes degree 2 rather than 3.
 */
function collectNeighbours(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: number[]
): number {
  out.length = 0;

  const set = (nx: number, ny: number): boolean => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
    return pixels[ny * width + nx] === 1;
  };

  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!set(nx, ny)) continue;

    // Diagonal step: skip it when either shared orthogonal cell is also set, since
    // the two pixels are already connected the long way round.
    if (dx !== 0 && dy !== 0) {
      if (set(x + dx, y) || set(x, y + dy)) continue;
    }

    out.push(ny * width + nx);
  }

  return out.length;
}

export interface Branch {
  /** Pixel centres along the branch, ordered end to end. */
  points: Point[];
  /** True when the branch returns to its start, e.g. the skeleton of a ring. */
  closed: boolean;
  /** Degree of the vertex at each end: 1 is a free end, 3 or more a junction. */
  startDegree: number;
  endDegree: number;
  /** Summed pixel-to-pixel length. */
  length: number;
}

/**
 * Split a skeleton into branches.
 *
 * Vertices of degree other than two are nodes: free ends and junctions. A branch
 * is a maximal run of degree-two pixels between two nodes. Anything left over once
 * every node has been walked is a closed loop with no node on it at all — the
 * skeleton of a ring — and is emitted as a closed branch.
 */
export function extractBranches(skeleton: Skeleton): Branch[] {
  const { pixels, width, height } = skeleton;
  const total = width * height;

  const scratch: number[] = [];

  const degree = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!pixels[index]) continue;
      degree[index] = collectNeighbours(pixels, width, height, x, y, scratch);
    }
  }

  // Edges rather than pixels are marked used: a junction belongs to several
  // branches, so marking it consumed would truncate all but the first.
  const usedEdges = new Set<number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * total + b : b * total + a);

  const neighboursOf = (index: number): number[] => {
    const x = index % width;
    const found: number[] = [];
    collectNeighbours(pixels, width, height, x, (index - x) / width, found);
    return found;
  };

  const branches: Branch[] = [];

  const walk = (start: number, first: number): void => {
    const path = [start];
    let previous = start;
    let current = first;

    for (;;) {
      usedEdges.add(edgeKey(previous, current));
      path.push(current);

      if (degree[current] !== 2) break;
      if (current === start) break;

      const options = neighboursOf(current).filter(
        (candidate) => !usedEdges.has(edgeKey(current, candidate))
      );
      if (options.length === 0) break;

      previous = current;
      current = options[0];
    }

    branches.push(makeBranch(path, degree, width));
  };

  // Nodes first, so leftover edges are guaranteed to be node-free loops.
  for (let index = 0; index < total; index++) {
    if (!pixels[index] || degree[index] === 2) continue;

    if (degree[index] === 0) {
      // An isolated pixel: a dot. Worth keeping as a degenerate branch so a
      // dotted line does not silently lose its dots.
      branches.push(makeBranch([index], degree, width));
      continue;
    }

    for (const neighbour of neighboursOf(index)) {
      if (usedEdges.has(edgeKey(index, neighbour))) continue;
      walk(index, neighbour);
    }
  }

  // Closed loops with no nodes.
  for (let index = 0; index < total; index++) {
    if (!pixels[index] || degree[index] !== 2) continue;
    const options = neighboursOf(index).filter(
      (candidate) => !usedEdges.has(edgeKey(index, candidate))
    );
    if (options.length === 0) continue;
    walk(index, options[0]);
  }

  return branches;
}

function makeBranch(path: number[], degree: Uint8Array, width: number): Branch {
  const points: Point[] = path.map((index) => {
    const x = index % width;
    // Pixel centres, so a centreline through a 1px-wide run lands on the middle
    // of that run rather than on its top-left corner.
    return { x: x + 0.5, y: (index - x) / width + 0.5 };
  });

  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  const closed = path.length > 2 && path[0] === path[path.length - 1];

  return {
    points,
    closed,
    startDegree: degree[path[0]] ?? 0,
    endDegree: degree[path[path.length - 1]] ?? 0,
    length,
  };
}

/**
 * Drop short branches that dangle from a junction.
 *
 * These are medial-axis artifacts: a corner or a bulge in a stroke sprouts a stub
 * pointing into it. The threshold is expressed in stroke widths because that is
 * the scale the artifacts occur at — a spur is roughly as long as the stroke is
 * wide. Branches with a free end at *both* ends are never dropped, however short,
 * since that is a whole short stroke rather than a stub on a longer one.
 */
export function pruneSpurs(branches: Branch[], strokeWidth: number, factor = 1.6): Branch[] {
  const threshold = Math.max(1.5, strokeWidth * factor);

  return branches.filter((branch) => {
    if (branch.closed) return true;
    if (branch.length >= threshold) return true;

    const freeEnds = (branch.startDegree <= 1 ? 1 : 0) + (branch.endDegree <= 1 ? 1 : 0);
    // Exactly one free end plus one junction is a stub hanging off something else.
    return freeEnds !== 1;
  });
}
