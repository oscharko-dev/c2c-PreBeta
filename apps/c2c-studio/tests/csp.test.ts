// Issue #271 / ADR-0005 §6: contract test for the **static-asset
// fallback CSP** declared in ``next.config.mjs``. The per-request
// nonce-based CSP that hydrates the App Router is owned by
// ``src/middleware.ts`` and exercised by ``tests/middleware.test.ts``.
//
// The fallback is what ships for paths the middleware matcher
// excludes — ``/_next/static``, ``/_next/image``, ``/favicon``, and
// ``/api/*``. Those paths don't run inline scripts, so a tight
// ``script-src 'self'`` (no nonce, no ``'unsafe-eval'``) is correct
// and removing it would silently widen the fallback.

import { describe, expect, it } from "vitest";
// next.config.mjs is a plain ESM module without type declarations;
// importing it for its public ``headers`` callback is the
// load-bearing contract surface here.
import nextConfig from "../next.config.mjs";

interface Header {
  key: string;
  value: string;
}
interface HeaderGroup {
  source: string;
  headers: Header[];
}

// Locate the catch-all (``source: "/:path*"``) header group instead of
// indexing the first entry positionally. A future change that
// prepends a route-scoped override (e.g. a stricter policy on
// ``/api/*``) would otherwise silently route the assertion onto the
// wrong group.
async function loadCatchAllHeaders(): Promise<Header[]> {
  const headersFn = (nextConfig as { headers?: () => Promise<HeaderGroup[]> })
    .headers;
  if (typeof headersFn !== "function") {
    throw new Error("next.config.mjs does not export a headers() function");
  }
  const groups = await headersFn();
  const catchAll = groups.find((group) => group.source === "/:path*");
  if (!catchAll) {
    throw new Error("next.config.mjs has no /:path* header group");
  }
  return catchAll.headers;
}

async function resolveCsp(): Promise<string> {
  const headers = await loadCatchAllHeaders();
  const csp = headers.find(
    (header) => header.key === "Content-Security-Policy",
  );
  if (!csp) {
    throw new Error(
      "Content-Security-Policy header not found in next.config.mjs",
    );
  }
  return csp.value;
}

describe("Studio static-asset fallback CSP (ADR-0005 §6)", () => {
  it("declares default-src 'self'", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("default-src 'self'");
  });

  it("declares script-src 'self' (no nonce, no eval) for static assets", async () => {
    const csp = await resolveCsp();
    const scriptDirective = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptDirective).toBe("script-src 'self'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
  });

  it("declares worker-src 'self' (ADR-0005 §6 — no blob:)", async () => {
    const csp = await resolveCsp();
    const workerDirective = csp.match(/worker-src[^;]*/)?.[0] ?? "";
    expect(workerDirective).toBe("worker-src 'self'");
  });

  it("forbids object embeds and frame ancestors", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("restricts connect-src to 'self' on the fallback (BFF override lives in the middleware)", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("connect-src 'self'");
  });

  it("declares img-src 'self' data: and font-src 'self' data:", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self' data:");
  });

  it("declares base-uri 'self' and form-action 'self'", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("declares the ADR-0005 §6 report-uri verbatim", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("report-uri /api/v0/csp-report");
  });

  it("ships X-Frame-Options DENY and X-Content-Type-Options nosniff", async () => {
    const headers = await loadCatchAllHeaders();
    expect(headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(headers).toContainEqual({
      key: "X-Content-Type-Options",
      value: "nosniff",
    });
  });
});
