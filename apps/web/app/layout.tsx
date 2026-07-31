import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PerfectVector — Free AI Image to SVG, Clean and Editable',
  description:
    'Convert PNG and JPG into clean, editable SVGs. Low node count, every color on its own layer, and an honest answer about whether your image will trace well.',
  openGraph: {
    title: 'PerfectVector — Image to clean, editable SVG',
    description:
      'Clean paths, a low node count, and every color already on its own layer. Converted entirely in your browser.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#converter"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-950"
        >
          Skip to the converter
        </a>
        {children}
      </body>
    </html>
  );
}
