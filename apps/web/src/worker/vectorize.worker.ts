/// <reference lib="webworker" />

import {
  analyzeImage,
  emitSvg,
  exportDxf,
  exportEps,
  exportPdf,
  mergeLayersFast,
  relativeLuminance,
  remergeWithPalette,
  removeLayers,
  suggestMerges,
  vectorize,
  type ColorEditPlan,
  type RasterImage,
  type VectorizeOptions,
  type VectorizeResult,
} from '@perfectvector/core';

import type { LayerSummary, TraceSummary, WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * Vectorization worker.
 *
 * Tracing a 1400px image takes a few hundred milliseconds of solid computation.
 * On the main thread that is a visibly frozen page — no spinner animation, no
 * cancelled upload, no scrolling. Here it is invisible.
 *
 * State is retained between messages so that changing one slider re-traces from
 * the already-decoded pixels, and exporting reuses the already-fitted geometry.
 */

let source: RasterImage | null = null;
let lastOptions: VectorizeOptions = {};
let baseResult: VectorizeResult | null = null;
let currentResult: VectorizeResult | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'load': {
        source = {
          width: request.width,
          height: request.height,
          data: new Uint8ClampedArray(request.pixels),
        };
        baseResult = null;
        currentResult = null;
        reply({ id: request.id, ok: true, type: 'load', analysis: analyzeImage(source) });
        return;
      }

      case 'trace': {
        if (!source) throw new Error('No image loaded yet.');
        lastOptions = request.options;
        baseResult = vectorize(source, request.options);
        currentResult = baseResult;
        reply({ id: request.id, ok: true, type: 'trace', summary: summarize(baseResult) });
        return;
      }

      case 'edit': {
        if (!source || !baseResult) throw new Error('Nothing traced yet.');
        currentResult = applyEdits(source, lastOptions, baseResult, request.plan, request.exact);
        reply({ id: request.id, ok: true, type: 'edit', summary: summarize(currentResult) });
        return;
      }

      case 'export': {
        if (!currentResult) throw new Error('Nothing traced yet.');
        reply({
          id: request.id,
          ok: true,
          type: 'export',
          format: request.format,
          text: renderExport(currentResult, request.format),
        });
        return;
      }

      case 'reset': {
        source = null;
        baseResult = null;
        currentResult = null;
        reply({ id: request.id, ok: true, type: 'reset' });
        return;
      }
    }
  } catch (error) {
    reply({
      id: (request as { id: number }).id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Apply palette edits.
 *
 * `exact` selects between two genuinely different operations rather than two
 * quality levels:
 *
 *  - false — recolour the existing shapes. Instant, so it can run while someone
 *    drags swatches together, but the boundary between merged regions is still in
 *    the file, so the node count does not improve.
 *  - true — re-run the trace with the merged palette. The merge then happens on
 *    the label map, the internal boundary is never traced, and the node count
 *    actually drops. Costs a full re-trace, so it runs on export.
 */
function applyEdits(
  image: RasterImage,
  options: VectorizeOptions,
  base: VectorizeResult,
  plan: ColorEditPlan,
  exact: boolean
): VectorizeResult {
  const hasMerges = (plan.groups ?? []).some((group) => group.absorb.length > 0);
  const hasRemovals = (plan.remove ?? []).length > 0;

  if (!hasMerges && !hasRemovals) return base;

  if (exact && hasMerges) {
    return remergeWithPalette(image, options, base, plan);
  }

  const merged = hasMerges ? mergeLayersFast(base, { groups: plan.groups }) : base;
  return hasRemovals ? removeLayers(merged, plan.remove ?? []) : merged;
}

function renderExport(result: VectorizeResult, format: 'svg' | 'pdf' | 'eps' | 'dxf'): string {
  switch (format) {
    case 'svg':
      return emitSvg(result, { pretty: true });
    case 'pdf':
      return exportPdf(result);
    case 'eps':
      return exportEps(result);
    case 'dxf':
      return exportDxf(result);
  }
}

function summarize(result: VectorizeResult): TraceSummary {
  const svg = emitSvg(result);
  const totalArea = result.layers.reduce((sum, layer) => sum + layer.pixelCount, 0) || 1;

  const layers: LayerSummary[] = result.layers.map((layer) => ({
    index: layer.index,
    hex: layer.hex,
    name: layer.name,
    pieces: layer.shapes.length,
    strokes: layer.strokes.length,
    strokeWidth:
      layer.strokes.length > 0
        ? Math.round(
            (layer.strokes.reduce((sum, stroke) => sum + stroke.width, 0) / layer.strokes.length) *
              100
          ) / 100
        : null,
    nodes:
      layer.shapes.reduce(
        (sum, shape) =>
          sum + shape.contours.reduce((count, contour) => count + contour.segments.length, 0),
        0
      ) + layer.strokes.reduce((sum, stroke) => sum + stroke.segments.length, 0),
    areaShare: layer.pixelCount / totalArea,
    // WCAG relative luminance, so the swatch label stays readable on any colour.
    prefersLightText: relativeLuminance(layer.color) < 0.35,
  }));

  return {
    width: result.width,
    height: result.height,
    stats: result.stats,
    layers,
    svg,
    svgBytes: new TextEncoder().encode(svg).byteLength,
    suggestions: suggestMerges(result, 10),
    strokeReport: result.strokeReport,
  };
}

function reply(response: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
}
