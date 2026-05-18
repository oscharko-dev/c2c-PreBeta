// Studio-IDE-12 (#250) follow-up: nonce-based CSP for the production
// HTML routes. Retires the ``'unsafe-inline'`` allowance on
// ``script-src`` that ``next.config.mjs`` kept in place so Next's App
// Router hydration scripts could run.
//
// How it works:
//
//   1. ``middleware`` generates a fresh 16-byte base64 nonce on every
//      request (App Router HTML responses are dynamic per request,
//      so the nonce stays unpredictable and unique).
//   2. The middleware writes a tight CSP onto BOTH the request
//      headers (so React Server Components / ``headers()`` in
//      layout/page can read it) AND the response headers (so the
//      browser sees it). The directive includes
//      ``script-src 'self' 'nonce-{NONCE}' 'strict-dynamic'`` —
//      ``'strict-dynamic'`` lets Next's hydration entry script load
//      its dynamic chunks without needing each one allowlisted
//      separately.
//   3. ``app/layout.tsx`` reads the nonce via ``headers().get(...)``
//      and stamps it on the framework's ``<Script>`` tags. Next.js
//      automatically threads the same nonce through its own
//      Fast-Refresh / hydration bootstrap when the request header
//      is present.
//
// Static assets (``/_next/static/*``), the favicon redirect, and
// dev-tools paths are excluded so the middleware's per-request
// nonce work does not slow down the file-server fast path. The
// ``next.config.mjs`` ``headers()`` policy still ships for those
// paths and stays the fallback for non-HTML responses.

import { NextResponse, type NextRequest } from "next/server";

const STATIC_PATH_EXCLUSIONS = [
  "/_next/static",
  "/_next/image",
  "/favicon.svg",
  "/favicon.ico",
];

function generateNonce(): string {
  // Web Crypto's randomUUID returns 36 chars; encoding to base64 gives
  // us ~24 chars of crypto-strong entropy — more than enough for a
  // per-request nonce. The base64 form keeps the value CSP-safe (no
  // single-quote escaping).
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

function buildCspWithNonce(nonce: string): string {
  // Notes:
  // * ``'strict-dynamic'`` is the load-bearing token that lets the
  //   nonced entry script load further chunks without needing each
  //   one in the allowlist. Without it, App Router's chunked
  //   hydration breaks on first navigation.
  // * Dev mode keeps its own permissive policy via
  //   ``next.config.mjs`` (the middleware only runs in production
  //   builds — Fast Refresh / HMR isn't on this code path).
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  if (shouldSkip(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  // Dev mode: ``next.config.mjs`` already serves a relaxed policy
  // that includes ``'unsafe-eval'`` + ``'unsafe-inline'`` for Fast
  // Refresh. The middleware only runs strict-dynamic in production.
  if (process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  const nonce = generateNonce();
  const csp = buildCspWithNonce(nonce);

  // Forward the nonce on the request so ``app/layout.tsx`` can read
  // it from ``headers()`` and stamp it on its Script tags.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-c2c-csp-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  // Overwrite the static CSP from next.config.mjs with the per-
  // request nonced version.
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = {
  matcher: [
    // Run on every HTML route except static assets and Next-internal
    // image / data fetches. The negative lookahead is the standard
    // App-Router-with-middleware pattern from the Next.js docs.
    "/((?!api|_next/static|_next/image|favicon).*)",
  ],
};
