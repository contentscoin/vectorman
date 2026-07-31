'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PRESET_ID,
  resolvePreset,
  type ColorEditPlan,
  type ImageAnalysis,
  type VectorizeOptions,
} from '@perfectvector/core';

import { decodeFile, decodeUrl, formatBytes, type DecodedImage } from '@/lib/decode';
import {
  CUSTOM_PREFIX,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
  type CustomPreset,
} from '@/lib/custom-presets';
import { downloadRaster, downloadText, swapExtension } from '@/lib/download';
import { isSuperseded, VectorizerClient } from '@/lib/worker-client';
import type { TraceSummary } from '@/worker/protocol';
import { Dropzone } from './Dropzone';
import { CompareView } from './CompareView';
import { SettingsPanel, type SettingsState } from './SettingsPanel';
import { LayerPanel } from './LayerPanel';
import { DownloadBar, type DownloadTarget } from './DownloadBar';
import { StatsBar } from './StatsBar';
import { SuitabilityNotice } from './SuitabilityNotice';
import { SAMPLES } from '@/lib/samples';

interface StudioProps {
  /** Hide the sample strip and tighten spacing, for embedding in the hero. */
  compact?: boolean;
}

export function Studio({ compact }: StudioProps) {
  const clientRef = useRef<VectorizerClient | null>(null);
  const imageRef = useRef<DecodedImage | null>(null);

  const [image, setImage] = useState<DecodedImage | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [settings, setSettings] = useState<SettingsState>({
    presetId: DEFAULT_PRESET_ID,
    overrides: {},
  });
  const [removed, setRemoved] = useState<string[]>([]);
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'decoding' | 'tracing' | 'ready'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);

  // Read on mount only: localStorage is not available during server rendering.
  useEffect(() => {
    setCustomPresets(loadCustomPresets());
  }, []);

  const getClient = useCallback(() => {
    if (!clientRef.current) clientRef.current = new VectorizerClient();
    return clientRef.current;
  }, []);

  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
    };
  }, []);

  const effectiveOptions = useMemo<VectorizeOptions>(() => {
    // A saved preset stores fully resolved options, so it keeps behaving the same even
    // if a built-in preset's defaults change underneath it.
    if (settings.presetId.startsWith(CUSTOM_PREFIX)) {
      const custom = customPresets.find((preset) => preset.id === settings.presetId);
      if (custom) return { ...custom.options, ...settings.overrides };
      // Saved preset deleted while selected: fall back rather than trace nothing.
      return resolvePreset(DEFAULT_PRESET_ID, settings.overrides);
    }

    try {
      return resolvePreset(settings.presetId, settings.overrides);
    } catch {
      return resolvePreset(DEFAULT_PRESET_ID, settings.overrides);
    }
  }, [settings, customPresets]);

  /** The edit plan derived from the layer panel's current state. */
  const editPlan = useMemo<ColorEditPlan>(() => {
    const grouped = new Map<string, string[]>();
    for (const [absorb, keep] of Object.entries(mergeTargets)) {
      const list = grouped.get(keep) ?? [];
      list.push(absorb);
      grouped.set(keep, list);
    }
    return {
      groups: [...grouped.entries()].map(([keep, absorb]) => ({ keep, absorb })),
      remove: removed,
    };
  }, [mergeTargets, removed]);

  const hasEdits = removed.length > 0 || Object.keys(mergeTargets).length > 0;

  const loadImage = useCallback(
    async (decoded: DecodedImage) => {
      if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
      imageRef.current = decoded;

      setImage(decoded);
      setSummary(null);
      setRemoved([]);
      setMergeTargets({});
      setError(null);
      setStatus('tracing');

      try {
        const report = await getClient().load(decoded);
        setAnalysis(report);

        // Start from what the analyzer recommends. On a fresh image that is a far
        // better starting point than a fixed default.
        //
        // Tracing is deliberately *not* done here. Changing the settings schedules a
        // trace in the effect below, so doing one here as well would trace every
        // uploaded image twice — wasted work, and a visible second spinner.
        setSettings({
          presetId: report.recommended.presetId,
          overrides: report.recommended.options,
        });
      } catch (caught) {
        if (isSuperseded(caught)) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('idle');
      }
    },
    [getClient]
  );

  const handleFile = useCallback(
    async (file: File) => {
      setStatus('decoding');
      setError(null);
      try {
        await loadImage(await decodeFile(file));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('idle');
      }
    },
    [loadImage]
  );

  const handleSample = useCallback(
    async (url: string, name: string) => {
      setStatus('decoding');
      setError(null);
      try {
        await loadImage(await decodeUrl(url, name));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('idle');
      }
    },
    [loadImage]
  );

  // Re-trace whenever settings change, then re-apply any pending palette edits so
  // the preview keeps showing what the user set up.
  useEffect(() => {
    if (!image || status === 'decoding') return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setStatus('tracing');
      try {
        const client = getClient();
        const traced = await client.trace(effectiveOptions);
        if (cancelled) return;

        if (hasEdits) {
          // Preview edits with the fast path; the exact re-trace happens on download.
          const edited = await client.edit(editPlan, false);
          if (cancelled) return;
          setSummary(edited);
        } else {
          setSummary(traced);
        }
        setStatus('ready');
      } catch (caught) {
        if (cancelled || isSuperseded(caught)) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('ready');
      }
      // Debounced so dragging a slider does not queue a trace per frame.
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOptions, editPlan, image]);

  const handleDownload = useCallback(
    async (target: DownloadTarget) => {
      if (!image || !summary) return;
      const client = getClient();

      // Re-run the trace and apply edits exactly before exporting. Merging on the
      // label map is what removes the now-internal boundaries between merged
      // regions, which the instant preview cannot do.
      await client.trace(effectiveOptions);
      if (hasEdits) await client.edit(editPlan, true);

      if (target === 'png' || target === 'jpg') {
        const svg = await client.export('svg');
        await downloadRaster(svg, swapExtension(image.name, target), target, {
          width: summary.width,
          height: summary.height,
          background: target === 'jpg' ? '#ffffff' : null,
        });
        return;
      }

      const text = await client.export(target);
      downloadText(text, swapExtension(image.name, target), target);
    },
    [editPlan, effectiveOptions, getClient, hasEdits, image, summary]
  );

  const reset = useCallback(() => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
    imageRef.current = null;
    setImage(null);
    setAnalysis(null);
    setSummary(null);
    setRemoved([]);
    setMergeTargets({});
    setError(null);
    setStatus('idle');
  }, []);

  const busy = status === 'decoding' || status === 'tracing';

  if (!image) {
    return (
      <div className="flex flex-col gap-4">
        <Dropzone onFile={handleFile} disabled={status === 'decoding'} compact={compact} />

        {status === 'decoding' && (
          <p className="text-center text-xs text-ink-300">Decoding…</p>
        )}

        {error && (
          <p role="alert" className="text-center text-xs text-danger">
            {error}
          </p>
        )}

        <div>
          <p className="mb-2 text-center text-xs text-ink-400">or try one of these</p>
          <div className="flex flex-wrap justify-center gap-2">
            {SAMPLES.map((sample) => (
              <button
                key={sample.file}
                type="button"
                onClick={() => handleSample(`/samples/${sample.file}`, sample.file)}
                title={sample.note}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-ink-700 bg-ink-850 transition-colors hover:border-accent"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/samples/${sample.file}`}
                  alt={sample.label}
                  className="h-full w-full object-contain p-1"
                />
                <span className="absolute inset-x-0 bottom-0 bg-ink-950/85 py-0.5 text-[9px] text-ink-200 opacity-0 transition-opacity group-hover:opacity-100">
                  {sample.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-ink-300">
          <span className="font-medium text-ink-100">{image.name}</span>
          <span className="ml-2 text-ink-500">
            {image.width}×{image.height} · {formatBytes(image.byteLength)}
          </span>
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-200 transition-colors hover:border-ink-500"
        >
          New image
        </button>
      </div>

      {analysis && <SuitabilityNotice analysis={analysis} />}

      {error && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-4">
          {summary ? (
            <>
              <CompareView
                originalUrl={image.previewUrl}
                svg={summary.svg}
                width={summary.width}
                height={summary.height}
                busy={busy}
              />
              <StatsBar
                stats={summary.stats}
                svgBytes={summary.svgBytes}
                sourceBytes={image.byteLength}
                strokeWidth={summary.strokeReport.medianWidth}
              />
            </>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-ink-700 bg-ink-900">
              <span className="flex items-center gap-2 text-xs text-ink-300">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
                Tracing
              </span>
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-6 rounded-xl border border-ink-700 bg-ink-900/50 p-4">
          <SettingsPanel
            state={settings}
            effective={effectiveOptions}
            recommendedPresetId={analysis?.recommended.presetId ?? null}
            customPresets={customPresets}
            onChange={setSettings}
            onSavePreset={(label) => {
              // Save what is actually in effect, preset plus tweaks, so reloading it
              // reproduces exactly what is on screen.
              const next = saveCustomPreset(customPresets, label, effectiveOptions);
              setCustomPresets(next);
              if (next[0]) setSettings({ presetId: next[0].id, overrides: {} });
            }}
            onDeletePreset={(id) => {
              setCustomPresets(deleteCustomPreset(customPresets, id));
              if (settings.presetId === id) {
                setSettings({ presetId: DEFAULT_PRESET_ID, overrides: {} });
              }
            }}
            disabled={status === 'decoding'}
          />

          {summary && (
            <LayerPanel
              layers={summary.layers}
              suggestions={summary.suggestions}
              removed={removed}
              mergeTargets={mergeTargets}
              onToggleRemove={(hex) => {
                const key = hex.toLowerCase();
                setRemoved((current) =>
                  current.includes(key) ? current.filter((h) => h !== key) : [...current, key]
                );
              }}
              onMerge={(keep, absorb) => {
                setMergeTargets((current) => ({
                  ...current,
                  [absorb.toLowerCase()]: keep.toLowerCase(),
                }));
              }}
              onUnmergeAll={() => {
                setMergeTargets({});
                setRemoved([]);
              }}
              onApplySuggestions={() => {
                setMergeTargets((current) => {
                  const next = { ...current };
                  for (const suggestion of summary.suggestions) {
                    next[suggestion.absorb.toLowerCase()] = suggestion.keep.toLowerCase();
                  }
                  return next;
                });
              }}
              disabled={status === 'decoding'}
            />
          )}

          <DownloadBar onDownload={handleDownload} disabled={!summary} />
        </aside>
      </div>
    </div>
  );
}
