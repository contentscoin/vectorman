'use client';

import { useState } from 'react';
import type { ExportFormat } from '@/worker/protocol';
import { classNames } from '@/lib/format';

export type DownloadTarget = ExportFormat | 'png' | 'jpg';

interface DownloadBarProps {
  onDownload: (target: DownloadTarget) => Promise<void> | void;
  disabled?: boolean;
}

const FORMATS: Array<{ id: DownloadTarget; label: string; note: string }> = [
  { id: 'svg', label: 'SVG', note: 'design tools, web, cutting machines' },
  { id: 'pdf', label: 'PDF', note: 'print shops — real vector paths' },
  { id: 'eps', label: 'EPS', note: 'older RIPs and sign shops' },
  { id: 'dxf', label: 'DXF', note: 'laser and CNC, curves flattened' },
  { id: 'png', label: 'PNG', note: 'transparent raster preview' },
  { id: 'jpg', label: 'JPG', note: 'flattened raster preview' },
];

export function DownloadBar({ onDownload, disabled }: DownloadBarProps) {
  const [busy, setBusy] = useState<DownloadTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (target: DownloadTarget) => {
    setBusy(target);
    setError(null);
    try {
      await onDownload(target);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={classNames('flex flex-col gap-2', disabled && 'pointer-events-none opacity-60')}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Download</h3>

      <div className="flex flex-wrap gap-1.5">
        {FORMATS.map((format, index) => (
          <button
            key={format.id}
            type="button"
            onClick={() => run(format.id)}
            title={format.note}
            disabled={busy !== null}
            className={classNames(
              'rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-60',
              index === 0
                ? 'border-accent bg-accent text-ink-950 hover:bg-accent-bright'
                : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-ink-500 hover:text-ink-100'
            )}
          >
            {busy === format.id ? 'Preparing…' : format.label}
          </button>
        ))}
      </div>

      <p className="text-[11px] leading-snug text-ink-500">
        Every download is re-optimized: merged colors are re-traced so their shared boundary
        disappears, and coordinates are rounded to the chosen precision.
      </p>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
