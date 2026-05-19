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

  it("clearSessionBootstrap forces the next call to re-fetch (logout / re-auth)", async () => {
    const { fetch, calls } = makeFetchStub({
      status: 200,
      body: {
        tenantId: "tenant-A",
        userId: "user-1",
        draftKeyWrappingSecret: freshSecret(),
      },
    });
    await getSessionBootstrap({ fetch });
    clearSessionBootstrap();
    await getSessionBootstrap({ fetch });
    expect(calls).toHaveLength(2);
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
