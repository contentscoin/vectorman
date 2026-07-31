import { classNames } from '@/lib/format';

/**
 * What you get, in place of a pricing table.
 *
 * Two deliberate departures from the site this is modelled on.
 *
 * First, it is rendered from static constants on the server. The original fetches
 * prices client-side, and when that call fails every tier reads "Current pricing is
 * temporarily unavailable" — in the conversion path, on the one section where a broken
 * state costs a signup. Plans change rarely enough that a build-time constant wins.
 *
 * Second, the tiers describe *where the engine runs* rather than what has been paid
 * for, and every line is a feature that exists in this repository. An earlier draft
 * mirrored the original's tiers and ended up advertising "saved presets across
 * devices" and a "team preset library" that were never built. Since the whole project
 * argues for telling people the truth about what tracing can do, advertising software
 * that does not exist was the one claim it could not afford.
 */

interface Tier {
  id: string;
  name: string;
  blurb: string;
  price: string;
  period: string | null;
  features: string[];
  cta: string;
  featured?: boolean;
  footnote?: string;
}

const TIERS: Tier[] = [
  {
    id: 'free',
    name: 'In the browser',
    blurb: 'The studio on this page',
    price: '$0',
    period: null,
    features: [
      'Unlimited conversions, nothing uploaded',
      'Merge and delete colours, re-optimised on export',
      'Centreline recovery for line work',
      'Saved presets, kept in your browser',
      'SVG, PNG, JPG, PDF, EPS and DXF export',
    ],
    cta: 'Start converting',
    footnote: 'Conversion runs locally, so there is nothing to meter.',
  },
  {
    id: 'cli',
    name: 'Whole folders',
    blurb: 'For a batch of client files',
    price: '$0',
    period: null,
    features: [
      'Everything above, plus:',
      'Convert a folder across worker threads',
      'Unsuitable images skipped, not silently mangled',
      'Dry run and overwrite protection',
      'Per-file report of what converted, skipped or failed',
    ],
    cta: 'See the MCP setup',
    featured: true,
  },
  {
    id: 'engine',
    name: 'In your own code',
    blurb: 'For tools and pipelines',
    price: '$0',
    period: null,
    features: [
      'Everything above, plus:',
      'The engine as a TypeScript package',
      'MCP server, so an assistant can drive it',
      'Runs in a browser worker and in Node',
      'MIT licensed',
    ],
    cta: 'Read the docs',
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="border-y border-ink-800 bg-ink-900/30 py-20 sm:py-28">
      <div className="section">
        <div className="max-w-2xl">
          <p className="eyebrow">What you get</p>
          <h2 className="heading-lg mt-3 text-balance">Three ways to run it. All of them free.</h2>
          <p className="body-lg mt-4">
            Conversion happens on your own machine, so there is nothing to meter and no account to
            create. Every feature listed below is implemented in this build — nothing here is a
            plan for later.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              className={classNames(
                'relative flex flex-col rounded-2xl border p-6',
                tier.featured
                  ? 'border-accent bg-accent/5'
                  : 'border-ink-700 bg-ink-900'
              )}
            >
              {tier.featured && (
                <span className="absolute -top-3 left-6 rounded-full bg-accent px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-ink-950">
                  Most useful
                </span>
              )}

              <h3 className="text-lg font-semibold text-ink-100">{tier.name}</h3>
              <p className="mt-1 text-sm text-ink-400">{tier.blurb}</p>

              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tight text-ink-100">
                  {tier.price}
                </span>
                {tier.period && <span className="text-sm text-ink-400">{tier.period}</span>}
              </p>
              {tier.id === 'free' && (
                <p className="mt-1 text-xs text-ink-500">no account, no upload</p>
              )}

              <ul className="mt-6 flex flex-1 flex-col gap-2.5">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm text-ink-200">
                    <span className="mt-0.5 flex-none text-accent" aria-hidden="true">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>

              <a
                href="#converter"
                className={classNames(
                  'mt-6 rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition-colors',
                  tier.featured
                    ? 'bg-accent text-ink-950 hover:bg-accent-bright'
                    : 'border border-ink-600 text-ink-100 hover:border-ink-400'
                )}
              >
                {tier.cta}
              </a>

              {tier.footnote && (
                <p className="mt-3 text-center text-[11px] text-ink-500">{tier.footnote}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
