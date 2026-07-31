/**
 * Label-map cleanup.
 *
 * After quantization every pixel holds a palette index (or -1 for transparent).
 * That map decides the final geometry exactly, so cleaning it is far cheaper and
 * more reliable than trying to repair thousands of paths afterwards.
 *
 * Connectivity note: regions are 4-connected throughout. 8-connectivity would
 * make diagonally-touching pixels one region, which creates a boundary that
 * crosses itself at the touch point and cannot be expressed as a simple closed
 * contour. With 4-connectivity every region has an unambiguous crack boundary.
 */

/** Sentinel label for "no geometry here". */
export const TRANSPARENT = -1;

export interface ComponentMap {
  /** Component id per pixel. */
  ids: Int32Array;
  /** Pixel count per component. */
  areas: Int32Array;
  /** Palette label per component. */
  labels: Int16Array;
  /** Tight pixel bounds per component, 4 entries each: minX, minY, maxX, maxY (inclusive). */
  bounds: Int32Array;
  count: number;
}

/** Flood-fill every 4-connected run of equal labels into its own component. */
export function findComponents(
  labels: Int16Array,
  width: number,
  height: number
): ComponentMap {
  const total = width * height;
  const ids = new Int32Array(total).fill(-1);
  const areas: number[] = [];
  const componentLabels: number[] = [];
  const bounds: number[] = [];

  // Explicit stack; recursion overflows on large flat regions.
  const stack = new Int32Array(total);

  for (let seed = 0; seed < total; seed++) {
    if (ids[seed] !== -1) continue;

    const label = labels[seed];
    const id = areas.length;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sp = 0;
    stack[sp++] = seed;
    ids[seed] = id;

    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const q = p - 1;
        if (ids[q] === -1 && labels[q] === label) {
          ids[q] = id;
          stack[sp++] = q;
        }
      }
      if (x + 1 < width) {
        const q = p + 1;
        if (ids[q] === -1 && labels[q] === label) {
          ids[q] = id;
          stack[sp++] = q;
        }
      }
      if (y > 0) {
        const q = p - width;
        if (ids[q] === -1 && labels[q] === label) {
          ids[q] = id;
          stack[sp++] = q;
        }
      }
      if (y + 1 < height) {
        const q = p + width;
        if (ids[q] === -1 && labels[q] === label) {
          ids[q] = id;
          stack[sp++] = q;
        }
      }
    }

    areas.push(area);
    componentLabels.push(label);
    bounds.push(minX, minY, maxX, maxY);
  }

  return {
    ids,
    areas: Int32Array.from(areas),
    labels: Int16Array.from(componentLabels),
    bounds: Int32Array.from(bounds),
    count: areas.length,
  };
}

/**
 * Dissolve regions below `minArea` into whichever neighbour shares the longest
 * border with them.
 *
 * Choosing by shared border length rather than by nearest color is deliberate:
 * a speck sitting on an edge between two colors should join the region it is
 * actually embedded in, otherwise it stays visible as a color-shifted notch.
 *
 * Runs repeatedly because dissolving one speck can expose another, and stops
 * early once a pass changes nothing.
 */
export function despeckle(
  labels: Int16Array,
  width: number,
  height: number,
  minArea: number,
  maxPasses = 4
): number {
  if (minArea <= 1) return 0;

  let dissolved = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const components = findComponents(labels, width, height);
    let changedThisPass = 0;

    // Border length per (component, neighbour label) pair.
    const neighbourBorders = new Map<number, Map<number, number>>();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const id = components.ids[p];
        if (components.areas[id] >= minArea) continue;

        let borders = neighbourBorders.get(id);
        if (!borders) {
          borders = new Map<number, number>();
          neighbourBorders.set(id, borders);
        }

        const own = labels[p];
        if (x > 0) tally(borders, labels[p - 1], own);
        if (x + 1 < width) tally(borders, labels[p + 1], own);
        if (y > 0) tally(borders, labels[p - width], own);
        if (y + 1 < height) tally(borders, labels[p + width], own);
      }
    }

    if (neighbourBorders.size === 0) break;

    // Resolve smallest first so specks merge outward into stable regions.
    const targets = [...neighbourBorders.entries()].sort(
      (a, b) => components.areas[a[0]] - components.areas[b[0]]
    );

    const newLabelByComponent = new Map<number, number>();
    for (const [id, borders] of targets) {
      let bestLabel = -2;
      let bestLength = 0;
      for (const [label, length] of borders) {
        if (length > bestLength) {
          bestLength = length;
          bestLabel = label;
        }
      }
      // A component with no differing neighbour is an isolated island (the whole
      // image, or a speck fully surrounded by transparency). Leave it alone.
      if (bestLabel !== -2) newLabelByComponent.set(id, bestLabel);
    }

    if (newLabelByComponent.size === 0) break;

    for (let p = 0; p < labels.length; p++) {
      const replacement = newLabelByComponent.get(components.ids[p]);
      if (replacement !== undefined && replacement !== labels[p]) {
        labels[p] = replacement as number;
        changedThisPass++;
      }
    }

    dissolved += newLabelByComponent.size;
    if (changedThisPass === 0) break;
  }

  return dissolved;
}

function tally(borders: Map<number, number>, neighbour: number, own: number): void {
  if (neighbour === own) return;
  borders.set(neighbour, (borders.get(neighbour) ?? 0) + 1);
}

/**
 * Majority smoothing over an 8-neighbourhood.
 *
 * Reserved for heavy-cleanup mode, and deliberately *not* part of the default
 * path. The reason is a hard limit rather than a tuning problem: a single-pixel
 * spur and a 90 degree convex corner have identical 8-neighbourhoods — three
 * same-label neighbours and five different ones. No threshold can remove one and
 * keep the other.
 *
 * Since sharp corners matter more than spurs for logos and lettering, and since
 * simplification plus curve fitting already handle staircases with sub-pixel
 * accuracy, the default is to not run this at all. At a threshold of 6 it strips
 * spurs and two-neighbour noise, at the cost of eroding thin diagonal strokes by
 * a pixel — a reasonable trade only when someone has explicitly asked for
 * aggressive denoising.
 */
export function smoothLabels(
  labels: Int16Array,
  width: number,
  height: number,
  iterations: number,
  threshold = 6
): void {
  if (iterations <= 0) return;

  // `labels` is read for the whole sweep and `scratch` accumulates the result, so
  // every pixel in one iteration sees the same input state. Deciding in-place
  // would let earlier pixels influence later ones and bias smoothing toward the
  // scan direction, which shows up as a diagonal drift on large flat edges.
  const source = labels;
  const scratch = new Int16Array(labels.length);

  for (let iter = 0; iter < iterations; iter++) {
    scratch.set(source);
    let changed = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const own = source[p];

        // Tally the 8 neighbours. Out-of-bounds neighbours are skipped rather
        // than treated as a label, so border pixels are not pulled inward.
        let bestLabel = own;
        let bestCount = 0;
        const counts = new Map<number, number>();

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const label = source[ny * width + nx];
            const next = (counts.get(label) ?? 0) + 1;
            counts.set(label, next);
            if (next > bestCount) {
              bestCount = next;
              bestLabel = label;
            }
          }
        }

        if (bestLabel !== own && bestCount >= threshold) {
          scratch[p] = bestLabel;
          changed++;
        }
      }
    }

    // Fold the pass back into the working buffer so the next iteration builds on it.
    labels.set(scratch);

    if (changed === 0) break;
  }
}

export interface BackgroundDetection {
  /** Palette index judged to be background, or null. */
  label: number | null;
  /** Fraction of the border occupied by that label. */
  borderCoverage: number;
  reason: string;
}

/**
 * Decide whether one palette color is a flat backdrop that should become
 * transparency.
 *
 * The test is border dominance plus connectivity: a real background touches most
 * of the frame edge *and* does so as one connected region. A large foreground
 * shape can touch the border, but rarely surrounds the whole frame; conversely a
 * gradient sky would already have been split into several palette entries and so
 * no single label would dominate.
 */
export function detectBackground(
  labels: Int16Array,
  width: number,
  height: number,
  paletteSize: number
): BackgroundDetection {
  if (paletteSize === 0) {
    return { label: null, borderCoverage: 0, reason: 'empty palette' };
  }

  const borderCounts = new Int32Array(paletteSize + 1);
  let borderTotal = 0;

  // Coverage is measured against the *whole* perimeter, transparent pixels
  // included. Counting only the opaque border pixels was subtly wrong: in a PNG
  // whose subject already sits on transparency, a subject that happens to reach
  // the top and bottom edges accounts for every opaque border pixel and gets
  // mistaken for the backdrop — then deleted. Requiring a real backdrop to
  // surround the frame means an image that already has an alpha channel is
  // correctly left alone, since its background was removed before we ever saw it.
  const bump = (label: number) => {
    borderTotal++;
    if (label === TRANSPARENT) return;
    borderCounts[label]++;
  };

  for (let x = 0; x < width; x++) {
    bump(labels[x]);
    bump(labels[(height - 1) * width + x]);
  }
  for (let y = 1; y < height - 1; y++) {
    bump(labels[y * width]);
    bump(labels[y * width + width - 1]);
  }

  if (borderTotal === 0) {
    return { label: null, borderCoverage: 0, reason: 'image has no border' };
  }

  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < paletteSize; i++) {
    if (borderCounts[i] > bestCount) {
      bestCount = borderCounts[i];
      best = i;
    }
  }

  const coverage = bestCount / borderTotal;
  if (best < 0 || coverage < 0.7) {
    return {
      label: null,
      borderCoverage: coverage,
      reason:
        bestCount === 0
          ? 'border is already transparent'
          : 'no single color surrounds the frame',
    };
  }

  // Require the background to be essentially one region, so a checkerboard or a
  // striped pattern touching the border is not mistaken for a backdrop.
  const components = findComponents(labels, width, height);
  let labelArea = 0;
  let largestComponentArea = 0;
  for (let id = 0; id < components.count; id++) {
    if (components.labels[id] !== best) continue;
    labelArea += components.areas[id];
    if (components.areas[id] > largestComponentArea) {
      largestComponentArea = components.areas[id];
    }
  }

  if (labelArea === 0 || largestComponentArea / labelArea < 0.6) {
    return {
      label: null,
      borderCoverage: coverage,
      reason: 'border color is fragmented, not a backdrop',
    };
  }

  return {
    label: best,
    borderCoverage: coverage,
    reason: `covers ${Math.round(coverage * 100)}% of the border as one region`,
  };
}

/**
 * Turn one label into transparency, but only for regions connected to the border.
 *
 * The connectivity restriction preserves enclosed areas of the same color: a
 * white page background disappears while the whites of an eye, or the counter of
 * a letter "o" drawn in the background color, stay filled.
 */
export function removeBackgroundLabel(
  labels: Int16Array,
  width: number,
  height: number,
  target: number
): number {
  const components = findComponents(labels, width, height);
  const touchesBorder = new Uint8Array(components.count);

  for (let x = 0; x < width; x++) {
    touchesBorder[components.ids[x]] = 1;
    touchesBorder[components.ids[(height - 1) * width + x]] = 1;
  }
  for (let y = 0; y < height; y++) {
    touchesBorder[components.ids[y * width]] = 1;
    touchesBorder[components.ids[y * width + width - 1]] = 1;
  }

  let cleared = 0;
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] !== target) continue;
    if (!touchesBorder[components.ids[p]]) continue;
    labels[p] = TRANSPARENT;
    cleared++;
  }

  return cleared;
}
