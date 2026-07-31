import sampleStats from '@/lib/sample-stats.json';

const STATS = sampleStats as Record<string, { nodes: number; nodesBeforeFitting: number }>;

const POINTS = [
  {
    number: '01',
    title: 'Low node count',
    body: 'Smooth closed paths fitted with least-squares Béziers, not a vertex per pixel step. Editing starts from a clean shape instead of an hour of cleanup.',
  },
  {
    number: '02',
    title: 'Colors already separated',
    body: 'Every color lands in its own group with an id and a data-color attribute — ready to recolor in place, cut by mat, or hand to a print shop as separations.',
  },
  {
    number: '03',
    title: 'No seams between colors',
    body: 'Adjacent colors share one fitted boundary rather than each fitting their own, so there are no hairline gaps or overlaps where two regions meet.',
  },
  {
    number: '04',
    title: 'Edit, then re-optimize',
    body: 'Merge near-duplicate colors in your browser. On download the trace is re-run with the merged palette, so the internal boundary vanishes and the node count drops again.',
  },
  {
    number: '05',
    title: 'Real centrelines for line work',
    body: 'A stroke traced as a fill comes back as two parallel outlines — useless as a plotter or laser toolpath, and several times the nodes. Thin shapes are recovered as one path with a stroke weight instead, with the original thickness measured back off the pixels.',
  },
  {
    number: '06',
    title: 'An honest answer first',
    body: 'Every image is scored before conversion. If it is a photograph, no setting will help, and the app says so instead of handing you forty layers of colour bands.',
  },
];

export function Differentiators() {
  const logo = STATS['logo.png'];
  const reduction = logo && logo.nodes > 0 ? (logo.nodesBeforeFitting / logo.nodes).toFixed(0) : null;

  return (
    <section className="section py-20 sm:py-28">
      <div className="max-w-2xl">
        <p className="eyebrow">The fix</p>
        <h2 className="heading-lg mt-3 text-balance">A vector that works the first time.</h2>
        <p className="body-lg mt-4">
          Clean paths, a low node count, and every color already on its own layer. Drag any anchor
          and the shape holds, instead of fighting hundreds of stray points.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {POINTS.map((point) => (
          <article key={point.number} className="card">
            <span className="font-mono text-xs text-accent">{point.number}</span>
            <h3 className="mt-2 text-base font-semibold text-ink-100">{point.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-300">{point.body}</p>
          </article>
        ))}
      </div>

      {reduction && (
        <p className="mt-8 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-ink-200">
          <span className="font-semibold text-accent">Measured:</span> the sample logo traces to{' '}
          <span className="font-mono">{logo.nodes}</span> nodes, where following the pixel boundary
          would give <span className="font-mono">{logo.nodesBeforeFitting}</span> — about{' '}
          {reduction}× fewer points to edit.
        </p>
      )}
    </section>
  );
}
