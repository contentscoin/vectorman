import type { Metadata } from 'next';
import { Nav } from '@/components/landing/Nav';
import { Studio } from '@/components/studio/Studio';

export const metadata: Metadata = {
  title: 'Studio — PerfectVector',
  description: 'Convert and refine a raster image into a clean, editable SVG.',
};

export default function StudioPage() {
  return (
    <>
      <Nav />
      <main className="section py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
          <p className="mt-1.5 text-sm text-ink-300">
            Drop an image, adjust the trace, merge colors, then export. Everything runs locally.
          </p>
        </div>
        <div id="converter" className="rounded-2xl border border-ink-700 bg-ink-900/40 p-4 sm:p-6">
          <Studio />
        </div>
      </main>
    </>
  );
}
