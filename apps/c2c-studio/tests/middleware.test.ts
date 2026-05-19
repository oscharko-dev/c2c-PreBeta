// Studio-IDE-12 (#250) follow-up: nonce-based CSP middleware test.
// Verifies the middleware stamps a per-request nonce on the response,
// writes the matching ``script-src 'nonce-...' 'strict-dynamic'``
// directive, and skips static-asset paths.
//
// The test runs the Edge-runtime middleware exported by
// ``src/middleware.ts`` in a synthetic NODE_ENV=production context
// using a NextRequest stub built from the public Next.js API.

import { describe, expect, it, beforeEach, afterEach } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function loadMiddleware() {
  // Dynamic import so each test can mutate ``process.env.NODE_ENV``
  // before module-level code reads it (the middleware reads it at
  // request time, but importing fresh keeps the contract symmetrical
  // across tests).
  return await import("../src/middleware");
}

async function makeRequest(pathname: string) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(new URL(pathname, "http://localhost:3000").toString());
}

beforeEach(() => {
  // Run as production for the strict-CSP branch. The dev branch is
  // tested separately below. ``process.env.NODE_ENV`` is writable in
  // the Node test runtime — direct assignment works without the
  // ``defineProperty`` dance that newer Node versions block.
  (process.env as Record<string, string>).NODE_ENV = "production";
});

afterEach(() => {
  (process.env as Record<string, string>).NODE_ENV =
    ORIGINAL_NODE_ENV ?? "test";
});

describe("Studio-IDE-12 (#250) CSP nonce middleware", () => {
  it("writes a fresh nonce + strict-dynamic CSP on a regular route", async () => {
    const { middleware } = await loadMiddleware();
    const response = middleware(await makeRequest("/"));
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp!).toMatch(
      /script-src 'self' 'nonce-[A-Za-z0-9+/]+' 'strict-dynamic'/,
    );
    expect(csp!).toContain("object-src 'none'");
    expect(csp!).toContain("frame-ancestors 'none'");
    // ``'unsafe-inline'`` lives only on ``style-src`` (Tailwind +
    // Monaco inline-style decorations) — never on ``script-src``.
    const scriptDirective = csp!.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it("emits a different nonce on each request", async () => {
    const { middleware } = await loadMiddleware();
    const a = middleware(await makeRequest("/")).headers.get(
      "Content-Security-Policy",
    );
    const b = middleware(await makeRequest("/")).headers.get(
      "Content-Security-Policy",
    );
    const noncePattern = /'nonce-([A-Za-z0-9+/]+)'/;
    const nonceA = a?.match(noncePattern)?.[1];
    const nonceB = b?.match(noncePattern)?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toEqual(nonceB);
  });

  it("ships the matching X-* defence headers", async () => {
    const { middleware } = await loadMiddleware();
    const response = middleware(await makeRequest("/"));
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("ships COOP/COEP for cross-origin isolation (memory measurement)", async () => {
    const { middleware } = await loadMiddleware();
    const response = middleware(await makeRequest("/"));
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "credentialless",
    );
  });

  it("skips static-asset paths without stamping a nonce", async () => {
    const { middleware } = await loadMiddleware();
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image?url=…",
      "/favicon.svg",
      "/favicon.ico",
    ]) {
      const response = middleware(await makeRequest(path));
      // The skip branch returns ``NextResponse.next()`` without
      // setting the CSP header — ``next.config.mjs`` ``headers()``
      // still ships its static policy for those paths.
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    }
  });

  it("does not set strict-dynamic in dev mode", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    const { middleware } = await loadMiddleware();
    const response = middleware(await makeRequest("/"));
    // Dev short-circuit returns plain ``NextResponse.next()``; the
    // permissive dev policy from ``next.config.mjs`` ships unchanged.
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });
});
