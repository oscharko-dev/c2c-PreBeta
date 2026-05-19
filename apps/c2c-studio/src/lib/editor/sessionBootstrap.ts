/**
 * Issue #272 / ADR-0005 §2 "Encryption at Rest" — Studio client for the
 * BFF session-bootstrap endpoint.
 *
 * Contract (mirrors `services/c2c-bff/openapi.yaml`):
 *
 *   POST /api/v0/session/bootstrap
 *     → 200 { tenantId, userId, draftKeyWrappingSecret (base64) }
 *     → 401 if the session cookie is missing or the referenced session
 *       no longer exists.
 *
 * The bootstrap is the single source of truth for the Studio
 * runtime's (tenantId, userId) and the HKDF input keying material
 * used by `editorPersistence` to derive the AES-GCM key. Per
 * ADR-0005 §2 the wrapping secret lives in memory only — it is
 * never written to localStorage, never logged, and never re-sent.
 *
 * Concurrency: a single in-flight `fetch` is shared by every caller
 * during the first session start; once it resolves, the resolved
 * promise is cached so subsequent callers receive the same record
 * without a second network round-trip. `clearSessionBootstrap` drops
 * the cache on logout / re-auth so the next call refreshes from the
 * BFF.
 *
 * Validation: the client re-runs the ADR-0005 §3 defensive checks
 * (no `@`, no whitespace) on the BFF response so a server-side
 * regression cannot smuggle an email-shaped identifier into the
 * draft-encryption AAD where it would land in IndexedDB plaintext
 * keys.
 */

export interface SessionBootstrap {
  tenantId: string;
  userId: string;
  // 32 raw bytes — the HKDF IKM. Decoded once from the base64
  // body so each call site does not repeat the base64 decode.
  draftKeyWrappingSecret: Uint8Array<ArrayBuffer>;
}

export type SessionBootstrapErrorKind =
  // The BFF returned 401. Studio surfaces this as "sign-in required"
  // and the editor persistence path raises `SessionExpiredDuringEdit`
  // so the workbench can prompt re-auth without discarding the
  // in-memory buffer (ADR-0005 §2 "Session expiry mid-edit").
  | "Unauthenticated"
  // The bootstrap response was 5xx, returned malformed JSON, or
  // failed an ADR-0005 §3 defensive check. Studio surfaces this as
  // a non-fatal "drafts unavailable" banner — durable work belongs
  // in the server-side artifact store.
  | "InvalidResponse"
  // The fetch itself failed (network error, no BFF reachable). Same
  // UI posture as `InvalidResponse`.
  | "NetworkError";

export class SessionBootstrapError extends Error {
  readonly kind: SessionBootstrapErrorKind;
  constructor(kind: SessionBootstrapErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "SessionBootstrapError";
    this.kind = kind;
  }
}

const BOOTSTRAP_PATH = "/api/v0/session/bootstrap";

// Identifier validator — same allow-list the BFF enforces. Repeating
// it here lets the Studio reject a malformed response without an
// extra round-trip and gives defense in depth against a future BFF
// regression.
const SAFE_ID_PATTERN = /^[A-Za-z0-9._\-]{1,128}$/u;

export interface SessionBootstrapDeps {
  // Override the global `fetch` for tests. The implementation always
  // passes `credentials: "include"` so the HttpOnly session cookie is
  // attached.
  fetch?: typeof globalThis.fetch;
  // Override the base URL for tests / Storybook. When omitted, the
  // module uses the shared ``resolveApiBaseUrl`` (which returns
  // ``""`` for same-origin in production and the
  // ``NEXT_PUBLIC_C2C_BFF_BASE_URL`` override during split-server
  // local dev).
  baseUrl?: string;
}

let cached: Promise<SessionBootstrap> | null = null;
let activeDeps: SessionBootstrapDeps | null = null;

export function getSessionBootstrap(
  deps: SessionBootstrapDeps = {},
): Promise<SessionBootstrap> {
  if (cached && depsMatch(activeDeps, deps)) {
    return cached;
  }
  activeDeps = deps;
  cached = fetchBootstrap(deps).catch((err) => {
    // On error, drop the cache so the next call retries cleanly. A
    // persistent rejected promise would otherwise pin the runtime
    // to a single failed bootstrap even after the network heals.
    cached = null;
    throw err;
  });
  return cached;
}

export function clearSessionBootstrap(): void {
  cached = null;
  activeDeps = null;
}

// Tests reset module-private state directly via this helper rather
// than poking at the cache through `clearSessionBootstrap`, so a
// future refactor that adds more module-private fields stays
// contained behind one entry point.
export function __resetSessionBootstrapForTests(): void {
  clearSessionBootstrap();
}

function depsMatch(
  a: SessionBootstrapDeps | null,
  b: SessionBootstrapDeps,
): boolean {
  if (a === null) return false;
  return (a.fetch ?? null) === (b.fetch ?? null) && a.baseUrl === b.baseUrl;
}

async function fetchBootstrap(
  deps: SessionBootstrapDeps,
): Promise<SessionBootstrap> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new SessionBootstrapError(
      "NetworkError",
      "fetch is not available in this environment",
    );
  }
  let baseUrl = deps.baseUrl;
  if (baseUrl === undefined) {
    // Lazy import so test environments that mock the apiBaseUrl
    // module pick up the mock; ``test.fetch`` overrides skip this
    // path entirely.
    const { resolveApiBaseUrl } = await import("@/lib/apiBaseUrl");
    const result = resolveApiBaseUrl();
    if (!result.ok) {
      throw new SessionBootstrapError(
        "InvalidResponse",
        `Failed to resolve BFF base URL: ${result.message}`,
      );
    }
    baseUrl = result.data;
  }
  const url = `${baseUrl}${BOOTSTRAP_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new SessionBootstrapError(
      "NetworkError",
      `session bootstrap fetch failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (response.status === 401) {
    throw new SessionBootstrapError(
      "Unauthenticated",
      "session bootstrap returned 401",
    );
  }
  if (!response.ok) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      `session bootstrap returned ${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      `session bootstrap response was not JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  return parseBootstrapResponse(body);
}

function parseBootstrapResponse(raw: unknown): SessionBootstrap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "session bootstrap response was not an object",
    );
  }
  const obj = raw as Record<string, unknown>;
  const tenantId = obj.tenantId;
  const userId = obj.userId;
  const secret = obj.draftKeyWrappingSecret;
  if (typeof tenantId !== "string" || !SAFE_ID_PATTERN.test(tenantId)) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "tenantId missing or malformed",
    );
  }
  if (tenantId.includes("@") || /\s/.test(tenantId)) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "tenantId must not contain '@' or whitespace (ADR-0005 §3)",
    );
  }
  if (typeof userId !== "string" || !SAFE_ID_PATTERN.test(userId)) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "userId missing or malformed",
    );
  }
  if (userId.includes("@") || /\s/.test(userId)) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "userId must not contain '@' or whitespace (ADR-0005 §3)",
    );
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "draftKeyWrappingSecret missing",
    );
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64Decode(secret);
  } catch {
    throw new SessionBootstrapError(
      "InvalidResponse",
      "draftKeyWrappingSecret is not valid base64",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new SessionBootstrapError(
      "InvalidResponse",
      `draftKeyWrappingSecret must be 32 bytes; got ${bytes.byteLength}`,
    );
  }
  return { tenantId, userId, draftKeyWrappingSecret: bytes };
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  // We avoid `Buffer` to keep this module browser-compatible without
  // a polyfill. `atob` is present in every evergreen browser and in
  // recent Node test environments.
  const binary = globalThis.atob(value);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(
    new ArrayBuffer(binary.length),
  );
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
