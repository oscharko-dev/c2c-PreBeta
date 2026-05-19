// Issue #271 / ADR-0005 §6 "CSP Compatibility": Studio CSP plumbing.
//
// Mints a per-request 128-bit nonce, writes the production CSP onto
// the response, and forwards the nonce on the request as ``x-nonce``
// so the App Router renderer threads it through every framework-
// emitted ``<script>`` tag (hydration bootstrap, RSC Flight payload,
// ``next/script``). Pages that own custom scripts read the same
// header via ``headers().get("x-nonce")`` and stamp it themselves.
//
// Why a middleware (not ``next.config.mjs headers()``):
//
//   ``headers()`` in ``next.config.mjs`` is evaluated without a
//   per-request context — it cannot mint the ``{NONCE}`` value that
//   the CSP requires, and it cannot communicate that value to the App
//   Router renderer for re-use in the inline framework scripts. The
//   nonce, the CSP header, and the framework scripts must agree on a
//   single value, and the only place that single value can be born is
//   a middleware that runs once per request.
//
// Dev-mode branch: ``script-src`` adds ``'unsafe-eval'`` because
// Next.js' Fast Refresh transformer compiles modules with ``eval``.
// The dev policy is the only place this token appears. Production
// keeps it out.
//
// Static assets, Next-internal image / data fetches, the favicon
// redirect, and the BFF-proxied ``/api/*`` paths are excluded by the
// matcher so the per-request nonce work does not sit on the file-
// server fast path. The fallback policy in ``next.config.mjs``
// (``script-src 'self'`` only — no inline scripts on those paths)
// covers them.

import { NextResponse, type NextRequest } from "next/server";

const STATIC_PATH_EXCLUSIONS = [
  "/_next/static",
  "/_next/image",
  "/favicon.svg",
  "/favicon.ico",
];

// Local-host allow-list mirrors the split-server dev guard in
// ``src/lib/apiBaseUrl.ts``. A non-local override is treated as
// absent so a hostile env value cannot widen the CSP.
const LOCAL_OVERRIDE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function generateNonce(): string {
  // 16 random bytes → ~22 base64 chars (no padding). RFC 8941
  // recommends ≥128 bits of entropy for CSP nonces; this matches the
  // Next.js documentation example verbatim.
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  // Edge runtime exposes ``btoa`` for base64 encoding.
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

function shouldSkip(pathname: string): boolean {
  for (const prefix of STATIC_PATH_EXCLUSIONS) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function safeBffOrigin(): string | null {
  const raw = (process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL ?? "").trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (!LOCAL_OVERRIDE_HOSTS.has(parsed.hostname)) return null;
  return parsed.origin;
}

interface CspContext {
  nonce: string;
  isDev: boolean;
}

function buildCsp({ nonce, isDev }: CspContext): string {
  // ADR-0005 §6 production CSP, additive over today's empty baseline.
  // Order mirrors the ADR table so a future reviewer can diff this
  // file against the ADR without re-sorting in their head.
  const scriptSrcParts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDev) {
    // Next.js Fast Refresh uses ``eval``-based bootstrapping. Only the
    // dev branch carries this token; the production policy must never
    // include it.
    scriptSrcParts.push("'unsafe-eval'");
  }

  const connectSrcParts = ["'self'"];
  const bffOrigin = safeBffOrigin();
  if (bffOrigin) connectSrcParts.push(bffOrigin);
  if (isDev) {
    // HMR opens a WebSocket back to the dev server. Cover both
    // same-origin (``next dev``) and the split-server case where the
    // BFF override is the API origin but the HMR socket is still
    // local.
    connectSrcParts.push("ws:", "wss:");
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrcParts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    `connect-src ${connectSrcParts.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/v0/csp-report",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  if (shouldSkip(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const isDev = process.env.NODE_ENV !== "production";
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, isDev });

  // Forward the nonce on the request so the App Router renderer
  // (``headers().get("x-nonce")`` in layout/page) threads it onto
  // every framework-emitted script. Next.js' renderer specifically
  // looks for ``x-nonce`` to auto-propagate to its own hydration
  // bootstrap and RSC Flight payload tags.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  // Studio-IDE-12 (#250) §Memory: ``performance.measureUserAgentSpecificMemory()``
  // in Chromium requires a cross-origin-isolated context. COOP
  // same-origin + COEP credentialless gives us isolation while still
  // allowing same-origin embeds (workers, BFF). Studio embeds nothing
  // cross-origin today; a future feature that needs to must opt-in on
  // the embedded resource via CORP headers.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  return response;
}

export const config = {
  matcher: [
    // Run on every HTML route except static assets, Next-internal
    // image / data fetches, and the BFF-proxied ``/api/*`` paths.
    // The negative lookahead is the standard App-Router-with-
    // middleware pattern from the Next.js docs.
    "/((?!api|_next/static|_next/image|favicon).*)",
  ],
};
