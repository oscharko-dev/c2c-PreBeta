// Issue #272 — integration tests for the BFF session-bootstrap surface.
//
// These tests stand up the real HTTP handler via ``createApp`` so the
// cookie plumbing, the 401 path, and the same-secret-per-session
// contract are exercised end-to-end. Upstream clients default to the
// "disabled" stubs ``resolveDeps`` builds for blank URLs — the
// session routes don't touch any upstream so we don't need to
// inject explicit stubs here.

import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";

import { createApp } from "./server";
import { createRunStore } from "./run-store";
import { createSessionStore } from "./sessionStore";
import { SESSION_COOKIE_NAME } from "./sessionCookie";
import type { BffConfig } from "./config";

const baseConfig: BffConfig = {
  serviceName: "c2c-bff",
  port: 0,
  repoRoot: "/tmp/c2c-test-root",
  staticRoot: "/tmp/c2c-test-static-does-not-exist",
  orchestratorUrl: "",
  orchestratorControlToken: "",
  evidenceUrl: "",
  experienceLearningUrl: "",
  modelGatewayUrl: "",
  harnessUrl: "",
  buildTestRunnerUrl: "",
  buildTestRunnerControlToken: "",
  formatJavaTimeoutMs: 1_000,
  formatJavaSourceMaxBytes: 4_096,
  upstreamTimeoutMs: 1_000,
  transformSourceMaxBytes: 1_000_000,
  artifactContentMaxBytes: 1_048_576,
  enableDiagnosticFixtures: false,
  enableFixtureSessions: true,
  forceSecureSessionCookies: false,
  studioCorsOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
};

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: http.RequestListener,
): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface FetchResult {
  status: number;
  body: unknown;
  setCookie: string[];
}

async function fetchWithCookies(
  url: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string;
    forwardedProto?: string;
    origin?: string;
  } = {},
): Promise<FetchResult> {
  const target = new URL(url);
  const bodyBytes =
    init.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(init.body));
  const headers: Record<string, string> = { accept: "application/json" };
  if (bodyBytes) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(bodyBytes.length);
  }
  if (init.cookie) headers["cookie"] = init.cookie;
  if (init.forwardedProto) headers["x-forwarded-proto"] = init.forwardedProto;
  if (init.origin) headers["origin"] = init.origin;
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: init.method ?? "GET",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown = raw;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          const rawSetCookie = res.headers["set-cookie"];
          const setCookie = Array.isArray(rawSetCookie)
            ? rawSetCookie
            : typeof rawSetCookie === "string"
              ? [rawSetCookie]
              : [];
          resolve({
            status: res.statusCode ?? 0,
            body: parsed,
            setCookie,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyBytes) req.write(bodyBytes);
    req.end();
  });
}

interface RawHeadersResult {
  status: number;
  headers: Record<string, string>;
}

async function fetchRawHeaders(
  url: string,
  init: { method?: string; cookie?: string; origin?: string } = {},
): Promise<RawHeadersResult> {
  const target = new URL(url);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.cookie) headers["cookie"] = init.cookie;
  if (init.origin) headers["origin"] = init.origin;
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: init.method ?? "GET",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        const merged: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          merged[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : value;
        }
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: merged }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function extractSessionCookieValue(setCookie: string[]): string | null {
  for (const header of setCookie) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    return first.slice(eq + 1).trim();
  }
  return null;
}

function makeApp(overrides: { config?: Partial<BffConfig> } = {}) {
  return createApp({
    config: { ...baseConfig, ...overrides.config },
    // Empty sample / acceptance-fixture registries so ``resolveDeps``
    // does not try to read on-disk fixtures the session-routes tests
    // do not care about.
    samples: { list: () => [], get: () => undefined },
    acceptanceFixtures: {
      list: () => [],
      get: () => undefined,
      fixtures: () => [],
    },
    runStore: createRunStore(),
    sessionStore: createSessionStore(),
  });
}

test("POST /api/v0/session/bootstrap returns 401 when no cookie is present", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      { method: "POST" },
    );
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "session cookie missing" });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/bootstrap returns 401 + clears cookie when the cookie is forged", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      {
        method: "POST",
        cookie: `${SESSION_COOKIE_NAME}=forged0000000000000000000000000000`,
      },
    );
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "session not found" });
    // Cookie clearing is part of the contract: the browser must drop
    // the forged value rather than keep replaying it on every page.
    const cleared = result.setCookie.find((h) =>
      h.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    assert.ok(
      cleared,
      "bootstrap must send a Set-Cookie that clears the value",
    );
    assert.match(cleared as string, /Max-Age=0/);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/sign-in mints a session and sets HttpOnly + SameSite=Lax cookie", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: {} },
    );
    assert.equal(result.status, 200);
    const body = result.body as { tenantId: string; userId: string };
    assert.match(body.tenantId, /^tenant-[a-f0-9]{16}$/);
    assert.match(body.userId, /^user-[a-f0-9]{16}$/);
    const cookie = result.setCookie[0] ?? "";
    assert.match(cookie, /^c2c\.sid=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    // Localhost HTTP test — Secure must be absent so the browser will
    // send the cookie back.
    assert.doesNotMatch(cookie, /Secure/);
    // The body MUST NOT carry the wrapping secret — that comes from
    // ``/api/v0/session/bootstrap`` so a network log of sign-in
    // requests does not expose the key material.
    assert.equal(
      (body as { draftKeyWrappingSecret?: unknown }).draftKeyWrappingSecret,
      undefined,
    );
  } finally {
    await server.close();
  }
});

test("session routes reject browser requests from unlisted origins", async () => {
  const server = await startTestServer(makeApp());
  try {
    const signIn = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: {},
        origin: "http://localhost:5173",
      },
    );
    assert.equal(signIn.status, 403);
    assert.equal(
      (signIn.body as Record<string, unknown>).error,
      "origin not allowed",
    );
    assert.deepEqual(signIn.setCookie, []);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/sign-in accepts identity overrides for test fixtures", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: { tenantId: "tenant-A", userId: "user-1" },
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { tenantId: "tenant-A", userId: "user-1" });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/sign-in rejects @ in identifiers (ADR-0005 §3 defense)", async () => {
  const server = await startTestServer(makeApp());
  try {
    const tenantBad = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: { tenantId: "alice@example.com", userId: "user-1" },
      },
    );
    assert.equal(tenantBad.status, 400);
    const tenantBody = tenantBad.body as { error: string };
    assert.match(tenantBody.error, /tenantId.*@.*forbidden/);
    const userBad = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: { tenantId: "tenant-A", userId: "alice@example.com" },
      },
    );
    assert.equal(userBad.status, 400);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/sign-in rejects whitespace in identifiers", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: { tenantId: "tenant A", userId: "user-1" },
      },
    );
    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /tenantId.*whitespace/);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/sign-in returns 404 when fixture sessions are disabled (prod posture)", async () => {
  const server = await startTestServer(
    makeApp({ config: { enableFixtureSessions: false } }),
  );
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: {} },
    );
    assert.equal(result.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/bootstrap returns the same secret on repeated calls (same-secret-per-session)", async () => {
  const server = await startTestServer(makeApp());
  try {
    const signIn = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: { tenantId: "tenant-A", userId: "user-1" } },
    );
    const cookieValue = extractSessionCookieValue(signIn.setCookie);
    assert.ok(cookieValue, "sign-in must set a session cookie");
    const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieValue}`;

    const first = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      { method: "POST", cookie: cookieHeader },
    );
    const second = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      { method: "POST", cookie: cookieHeader },
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const firstBody = first.body as {
      tenantId: string;
      userId: string;
      draftKeyWrappingSecret: string;
    };
    const secondBody = second.body as typeof firstBody;
    assert.equal(firstBody.tenantId, "tenant-A");
    assert.equal(firstBody.userId, "user-1");
    assert.equal(
      firstBody.draftKeyWrappingSecret,
      secondBody.draftKeyWrappingSecret,
      "bootstrap returns the same wrapping secret for the lifetime of a session",
    );
    // 32 bytes → base64 length 44 (including padding).
    assert.equal(
      Buffer.from(firstBody.draftKeyWrappingSecret, "base64").length,
      32,
    );
  } finally {
    await server.close();
  }
});

test("a fresh sign-in rotates the wrapping secret (drafts under the prior key become unreadable)", async () => {
  const server = await startTestServer(makeApp());
  try {
    const signIn1 = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: { tenantId: "tenant-A", userId: "user-1" } },
    );
    const cookie1 = `${SESSION_COOKIE_NAME}=${extractSessionCookieValue(
      signIn1.setCookie,
    )}`;
    const boot1 = (
      await fetchWithCookies(`${server.baseUrl}/api/v0/session/bootstrap`, {
        method: "POST",
        cookie: cookie1,
      })
    ).body as { draftKeyWrappingSecret: string };

    const signIn2 = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: { tenantId: "tenant-A", userId: "user-1" } },
    );
    const cookie2 = `${SESSION_COOKIE_NAME}=${extractSessionCookieValue(
      signIn2.setCookie,
    )}`;
    const boot2 = (
      await fetchWithCookies(`${server.baseUrl}/api/v0/session/bootstrap`, {
        method: "POST",
        cookie: cookie2,
      })
    ).body as { draftKeyWrappingSecret: string };

    assert.notEqual(
      boot1.draftKeyWrappingSecret,
      boot2.draftKeyWrappingSecret,
      "a fresh sign-in must produce a fresh wrapping secret",
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/logout deletes the session (subsequent bootstrap returns 401)", async () => {
  const server = await startTestServer(makeApp());
  try {
    const signIn = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: { tenantId: "tenant-A", userId: "user-1" } },
    );
    const cookieValue = extractSessionCookieValue(signIn.setCookie);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieValue}`;
    const bootOk = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      { method: "POST", cookie: cookieHeader },
    );
    assert.equal(bootOk.status, 200);

    const logout = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/logout`,
      { method: "POST", cookie: cookieHeader },
    );
    assert.equal(logout.status, 204);
    const cleared = logout.setCookie.find((h) =>
      h.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    assert.ok(cleared);
    assert.match(cleared as string, /Max-Age=0/);

    const after = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      { method: "POST", cookie: cookieHeader },
    );
    assert.equal(after.status, 401);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/session/logout is idempotent without a cookie", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/logout`,
      { method: "POST" },
    );
    assert.equal(result.status, 204);
  } finally {
    await server.close();
  }
});

test("session cookie gets Secure when the request claims X-Forwarded-Proto=https", async () => {
  const server = await startTestServer(makeApp());
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: {}, forwardedProto: "https" },
    );
    const cookie = result.setCookie[0] ?? "";
    assert.match(cookie, /Secure/);
  } finally {
    await server.close();
  }
});

test("session cookie gets Secure when forceSecureSessionCookies is set", async () => {
  const server = await startTestServer(
    makeApp({ config: { forceSecureSessionCookies: true } }),
  );
  try {
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: {} },
    );
    const cookie = result.setCookie[0] ?? "";
    assert.match(cookie, /Secure/);
  } finally {
    await server.close();
  }
});

test("sign-in body cap rejects oversized payloads with 413", async () => {
  const server = await startTestServer(makeApp());
  try {
    // 2 KiB payload — well above the 1 KiB cap.
    const result = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      {
        method: "POST",
        body: { tenantId: "tenant-A", userId: "u", filler: "x".repeat(2048) },
      },
    );
    assert.equal(result.status, 413);
  } finally {
    await server.close();
  }
});

test("bootstrap response preserves Vary: Origin and Cookie for CORS caches", async () => {
  const server = await startTestServer(makeApp());
  try {
    const signIn = await fetchWithCookies(
      `${server.baseUrl}/api/v0/session/sign-in`,
      { method: "POST", body: { tenantId: "tenant-A", userId: "user-1" } },
    );
    const cookieValue = extractSessionCookieValue(signIn.setCookie);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieValue}`;
    // Use a raw http.request so we can inspect response headers directly.
    const rawResponse = await fetchRawHeaders(
      `${server.baseUrl}/api/v0/session/bootstrap`,
      {
        method: "POST",
        cookie: cookieHeader,
        origin: "http://127.0.0.1:3000",
      },
    );
    assert.equal(rawResponse.status, 200);
    // Vary may be set as multiple headers or comma-joined; allow either.
    const vary = (rawResponse.headers.vary ?? "").toLowerCase();
    assert.match(
      vary,
      /cookie/,
      `bootstrap response must include 'Vary: Cookie' so a CDN cannot serve one user's wrapping secret to another (got: '${rawResponse.headers.vary ?? "<missing>"}')`,
    );
    assert.match(
      vary,
      /origin/,
      `bootstrap response must keep 'Vary: Origin' for credentialed CORS responses (got: '${rawResponse.headers.vary ?? "<missing>"}')`,
    );
    assert.equal(
      rawResponse.headers["access-control-allow-origin"],
      "http://127.0.0.1:3000",
    );
    // The existing jsonResponse helper also stamps Cache-Control: no-store —
    // assert that too so the contract is observable from one test.
    assert.match(
      (rawResponse.headers["cache-control"] ?? "").toLowerCase(),
      /no-store/,
    );
  } finally {
    await server.close();
  }
});

test("sign-in rate limiter rejects the 11th hit per IP within the default window", async () => {
  const server = await startTestServer(makeApp());
  try {
    // The default limiter is 10 hits per minute. Burst 10 sign-ins from
    // a single peer (the test client is always 127.0.0.1) and the 11th
    // must come back 429.
    let allowedCount = 0;
    let firstRejected = -1;
    for (let i = 0; i < 11; i += 1) {
      const result = await fetchWithCookies(
        `${server.baseUrl}/api/v0/session/sign-in`,
        { method: "POST", body: {} },
      );
      if (result.status === 200) allowedCount += 1;
      if (result.status === 429 && firstRejected === -1) firstRejected = i;
    }
    assert.equal(allowedCount, 10, "first 10 hits must succeed");
    assert.equal(firstRejected, 10, "11th hit must be 429");
  } finally {
    await server.close();
  }
});
