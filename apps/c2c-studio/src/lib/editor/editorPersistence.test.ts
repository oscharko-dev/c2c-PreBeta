/**
 * Studio-IDE-3 (#247): unit tests for the IndexedDB-backed editor draft
 * persistence module. Covers the issue body acceptance criteria for
 * round-trip, TTL, clear, scope isolation, overlay pass-through, and
 * encryption integrity, plus the ADR 0005 §2 AAD/schema-bump invariants.
 *
 * fake-indexeddb provides the IDB polyfill (jsdom does not expose IDB).
 * Web Crypto is provided by Node 22's globalThis.crypto.subtle — both
 * are routinely available in CI.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEditorPersistence,
  editorPersistence,
  EditorPersistenceError,
  __resetEditorPersistenceForTests,
  type DraftKey,
  type DraftPayload,
  type DraftScope,
  type JavaDraftKey,
} from "./editorPersistence";
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
  // is absent (the editorPersistence module's in-memory fallback covers
  // that path).
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  storage?.clear?.();
}

describe("editorPersistence", () => {
  beforeEach(async () => {
    await resetEnvironment();
  });

  afterEach(async () => {
    await resetEnvironment();
  });

  it("reports availability in the test environment", async () => {
    expect(await editorPersistence.isAvailable()).toBe(true);
  });

  it("round-trips a COBOL draft", async () => {
    const payload = cobolPayload();
    const result = await editorPersistence.saveDraft(scopeA, cobolKey, payload);
    expect(result.encryptedSize).toBeGreaterThan(0);
    expect(result.ttlExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const loaded = await editorPersistence.loadDraft(scopeA, cobolKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.payload.content).toBe(COBOL_CONTENT);
    expect(loaded?.payload.kind).toBe("cobol");
    expect(loaded?.payload.schemaVersion).toBe("v0");
    expect(loaded?.isExpired).toBe(false);
  });

  it("round-trips a Java draft with manualEditOverlay verbatim", async () => {
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
    await editorPersistence.saveDraft(
      scopeA,
      javaKey,
      javaPayload(JAVA_CONTENT, overlay),
    );

    const loaded = await editorPersistence.loadDraft(scopeA, javaKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.payload.content).toBe(JAVA_CONTENT);
    expect(loaded?.payload.manualEditOverlay).toEqual(overlay);
  });

  it("isolates drafts by scope (tenant)", async () => {
    await editorPersistence.saveDraft(
      scopeA,
      cobolKey,
      cobolPayload("only in tenant A"),
    );
    await editorPersistence.saveDraft(
      scopeB,
      cobolKey,
      cobolPayload("only in tenant B"),
    );

    const loadedA = await editorPersistence.loadDraft(scopeA, cobolKey);
    const loadedB = await editorPersistence.loadDraft(scopeB, cobolKey);
    expect(loadedA?.payload.content).toBe("only in tenant A");
    expect(loadedB?.payload.content).toBe("only in tenant B");
  });

  it("isolates COBOL and Java drafts under the same program (kind disambiguates)", async () => {
    await editorPersistence.saveDraft(
      scopeA,
      cobolKey,
      cobolPayload("cobol content"),
    );
    await editorPersistence.saveDraft(
      scopeA,
      javaKey,
      javaPayload("java content"),
    );

    const loadedCobol = await editorPersistence.loadDraft(scopeA, cobolKey);
    const loadedJava = await editorPersistence.loadDraft(scopeA, javaKey);
    expect(loadedCobol?.payload.content).toBe("cobol content");
    expect(loadedJava?.payload.content).toBe("java content");
  });

  it("marks records as expired after TTL", async () => {
    const fixedNow = 1_700_000_000_000;
    let now = fixedNow;
    const moduleUnderTest = createEditorPersistence({
      ttlMs: 14 * 24 * 60 * 60 * 1000,
      nowMs: () => now,
    });

    await moduleUnderTest.saveDraft(scopeA, cobolKey, cobolPayload());
    // Jump past the TTL.
    now = fixedNow + 15 * 24 * 60 * 60 * 1000;
    const loaded = await moduleUnderTest.loadDraft(scopeA, cobolKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.isExpired).toBe(true);
  });

  it("purgeExpired removes expired records and leaves live ones intact", async () => {
    let now = 1_700_000_000_000;
    const moduleUnderTest = createEditorPersistence({
      ttlMs: 1_000,
      nowMs: () => now,
    });

    await moduleUnderTest.saveDraft(scopeA, cobolKey, cobolPayload("first"));
    // First save expires.
    now += 2_000;
    await moduleUnderTest.saveDraft(scopeA, javaKey, javaPayload("second"));

    const result = await moduleUnderTest.purgeExpired();
    expect(result.purgedCount).toBe(1);

    expect(await moduleUnderTest.loadDraft(scopeA, cobolKey)).toBeNull();
    const java = await moduleUnderTest.loadDraft(scopeA, javaKey);
    expect(java?.payload.content).toBe("second");
  });

  it("clearAll removes only the requested scope's drafts", async () => {
    await editorPersistence.saveDraft(scopeA, cobolKey, cobolPayload("a"));
    await editorPersistence.saveDraft(scopeA, javaKey, javaPayload("a-java"));
    await editorPersistence.saveDraft(scopeB, cobolKey, cobolPayload("b"));

    const cleared = await editorPersistence.clearAll(scopeA);
    expect(cleared.purgedCount).toBe(2);

    expect(await editorPersistence.loadDraft(scopeA, cobolKey)).toBeNull();
    expect(await editorPersistence.loadDraft(scopeA, javaKey)).toBeNull();
    const survivor = await editorPersistence.loadDraft(scopeB, cobolKey);
    expect(survivor?.payload.content).toBe("b");
  });

  it("listDrafts returns metadata for both kinds under one scope", async () => {
    await editorPersistence.saveDraft(scopeA, cobolKey, cobolPayload());
    await editorPersistence.saveDraft(scopeA, javaKey, javaPayload());

    const drafts = await editorPersistence.listDrafts(scopeA);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.kind).sort()).toEqual(["cobol", "java"]);
    const java = drafts.find((d) => d.kind === "java");
    expect(java?.javaFilePath).toBe(javaKey.javaFilePath);
    const cobol = drafts.find((d) => d.kind === "cobol");
    expect(cobol?.programId).toBe(cobolKey.programId);
  });

  it("rejects a payload.kind/key.kind mismatch with a descriptive error", async () => {
    await expect(
      editorPersistence.saveDraft(scopeA, cobolKey, javaPayload()),
    ).rejects.toThrow(/payload\.kind/);
  });

  it("encrypts contents at rest — distinctive plaintext does not appear in ciphertext", async () => {
    const distinctiveText = "SECRETPAYROLLDATA1234567890ZZZ";
    await editorPersistence.saveDraft(
      scopeA,
      cobolKey,
      cobolPayload(distinctiveText),
    );

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
    await editorPersistence.saveDraft(scopeA, cobolKey, cobolPayload());

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

    const loaded = await editorPersistence.loadDraft(scopeA, cobolKey);
    expect(loaded).toBeNull();
    // The corrupt record is purged so subsequent loads do not keep failing.
    const drafts = await editorPersistence.listDrafts(scopeA);
    expect(drafts).toHaveLength(0);
  });

  it("drops legacy v0 schema records that lack AAD (ADR 0005 §2 migration)", async () => {
    await editorPersistence.saveDraft(scopeA, cobolKey, cobolPayload());

    // Mutate the on-disk recordSchemaVersion to simulate a v0 record.
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
            record.recordSchemaVersion = "v0";
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

    const loaded = await editorPersistence.loadDraft(scopeA, cobolKey);
    expect(loaded).toBeNull();
    const drafts = await editorPersistence.listDrafts(scopeA);
    expect(drafts).toHaveLength(0);
  });

  it("EditorPersistenceError carries a discriminated kind", () => {
    const err = new EditorPersistenceError("QuotaExceeded", "Storage full");
    expect(err.name).toBe("EditorPersistenceError");
    expect(err.kind).toBe("QuotaExceeded");
    expect(err.message).toBe("Storage full");
    expect(err).toBeInstanceOf(Error);
  });
});
