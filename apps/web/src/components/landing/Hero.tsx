import { Studio } from '@/components/studio/Studio';

const BADGES = ['No account', 'Nothing uploaded', 'SVG ready in seconds'];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Decorative glow. Behind everything and non-interactive. */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-40 h-[420px] opacity-40"
        style={{
          background:
            'radial-gradient(50% 60% at 50% 40%, rgba(61,220,151,0.22) 0%, rgba(61,220,151,0) 100%)',
        }}
        aria-hidden="true"
      />

      <div className="section relative pt-16 pb-14 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Free image to SVG</p>
          <h1 className="heading-xl mt-4 text-balance">Make images into vectors.</h1>
          <p className="body-lg mx-auto mt-5 max-w-2xl">
            Convert PNG and JPG into clean, editable SVGs. Low node count, every color on its own
            layer, and no seams where colors meet — traced entirely in your browser.
          </p>

          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-400">
            {BADGES.map((badge) => (
              <li key={badge} className="flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-accent" aria-hidden="true" />
                {badge}
              </li>
            ))}
          </ul>
        </div>

        <div id="converter" className="mt-10 scroll-mt-20">
          <div className="rounded-3xl border border-ink-700 bg-ink-900/40 p-4 shadow-2xl sm:p-6">
            <Studio />
          </div>
        </div>
      </div>
    </section>
  );
}
