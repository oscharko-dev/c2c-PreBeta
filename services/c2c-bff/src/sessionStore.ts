// Issue #272 / ADR 0005 §2 "Encryption at Rest" — Hard prerequisite for
// Studio-IDE-3 (#247). Server-side session record for the draft-key
// wrapping flow.
//
// Lifecycle contract (ADR 0005 §2):
//
//   * The BFF generates a fresh ``draftKeyWrappingSecret`` (32 random
//     bytes) **once per auth session** at sign-in and stores it keyed
//     by ``sessionId``.
//   * Every ``POST /api/v0/session/bootstrap`` within the same auth
//     session returns the **same** secret — a page reload re-fetches
//     and can decrypt drafts written earlier in the session.
//   * Sign-in rotates the secret. Logout deletes it; the prior value
//     cannot be recovered, and drafts encrypted under it become
//     permanently unreadable.
//
// PII gate (ADR 0005 §3): ``tenantId`` and ``userId`` are **opaque
// pseudonymous identifiers**. The store rejects values that contain
// ``@`` or any whitespace as a defensive check against accidental
// email / display-name leakage into IndexedDB plaintext keys.
//
// The store is intentionally in-process: a single BFF replica is the
// canonical W0 deployment topology (Studio is a single-tenant local
// developer surface). Horizontal scale would need a shared backend
// keyed by ``sessionId`` — out of scope for #272, named follow-up
// when a real identity layer lands behind the bootstrap.

import { randomBytes } from "node:crypto";

// Length of the cryptographically random ``draftKeyWrappingSecret``.
// ADR 0005 §2 specifies 32 bytes; the HKDF-SHA-256 input keying
// material is at least that wide to give the derived AES-GCM key the
// full security margin of the algorithm.
export const DRAFT_KEY_WRAPPING_SECRET_BYTES = 32;

// SessionId is 32 random hex chars (16 bytes). Wide enough that a
// forged guess is computationally infeasible; opaque so the cookie
// value reveals nothing about the underlying identity.
const SESSION_ID_BYTES = 16;

// Identifier shape — same allow-list ``editorTelemetry.ts`` uses for
// ``x-c2c-tenant-id`` / ``x-c2c-user-id``. ADR 0005 §3 adds the rule
// that opaque identifiers must not contain ``@`` or whitespace; this
// pattern enforces both at once (the allowed character class excludes
// both).
const SAFE_ID_PATTERN = /^[A-Za-z0-9._\-]{1,128}$/u;

export class SessionIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionIdentifierError";
  }
}

export interface SessionIdentity {
  tenantId: string;
  userId: string;
  studioRedactionPatternAdditions?: RedactionPatternAddition[];
}

export interface RedactionPatternAddition {
  id: string;
  literal: string;
}

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  userId: string;
  // Base64-encoded 32 random bytes. ADR 0005 §2: held in memory only,
  // never logged, never re-sent by the Studio runtime.
  draftKeyWrappingSecret: string;
  studioRedactionPatternAdditions: RedactionPatternAddition[];
  trustCasePreferences: Record<string, string>;
  createdAt: string;
}

export interface SessionStore {
  // Mints a new session and returns the full record. Caller is
  // responsible for setting the session cookie on the response.
  create(identity: SessionIdentity): SessionRecord;
  // Returns the record for an existing session, or ``null`` if the
  // session is unknown (cookie expired, server restart, logout).
  get(sessionId: string): SessionRecord | null;
  getTrustCasePreference(sessionId: string, programId: string): string | null;
  setTrustCasePreference(
    sessionId: string,
    programId: string,
    trustCaseId: string,
  ): SessionRecord | null;
  // Deletes the session record. Returns ``true`` if the session was
  // present; ``false`` if it was already absent (idempotent logout).
  delete(sessionId: string): boolean;
}

export interface SessionStoreOptions {
  // Cryptographically random byte generator. Defaults to
  // ``node:crypto.randomBytes``; tests inject deterministic bytes so
  // the store's ID + secret allocation is observable without leaking
  // platform randomness into the assertion.
  randomBytes?: (size: number) => Buffer;
  // ISO-8601 clock for ``createdAt`` + the idle-timeout calculation.
  // Defaults to ``new Date()``.
  now?: () => Date;
  // Idle-timeout in milliseconds. A session that has not been
  // accessed (``get``) within this window is evicted on the next
  // ``get``/``create`` call. Defaults to 8 hours, matching a
  // typical interactive session length. Set to ``0`` to disable.
  idleTimeoutMs?: number;
  // Hard cap on the number of concurrent sessions held in memory.
  // When the cap would be exceeded, the oldest record by
  // ``createdAt`` is evicted first. Defaults to 10 000 — well above
  // any realistic concurrent-user count for a single BFF replica
  // and small enough that the Map's memory footprint stays
  // bounded under a flood (each record is < 200 bytes).
  maxSessions?: number;
}

export function validateSessionIdentity(identity: SessionIdentity): void {
  validateOpaqueIdentifier("tenantId", identity.tenantId);
  validateOpaqueIdentifier("userId", identity.userId);
  validateRedactionAdditions(identity.studioRedactionPatternAdditions ?? []);
}

function validateOpaqueIdentifier(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionIdentifierError(
      `${field} must be a non-empty opaque identifier`,
    );
  }
  // ADR 0005 §3: explicit ``@`` and whitespace check. The allow-list
  // pattern subsumes both, but we lift the diagnostic up so an
  // operator looking at a 400 response sees exactly what went wrong.
  if (value.includes("@")) {
    throw new SessionIdentifierError(
      `${field} must be an opaque pseudonymous identifier; '@' is forbidden (looks like an email)`,
    );
  }
  if (/\s/.test(value)) {
    throw new SessionIdentifierError(`${field} must not contain whitespace`);
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new SessionIdentifierError(
      `${field} must match [A-Za-z0-9._-]{1,128}`,
    );
  }
}

// Default idle timeout: 8 hours. A user actively editing keeps the
// session warm via the regular bootstrap re-fetch on each page
// reload; a session that goes idle this long has effectively been
// abandoned and should not pin BFF memory.
const DEFAULT_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

// Default hard cap on concurrent sessions. Each record is < 200
// bytes, so 10k records ≈ 2 MB — bounded and small. A real
// deployment with more than 10k concurrent users on a single BFF
// replica should reach for a shared session backend anyway (see
// ADR-0005 §2 named follow-ups).
const DEFAULT_MAX_SESSIONS = 10_000;
const REDACTION_ADDITION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/u;
const MAX_REDACTION_ADDITIONS = 25;
const MAX_REDACTION_LITERAL_CHARS = 256;

interface StoredRecord {
  record: SessionRecord;
  lastAccessMs: number;
  createdAtMs: number;
}

export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const rng = options.randomBytes ?? randomBytes;
  const clock = options.now ?? (() => new Date());
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, StoredRecord>();

  function nowMs(): number {
    return clock().getTime();
  }

  // Sweep idle records on every mutating call. Cheap: the map is
  // bounded by ``maxSessions`` and a single linear pass over an
  // already-capped collection is O(n) on n ≤ 10 000.
  function sweepIdle(currentMs: number): void {
    if (idleTimeoutMs <= 0) return;
    for (const [id, entry] of sessions) {
      if (currentMs - entry.lastAccessMs > idleTimeoutMs) {
        sessions.delete(id);
      }
    }
  }

  // Enforce the hard cap by evicting the oldest record (by
  // ``createdAtMs``) first. With ``Map`` iteration order being
  // insertion order, this is equivalent to a FIFO eviction policy
  // because ``createdAtMs`` is monotonic in our caller pattern.
  function evictUntilUnderCap(): void {
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  return {
    create(identity: SessionIdentity): SessionRecord {
      validateSessionIdentity(identity);
      const currentMs = nowMs();
      sweepIdle(currentMs);
      evictUntilUnderCap();
      const sessionId = rng(SESSION_ID_BYTES).toString("hex");
      const secretBuf = rng(DRAFT_KEY_WRAPPING_SECRET_BYTES);
      const record: SessionRecord = {
        sessionId,
        tenantId: identity.tenantId,
        userId: identity.userId,
        draftKeyWrappingSecret: secretBuf.toString("base64"),
        studioRedactionPatternAdditions: validateRedactionAdditions(
          identity.studioRedactionPatternAdditions ?? [],
        ),
        trustCasePreferences: {},
        createdAt: new Date(currentMs).toISOString(),
      };
      sessions.set(sessionId, {
        record,
        lastAccessMs: currentMs,
        createdAtMs: currentMs,
      });
      return record;
    },
    get(sessionId: string): SessionRecord | null {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return null;
      }
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      const currentMs = nowMs();
      if (idleTimeoutMs > 0 && currentMs - entry.lastAccessMs > idleTimeoutMs) {
        // Touch-then-delete on the idle path: a request arriving
        // exactly at the timeout boundary sees a 401 rather than a
        // half-stale record.
        sessions.delete(sessionId);
        return null;
      }
      entry.lastAccessMs = currentMs;
      return entry.record;
    },
    getTrustCasePreference(sessionId: string, programId: string): string | null {
      const record = this.get(sessionId);
      if (!record || typeof programId !== "string" || programId.length === 0) {
        return null;
      }
      return record.trustCasePreferences[programId] ?? null;
    },
    setTrustCasePreference(
      sessionId: string,
      programId: string,
      trustCaseId: string,
    ): SessionRecord | null {
      const record = this.get(sessionId);
      if (
        !record ||
        typeof programId !== "string" ||
        programId.length === 0 ||
        typeof trustCaseId !== "string" ||
        trustCaseId.length === 0
      ) {
        return null;
      }
      record.trustCasePreferences[programId] = trustCaseId;
      return record;
    },
    delete(sessionId: string): boolean {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return false;
      }
      return sessions.delete(sessionId);
    },
  };
}

function validateRedactionAdditions(
  additions: RedactionPatternAddition[],
): RedactionPatternAddition[] {
  if (!Array.isArray(additions) || additions.length > MAX_REDACTION_ADDITIONS) {
    throw new SessionIdentifierError(
      "studioRedactionPatternAdditions must be an array of at most 25 entries",
    );
  }
  return additions.map((addition) => {
    if (!addition || typeof addition !== "object") {
      throw new SessionIdentifierError(
        "studioRedactionPatternAdditions entries must be objects",
      );
    }
    const keys = Object.keys(addition).sort();
    if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "literal") {
      throw new SessionIdentifierError(
        "studioRedactionPatternAdditions entries must contain only id and literal",
      );
    }
    const { id, literal } = addition;
    if (typeof id !== "string" || !REDACTION_ADDITION_ID_PATTERN.test(id)) {
      throw new SessionIdentifierError(
        "studioRedactionPatternAdditions id must match [A-Za-z0-9._:-]{1,96}",
      );
    }
    if (
      typeof literal !== "string" ||
      literal.trim().length === 0 ||
      literal.length > MAX_REDACTION_LITERAL_CHARS
    ) {
      throw new SessionIdentifierError(
        "studioRedactionPatternAdditions literal must be 1-256 characters",
      );
    }
    return { id, literal };
  });
}
