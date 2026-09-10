/**
 * Build and deploy concerns.
 *
 * `basePath` has to be settled at build time, before the YAML config layer has
 * loaded, so it is the one setting read straight from the environment — the
 * profiles declare it as ${BASE_PATH:} for exactly that reason.
 */

const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Deliberately not `output: 'standalone'`. Standalone builds their own
  // server.js, and this application has its own entry point in
  // server-bootstrap.mjs; the image needs full node_modules regardless, because
  // the Playwright and Lighthouse CLIs are spawned from it.
  basePath,
  reactStrictMode: true,
  poweredByHeader: false,

  // Next prefixes its own links and assets with the base path but not a
  // hand-written fetch, so the API client needs the same value. Derived here
  // rather than set twice, which is how the two would drift.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },

  // Spawned as child processes rather than imported, so the bundler must leave
  // them alone: tracing them into the build would pull a browser download into
  // the image.
  serverExternalPackages: ['@playwright/test', 'playwright-core', 'lighthouse'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Monaco ships its workers as blobs and styles itself inline.
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
              "style-src 'self' 'unsafe-inline'",
              "worker-src 'self' blob:",
              "img-src 'self' data: blob:",
              "media-src 'self' blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              // The Playwright HTML report is served into an iframe from our
              // own origin; nothing else may frame us.
              "frame-src 'self'",
              "frame-ancestors 'self'",
              "object-src 'none'",
              "base-uri 'self'",
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
