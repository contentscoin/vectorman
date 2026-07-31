'use client';

import type { ImageAnalysis } from '@perfectvector/core';
import { classNames } from '@/lib/format';

const TONE = {
  error: {
    wrap: 'border-danger/40 bg-danger/10',
    label: 'text-danger',
  },
  warning: {
    wrap: 'border-warn/40 bg-warn/10',
    label: 'text-warn',
  },
  info: {
    wrap: 'border-ink-700 bg-ink-900',
    label: 'text-accent',
  },
} as const;

/**
 * Suitability verdict shown above the result.
 *
 * Deliberately prominent when the answer is bad. If the source is a photograph the
 * output will be a stack of colour bands no matter what the settings are, and
 * saying so immediately is more useful than letting someone spend twenty minutes
 * on sliders that cannot fix it.
 */
export function SuitabilityNotice({ analysis }: { analysis: ImageAnalysis }) {
  const worst: 'error' | 'warning' | 'info' = analysis.findings.some((f) => f.level === 'error')
    ? 'error'
    : analysis.findings.some((f) => f.level === 'warning')
      ? 'warning'
      : 'info';

  const tone = TONE[worst];
  const shown = analysis.findings.filter((f) => f.level !== 'info').slice(0, 3);

  if (worst === 'info') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs">
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-hidden="true" />
        <span className="text-ink-200">
          Good input for tracing — {analysis.classification.replace('-', ' ')}, score{' '}
          <span className="font-mono">{analysis.score}</span>/100.
        </span>
      </div>
    );
  }

  return (
    <div className={classNames('rounded-lg border px-3 py-2.5', tone.wrap)}>
      <p className={classNames('text-xs font-semibold', tone.label)}>
        {worst === 'error' ? 'This image will not trace well' : 'Heads up'} — score{' '}
        <span className="font-mono">{analysis.score}</span>/100,{' '}
        {analysis.classification.replace('-', ' ')}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {shown.map((finding, index) => (
          <li key={index} className="text-[11px] leading-relaxed text-ink-200">
            {finding.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
