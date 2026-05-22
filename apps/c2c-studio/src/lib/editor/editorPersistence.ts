/**
 * Studio-IDE-3 (#247) — Editor draft persistence module.
 *
 * IndexedDB-backed local persistence for the COBOL editor buffer and the
 * Java editor buffer, governed by ADR 0005 (#240). Drafts are encrypted at
 * rest with AES-GCM 256 using a per-session HKDF-derived key.
 *
 * Key derivation (Issue #272 / ADR 0005 §2):
 *
 *   * **IKM** — the `draftKeyWrappingSecret` issued by the BFF at
 *     `POST /api/v0/session/bootstrap`. Held in memory only by
 *     `./sessionBootstrap`; never persisted, never logged. Rotates on
 *     sign-in; deleted on logout, at which point drafts encrypted
 *     under the prior secret become permanently unreadable. The
 *     placeholder per-installation localStorage secret that
 *     pre-#272 builds used is gone.
 *   * **Salt** — `SHA-256(u32be(len(tenantId)) || tenantId ||
 *     u32be(len(userId)) || userId)`. Deterministic from the
 *     identity pair, so the same scope on two devices (or on the
 *     same device after a reload) derives the same key from the
 *     same secret. Length-prefix domain separation prevents the
 *     ambiguity whereby `(tenantId="ab", userId="c")` and
 *     `(tenantId="a", userId="bc")` would otherwise hash to the
 *     same value.
 *   * **Info** — the constant ASCII string `"c2c-studio-draft-v1"`.
 *     Versions the derivation so a future v2 procedure does not
 *     collide with v1.
 *   * **Algorithm** — HKDF-SHA-256 → 256-bit AES-GCM key.
 *
 * AEAD additional-authenticated-data (AAD) per ADR 0005 §2 binds each
 * ciphertext to opaque HMAC selectors derived from its `(scope, key)` tuple
 * — a record cannot be moved or replayed under a different SourceKey and
 * still decrypt successfully. AAD is derived deterministically at both
 * encrypt and decrypt time; mismatch reports a `CorruptDraft` and the row
 * is purged.
 *
 * The module is the single source of truth for the on-disk shape. Editors
 * and stores call `saveDraft` / `loadDraft` / `clearAll` / `purgeExpired`
 * via the exported `editorPersistence` singleton.
 *
 * Errors from the public surface are surfaced as `EditorPersistenceError`
 * with a discriminated `kind` field so the UI can distinguish quota
 * exhaustion ("local storage full") from web-crypto unavailability
 * ("secure storage not available in this browser") and act accordingly.
 * On a 401 from the bootstrap endpoint mid-edit, `saveDraft` rejects
 * with `EditorPersistenceError("SessionExpiredDuringEdit")` so the
 * workbench can prompt re-auth without discarding the in-memory buffer
 * (ADR 0005 §2 "Session expiry mid-edit").
 *
 * Cross-tab strategy: last-write-wins (LWW). IndexedDB serialises writes
 * (the object store is the synchronisation point) so two tabs can save
 * concurrently without corrupting the store. Clear operations publish a
 * best-effort same-origin notification via `BroadcastChannel` plus a
 * `storage` fallback so sibling tabs can invalidate persistence-adjacent UI.
 */

import { openDB, IDBPDatabase } from "idb";

import { emit as emitTelemetry } from "@/lib/editor/editorTelemetry";
import type { JavaOriginOverlay } from "../../types/api";
import {
  getSessionBootstrap as defaultGetSessionBootstrap,
  SessionBootstrapError,
  type SessionBootstrap,
} from "./sessionBootstrap";

// ----- Public types -------------------------------------------------------

export interface DraftScope {
  tenantId: string;
  userId: string;
}

export interface CobolDraftKey {
  kind: "cobol";
  programId: string;
  sourceName: string;
}

export interface JavaDraftKey {
  kind: "java";
  programId: string;
  sourceName: string;
  javaFilePath: string;
}

export type DraftKey = CobolDraftKey | JavaDraftKey;

export interface DraftPayload {
  schemaVersion: "v0";
  kind: "cobol" | "java";
  content: string;
  bufferHash: string;
  programId?: string;
  sourceName?: string;
  javaFilePath?: string;
  lastRunInputHash?: string;
  lastRunInputContent?: string;
  generatorBaselineHash?: string;
  generatorBaselineRunId?: string;
  manualEditOverlay?: JavaOriginOverlay;
  resolvedBackendHash?: string;
  savedAt: string;
}

export interface DraftMeta {
  kind: "cobol" | "java";
  programId: string;
  sourceName: string;
  javaFilePath?: string;
  savedAt: string;
  ttlExpiresAt: string;
  isExpired: boolean;
}

export interface LoadedDraft {
  payload: DraftPayload;
  isExpired: boolean;
  savedAt: string;
  ttlExpiresAt: string;
}

export interface SaveResult {
  encryptedSize: number;
  ttlExpiresAt: string;
}

export interface ClearResult {
  purgedCount: number;
}

// Per ADR 0005 §2 "Behavioural contract": the discriminated error taxonomy
// the editor surfaces to the UI. `EditorPersistenceError.kind` lets the
// caller decide between "show re-auth prompt" (SessionExpiredDuringEdit)
// vs "show storage-full dialog" (QuotaExceeded) vs "drafts unavailable"
// (CryptoUnavailable / StorageUnavailable) without parsing string
// messages. `CorruptDraft` is reserved for future surface use; today the
// load path silently purges corrupt rows and reports a missing draft.
export type EditorPersistenceErrorKind =
  | "SessionExpiredDuringEdit"
  | "CryptoUnavailable"
  | "StorageUnavailable"
  | "QuotaExceeded"
  | "CorruptDraft";

export class EditorPersistenceError extends Error {
  readonly kind: EditorPersistenceErrorKind;
  constructor(kind: EditorPersistenceErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "EditorPersistenceError";
    this.kind = kind;
  }
}

export interface EditorPersistence {
  // Returns true iff Web Crypto and IndexedDB are both usable for the
  // current origin. UIs check this before mounting save shortcuts.
  isAvailable(): Promise<boolean>;
  saveDraft(
    scope: DraftScope,
    key: DraftKey,
    payload: DraftPayload,
  ): Promise<SaveResult>;
  loadDraft(scope: DraftScope, key: DraftKey): Promise<LoadedDraft | null>;
  purgeExpired(scope: DraftScope): Promise<ClearResult>;
  clearAll(scope: DraftScope): Promise<ClearResult>;
  clearLocalOrigin(): Promise<ClearResult>;
  countDrafts(scope: DraftScope): Promise<number>;
  listDrafts(scope: DraftScope): Promise<DraftMeta[]>;
}

export interface DraftPersistenceEvent {
  type: "drafts-cleared";
  allScopes: boolean;
  occurredAtMs: number;
}

// ----- Internal constants -------------------------------------------------

const DB_NAME = "c2c-studio-drafts";
const DB_VERSION = 2;
const STORE_NAME = "drafts";

// Persistence schema version. Bump when the on-disk record shape
// changes. v2 (Issue #272) swapped the placeholder localStorage
// client secret for the BFF-issued draft-key wrapping secret;
// records encrypted under v0 (no AAD) or v1 (localStorage secret)
// are abandoned on read — see ADR 0005 Consequences: drafts are
// working copies, not durable artifacts.
const RECORD_SCHEMA_VERSION = "v3" as const;
const RECORD_SCHEMA_VERSION_BYTE = 3;

// Default TTL: 14 days, per ADR 0005 §1.
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// HKDF parameters for AES-GCM key derivation. The `info` string is
// taken verbatim from ADR 0005 §2 — a future v2 derivation procedure
// must change this so derived keys do not collide.
const HKDF_INFO = new TextEncoder().encode("c2c-studio-draft-v1");
const AES_KEY_BITS = 256;
const AES_IV_BYTES = 12;
const SELECTOR_RECORD_DOMAIN = "c2c-studio-draft-record-v1";
const SELECTOR_SCOPE_DOMAIN = "c2c-studio-draft-scope-v1";
const DRAFT_EVENT_NAME = "c2c-studio:draft-persistence";
const DRAFT_EVENT_CHANNEL = "c2c-studio-draft-events";
const DRAFT_EVENT_STORAGE_KEY = "c2c-studio:draft-persistence-event";
const TTL_TOUCH_WINDOW_MS = 24 * 60 * 60 * 1000;

// ----- IndexedDB record shape ---------------------------------------------

interface DraftRecord {
  // HMAC selector used as IDB primary key. It is deterministic for lookup but
  // does not expose tenant/user/file identifiers in DevTools or browser data.
  key: string;
  // HMAC selector for the tenant/user scope, mirrored for scoped count/clear.
  scopeSelector: string;
  // Ciphertext (AES-GCM output is concatenated tag). Stored as ArrayBuffer
  // so IndexedDB structured-clone preserves byte fidelity.
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  // Bookkeeping fields kept in cleartext so count / clear / purge can run
  // without decrypting or cloning large ciphertext records.
  recordSchemaVersion: typeof RECORD_SCHEMA_VERSION;
  savedAtMs: number;
  ttlExpiresAtMs: number;
}

// ----- Module-private state ----------------------------------------------

let cachedDb: Promise<IDBPDatabase> | null = null;
// AES key cache. Keyed by ``(bootstrapFingerprint, tenantId, userId)``
// so a session change (sign-in rotation, logout) automatically
// invalidates the cached key. The fingerprint is a SHA-256 of the
// wrapping secret bytes — kept opaque so the raw secret never
// leaves ``sessionBootstrap``.
interface CachedAesKeyEntry {
  fingerprint: string;
  tenantId: string;
  userId: string;
  key: Promise<CryptoKey>;
}
let cachedAesKeyEntry: CachedAesKeyEntry | null = null;

interface CachedSelectorKeyEntry {
  fingerprint: string;
  key: Promise<CryptoKey>;
}
let cachedSelectorKeyEntry: CachedSelectorKeyEntry | null = null;

function isBrowserEnvironment(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.indexedDB !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined"
  );
}

function requireSubtleCrypto(): SubtleCrypto {
  if (!isBrowserEnvironment()) {
    throw new EditorPersistenceError(
      "CryptoUnavailable",
      "editorPersistence requires IndexedDB and WebCrypto.",
    );
  }
  return globalThis.crypto.subtle;
}

function getDb(): Promise<IDBPDatabase> {
  if (!cachedDb) {
    cachedDb = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        } else {
          store = transaction.objectStore(STORE_NAME);
        }

        if (oldVersion > 0 && oldVersion < DB_VERSION) {
          // v1 stored tenant/user/program/source/path metadata in cleartext.
          // Drafts are working copies, not durable artifacts, so the safest
          // migration is to remove old records rather than keep leaking
          // metadata until their TTLs expire.
          void store.clear();
        }

        if (store.indexNames.contains("by-scope")) {
          store.deleteIndex("by-scope");
        }
        if (!store.indexNames.contains("by-scope-selector")) {
          store.createIndex("by-scope-selector", "scopeSelector", {
            unique: false,
          });
        }
        if (!store.indexNames.contains("by-expiry")) {
          store.createIndex("by-expiry", "ttlExpiresAtMs", { unique: false });
        }
      },
    });
  }
  return cachedDb;
}

function toStorageUnavailableError(cause: unknown): EditorPersistenceError {
  return new EditorPersistenceError(
    "StorageUnavailable",
    `Failed to open IndexedDB: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  );
}

async function openDraftDb(): Promise<IDBPDatabase> {
  try {
    return await getDb();
  } catch (cause) {
    // A failed IDB open leaves `cachedDb` holding a rejected promise.
    // Clear it here so a later call can recover after a transient browser
    // storage failure or dev-time version mismatch.
    cachedDb = null;
    throw toStorageUnavailableError(cause);
  }
}

function isQuotaExceededError(cause: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    cause instanceof DOMException &&
    cause.name === "QuotaExceededError"
  ) {
    return true;
  }
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { name?: unknown }).name === "QuotaExceededError"
  );
}

// ----- Crypto helpers -----------------------------------------------------

// All Uint8Array values that flow into Web Crypto must be backed by a
// concrete `ArrayBuffer` (not the wider `ArrayBufferLike` union that
// `crypto.getRandomValues` and the default Uint8Array constructor return
// under TypeScript 5.7+ libs). Annotating the helper return types makes
// the constraint explicit at every call site.
type Bytes = Uint8Array<ArrayBuffer>;

function freshRandomBytes(size: number): Bytes {
  const view: Bytes = new Uint8Array(new ArrayBuffer(size));
  globalThis.crypto.getRandomValues(view);
  return view;
}

// Salt derivation per ADR 0005 §2: deterministic from the identity
// pair so the same scope on two devices derives the same key from
// the same wrapping secret. Length-prefix encoded so
// `(tenantId="ab", userId="c")` and `(tenantId="a", userId="bc")`
// do not collide.
async function deriveHkdfSalt(
  subtle: SubtleCrypto,
  scope: DraftScope,
): Promise<Bytes> {
  const encoder = new TextEncoder();
  const tenant = encoder.encode(scope.tenantId);
  const user = encoder.encode(scope.userId);
  const buffer = new ArrayBuffer(4 + tenant.byteLength + 4 + user.byteLength);
  const view = new DataView(buffer);
  const out: Bytes = new Uint8Array(buffer);
  let offset = 0;
  view.setUint32(offset, tenant.byteLength, false);
  offset += 4;
  out.set(tenant, offset);
  offset += tenant.byteLength;
  view.setUint32(offset, user.byteLength, false);
  offset += 4;
  out.set(user, offset);
  // ``subtle.digest`` accepts any ``BufferSource`` per the spec,
  // but the jsdom polyfill that vitest uses in CI only accepts a
  // concrete typed-array / DataView and rejects a bare
  // ``ArrayBuffer``. Pass the ``Uint8Array`` view so both Node's
  // native WebCrypto and jsdom's polyfill agree.
  const digest = await subtle.digest("SHA-256", out);
  return new Uint8Array(digest) as Bytes;
}

// Fingerprint of the wrapping secret used as a cache key. Stays
// opaque so the raw secret never leaves this module and the cache
// entry can be compared in constant time across sessions.
async function fingerprintSecret(
  subtle: SubtleCrypto,
  secret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await subtle.digest("SHA-256", secret);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function deriveAesKey(bootstrap: SessionBootstrap): Promise<CryptoKey> {
  const subtle = requireSubtleCrypto();
  const fingerprint = await fingerprintSecret(
    subtle,
    bootstrap.draftKeyWrappingSecret,
  );
  if (
    cachedAesKeyEntry &&
    cachedAesKeyEntry.fingerprint === fingerprint &&
    cachedAesKeyEntry.tenantId === bootstrap.tenantId &&
    cachedAesKeyEntry.userId === bootstrap.userId
  ) {
    return cachedAesKeyEntry.key;
  }
  const keyPromise = (async () => {
    const salt = await deriveHkdfSalt(subtle, {
      tenantId: bootstrap.tenantId,
      userId: bootstrap.userId,
    });
    const baseKey = await subtle.importKey(
      "raw",
      bootstrap.draftKeyWrappingSecret,
      "HKDF",
      false,
      ["deriveKey"],
    );
    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: HKDF_INFO,
      },
      baseKey,
      { name: "AES-GCM", length: AES_KEY_BITS },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  cachedAesKeyEntry = {
    fingerprint,
    tenantId: bootstrap.tenantId,
    userId: bootstrap.userId,
    key: keyPromise,
  };
  // If derivation throws, drop the cache so the next call retries
  // cleanly.
  keyPromise.catch(() => {
    if (cachedAesKeyEntry?.key === keyPromise) {
      cachedAesKeyEntry = null;
    }
  });
  return keyPromise;
}

async function deriveSelectorHmacKey(
  bootstrap: SessionBootstrap,
): Promise<CryptoKey> {
  const subtle = requireSubtleCrypto();
  const fingerprint = await fingerprintSecret(
    subtle,
    bootstrap.draftKeyWrappingSecret,
  );
  if (
    cachedSelectorKeyEntry &&
    cachedSelectorKeyEntry.fingerprint === fingerprint
  ) {
    return cachedSelectorKeyEntry.key;
  }
  const keyPromise = subtle.importKey(
    "raw",
    bootstrap.draftKeyWrappingSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedSelectorKeyEntry = {
    fingerprint,
    key: keyPromise,
  };
  keyPromise.catch(() => {
    if (cachedSelectorKeyEntry?.key === keyPromise) {
      cachedSelectorKeyEntry = null;
    }
  });
  return keyPromise;
}

function encodeLengthPrefixedFields(domain: string, fields: string[]): Bytes {
  const encoder = new TextEncoder();
  const encodedFields = [domain, ...fields].map((field) =>
    encoder.encode(field),
  );
  const fieldsBytes = encodedFields.reduce((sum, f) => sum + f.byteLength, 0);
  const buffer = new ArrayBuffer(4 * encodedFields.length + fieldsBytes);
  const view = new DataView(buffer);
  const out: Bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const field of encodedFields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    out.set(field, offset);
    offset += field.byteLength;
  }
  return out;
}

async function hmacSelector(
  bootstrap: SessionBootstrap,
  domain: string,
  fields: string[],
): Promise<string> {
  const subtle = requireSubtleCrypto();
  const selectorKey = await deriveSelectorHmacKey(bootstrap);
  const signature = await subtle.sign(
    "HMAC",
    selectorKey,
    encodeLengthPrefixedFields(domain, fields),
  );
  return `${RECORD_SCHEMA_VERSION}:${bytesToHex(new Uint8Array(signature))}`;
}

function draftKeySelectorFields(
  bootstrap: SessionBootstrap,
  key: DraftKey,
): string[] {
  return [
    bootstrap.tenantId,
    bootstrap.userId,
    key.kind,
    key.programId,
    key.sourceName,
    key.kind === "java" ? key.javaFilePath : ".",
  ];
}

async function deriveRecordSelector(
  bootstrap: SessionBootstrap,
  key: DraftKey,
): Promise<string> {
  return hmacSelector(
    bootstrap,
    SELECTOR_RECORD_DOMAIN,
    draftKeySelectorFields(bootstrap, key),
  );
}

async function deriveScopeSelector(
  bootstrap: SessionBootstrap,
): Promise<string> {
  return hmacSelector(bootstrap, SELECTOR_SCOPE_DOMAIN, [
    bootstrap.tenantId,
    bootstrap.userId,
  ]);
}

// AEAD AAD per ADR 0005 §2: binds the ciphertext to opaque selectors derived
// from its key + identity scope. A row that decrypts without AAD verification
// is treated as CorruptDraft. The clear IndexedDB record therefore never needs
// tenant/user/program/source/path metadata to authenticate replay attempts.
function deriveAad(recordKey: string, scopeSelector: string): Bytes {
  const encoder = new TextEncoder();
  const fields = [encoder.encode(recordKey), encoder.encode(scopeSelector)];
  const fieldsBytes = fields.reduce((sum, f) => sum + f.byteLength, 0);
  // 1 byte schema version + 4-byte u32be length prefix per selector.
  const totalLength = 1 + 4 * fields.length + fieldsBytes;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const out: Bytes = new Uint8Array(buffer);
  let offset = 0;
  view.setUint8(offset, RECORD_SCHEMA_VERSION_BYTE);
  offset += 1;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    out.set(field, offset);
    offset += field.byteLength;
  }
  return out;
}

async function encryptPayload(
  bootstrap: SessionBootstrap,
  recordKey: string,
  scopeSelector: string,
  payload: DraftPayload,
): Promise<{ iv: Bytes; ciphertext: ArrayBuffer }> {
  const subtle = requireSubtleCrypto();
  const aesKey = await deriveAesKey(bootstrap);
  const iv = freshRandomBytes(AES_IV_BYTES);
  const plaintextSource = new TextEncoder().encode(JSON.stringify(payload));
  // Copy into a fresh ArrayBuffer-backed view so TypeScript's strict
  // BufferSource typing accepts the value at the subtle.encrypt boundary.
  const plaintext: Bytes = new Uint8Array(
    new ArrayBuffer(plaintextSource.byteLength),
  );
  plaintext.set(plaintextSource);
  const additionalData = deriveAad(recordKey, scopeSelector);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    aesKey,
    plaintext,
  );
  return { iv, ciphertext };
}

async function decryptPayload(
  bootstrap: SessionBootstrap,
  recordKey: string,
  scopeSelector: string,
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer,
): Promise<DraftPayload | null> {
  try {
    const subtle = requireSubtleCrypto();
    const aesKey = await deriveAesKey(bootstrap);
    const additionalData = deriveAad(recordKey, scopeSelector);
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), additionalData },
      aesKey,
      ciphertext,
    );
    const text = new TextDecoder().decode(plaintext);
    const parsed = JSON.parse(text) as DraftPayload;
    if (parsed.schemaVersion !== "v0") {
      // Payload-level schema mismatch (distinct from record-level
      // RECORD_SCHEMA_VERSION). A future Studio writing payload "v1"
      // ends up here; we drop it so the current build does not
      // misinterpret unknown fields.
      return null;
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof EditorPersistenceError) {
      throw cause;
    }
    // AAD mismatch, tampered ciphertext, key change (sign-in rotation,
    // logout), or schema drift. Treat as CorruptDraft: return null so
    // the caller falls back to backend content; the load path purges
    // the row so subsequent reads do not keep failing. Typed runtime
    // availability errors propagate above and never delete a valid row.
    return null;
  }
}

// ----- Cross-tab persistence events --------------------------------------

function publishDraftPersistenceEvent(event: DraftPersistenceEvent): void {
  const eventTarget =
    typeof window !== "undefined" ? window : (undefined as Window | undefined);
  eventTarget?.dispatchEvent(
    new CustomEvent(DRAFT_EVENT_NAME, { detail: event }),
  );

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(DRAFT_EVENT_CHANNEL);
      channel.postMessage(event);
      channel.close();
    } catch {
      // BroadcastChannel is best-effort only; storage fallback below covers
      // browsers that disable it in private/storage-constrained modes.
    }
  }

  try {
    const storage = globalThis.localStorage;
    storage?.setItem(DRAFT_EVENT_STORAGE_KEY, JSON.stringify(event));
    storage?.removeItem(DRAFT_EVENT_STORAGE_KEY);
  } catch {
    // Some browser modes deny localStorage; same-tab dispatch still happened.
  }
}

export function subscribeToDraftPersistenceEvents(
  listener: (event: DraftPersistenceEvent) => void,
): () => void {
  const eventTarget =
    typeof window !== "undefined" ? window : (undefined as Window | undefined);
  const handleCustomEvent = (event: Event) => {
    listener((event as CustomEvent<DraftPersistenceEvent>).detail);
  };
  eventTarget?.addEventListener(DRAFT_EVENT_NAME, handleCustomEvent);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(DRAFT_EVENT_CHANNEL);
      channel.onmessage = (event: MessageEvent<DraftPersistenceEvent>) => {
        listener(event.data);
      };
    } catch {
      channel = null;
    }
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== DRAFT_EVENT_STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      listener(JSON.parse(event.newValue) as DraftPersistenceEvent);
    } catch {
      // Ignore malformed same-origin storage events.
    }
  };
  eventTarget?.addEventListener("storage", handleStorage);

  return () => {
    eventTarget?.removeEventListener(DRAFT_EVENT_NAME, handleCustomEvent);
    eventTarget?.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}

// ----- Public API ---------------------------------------------------------

export type SessionBootstrapProvider = () => Promise<SessionBootstrap>;

function makePersistence(
  options: {
    ttlMs?: number;
    nowMs?: () => number;
    sessionBootstrap?: SessionBootstrapProvider;
  } = {},
): EditorPersistence {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const sessionBootstrapProvider =
    options.sessionBootstrap ?? defaultGetSessionBootstrap;

  // Fetches the active session bootstrap and asserts that the scope
  // the caller asked us to operate on (the `(tenantId, userId)` pair
  // in the SourceKey path) matches the BFF-issued identity. A
  // mismatch means a caller is passing the placeholder
  // `("default", "local")` after #272 should have replaced it; we
  // refuse the operation rather than let a wrong key derive a
  // wrong AES key. The check also surfaces 401 from the bootstrap
  // as `SessionExpiredDuringEdit` per ADR-0005 §2.
  async function bootstrapFor(scope: DraftScope): Promise<SessionBootstrap> {
    let bootstrap: SessionBootstrap;
    try {
      bootstrap = await sessionBootstrapProvider();
    } catch (cause) {
      if (
        cause instanceof SessionBootstrapError &&
        cause.kind === "Unauthenticated"
      ) {
        throw new EditorPersistenceError(
          "SessionExpiredDuringEdit",
          "Session expired during edit; re-authentication required.",
        );
      }
      // CryptoUnavailable is the closest existing kind for "bootstrap
      // is unreachable" — the UI surfaces it as "drafts unavailable"
      // and disables save, matching the documented degraded-mode
      // posture. Cause is preserved for diagnostic surfaces.
      throw new EditorPersistenceError(
        "CryptoUnavailable",
        cause instanceof Error
          ? `Session bootstrap unavailable: ${cause.message}`
          : "Session bootstrap unavailable",
      );
    }
    if (
      bootstrap.tenantId !== scope.tenantId ||
      bootstrap.userId !== scope.userId
    ) {
      throw new EditorPersistenceError(
        "SessionExpiredDuringEdit",
        "Draft scope does not match the active session.",
      );
    }
    return bootstrap;
  }

  async function isAvailable(): Promise<boolean> {
    if (!isBrowserEnvironment()) {
      return false;
    }
    try {
      await getDb();
      return true;
    } catch {
      // Reset the cached DB promise so a transient open failure (e.g.,
      // mid-upgrade race during dev hot reload) does not pin the
      // module to an unrecoverable rejected promise.
      cachedDb = null;
      return false;
    }
  }

  async function saveDraft(
    scope: DraftScope,
    key: DraftKey,
    payload: DraftPayload,
  ): Promise<SaveResult> {
    if (payload.kind !== key.kind) {
      throw new Error(
        `editorPersistence.saveDraft: payload.kind (${payload.kind}) does not match key.kind (${key.kind}).`,
      );
    }
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const recordKey = await deriveRecordSelector(bootstrap, key);
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const encryptedPayload: DraftPayload = {
      ...payload,
      programId: key.programId,
      sourceName: key.sourceName,
    };
    if (key.kind === "java") {
      encryptedPayload.javaFilePath = key.javaFilePath;
    }
    const { iv, ciphertext } = await encryptPayload(
      bootstrap,
      recordKey,
      scopeSelector,
      encryptedPayload,
    );
    const savedAtMs = nowMs();
    const ttlExpiresAtMs = savedAtMs + ttlMs;
    const record: DraftRecord = {
      key: recordKey,
      scopeSelector,
      ciphertext,
      // Capture the IV bytes into a freshly-allocated ArrayBuffer so the
      // record type is concrete (`ArrayBuffer`, not `ArrayBufferLike`) and
      // survives IndexedDB structured cloning unambiguously.
      iv: (() => {
        const copy = new ArrayBuffer(iv.byteLength);
        new Uint8Array(copy).set(iv);
        return copy;
      })(),
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      savedAtMs,
      ttlExpiresAtMs,
    };
    try {
      await db.put(STORE_NAME, record);
    } catch (cause) {
      // QuotaExceededError is a DOMException name; IndexedDB raises it as
      // a generic error event whose `name` matches. We surface it as a
      // distinct error so the UI can show a "local storage full" dialog
      // without a string-match on the message.
      if (isQuotaExceededError(cause)) {
        throw new EditorPersistenceError(
          "QuotaExceeded",
          "Storage quota exceeded while saving the draft.",
        );
      }
      throw cause;
    }
    // Studio-IDE-11 (#251): tag-only persistence telemetry. The
    // `encrypted` field is always `true` here because every draft this
    // module writes goes through AES-GCM (ADR 0005 §2); the boolean is
    // load-bearing for the learning signal that records the encrypted
    // local-save flow, not a hypothetical plaintext fallback.
    emitTelemetry({
      eventType: "save.local",
      payload: { kind: key.kind, encrypted: true },
    });
    return {
      encryptedSize: ciphertext.byteLength,
      ttlExpiresAt: new Date(ttlExpiresAtMs).toISOString(),
    };
  }

  async function loadDraft(
    scope: DraftScope,
    key: DraftKey,
  ): Promise<LoadedDraft | null> {
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const recordKey = await deriveRecordSelector(bootstrap, key);
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const record = (await db.get(STORE_NAME, recordKey)) as
      | DraftRecord
      | undefined;
    if (!record) {
      return null;
    }
    if (
      record.recordSchemaVersion !== RECORD_SCHEMA_VERSION ||
      record.scopeSelector !== scopeSelector
    ) {
      // Old-schema row (e.g., a v0 record from a previous Studio build
      // before AAD was bound, or a v1 record encrypted under the
      // pre-#272 localStorage secret). Drop it so the next save can
      // succeed without colliding on the primary key.
      await db.delete(STORE_NAME, record.key);
      return null;
    }
    const payload = await decryptPayload(
      bootstrap,
      record.key,
      record.scopeSelector,
      record.iv,
      record.ciphertext,
    );
    if (!payload) {
      // AAD mismatch, tampered ciphertext, or key change. Silently drop
      // so a stale record does not block the next save.
      await db.delete(STORE_NAME, record.key);
      return null;
    }
    const currentMs = nowMs();
    const isExpired = record.ttlExpiresAtMs <= currentMs;
    let ttlExpiresAtMs = record.ttlExpiresAtMs;
    const msUntilExpiry = record.ttlExpiresAtMs - currentMs;
    const touchWindowMs = Math.min(ttlMs / 2, TTL_TOUCH_WINDOW_MS);
    if (!isExpired && msUntilExpiry <= touchWindowMs) {
      // ADR-0005 §1: opening a live draft explicitly touches its TTL
      // without changing savedAt. To avoid rewriting large encrypted blobs on
      // every file switch, only coalesce the touch when the record is nearing
      // expiry; fresh records keep their existing TTL.
      ttlExpiresAtMs = currentMs + ttlMs;
      await db.put(STORE_NAME, { ...record, ttlExpiresAtMs });
    }
    return {
      payload,
      isExpired,
      savedAt: new Date(record.savedAtMs).toISOString(),
      ttlExpiresAt: new Date(ttlExpiresAtMs).toISOString(),
    };
  }

  async function purgeExpired(scope: DraftScope): Promise<ClearResult> {
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const scopeIndex = store.index("by-scope-selector");
    const currentMs = nowMs();
    const range = IDBKeyRange.only(scopeSelector);
    let purgedCount = 0;
    let cursor = await scopeIndex.openCursor(range);
    while (cursor) {
      const record = cursor.value as DraftRecord;
      if (record.ttlExpiresAtMs <= currentMs) {
        await store.delete(record.key);
        purgedCount += 1;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return { purgedCount };
  }

  async function clearAll(scope: DraftScope): Promise<ClearResult> {
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const scopeIndex = store.index("by-scope-selector");
    const range = IDBKeyRange.only(scopeSelector);
    let purgedCount = 0;
    let cursor = await scopeIndex.openKeyCursor(range);
    while (cursor) {
      await store.delete(cursor.primaryKey);
      purgedCount += 1;
      cursor = await cursor.continue();
    }
    await tx.done;
    publishDraftPersistenceEvent({
      type: "drafts-cleared",
      allScopes: false,
      occurredAtMs: nowMs(),
    });
    return { purgedCount };
  }

  async function clearLocalOrigin(): Promise<ClearResult> {
    const db = await openDraftDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const purgedCount = await store.count();
    await store.clear();
    await tx.done;
    publishDraftPersistenceEvent({
      type: "drafts-cleared",
      allScopes: true,
      occurredAtMs: nowMs(),
    });
    return { purgedCount };
  }

  async function countDrafts(scope: DraftScope): Promise<number> {
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const tx = db.transaction(STORE_NAME, "readonly");
    const count = await tx
      .objectStore(STORE_NAME)
      .index("by-scope-selector")
      .count(IDBKeyRange.only(scopeSelector));
    await tx.done;
    return count;
  }

  async function listDrafts(scope: DraftScope): Promise<DraftMeta[]> {
    const bootstrap = await bootstrapFor(scope);
    const db = await openDraftDb();
    const scopeSelector = await deriveScopeSelector(bootstrap);
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const scopeIndex = store.index("by-scope-selector");
    const range = IDBKeyRange.only(scopeSelector);
    const records = (await scopeIndex.getAll(range)) as DraftRecord[];
    await tx.done;
    const out: DraftMeta[] = [];
    const currentMs = nowMs();
    for (const record of records) {
      if (record.recordSchemaVersion === RECORD_SCHEMA_VERSION) {
        const payload = await decryptPayload(
          bootstrap,
          record.key,
          record.scopeSelector,
          record.iv,
          record.ciphertext,
        );
        if (
          payload &&
          payload.programId &&
          payload.sourceName &&
          (payload.kind === "cobol" || payload.javaFilePath)
        ) {
          out.push({
            kind: payload.kind,
            programId: payload.programId,
            sourceName: payload.sourceName,
            javaFilePath:
              payload.kind === "java" ? payload.javaFilePath : undefined,
            savedAt: new Date(record.savedAtMs).toISOString(),
            ttlExpiresAt: new Date(record.ttlExpiresAtMs).toISOString(),
            isExpired: record.ttlExpiresAtMs <= currentMs,
          });
        }
      }
    }
    return out;
  }

  return {
    isAvailable,
    saveDraft,
    loadDraft,
    purgeExpired,
    clearAll,
    clearLocalOrigin,
    countDrafts,
    listDrafts,
  };
}

// Default singleton with the ADR-defined 14-day TTL.
export const editorPersistence: EditorPersistence = makePersistence();

// Factory for tests / future per-tenant override (ADR-2 §1
// configurability). Tests inject a stub ``sessionBootstrap`` provider
// so the encryption path is exercised without standing up a BFF.
export function createEditorPersistence(options: {
  ttlMs?: number;
  nowMs?: () => number;
  sessionBootstrap?: SessionBootstrapProvider;
}): EditorPersistence {
  return makePersistence(options);
}

// Test-only reset for vitest. Closes any cached IDB connection (so a
// subsequent `indexedDB.deleteDatabase` does not block on an open
// handle), then drops the cached DB handle and AES key cache so the
// next call re-derives them. Not exported through the public API
// surface beyond tests.
export async function __resetEditorPersistenceForTests(): Promise<void> {
  if (cachedDb) {
    try {
      const db = await cachedDb;
      db.close();
    } catch {
      // The cached promise may have rejected; nothing to close.
    }
  }
  cachedDb = null;
  cachedAesKeyEntry = null;
  cachedSelectorKeyEntry = null;
}

// ----- Scope helpers ------------------------------------------------------

// Module-level provider for ``getCurrentDraftScope``. Lives in
// lockstep with the default ``editorPersistence`` singleton so a
// test that swaps the provider sees the same view of the active
// session from both surfaces.
let currentDraftScopeProvider: SessionBootstrapProvider =
  defaultGetSessionBootstrap;

// Issue #272 / ADR-0005 §2: the Studio reads its draft scope from the
// BFF session-bootstrap surface. The placeholder
// ``{ tenantId: "default", userId: "local" }`` that pre-#272 builds
// returned has been removed; callers must `await` this and handle
// `SessionBootstrapError` (typically by promoting it to the
// re-auth UI flow). The function is intentionally thin — it routes
// to the session bootstrap so a future identity-layer integration
// changes nothing else in the call sites.
export async function getCurrentDraftScope(): Promise<DraftScope> {
  const bootstrap = await currentDraftScopeProvider();
  return { tenantId: bootstrap.tenantId, userId: bootstrap.userId };
}

// Test-only override for ``getCurrentDraftScope``. Mirrors the
// ``sessionBootstrap`` option on ``createEditorPersistence`` so a
// vitest suite can drive both the singleton and the standalone
// helper through one stub. Pass ``undefined`` to restore the
// default. Not exported through the public API surface beyond
// tests.
export function __setCurrentDraftScopeProviderForTests(
  provider: SessionBootstrapProvider | undefined,
): void {
  currentDraftScopeProvider = provider ?? defaultGetSessionBootstrap;
}
