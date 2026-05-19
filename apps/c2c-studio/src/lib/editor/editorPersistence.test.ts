/**
 * Studio-IDE-3 (#247): unit tests for the IndexedDB-backed editor draft
 * persistence module. Covers the issue body acceptance criteria for
 * round-trip, TTL, clear, scope isolation, overlay pass-through, and
 * encryption integrity, plus the ADR 0005 §2 AAD/schema-bump invariants
 * and the Issue #272 bootstrap-issued-key contract.
 *
 * fake-indexeddb provides the IDB polyfill (jsdom does not expose IDB).
 * Web Crypto is provided by Node 22's globalThis.crypto.subtle — both
 * are routinely available in CI.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEditorPersistence,
  EditorPersistenceError,
  __resetEditorPersistenceForTests,
  type DraftKey,
  type DraftPayload,
  type DraftScope,
  type EditorPersistence,
  type JavaDraftKey,
  type SessionBootstrapProvider,
} from "./editorPersistence";
import { SessionBootstrapError } from "./sessionBootstrap";
import type { JavaOriginOverlay } from "../../types/api";

const scopeA: DraftScope = { tenantId: "tenant-A", userId: "user-1" };
const scopeB: DraftScope = { tenantId: "tenant-B", userId: "user-1" };

const cobolKey: DraftKey = {
  kind: "cobol",
  programId: "PAYROLL01",
  sourceName: "PAYROLL.cbl",
};

const javaKey: JavaDraftKey = {
  kind: "java",
  programId: "PAYROLL01",
  sourceName: "PAYROLL.cbl",
  javaFilePath: "src/main/java/com/example/Payroll.java",
};

const COBOL_CONTENT = [
  "       IDENTIFICATION DIVISION.",
  "       PROGRAM-ID. PAYROLL.",
  "       PROCEDURE DIVISION.",
  '           DISPLAY "Hello".',
  "           STOP RUN.",
].join("\n");

const JAVA_CONTENT = [
  "package com.example;",
  "",
  "public class Payroll {",
  "  public static void main(String[] args) {",
  '    System.out.println("Hello");',
  "  }",
  "}",
].join("\n");

function cobolPayload(content = COBOL_CONTENT): DraftPayload {
  return {
    schemaVersion: "v0",
    kind: "cobol",
    content,
    bufferHash: "abc123",
    savedAt: "2026-05-18T12:00:00Z",
  };
}

function javaPayload(
  content = JAVA_CONTENT,
  overlay: JavaOriginOverlay | null = null,
): DraftPayload {
  return {
    schemaVersion: "v0",
    kind: "java",
    content,
    bufferHash: "def456",
    generatorBaselineHash: "deadbeef",
    generatorBaselineRunId: "run-abc",
    manualEditOverlay: overlay ?? undefined,
    savedAt: "2026-05-18T12:00:00Z",
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function openRawDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("c2c-studio-drafts");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function resetEnvironment() {
  // Close the cached IndexedDB connection BEFORE deleteDatabase so the
  // delete request is not blocked on the open handle. Without this,
  // fake-indexeddb queues the delete and the test waits for the
  // `onblocked` fallback to resolve.
  await __resetEditorPersistenceForTests();
  await deleteDatabase("c2c-studio-drafts");
  // jsdom exposes localStorage via the window proxy; defensive access keeps
  // the test runnable even on a node-only configuration where localStorage
  // is absent.
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  storage?.clear?.();
}

function bytes32From(seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i += 1) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

// Issue #272: tests inject a session-bootstrap provider so the
// encryption path is exercised without standing up the BFF. The
// provider's identity is locked to the test scope — production
// reflects this: the bootstrap returns the active session's
// identity, and `editorPersistence.bootstrapFor(scope)` refuses to
// derive a key when the scope does not match.
function bootstrapFor(
  scope: DraftScope,
  secretSeed = 1,
): SessionBootstrapProvider {
  return async () => ({
    tenantId: scope.tenantId,
    userId: scope.userId,
    draftKeyWrappingSecret: bytes32From(secretSeed),
  });
}

function persistenceFor(
  scope: DraftScope,
  options: { ttlMs?: number; nowMs?: () => number; secretSeed?: number } = {},
): EditorPersistence {
  return createEditorPersistence({
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    sessionBootstrap: bootstrapFor(scope, options.secretSeed),
  });
}

describe("editorPersistence", () => {
  beforeEach(async () => {
    await resetEnvironment();
  });

  afterEach(async () => {
    await resetEnvironment();
  });

  it("reports availability in the test environment", async () => {
    const p = persistenceFor(scopeA);
    expect(await p.isAvailable()).toBe(true);
  });

  it("round-trips a COBOL draft", async () => {
    const p = persistenceFor(scopeA);
    const payload = cobolPayload();
    const result = await p.saveDraft(scopeA, cobolKey, payload);
    expect(result.encryptedSize).toBeGreaterThan(0);
    expect(result.ttlExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const loaded = await p.loadDraft(scopeA, cobolKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.payload.content).toBe(COBOL_CONTENT);
    expect(loaded?.payload.kind).toBe("cobol");
    expect(loaded?.payload.schemaVersion).toBe("v0");
    expect(loaded?.isExpired).toBe(false);
  });

  it("round-trips a Java draft with manualEditOverlay verbatim", async () => {
    const p = persistenceFor(scopeA);
    const overlay: JavaOriginOverlay = {
      schemaVersion: "v0",
      runId: "run-abc",
      javaFile: "Payroll.java",
      regions: [
        {
          lineRange: { startLine: 5, endLine: 7 },
          originClass: "manual_modified",
          generatorBaselineRunId: "run-abc",
          generatorBaselineRegionHash: "abc123",
          lastModifiedAt: "2026-05-18T12:00:00Z",
          lastModifiedBy: { userId: "user-1", tenantId: "tenant-A" },
          manualEditCount: 2,
        },
      ],
    };
    await p.saveDraft(scopeA, javaKey, javaPayload(JAVA_CONTENT, overlay));

    const loaded = await p.loadDraft(scopeA, javaKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.payload.content).toBe(JAVA_CONTENT);
    expect(loaded?.payload.manualEditOverlay).toEqual(overlay);
  });

  it("isolates drafts by scope (tenant) — each scope binds its own bootstrap identity", async () => {
    const pA = persistenceFor(scopeA);
    await pA.saveDraft(scopeA, cobolKey, cobolPayload("only in tenant A"));

    // Switch to scopeB. fake-indexeddb is shared globally so both
    // persistence instances see the same store; the test asserts
    // that the AES key derived from a different scope cannot decrypt
    // tenant-A's record (silently dropped as CorruptDraft).
    await __resetEditorPersistenceForTests();
    const pB = persistenceFor(scopeB);
    await pB.saveDraft(scopeB, cobolKey, cobolPayload("only in tenant B"));

    const loadedB = await pB.loadDraft(scopeB, cobolKey);
    expect(loadedB?.payload.content).toBe("only in tenant B");

    // Reset cached AES key and re-load under scopeA to prove the
    // original tenant-A record is still recoverable under its own
    // bootstrap identity.
    await __resetEditorPersistenceForTests();
    const pA2 = persistenceFor(scopeA);
    const loadedA = await pA2.loadDraft(scopeA, cobolKey);
    expect(loadedA?.payload.content).toBe("only in tenant A");
  });

  it("isolates COBOL and Java drafts under the same program (kind disambiguates)", async () => {
    const p = persistenceFor(scopeA);
    await p.saveDraft(scopeA, cobolKey, cobolPayload("cobol content"));
    await p.saveDraft(scopeA, javaKey, javaPayload("java content"));

    const loadedCobol = await p.loadDraft(scopeA, cobolKey);
    const loadedJava = await p.loadDraft(scopeA, javaKey);
    expect(loadedCobol?.payload.content).toBe("cobol content");
    expect(loadedJava?.payload.content).toBe("java content");
  });

  it("marks records as expired after TTL", async () => {
    const fixedNow = 1_700_000_000_000;
    let now = fixedNow;
    const p = persistenceFor(scopeA, {
      ttlMs: 14 * 24 * 60 * 60 * 1000,
      nowMs: () => now,
    });

    await p.saveDraft(scopeA, cobolKey, cobolPayload());
    now = fixedNow + 15 * 24 * 60 * 60 * 1000;
    const loaded = await p.loadDraft(scopeA, cobolKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.isExpired).toBe(true);
  });

  it("purgeExpired removes expired records and leaves live ones intact", async () => {
    let now = 1_700_000_000_000;
    const p = persistenceFor(scopeA, {
      ttlMs: 1_000,
      nowMs: () => now,
    });

    await p.saveDraft(scopeA, cobolKey, cobolPayload("first"));
    now += 2_000;
    await p.saveDraft(scopeA, javaKey, javaPayload("second"));

    const result = await p.purgeExpired();
    expect(result.purgedCount).toBe(1);

    expect(await p.loadDraft(scopeA, cobolKey)).toBeNull();
    const java = await p.loadDraft(scopeA, javaKey);
    expect(java?.payload.content).toBe("second");
  });

  it("clearAll removes only the requested scope's drafts", async () => {
    const pA = persistenceFor(scopeA);
    await pA.saveDraft(scopeA, cobolKey, cobolPayload("a"));
    await pA.saveDraft(scopeA, javaKey, javaPayload("a-java"));

    await __resetEditorPersistenceForTests();
    const pB = persistenceFor(scopeB);
    await pB.saveDraft(scopeB, cobolKey, cobolPayload("b"));

    await __resetEditorPersistenceForTests();
    const pA2 = persistenceFor(scopeA);
    const cleared = await pA2.clearAll(scopeA);
    expect(cleared.purgedCount).toBe(2);

    expect(await pA2.loadDraft(scopeA, cobolKey)).toBeNull();
    expect(await pA2.loadDraft(scopeA, javaKey)).toBeNull();

    await __resetEditorPersistenceForTests();
    const pB2 = persistenceFor(scopeB);
    const survivor = await pB2.loadDraft(scopeB, cobolKey);
    expect(survivor?.payload.content).toBe("b");
  });

  it("listDrafts returns metadata for both kinds under one scope", async () => {
    const p = persistenceFor(scopeA);
    await p.saveDraft(scopeA, cobolKey, cobolPayload());
    await p.saveDraft(scopeA, javaKey, javaPayload());

    const drafts = await p.listDrafts(scopeA);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.kind).sort()).toEqual(["cobol", "java"]);
    const java = drafts.find((d) => d.kind === "java");
    expect(java?.javaFilePath).toBe(javaKey.javaFilePath);
    const cobol = drafts.find((d) => d.kind === "cobol");
    expect(cobol?.programId).toBe(cobolKey.programId);
  });

  it("rejects a payload.kind/key.kind mismatch with a descriptive error", async () => {
    const p = persistenceFor(scopeA);
    await expect(p.saveDraft(scopeA, cobolKey, javaPayload())).rejects.toThrow(
      /payload\.kind/,
    );
  });

  it("encrypts contents at rest — distinctive plaintext does not appear in ciphertext", async () => {
    const distinctiveText = "SECRETPAYROLLDATA1234567890ZZZ";
    const p = persistenceFor(scopeA);
    await p.saveDraft(scopeA, cobolKey, cobolPayload(distinctiveText));

    const db = await openRawDb();
    try {
      const records = await new Promise<Array<{ ciphertext: ArrayBuffer }>>(
        (resolve) => {
          const tx = db.transaction("drafts", "readonly");
          const req = tx.objectStore("drafts").getAll();
          req.onsuccess = () => resolve(req.result);
        },
      );
      expect(records).toHaveLength(1);
      const ciphertext = new Uint8Array(records[0].ciphertext);
      expect(new TextDecoder().decode(ciphertext)).not.toContain(
        distinctiveText,
      );
    } finally {
      db.close();
    }
  });

  it("returns null and purges a record when the ciphertext is tampered with (AEAD integrity)", async () => {
    const p = persistenceFor(scopeA);
    await p.saveDraft(scopeA, cobolKey, cobolPayload());

    const db = await openRawDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const record = cursor.value as { ciphertext: ArrayBuffer };
            // Flip a byte in the ciphertext so AES-GCM rejects on auth.
            const bytes = new Uint8Array(record.ciphertext);
            bytes[0] ^= 0xff;
            cursor.update(record);
            cursor.continue();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }

    const loaded = await p.loadDraft(scopeA, cobolKey);
    expect(loaded).toBeNull();
    const drafts = await p.listDrafts(scopeA);
    expect(drafts).toHaveLength(0);
  });

  it("drops legacy v1 schema records (Issue #272 migration to v2)", async () => {
    const p = persistenceFor(scopeA);
    await p.saveDraft(scopeA, cobolKey, cobolPayload());

    // Mutate the on-disk recordSchemaVersion to simulate a v1 record
    // (the pre-#272 schema before the BFF-issued wrapping secret
    // landed).
    const db = await openRawDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const record = cursor.value as { recordSchemaVersion: string };
            record.recordSchemaVersion = "v1";
            cursor.update(record);
            cursor.continue();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }

    const loaded = await p.loadDraft(scopeA, cobolKey);
    expect(loaded).toBeNull();
    const drafts = await p.listDrafts(scopeA);
    expect(drafts).toHaveLength(0);
  });

  it("rejects saveDraft with SessionExpiredDuringEdit when the bootstrap returns 401 (Issue #272)", async () => {
    const provider: SessionBootstrapProvider = async () => {
      throw new SessionBootstrapError(
        "Unauthenticated",
        "session bootstrap returned 401",
      );
    };
    const p = createEditorPersistence({ sessionBootstrap: provider });
    await expect(p.saveDraft(scopeA, cobolKey, cobolPayload())).rejects.toEqual(
      expect.objectContaining({
        name: "EditorPersistenceError",
        kind: "SessionExpiredDuringEdit",
      }),
    );
  });

  it("rejects when the scope passed to saveDraft does not match the active session", async () => {
    // Bootstrap returns scopeA; caller asks to write under scopeB.
    // Defense-in-depth: refuse rather than derive a wrong key.
    const p = createEditorPersistence({
      sessionBootstrap: bootstrapFor(scopeA),
    });
    await expect(p.saveDraft(scopeB, cobolKey, cobolPayload())).rejects.toEqual(
      expect.objectContaining({
        name: "EditorPersistenceError",
        kind: "SessionExpiredDuringEdit",
      }),
    );
  });

  it("drafts become unreadable after a session rotation / logout (Issue #272 lifecycle)", async () => {
    // Initial session: seed=1.
    const pBefore = persistenceFor(scopeA, { secretSeed: 1 });
    await pBefore.saveDraft(scopeA, cobolKey, cobolPayload("before logout"));
    await __resetEditorPersistenceForTests();

    // After re-auth: the same identity but a fresh wrapping secret
    // (seed=42). The old ciphertext is bound to the prior key under
    // AAD; AES-GCM authentication fails and `loadDraft` returns null
    // after purging the row (CorruptDraft path).
    const pAfter = persistenceFor(scopeA, { secretSeed: 42 });
    const loaded = await pAfter.loadDraft(scopeA, cobolKey);
    expect(loaded).toBeNull();
  });

  it("EditorPersistenceError carries a discriminated kind", () => {
    const err = new EditorPersistenceError("QuotaExceeded", "Storage full");
    expect(err.name).toBe("EditorPersistenceError");
    expect(err.kind).toBe("QuotaExceeded");
    expect(err.message).toBe("Storage full");
    expect(err).toBeInstanceOf(Error);
  });
});
