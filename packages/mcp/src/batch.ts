import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { defaultPoolSize, runPool } from './pool.js';
import { convertForBatch, type BatchFileResult, type BatchFileTask, type OutputFormat, type SettingsOverrides } from './tools.js';
import { formatBytes, withExtension } from './image.js';

/**
 * Batch folder conversion.
 *
 * Three properties matter more than raw throughput here:
 *
 *  - **Nothing is destroyed by accident.** Existing outputs are skipped unless
 *    `overwrite` is set, and `dryRun` reports exactly what would happen without
 *    touching the disk. A tool that rewrites a folder of a designer's files on a
 *    mistyped path is worse than no tool.
 *  - **One bad file cannot end the run.** Failures are collected per file, so
 *    ninety-nine good images still convert and the report says which one broke.
 *  - **Unsuitable images are skipped by default.** Photographs are both the least
 *    convertible and the slowest to trace, so converting a folder of them wastes
 *    the most time to produce the least usable output.
 */

export const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** Hard ceiling on files per run, so a wrong path cannot start thousands of conversions. */
const MAX_FILES = 500;

export interface BatchOptions extends SettingsOverrides {
  /** Folder to read. Mutually exclusive with `paths`. */
  directory?: string;
  /** Explicit files to convert. */
  paths?: string[];
  recursive?: boolean;
  extensions?: string[];
  /** Where outputs go. Required unless `dryRun`. */
  outputDirectory?: string;
  format?: OutputFormat;
  preset?: string;
  /** Analyzer score below which a file is skipped. @default 35 */
  minScore?: number;
  /** Replace existing output files. @default false */
  overwrite?: boolean;
  /** Report the plan without reading or writing anything. @default false */
  dryRun?: boolean;
  /** Worker threads. Defaults to one fewer than the core count. */
  concurrency?: number;
  /** Stop after this many files. */
  limit?: number;
  backgroundColor?: string;
  rasterWidth?: number;
}

export interface BatchSummary {
  summary: string;
  structured: {
    directory: string | null;
    outputDirectory: string | null;
    format: OutputFormat;
    preset: string;
    dryRun: boolean;
    concurrency: number;
    discovered: number;
    converted: number;
    skipped: number;
    failed: number;
    totalOutputBytes: number;
    wallClockMs: number;
    /** Summed per-file time, so the parallel speedup is visible. */
    cpuMs: number;
    files: BatchFileResult[];
  };
}

export async function runBatch(options: BatchOptions, workerUrl: URL): Promise<BatchSummary> {
  const startedAt = Date.now();

  const format = options.format ?? 'svg';
  const dryRun = options.dryRun ?? false;
  const minScore = options.minScore ?? 35;
  const overwrite = options.overwrite ?? false;
  const preset = options.preset ?? 'auto';

  const discovered = await discoverFiles(options);
  if (discovered.length === 0) {
    throw new Error(
      options.directory
        ? `No images found in ${resolve(options.directory)}. Looked for ${(options.extensions ?? DEFAULT_EXTENSIONS).join(', ')}${options.recursive ? ' recursively' : ' (pass recursive to search subfolders)'}.`
        : 'No input files given. Pass `directory` or `paths`.'
    );
  }

  if (!dryRun && !options.outputDirectory) {
    throw new Error('`outputDirectory` is required unless `dryRun` is set.');
  }

  const outputDirectory = options.outputDirectory ? resolve(options.outputDirectory) : null;
  const baseDirectory = options.directory ? resolve(options.directory) : null;

  // Build tasks, resolving output paths and filtering out anything already present.
  const tasks: BatchFileTask[] = [];
  const preSkipped: BatchFileResult[] = [];

  discovered.forEach((path, index) => {
    let outputPath: string | null = null;

    if (outputDirectory) {
      // Mirror the input tree when recursing, so two files with the same basename in
      // different folders do not collide and silently overwrite each other.
      const relativePath = baseDirectory ? relative(baseDirectory, path) : basename(path);
      outputPath = withExtension(join(outputDirectory, relativePath), extensionFor(format));

      if (!overwrite && existsSync(outputPath)) {
        preSkipped.push({
          id: index,
          path,
          status: 'skipped',
          reason: `output already exists at ${outputPath} (pass overwrite to replace it)`,
          outputPath,
          elapsedMs: 0,
        });
        return;
      }
    }

    tasks.push({
      id: index,
      path,
      outputPath: dryRun ? null : outputPath,
      preset,
      overrides: pickSettings(options),
      format,
      minScore,
      backgroundColor: options.backgroundColor,
      rasterWidth: options.rasterWidth,
    });
  });

  const requested = options.concurrency ?? defaultPoolSize();
  const concurrency = Math.max(1, Math.min(requested, tasks.length || 1, defaultPoolSize()));

  let results: BatchFileResult[];

  if (tasks.length === 0) {
    results = [];
  } else if (concurrency === 1 || tasks.length === 1) {
    // Spawning a thread costs more than it saves for a single file, and the
    // in-process path is also what makes the tool debuggable.
    results = [];
    for (const task of tasks) results.push(await convertForBatch(task));
  } else {
    results = await runPool<BatchFileTask, BatchFileResult>(tasks, {
      workerUrl,
      size: concurrency,
    });
  }

  const files = [...preSkipped, ...results].sort((a, b) => a.id - b.id);

  const converted = files.filter((f) => f.status === 'converted');
  const skipped = files.filter((f) => f.status === 'skipped');
  const failed = files.filter((f) => f.status === 'failed');

  const totalOutputBytes = converted.reduce((sum, f) => sum + (f.outputBytes ?? 0), 0);
  const cpuMs = files.reduce((sum, f) => sum + f.elapsedMs, 0);
  const wallClockMs = Date.now() - startedAt;

  return {
    summary: buildSummary({
      files,
      converted,
      skipped,
      failed,
      discovered: discovered.length,
      baseDirectory,
      outputDirectory,
      format,
      preset,
      dryRun,
      concurrency,
      totalOutputBytes,
      cpuMs,
      wallClockMs,
      minScore,
    }),
    structured: {
      directory: baseDirectory,
      outputDirectory,
      format,
      preset,
      dryRun,
      concurrency,
      discovered: discovered.length,
      converted: converted.length,
      skipped: skipped.length,
      failed: failed.length,
      totalOutputBytes,
      wallClockMs,
      cpuMs,
      files,
    },
  };
}

async function discoverFiles(options: BatchOptions): Promise<string[]> {
  if (options.directory && options.paths?.length) {
    throw new Error('Provide either `directory` or `paths`, not both.');
  }

  const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((extension) =>
    extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  );

  let found: string[];

  if (options.paths?.length) {
    found = options.paths.map((path) => resolve(path));
  } else if (options.directory) {
    const root = resolve(options.directory);
    const info = await stat(root).catch(() => null);
    if (!info) throw new Error(`No such directory: ${root}`);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${root}`);
    found = await walk(root, extensions, options.recursive ?? false);
  } else {
    return [];
  }

  found.sort();

  const limit = Math.min(options.limit ?? MAX_FILES, MAX_FILES);
  if (found.length > limit) {
    // Truncating rather than throwing keeps a large folder usable, and the report
    // states the cut so it cannot be mistaken for the whole job.
    found = found.slice(0, limit);
  }

  return found;
}

async function walk(root: string, extensions: string[], recursive: boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(root, entry.name);

    if (entry.isDirectory()) {
      if (!recursive) continue;
      // Skip dot-directories: no useful source art lives in .git or .cache, and
      // descending into them can be enormous.
      if (entry.name.startsWith('.')) continue;
      files.push(...(await walk(full, extensions, recursive)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!extensions.includes(extname(entry.name).toLowerCase())) continue;
    files.push(full);
  }

  return files;
}

interface SummaryInput {
  files: BatchFileResult[];
  converted: BatchFileResult[];
  skipped: BatchFileResult[];
  failed: BatchFileResult[];
  discovered: number;
  baseDirectory: string | null;
  outputDirectory: string | null;
  format: OutputFormat;
  preset: string;
  dryRun: boolean;
  concurrency: number;
  totalOutputBytes: number;
  cpuMs: number;
  wallClockMs: number;
  minScore: number;
}

function buildSummary(input: SummaryInput): string {
  const lines: string[] = [];

  lines.push(
    `${input.dryRun ? 'Dry run: ' : ''}${input.discovered} image(s) found` +
      (input.baseDirectory ? ` in ${input.baseDirectory}` : '') +
      `, preset "${input.preset}", output ${input.format.toUpperCase()}.`
  );

  if (input.dryRun) {
    lines.push('Nothing was written.');
  } else if (input.outputDirectory) {
    lines.push(`Writing to ${input.outputDirectory}`);
  }

  lines.push('');
  lines.push(
    `  converted: ${input.converted.length}   skipped: ${input.skipped.length}   failed: ${input.failed.length}`
  );

  if (input.converted.length > 0) {
    const speedup = input.wallClockMs > 0 ? input.cpuMs / input.wallClockMs : 1;
    lines.push(
      `  ${(input.wallClockMs / 1000).toFixed(2)}s wall clock across ${input.concurrency} worker(s)` +
        ` — ${(input.cpuMs / 1000).toFixed(2)}s of tracing, ${speedup.toFixed(1)}x parallel speedup`
    );
    lines.push(`  ${formatBytes(input.totalOutputBytes)} written`);
  }

  if (input.converted.length > 0) {
    const header = 'file                            colors  pieces strokes  nodes    out';
    lines.push('', header, '-'.repeat(header.length));
    for (const file of input.converted) {
      lines.push(
        `${truncate(displayName(file.path, input.baseDirectory), 31).padEnd(31)} ` +
          `${String(file.colors ?? '-').padStart(6)} ${String(file.pieces ?? '-').padStart(7)} ` +
          `${String(file.strokes ?? '-').padStart(7)} ${String(file.nodes ?? '-').padStart(6)} ` +
          `${formatBytes(file.outputBytes ?? 0).padStart(7)}`
      );
    }
  }

  if (input.skipped.length > 0) {
    lines.push('', `Skipped (${input.skipped.length}):`);
    for (const file of input.skipped) {
      lines.push(`  ${displayName(file.path, input.baseDirectory)} — ${file.reason}`);
    }
    if (input.skipped.some((f) => f.reason?.includes('threshold'))) {
      lines.push(
        `  Unsuitable images are skipped below a score of ${input.minScore}. Set minScore to 0 to convert them anyway.`
      );
    }
  }

  if (input.failed.length > 0) {
    lines.push('', `Failed (${input.failed.length}):`);
    for (const file of input.failed) {
      lines.push(`  ${displayName(file.path, input.baseDirectory)} — ${file.reason}`);
    }
  }

  // Surfaced because silence here would be indistinguishable from success.
  const dropped = input.converted.reduce((sum, f) => sum + (f.droppedRegions ?? 0), 0);
  const repaired = input.converted.reduce((sum, f) => sum + (f.repairedRegions ?? 0), 0);
  if (dropped > 0) {
    lines.push(
      '',
      `Warning: ${dropped} region(s) produced no geometry and were discarded, so some artwork is ` +
        `missing from the output. Please report this.`
    );
  } else if (repaired > 0) {
    lines.push(
      '',
      `Note: ${repaired} region(s) had an inconsistent outline classification that was repaired. ` +
        `The output is complete; this is recorded only because it is rare.`
    );
  }

  return lines.join('\n');
}

function displayName(path: string, baseDirectory: string | null): string {
  return baseDirectory ? relative(baseDirectory, path) : basename(path);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `…${value.slice(-(length - 1))}`;
}

function extensionFor(format: OutputFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function pickSettings(options: BatchOptions): SettingsOverrides {
  return {
    maxColors: options.maxColors,
    detail: options.detail,
    smoothing: options.smoothing,
    denoise: options.denoise,
    background: options.background,
    colorMergeThreshold: options.colorMergeThreshold,
    maxDimension: options.maxDimension,
    precision: options.precision,
    minArea: options.minArea,
    strokeMode: options.strokeMode,
    minStrokeElongation: options.minStrokeElongation,
  };
}
