'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '@/lib/format';

interface CompareViewProps {
  originalUrl: string;
  svg: string;
  width: number;
  height: number;
  busy?: boolean;
}

type ViewMode = 'slider' | 'vector' | 'raster';

/**
 * Before/after viewer.
 *
 * The checkerboard matters more than it looks: the headline output is a
 * transparent SVG, and against a plain background transparency and white fill are
 * indistinguishable. Without it, "the background was removed" is unverifiable.
 */
export function CompareView({ originalUrl, svg, width, height, busy }: CompareViewProps) {
  const [mode, setMode] = useState<ViewMode>('slider');
  const [position, setPosition] = useState(55);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const updateFromPointer = useCallback((clientX: number) => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.max(0, Math.min(100, ratio)));
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      event.preventDefault();
      updateFromPointer(event.clientX);
    };
    const onUp = () => {
      dragging.current = false;
    };
    // Listeners live on the window so the drag survives the pointer leaving the
    // element, which is otherwise a constant annoyance with slider handles.
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [updateFromPointer]);

  const aspect = height > 0 ? width / height : 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
          {(
            [
              ['slider', 'Compare'],
              ['vector', 'Vector'],
              ['raster', 'Original'],
            ] as Array<[ViewMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={classNames(
                'rounded-md px-3 py-1.5 font-medium transition-colors',
                mode === value ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:text-ink-100'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-ink-300">
          <span className="font-mono">{Math.round(zoom * 100)}%</span>
          <input
            type="range"
            min={1}
            max={8}
            step={0.25}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-28 accent-accent"
            aria-label="Zoom"
          />
          <span className="hidden sm:inline text-ink-400">zoom in to check the edges</span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl border border-ink-700 bg-ink-950"
        style={{ aspectRatio: `${aspect}` }}
      >
        {/* Checkerboard, so transparency is visibly transparency. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(45deg, #161d28 25%, transparent 25%), linear-gradient(-45deg, #161d28 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #161d28 75%), linear-gradient(-45deg, transparent 75%, #161d28 75%)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
            backgroundColor: '#0e141d',
          }}
          aria-hidden="true"
        />

        <div
          className="absolute inset-0 origin-center transition-transform duration-150"
          style={{ transform: `scale(${zoom})` }}
        >
          {mode !== 'vector' && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={originalUrl}
              alt="Original raster image"
              className="absolute inset-0 h-full w-full object-contain"
              style={
                mode === 'slider'
                  ? { clipPath: `inset(0 0 0 ${position}%)` }
                  : undefined
              }
            />
          )}

          {mode !== 'raster' && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={dataUrl}
              alt="Vectorized result"
              className="absolute inset-0 h-full w-full object-contain"
              style={
                mode === 'slider'
                  ? { clipPath: `inset(0 ${100 - position}% 0 0)` }
                  : undefined
              }
            />
          )}
        </div>

        {mode === 'slider' && (
          <>
            <div
              className="absolute inset-y-0 z-10 w-px bg-accent"
              style={{ left: `${position}%` }}
              aria-hidden="true"
            />
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                dragging.current = true;
                updateFromPointer(event.clientX);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setPosition((p) => Math.max(0, p - 2));
                if (event.key === 'ArrowRight') setPosition((p) => Math.min(100, p + 2));
              }}
              className="absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border-2 border-accent bg-ink-950 p-2 shadow-lg focus:outline-none focus:ring-2 focus:ring-accent"
              style={{ left: `${position}%` }}
              aria-label="Drag to compare"
              role="slider"
              aria-valuenow={Math.round(position)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent" fill="none">
                <path
                  d="M9 6 4 12l5 6M15 6l5 6-5 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            <span className="pointer-events-none absolute bottom-2 left-3 z-10 rounded bg-ink-950/80 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-300">
              Vector
            </span>
            <span className="pointer-events-none absolute bottom-2 right-3 z-10 rounded bg-ink-950/80 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-300">
              Original
            </span>
          </>
        )}

        {busy && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/50 backdrop-blur-[1px]">
            <span className="flex items-center gap-2 rounded-lg bg-ink-900 px-3 py-2 text-xs text-ink-200 shadow-lg">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
              Tracing
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
