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

async function resolveCsp(): Promise<string> {
  const headersFn = (nextConfig as { headers?: () => Promise<HeaderGroup[]> })
    .headers;
  if (typeof headersFn !== "function") {
    throw new Error("next.config.mjs does not export a headers() function");
  }
  const groups = await headersFn();
  for (const group of groups) {
    for (const header of group.headers) {
      if (header.key === "Content-Security-Policy") return header.value;
    }
  }
  throw new Error(
    "Content-Security-Policy header not found in next.config.mjs",
  );
}

describe("Studio-IDE-12 (#250) Content Security Policy", () => {
  it("declares default-src 'self'", async () => {
    const csp = await resolveCsp();
    expect(csp).toContain("default-src 'self'");
  });

  it("declares script-src 'self' without unsafe-eval or unsafe-inline", async () => {
    const csp = await resolveCsp();
    expect(csp).toMatch(/script-src 'self'(;|\s|$)/);
    expect(csp).not.toContain("'unsafe-eval'");
    // The only ``'unsafe-inline'`` allowance is on style-src (Tailwind +
    // Monaco) — never on scripts.
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
    const headersFn = (nextConfig as { headers?: () => Promise<HeaderGroup[]> })
      .headers;
    const groups = await headersFn!();
    const headers = groups[0]!.headers;
    expect(headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(headers).toContainEqual({
      key: "X-Content-Type-Options",
      value: "nosniff",
    });
  });
});
