import type {
  ColorEditPlan,
  ImageAnalysis,
  StrokeReport,
  SuggestedMerge,
  VectorizeOptions,
  VectorizeStats,
} from '@perfectvector/core';

/**
 * Worker protocol.
 *
 * The worker is *stateful*: it holds the decoded pixels and the traced geometry,
 * and the main thread only ever receives summaries plus the rendered SVG string.
 *
 * That split is the important design decision. A traced result contains every
 * anchor and control point of every contour, which is far larger than the SVG it
 * produces. Shipping it across the thread boundary on every settings change would
 * cost more in structured-clone time than the tracing itself, and would leave the
 * main thread holding a large object it cannot do anything useful with. Exports
 * therefore also run in the worker, where the geometry already lives.
 */

/** Everything the UI needs about one color layer. Geometry stays in the worker. */
export interface LayerSummary {
  index: number;
  hex: string;
  name: string;
  pieces: number;
  /** Recovered centreline paths, when stroke recovery found any. */
  strokes: number;
  /** Stroke weight in source pixels, when this layer has centrelines. */
  strokeWidth: number | null;
  nodes: number;
  /** Share of the traced artwork this color covers, 0-1. */
  areaShare: number;
  /** True when white text is more readable than black on this swatch. */
  prefersLightText: boolean;
}

export interface TraceSummary {
  width: number;
  height: number;
  stats: VectorizeStats;
  layers: LayerSummary[];
  svg: string;
  svgBytes: number;
  suggestions: SuggestedMerge[];
  strokeReport: StrokeReport;
}

export type ExportFormat = 'svg' | 'pdf' | 'eps' | 'dxf';

export type WorkerRequest =
  | {
      id: number;
      type: 'load';
      width: number;
      height: number;
      /** RGBA bytes, transferred rather than copied. */
      pixels: ArrayBuffer;
    }
  | { id: number; type: 'trace'; options: VectorizeOptions }
  | { id: number; type: 'edit'; plan: ColorEditPlan; exact: boolean }
  | { id: number; type: 'export'; format: ExportFormat }
  | { id: number; type: 'reset' };

export type WorkerResponse =
  | { id: number; ok: true; type: 'load'; analysis: ImageAnalysis }
  | { id: number; ok: true; type: 'trace'; summary: TraceSummary }
  | { id: number; ok: true; type: 'edit'; summary: TraceSummary }
  | { id: number; ok: true; type: 'export'; format: ExportFormat; text: string }
  | { id: number; ok: true; type: 'reset' }
  | { id: number; ok: false; error: string };
