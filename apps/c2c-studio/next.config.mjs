// Issue #271 / ADR-0005 §6: the Studio CSP is owned by
// ``src/middleware.ts``, which mints a per-request nonce and writes
// the production-grade ``script-src 'self' 'nonce-{N}' 'strict-dynamic'``
// header per the ADR. ``next.config.mjs headers()`` cannot host that
// policy because it is evaluated without per-request context.
//
// What stays here is a **static-asset fallback CSP**. The middleware
// matcher excludes ``/_next/static``, ``/_next/image``, ``/favicon``
// and ``/api`` from per-request work; those paths fall through to
// the policy below. They ship no inline scripts, so a tight
// ``script-src 'self'`` (without a nonce) is correct for them.
//
// Defence-in-depth security headers (``X-Content-Type-Options``,
// ``Referrer-Policy``, ``X-Frame-Options``) ship on every response
// from both the middleware and this fallback so they cover both
// branches without coordination.
//
// Dev-mode note: the middleware now runs in both dev and prod (see
// the ``isDev`` branch in ``src/middleware.ts``) so dev HMR no
// longer needs an ``'unsafe-eval'`` carve-out at this layer. The
// fallback below covers static assets only, where neither HMR nor
// inline scripts are in play.

const STATIC_FALLBACK_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "report-uri /api/v0/csp-report",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/favicon.ico",
        destination: "/favicon.svg?v=mirrored-20260517",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: STATIC_FALLBACK_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
