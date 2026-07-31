import { deltaE2000, describeColor, hexToRgb, rgbToHex, rgbToLab, uniquifyNames } from '../color/space.js';
import { vectorize } from '../pipeline.js';
import type {
  ColorLayer,
  RGB,
  RasterImage,
  VectorizeOptions,
  VectorizeResult,
} from '../types.js';

/**
 * Palette editing.
 *
 * Two ways to merge colors, because they serve different moments:
 *
 *  - `mergeLayersFast` recolours in place. Instant, so it drives the interactive
 *    preview while someone drags swatches together. Adjacent same-color regions
 *    render as a clean union (identical winding plus `fill-rule: nonzero`), but
 *    the now-internal boundary between them is still in the file, so the node
 *    count does not improve.
 *
 *  - `remergeWithPalette` re-runs the pipeline with the merged palette. The merge
 *    then happens on the *label map*, so the regions become genuinely one region,
 *    the boundary between them is never traced, and the node count actually
 *    drops. This is what should run on export.
 *
 * That split is deliberate: the cheap path keeps the UI responsive, the exact
 * path produces the file you ship.
 */

export interface ColorMergeGroup {
  /** Hex color that survives the merge. */
  keep: string;
  /** Hex colors folded into `keep`. */
  absorb: string[];
}

export interface ColorEditPlan {
  groups?: ColorMergeGroup[];
  /** Hex colors to delete outright. Their area becomes transparent. */
  remove?: string[];
}

/** Instant, geometry-preserving merge. Use for previews. */
export function mergeLayersFast(result: VectorizeResult, plan: ColorEditPlan): VectorizeResult {
  const removeSet = new Set((plan.remove ?? []).map(normalizeHex));
  const absorbToKeep = new Map<string, string>();

  for (const group of plan.groups ?? []) {
    const keep = normalizeHex(group.keep);
    for (const hex of group.absorb) {
      absorbToKeep.set(normalizeHex(hex), keep);
    }
  }

  const byHex = new Map<string, ColorLayer>();
  const order: string[] = [];

  for (const layer of result.layers) {
    const hex = normalizeHex(layer.hex);
    if (removeSet.has(hex)) continue;

    const targetHex = absorbToKeep.get(hex) ?? hex;
    if (removeSet.has(targetHex)) continue;

    const existing = byHex.get(targetHex);
    if (existing) {
      existing.shapes.push(...layer.shapes);
      existing.strokes.push(...layer.strokes);
      existing.pixelCount += layer.pixelCount;
      continue;
    }

    // The surviving color's own RGB is used, not an average, so a brand hex that
    // absorbs its anti-aliasing neighbours stays exactly itself.
    const color = safeHexToRgb(targetHex) ?? layer.color;
    byHex.set(targetHex, {
      index: 0,
      color,
      hex: targetHex,
      name: describeColor(color),
      shapes: [...layer.shapes],
      strokes: [...layer.strokes],
      pixelCount: layer.pixelCount,
    });
    order.push(targetHex);
  }

  const layers = order
    .map((hex) => byHex.get(hex)!)
    .sort((a, b) => b.pixelCount - a.pixelCount);

  const names = uniquifyNames(layers.map((l) => describeColor(l.color)));
  layers.forEach((layer, index) => {
    layer.index = index;
    layer.name = names[index];
    layer.shapes.sort((a, b) => b.pixelCount - a.pixelCount);
  });

  return {
    ...result,
    layers,
    palette: layers.map((l) => l.color),
    stats: recountStats(result.stats, layers),
  };
}

/** Recompute the counts that palette edits can change. */
function recountStats(
  stats: VectorizeResult['stats'],
  layers: ColorLayer[]
): VectorizeResult['stats'] {
  return {
    ...stats,
    colors: layers.length,
    pieces: layers.reduce((sum, l) => sum + l.shapes.length, 0),
    strokes: layers.reduce((sum, l) => sum + l.strokes.length, 0),
    nodes: layers.reduce(
      (sum, layer) =>
        sum +
        layer.shapes.reduce(
          (shapeSum, shape) =>
            shapeSum + shape.contours.reduce((c, contour) => c + contour.segments.length, 0),
          0
        ) +
        layer.strokes.reduce((strokeSum, stroke) => strokeSum + stroke.segments.length, 0),
      0
    ),
  };
}

/**
 * Re-run the pipeline with the merged palette forced, so merged colors become one
 * region and their shared boundary is never traced. Removals are applied to the
 * result afterwards, since a dropped color must become transparency rather than
 * be reassigned to a neighbour.
 */
export function remergeWithPalette(
  image: RasterImage,
  baseOptions: VectorizeOptions,
  previous: VectorizeResult,
  plan: ColorEditPlan
): VectorizeResult {
  const removeSet = new Set((plan.remove ?? []).map(normalizeHex));
  const absorbToKeep = new Map<string, string>();
  for (const group of plan.groups ?? []) {
    const keep = normalizeHex(group.keep);
    for (const hex of group.absorb) absorbToKeep.set(normalizeHex(hex), keep);
  }

  const forced: RGB[] = [];
  const seen = new Set<string>();
  for (const layer of previous.layers) {
    const hex = normalizeHex(layer.hex);
    const targetHex = absorbToKeep.get(hex) ?? hex;
    if (seen.has(targetHex)) continue;
    seen.add(targetHex);
    const rgb = safeHexToRgb(targetHex);
    if (rgb) forced.push(rgb);
  }

  if (forced.length === 0) return previous;

  const result = vectorize(image, { ...baseOptions, palette: forced });
  if (removeSet.size === 0) return result;
  return removeLayers(result, [...removeSet]);
}

/** Delete color layers outright. Their area becomes transparent. */
export function removeLayers(result: VectorizeResult, hexes: string[]): VectorizeResult {
  const removeSet = new Set(hexes.map(normalizeHex));
  const layers = result.layers
    .filter((layer) => !removeSet.has(normalizeHex(layer.hex)))
    .map((layer, index) => ({ ...layer, index }));

  return {
    ...result,
    layers,
    palette: layers.map((l) => l.color),
    stats: recountStats(result.stats, layers),
  };
}

export interface SuggestedMerge {
  keep: string;
  absorb: string;
  deltaE: number;
  /** Share of total artwork area the absorbed layer occupies, 0-1. */
  absorbedAreaShare: number;
}

/**
 * Propose merges for near-duplicate colors.
 *
 * Ranked by perceptual distance, and the smaller layer is always the one that
 * gets absorbed so the dominant color keeps its exact value. Only pairs under
 * `threshold` are offered, which at the default of 8 catches anti-aliasing
 * residue and compression artifacts without touching colors a designer chose.
 */
export function suggestMerges(result: VectorizeResult, threshold = 8): SuggestedMerge[] {
  const totalArea = result.layers.reduce((sum, l) => sum + l.pixelCount, 0) || 1;
  const labs = result.layers.map((l) => rgbToLab(l.color));
  const suggestions: SuggestedMerge[] = [];

  for (let i = 0; i < result.layers.length; i++) {
    for (let j = i + 1; j < result.layers.length; j++) {
      const distance = deltaE2000(labs[i], labs[j]);
      if (distance >= threshold) continue;

      const a = result.layers[i];
      const b = result.layers[j];
      const [keep, absorb] = a.pixelCount >= b.pixelCount ? [a, b] : [b, a];

      suggestions.push({
        keep: keep.hex,
        absorb: absorb.hex,
        deltaE: Math.round(distance * 100) / 100,
        absorbedAreaShare: Math.round((absorb.pixelCount / totalArea) * 10000) / 10000,
      });
    }
  }

  return suggestions.sort((a, b) => a.deltaE - b.deltaE);
}

/** Turn a flat list of suggestions into merge groups, resolving chains transitively. */
export function suggestionsToPlan(suggestions: SuggestedMerge[]): ColorEditPlan {
  // Union-find over hex values so A->B and B->C collapse into a single group.
  const parent = new Map<string, string>();

  const find = (hex: string): string => {
    let current = normalizeHex(hex);
    while (parent.has(current) && parent.get(current) !== current) {
      current = parent.get(current) as string;
    }
    return current;
  };

  for (const suggestion of suggestions) {
    const keep = normalizeHex(suggestion.keep);
    const absorb = normalizeHex(suggestion.absorb);
    if (!parent.has(keep)) parent.set(keep, keep);
    if (!parent.has(absorb)) parent.set(absorb, absorb);
    const rootKeep = find(keep);
    const rootAbsorb = find(absorb);
    if (rootKeep !== rootAbsorb) parent.set(rootAbsorb, rootKeep);
  }

  const grouped = new Map<string, string[]>();
  for (const hex of parent.keys()) {
    const root = find(hex);
    if (root === hex) continue;
    const list = grouped.get(root) ?? [];
    list.push(hex);
    grouped.set(root, list);
  }

  return {
    groups: [...grouped.entries()].map(([keep, absorb]) => ({ keep, absorb })),
  };
}

function normalizeHex(hex: string): string {
  try {
    return rgbToHex(hexToRgb(hex));
  } catch {
    return hex.trim().toLowerCase();
  }
}

function safeHexToRgb(hex: string): RGB | null {
  try {
    return hexToRgb(hex);
  } catch {
    return null;
  }
}
