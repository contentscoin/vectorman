'use client';

import type { SuggestedMerge } from '@perfectvector/core';
import type { LayerSummary } from '@/worker/protocol';
import { classNames, formatCount, formatPercent } from '@/lib/format';

interface LayerPanelProps {
  layers: LayerSummary[];
  suggestions: SuggestedMerge[];
  removed: string[];
  mergeTargets: Record<string, string>;
  onToggleRemove: (hex: string) => void;
  onMerge: (keep: string, absorb: string) => void;
  onUnmergeAll: () => void;
  onApplySuggestions: () => void;
  disabled?: boolean;
}

/**
 * The color layer list.
 *
 * This is where "every color already on its own layer" stops being a claim and
 * becomes something you can act on: each row is a real `<g>` in the output, with
 * its own piece and node counts, and can be merged into another or dropped
 * entirely.
 */
export function LayerPanel({
  layers,
  suggestions,
  removed,
  mergeTargets,
  onToggleRemove,
  onMerge,
  onUnmergeAll,
  onApplySuggestions,
  disabled,
}: LayerPanelProps) {
  const mergeCount = Object.keys(mergeTargets).length;
  const pendingSuggestions = suggestions.filter(
    (s) => !mergeTargets[s.absorb.toLowerCase()] && !removed.includes(s.absorb.toLowerCase())
  );

  return (
    <div className={classNames('flex flex-col gap-3', disabled && 'pointer-events-none opacity-60')}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">
          Color layers
          <span className="ml-1.5 font-mono text-ink-500">{layers.length}</span>
        </h3>
        {(mergeCount > 0 || removed.length > 0) && (
          <button
            type="button"
            onClick={onUnmergeAll}
            className="text-xs text-accent hover:text-accent-bright"
          >
            Undo edits
          </button>
        )}
      </div>

      {pendingSuggestions.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/5 p-3">
          <p className="text-xs leading-relaxed text-ink-200">
            <span className="font-semibold text-warn">
              {pendingSuggestions.length} near-duplicate{' '}
              {pendingSuggestions.length === 1 ? 'color' : 'colors'}
            </span>{' '}
            — close enough that most people would not see the difference in print.
          </p>
          <button
            type="button"
            onClick={onApplySuggestions}
            className="mt-2 rounded-md border border-warn/40 px-2.5 py-1 text-xs font-medium text-warn transition-colors hover:bg-warn/10"
          >
            Merge them
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {layers.map((layer) => {
          const key = layer.hex.toLowerCase();
          const isRemoved = removed.includes(key);

          return (
            <li
              key={layer.hex}
              className={classNames(
                'group rounded-lg border p-2 transition-colors',
                isRemoved
                  ? 'border-ink-800 bg-ink-900/40 opacity-50'
                  : 'border-ink-700 bg-ink-900 hover:border-ink-600'
              )}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-white/10 text-[9px] font-bold"
                  style={{
                    backgroundColor: layer.hex,
                    color: layer.prefersLightText ? '#ffffff' : '#000000',
                  }}
                  aria-hidden="true"
                >
                  {layer.strokes > 0 ? layer.strokes : layer.pieces}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-medium text-ink-100">{layer.name}</span>
                    <span className="font-mono text-[10px] uppercase text-ink-500">
                      {layer.hex}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-ink-400">
                    <span>{formatPercent(layer.areaShare, 0)} of art</span>
                    <span aria-hidden="true">·</span>
                    {layer.strokes > 0 ? (
                      <span className="text-accent">
                        {layer.strokes} centreline{layer.strokes === 1 ? '' : 's'}
                        {layer.strokeWidth !== null && ` at ${layer.strokeWidth}px`}
                      </span>
                    ) : (
                      <span>
                        {layer.pieces} {layer.pieces === 1 ? 'piece' : 'pieces'}
                      </span>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{formatCount(layer.nodes)} nodes</span>
                  </div>
                </div>

                <div className="flex flex-none items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {layers.length > 1 && !isRemoved && (
                    <select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) onMerge(event.target.value, layer.hex);
                      }}
                      className="rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-[10px] text-ink-200"
                      aria-label={`Merge ${layer.name} into another color`}
                    >
                      <option value="">Merge into…</option>
                      {layers
                        .filter((other) => other.hex !== layer.hex && !removed.includes(other.hex.toLowerCase()))
                        .map((other) => (
                          <option key={other.hex} value={other.hex}>
                            {other.name} {other.hex}
                          </option>
                        ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={() => onToggleRemove(layer.hex)}
                    title={isRemoved ? 'Restore this color' : 'Delete this color'}
                    className="rounded border border-ink-600 px-1.5 py-1 text-[10px] text-ink-300 transition-colors hover:border-danger hover:text-danger"
                  >
                    {isRemoved ? 'Restore' : 'Delete'}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {mergeCount > 0 && (
        <p className="text-[11px] leading-snug text-ink-500">
          Merging is previewed instantly by recoloring shapes. On download the trace is re-run with
          the merged palette, so the boundary between merged regions disappears and the node count
          drops further.
        </p>
      )}
    </div>
  );
}
