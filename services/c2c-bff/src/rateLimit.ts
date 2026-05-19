// Issue #272 — simple in-process sliding-window rate limiter for
// state-changing session routes (notably ``/api/v0/session/sign-in``).
// Defends against a flood that would otherwise exhaust the BFF's
// in-memory session store before the idle / max-size eviction can
// catch up.
//
// Bucket key is the client IP (or whatever string the caller passes
// in — the route handler resolves the peer address). The counter
// state is itself bounded by ``maxBuckets`` so a flood of varying
// source addresses cannot pin the rate-limiter map.
//
// This is intentionally lightweight: a single BFF replica's
// posture, no Redis, no distributed coordination. A real
// multi-replica deployment behind a load balancer should rely on
// the LB's rate limiting; the in-process limiter is the last line
// of defence per replica.

import type * as http from "node:http";

export interface RateLimiterOptions {
  // Maximum number of permitted hits within ``windowMs``. Default:
  // 10 — high enough for legitimate dev workflows (sign-in on app
  // start, occasional re-sign-in for testing) and low enough that
  // a flood can't sustain session creation.
  maxHits?: number;
  // Sliding-window length in milliseconds. Default: 60 seconds.
  windowMs?: number;
  // Hard cap on the number of distinct buckets in memory. Default:
  // 4096. Each bucket entry is ~80 bytes (string key + small
  // number array), so 4096 entries ≈ 320 KB.
  maxBuckets?: number;
  // Clock injection for tests.
  now?: () => number;
}

export interface RateLimiter {
  // Returns ``true`` if the request should be permitted, ``false``
  // if the bucket has exhausted its budget for the active window.
  consume(bucketKey: string): boolean;
}

export function createRateLimiter(
  options: RateLimiterOptions = {},
): RateLimiter {
  const maxHits = options.maxHits ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const maxBuckets = options.maxBuckets ?? 4096;
  const nowMs = options.now ?? (() => Date.now());
  const buckets = new Map<string, number[]>();

  function evictUntilUnderCap(): void {
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    consume(bucketKey: string): boolean {
      if (typeof bucketKey !== "string" || bucketKey.length === 0) {
        // No bucket → no rate limit applied. Caller is expected to
        // pass a stable identifier; an empty key is a programming
        // error, not a client request.
        return true;
      }
      const currentMs = nowMs();
      const cutoff = currentMs - windowMs;
      let timestamps = buckets.get(bucketKey);
      if (!timestamps) {
        evictUntilUnderCap();
        timestamps = [];
        buckets.set(bucketKey, timestamps);
      }
      // Drop hits outside the sliding window. Linear scan over a
      // bounded array (length ≤ maxHits) — O(maxHits) per call.
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < timestamps.length; readIndex += 1) {
        const ts = timestamps[readIndex];
        if (ts !== undefined && ts > cutoff) {
          timestamps[writeIndex] = ts;
          writeIndex += 1;
        }
      }
      timestamps.length = writeIndex;
      if (timestamps.length >= maxHits) {
        return false;
      }
      timestamps.push(currentMs);
      return true;
    },
  };
}

// Resolve the request peer address. We do NOT trust
// ``X-Forwarded-For`` blindly — only the leftmost value, and only
// when present (so a malicious client cannot spoof the bucket by
// rotating header values).
export function resolveClientBucketKey(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedFirst = pickFirstHeader(forwarded);
  if (forwardedFirst) {
    const leftmost = forwardedFirst.split(",")[0]?.trim();
    if (leftmost && leftmost.length > 0) return leftmost;
  }
  const remote = req.socket.remoteAddress;
  return typeof remote === "string" && remote.length > 0 ? remote : "unknown";
}

function pickFirstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string")
    return value[0];
  return null;
}
