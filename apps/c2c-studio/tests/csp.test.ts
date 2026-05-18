// Studio-IDE-12 (#250) CSP contract test: lock the policy emitted by
// ``next.config.mjs`` so a regression that introduces ``'unsafe-eval'``
// or removes the Monaco worker source flips this assertion red.
//
// The test imports the Next.js config (an ESM module) and exercises
// its ``headers()`` callback, then validates the
// ``Content-Security-Policy`` value against the directives Issue #250
// §CSP prescribes.

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

describe("Studio-IDE-12 (#250) Content Security Policy", () => {
  it("declares default-src 'self'", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("default-src 'self'");
  });

  // ``'unsafe-eval'`` is the load-bearing protection against runtime
  // code injection. It MUST stay out of the production policy at all
  // times. The dev policy is allowed to relax this for Fast Refresh,
  // but vitest runs in NODE_ENV=test which the build treats as
  // production for the purposes of next.config.mjs.
  it("forbids 'unsafe-eval' on script-src", async () => {
    const csp = await resolveCsp();
    const scriptDirective = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it("declares script-src 'self' as the primary script source", async () => {
    const csp = await resolveCsp();
    expect(csp).toMatch(/script-src 'self'/);
  });

  // Studio-IDE-12 (#250) follow-up: production fallback CSP MUST NOT
  // permit ``'unsafe-inline'``. The middleware overrides this header
  // with a per-request nonce on every HTML response, so the only
  // routes that fall through to this fallback are static assets
  // that ship no inline scripts.
  it("production fallback forbids 'unsafe-inline' on script-src", async () => {
    const csp = await resolveCsp();
    const scriptDirective = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptDirective).not.toContain("'unsafe-inline'");
  });

  it("allows worker-src 'self' blob: for Monaco web workers", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it("forbids object embeds and frame ancestors", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("restricts connect-src to same origin (BFF)", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("connect-src 'self'");
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
