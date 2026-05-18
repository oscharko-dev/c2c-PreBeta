/**
 * Studio-IDE-3 (#247) — Editor draft persistence module.
 *
 * IndexedDB-backed local persistence for the COBOL editor buffer and the
 * Java editor buffer, governed by ADR 0005 (#240). Drafts are encrypted at
 * rest with AES-GCM 256 using a per-installation HKDF-derived key; the
 * client secret lives in localStorage so drafts survive reload/restart but
 * become unreadable if the user clears site data.
 *
 * AEAD additional-authenticated-data (AAD) per ADR 0005 §2 binds each
 * ciphertext to its `(schemaVersion, scope, key)` tuple — a record cannot
 * be moved or replayed under a different SourceKey and still decrypt
 * successfully. AAD is derived deterministically at both encrypt and
 * decrypt time; mismatch reports a `CorruptDraft` and the row is purged.
 *
 * The module is the single source of truth for the on-disk shape. Editors
 * and stores call `saveDraft` / `loadDraft` / `clearAll` / `purgeExpired`
 * via the exported `editorPersistence` singleton.
 *
 * Errors from the public surface are surfaced as `EditorPersistenceError`
 * with a discriminated `kind` field so the UI can distinguish quota
 * exhaustion ("local storage full") from web-crypto unavailability
 * ("secure storage not available in this browser") and act accordingly.
 *
 * Cross-tab strategy: last-write-wins (LWW). IndexedDB serialises writes
 * (the object store is the synchronisation point) so two tabs can save
 * concurrently without corrupting the store. Tabs do not actively notify
 * each other; a `BroadcastChannel`-backed coordination upgrade is feasible
 * without changing the API (ADR 0005 named follow-up).
 */

import { openDB, IDBPDatabase } from "idb";

import type { JavaOriginOverlay } from "../../types/api";

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
  lastRunInputHash?: string;
  generatorBaselineHash?: string;
  generatorBaselineRunId?: string;
  manualEditOverlay?: JavaOriginOverlay;
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
  purgeExpired(): Promise<ClearResult>;
  clearAll(scope: DraftScope): Promise<ClearResult>;
  listDrafts(scope: DraftScope): Promise<DraftMeta[]>;
}

// ----- Internal constants -------------------------------------------------

const DB_NAME = "c2c-studio-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";

// Persistence schema version. Bump when the on-disk record shape changes.
// v1 introduced AAD-bound AES-GCM records per ADR 0005 §2. Records written
// under v0 (no AAD) are abandoned on read — see ADR 0005 Consequences:
// drafts are working copies, not durable artifacts.
const RECORD_SCHEMA_VERSION = "v1" as const;
const RECORD_SCHEMA_VERSION_BYTE = 1;

// Default TTL: 14 days, per ADR 0005 §1.
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// HKDF parameters for AES-GCM key derivation.
const HKDF_SALT_BYTES = 16;
const HKDF_INFO = new TextEncoder().encode("c2c-studio:editor-draft-aead:v0");
const CLIENT_SECRET_BYTES = 32;
const CLIENT_SECRET_LS_KEY = "c2c-studio:persistence:client-secret";
const HKDF_SALT_LS_KEY = "c2c-studio:persistence:hkdf-salt";
const AES_KEY_BITS = 256;
const AES_IV_BYTES = 12;

// ----- IndexedDB record shape ---------------------------------------------

interface DraftRecord {
  // Composite key used as IDB primary key.
  key: string;
  // Tenant + user scope, mirrored from the composite key for index lookup.
  tenantId: string;
  userId: string;
  kind: "cobol" | "java";
  programId: string;
  sourceName: string;
  javaFilePath?: string;
  // Ciphertext (AES-GCM output is concatenated tag). Stored as ArrayBuffer
  // so IndexedDB structured-clone preserves byte fidelity.
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  // Bookkeeping fields kept in cleartext so list / purge can run without
  // decrypting every record. None of these reveal source content.
  recordSchemaVersion: typeof RECORD_SCHEMA_VERSION;
  savedAtMs: number;
  ttlExpiresAtMs: number;
}

// ----- Module-private state ----------------------------------------------

let cachedDb: Promise<IDBPDatabase> | null = null;
let cachedAesKey: Promise<CryptoKey> | null = null;

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
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("by-scope", ["tenantId", "userId"], {
            unique: false,
          });
          store.createIndex("by-expiry", "ttlExpiresAtMs", { unique: false });
        }
      },
    });
  }
  return cachedDb;
}

// ----- Storage backend (localStorage with safe fallback) ------------------

interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let storageBackend: StorageBackend | null = null;

function getStorage(): StorageBackend {
  if (storageBackend) {
    return storageBackend;
  }
  try {
    const probeKey = `${CLIENT_SECRET_LS_KEY}:probe`;
    globalThis.localStorage.setItem(probeKey, "1");
    globalThis.localStorage.removeItem(probeKey);
    storageBackend = {
      getItem: (key) => globalThis.localStorage.getItem(key),
      setItem: (key, value) => {
        globalThis.localStorage.setItem(key, value);
      },
    };
    return storageBackend;
  } catch {
    // localStorage unavailable (private browsing on some legacy browsers,
    // or a sandboxed iframe). Fall back to an in-memory map so the
    // module still functions for the session — drafts will be unreadable
    // after reload, which matches the documented degraded-mode behaviour.
    const memory = new Map<string, string>();
    storageBackend = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
    return storageBackend;
  }
}

// ----- Crypto helpers -----------------------------------------------------

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  // btoa is present in browser and jsdom.
  return globalThis.btoa(binary);
}

// All Uint8Array values that flow into Web Crypto must be backed by a
// concrete `ArrayBuffer` (not the wider `ArrayBufferLike` union that
// `crypto.getRandomValues` and the default Uint8Array constructor return
// under TypeScript 5.7+ libs). Annotating the helper return types makes
// the constraint explicit at every call site.
type Bytes = Uint8Array<ArrayBuffer>;

function base64Decode(value: string): Bytes {
  const binary = globalThis.atob(value);
  const out: Bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function freshRandomBytes(size: number): Bytes {
  const view: Bytes = new Uint8Array(new ArrayBuffer(size));
  globalThis.crypto.getRandomValues(view);
  return view;
}

function getOrCreateClientSecret(): Bytes {
  const storage = getStorage();
  const existing = storage.getItem(CLIENT_SECRET_LS_KEY);
  if (existing) {
    try {
      const decoded = base64Decode(existing);
      if (decoded.byteLength === CLIENT_SECRET_BYTES) {
        return decoded;
      }
    } catch {
      // fall through and regenerate.
    }
  }
  const fresh = freshRandomBytes(CLIENT_SECRET_BYTES);
  storage.setItem(CLIENT_SECRET_LS_KEY, base64Encode(fresh));
  return fresh;
}

function getOrCreateHkdfSalt(): Bytes {
  const storage = getStorage();
  const existing = storage.getItem(HKDF_SALT_LS_KEY);
  if (existing) {
    try {
      const decoded = base64Decode(existing);
      if (decoded.byteLength === HKDF_SALT_BYTES) {
        return decoded;
      }
    } catch {
      // regenerate below.
    }
  }
  const fresh = freshRandomBytes(HKDF_SALT_BYTES);
  storage.setItem(HKDF_SALT_LS_KEY, base64Encode(fresh));
  return fresh;
}

async function deriveAesKey(): Promise<CryptoKey> {
  if (!cachedAesKey) {
    cachedAesKey = (async () => {
      const subtle = requireSubtleCrypto();
      const secret = getOrCreateClientSecret();
      const salt = getOrCreateHkdfSalt();
      const baseKey = await subtle.importKey("raw", secret, "HKDF", false, [
        "deriveKey",
      ]);
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
  }
  return cachedAesKey;
}

// AEAD AAD per ADR 0005 §2: binds the ciphertext to its key + identity
// scope. A row that decrypts without AAD verification is treated as
// CorruptDraft. The layout is length-prefix domain-separated so e.g.
// (tenantId="ab", userId="c") cannot collide with (tenantId="a",
// userId="bc"). Order is fixed:
//   u8(schemaVersion)
//   u32be(len(tenantId))   || tenantId
//   u32be(len(userId))     || userId
//   u32be(len(programId))  || programId
//   u32be(len(sourceName)) || sourceName
//   u32be(len(kind))       || kind        // bufferKind in ADR vocabulary
//   u32be(len(bufferPath)) || bufferPath  // javaFilePath for java, "." for cobol
function deriveAad(scope: DraftScope, key: DraftKey): Bytes {
  const encoder = new TextEncoder();
  const fields = [
    encoder.encode(scope.tenantId),
    encoder.encode(scope.userId),
    encoder.encode(key.programId),
    encoder.encode(key.sourceName),
    encoder.encode(key.kind),
    encoder.encode(key.kind === "java" ? key.javaFilePath : "."),
  ];
  const fieldsBytes = fields.reduce((sum, f) => sum + f.byteLength, 0);
  // 1 byte schema version + 4-byte u32be length prefix per field.
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
  scope: DraftScope,
  key: DraftKey,
  payload: DraftPayload,
): Promise<{ iv: Bytes; ciphertext: ArrayBuffer }> {
  const subtle = requireSubtleCrypto();
  const aesKey = await deriveAesKey();
  const iv = freshRandomBytes(AES_IV_BYTES);
  const plaintextSource = new TextEncoder().encode(JSON.stringify(payload));
  // Copy into a fresh ArrayBuffer-backed view so TypeScript's strict
  // BufferSource typing accepts the value at the subtle.encrypt boundary.
  const plaintext: Bytes = new Uint8Array(
    new ArrayBuffer(plaintextSource.byteLength),
  );
  plaintext.set(plaintextSource);
  const additionalData = deriveAad(scope, key);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    aesKey,
    plaintext,
  );
  return { iv, ciphertext };
}

async function decryptPayload(
  scope: DraftScope,
  key: DraftKey,
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer,
): Promise<DraftPayload | null> {
  try {
    const subtle = requireSubtleCrypto();
    const aesKey = await deriveAesKey();
    const additionalData = deriveAad(scope, key);
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
  } catch {
    // AAD mismatch, tampered ciphertext, wrong key (localStorage wiped
    // mid-session), or schema drift. Treat as CorruptDraft: return null so
    // the caller falls back to backend content; the load path purges the
    // row so subsequent reads do not keep failing.
    return null;
  }
}

// ----- Key serialisation --------------------------------------------------

function serializeKey(scope: DraftScope, key: DraftKey): string {
  // Tightly scoped composite to prevent collisions. `` (Unit Separator)
  // is reserved as the field delimiter so program/source names that contain
  // colons or slashes do not corrupt the key.
  const sep = "";
  const head = [
    scope.tenantId,
    scope.userId,
    key.kind,
    key.programId,
    key.sourceName,
  ].join(sep);
  if (key.kind === "java") {
    return `${head}${sep}${key.javaFilePath}`;
  }
  return head;
}

// ----- Public API ---------------------------------------------------------

function makePersistence(
  options: { ttlMs?: number; nowMs?: () => number } = {},
): EditorPersistence {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = options.nowMs ?? (() => Date.now());

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
    let db: IDBPDatabase;
    try {
      db = await getDb();
    } catch (cause) {
      throw new EditorPersistenceError(
        "StorageUnavailable",
        `Failed to open IndexedDB: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const { iv, ciphertext } = await encryptPayload(scope, key, payload);
    const savedAtMs = nowMs();
    const ttlExpiresAtMs = savedAtMs + ttlMs;
    const record: DraftRecord = {
      key: serializeKey(scope, key),
      tenantId: scope.tenantId,
      userId: scope.userId,
      kind: key.kind,
      programId: key.programId,
      sourceName: key.sourceName,
      javaFilePath: key.kind === "java" ? key.javaFilePath : undefined,
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
      if (
        cause instanceof DOMException &&
        cause.name === "QuotaExceededError"
      ) {
        throw new EditorPersistenceError(
          "QuotaExceeded",
          "Storage quota exceeded while saving the draft.",
        );
      }
      throw cause;
    }
    return {
      encryptedSize: ciphertext.byteLength,
      ttlExpiresAt: new Date(ttlExpiresAtMs).toISOString(),
    };
  }

  async function loadDraft(
    scope: DraftScope,
    key: DraftKey,
  ): Promise<LoadedDraft | null> {
    let db: IDBPDatabase;
    try {
      db = await getDb();
    } catch (cause) {
      throw new EditorPersistenceError(
        "StorageUnavailable",
        `Failed to open IndexedDB: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const record = (await db.get(STORE_NAME, serializeKey(scope, key))) as
      | DraftRecord
      | undefined;
    if (!record) {
      return null;
    }
    if (record.recordSchemaVersion !== RECORD_SCHEMA_VERSION) {
      // Old-schema row (e.g., a v0 record from a previous Studio build
      // before AAD was bound). Drop it so the next save can succeed
      // without colliding on the primary key.
      await db.delete(STORE_NAME, record.key);
      return null;
    }
    const payload = await decryptPayload(
      scope,
      key,
      record.iv,
      record.ciphertext,
    );
    if (!payload) {
      // AAD mismatch, tampered ciphertext, or key change. Silently drop
      // so a stale record does not block the next save.
      await db.delete(STORE_NAME, record.key);
      return null;
    }
    return {
      payload,
      isExpired: record.ttlExpiresAtMs <= nowMs(),
      savedAt: new Date(record.savedAtMs).toISOString(),
      ttlExpiresAt: new Date(record.ttlExpiresAtMs).toISOString(),
    };
  }

  async function purgeExpired(): Promise<ClearResult> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const expiryIndex = store.index("by-expiry");
    const cursorRange = IDBKeyRange.upperBound(nowMs());
    let purgedCount = 0;
    let cursor = await expiryIndex.openCursor(cursorRange);
    while (cursor) {
      await cursor.delete();
      purgedCount += 1;
      cursor = await cursor.continue();
    }
    await tx.done;
    return { purgedCount };
  }

  async function clearAll(scope: DraftScope): Promise<ClearResult> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const scopeIndex = store.index("by-scope");
    const range = IDBKeyRange.only([scope.tenantId, scope.userId]);
    let purgedCount = 0;
    let cursor = await scopeIndex.openCursor(range);
    while (cursor) {
      await cursor.delete();
      purgedCount += 1;
      cursor = await cursor.continue();
    }
    await tx.done;
    return { purgedCount };
  }

  async function listDrafts(scope: DraftScope): Promise<DraftMeta[]> {
    const db = await getDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const scopeIndex = store.index("by-scope");
    const range = IDBKeyRange.only([scope.tenantId, scope.userId]);
    const out: DraftMeta[] = [];
    const currentMs = nowMs();
    let cursor = await scopeIndex.openCursor(range);
    while (cursor) {
      const record = cursor.value as DraftRecord;
      out.push({
        kind: record.kind,
        programId: record.programId,
        sourceName: record.sourceName,
        javaFilePath: record.javaFilePath,
        savedAt: new Date(record.savedAtMs).toISOString(),
        ttlExpiresAt: new Date(record.ttlExpiresAtMs).toISOString(),
        isExpired: record.ttlExpiresAtMs <= currentMs,
      });
      cursor = await cursor.continue();
    }
    return out;
  }

  return {
    isAvailable,
    saveDraft,
    loadDraft,
    purgeExpired,
    clearAll,
    listDrafts,
  };
}

// Default singleton with the ADR-defined 14-day TTL.
export const editorPersistence: EditorPersistence = makePersistence();

// Factory for tests / future per-tenant override (ADR-2 §1 configurability).
export function createEditorPersistence(options: {
  ttlMs?: number;
  nowMs?: () => number;
}): EditorPersistence {
  return makePersistence(options);
}

// Test-only reset for vitest. Closes any cached IDB connection (so a
// subsequent `indexedDB.deleteDatabase` does not block on an open
// handle), then drops the cached DB handle, AES key, and storage
// backend so the next call re-derives them with a fresh client secret
// and salt. Not exported through the public API surface beyond tests.
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
  cachedAesKey = null;
  storageBackend = null;
}

// ----- Scope helpers ------------------------------------------------------

// Until a real auth surface lands (see ADR 0005 §3), the Studio runs in a
// single-user/single-tenant local-dev configuration. We expose stable
// defaults here so call-sites do not hard-code the strings; when auth
// integrates, only this function needs to learn how to read the session.
export function getCurrentDraftScope(): DraftScope {
  return { tenantId: "default", userId: "local" };
}
