import sampleStats from '@/lib/sample-stats.json';
import { SAMPLES } from '@/lib/samples';
import { formatBytes, formatCount } from '@/lib/format';

interface SampleStat {
  width: number;
  height: number;
  sourceBytes: number;
  preset: string;
  colors: number;
  pieces: number;
  strokes: number;
  strokeWidth: number | null;
  nodes: number;
  nodesBeforeFitting: number;
  svgBytes: number;
  elapsedMs: number;
  suitability: string;
  classification: string;
  score: number;
  palette: string[];
  svg: string;
}

const STATS = sampleStats as Record<string, SampleStat>;

/**
 * Measured results for the sample artwork.
 *
 * Every figure here comes from `scripts/measure-samples.mjs`, which runs the real
 * engine over the real files and writes the JSON this section imports. The SVG
 * shown is the actual traced output, inlined — not a screenshot. So these numbers
 * cannot quietly become marketing: if the tracer regresses, the page regresses
 * with it.
 */
export function RealConversions() {
  const shown = SAMPLES.filter((sample) => sample.file !== 'photo.jpg')
    .map((sample) => ({ sample, stat: STATS[sample.file] }))
    .filter((entry): entry is { sample: (typeof SAMPLES)[number]; stat: SampleStat } =>
      Boolean(entry.stat)
    );

  return (
    <section id="how" className="border-y border-ink-800 bg-ink-900/30 py-20 sm:py-28">
      <div className="section">
        <div className="max-w-2xl">
          <p className="eyebrow">Real conversions</p>
          <h2 className="heading-lg mt-3 text-balance">Clean enough to count.</h2>
          <p className="body-lg mt-4">
            Every number below is measured from the SVG the engine produced, at build time, from the
            file you can load yourself in one click. Each color is already on its own layer.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map(({ sample, stat }) => {
            const reduction =
              stat.nodes > 0 ? (stat.nodesBeforeFitting / stat.nodes).toFixed(1) : '—';

            return (
              <article
                key={sample.file}
                className="flex flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900"
              >
                <div className="bg-checker flex aspect-[4/3] items-center justify-center p-6">
                  {/* The traced SVG itself, inlined as a data URL. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(stat.svg)}`}
                    alt={`Vectorized ${sample.label}`}
                    className="h-full w-full object-contain"
                    loading="lazy"
                  />
                </div>

                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink-100">{sample.label}</h3>
                      <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
                        {stat.preset}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-ink-400">{sample.note}</p>
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-1.5">
                    {stat.palette.slice(0, 8).map((hex) => (
                      <span
                        key={hex}
                        title={hex}
                        className="h-4 w-4 rounded border border-white/10"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>

                  <dl className="grid grid-cols-3 gap-2 border-t border-ink-800 pt-3 text-center">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-ink-500">Colors</dt>
                      <dd className="font-mono text-sm text-ink-100">{stat.colors}</dd>
                    </div>
                    <div>
                      {/* A region becomes a filled piece or a centreline, never both,
                          so the label follows whichever this sample produced. */}
                      <dt className="text-[10px] uppercase tracking-wide text-ink-500">
                        {stat.strokes > 0 ? 'Strokes' : 'Pieces'}
                      </dt>
                      <dd className="font-mono text-sm text-ink-100">
                        {stat.strokes > 0 ? stat.strokes : stat.pieces}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-ink-500">Nodes</dt>
                      <dd className="font-mono text-sm text-ink-100">{formatCount(stat.nodes)}</dd>
                    </div>
                  </dl>

                  <p className="text-[10px] leading-snug text-ink-500">
                    {formatBytes(stat.sourceBytes)} raster in, {formatBytes(stat.svgBytes)} SVG out.
                    {stat.strokes > 0 && stat.strokeWidth
                      ? ` Recovered as ${stat.strokeWidth}px centrelines, not filled outlines.`
                      : stat.nodes > 0 && Number(reduction) > 1.5
                        ? ` ${reduction}× fewer nodes than a pixel-following trace.`
                        : null}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
