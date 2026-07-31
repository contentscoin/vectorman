export function Footer() {
  return (
    <footer className="border-t border-ink-800 bg-ink-950">
      <div className="section py-14">
        <div className="rounded-2xl border border-accent/25 bg-accent/5 p-8 text-center">
          <h2 className="heading-lg text-balance">Ready to make perfect vectors?</h2>
          <p className="body-lg mx-auto mt-3 max-w-xl">
            Turn your image into a clean, scalable SVG in seconds. No account, no upload, no limit.
          </p>
          <a
            href="#converter"
            className="mt-6 inline-block rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-bright"
          >
            Vectorize an image — free
          </a>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-ink-800 pt-8 text-xs text-ink-500 sm:flex-row">
          <p>
            PerfectVector — a working reimplementation, built as an engineering exercise. Not
            affiliated with the original site.
          </p>
          <div className="flex gap-5">
            <a href="#how" className="transition-colors hover:text-ink-300">
              How it works
            </a>
            <a href="#suitability" className="transition-colors hover:text-ink-300">
              Limits
            </a>
            <a href="#faq" className="transition-colors hover:text-ink-300">
              FAQ
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
