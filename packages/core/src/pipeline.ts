import { describeColor, rgbToHex, uniquifyNames } from './color/space.js';
import { quantize } from './color/quantize.js';
import {
  TRANSPARENT,
  despeckle,
  detectBackground,
  findComponents,
  removeBackgroundLabel,
  smoothLabels,
} from './image/labels.js';
import {
  denoiseRadius,
  downscale,
  estimateNoise,
  hardenAlpha,
  medianFilter,
} from './image/preprocess.js';
import { analyzeCorners, cornerThresholdDegrees } from './geom/corners.js';
import { fitClosedContour, fitOpenPolyline } from './geom/fit.js';
import { removeCollinear, simplifyClosed, simplifyPolyline } from './geom/simplify.js';
import { type Polypath, reversePolypath } from './geom/segments.js';
import {
  NO_REGION,
  loopSignedArea,
  type Chain,
  type RegionLoop,
  tracePlanar,
} from './trace/planar.js';
import {
  scaleStrokePath,
  traceCenterline,
  type CenterlineOptions,
  type StrokeCandidate,
} from './trace/centerline.js';
import type {
  Bounds,
  ColorLayer,
  Contour,
  Point,
  RGB,
  RasterImage,
  ResolvedVectorizeOptions,
  Segment,
  Shape,
  StrokePath,
  StrokeReport,
  VectorizeOptions,
  VectorizeResult,
} from './types.js';

/**
 * The vectorization pipeline.
 *
 * Stage order is load-bearing. Each stage assumes the previous one has removed a
 * specific class of defect, and reordering them measurably degrades output:
 *
 *   downscale -> harden alpha -> denoise -> quantize -> drop background
 *     -> despeckle -> smooth labels -> despeckle -> regions
 *     -> planar trace -> simplify & fit each shared boundary once
 *     -> assemble outlines -> rescale to source size
 *
 * Two decisions shape everything else:
 *
 *  - **All cleanup happens on the label map**, before any geometry exists.
 *    Repairing a bad path is far harder than repairing the pixels that produced
 *    it, and once tracing starts the answer is already fixed.
 *
 *  - **Shared boundaries are fitted once**, not once per adjacent color. See
 *    `trace/planar.ts` for why independent per-color tracing leaves hairline
 *    seams between regions.
 */

const DEFAULTS = {
  maxColors: 8,
  detail: 55,
  smoothing: 60,
  denoise: 45,
  alphaThreshold: 128,
  background: 'auto' as const,
  colorMergeThreshold: 6,
  maxDimension: 1400,
  precision: 2,
  seed: 0x5eed,
  strokeMode: 'off' as const,
  minStrokeElongation: 5,
};

/** Elongation bar used by `force`, expressed as length-to-width ratio. */
const FORCED_ELONGATION = 2.5;

export function vectorize(image: RasterImage, options: VectorizeOptions = {}): VectorizeResult {
  const startedAt = now();

  if (image.width <= 0 || image.height <= 0) {
    throw new Error('Image has zero width or height');
  }
  if (image.data.length < image.width * image.height * 4) {
    throw new Error(
      `Pixel buffer too small: expected ${image.width * image.height * 4} bytes, ` +
        `got ${image.data.length}`
    );
  }

  const sourceWidth = image.width;
  const sourceHeight = image.height;

  const alphaThreshold = clampInt(options.alphaThreshold ?? DEFAULTS.alphaThreshold, 0, 255);
  const denoise = clampInt(options.denoise ?? DEFAULTS.denoise, 0, 100);
  const detail = clampInt(options.detail ?? DEFAULTS.detail, 0, 100);
  const smoothing = clampInt(options.smoothing ?? DEFAULTS.smoothing, 0, 100);
  const maxColors = clampInt(options.maxColors ?? DEFAULTS.maxColors, 1, 256);
  const colorMergeThreshold = Math.max(
    0,
    options.colorMergeThreshold ?? DEFAULTS.colorMergeThreshold
  );
  const precision = clampInt(options.precision ?? DEFAULTS.precision, 0, 6);
  const background = options.background ?? DEFAULTS.background;
  const seed = options.seed ?? DEFAULTS.seed;
  const maxDimension = options.maxDimension ?? DEFAULTS.maxDimension;
  const strokeMode = options.strokeMode ?? DEFAULTS.strokeMode;
  const minStrokeElongation = Math.max(
    1,
    options.minStrokeElongation ?? DEFAULTS.minStrokeElongation
  );

  // ---- Stage 1: resolution ------------------------------------------------
  const { image: scaled, scale } = downscale(image, maxDimension);
  const tracedWidth = scaled.width;
  const tracedHeight = scaled.height;

  // minArea is authored in source pixels but enforced in traced pixels.
  const sourceArea = sourceWidth * sourceHeight;
  const defaultMinAreaSource = Math.max(
    2,
    Math.round(sourceArea * 0.00002 * (0.4 + (denoise / 100) * 1.6))
  );
  const minAreaSource = options.minArea ?? defaultMinAreaSource;
  const minAreaTraced = Math.max(1, Math.round(minAreaSource * scale * scale));

  // ---- Stage 2: pixel conditioning ---------------------------------------
  let working: RasterImage = hardenAlpha(scaled, alphaThreshold);

  // Denoising is applied only when there is measurable noise in areas that should
  // be flat. A median filter shifts three-way junctions and chamfers corners by
  // up to a pixel, so running it unconditionally would damage exactly the clean
  // logo input it is not needed for. See `estimateNoise`.
  const noiseLevel = denoise > 10 ? estimateNoise(working) : 0;
  // Calibrated against the fixtures: clean art measures 0, so there is wide
  // headroom below the gate. A higher denoise setting lowers the bar for acting.
  const noiseGate = 0.04 + 0.16 * (1 - denoise / 100);
  const radius = noiseLevel >= noiseGate ? denoiseRadius(denoise, tracedWidth, tracedHeight) : 0;
  if (radius > 0) working = medianFilter(working, radius);

  // ---- Stage 3: palette ---------------------------------------------------
  const quantized = quantize(working.data, tracedWidth, tracedHeight, {
    maxColors,
    alphaThreshold: 1, // alpha is already binary after hardening
    mergeThreshold: colorMergeThreshold,
    seed,
    forcedPalette: options.palette ?? null,
  });

  const labels = quantized.labels;
  const quantizedPalette = quantized.palette;

  // ---- Stage 4: background ------------------------------------------------
  if (quantizedPalette.length > 0 && background !== 'keep') {
    const detection = detectBackground(labels, tracedWidth, tracedHeight, quantizedPalette.length);
    const target =
      background === 'remove'
        ? (detection.label ??
          dominantBorderLabel(labels, tracedWidth, tracedHeight, quantizedPalette.length))
        : detection.label;
    if (target !== null) {
      removeBackgroundLabel(labels, tracedWidth, tracedHeight, target);
    }
  }

  // ---- Stage 5: label map cleanup ----------------------------------------
  despeckle(labels, tracedWidth, tracedHeight, minAreaTraced);

  // Majority smoothing is off unless denoising was explicitly cranked up. It
  // cannot distinguish a single-pixel spur from a 90 degree corner, so on the
  // default path it would chamfer every corner in a logo. Staircases are handled
  // downstream by simplification and curve fitting instead.
  const smoothingIterations = denoise >= 70 ? 1 : 0;
  if (smoothingIterations > 0) {
    smoothLabels(labels, tracedWidth, tracedHeight, smoothingIterations);
    despeckle(labels, tracedWidth, tracedHeight, minAreaTraced, 2);
  }

  // ---- Stage 6: regions ---------------------------------------------------
  const components = findComponents(labels, tracedWidth, tracedHeight);

  // Transparent components carry no geometry, so they collapse into a single
  // "nothing here" identity for the planar graph.
  const regionIds = new Int32Array(components.ids.length);
  for (let i = 0; i < regionIds.length; i++) {
    const id = components.ids[i];
    regionIds[i] = components.labels[id] === TRANSPARENT ? NO_REGION : id;
  }

  const trace = tracePlanar({
    regionIds,
    width: tracedWidth,
    height: tracedHeight,
    regionBounds: components.bounds,
    regionCount: components.count,
  });

  // ---- Stage 7: fit each shared boundary exactly once --------------------
  const epsilon = epsilonFromDetail(detail);
  const tolerance = toleranceFromDetail(detail);
  const cornerThreshold = cornerThresholdDegrees(smoothing);
  const lineTolerance = Math.max(0.01, epsilon * 0.25);

  const scaleX = sourceWidth / tracedWidth;
  const scaleY = sourceHeight / tracedHeight;

  const fitted = new Array<Polypath | null>(trace.chains.length).fill(null);
  const reversedCache = new Array<Polypath | null>(trace.chains.length).fill(null);
  let rawNodeTotal = 0;

  for (const chain of trace.chains) {
    // Baseline for the reduction figure: the staircase corner count, which is
    // roughly what a pixel-following tracer emits.
    rawNodeTotal += chain.points.length;
    const path = fitChain(chain, {
      epsilon,
      tolerance,
      cornerThreshold,
      lineTolerance,
      minCornerSpacing: epsilon * 0.9,
    });
    if (!path) continue;
    scalePolypath(path, scaleX, scaleY);
    fitted[chain.id] = path;
  }

  const resolveChain = (id: number, reversed: boolean): Polypath | null => {
    const forward = fitted[id];
    if (!forward) return null;
    if (!reversed) return forward;
    let cached = reversedCache[id];
    if (!cached) {
      cached = reversePolypath(forward);
      reversedCache[id] = cached;
    }
    return cached;
  };

  // ---- Stage 8: assemble outlines, recovering strokes where asked --------
  const shapesByLabel = new Map<number, Shape[]>();
  const strokesByLabel = new Map<number, StrokePath[]>();
  let fittedNodeTotal = 0;
  let droppedRegions = 0;
  let repairedRegions = 0;

  const centerlineOptions: CenterlineOptions = {
    minElongation: strokeMode === 'force' ? FORCED_ELONGATION : minStrokeElongation,
    epsilon,
    tolerance,
    cornerThreshold,
    lineTolerance,
    maxStrokeRadius: 40,
  };
  const strokeReport: StrokeReport = {
    mode: strokeMode,
    converted: 0,
    blockedByNeighbours: 0,
    medianWidth: null,
  };
  const recoveredWidths: number[] = [];

  for (const [region, loops] of trace.loopsByRegion) {
    const label = components.labels[region];
    if (label === TRANSPARENT) continue;

    const bounds = {
      minX: components.bounds[region * 4],
      minY: components.bounds[region * 4 + 1],
      maxX: components.bounds[region * 4 + 2],
      maxY: components.bounds[region * 4 + 3],
    };

    // Try the centreline first: on success the region produces strokes instead of
    // filled outlines, so there is no point fitting contours we would discard.
    if (strokeMode !== 'off') {
      if (!bordersOnlyEmptiness(loops, trace.chains, region)) {
        strokeReport.blockedByNeighbours++;
      } else {
        const candidate = buildStrokeCandidate(
          regionIds,
          region,
          bounds,
          tracedWidth,
          tracedHeight
        );
        const centerline = traceCenterline(candidate, centerlineOptions);
        if (centerline) {
          for (const path of centerline.paths) {
            scaleStrokePath(path, scaleX, scaleY);
            fittedNodeTotal += path.segments.length;
            recoveredWidths.push(path.width);
          }
          const existing = strokesByLabel.get(label);
          if (existing) existing.push(...centerline.paths);
          else strokesByLabel.set(label, [...centerline.paths]);
          strokeReport.converted++;
          continue;
        }
      }
    }

    const outers: Contour[] = [];
    const holes: Contour[] = [];
    let regionNodes = 0;

    for (const loop of loops) {
      // Derived from the loop's own lattice polygon each time, never cached on it.
      const signedArea = loopSignedArea(loop);

      // Fall back to the exact lattice outline rather than losing the loop. A region
      // in the label map has visible pixels, so it must produce geometry; dropping it
      // because one shared chain failed to fit would make a whole colour layer
      // disappear from the output.
      const contour =
        assembleContour(loop.chains, signedArea, resolveChain) ??
        latticeContour(loop, signedArea, scaleX, scaleY);
      if (!contour) continue;
      regionNodes += contour.segments.length;
      if (contour.isHole) holes.push(contour);
      else outers.push(contour);
    }

    // A region with no outer boundary contributes nothing, so its contours must not
    // be counted either. Adding to the total before this point made `stats.nodes`
    // describe geometry that was never emitted — the symptom being a colour layer
    // silently vanishing while the node count stayed put.
    // Every connected region has exactly one outer boundary — that is a fact about
    // connected sets, not an assumption about this code. So if nothing was classified
    // as an outline, the classification is what is wrong, and the loop enclosing the
    // most area is the outline. Repairing to the nearest consistent state keeps the
    // artwork; trusting the classification would delete a whole colour layer.
    //
    // This fires rarely and only under worker threads. Stages up to and including
    // chain extraction were verified bit-identical across 540 runs, so the trigger is
    // downstream float behaviour rather than a different label map. Guaranteeing the
    // invariant is worth more than pinning the exact comparison that flips.
    if (outers.length === 0 && holes.length > 0) {
      let widest = 0;
      for (let i = 1; i < holes.length; i++) {
        if (Math.abs(holes[i].signedArea) > Math.abs(holes[widest].signedArea)) widest = i;
      }
      const promoted = holes.splice(widest, 1)[0];
      promoted.isHole = false;
      outers.push(promoted);
      repairedRegions++;
    }

    if (outers.length === 0) {
      droppedRegions++;
      continue;
    }
    fittedNodeTotal += regionNodes;

    const areaInSourcePixels = Math.round(components.areas[region] * scaleX * scaleY);
    const shapes = assembleShapes(outers, holes, areaInSourcePixels);

    const existing = shapesByLabel.get(label);
    if (existing) existing.push(...shapes);
    else shapesByLabel.set(label, shapes);
  }

  if (recoveredWidths.length > 0) {
    recoveredWidths.sort((a, b) => a - b);
    strokeReport.medianWidth =
      Math.round(recoveredWidths[recoveredWidths.length >> 1] * 100) / 100;
  }

  // ---- Stage 9: layers ----------------------------------------------------
  // A colour can end up with only strokes, so both maps contribute labels.
  const usedLabels = [...new Set([...shapesByLabel.keys(), ...strokesByLabel.keys()])];

  const areaByLabel = new Map<number, number>();
  for (let region = 0; region < components.count; region++) {
    const label = components.labels[region];
    if (label === TRANSPARENT) continue;
    if (!shapesByLabel.has(label) && !strokesByLabel.has(label)) continue;
    // Measured from the label map rather than from shapes, so a colour recovered as
    // strokes still reports the area it actually covers.
    areaByLabel.set(
      label,
      (areaByLabel.get(label) ?? 0) + Math.round(components.areas[region] * scaleX * scaleY)
    );
  }
  usedLabels.sort((a, b) => (areaByLabel.get(b) ?? 0) - (areaByLabel.get(a) ?? 0));

  const palette: RGB[] = usedLabels.map((label) => quantizedPalette[label] ?? { r: 0, g: 0, b: 0 });
  const names = uniquifyNames(palette.map(describeColor));

  const layers: ColorLayer[] = usedLabels.map((label, index) => {
    const shapes = shapesByLabel.get(label) ?? [];
    // Largest piece first, so clicking into a layer selects the dominant shape.
    shapes.sort((a, b) => b.pixelCount - a.pixelCount);
    return {
      index,
      color: palette[index],
      hex: rgbToHex(palette[index]),
      name: names[index],
      shapes,
      strokes: strokesByLabel.get(label) ?? [],
      pixelCount: areaByLabel.get(label) ?? 0,
    };
  });

  const resolvedOptions: ResolvedVectorizeOptions = {
    maxColors,
    detail,
    smoothing,
    denoise,
    alphaThreshold,
    background,
    colorMergeThreshold,
    maxDimension,
    precision,
    seed,
    strokeMode,
    minStrokeElongation,
    palette: options.palette ?? null,
    minArea: minAreaSource,
  };

  return {
    width: sourceWidth,
    height: sourceHeight,
    layers,
    palette,
    resolvedOptions,
    strokeReport,
    stats: {
      sourceWidth,
      sourceHeight,
      tracedWidth,
      tracedHeight,
      colors: layers.length,
      pieces: layers.reduce((sum, l) => sum + l.shapes.length, 0),
      strokes: layers.reduce((sum, l) => sum + l.strokes.length, 0),
      nodes: fittedNodeTotal,
      nodesBeforeFitting: rawNodeTotal,
      droppedRegions,
      repairedRegions,
      elapsedMs: Math.round((now() - startedAt) * 100) / 100,
    },
  };
}

interface ContourFitConfig {
  epsilon: number;
  tolerance: number;
  cornerThreshold: number;
  lineTolerance: number;
  minCornerSpacing: number;
}

/**
 * Simplify and curve-fit one chain.
 *
 * Corner detection runs *after* simplification, never before. On the raw
 * staircase every vertex is a 90 degree turn, so classifying first would mark the
 * whole outline as corners and disable the fitter entirely.
 *
 * Open chains keep their endpoints pinned: those are junctions where a third
 * region meets, and every boundary arriving there must agree on the exact point
 * or a pinhole opens up between the three colors.
 */
/**
 * Straight-line path through the given points. Always valid.
 *
 * This is the floor under curve fitting. A chain exists because the label map has a
 * real boundary there, so it must produce geometry — and because chains are shared,
 * one that produced nothing would take out every region using it, dropping visible
 * artwork. Emitting the exact lattice polyline is worse-looking than a fitted curve
 * and strictly better than losing a colour layer.
 */
function polylineFallback(points: Point[], closed: boolean): Polypath | null {
  if (points.length < 2) return null;

  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({ kind: 'line', to: points[i] });
  }
  if (closed) {
    segments.push({ kind: 'line', to: points[0] });
  }

  return segments.length > 0 ? { start: points[0], segments } : null;
}

function fitChain(chain: Chain, config: ContourFitConfig): Polypath | null {
  if (chain.closed) {
    if (chain.points.length < 3) return null;
    let working = chain.points;
    if (config.epsilon > 0) {
      working = simplifyClosed(working, config.epsilon);
      working = removeCollinear(working);

      // A feature only a pixel or two across can be simplified out of existence,
      // because the epsilon that collapses a staircase is the same size as the
      // whole shape. Falling back to the unsimplified outline keeps small but
      // intentional details — a dot over an i, a 1px highlight — instead of
      // silently dropping them.
      if (working.length < 3) {
        working = removeCollinear(chain.points);
        if (working.length < 3) working = chain.points;
      }
    }
    if (working.length < 3) return null;

    const { corners } = analyzeCorners(
      working,
      config.cornerThreshold,
      true,
      config.minCornerSpacing
    );
    return (
      fitClosedContour(working, corners, {
        tolerance: config.tolerance,
        lineTolerance: config.lineTolerance,
      }) ?? polylineFallback(working, true)
    );
  }

  if (chain.points.length < 2) return null;
  let working = chain.points;
  if (config.epsilon > 0) {
    working = simplifyPolyline(working, config.epsilon);
  }
  if (working.length < 2) return null;

  const { corners } = analyzeCorners(
    working,
    config.cornerThreshold,
    false,
    config.minCornerSpacing
  );
  return (
    fitOpenPolyline(working, corners, {
      tolerance: config.tolerance,
      lineTolerance: config.lineTolerance,
    }) ?? polylineFallback(working, false)
  );
}

/**
 * Concatenate the fitted chains of one boundary loop into a closed contour.
 *
 * Chains meet exactly at junctions, so concatenation is continuous by
 * construction and the final segment lands back on the start point.
 */
function assembleContour(
  refs: Array<{ chain: number; reversed: boolean }>,
  signedArea: number,
  resolve: (id: number, reversed: boolean) => Polypath | null
): Contour | null {
  let start: Point | null = null;
  const segments: Segment[] = [];

  for (const ref of refs) {
    const path = resolve(ref.chain, ref.reversed);
    if (!path) return null; // a dropped chain would leave the outline open
    if (start === null) start = path.start;
    // Appended in a loop rather than with `push(...path.segments)`. A spread passes
    // every element as a call argument, so a long chain can exceed the stack — and
    // worker threads get a smaller stack than the main thread, which is exactly the
    // sort of difference that turns into an intermittent, environment-specific fault.
    for (const segment of path.segments) segments.push(segment);
  }

  if (start === null || segments.length === 0) return null;

  return { start, segments, signedArea, isHole: signedArea < 0 };
}

/**
 * Build a contour straight from a loop's lattice polygon.
 *
 * The unconditional safety net under chain assembly. It produces the same exact
 * region boundary the tracer found, just unsmoothed — a worse-looking outline than a
 * fitted one, and vastly better than a missing colour layer.
 */
function latticeContour(
  loop: RegionLoop,
  signedArea: number,
  scaleX: number,
  scaleY: number
): Contour | null {
  if (loop.vertices.length < 3) return null;

  const scaled = loop.vertices.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
  const segments: Segment[] = [];
  for (let i = 1; i < scaled.length; i++) segments.push({ kind: 'line', to: scaled[i] });
  segments.push({ kind: 'line', to: scaled[0] });

  return {
    start: scaled[0],
    segments,
    signedArea,
    isHole: signedArea < 0,
  };
}

function scalePolypath(path: Polypath, scaleX: number, scaleY: number): void {
  if (scaleX === 1 && scaleY === 1) return;

  path.start = { x: path.start.x * scaleX, y: path.start.y * scaleY };
  for (const segment of path.segments) {
    segment.to = { x: segment.to.x * scaleX, y: segment.to.y * scaleY };
    if (segment.kind === 'cubic') {
      segment.c1 = { x: segment.c1.x * scaleX, y: segment.c1.y * scaleY };
      segment.c2 = { x: segment.c2.x * scaleX, y: segment.c2.y * scaleY };
    }
  }
}

/**
 * Pair holes with the outline that encloses them.
 *
 * A 4-connected region normally yields exactly one outline, which the fast path
 * covers. Multiple outlines arise when a region pinches to a diagonal touch,
 * where the boundary legitimately splits, and there a containment test is needed
 * to avoid punching a hole through the wrong piece.
 */
function assembleShapes(outers: Contour[], holes: Contour[], totalPixelCount: number): Shape[] {
  if (outers.length === 1) {
    return [
      {
        contours: [outers[0], ...holes],
        pixelCount: totalPixelCount,
        bounds: contourBounds(outers[0]),
      },
    ];
  }

  const shapes: Shape[] = outers.map((outer) => ({
    contours: [outer],
    pixelCount: 0,
    bounds: contourBounds(outer),
  }));

  for (const hole of holes) {
    let target = -1;
    let smallestArea = Infinity;
    for (let i = 0; i < shapes.length; i++) {
      const bounds = shapes[i].bounds;
      if (
        hole.start.x < bounds.minX ||
        hole.start.x > bounds.maxX ||
        hole.start.y < bounds.minY ||
        hole.start.y > bounds.maxY
      ) {
        continue;
      }
      // Prefer the tightest enclosing outline so nested outlines behave.
      const area = Math.abs(shapes[i].contours[0].signedArea);
      if (area < smallestArea) {
        smallestArea = area;
        target = i;
      }
    }
    if (target >= 0) shapes[target].contours.push(hole);
  }

  // Split the region's pixel count across outlines by area. Only used for
  // sorting and reporting, so an area-weighted estimate is sufficient.
  const totalOuterArea = shapes.reduce((sum, s) => sum + Math.abs(s.contours[0].signedArea), 0);
  for (const shape of shapes) {
    const share =
      totalOuterArea > 0
        ? Math.abs(shape.contours[0].signedArea) / totalOuterArea
        : 1 / shapes.length;
    shape.pixelCount = Math.round(totalPixelCount * share);
  }

  return shapes;
}

/**
 * May this region's fill be replaced by a stroke?
 *
 * Only if every boundary it owns faces empty space. Converting a fill to a stroke
 * moves that colour's edge inward to the centreline, so if another colour region
 * shares that edge, the two stop meeting and a gap opens — precisely the seam the
 * planar tracer exists to prevent. Ink on transparency passes; a line drawn across
 * a filled background does not, and stays a filled outline.
 *
 * The chain graph already records which two regions each boundary separates, so
 * this is a lookup rather than a fresh neighbourhood scan.
 */
function bordersOnlyEmptiness(
  loops: RegionLoop[],
  chains: Chain[],
  region: number
): boolean {
  for (const loop of loops) {
    for (const ref of loop.chains) {
      const chain = chains[ref.chain];
      if (!chain) return false;
      const other = chain.regionA === region ? chain.regionB : chain.regionA;
      if (other !== NO_REGION) return false;
    }
  }
  return true;
}

/**
 * Crop a region into its own mask, with a one-pixel margin of background.
 *
 * The margin is required, not cosmetic. A tight crop of a solid bar is *entirely*
 * foreground, so the distance transform finds no background to measure against,
 * reports infinity everywhere, and the region is silently never recognised as a
 * stroke. One pixel is enough: everything outside the region is background by
 * definition, so the ring of padding states the truth the transform needs.
 */
function buildStrokeCandidate(
  regionIds: Int32Array,
  region: number,
  bounds: Bounds,
  imageWidth: number,
  imageHeight: number
): StrokeCandidate {
  const padding = 1;
  const regionWidth = bounds.maxX - bounds.minX + 1;
  const regionHeight = bounds.maxY - bounds.minY + 1;
  const maskWidth = regionWidth + padding * 2;
  const maskHeight = regionHeight + padding * 2;
  const mask = new Uint8Array(maskWidth * maskHeight);

  let pixelCount = 0;
  for (let y = 0; y < regionHeight; y++) {
    const sourceY = bounds.minY + y;
    if (sourceY < 0 || sourceY >= imageHeight) continue;
    const sourceRow = sourceY * imageWidth;
    const maskRow = (y + padding) * maskWidth + padding;
    for (let x = 0; x < regionWidth; x++) {
      const sourceX = bounds.minX + x;
      if (sourceX < 0 || sourceX >= imageWidth) continue;
      if (regionIds[sourceRow + sourceX] === region) {
        mask[maskRow + x] = 1;
        pixelCount++;
      }
    }
  }

  return {
    mask,
    maskWidth,
    maskHeight,
    offsetX: bounds.minX - padding,
    offsetY: bounds.minY - padding,
    pixelCount,
  };
}

function contourBounds(contour: Contour): Bounds {
  let minX = contour.start.x;
  let minY = contour.start.y;
  let maxX = contour.start.x;
  let maxY = contour.start.y;

  const consider = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };

  for (const segment of contour.segments) {
    consider(segment.to);
    // Control points can extend past the anchors. Including them keeps the box
    // conservative, which is what the hole containment test needs.
    if (segment.kind === 'cubic') {
      consider(segment.c1);
      consider(segment.c2);
    }
  }

  return { minX, minY, maxX, maxY };
}

function dominantBorderLabel(
  labels: Int16Array,
  width: number,
  height: number,
  paletteSize: number
): number | null {
  const counts = new Int32Array(paletteSize);
  const bump = (label: number) => {
    if (label >= 0 && label < paletteSize) counts[label]++;
  };

  for (let x = 0; x < width; x++) {
    bump(labels[x]);
    bump(labels[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y++) {
    bump(labels[y * width]);
    bump(labels[y * width + width - 1]);
  }

  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < paletteSize; i++) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

/**
 * Simplification epsilon from the detail setting, in pixels.
 *
 * A staircase step deviates from the ideal line by at most half a pixel, so the
 * interesting range straddles 0.5: below it staircases survive, above it they
 * collapse. The exponent concentrates the slider's resolution around that region
 * rather than wasting it on the extremes.
 */
export function epsilonFromDetail(detail: number): number {
  if (detail >= 99.5) return 0;
  const inverse = (100 - detail) / 100;
  return 0.55 + 2.6 * Math.pow(inverse, 1.3);
}

/**
 * Curve-fitting tolerance in pixels.
 *
 * Floored near a pixel on purpose. The input polyline sits on the pixel lattice,
 * so each of its vertices is up to ~0.7px from where the true edge actually was.
 * Demanding that the fitted curve pass closer than that to every vertex forces it
 * to chase quantization noise, which costs nodes without adding accuracy. Keeping
 * the tolerance at or above the simplification epsilon also stops the fitter from
 * fighting a decision the simplifier already made.
 */
export function toleranceFromDetail(detail: number): number {
  if (detail >= 99.5) return 0.06;
  return Math.max(0.85, epsilonFromDetail(detail) * 0.9);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
