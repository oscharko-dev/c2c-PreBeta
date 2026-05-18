// Studio-IDE-12 (#250): Content Security Policy aligned with the
// DOMPurify allow-list in ``src/lib/editor/hoverMarkdownSanitizer.ts``.
//
// Policy choices (per Issue #250 §CSP):
//   * ``script-src 'self'`` — Studio bundles every script from the
//     Next.js build output. NO ``'unsafe-inline'`` and NO
//     ``'unsafe-eval'``. Monaco's Web Worker bootstrap requires
//     ``worker-src 'self' blob:`` because Next.js serves the worker
//     JS via a same-origin blob URL.
//   * ``style-src 'self' 'unsafe-inline'`` — required by Tailwind's
//     runtime utility classes and Monaco's inline style decorations.
//     This is the load-bearing tradeoff documented in Issue #250 CSP
//     section; ``hoverMarkdownSanitizer.ts`` strips every inline style
//     from user-supplied markdown so the surface area is bounded.
//   * ``img-src 'self' data:`` — Monaco's gutter glyphs are encoded
//     as data URIs.
//   * ``connect-src 'self'`` — Studio only talks to the BFF, which is
//     same-origin in deployment. Split-server dev uses an explicit
//     ``NEXT_PUBLIC_C2C_BFF_BASE_URL`` override that is also
//     same-origin (``localhost`` / ``127.0.0.1``).
//   * ``font-src 'self'`` — fonts ship via the Next.js build.
//   * ``object-src 'none'`` — no plugins.
//   * ``frame-ancestors 'none'`` — Studio is never embedded.
//   * ``base-uri 'self'`` — defence against base-tag injection.
//   * ``form-action 'self'`` — no third-party form posts.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self' blob:",
];
const CSP_HEADER_VALUE = CSP_DIRECTIVES.join("; ");

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
          { key: "Content-Security-Policy", value: CSP_HEADER_VALUE },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
