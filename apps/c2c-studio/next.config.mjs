// Studio-IDE-12 (#250): Content Security Policy aligned with the
// DOMPurify allow-list in ``src/lib/editor/hoverMarkdownSanitizer.ts``.
//
// The policy is dev-vs-production aware:
//
//   * **Development** (``npm run dev``): Next.js' Fast Refresh requires
//     ``'unsafe-eval'`` + inline scripts and opens a WebSocket connection
//     for HMR. Without those allowances the dev experience breaks
//     (blank pages, no HMR). The dev policy keeps every other gate
//     tight.
//
//   * **Production** (``next build`` output): Next.js' App Router still
//     emits hydration / RSC payload scripts inline. Implementing a
//     nonce / hash-based ``script-src 'self' 'strict-dynamic'`` policy
//     is a focused follow-up (Issue #250 review-finding); until then
//     the production policy permits ``'unsafe-inline'`` on
//     ``script-src`` so the workbench shell hydrates. Every other gate
//     stays strict (no ``'unsafe-eval'``, no third-party origins, no
//     framing, no plugins).
//
// Split-server dev (``NEXT_PUBLIC_C2C_BFF_BASE_URL=http://localhost:18089``
// while Next runs on :3000) is a different-origin setup. The CSP picks
// up the override at config-load time and adds it to ``connect-src``
// so browser fetches to the BFF succeed.
//
// Additional security headers ship alongside CSP:
//   * ``X-Content-Type-Options: nosniff``
//   * ``Referrer-Policy: strict-origin-when-cross-origin``
//   * ``X-Frame-Options: DENY`` — redundant with
//     ``frame-ancestors 'none'`` for modern browsers; kept as a
//     defence-in-depth for older user agents.

// Treat ONLY ``NODE_ENV=development`` as the relaxed-policy branch so
// the production policy is asserted in the test (``NODE_ENV=test``) and
// CI (``NODE_ENV=production`` for the build step) environments alike.
const IS_DEV = process.env.NODE_ENV === "development";
const BFF_OVERRIDE = (process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL ?? "").trim();

function safeOriginFromOverride(rawOverride) {
  if (!rawOverride) return null;
  try {
    const parsed = new URL(rawOverride);
    // Limit to local hosts — mirrors the runtime guard in
    // ``src/lib/apiBaseUrl.ts`` so the CSP cannot be widened by a
    // hostile env value.
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildConnectSrc() {
  const sources = ["'self'"];
  const bffOrigin = safeOriginFromOverride(BFF_OVERRIDE);
  if (bffOrigin) sources.push(bffOrigin);
  if (IS_DEV) {
    // Webpack HMR + Fast Refresh open a WebSocket back to the dev
    // server. Allowing same-origin ws: covers both
    // ``next dev`` (same origin as the page) and the split-server
    // case (where the override above is the BFF, not the HMR
    // socket).
    sources.push("ws:");
    sources.push("wss:");
  }
  return `connect-src ${sources.join(" ")}`;
}

function buildScriptSrc() {
  if (IS_DEV) {
    // Fast Refresh / React Refresh transformation requires
    // ``eval``-based bootstrapping. The dev allowance is intentional;
    // production keeps ``'unsafe-eval'`` out of the policy.
    return "script-src 'self' 'unsafe-eval' 'unsafe-inline'";
  }
  // Production: ``src/middleware.ts`` overrides this header on every
  // HTML response with a per-request nonced policy
  // (``script-src 'self' 'nonce-<NONCE>' 'strict-dynamic'``). The
  // policy below is the fallback used for routes the middleware
  // skips (static asset paths). Those routes ship no inline
  // scripts, so the strict ``'self'`` directive is correct and
  // ``'unsafe-inline'`` is no longer needed.
  return "script-src 'self'";
}

function buildCspHeader() {
  return [
    "default-src 'self'",
    buildScriptSrc(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    buildConnectSrc(),
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  ].join("; ");
}

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
          { key: "Content-Security-Policy", value: buildCspHeader() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
