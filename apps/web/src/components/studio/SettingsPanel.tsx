'use client';

import { useState } from 'react';
import { PRESETS, type VectorizeOptions } from '@perfectvector/core';
import { classNames } from '@/lib/format';
import { describeOptions, type CustomPreset } from '@/lib/custom-presets';

export interface SettingsState {
  presetId: string;
  overrides: VectorizeOptions;
}

interface SettingsPanelProps {
  state: SettingsState;
  effective: VectorizeOptions;
  recommendedPresetId: string | null;
  customPresets: CustomPreset[];
  onChange: (next: SettingsState) => void;
  onSavePreset: (label: string) => void;
  onDeletePreset: (id: string) => void;
  disabled?: boolean;
}

const SLIDERS: Array<{
  key: 'maxColors' | 'detail' | 'smoothing' | 'denoise' | 'colorMergeThreshold';
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}> = [
  {
    key: 'maxColors',
    label: 'Colors',
    min: 1,
    max: 24,
    step: 1,
    hint: 'Palette cap. Artwork with fewer colors than this keeps its exact original values.',
  },
  {
    key: 'detail',
    label: 'Detail',
    min: 0,
    max: 100,
    step: 1,
    hint: 'How closely paths follow the pixels. 100 traces literally, pixel for pixel.',
  },
  {
    key: 'smoothing',
    label: 'Smoothing',
    min: 0,
    max: 100,
    step: 1,
    hint: 'Turn angle above which a vertex stays a hard corner. Low keeps lettering crisp.',
  },
  {
    key: 'denoise',
    label: 'Denoise',
    min: 0,
    max: 100,
    step: 1,
    hint: 'Cleanup for JPEG speckle. Applied only when noise is actually measured.',
  },
  {
    key: 'colorMergeThreshold',
    label: 'Merge similar',
    min: 0,
    max: 24,
    step: 1,
    hint: 'Collapse palette entries closer than this perceptual distance.',
  },
];

export function SettingsPanel({
  state,
  effective,
  recommendedPresetId,
  customPresets,
  onChange,
  onSavePreset,
  onDeletePreset,
  disabled,
}: SettingsPanelProps) {
  const [naming, setNaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');

  const setPreset = (presetId: string) => {
    // Switching preset clears manual tweaks, so the preset is what you actually get.
    onChange({ presetId, overrides: {} });
  };

  const commitSave = () => {
    onSavePreset(draftLabel);
    setDraftLabel('');
    setNaming(false);
  };

  const setOverride = (key: keyof VectorizeOptions, value: number | string) => {
    onChange({ ...state, overrides: { ...state.overrides, [key]: value } });
  };

  const activePreset = PRESETS.find((p) => p.id === state.presetId);
  const hasOverrides = Object.keys(state.overrides).length > 0;
  const activeCustom = customPresets.find((p) => p.id === state.presetId);

  return (
    <div className={classNames('flex flex-col gap-5', disabled && 'pointer-events-none opacity-60')}>
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Preset</h3>
          {hasOverrides && (
            <button
              type="button"
              onClick={() => onChange({ ...state, overrides: {} })}
              className="text-xs text-accent hover:text-accent-bright"
            >
              Reset tweaks
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setPreset(preset.id)}
              title={preset.description}
              className={classNames(
                'relative rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors',
                state.presetId === preset.id && !activeCustom
                  ? 'border-accent bg-accent/10 text-ink-100'
                  : 'border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
              )}
            >
              {preset.label}
              {recommendedPresetId === preset.id && (
                <span
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent"
                  title="Recommended for this image"
                />
              )}
            </button>
          ))}
        </div>

        {activePreset && (
          <p className="mt-2 text-xs leading-relaxed text-ink-400">{activePreset.description}</p>
        )}

        {customPresets.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
              Saved
            </h4>
            <ul className="flex flex-col gap-1">
              {customPresets.map((preset) => (
                <li key={preset.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPreset(preset.id)}
                    title={describeOptions(preset.options)}
                    className={classNames(
                      'min-w-0 flex-1 truncate rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                      state.presetId === preset.id
                        ? 'border-accent bg-accent/10 text-ink-100'
                        : 'border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
                    )}
                  >
                    {preset.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeletePreset(preset.id)}
                    title={`Delete ${preset.label}`}
                    aria-label={`Delete ${preset.label}`}
                    className="flex-none rounded border border-ink-700 px-1.5 py-1 text-[10px] text-ink-400 opacity-0 transition-opacity hover:border-danger hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {naming ? (
          <div className="mt-2 flex gap-1">
            <input
              autoFocus
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSave();
                if (event.key === 'Escape') {
                  setNaming(false);
                  setDraftLabel('');
                }
              }}
              placeholder="Preset name"
              maxLength={40}
              aria-label="Preset name"
              className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-850 px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500"
            />
            <button
              type="button"
              onClick={commitSave}
              className="flex-none rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-bright"
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="mt-2 w-full rounded-lg border border-dashed border-ink-600 px-2.5 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:border-ink-400 hover:text-ink-100"
          >
            Save current settings
          </button>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Fine tune</h3>

        {SLIDERS.map((slider) => {
          const value = Number(effective[slider.key] ?? 0);
          const overridden = state.overrides[slider.key] !== undefined;

          return (
            <label key={slider.key} className="group block">
              <span className="mb-1 flex items-baseline justify-between text-xs">
                <span className={overridden ? 'text-accent' : 'text-ink-200'}>{slider.label}</span>
                <span className="font-mono text-ink-400">{value}</span>
              </span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={value}
                onChange={(event) => setOverride(slider.key, Number(event.target.value))}
                className="w-full accent-accent"
              />
              <span className="mt-1 block text-[11px] leading-snug text-ink-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {slider.hint}
              </span>
            </label>
          );
        })}

        <div>
          <span className="mb-1.5 block text-xs text-ink-200">Thin shapes</span>
          <div className="inline-flex w-full rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
            {(
              [
                ['off', 'Fill'],
                ['auto', 'Centreline'],
                ['force', 'Aggressive'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setOverride('strokeMode', value)}
                className={classNames(
                  'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                  (effective.strokeMode ?? 'off') === value
                    ? 'bg-ink-700 text-ink-100'
                    : 'text-ink-300 hover:text-ink-100'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
            A stroke traced as a fill becomes two parallel outlines. Centreline recovers it as one
            path with a stroke weight — far fewer nodes, editable thickness, and a usable toolpath
            for a plotter or laser. Only applied where nothing else shares the edge.
          </p>
        </div>

        <div>
          <span className="mb-1.5 block text-xs text-ink-200">Background</span>
          <div className="inline-flex w-full rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
            {(['auto', 'remove', 'keep'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setOverride('background', value)}
                className={classNames(
                  'flex-1 rounded-md px-2 py-1.5 font-medium capitalize transition-colors',
                  effective.background === value
                    ? 'bg-ink-700 text-ink-100'
                    : 'text-ink-300 hover:text-ink-100'
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
            Auto drops a flat backdrop touching the frame edge but keeps enclosed areas of the same
            color, so the whites of an eye stay filled.
          </p>
        </div>
      </div>
    </div>
  );
}
