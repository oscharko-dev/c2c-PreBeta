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
}

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  userId: string;
  // Base64-encoded 32 random bytes. ADR 0005 §2: held in memory only,
  // never logged, never re-sent by the Studio runtime.
  draftKeyWrappingSecret: string;
  createdAt: string;
}

export interface SessionStore {
  // Mints a new session and returns the full record. Caller is
  // responsible for setting the session cookie on the response.
  create(identity: SessionIdentity): SessionRecord;
  // Returns the record for an existing session, or ``null`` if the
  // session is unknown (cookie expired, server restart, logout).
  get(sessionId: string): SessionRecord | null;
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
  // ISO-8601 clock for ``createdAt``. Defaults to ``new Date()``.
  now?: () => Date;
}

export function validateSessionIdentity(identity: SessionIdentity): void {
  validateOpaqueIdentifier("tenantId", identity.tenantId);
  validateOpaqueIdentifier("userId", identity.userId);
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

export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const rng = options.randomBytes ?? randomBytes;
  const clock = options.now ?? (() => new Date());
  const sessions = new Map<string, SessionRecord>();

  return {
    create(identity: SessionIdentity): SessionRecord {
      validateSessionIdentity(identity);
      const sessionId = rng(SESSION_ID_BYTES).toString("hex");
      const secretBuf = rng(DRAFT_KEY_WRAPPING_SECRET_BYTES);
      const record: SessionRecord = {
        sessionId,
        tenantId: identity.tenantId,
        userId: identity.userId,
        draftKeyWrappingSecret: secretBuf.toString("base64"),
        createdAt: clock().toISOString(),
      };
      sessions.set(sessionId, record);
      return record;
    },
    get(sessionId: string): SessionRecord | null {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return null;
      }
      return sessions.get(sessionId) ?? null;
    },
    delete(sessionId: string): boolean {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return false;
      }
      return sessions.delete(sessionId);
    },
  };
}
