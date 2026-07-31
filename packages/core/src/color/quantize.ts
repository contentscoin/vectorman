import type { Lab, RGB } from '../types.js';
import { deltaE2000, rgbToLab } from './space.js';

/**
 * Palette reduction.
 *
 * Two strategies, chosen automatically:
 *
 *  1. **Exact palette** — for logos, flat illustrations and AI art prompted flat.
 *     These images already have a small set of intentional colors, surrounded by a
 *     halo of anti-aliasing blends. We keep the intentional colors *bit-exact* and
 *     snap the halo to its nearest neighbour. This is why a brand hex survives the
 *     round trip instead of drifting a few points, which is the single most common
 *     complaint about generic tracers.
 *
 *  2. **Weighted k-means in Lab** — for everything else. Clustering runs over a
 *     5-bit-per-channel histogram rather than raw pixels, so cost scales with the
 *     number of *distinct* colors, not with resolution.
 */

export interface QuantizeOptions {
  maxColors: number;
  alphaThreshold: number;
  /** CIEDE2000 distance below which two palette entries are considered duplicates. */
  mergeThreshold: number;
  seed: number;
  /** Skip detection and use exactly this palette. */
  forcedPalette?: RGB[] | null;
}

export interface QuantizeResult {
  palette: RGB[];
  /** One entry per pixel: palette index, or -1 for transparent. */
  labels: Int16Array;
  /** Pixel count per palette entry. */
  counts: number[];
  /** True when the original colors were preserved bit-exactly. */
  exact: boolean;
}

/**
 * Margin by which one candidate must beat another to win a nearest-colour contest.
 *
 * This exists to make the engine's output reproducible, and it is not a
 * micro-optimisation — without it, tracing the same JPEG twice occasionally produced
 * a different number of colour layers.
 *
 * The cause is that V8 evaluates `Math.cbrt` and `Math.pow` slightly differently
 * depending on which optimisation tier a function has reached, and a function's tier
 * depends on how many times it has run. In a worker pool that varies per thread, so
 * the *same* pixels can yield Lab values differing in the last bit. A strict `<`
 * comparison then hands a near-tied pixel to a different cluster, and if that empties
 * a cluster it gets pruned and a whole layer disappears.
 *
 * Requiring a later candidate to win by this margin makes ties resolve to the lowest
 * index instead. The value sits far above last-bit noise on squared Lab distances
 * (which reach ~10^4, where one ULP is around 2e-12) and far below any difference
 * between colours a person could distinguish, so it changes no real decision.
 */
const TIE_BREAK_EPSILON = 1e-9;

/** Above this many distinct colors we stop hoping for a flat-art fast path. */
const EXACT_SCAN_LIMIT = 8192;

/** Fraction of opaque pixels the top-N exact colors must cover to take the fast path. */
const EXACT_COVERAGE_TARGET = 0.9;

export function quantize(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: QuantizeOptions
): QuantizeResult {
  const pixelCount = width * height;
  const labels = new Int16Array(pixelCount).fill(-1);

  const opaque = collectOpaqueMask(rgba, pixelCount, options.alphaThreshold);
  if (opaque.count === 0) {
    return { palette: [], labels, counts: [], exact: true };
  }

  if (options.forcedPalette && options.forcedPalette.length > 0) {
    const palette = options.forcedPalette.slice(0, 4096);
    const counts = assignLabels(rgba, pixelCount, opaque.mask, palette, labels);
    return { palette, labels, counts, exact: false };
  }

  const exactHistogram = buildExactHistogram(rgba, pixelCount, opaque.mask);

  if (exactHistogram) {
    const chosen = chooseExactPalette(exactHistogram, opaque.count, options);
    if (chosen) {
      const counts = assignLabels(rgba, pixelCount, opaque.mask, chosen, labels);
      const pruned = pruneEmpty(chosen, counts, labels, pixelCount);
      return { palette: pruned.palette, labels, counts: pruned.counts, exact: true };
    }
  }

  const palette = kmeansPalette(rgba, pixelCount, opaque.mask, options);
  const merged = mergeSimilar(palette.colors, palette.weights, options.mergeThreshold);
  const counts = assignLabels(rgba, pixelCount, opaque.mask, merged, labels);
  const pruned = pruneEmpty(merged, counts, labels, pixelCount);

  return { palette: pruned.palette, labels, counts: pruned.counts, exact: false };
}

function collectOpaqueMask(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  alphaThreshold: number
): { mask: Uint8Array; count: number } {
  const mask = new Uint8Array(pixelCount);
  let count = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (rgba[i * 4 + 3] >= alphaThreshold) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

interface ExactEntry {
  rgb: RGB;
  lab: Lab;
  count: number;
}

/**
 * Exact color histogram, or `null` if the image has too many distinct colors to
 * be flat art (photographs blow past the limit within a few thousand pixels).
 */
function buildExactHistogram(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  mask: Uint8Array
): ExactEntry[] | null {
  const map = new Map<number, number>();
  for (let i = 0; i < pixelCount; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    map.set(key, (map.get(key) ?? 0) + 1);
    if (map.size > EXACT_SCAN_LIMIT) return null;
  }

  const entries: ExactEntry[] = [];
  for (const [key, count] of map) {
    const rgb = { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff };
    entries.push({ rgb, lab: rgbToLab(rgb), count });
  }
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

/** Max distance from the line between two palette colors for a color to be a blend of them. */
const BLEND_DISTANCE = 5;

/** A blend candidate must also be this small a share of the image to be rejected. */
const BLEND_MAX_AREA_SHARE = 0.02;

/**
 * Is this color an anti-aliasing blend of two colors already chosen?
 *
 * An anti-aliased edge pixel is a linear mix of the two colors it sits between, so
 * in Lab it lands on the line segment joining them. That single test is not enough
 * on its own, because a deliberate mid-tone in a three-tone ramp also lies between
 * its neighbours — so area is required as well. A blend occupies a one-pixel border,
 * which is a tiny fraction of the artwork; an intentional mid-tone fills real space.
 *
 * Without this check, a flat illustration with four colors comes back with seven:
 * the extra three are the blends along its internal edges, each promoted to a
 * full layer that a designer then has to find and merge by hand.
 */
function isBlendOfPicked(entry: ExactEntry, picked: ExactEntry[], opaqueCount: number): boolean {
  if (entry.count / opaqueCount > BLEND_MAX_AREA_SHARE) return false;

  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      if (distanceToSegment(entry.lab, picked[i].lab, picked[j].lab) < BLEND_DISTANCE) {
        return true;
      }
    }
  }

  return false;
}

/** Euclidean distance in Lab from a point to the segment ab. */
function distanceToSegment(p: Lab, a: Lab, b: Lab): number {
  const abL = b.L - a.L;
  const abA = b.a - a.a;
  const abB = b.b - a.b;
  const lengthSquared = abL * abL + abA * abA + abB * abB;

  if (lengthSquared < 1e-9) {
    return Math.hypot(p.L - a.L, p.a - a.a, p.b - a.b);
  }

  let t = ((p.L - a.L) * abL + (p.a - a.a) * abA + (p.b - a.b) * abB) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(p.L - (a.L + abL * t), p.a - (a.a + abA * t), p.b - (a.b + abB * t));
}

/**
 * Pick dominant exact colors, in descending frequency, skipping any that are
 * perceptually indistinguishable from an already-chosen one, and any that are
 * anti-aliasing blends of two already-chosen colors. Returns `null` if the result
 * would not cover enough of the image, meaning the picture has real tonal
 * variation and deserves k-means instead.
 */
function chooseExactPalette(
  entries: ExactEntry[],
  opaqueCount: number,
  options: QuantizeOptions
): RGB[] | null {
  const picked: ExactEntry[] = [];
  let covered = 0;

  for (const entry of entries) {
    if (picked.length >= options.maxColors) break;

    let duplicate = false;
    for (const p of picked) {
      if (deltaE2000(p.lab, entry.lab) < options.mergeThreshold) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    // Frequency-descending order means the colors a blend sits between have
    // already been picked by the time the blend itself comes up.
    if (picked.length >= 2 && isBlendOfPicked(entry, picked, opaqueCount)) continue;

    picked.push(entry);
    covered += entry.count;
  }

  if (picked.length === 0) return null;

  // Coverage counts only the pixels that landed on a picked color exactly. The
  // remainder are anti-aliasing blends, which snap to a neighbour later. If the
  // remainder is large, these are not blends but genuine image content.
  if (covered / opaqueCount < EXACT_COVERAGE_TARGET && entries.length > options.maxColors * 6) {
    return null;
  }

  return picked.map((p) => p.rgb);
}

interface HistogramBin {
  /** Summed Lab, divided by count on use. */
  L: number;
  a: number;
  b: number;
  r: number;
  g: number;
  bl: number;
  count: number;
}

/** 5 bits per channel: a good accuracy/size tradeoff for clustering input. */
function buildCoarseHistogram(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  mask: Uint8Array
): HistogramBin[] {
  const bins = new Map<number, HistogramBin>();
  for (let i = 0; i < pixelCount; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

    let bin = bins.get(key);
    if (!bin) {
      bin = { L: 0, a: 0, b: 0, r: 0, g: 0, bl: 0, count: 0 };
      bins.set(key, bin);
    }
    const lab = rgbToLab({ r, g, b });
    bin.L += lab.L;
    bin.a += lab.a;
    bin.b += lab.b;
    bin.r += r;
    bin.g += g;
    bin.bl += b;
    bin.count++;
  }
  return [...bins.values()];
}

function kmeansPalette(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  mask: Uint8Array,
  options: QuantizeOptions
): { colors: RGB[]; weights: number[] } {
  const bins = buildCoarseHistogram(rgba, pixelCount, mask);
  const n = bins.length;
  const k = Math.max(1, Math.min(options.maxColors, n));

  // Per-bin mean Lab and weight.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const bin = bins[i];
    px[i] = bin.L / bin.count;
    py[i] = bin.a / bin.count;
    pz[i] = bin.b / bin.count;
    w[i] = bin.count;
  }

  const cx = new Float64Array(k);
  const cy = new Float64Array(k);
  const cz = new Float64Array(k);

  seedKmeansPlusPlus(px, py, pz, w, n, k, options.seed, cx, cy, cz);

  const assignment = new Int32Array(n).fill(-1);
  const sumX = new Float64Array(k);
  const sumY = new Float64Array(k);
  const sumZ = new Float64Array(k);
  const sumW = new Float64Array(k);

  const MAX_ITERATIONS = 40;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = 0;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dL = px[i] - cx[c];
        const da = py[i] - cy[c];
        const db = pz[i] - cz[c];
        const d = dL * dL + da * da + db * db;
        // A later centroid must be better by more than float noise to win, which
        // makes ties resolve to the lowest index instead of to whatever the last
        // bit happened to be. See TIE_BREAK_EPSILON.
        if (d < bestDist - TIE_BREAK_EPSILON) {
          bestDist = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved++;
      }
    }

    sumX.fill(0);
    sumY.fill(0);
    sumZ.fill(0);
    sumW.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignment[i];
      const weight = w[i];
      sumX[c] += px[i] * weight;
      sumY[c] += py[i] * weight;
      sumZ[c] += pz[i] * weight;
      sumW[c] += weight;
    }
    for (let c = 0; c < k; c++) {
      if (sumW[c] > 0) {
        cx[c] = sumX[c] / sumW[c];
        cy[c] = sumY[c] / sumW[c];
        cz[c] = sumZ[c] / sumW[c];
      }
    }

    if (moved === 0) break;
  }

  // Represent each cluster with the mean of its *source RGB*, weighted by pixel
  // count. Averaging in sRGB here (rather than converting the Lab centroid back)
  // keeps the palette closer to colors actually present in the image.
  const rAcc = new Float64Array(k);
  const gAcc = new Float64Array(k);
  const bAcc = new Float64Array(k);
  const wAcc = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const c = assignment[i];
    const bin = bins[i];
    rAcc[c] += bin.r;
    gAcc[c] += bin.g;
    bAcc[c] += bin.bl;
    wAcc[c] += bin.count;
  }

  const colors: RGB[] = [];
  const weights: number[] = [];
  for (let c = 0; c < k; c++) {
    if (wAcc[c] <= 0) continue;
    colors.push({
      r: Math.round(rAcc[c] / wAcc[c]),
      g: Math.round(gAcc[c] / wAcc[c]),
      b: Math.round(bAcc[c] / wAcc[c]),
    });
    weights.push(wAcc[c]);
  }

  return { colors, weights };
}

/** k-means++ seeding, weighted by bin population, with a deterministic RNG. */
function seedKmeansPlusPlus(
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  w: Float64Array,
  n: number,
  k: number,
  seed: number,
  cx: Float64Array,
  cy: Float64Array,
  cz: Float64Array
): void {
  const rand = mulberry32(seed);

  // First center: the heaviest bin, so results are stable and start from the
  // dominant color rather than an arbitrary one.
  let heaviest = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[heaviest]) heaviest = i;
  cx[0] = px[heaviest];
  cy[0] = py[heaviest];
  cz[0] = pz[heaviest];

  const dist = new Float64Array(n).fill(Infinity);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dL = px[i] - cx[c - 1];
      const da = py[i] - cy[c - 1];
      const db = pz[i] - cz[c - 1];
      const d = dL * dL + da * da + db * db;
      if (d < dist[i]) dist[i] = d;
      total += dist[i] * w[i];
    }

    if (total <= 0) {
      // Degenerate: fewer distinct colors than requested clusters.
      cx[c] = px[c % n];
      cy[c] = py[c % n];
      cz[c] = pz[c % n];
      continue;
    }

    let target = rand() * total;
    let picked = n - 1;
    for (let i = 0; i < n; i++) {
      target -= dist[i] * w[i];
      if (target <= 0) {
        picked = i;
        break;
      }
    }
    cx[c] = px[picked];
    cy[c] = py[picked];
    cz[c] = pz[picked];
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Collapse palette entries within `threshold` deltaE of each other, keeping the
 * heavier entry's exact value. Repeated until stable, since merging can bring
 * new pairs within range.
 */
function mergeSimilar(colors: RGB[], weights: number[], threshold: number): RGB[] {
  if (threshold <= 0 || colors.length < 2) return colors;

  let current = colors.map((rgb, i) => ({ rgb, lab: rgbToLab(rgb), weight: weights[i] ?? 1 }));

  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    current.sort((a, b) => b.weight - a.weight);

    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        // deltaE2000 uses Math.pow and Math.exp, so a pair sitting exactly on the
        // threshold could otherwise merge or not depending on JIT tier.
        if (deltaE2000(current[i].lab, current[j].lab) < threshold - TIE_BREAK_EPSILON) {
          current[i].weight += current[j].weight;
          current.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }

  return current.map((c) => c.rgb);
}

/**
 * Nearest-palette assignment for every opaque pixel, memoized on a 15-bit color
 * key. Real images reuse colors heavily, so the cache turns a per-pixel palette
 * scan into a single array lookup for the vast majority of pixels.
 */
function assignLabels(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  mask: Uint8Array,
  palette: RGB[],
  labels: Int16Array
): number[] {
  const counts = new Array<number>(palette.length).fill(0);
  if (palette.length === 0) return counts;

  const paletteLab = palette.map(rgbToLab);
  const pL = new Float64Array(paletteLab.length);
  const pa = new Float64Array(paletteLab.length);
  const pb = new Float64Array(paletteLab.length);
  for (let i = 0; i < paletteLab.length; i++) {
    pL[i] = paletteLab[i].L;
    pa[i] = paletteLab[i].a;
    pb[i] = paletteLab[i].b;
  }

  // Exact-color shortcut so bit-identical pixels never go through Lab at all.
  const exactMap = new Map<number, number>();
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    exactMap.set((p.r << 16) | (p.g << 8) | p.b, i);
  }

  const cache = new Int16Array(32768).fill(-2);

  for (let i = 0; i < pixelCount; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];

    const exact = exactMap.get((r << 16) | (g << 8) | b);
    if (exact !== undefined) {
      labels[i] = exact;
      counts[exact]++;
      continue;
    }

    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx === -2) {
      const lab = rgbToLab({ r, g, b });
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < pL.length; c++) {
        const dL = lab.L - pL[c];
        const da = lab.a - pa[c];
        const db = lab.b - pb[c];
        const d = dL * dL + da * da + db * db;
        // Lowest palette index wins a tie, for the same reproducibility reason.
        if (d < bestDist - TIE_BREAK_EPSILON) {
          bestDist = d;
          best = c;
        }
      }
      idx = best;
      cache[key] = best;
    }
    labels[i] = idx;
    counts[idx]++;
  }

  return counts;
}

/** Remove palette entries that ended up with no pixels and reindex labels. */
function pruneEmpty(
  palette: RGB[],
  counts: number[],
  labels: Int16Array,
  pixelCount: number
): { palette: RGB[]; counts: number[] } {
  if (!counts.some((c) => c === 0)) return { palette, counts };

  const remap = new Int16Array(palette.length).fill(-1);
  const nextPalette: RGB[] = [];
  const nextCounts: number[] = [];

  for (let i = 0; i < palette.length; i++) {
    if (counts[i] > 0) {
      remap[i] = nextPalette.length;
      nextPalette.push(palette[i]);
      nextCounts.push(counts[i]);
    }
  }

  for (let i = 0; i < pixelCount; i++) {
    const l = labels[i];
    if (l >= 0) labels[i] = remap[l];
  }

  return { palette: nextPalette, counts: nextCounts };
}
