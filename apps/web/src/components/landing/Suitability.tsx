import sampleStats from '@/lib/sample-stats.json';

const STATS = sampleStats as Record<string, { score: number; classification: string }>;

const GOOD = [
  'Logos and wordmarks',
  'Flat illustrations and mascots',
  'Stickers, decals and cut files',
  'Line art and silhouettes',
  'AI art prompted flat — solid colors, no gradients',
  'Pixel art, traced literally',
];

const BAD = [
  'Photographs',
  'Photoreal or gradient-heavy AI art',
  'Very low-resolution or blurry sources',
  'Fine textures: fur, film grain, watercolor washes',
];

export function Suitability() {
  const photo = STATS['photo.jpg'];
  const logo = STATS['logo.png'];

  return (
    <section id="suitability" className="section py-20 sm:py-28">
      <div className="max-w-2xl">
        <p className="eyebrow">An honest answer</p>
        <h2 className="heading-lg mt-3 text-balance">Will it work on your image?</h2>
        <p className="body-lg mt-4">
          Tracing rewards flat, defined shapes. Rather than making you find out after the fact,
          every upload is scored first — and if the answer is no, the app says so before you spend
          time on sliders that cannot fix it.
        </p>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-accent/30 bg-accent/5 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-accent">
            <span aria-hidden="true">✓</span> Converts beautifully
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {GOOD.map((item) => (
              <li key={item} className="text-sm text-ink-200">
                {item}
              </li>
            ))}
          </ul>
          {logo && (
            <p className="mt-4 border-t border-accent/20 pt-3 font-mono text-xs text-ink-400">
              sample logo scored {logo.score}/100 · {logo.classification}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-danger">
            <span aria-hidden="true">✕</span> Won&apos;t convert well
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {BAD.map((item) => (
              <li key={item} className="text-sm text-ink-200">
                {item}
              </li>
            ))}
          </ul>
          {photo && (
            <p className="mt-4 border-t border-danger/20 pt-3 font-mono text-xs text-ink-400">
              sample photo scored {photo.score}/100 · {photo.classification} · refused
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <p className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-sm leading-relaxed text-ink-300">
          <span className="font-semibold text-ink-100">Generating with AI?</span> Prompt for “flat
          vector style, solid colors, no gradients”. That is the kind of art tracing rewards.
        </p>
        <p className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-sm leading-relaxed text-ink-300">
          <span className="font-semibold text-ink-100">What we do not do.</span> We trace what is in
          your pixels and never invent detail that is not there. Text comes back as letter-shaped
          paths, not editable type.
        </p>
      </div>
    </section>
  );
}
