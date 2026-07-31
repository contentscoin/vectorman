'use client';

import type { VectorizeStats } from '@perfectvector/core';
import { formatBytes, formatCount, formatMilliseconds } from '@/lib/format';

interface StatsBarProps {
  stats: VectorizeStats;
  svgBytes: number;
  sourceBytes: number;
  strokeWidth?: number | null;
}

export function StatsBar({ stats, svgBytes, sourceBytes, strokeWidth }: StatsBarProps) {
  const reduction = stats.nodes > 0 ? stats.nodesBeforeFitting / stats.nodes : 0;

  const items: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Colors', value: formatCount(stats.colors), hint: 'each on its own layer' },
  ];

  // Pieces and centrelines are alternatives, not both — a region becomes one or the
  // other. Showing whichever applies keeps the row readable instead of padding it
  // with a permanent zero.
  if (stats.strokes > 0) {
    items.push({
      label: 'Centrelines',
      value: formatCount(stats.strokes),
      hint: strokeWidth ? `${strokeWidth}px stroke recovered` : 'single stroked paths',
    });
    if (stats.pieces > 0) {
      items.push({
        label: 'Pieces',
        value: formatCount(stats.pieces),
        hint: 'still filled regions',
      });
    }
  } else {
    items.push({
      label: 'Pieces',
      value: formatCount(stats.pieces),
      hint: 'separate filled regions',
    });
  }

  items.push(
    {
      label: 'Nodes',
      value: formatCount(stats.nodes),
      hint:
        reduction > 1.5
          ? `${reduction.toFixed(1)}x fewer than a pixel-following trace`
          : 'anchor points you would drag',
    },
    {
      label: 'SVG',
      value: formatBytes(svgBytes),
      hint: sourceBytes > 0 ? `source was ${formatBytes(sourceBytes)}` : undefined,
    },
    { label: 'Traced in', value: formatMilliseconds(stats.elapsedMs), hint: 'in your browser' }
  );

  return (
    // The test id gives automated checks an unambiguous hook. The landing page also
    // renders <dl> stat grids for the sample gallery, and a structural selector
    // would happily read those instead of the live result.
    <dl
      data-testid="trace-stats"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
    >
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
            {item.label}
          </dt>
          <dd className="mt-0.5 font-mono text-lg leading-tight text-ink-100">{item.value}</dd>
          {item.hint && (
            <dd className="mt-0.5 text-[10px] leading-snug text-ink-500">{item.hint}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
