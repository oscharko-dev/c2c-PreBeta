/**
 * Issue #272 — Studio sessionBootstrap client.
 *
 * The fetched secret never touches localStorage; the test environment
 * runs under jsdom so we can assert the absence of any side-channel
 * write as well.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetSessionBootstrapForTests,
  getSessionBootstrap,
  clearSessionBootstrap,
  SessionBootstrapError,
} from "./sessionBootstrap";

function makeFetchStub(response: { status: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

function freshSecret(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = i;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary);
}

describe("sessionBootstrap", () => {
  afterEach(() => {
    __resetSessionBootstrapForTests();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // jsdom environments without localStorage are tolerated.
    }
  });

  it("fetches the bootstrap and decodes the wrapping secret", async () => {
    const { fetch, calls } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    const record = await getSessionBootstrap({ fetch });
    expect(record.tenantId).toBe("tenant-A");
    expect(record.userId).toBe("user-1");
    expect(record.draftKeyWrappingSecret.byteLength).toBe(32);
    expect(record.draftKeyWrappingSecret[0]).toBe(0);
    expect(record.draftKeyWrappingSecret[31]).toBe(31);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v0/session/bootstrap");
    expect(calls[0].init?.method).toBe("POST");
    // credentials: include is the contract — without it the browser
    // would not attach the HttpOnly cookie.
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("memoizes the bootstrap (concurrent callers share one fetch)", async () => {
    const { fetch, calls } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    const [a, b] = await Promise.all([
      getSessionBootstrap({ fetch }),
      getSessionBootstrap({ fetch }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("re-fetches after a resolved bootstrap so logout / re-auth rotation is authoritative", async () => {
    const { fetch, calls } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    await getSessionBootstrap({ fetch });
    await getSessionBootstrap({ fetch });
    expect(calls).toHaveLength(2);
  });

  it("clearSessionBootstrap drops an in-flight bootstrap before the next call", async () => {
    const firstHandle: { resolve: ((r: Response) => void) | null } = {
      resolve: null,
    };
    const firstFetch: typeof globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        firstHandle.resolve = resolve;
      });
    const { fetch: secondFetch, calls } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-B",
        userId: "user-2",
        draftKeyWrappingSecret: freshSecret(),
      },
    });

    const first = getSessionBootstrap({ fetch: firstFetch });
    clearSessionBootstrap();
    const second = await getSessionBootstrap({ fetch: secondFetch });
    expect(second.tenantId).toBe("tenant-B");
    expect(calls).toHaveLength(1);

    firstHandle.resolve?.(
      new Response("nope", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(first).rejects.toThrow(SessionBootstrapError);
  });

  it("raises SessionBootstrapError(Unauthenticated) on 401", async () => {
    const { fetch } = makeFetchStub({
      status: 401,
      body: { error: "session cookie missing" },
    });
    await expect(getSessionBootstrap({ fetch })).rejects.toMatchObject({
      name: "SessionBootstrapError",
      kind: "Unauthenticated",
    });
  });

  it("raises InvalidResponse when the wrapping secret is the wrong size", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: globalThis.btoa("short"),
      },
    });
    const err = await getSessionBootstrap({ fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBootstrapError);
    expect((err as SessionBootstrapError).kind).toBe("InvalidResponse");
    expect((err as Error).message).toMatch(/32 bytes/);
  });

  it("raises InvalidResponse when tenantId contains an @ (defense in depth)", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "alice@example.com",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    const err = await getSessionBootstrap({ fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBootstrapError);
    expect((err as SessionBootstrapError).kind).toBe("InvalidResponse");
  });

  it("raises InvalidResponse when tenantId contains whitespace", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    const err = await getSessionBootstrap({ fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBootstrapError);
    expect((err as SessionBootstrapError).kind).toBe("InvalidResponse");
  });

  it("raises InvalidResponse when userId contains whitespace", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user 1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    const err = await getSessionBootstrap({ fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBootstrapError);
    expect((err as SessionBootstrapError).kind).toBe("InvalidResponse");
  });

  it("parses session-scoped Studio redaction additions", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
        studioRedactionPatternAdditions: [
          {
            id: "tenant:customer-secret-code",
            literal: "CUSTOMER-SECRET-CODE",
          },
        ],
      },
    });
    const record = await getSessionBootstrap({ fetch });
    expect(record.studioRedactionPatternAdditions).toEqual([
      { id: "tenant:customer-secret-code", literal: "CUSTOMER-SECRET-CODE" },
    ]);
  });

  it("does not write the wrapping secret to localStorage", async () => {
    const { fetch } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    await getSessionBootstrap({ fetch });
    const ls = globalThis.localStorage;
    if (!ls) return;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key) continue;
      const value = ls.getItem(key) ?? "";
      // ``draftKeyWrappingSecret`` and the literal base64 string both
      // sneak through if a buggy client serialized the bootstrap.
      expect(key).not.toMatch(/wrappingSecret/i);
      expect(value).not.toContain(freshSecret());
    }
  });

  it("a stale rejection does not clobber a freshly-cached success (concurrent-fetch race)", async () => {
    // Scenario: call A is in-flight (will reject later). Caller invokes
    // ``clearSessionBootstrap`` followed by a new ``getSessionBootstrap``
    // that succeeds. When call A's rejection finally lands, the cache
    // should still hold the new success — not be nulled out by the
    // stale rejection.
    const aHandle: { resolve: ((r: Response) => void) | null } = {
      resolve: null,
    };
    const fetchA: typeof globalThis.fetch = (input, init) => {
      void input;
      void init;
      return new Promise<Response>((resolve) => {
        aHandle.resolve = resolve;
      });
    };
    const fetchB: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          tenantId: "tenant-A",
          userId: "user-1",
          draftKeyWrappingSecret: freshSecret(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const promiseA = getSessionBootstrap({ fetch: fetchA });
    clearSessionBootstrap();
    const promiseB = await getSessionBootstrap({ fetch: fetchB });
    expect(promiseB.tenantId).toBe("tenant-A");

    // Now reject A. The race-safe identity check must prevent A's
    // rejection from clearing B's cached entry.
    aHandle.resolve?.(new Response("nope", { status: 500 }));
    await expect(promiseA).rejects.toThrow();

    // Resolved bootstraps are not cached. The next call must re-fetch
    // through the active dependency instead of reusing B's resolved
    // secret across a possible logout / re-auth transition.
    let refetchCount = 0;
    const refetch: typeof globalThis.fetch = async () => {
      refetchCount += 1;
      return new Response(
        JSON.stringify({
          tenantId: "tenant-C",
          userId: "user-3",
          draftKeyWrappingSecret: freshSecret(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const refreshed = await getSessionBootstrap({ fetch: refetch });
    expect(refreshed.tenantId).toBe("tenant-C");
    expect(refetchCount).toBe(1);
  });

  it("after an error, the next call retries cleanly (rejected promise is not cached)", async () => {
    let attempt = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("nope", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          tenantId: "tenant-A",
          userId: "user-1",
          draftKeyWrappingSecret: freshSecret(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await expect(getSessionBootstrap({ fetch: fetchImpl })).rejects.toThrow();
    const ok = await getSessionBootstrap({ fetch: fetchImpl });
    expect(ok.tenantId).toBe("tenant-A");
    expect(attempt).toBe(2);
  });
});
