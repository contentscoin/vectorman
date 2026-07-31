/**
 * The app has no server features — no route handlers, no server actions, no
 * middleware, no `next/image` — because conversion happens in a Web Worker in the
 * browser. So it can ship as plain files on any static host.
 *
 * Static export is gated behind an env var rather than made the default, so the
 * normal server build keeps working and the choice stays reversible if a server
 * feature is ever added.
 */
const staticExport = process.env.PV_STATIC_EXPORT === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The engine is a workspace package shipping compiled ESM. Listing it here keeps
  // module resolution predictable for both the app bundle and the web worker.
  transpilePackages: ['@perfectvector/core'],

  eslint: {
    ignoreDuringBuilds: true,
  },

  ...(staticExport
    ? {
        output: 'export',
        // `/studio` becomes `/studio/index.html`, which is what a plain file server
        // resolves without rewrite rules. Hosts that do support rewrites are unaffected.
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
