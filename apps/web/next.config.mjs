/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The engine is a workspace package shipping compiled ESM. Listing it here keeps
  // module resolution predictable for both the app bundle and the web worker.
  transpilePackages: ['@perfectvector/core'],

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
