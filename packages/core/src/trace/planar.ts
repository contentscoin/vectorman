import type { Point } from '../types.js';
import { shoelace } from '../geom/segments.js';

/**
 * Planar crack-edge tracing.
 *
 * ## Why not trace each color independently
 *
 * The obvious design is: for each color, build a mask, trace its outline, smooth
 * it, emit a path. It produces correct-looking output and it is what most tracers
 * do. It also has a defect that shows up the moment anyone zooms in or sends the
 * file to a cutter.
 *
 * Two adjacent color regions share a boundary. Traced independently, each side
 * simplifies and curve-fits that shared boundary *separately*. Simplification
 * anchors differ, so the fitted curves differ — by up to the simplification
 * epsilon, around a pixel. The two regions no longer meet: they leave a hairline
 * gap (which renders as a bright seam over white) or overlap (which double-prints
 * and confuses cut-path generation).
 *
 * ## What this does instead
 *
 * Treat the label map as a planar subdivision and work on its edges:
 *
 *  1. **Crack graph.** Every lattice edge separating two different regions is a
 *     graph edge. Vertices are lattice points.
 *  2. **Nodes.** Any vertex where more than two boundary edges meet is a junction
 *     where three or more regions touch. Those points are fixed.
 *  3. **Chains.** Maximal runs of edges between junctions. Each chain is the
 *     entire shared boundary between exactly one pair of regions.
 *  4. **Fit once.** Each chain is simplified and curve-fitted a single time.
 *  5. **Assemble.** Each region's outline is built by concatenating chains,
 *     reversing the ones traversed backwards.
 *
 * Both sides of every boundary therefore reference the *same* fitted curve, so
 * they agree exactly. No gaps, no overlaps, and every junction where three
 * regions meet stays a single shared point.
 *
 * A useful side effect: shared boundaries are fitted once instead of twice, so
 * this is also faster than independent tracing.
 */

/** Direction indices. 0=+x east, 1=+y south, 2=-x west, 3=-y north. */
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;

/**
 * A closed chain's walk begins partway along an edge, so the seam can end up with
 * a redundant vertex sitting in the middle of a straight run. Left in place it
 * becomes a zero-curvature artifact right where the curve should be smoothest.
 */
function collapseClosingVertices(points: Point[]): void {
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

  if (points.length >= 3) {
    const n = points.length;
    if (cross(points[n - 2], points[n - 1], points[0]) === 0) points.pop();
  }
  if (points.length >= 3) {
    const n = points.length;
    if (cross(points[n - 1], points[0], points[1]) === 0) points.shift();
  }
}

/** Region id meaning "no geometry here" (transparent, or outside the image). */
export const NO_REGION = -1;

export interface Chain {
  id: number;
  /**
   * Lattice polyline in canonical direction, with straight runs collapsed to their
   * endpoints. For an open chain these run from one junction to another and
   * include both. For a closed chain the final edge returns to `points[0]`, which
   * is not repeated.
   *
   * Collapsing here rather than downstream is important. Keeping a vertex per
   * pixel would make a 200px straight edge 200 points, and corner detection
   * measures direction over roughly 1.5px of arc — so vertices sitting a pixel
   * either side of a real corner would pick up part of its turn and be
   * misclassified as corners themselves, splitting one corner into three.
   */
  points: Point[];
  closed: boolean;
  /** Vertex count before straight runs were collapsed, i.e. the boundary length. */
  rawPointCount: number;
  /** The two regions this chain separates. Either may be NO_REGION. */
  regionA: number;
  regionB: number;
}

export interface ChainRef {
  chain: number;
  /** True when the region's outline traverses this chain against its canonical direction. */
  reversed: boolean;
}

export interface RegionLoop {
  chains: ChainRef[];
  /** Exact lattice area. Positive = outer contour, negative = hole. */
  signedArea: number;
  isHole: boolean;
  /**
   * The loop's exact lattice polygon, straight runs already collapsed.
   *
   * Retained as a guaranteed fallback. The normal path assembles a loop from fitted
   * chains, and if any one of those chains fails to produce geometry the whole loop —
   * and with it a region that has visible pixels — would be lost. This polygon is
   * always valid, so the caller can synthesize a contour instead of dropping artwork.
   */
  vertices: Point[];
}

export interface PlanarTrace {
  chains: Chain[];
  /** Boundary loops per region id, in no particular order. */
  loopsByRegion: Map<number, RegionLoop[]>;
}

export interface PlanarTraceOptions {
  regionIds: Int32Array;
  width: number;
  height: number;
  /** Inclusive pixel bounds per region: 4 entries (minX, minY, maxX, maxY) per id. */
  regionBounds: Int32Array;
  regionCount: number;
}

export function tracePlanar(options: PlanarTraceOptions): PlanarTrace {
  const graph = new CrackGraph(options.regionIds, options.width, options.height);
  const chains = graph.extractChains();
  const loopsByRegion = new Map<number, RegionLoop[]>();

  for (let region = 0; region < options.regionCount; region++) {
    const base = region * 4;
    const bounds = {
      minX: options.regionBounds[base],
      minY: options.regionBounds[base + 1],
      maxX: options.regionBounds[base + 2],
      maxY: options.regionBounds[base + 3],
    };
    if (bounds.maxX < bounds.minX) continue;

    const loops = graph.traceRegionLoops(region, bounds);
    if (loops.length > 0) loopsByRegion.set(region, loops);
  }

  return { chains, loopsByRegion };
}

class CrackGraph {
  private readonly width: number;
  private readonly height: number;
  private readonly regionIds: Int32Array;

  /** Number of horizontal edge slots; vertical edge ids are offset by this. */
  private readonly horizontalCount: number;
  private readonly edgeCount: number;

  /** Chain id per edge, -1 when unassigned. */
  private readonly edgeChain: Int32Array;
  /** 1 when the owning chain traverses this edge in its canonical direction. */
  private readonly edgeForward: Uint8Array;
  /**
   * Region id (offset by 1) of the last region whose outline traversed this edge.
   * Stamping avoids clearing a multi-megabyte array once per region.
   */
  private readonly edgeStamp: Int32Array;

  /** 1 when a vertex is a junction that chains must terminate at. */
  private readonly vertexIsNode: Uint8Array;

  private chains: Chain[] = [];

  constructor(regionIds: Int32Array, width: number, height: number) {
    this.regionIds = regionIds;
    this.width = width;
    this.height = height;

    this.horizontalCount = width * (height + 1);
    this.edgeCount = this.horizontalCount + (width + 1) * height;

    this.edgeChain = new Int32Array(this.edgeCount).fill(-1);
    this.edgeForward = new Uint8Array(this.edgeCount);
    this.edgeStamp = new Int32Array(this.edgeCount);
    this.vertexIsNode = new Uint8Array((width + 1) * (height + 1));

    this.markNodes();
  }

  /** Region at a cell, with everything outside the image treated as NO_REGION. */
  private regionAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return NO_REGION;
    return this.regionIds[y * this.width + x];
  }

  /** Horizontal edge from vertex (x,y) to (x+1,y). */
  private horizontalId(x: number, y: number): number {
    return y * this.width + x;
  }

  /** Vertical edge from vertex (x,y) to (x,y+1). */
  private verticalId(x: number, y: number): number {
    return this.horizontalCount + y * (this.width + 1) + x;
  }

  private horizontalExists(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y > this.height) return false;
    return this.regionAt(x, y - 1) !== this.regionAt(x, y);
  }

  private verticalExists(x: number, y: number): boolean {
    if (x < 0 || x > this.width || y < 0 || y >= this.height) return false;
    return this.regionAt(x - 1, y) !== this.regionAt(x, y);
  }

  private vertexId(x: number, y: number): number {
    return y * (this.width + 1) + x;
  }

  /**
   * Incident existing edges at a vertex, as (edgeId, otherX, otherY) triples
   * flattened into `out`. Returns the degree.
   */
  private incidentEdges(x: number, y: number, out: number[]): number {
    let count = 0;

    if (this.horizontalExists(x, y)) {
      out[count * 3] = this.horizontalId(x, y);
      out[count * 3 + 1] = x + 1;
      out[count * 3 + 2] = y;
      count++;
    }
    if (this.horizontalExists(x - 1, y)) {
      out[count * 3] = this.horizontalId(x - 1, y);
      out[count * 3 + 1] = x - 1;
      out[count * 3 + 2] = y;
      count++;
    }
    if (this.verticalExists(x, y)) {
      out[count * 3] = this.verticalId(x, y);
      out[count * 3 + 1] = x;
      out[count * 3 + 2] = y + 1;
      count++;
    }
    if (this.verticalExists(x, y - 1)) {
      out[count * 3] = this.verticalId(x, y - 1);
      out[count * 3 + 1] = x;
      out[count * 3 + 2] = y - 1;
      count++;
    }

    return count;
  }

  /**
   * A vertex is a node when its degree is anything other than two, or when its two
   * edges separate different pairs of regions.
   *
   * Degree 1 cannot occur on a closed subdivision, degree 3 and 4 mean three or
   * four regions meet. The region-pair check is a safety net: a chain must never
   * span a point where the identity of the regions on either side changes,
   * because then it would no longer be a single shared boundary.
   */
  private markNodes(): void {
    const incident: number[] = new Array(12);

    for (let y = 0; y <= this.height; y++) {
      for (let x = 0; x <= this.width; x++) {
        const degree = this.incidentEdges(x, y, incident);
        if (degree === 0) continue;

        if (degree !== 2) {
          this.vertexIsNode[this.vertexId(x, y)] = 1;
          continue;
        }

        const first = this.edgeRegions(incident[0]);
        const second = this.edgeRegions(incident[3]);
        const samePair =
          (first.a === second.a && first.b === second.b) ||
          (first.a === second.b && first.b === second.a);
        if (!samePair) this.vertexIsNode[this.vertexId(x, y)] = 1;
      }
    }
  }

  /** The two regions an edge separates, derived from its id. */
  private edgeRegions(edgeId: number): { a: number; b: number } {
    if (edgeId < this.horizontalCount) {
      const y = Math.floor(edgeId / this.width);
      const x = edgeId - y * this.width;
      return { a: this.regionAt(x, y - 1), b: this.regionAt(x, y) };
    }
    const local = edgeId - this.horizontalCount;
    const stride = this.width + 1;
    const y = Math.floor(local / stride);
    const x = local - y * stride;
    return { a: this.regionAt(x - 1, y), b: this.regionAt(x, y) };
  }

  /** Canonical start vertex of an edge. */
  private edgeStart(edgeId: number): { x: number; y: number } {
    if (edgeId < this.horizontalCount) {
      const y = Math.floor(edgeId / this.width);
      return { x: edgeId - y * this.width, y };
    }
    const local = edgeId - this.horizontalCount;
    const stride = this.width + 1;
    const y = Math.floor(local / stride);
    return { x: local - y * stride, y };
  }

  extractChains(): Chain[] {
    const incident: number[] = new Array(12);
    const visited = new Uint8Array(this.edgeCount);

    // Open chains first, seeded from every junction. Doing junctions before
    // cycles guarantees that any edge left over genuinely belongs to a loop with
    // no junction on it.
    for (let y = 0; y <= this.height; y++) {
      for (let x = 0; x <= this.width; x++) {
        if (!this.vertexIsNode[this.vertexId(x, y)]) continue;
        const degree = this.incidentEdges(x, y, incident);
        for (let i = 0; i < degree; i++) {
          const edgeId = incident[i * 3];
          if (visited[edgeId]) continue;
          this.walkChain(x, y, edgeId, visited);
        }
      }
    }

    // Remaining edges form closed loops of degree-2 vertices: a region entirely
    // surrounded by a single other region, such as a dot on a plain background.
    for (let y = 0; y <= this.height; y++) {
      for (let x = 0; x <= this.width; x++) {
        const degree = this.incidentEdges(x, y, incident);
        for (let i = 0; i < degree; i++) {
          const edgeId = incident[i * 3];
          if (visited[edgeId]) continue;
          this.walkChain(x, y, edgeId, visited);
        }
      }
    }

    return this.chains;
  }

  private walkChain(
    startX: number,
    startY: number,
    firstEdge: number,
    visited: Uint8Array
  ): void {
    const chainId = this.chains.length;
    const points: Point[] = [{ x: startX, y: startY }];
    const incident: number[] = new Array(12);

    let currentX = startX;
    let currentY = startY;
    let edgeId = firstEdge;
    let closed = false;
    let rawPointCount = 1;
    // Direction of the previous step, used to collapse straight runs on the fly.
    let lastDx = 0;
    let lastDy = 0;
    const regions = this.edgeRegions(firstEdge);

    for (;;) {
      visited[edgeId] = 1;
      this.edgeChain[edgeId] = chainId;

      const start = this.edgeStart(edgeId);
      const canonicalForward = start.x === currentX && start.y === currentY;
      this.edgeForward[edgeId] = canonicalForward ? 1 : 0;

      const next = this.otherEnd(edgeId, currentX, currentY);

      if (next.x === startX && next.y === startY) {
        closed = true;
        break;
      }

      rawPointCount++;
      const dx = next.x - currentX;
      const dy = next.y - currentY;
      if (dx === lastDx && dy === lastDy) {
        points[points.length - 1] = { x: next.x, y: next.y };
      } else {
        points.push({ x: next.x, y: next.y });
      }
      lastDx = dx;
      lastDy = dy;

      if (this.vertexIsNode[this.vertexId(next.x, next.y)]) break;

      const degree = this.incidentEdges(next.x, next.y, incident);
      let following = -1;
      for (let i = 0; i < degree; i++) {
        const candidate = incident[i * 3];
        if (candidate !== edgeId && !visited[candidate]) {
          following = candidate;
          break;
        }
      }
      if (following === -1) break;

      edgeId = following;
      currentX = next.x;
      currentY = next.y;
    }

    if (closed) collapseClosingVertices(points);

    this.chains.push({
      id: chainId,
      points,
      closed,
      rawPointCount,
      regionA: regions.a,
      regionB: regions.b,
    });
  }

  private otherEnd(edgeId: number, fromX: number, fromY: number): { x: number; y: number } {
    const start = this.edgeStart(edgeId);
    const isHorizontal = edgeId < this.horizontalCount;
    const endX = isHorizontal ? start.x + 1 : start.x;
    const endY = isHorizontal ? start.y : start.y + 1;

    if (start.x === fromX && start.y === fromY) return { x: endX, y: endY };
    return { x: start.x, y: start.y };
  }

  /**
   * Does a directed boundary edge leave this vertex in this direction for this
   * region?
   *
   * Directions are chosen so a lone pixel traverses top, right, bottom, left —
   * clockwise in y-down space, giving outer contours a positive area and holes a
   * negative one. Opposite windings let `fill-rule: nonzero` resolve holes with
   * no containment analysis.
   */
  private directedEdgeExists(vx: number, vy: number, dir: number, region: number): boolean {
    switch (dir) {
      case 0: // east: top edge of pixel (vx, vy)
        return this.regionAt(vx, vy) === region && this.regionAt(vx, vy - 1) !== region;
      case 1: // south: right edge of pixel (vx-1, vy)
        return this.regionAt(vx - 1, vy) === region && this.regionAt(vx, vy) !== region;
      case 2: // west: bottom edge of pixel (vx-1, vy-1)
        return this.regionAt(vx - 1, vy - 1) === region && this.regionAt(vx - 1, vy) !== region;
      default: // north: left edge of pixel (vx, vy-1)
        return this.regionAt(vx, vy - 1) === region && this.regionAt(vx - 1, vy - 1) !== region;
    }
  }

  private directedEdgeId(vx: number, vy: number, dir: number): { id: number; forward: boolean } {
    switch (dir) {
      case 0:
        return { id: this.horizontalId(vx, vy), forward: true };
      case 1:
        return { id: this.verticalId(vx, vy), forward: true };
      case 2:
        return { id: this.horizontalId(vx - 1, vy), forward: false };
      default:
        return { id: this.verticalId(vx, vy - 1), forward: false };
    }
  }

  traceRegionLoops(
    region: number,
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  ): RegionLoop[] {
    const loops: RegionLoop[] = [];
    const stamp = region + 1;

    const minX = Math.max(0, bounds.minX);
    const minY = Math.max(0, bounds.minY);
    const maxX = Math.min(this.width - 1, bounds.maxX);
    const maxY = Math.min(this.height - 1, bounds.maxY);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.regionAt(x, y) !== region) continue;

        // The four possible boundary sides of this pixel, as directed edges.
        if (this.regionAt(x, y - 1) !== region) {
          this.tryStartLoop(x, y, 0, region, stamp, loops);
        }
        if (this.regionAt(x + 1, y) !== region) {
          this.tryStartLoop(x + 1, y, 1, region, stamp, loops);
        }
        if (this.regionAt(x, y + 1) !== region) {
          this.tryStartLoop(x + 1, y + 1, 2, region, stamp, loops);
        }
        if (this.regionAt(x - 1, y) !== region) {
          this.tryStartLoop(x, y + 1, 3, region, stamp, loops);
        }
      }
    }

    return loops;
  }

  private tryStartLoop(
    vx: number,
    vy: number,
    dir: number,
    region: number,
    stamp: number,
    loops: RegionLoop[]
  ): void {
    const { id } = this.directedEdgeId(vx, vy, dir);
    if (this.edgeStamp[id] === stamp) return;

    const loop = this.walkRegionLoop(vx, vy, dir, region, stamp);
    if (loop) loops.push(loop);
  }

  private walkRegionLoop(
    startX: number,
    startY: number,
    startDir: number,
    region: number,
    stamp: number
  ): RegionLoop | null {
    const vertices: Point[] = [];
    const refs: ChainRef[] = [];

    let vx = startX;
    let vy = startY;
    let dir = startDir;
    let previousDir = -1;
    let steps = 0;
    const maxSteps = this.edgeCount + 8;

    for (;;) {
      if (++steps > maxSteps) return null;

      // Record the vertex, collapsing straight runs as we go.
      if (dir !== previousDir) {
        vertices.push({ x: vx, y: vy });
      } else {
        vertices[vertices.length - 1] = { x: vx, y: vy };
      }

      const { id, forward } = this.directedEdgeId(vx, vy, dir);
      this.edgeStamp[id] = stamp;

      const chainId = this.edgeChain[id];
      if (chainId >= 0) {
        const last = refs[refs.length - 1];
        if (!last || last.chain !== chainId) {
          // Each chain is traversed contiguously and at most once per loop,
          // because its interior vertices have degree two and both its sides
          // keep the same region identity throughout.
          refs.push({ chain: chainId, reversed: forward !== (this.edgeForward[id] === 1) });
        }
      }

      vx += DX[dir];
      vy += DY[dir];
      previousDir = dir;

      // Sharpest clockwise turn first. This is what keeps the walk hugging the
      // region it entered on at a vertex where the region touches itself
      // diagonally, instead of fusing an outline and its hole into one
      // self-crossing loop.
      const right = (dir + 1) & 3;
      const straight = dir;
      const left = (dir + 3) & 3;

      let next = -1;
      if (this.directedEdgeExists(vx, vy, right, region)) next = right;
      else if (this.directedEdgeExists(vx, vy, straight, region)) next = straight;
      else if (this.directedEdgeExists(vx, vy, left, region)) next = left;

      if (next === -1) break;
      if (vx === startX && vy === startY && next === startDir) break;

      dir = next;
    }

    if (vertices.length < 3 || refs.length === 0) return null;

    // The walk can begin partway along a chain, in which case that chain's edges
    // appear at both ends of the traversal. Dropping the duplicate leaves the
    // loop starting at that chain's canonical start instead — the same closed
    // loop, rotated, which is all that matters once geometry comes from chains.
    if (refs.length > 1 && refs[0].chain === refs[refs.length - 1].chain) {
      refs.pop();
    }

    const signedArea = shoelace(vertices);
    if (Math.abs(signedArea) < 0.5) return null;

    return { chains: refs, signedArea, isHole: signedArea < 0, vertices };
  }
}
