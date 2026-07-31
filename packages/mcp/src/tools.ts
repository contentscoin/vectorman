import {
  PRESETS,
  analyzeImage,
  emitSvg,
  exportDxf,
  exportEps,
  exportPdf,
  hexToRgb,
  remergeWithPalette,
  removeLayers,
  resolvePreset,
  suggestMerges,
  vectorize,
  type ColorEditPlan,
  type ImageAnalysis,
  type VectorizeOptions,
  type VectorizeResult,
} from '@perfectvector/core';
import {
  formatBytes,
  loadRaster,
  rasterizeSvg,
  withExtension,
  writeOutput,
  type ImageSource,
} from './image.js';

/**
 * Tool implementations, kept free of MCP wiring so they can be exercised directly.
 *
 * Design note on responses: every tool returns both a human-readable summary and a
 * structured payload. The summary matters because a model reading "3 colors, 47
 * nodes, background removed" can immediately judge whether to adjust settings,
 * whereas a raw JSON dump of path data tells it nothing useful and burns context.
 */

export type OutputFormat = 'svg' | 'pdf' | 'eps' | 'dxf' | 'png' | 'jpeg';

export const OUTPUT_FORMATS: OutputFormat[] = ['svg', 'pdf', 'eps', 'dxf', 'png', 'jpeg'];

export const PRESET_IDS = PRESETS.map((p) => p.id);

/** Above this, an SVG is written to disk or truncated rather than inlined. */
const DEFAULT_MAX_INLINE_BYTES = 60_000;

export interface SettingsOverrides {
  maxColors?: number;
  detail?: number;
  smoothing?: number;
  denoise?: number;
  background?: 'auto' | 'keep' | 'remove';
  colorMergeThreshold?: number;
  maxDimension?: number;
  precision?: number;
  minArea?: number;
  strokeMode?: 'off' | 'auto' | 'force';
  minStrokeElongation?: number;
}

export interface VectorizeToolInput extends ImageSource, SettingsOverrides {
  preset?: string;
  format?: OutputFormat;
  outputPath?: string;
  includeContent?: boolean;
  maxInlineBytes?: number;
  /** Paint a background instead of leaving transparency. */
  backgroundColor?: string;
  /** For raster output: pixel width. Defaults to the source width. */
  rasterWidth?: number;
}

export interface LayerReport {
  hex: string;
  name: string;
  pieces: number;
  /** Recovered centreline paths, when stroke mode found any. */
  strokes: number;
  /** Stroke weight in source pixels, when this layer has centrelines. */
  strokeWidth: number | null;
  /** Share of the artwork this color covers, 0-1. */
  areaShare: number;
  nodes: number;
}

export interface VectorizeToolResult {
  summary: string;
  structured: {
    source: string;
    sourceFormat: string;
    width: number;
    height: number;
    preset: string;
    presetReason: string;
    settings: Record<string, unknown>;
    stats: {
      colors: number;
      pieces: number;
      strokes: number;
      nodes: number;
      nodesBeforeFitting: number;
      nodeReduction: string;
      elapsedMs: number;
      tracedWidth: number;
      tracedHeight: number;
    };
    strokeReport: VectorizeResult['strokeReport'];
    layers: LayerReport[];
    suitability: {
      verdict: ImageAnalysis['suitability'];
      classification: ImageAnalysis['classification'];
      score: number;
      warnings: string[];
    };
    output: {
      format: OutputFormat;
      path: string | null;
      bytes: number;
      inlined: boolean;
    };
    content?: string;
  };
}

export async function runVectorize(input: VectorizeToolInput): Promise<VectorizeToolResult> {
  const loaded = await loadRaster(input);
  const analysis = analyzeImage(loaded.image);

  const chosenPreset =
    !input.preset || input.preset === 'auto' ? analysis.recommended.presetId : input.preset;
  const presetReason =
    !input.preset || input.preset === 'auto'
      ? `auto-selected from image analysis: ${analysis.recommended.rationale}`
      : 'explicitly requested';

  const options: VectorizeOptions = resolvePreset(chosenPreset, {
    // The analyzer's recommendations apply only when the preset was auto-chosen,
    // so an explicit preset is never silently overridden.
    ...(input.preset && input.preset !== 'auto' ? {} : analysis.recommended.options),
    ...pickOverrides(input),
  });

  const result = vectorize(loaded.image, options);

  return buildResult({
    input,
    loaded,
    analysis,
    result,
    preset: chosenPreset,
    presetReason,
    options,
  });
}

export interface RefineToolInput extends VectorizeToolInput {
  /** Groups of colors to fuse. `keep` survives; each entry in `absorb` folds into it. */
  merge?: Array<{ keep: string; absorb: string[] }>;
  /** Colors to delete outright, becoming transparency. */
  remove?: string[];
  /** Merge every pair closer than this deltaE automatically. */
  autoMergeBelowDeltaE?: number;
}

export async function runRefine(input: RefineToolInput): Promise<VectorizeToolResult> {
  const loaded = await loadRaster(input);
  const analysis = analyzeImage(loaded.image);

  const chosenPreset =
    !input.preset || input.preset === 'auto' ? analysis.recommended.presetId : input.preset;
  const options: VectorizeOptions = resolvePreset(chosenPreset, {
    ...(input.preset && input.preset !== 'auto' ? {} : analysis.recommended.options),
    ...pickOverrides(input),
  });

  const base = vectorize(loaded.image, options);

  const plan: ColorEditPlan = {
    groups: (input.merge ?? []).map((group) => ({ keep: group.keep, absorb: group.absorb })),
    remove: input.remove ?? [],
  };

  if (input.autoMergeBelowDeltaE && input.autoMergeBelowDeltaE > 0) {
    // Fold the automatic suggestions in, without discarding explicit instructions.
    for (const suggestion of suggestMerges(base, input.autoMergeBelowDeltaE)) {
      const existing = plan.groups?.find((g) => sameHex(g.keep, suggestion.keep));
      if (existing) {
        if (!existing.absorb.some((hex) => sameHex(hex, suggestion.absorb))) {
          existing.absorb.push(suggestion.absorb);
        }
      } else {
        plan.groups?.push({ keep: suggestion.keep, absorb: [suggestion.absorb] });
      }
    }
  }

  validatePlanColors(plan, base);

  const hasMerges = (plan.groups ?? []).some((g) => g.absorb.length > 0);
  // Merging on the label map (a full re-run) is what actually removes the now
  // internal boundaries and drops the node count. Removal alone needs no re-run.
  const refined = hasMerges
    ? remergeWithPalette(loaded.image, options, base, plan)
    : removeLayers(base, plan.remove ?? []);

  const built = await buildResult({
    input,
    loaded,
    analysis,
    result: refined,
    preset: chosenPreset,
    presetReason: 'refined',
    options,
  });

  const nodeDelta = base.stats.nodes - refined.stats.nodes;
  built.summary =
    `Refined: ${base.stats.colors} colors -> ${refined.stats.colors}, ` +
    `${base.stats.nodes} nodes -> ${refined.stats.nodes}` +
    (nodeDelta > 0 ? ` (${Math.round((nodeDelta / base.stats.nodes) * 100)}% fewer)` : '') +
    `.\n\n${built.summary}`;

  return built;
}

export interface AnalyzeToolResult {
  summary: string;
  structured: ImageAnalysis & { source: string; sourceFormat: string; sourceBytes: number };
}

export async function runAnalyze(source: ImageSource): Promise<AnalyzeToolResult> {
  const loaded = await loadRaster(source);
  const analysis = analyzeImage(loaded.image);

  const lines: string[] = [
    `${loaded.image.width}x${loaded.image.height} ${loaded.format.toUpperCase()}, ${formatBytes(loaded.byteLength)}`,
    '',
    `Verdict: ${analysis.suitability.toUpperCase()} (score ${analysis.score}/100, classified as ${analysis.classification})`,
    '',
    'Findings:',
    ...analysis.findings.map((f) => `  [${f.level}] ${f.message}`),
    '',
    `Recommended preset: ${analysis.recommended.presetId}`,
    `  Why: ${analysis.recommended.rationale}`,
    `  Overrides: ${JSON.stringify(analysis.recommended.options)}`,
    '',
    'Measurements:',
    `  distinct colors: ${analysis.uniqueColors}${analysis.uniqueColorsCapped ? '+ (scan limit reached)' : ''}`,
    `  flat pixels: ${pct(analysis.flatRatio)}   soft transitions: ${pct(analysis.softEdgeRatio)}   hard edges: ${pct(analysis.hardEdgeRatio)}`,
    `  noise estimate: ${analysis.noiseEstimate.toFixed(3)}   transparency: ${pct(analysis.transparentRatio)}`,
  ];

  return {
    summary: lines.join('\n'),
    structured: {
      ...analysis,
      source: loaded.origin,
      sourceFormat: loaded.format,
      sourceBytes: loaded.byteLength,
    },
  };
}

export interface SuggestMergesToolResult {
  summary: string;
  structured: {
    source: string;
    preset: string;
    threshold: number;
    colors: Array<{ hex: string; name: string; areaShare: number; pieces: number }>;
    suggestions: Array<{ keep: string; absorb: string; deltaE: number; absorbedAreaShare: number }>;
    projected: { colorsAfter: number };
  };
}

export async function runSuggestMerges(
  input: ImageSource & SettingsOverrides & { preset?: string; threshold?: number }
): Promise<SuggestMergesToolResult> {
  const loaded = await loadRaster(input);
  const analysis = analyzeImage(loaded.image);
  const chosenPreset =
    !input.preset || input.preset === 'auto' ? analysis.recommended.presetId : input.preset;

  const options = resolvePreset(chosenPreset, {
    ...(input.preset && input.preset !== 'auto' ? {} : analysis.recommended.options),
    ...pickOverrides(input),
  });

  const result = vectorize(loaded.image, options);
  const threshold = input.threshold ?? 8;
  const suggestions = suggestMerges(result, threshold);

  const absorbed = new Set(suggestions.map((s) => s.absorb.toLowerCase()));
  const totalArea = result.layers.reduce((sum, l) => sum + l.pixelCount, 0) || 1;

  const lines = [
    `${result.stats.colors} color layers at preset "${chosenPreset}".`,
    '',
    'Layers:',
    ...result.layers.map(
      (l) =>
        `  ${l.hex}  ${l.name.padEnd(14)} ${pct(l.pixelCount / totalArea).padStart(6)} of area, ${l.shapes.length} piece(s)`
    ),
    '',
    suggestions.length === 0
      ? `No color pairs are within deltaE ${threshold}. Nothing worth merging.`
      : `${suggestions.length} merge candidate(s) within deltaE ${threshold}:`,
    ...suggestions.map(
      (s) =>
        `  ${s.absorb} -> ${s.keep}  (deltaE ${s.deltaE}, absorbed color covers ${pct(s.absorbedAreaShare)} of the artwork)`
    ),
  ];

  if (suggestions.length > 0) {
    lines.push(
      '',
      `Applying all of them would leave ${result.stats.colors - absorbed.size} colors. ` +
        `Pass them to refine_colors to re-run the trace with the merged palette, which also lowers the node count.`
    );
  }

  return {
    summary: lines.join('\n'),
    structured: {
      source: loaded.origin,
      preset: chosenPreset,
      threshold,
      colors: result.layers.map((l) => ({
        hex: l.hex,
        name: l.name,
        areaShare: round(l.pixelCount / totalArea, 4),
        pieces: l.shapes.length,
      })),
      suggestions,
      projected: { colorsAfter: result.stats.colors - absorbed.size },
    },
  };
}

export interface ComparePresetsToolResult {
  summary: string;
  structured: {
    source: string;
    recommended: string;
    rows: Array<{
      preset: string;
      colors: number;
      pieces: number;
      nodes: number;
      svgBytes: number;
      elapsedMs: number;
    }>;
  };
}

export async function runComparePresets(
  input: ImageSource & { presets?: string[] }
): Promise<ComparePresetsToolResult> {
  const loaded = await loadRaster(input);
  const analysis = analyzeImage(loaded.image);
  const ids = input.presets && input.presets.length > 0 ? input.presets : PRESET_IDS;

  const rows = ids.map((id) => {
    const result = vectorize(loaded.image, resolvePreset(id));
    const svg = emitSvg(result);
    return {
      preset: id,
      colors: result.stats.colors,
      pieces: result.stats.pieces,
      nodes: result.stats.nodes,
      svgBytes: Buffer.byteLength(svg, 'utf8'),
      elapsedMs: result.stats.elapsedMs,
    };
  });

  const header = 'preset        colors  pieces   nodes    svg     ms';
  const lines = [
    `${loaded.image.width}x${loaded.image.height}, classified as ${analysis.classification}. ` +
      `Analyzer recommends "${analysis.recommended.presetId}".`,
    '',
    header,
    '-'.repeat(header.length),
    ...rows.map(
      (r) =>
        `${r.preset.padEnd(13)} ${String(r.colors).padStart(6)} ${String(r.pieces).padStart(7)} ` +
        `${String(r.nodes).padStart(7)} ${formatBytes(r.svgBytes).padStart(8)} ${String(r.elapsedMs).padStart(6)}`
    ),
    '',
    'Fewer nodes is easier to edit; more pieces usually means the palette is too large for the artwork.',
  ];

  return {
    summary: lines.join('\n'),
    structured: { source: loaded.origin, recommended: analysis.recommended.presetId, rows },
  };
}

/** One file's worth of work, as handed to a pool worker. Must be structured-cloneable. */
export interface BatchFileTask {
  id: number;
  path: string;
  /** Where to write, or null for a dry run. */
  outputPath: string | null;
  preset?: string;
  overrides: SettingsOverrides;
  format: OutputFormat;
  /**
   * Skip the file when the analyzer scores it below this. 0 converts everything.
   * Batches are where this matters most: converting 200 photographs produces 200
   * useless files and takes the longest, since photos are also the slowest to trace.
   */
  minScore: number;
  backgroundColor?: string;
  rasterWidth?: number;
}

export interface BatchFileResult {
  id: number;
  path: string;
  status: 'converted' | 'skipped' | 'failed';
  /** Why it was skipped or how it failed. */
  reason?: string;
  outputPath?: string | null;
  outputBytes?: number;
  preset?: string;
  width?: number;
  height?: number;
  colors?: number;
  pieces?: number;
  strokes?: number;
  nodes?: number;
  /** Regions with visible pixels that produced no geometry. Should always be 0. */
  droppedRegions?: number;
  /** Regions whose outer/hole classification was inconsistent and got repaired. */
  repairedRegions?: number;
  score?: number;
  classification?: string;
  suitability?: string;
  elapsedMs: number;
}

/**
 * Convert one file for a batch run.
 *
 * Every failure is captured and returned rather than thrown. In a batch, one
 * unreadable file must not take the other ninety-nine with it, and the caller needs
 * to know *which* file failed and why — an exception that unwinds the whole run
 * tells them neither.
 *
 * This deliberately reuses the same loading, preset selection and rendering path as
 * the single-file tool, so a batch cannot quietly produce different output from
 * converting the same image on its own.
 */
export async function convertForBatch(task: BatchFileTask): Promise<BatchFileResult> {
  const startedAt = Date.now();

  try {
    const loaded = await loadRaster({ path: task.path });
    const analysis = analyzeImage(loaded.image);

    if (task.minScore > 0 && analysis.score < task.minScore) {
      return {
        id: task.id,
        path: task.path,
        status: 'skipped',
        reason:
          `scored ${analysis.score}/100 (${analysis.classification}), below the ${task.minScore} threshold` +
          (analysis.classification === 'photo' ? ' — a photograph cannot be traced usefully' : ''),
        score: analysis.score,
        classification: analysis.classification,
        suitability: analysis.suitability,
        width: loaded.image.width,
        height: loaded.image.height,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const explicitPreset = task.preset && task.preset !== 'auto';
    const presetId = explicitPreset ? (task.preset as string) : analysis.recommended.presetId;
    const options = resolvePreset(presetId, {
      ...(explicitPreset ? {} : analysis.recommended.options),
      ...pickOverrides(task.overrides),
    });

    const result = vectorize(loaded.image, options);
    const svg = emitSvg(result, { backgroundColor: task.backgroundColor ?? null });
    const rendered = await renderFormat(task.format, result, svg, {
      backgroundColor: task.backgroundColor,
      rasterWidth: task.rasterWidth,
    });

    let outputPath: string | null = null;
    if (task.outputPath) {
      outputPath = await writeOutput(task.outputPath, rendered.data);
    }

    return {
      id: task.id,
      path: task.path,
      status: 'converted',
      outputPath,
      outputBytes: rendered.byteLength,
      preset: presetId,
      width: result.width,
      height: result.height,
      colors: result.stats.colors,
      pieces: result.stats.pieces,
      strokes: result.stats.strokes,
      nodes: result.stats.nodes,
      droppedRegions: result.stats.droppedRegions,
      repairedRegions: result.stats.repairedRegions,
      score: analysis.score,
      classification: analysis.classification,
      suitability: analysis.suitability,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id: task.id,
      path: task.path,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export function runListPresets(): { summary: string; structured: unknown } {
  const lines = ['Available presets:', ''];
  for (const preset of PRESETS) {
    lines.push(`${preset.id} — ${preset.label}`);
    lines.push(`  ${preset.description}`);
    lines.push(`  ${JSON.stringify(preset.options)}`);
    lines.push('');
  }
  lines.push('Pass preset "auto" (the default) to let image analysis choose.');

  return {
    summary: lines.join('\n'),
    structured: {
      presets: PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        options: p.options,
      })),
    },
  };
}

// ---------------------------------------------------------------------------

interface BuildResultArgs {
  input: VectorizeToolInput;
  loaded: Awaited<ReturnType<typeof loadRaster>>;
  analysis: ImageAnalysis;
  result: VectorizeResult;
  preset: string;
  presetReason: string;
  options: VectorizeOptions;
}

async function buildResult(args: BuildResultArgs): Promise<VectorizeToolResult> {
  const { input, loaded, analysis, result, preset, presetReason, options } = args;
  const format: OutputFormat = input.format ?? 'svg';

  const svg = emitSvg(result, {
    backgroundColor: input.backgroundColor ?? null,
    pretty: format === 'svg' && !input.outputPath,
  });

  const rendered = await renderFormat(format, result, svg, input);

  let outputPath: string | null = null;
  if (input.outputPath) {
    outputPath = await writeOutput(withExtension(input.outputPath, extensionFor(format)), rendered.data);
  }

  const maxInline = input.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const wantsContent = input.includeContent ?? outputPath === null;
  const canInline = rendered.isText && rendered.byteLength <= maxInline;
  const inlined = wantsContent && canInline;

  const totalArea = result.layers.reduce((sum, l) => sum + l.pixelCount, 0) || 1;
  const layers: LayerReport[] = result.layers.map((layer) => ({
    hex: layer.hex,
    name: layer.name,
    pieces: layer.shapes.length,
    strokes: layer.strokes.length,
    strokeWidth:
      layer.strokes.length > 0
        ? round(layer.strokes.reduce((sum, s) => sum + s.width, 0) / layer.strokes.length, 2)
        : null,
    areaShare: round(layer.pixelCount / totalArea, 4),
    nodes:
      layer.shapes.reduce(
        (sum, shape) => sum + shape.contours.reduce((c, contour) => c + contour.segments.length, 0),
        0
      ) + layer.strokes.reduce((sum, stroke) => sum + stroke.segments.length, 0),
  }));

  const warnings = analysis.findings
    .filter((f) => f.level !== 'info')
    .map((f) => f.message);

  const reduction =
    result.stats.nodesBeforeFitting > 0
      ? `${(result.stats.nodesBeforeFitting / Math.max(1, result.stats.nodes)).toFixed(1)}x fewer than a pixel-following trace`
      : 'n/a';

  const strokeSummary =
    result.stats.strokes > 0
      ? `   centrelines: ${result.stats.strokes}` +
        (result.strokeReport.medianWidth !== null
          ? ` (median width ${result.strokeReport.medianWidth}px)`
          : '')
      : '';

  const summaryLines: string[] = [
    `Vectorized ${loaded.image.width}x${loaded.image.height} ${loaded.format.toUpperCase()} ` +
      `using preset "${preset}" (${presetReason}).`,
    '',
    `  colors: ${result.stats.colors}   pieces: ${result.stats.pieces}${strokeSummary}   ` +
      `nodes: ${result.stats.nodes} (${reduction})`,
    `  traced at ${result.stats.tracedWidth}x${result.stats.tracedHeight} in ${result.stats.elapsedMs}ms`,
    `  output: ${format.toUpperCase()}, ${formatBytes(rendered.byteLength)}`,
    '',
    'Color layers:',
    ...layers.map(
      (l) =>
        `  ${l.hex}  ${l.name.padEnd(14)} ${pct(l.areaShare).padStart(6)} of area, ` +
        (l.strokes > 0
          ? `${l.strokes} centreline(s) at ${l.strokeWidth}px, ${l.nodes} nodes`
          : `${l.pieces} piece(s), ${l.nodes} nodes`)
    ),
  ];

  if (result.strokeReport.blockedByNeighbours > 0) {
    summaryLines.push(
      '',
      `${result.strokeReport.blockedByNeighbours} thin region(s) were left as filled outlines ` +
        `because they border another colour — replacing such a fill with a stroke would open a gap ` +
        `between the two. Removing the background usually unblocks them.`
    );
  }

  if (warnings.length > 0) {
    summaryLines.push('', 'Suitability warnings:', ...warnings.map((w) => `  - ${w}`));
  }

  if (outputPath) {
    summaryLines.push('', `Written to ${outputPath}`);
  } else if (!canInline && wantsContent) {
    summaryLines.push(
      '',
      rendered.isText
        ? `Content is ${formatBytes(rendered.byteLength)}, above the ${formatBytes(maxInline)} inline limit. ` +
            `Pass outputPath to write it, or raise maxInlineBytes.`
        : `${format.toUpperCase()} is binary. Pass outputPath to write it to disk.`
    );
  }

  const structured: VectorizeToolResult['structured'] = {
    source: loaded.origin,
    sourceFormat: loaded.format,
    width: result.width,
    height: result.height,
    preset,
    presetReason,
    settings: options as Record<string, unknown>,
    stats: {
      colors: result.stats.colors,
      pieces: result.stats.pieces,
      strokes: result.stats.strokes,
      nodes: result.stats.nodes,
      nodesBeforeFitting: result.stats.nodesBeforeFitting,
      nodeReduction: reduction,
      elapsedMs: result.stats.elapsedMs,
      tracedWidth: result.stats.tracedWidth,
      tracedHeight: result.stats.tracedHeight,
    },
    strokeReport: result.strokeReport,
    layers,
    suitability: {
      verdict: analysis.suitability,
      classification: analysis.classification,
      score: analysis.score,
      warnings,
    },
    output: {
      format,
      path: outputPath,
      bytes: rendered.byteLength,
      inlined,
    },
  };

  if (inlined) {
    structured.content = rendered.data.toString();
  }

  return { summary: summaryLines.join('\n'), structured };
}

interface RenderedOutput {
  data: string | Buffer;
  byteLength: number;
  isText: boolean;
}

async function renderFormat(
  format: OutputFormat,
  result: VectorizeResult,
  svg: string,
  input: VectorizeToolInput
): Promise<RenderedOutput> {
  switch (format) {
    case 'svg':
      return { data: svg, byteLength: Buffer.byteLength(svg, 'utf8'), isText: true };
    case 'pdf': {
      const pdf = exportPdf(result, { backgroundColor: input.backgroundColor ?? null });
      return { data: pdf, byteLength: Buffer.byteLength(pdf, 'latin1'), isText: true };
    }
    case 'eps': {
      const eps = exportEps(result, { backgroundColor: input.backgroundColor ?? null });
      return { data: eps, byteLength: Buffer.byteLength(eps, 'utf8'), isText: true };
    }
    case 'dxf': {
      const dxf = exportDxf(result);
      return { data: dxf, byteLength: Buffer.byteLength(dxf, 'utf8'), isText: true };
    }
    case 'png':
    case 'jpeg': {
      const buffer = await rasterizeSvg(svg, format, {
        width: input.rasterWidth,
        background: input.backgroundColor,
      });
      return { data: buffer, byteLength: buffer.byteLength, isText: false };
    }
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function extensionFor(format: OutputFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function pickOverrides(input: SettingsOverrides): VectorizeOptions {
  const overrides: VectorizeOptions = {};
  if (input.maxColors !== undefined) overrides.maxColors = input.maxColors;
  if (input.detail !== undefined) overrides.detail = input.detail;
  if (input.smoothing !== undefined) overrides.smoothing = input.smoothing;
  if (input.denoise !== undefined) overrides.denoise = input.denoise;
  if (input.background !== undefined) overrides.background = input.background;
  if (input.colorMergeThreshold !== undefined) {
    overrides.colorMergeThreshold = input.colorMergeThreshold;
  }
  if (input.maxDimension !== undefined) overrides.maxDimension = input.maxDimension;
  if (input.precision !== undefined) overrides.precision = input.precision;
  if (input.minArea !== undefined) overrides.minArea = input.minArea;
  if (input.strokeMode !== undefined) overrides.strokeMode = input.strokeMode;
  if (input.minStrokeElongation !== undefined) {
    overrides.minStrokeElongation = input.minStrokeElongation;
  }
  return overrides;
}

/**
 * Reject colors that are not in the traced result.
 *
 * Without this a typo in a hex value silently does nothing, and the caller is left
 * comparing node counts trying to work out why. Listing the actual palette in the
 * error makes the fix obvious.
 */
function validatePlanColors(plan: ColorEditPlan, result: VectorizeResult): void {
  const available = new Set(result.layers.map((l) => l.hex.toLowerCase()));
  const unknown: string[] = [];

  const check = (hex: string) => {
    let normalized: string;
    try {
      const rgb = hexToRgb(hex);
      normalized = `#${[rgb.r, rgb.g, rgb.b]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`;
    } catch {
      unknown.push(`${hex} (not a valid hex color)`);
      return;
    }
    if (!available.has(normalized)) unknown.push(hex);
  };

  for (const group of plan.groups ?? []) {
    check(group.keep);
    group.absorb.forEach(check);
  }
  (plan.remove ?? []).forEach(check);

  if (unknown.length > 0) {
    throw new Error(
      `These colors are not in the traced palette: ${unknown.join(', ')}. ` +
        `Available: ${result.layers.map((l) => l.hex).join(', ')}. ` +
        `Run suggest_color_merges first to see the palette for these settings.`
    );
  }
}

function sameHex(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
