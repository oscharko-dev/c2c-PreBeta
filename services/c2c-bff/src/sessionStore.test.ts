// Issue #272 — unit tests for the in-memory session store.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  createSessionStore,
  validateSessionIdentity,
  SessionIdentifierError,
  DRAFT_KEY_WRAPPING_SECRET_BYTES,
} from "./sessionStore";

test("validateSessionIdentity accepts opaque alphanumeric identifiers", () => {
  validateSessionIdentity({ tenantId: "tenant-A", userId: "user-1" });
  validateSessionIdentity({
    tenantId: "550e8400-e29b-41d4-a716-446655440000",
    userId: "u_42.local",
  });
});

test("validateSessionIdentity rejects @ (defends against email leakage)", () => {
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "alice@example.com",
        userId: "user-1",
      }),
    /tenantId.*@.*forbidden/,
  );
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "tenant-A",
        userId: "alice@example.com",
      }),
    /userId.*@.*forbidden/,
  );
});

test("validateSessionIdentity rejects whitespace", () => {
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "tenant A",
        userId: "user-1",
      }),
    /tenantId.*whitespace/,
  );
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "tenant-A",
        userId: "user 1",
      }),
    /userId.*whitespace/,
  );
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "tenant-A",
        userId: "user\t1",
      }),
    /userId.*whitespace/,
  );
});

test("validateSessionIdentity rejects empty and oversized identifiers", () => {
  assert.throws(
    () => validateSessionIdentity({ tenantId: "", userId: "user-1" }),
    /tenantId.*non-empty/,
  );
  const tooLong = "a".repeat(129);
  assert.throws(
    () => validateSessionIdentity({ tenantId: tooLong, userId: "user-1" }),
    /tenantId/,
  );
});

test("validateSessionIdentity rejects out-of-class punctuation", () => {
  // Slash isn't in [A-Za-z0-9._-]; the validator rejects so the
  // identifier can never end up encoded into an IndexedDB plaintext
  // key with characters that would corrupt our composite key
  // separator vocabulary.
  assert.throws(
    () => validateSessionIdentity({ tenantId: "ten/ant", userId: "user-1" }),
    SessionIdentifierError,
  );
});

test("create() mints a session record with a fresh sessionId and secret", () => {
  const store = createSessionStore();
  const record = store.create({ tenantId: "tenant-A", userId: "user-1" });
  assert.equal(typeof record.sessionId, "string");
  assert.ok(
    /^[a-f0-9]{32}$/.test(record.sessionId),
    "sessionId is 32 hex chars",
  );
  assert.equal(record.tenantId, "tenant-A");
  assert.equal(record.userId, "user-1");
  // base64 of 32 bytes is 44 chars (32/3*4 rounded up + padding).
  const secretBytes = Buffer.from(record.draftKeyWrappingSecret, "base64");
  assert.equal(secretBytes.length, DRAFT_KEY_WRAPPING_SECRET_BYTES);
  assert.deepEqual(record.studioRedactionPatternAdditions, []);
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("create() stores reviewed Studio redaction additions for bootstrap", () => {
  const store = createSessionStore();
  const record = store.create({
    tenantId: "tenant-A",
    userId: "user-1",
    studioRedactionPatternAdditions: [
      { id: "tenant:customer-secret-code", literal: "CUSTOMER-SECRET-CODE" },
    ],
  });
  assert.deepEqual(record.studioRedactionPatternAdditions, [
    { id: "tenant:customer-secret-code", literal: "CUSTOMER-SECRET-CODE" },
  ]);
});

test("validateSessionIdentity rejects redaction additions with extra fields", () => {
  assert.throws(
    () =>
      validateSessionIdentity({
        tenantId: "tenant-A",
        userId: "user-1",
        studioRedactionPatternAdditions: [
          {
            id: "tenant:customer-secret-code",
            literal: "CUSTOMER-SECRET-CODE",
            source: "unreviewed",
          } as unknown as { id: string; literal: string },
        ],
      }),
    /entries must contain only id and literal/,
  );
});

test("get() returns the same record for the same sessionId (re-fetch returns same secret)", () => {
  const store = createSessionStore();
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  const fetched1 = store.get(created.sessionId);
  const fetched2 = store.get(created.sessionId);
  assert.ok(fetched1);
  assert.ok(fetched2);
  assert.equal(
    fetched1?.draftKeyWrappingSecret,
    created.draftKeyWrappingSecret,
  );
  assert.equal(
    fetched2?.draftKeyWrappingSecret,
    created.draftKeyWrappingSecret,
  );
});

test("each create() rotates the secret (sign-in semantics)", () => {
  const store = createSessionStore();
  const first = store.create({ tenantId: "tenant-A", userId: "user-1" });
  const second = store.create({ tenantId: "tenant-A", userId: "user-1" });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(
    first.draftKeyWrappingSecret,
    second.draftKeyWrappingSecret,
    "a fresh session must use a fresh wrapping secret",
  );
});

test("delete() removes the record (logout semantics)", () => {
  const store = createSessionStore();
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  assert.equal(store.delete(created.sessionId), true);
  assert.equal(
    store.get(created.sessionId),
    null,
    "post-logout get must not return the prior secret",
  );
  assert.equal(
    store.delete(created.sessionId),
    false,
    "deleting an already-deleted session is idempotent",
  );
});

test("get() returns null for unknown / empty / non-string keys", () => {
  const store = createSessionStore();
  assert.equal(store.get(""), null);
  assert.equal(store.get("not-a-real-session"), null);
  assert.equal(store.get(undefined as unknown as string), null);
});

test("get() evicts a session that has been idle past the idle-timeout", () => {
  let now = new Date("2026-05-19T00:00:00Z");
  const store = createSessionStore({
    now: () => now,
    idleTimeoutMs: 60_000, // 60 seconds
  });
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  // 61s later, no intervening access — session has been idle the full
  // window and the next ``get`` evicts it on the way out.
  now = new Date(now.getTime() + 61_000);
  assert.equal(
    store.get(created.sessionId),
    null,
    "session past the idle timeout must be evicted",
  );
});

test("get() resets the idle window on access (touch semantics)", () => {
  let now = new Date("2026-05-19T00:00:00Z");
  const store = createSessionStore({
    now: () => now,
    idleTimeoutMs: 60_000,
  });
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  // Repeatedly poke just before the timeout — the session stays alive.
  for (let i = 0; i < 5; i += 1) {
    now = new Date(now.getTime() + 50_000);
    assert.ok(store.get(created.sessionId), `still alive at iteration ${i}`);
  }
});

test("create() enforces the max-sessions cap by evicting the oldest", () => {
  const store = createSessionStore({ maxSessions: 3 });
  const first = store.create({ tenantId: "t", userId: "a" });
  const second = store.create({ tenantId: "t", userId: "b" });
  const third = store.create({ tenantId: "t", userId: "c" });
  // 4th create triggers eviction of `first`.
  const fourth = store.create({ tenantId: "t", userId: "d" });
  assert.equal(store.get(first.sessionId), null, "oldest session evicted");
  assert.ok(store.get(second.sessionId));
  assert.ok(store.get(third.sessionId));
  assert.ok(store.get(fourth.sessionId));
});

test("idleTimeoutMs=0 disables idle eviction", () => {
  let now = new Date("2026-05-19T00:00:00Z");
  const store = createSessionStore({
    now: () => now,
    idleTimeoutMs: 0,
  });
  const created = store.create({ tenantId: "t", userId: "a" });
  // Jump a year — still alive.
  now = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.ok(store.get(created.sessionId));
});

test("randomBytes injection makes the secret + sessionId deterministic for tests", () => {
  // We hand the store a counter-driven byte generator so we can assert
  // on exact secret values. Production uses node:crypto.randomBytes.
  let counter = 0;
  const rng = (size: number): Buffer => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
      buf[i] = (counter + i) & 0xff;
    }
    counter += size;
    return buf;
  };
  const store = createSessionStore({ randomBytes: rng });
  const record = store.create({ tenantId: "t", userId: "u" });
  // First 16 bytes were 0..15 → sessionId is "000102…0f".
  assert.equal(record.sessionId, "000102030405060708090a0b0c0d0e0f");
  // Next 32 bytes were 16..47 → base64 of those bytes is the secret.
  const expectedSecret = Buffer.from(
    Array.from({ length: 32 }, (_, i) => 16 + i),
  ).toString("base64");
  assert.equal(record.draftKeyWrappingSecret, expectedSecret);
});

test("setTrustCasePreference accepts a pattern-valid trust-case id", () => {
  const store = createSessionStore();
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  const record = store.setTrustCasePreference(
    created.sessionId,
    "HELLOW02",
    "HELLOW02-PARITY",
  );
  assert.ok(record, "a valid id must persist");
  assert.equal(
    store.getTrustCasePreference(created.sessionId, "HELLOW02"),
    "HELLOW02-PARITY",
  );
});

test("setTrustCasePreference rejects a pattern-invalid trust-case id", () => {
  const store = createSessionStore();
  const created = store.create({ tenantId: "tenant-A", userId: "user-1" });
  // Lower-case, leading digit, and injection-style characters all fall
  // outside the trust-case id allow-list and must be rejected at the
  // write boundary rather than silently persisted.
  for (const invalid of [
    "hellow02-parity",
    "0HELLOW02",
    "HELLOW02 PARITY",
    "HELLOW02*/",
  ]) {
    assert.throws(
      () =>
        store.setTrustCasePreference(created.sessionId, "HELLOW02", invalid),
      /trustCaseId.*trust-case identifier pattern/,
      `must reject ${JSON.stringify(invalid)}`,
    );
  }
  assert.equal(
    store.getTrustCasePreference(created.sessionId, "HELLOW02"),
    null,
    "no rejected id may leak into the stored preference",
  );
});
