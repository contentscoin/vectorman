import { PRESETS, type VectorizeOptions } from '@perfectvector/core';

/**
 * Saved presets, stored in the browser.
 *
 * Kept local rather than synced to an account, because conversion itself is local —
 * introducing a server just to hold six numbers would mean uploads, accounts and a
 * privacy story, to solve a problem that `localStorage` already solves.
 *
 * Everything read back out is validated. `localStorage` is shared with anything else
 * on the origin and survives across versions of this code, so its contents are
 * untrusted input: a stale or hand-edited entry must not be able to crash the studio
 * or feed nonsense into the engine.
 */

const STORAGE_KEY = 'perfectvector.presets.v1';
const MAX_PRESETS = 24;
const MAX_LABEL_LENGTH = 40;

export const CUSTOM_PREFIX = 'custom:';

export interface CustomPreset {
  /** Always prefixed with `custom:` so it cannot collide with a built-in id. */
  id: string;
  label: string;
  /** Fully resolved options, so a saved preset keeps working if a built-in changes. */
  options: VectorizeOptions;
  createdAt: number;
}

/** Numeric settings, with the range each is clamped to on load. */
const NUMERIC_BOUNDS: Record<string, [number, number]> = {
  maxColors: [1, 256],
  detail: [0, 100],
  smoothing: [0, 100],
  denoise: [0, 100],
  colorMergeThreshold: [0, 50],
  maxDimension: [64, 8192],
  precision: [0, 6],
  minArea: [1, 1_000_000],
  minStrokeElongation: [1, 50],
};

export function loadCustomPresets(): CustomPreset[] {
  if (typeof window === 'undefined') return [];

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be disabled entirely, e.g. in private mode with cookies blocked.
    return [];
  }
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitize)
      .filter((preset): preset is CustomPreset => preset !== null)
      .slice(0, MAX_PRESETS);
  } catch {
    return [];
  }
}

function sanitize(value: unknown): CustomPreset | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const id = typeof candidate.id === 'string' ? candidate.id : '';
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  if (!id.startsWith(CUSTOM_PREFIX) || label.length === 0) return null;

  const rawOptions =
    typeof candidate.options === 'object' && candidate.options !== null
      ? (candidate.options as Record<string, unknown>)
      : {};

  const options: VectorizeOptions = {};

  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const raw = rawOptions[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    (options as Record<string, number>)[key] = Math.max(min, Math.min(max, raw));
  }

  if (rawOptions.background === 'auto' || rawOptions.background === 'keep' || rawOptions.background === 'remove') {
    options.background = rawOptions.background;
  }
  if (rawOptions.strokeMode === 'off' || rawOptions.strokeMode === 'auto' || rawOptions.strokeMode === 'force') {
    options.strokeMode = rawOptions.strokeMode;
  }

  // A preset that carries no recognised setting would silently do nothing.
  if (Object.keys(options).length === 0) return null;

  return {
    id,
    label: label.slice(0, MAX_LABEL_LENGTH),
    options,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
  };
}

function persist(presets: CustomPreset[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Quota exceeded or storage disabled. Losing a saved preset is not worth
    // interrupting a conversion over.
  }
}

export function saveCustomPreset(
  existing: CustomPreset[],
  label: string,
  options: VectorizeOptions
): CustomPreset[] {
  const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH) || 'Untitled preset';

  const preset: CustomPreset = {
    id: `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    label: uniqueLabel(trimmed, existing),
    options,
    createdAt: Date.now(),
  };

  // Newest first, oldest dropped past the cap.
  const next = [preset, ...existing].slice(0, MAX_PRESETS);
  persist(next);
  return next;
}

export function deleteCustomPreset(existing: CustomPreset[], id: string): CustomPreset[] {
  const next = existing.filter((preset) => preset.id !== id);
  persist(next);
  return next;
}

/**
 * Disambiguate against both saved and built-in names, so the preset list never shows
 * two identical labels and a save never appears to silently overwrite another.
 */
function uniqueLabel(label: string, existing: CustomPreset[]): string {
  const taken = new Set([
    ...existing.map((preset) => preset.label.toLowerCase()),
    ...PRESETS.map((preset) => preset.label.toLowerCase()),
  ]);

  if (!taken.has(label.toLowerCase())) return label;

  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${label} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${label} ${Date.now().toString(36)}`;
}

/** Describe a saved preset's settings compactly, for a tooltip. */
export function describeOptions(options: VectorizeOptions): string {
  const parts: string[] = [];
  if (options.maxColors !== undefined) parts.push(`${options.maxColors} colors`);
  if (options.detail !== undefined) parts.push(`detail ${options.detail}`);
  if (options.smoothing !== undefined) parts.push(`smoothing ${options.smoothing}`);
  if (options.denoise !== undefined) parts.push(`denoise ${options.denoise}`);
  if (options.colorMergeThreshold !== undefined) parts.push(`merge ${options.colorMergeThreshold}`);
  if (options.background) parts.push(`background ${options.background}`);
  if (options.strokeMode && options.strokeMode !== 'off') parts.push(`strokes ${options.strokeMode}`);
  return parts.join(' · ');
}
