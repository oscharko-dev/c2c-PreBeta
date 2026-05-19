// Issue #272 — unit tests for the in-process sliding-window rate
// limiter that guards the session-bootstrap fixture sign-in route.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type * as http from "node:http";

import { createRateLimiter, resolveClientBucketKey } from "./rateLimit";

test("consume() permits hits up to maxHits within the window", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({
    maxHits: 3,
    windowMs: 60_000,
    now: () => now,
  });
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(
    limiter.consume("ip-1"),
    false,
    "4th hit within the window is rejected",
  );
});

test("consume() resets after the window slides past stale hits", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({
    maxHits: 2,
    windowMs: 1_000,
    now: () => now,
  });
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(limiter.consume("ip-1"), false);
  // Move past the window.
  now += 1_500;
  assert.equal(
    limiter.consume("ip-1"),
    true,
    "after the window slides past, the bucket is empty again",
  );
});

test("consume() isolates buckets by key", () => {
  const limiter = createRateLimiter({ maxHits: 1, windowMs: 60_000 });
  assert.equal(limiter.consume("ip-1"), true);
  assert.equal(limiter.consume("ip-2"), true);
  assert.equal(limiter.consume("ip-1"), false);
  assert.equal(
    limiter.consume("ip-2"),
    false,
    "each bucket exhausts independently",
  );
});

test("consume() permits empty keys (defensive: caller is expected to pass a stable id)", () => {
  const limiter = createRateLimiter({ maxHits: 1, windowMs: 60_000 });
  // An empty key bypasses the bucket. The caller — the route handler —
  // resolves a peer-address fallback that's never empty in practice;
  // an empty key here means a programming error, not a client flood.
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.consume(""), true);
  }
});

test("consume() enforces the maxBuckets cap (FIFO eviction)", () => {
  const limiter = createRateLimiter({
    maxHits: 1,
    windowMs: 60_000,
    maxBuckets: 3,
  });
  limiter.consume("ip-1");
  limiter.consume("ip-2");
  limiter.consume("ip-3");
  // Add a 4th bucket — evicts the oldest (ip-1).
  limiter.consume("ip-4");
  // ip-1's eviction means its single-hit budget is fresh again.
  assert.equal(limiter.consume("ip-1"), true);
});

test("resolveClientBucketKey ignores spoofable X-Forwarded-For headers", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.99, 203.0.113.100" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;

  assert.equal(resolveClientBucketKey(req), "127.0.0.1");
});
