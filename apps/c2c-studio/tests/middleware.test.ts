// Issue #271 / ADR-0005 §6: contract tests for ``src/middleware.ts``.
//
// Pin three load-bearing invariants:
//
//   1. The nonce is fresh per request — caching the response would
//      degrade ``script-src 'nonce-…'`` to a static allow-list and
//      defeat its purpose.
//   2. Every CSP directive from ADR-0005 §6 is present on every
//      matched route (HTML routes, not static assets).
//   3. ``NODE_ENV=production`` strips ``'unsafe-eval'`` while non-
//      production keeps it (Fast Refresh requires it; the dev branch
//      is the only place it appears).
//
// The static-asset skip path is exercised via a request whose
// ``pathname`` starts with one of the documented exclusions; the
// middleware short-circuits without minting a nonce or writing a
// CSP header.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BFF_OVERRIDE = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL;

function setNodeEnv(value: string | undefined): void {
  // ``process.env.NODE_ENV`` is typed as ``string`` so deletion has
  // to go through the index signature; the cast keeps strict-null
  // checks happy without ``any``.
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  } else {
    (process.env as Record<string, string>).NODE_ENV = value;
  }
}

function setBffOverride(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>)
      .NEXT_PUBLIC_C2C_BFF_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL = value;
  }
}

async function loadMiddleware() {
  return await import("../src/middleware");
}

async function makeRequest(pathname: string) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(new URL(pathname, "http://localhost:3000").toString());
}

async function runMiddleware(pathname: string): Promise<Response> {
  const { middleware } = await loadMiddleware();
  const result = middleware(await makeRequest(pathname));
  return result as unknown as Response;
}

function readCsp(response: Response): string {
  const csp = response.headers.get("content-security-policy");
  if (!csp) throw new Error("expected Content-Security-Policy header");
  return csp;
}

function readNonceFromCsp(csp: string): string {
  const match = csp.match(/'nonce-([^']+)'/);
  if (!match || !match[1]) {
    throw new Error(`no nonce in CSP: ${csp}`);
  }
  return match[1];
}

function readScriptSrc(csp: string): string {
  const match = csp.match(/script-src[^;]*/);
  if (!match) throw new Error(`no script-src in CSP: ${csp}`);
  return match[0];
}

beforeEach(() => {
  setNodeEnv("production");
  setBffOverride(undefined);
});

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
  setBffOverride(ORIGINAL_BFF_OVERRIDE);
});

describe("Studio CSP middleware — nonce-per-request uniqueness", () => {
  it("mints a fresh nonce on every request", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const csp = readCsp(await runMiddleware("/"));
      seen.add(readNonceFromCsp(csp));
    }
    expect(seen.size).toBe(32);
  });

  it("uses base64-safe characters (no single quote / line break)", async () => {
    const nonce = readNonceFromCsp(readCsp(await runMiddleware("/")));
    // CSP nonces are double-wrapped in single quotes by the directive
    // syntax. A nonce containing one would break the policy.
    expect(nonce).not.toContain("'");
    expect(nonce).not.toContain("\n");
    expect(nonce.length).toBeGreaterThanOrEqual(16);
  });
});

describe("Studio CSP middleware — header presence (ADR-0005 §6)", () => {
  it("writes the CSP response header on HTML routes", async () => {
    const csp = readCsp(await runMiddleware("/"));
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("report-uri /api/v0/csp-report");
  });

  it("forwards the nonce on the request as ``x-nonce``", async () => {
    const response = await runMiddleware("/");
    const csp = readCsp(response);
    const nonceInCsp = readNonceFromCsp(csp);
    // ``NextResponse.next({ request: { headers } })`` surfaces the
    // forwarded header on a synthetic ``x-middleware-request-x-nonce``
    // header in the response. We assert it matches the CSP nonce —
    // if they drift, framework hydration scripts emit a nonce that
    // is not in the CSP allow-list and the page breaks.
    const forwarded = response.headers.get("x-middleware-request-x-nonce");
    expect(typeof forwarded).toBe("string");
    expect(forwarded).toBe(nonceInCsp);
  });

  it("ships the defence-in-depth security headers alongside the CSP", async () => {
    const response = await runMiddleware("/");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    // Studio-IDE-12 (#250) §Memory holdover: COOP/COEP isolate the
    // page so ``measureUserAgentSpecificMemory`` works.
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("cross-origin-embedder-policy")).toBe(
      "credentialless",
    );
  });

  it("skips static asset paths (no CSP override, no nonce minted)", async () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Ffoo.png&w=64&q=75",
      "/favicon.svg",
      "/favicon.ico",
    ]) {
      const response = await runMiddleware(path);
      // The skip branch returns ``NextResponse.next()`` — neither
      // CSP nor request-header mutation happens, so the
      // ``next.config.mjs`` fallback policy flows through unchanged.
      expect(response.headers.get("content-security-policy")).toBeNull();
    }
  });
});

describe("Studio CSP middleware — dev vs production branch", () => {
  it("adds 'unsafe-eval' to script-src in non-production (Fast Refresh)", async () => {
    setNodeEnv("development");
    const csp = readCsp(await runMiddleware("/"));
    expect(readScriptSrc(csp)).toContain("'unsafe-eval'");
  });

  it("OMITS 'unsafe-eval' from script-src in production", async () => {
    setNodeEnv("production");
    const csp = readCsp(await runMiddleware("/"));
    expect(readScriptSrc(csp)).not.toContain("'unsafe-eval'");
  });

  it("adds ws:/wss: to connect-src in non-production for HMR", async () => {
    setNodeEnv("development");
    const csp = readCsp(await runMiddleware("/"));
    const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
    expect(connect).toContain("ws:");
    expect(connect).toContain("wss:");
  });

  it("OMITS ws:/wss: from connect-src in production", async () => {
    setNodeEnv("production");
    const csp = readCsp(await runMiddleware("/"));
    const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
    expect(connect).not.toContain("ws:");
    expect(connect).not.toContain("wss:");
  });

  it("NEVER includes 'unsafe-inline' on script-src in either branch", async () => {
    // ADR-0005 §6: ``'unsafe-inline'`` on script-src is explicitly
    // not acceptable. The nonce-based directive is the entire reason
    // this middleware exists.
    for (const env of ["development", "production"]) {
      setNodeEnv(env);
      const csp = readCsp(await runMiddleware("/"));
      expect(readScriptSrc(csp)).not.toContain("'unsafe-inline'");
    }
  });

  it("includes 'strict-dynamic' on script-src in both branches", async () => {
    for (const env of ["development", "production"]) {
      setNodeEnv(env);
      const csp = readCsp(await runMiddleware("/"));
      expect(readScriptSrc(csp)).toContain("'strict-dynamic'");
    }
  });
});

describe("Studio CSP middleware — BFF origin in connect-src", () => {
  it("adds a local BFF override to connect-src", async () => {
    setBffOverride("http://localhost:18089");
    const csp = readCsp(await runMiddleware("/"));
    const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
    expect(connect).toContain("http://localhost:18089");
  });

  it("rejects a non-local BFF override (CSP cannot be widened by a hostile env)", async () => {
    setBffOverride("https://evil.example.com");
    const csp = readCsp(await runMiddleware("/"));
    const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
    expect(connect).not.toContain("evil.example.com");
  });

  it("rejects a malformed BFF override silently", async () => {
    setBffOverride("not-a-url");
    const csp = readCsp(await runMiddleware("/"));
    // Falls back to ``connect-src 'self'`` only (no dev ws:/wss:
    // because we're in production for this case).
    const connect = csp.match(/connect-src[^;]*/)?.[0] ?? "";
    expect(connect).toBe("connect-src 'self'");
  });
});

describe("Studio CSP middleware — report-uri", () => {
  it("declares the ADR-0005 §6 report-uri verbatim", async () => {
    const csp = readCsp(await runMiddleware("/"));
    expect(csp).toContain("report-uri /api/v0/csp-report");
  });
});
