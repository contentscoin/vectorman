/**
 * Core geometry and result types for the vectorization engine.
 *
 * Coordinate convention: all geometry is expressed in *source pixel space*, with
 * (0,0) at the top-left corner of the top-left pixel. A 100x50 image therefore
 * produces geometry inside the box (0,0)-(100,50). Region boundaries fall on
 * integer lattice points before smoothing, which is what lets the tracer produce
 * exact, gap-free regions.
 */

export interface Point {
  x: number;
  y: number;
}

/** 8-bit sRGB triple. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** CIE L*a*b*, D65 white point. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Raw RGBA raster. `data` is row-major, 4 bytes per pixel, not premultiplied. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A single path segment. The start point is implicit (previous segment's end). */
export type Segment =
  | { kind: 'line'; to: Point }
  | { kind: 'cubic'; c1: Point; c2: Point; to: Point };

/**
 * A closed contour. `isHole` is derived from signed area: outer contours are
 * emitted clockwise (positive area in SVG's y-down space), holes counter-clockwise,
 * so that `fill-rule: nonzero` renders holes correctly without even-odd tricks.
 */
export interface Contour {
  start: Point;
  segments: Segment[];
  /** Signed area in px^2. Positive = clockwise in y-down space = outer. */
  signedArea: number;
  isHole: boolean;
}

/** One connected region of a single color, plus any holes punched through it. */
export interface Shape {
  /** Outer contour first, then holes. */
  contours: Contour[];
  /** Filled pixel count of the region (excludes holes). */
  pixelCount: number;
  /** Axis-aligned bounds in pixel space. */
  bounds: Bounds;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A centreline recovered from a thin, elongated region: one path drawn with a
 * stroke weight, rather than the two parallel outlines a fill would produce.
 */
export interface StrokePath {
  start: Point;
  segments: Segment[];
  /** True when the path returns to its start, e.g. the centreline of a ring. */
  closed: boolean;
  /** Stroke weight in source pixels, recovered from the distance transform. */
  width: number;
}

/** All shapes sharing one palette color. Becomes one `<g>` in the SVG. */
export interface ColorLayer {
  /** Index into the result palette. Stable across color-merge edits. */
  index: number;
  color: RGB;
  /** Lowercase `#rrggbb`. */
  hex: string;
  /** Human label, e.g. "Dark teal". Used in the layer list UI. */
  name: string;
  /** Filled regions. */
  shapes: Shape[];
  /**
   * Stroked centrelines. Only populated when `strokeMode` recovers strokes; the
   * regions they came from are removed from `shapes`, so the two never overlap.
   */
  strokes: StrokePath[];
  pixelCount: number;
}

export interface VectorizeStats {
  sourceWidth: number;
  sourceHeight: number;
  /** Dimensions actually traced (may be downscaled from source). */
  tracedWidth: number;
  tracedHeight: number;
  colors: number;
  /** Number of discrete filled regions across all layers. */
  pieces: number;
  /** Number of recovered centreline paths across all layers. */
  strokes: number;
  /** Total anchor points across all contours. The headline "low node count" metric. */
  nodes: number;
  /** Anchor points before curve fitting, for the reduction ratio. */
  nodesBeforeFitting: number;
  /**
   * Regions with visible pixels that produced no geometry and were discarded.
   *
   * Should always be 0. It is reported rather than assumed because a silently
   * dropped region means a whole colour layer can vanish from the output, and a
   * number you can assert on is worth more than an invariant you hope holds.
   */
  droppedRegions: number;
  /**
   * Regions whose outer/hole classification was inconsistent and got repaired.
   *
   * Normally 0. Non-zero means a rare downstream numeric fault was caught and the
   * region preserved rather than dropped, so the output is correct but the engine hit
   * a path worth knowing about.
   */
  repairedRegions: number;
  elapsedMs: number;
}

export interface VectorizeResult {
  /** Geometry is in this coordinate space; also the SVG viewBox. */
  width: number;
  height: number;
  layers: ColorLayer[];
  palette: RGB[];
  stats: VectorizeStats;
  /** Options after defaults and auto-detection were applied. */
  resolvedOptions: ResolvedVectorizeOptions;
  /** What the centreline pass did, present even when it was disabled. */
  strokeReport: StrokeReport;
}

export type BackgroundHandling = 'auto' | 'keep' | 'remove';

export interface VectorizeOptions {
  /**
   * Upper bound on palette size. Flat art with fewer distinct colors than this
   * keeps its exact colors instead of being re-quantized.
   * @default 8
   */
  maxColors?: number;

  /**
   * 0-100. How closely paths follow the pixel boundary. Higher keeps more
   * detail and produces more nodes; lower produces smoother, lighter paths.
   * @default 55
   */
  detail?: number;

  /**
   * 0-100. How aggressively corners are rounded into curves. 0 preserves every
   * corner as a hard vertex, 100 smooths nearly everything.
   * @default 60
   */
  smoothing?: number;

  /**
   * Drop regions smaller than this many source pixels. `undefined` derives a
   * value from image area, which is what removes JPEG speckle.
   */
  minArea?: number;

  /**
   * 0-100. Pre-trace noise cleanup strength. Raise for JPEG artifacts and
   * anti-aliased edges, lower for crisp pixel art you want traced literally.
   * @default 45
   */
  denoise?: number;

  /**
   * Pixels with alpha below this are treated as transparent and produce no geometry.
   * @default 128
   */
  alphaThreshold?: number;

  /**
   * `auto` drops a color layer if it looks like a flat background touching the
   * border on all sides, giving a transparent SVG.
   * @default 'auto'
   */
  background?: BackgroundHandling;

  /**
   * Palette entries closer than this CIE76 deltaE get merged. Prevents
   * near-duplicate colors from anti-aliasing becoming separate layers.
   * @default 6
   */
  colorMergeThreshold?: number;

  /**
   * Longest side used for tracing. Larger images are downscaled for speed and
   * the geometry is scaled back up, so output still matches source dimensions.
   * @default 1400
   */
  maxDimension?: number;

  /**
   * Decimal places in emitted path coordinates.
   * @default 2
   */
  precision?: number;

  /** Force an exact palette instead of quantizing. */
  palette?: RGB[];

  /** Deterministic seed for the k-means++ initialization. */
  seed?: number;

  /**
   * Recover thin regions as stroked centrelines instead of filled outlines.
   *
   * `off` always fills. `auto` converts a region only when it is clearly a stroke
   * *and* nothing else shares its boundary — replacing a fill with a stroke moves
   * that colour's edge, so doing it next to another colour would open a seam.
   * `force` lowers the elongation bar for artwork you know is line work.
   *
   * @default 'off'
   */
  strokeMode?: StrokeMode;

  /**
   * Minimum length-to-width ratio for `auto` to treat a region as a stroke. Reads
   * directly as "how many times longer than it is wide".
   * @default 5
   */
  minStrokeElongation?: number;
}

export type StrokeMode = 'off' | 'auto' | 'force';

export type ResolvedVectorizeOptions = Required<
  Omit<VectorizeOptions, 'palette' | 'minArea'>
> & {
  palette: RGB[] | null;
  minArea: number;
};

/** Which regions a stroke pass may legally convert, and what it found. */
export interface StrokeReport {
  mode: StrokeMode;
  /** Regions converted from a filled outline into centrelines. */
  converted: number;
  /** Regions that looked like strokes but border another color, so were left filled. */
  blockedByNeighbours: number;
  /** Median recovered stroke width in source pixels, or null when none were found. */
  medianWidth: number | null;
}

export interface SvgEmitOptions {
  /** Decimal places for coordinates. Defaults to the value used during tracing. */
  precision?: number;
  /** Emit relative path commands, which are typically 15-25% smaller. @default true */
  relative?: boolean;
  /** Add `<title>`/`<desc>` metadata. @default true */
  metadata?: boolean;
  /** Group each color in a `<g>` with an id and `data-color`. @default true */
  groupByColor?: boolean;
  /**
   * Round stroke caps and joins on recovered centrelines. Matches how the original
   * drawn stroke almost always looked, and avoids the notches butt caps leave at
   * junctions. @default true
   */
  roundStrokes?: boolean;
  /** Pretty-print with newlines and indentation. @default false */
  pretty?: boolean;
  /** Explicit width/height attributes in addition to viewBox. @default true */
  dimensions?: boolean;
  /** Paint a solid rect behind everything. */
  backgroundColor?: string | null;
  /** Scale factor applied to the viewBox dimensions. @default 1 */
  scale?: number;
}
