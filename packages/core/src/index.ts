/**
 * @perfectvector/core
 *
 * Raster to clean, editable SVG. Pure TypeScript with no platform dependencies,
 * so the identical engine runs in a browser worker and in a Node process.
 *
 * Quick start:
 *
 * ```ts
 * import { vectorize, emitSvg, resolvePreset } from '@perfectvector/core';
 *
 * const result = vectorize({ width, height, data: rgba }, resolvePreset('logo'));
 * const svg = emitSvg(result);
 * console.log(result.stats); // { colors, pieces, nodes, ... }
 * ```
 */

export { vectorize, epsilonFromDetail, toleranceFromDetail } from './pipeline.js';
export { emitSvg, contourToPathData, strokePathData, formatNumber, countNodes } from './svg/emit.js';

export { distanceTransform, maxInscribedRadius } from './image/distance.js';
export { skeletonize, extractBranches, pruneSpurs } from './trace/skeleton.js';
export { traceCenterline } from './trace/centerline.js';
export type { CenterlineOptions, CenterlineResult } from './trace/centerline.js';

export { analyzeImage } from './analyze.js';
export type { ImageAnalysis, Classification, Suitability, Finding } from './analyze.js';

export { PRESETS, DEFAULT_PRESET_ID, getPreset, resolvePreset } from './presets.js';
export type { Preset } from './presets.js';

export {
  mergeLayersFast,
  remergeWithPalette,
  removeLayers,
  suggestMerges,
  suggestionsToPlan,
} from './edit/colors.js';
export type { ColorEditPlan, ColorMergeGroup, SuggestedMerge } from './edit/colors.js';

export { exportPdf } from './export/pdf.js';
export type { PdfExportOptions } from './export/pdf.js';
export { exportEps } from './export/eps.js';
export type { EpsExportOptions } from './export/eps.js';
export { exportDxf } from './export/dxf.js';
export type { DxfExportOptions } from './export/dxf.js';
export { flattenContour } from './export/flatten.js';

export {
  rgbToHex,
  hexToRgb,
  rgbToLab,
  labToRgb,
  deltaE76,
  deltaE2000,
  describeColor,
  relativeLuminance,
} from './color/space.js';

export {
  downscale,
  medianFilter,
  hardenAlpha,
  estimateNoise,
  createRaster,
  cloneRaster,
} from './image/preprocess.js';

export type {
  Bounds,
  ColorLayer,
  Contour,
  Lab,
  Point,
  RGB,
  RasterImage,
  ResolvedVectorizeOptions,
  Segment,
  Shape,
  StrokeMode,
  StrokePath,
  StrokeReport,
  SvgEmitOptions,
  VectorizeOptions,
  VectorizeResult,
  VectorizeStats,
  BackgroundHandling,
} from './types.js';

import { vectorize } from './pipeline.js';
import { emitSvg } from './svg/emit.js';
import type { RasterImage, SvgEmitOptions, VectorizeOptions, VectorizeResult } from './types.js';

/** Vectorize and serialize in one call, returning both the SVG and the stats. */
export function vectorizeToSvg(
  image: RasterImage,
  options: VectorizeOptions = {},
  emitOptions: SvgEmitOptions & { pathPerShape?: boolean } = {}
): { svg: string; result: VectorizeResult } {
  const result = vectorize(image, options);
  return { svg: emitSvg(result, emitOptions), result };
}
