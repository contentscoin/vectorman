import Link from 'next/link';

const LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#suitability', label: 'Will it work?' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/80 backdrop-blur">
      <nav className="section flex h-14 items-center justify-between" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-ink-950"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
              <path
                d="M4 20 12 4l8 16M8.5 14h7"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          PerfectVector
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-ink-300 transition-colors hover:text-ink-100"
            >
              {link.label}
            </a>
          ))}
        </div>

        <a
          href="#converter"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-bright"
        >
          Vectorize free
        </a>
      </nav>
    </header>
  );
}
