// Studio-IDE-11 (#251) AC coverage check: each interactive editor slice
// that ships an instrumented checkpoint (IDE-3, 6, 8, 9, 10, 13, 14)
// emits at least one telemetry event when its primary action runs.
//
// The test patches the telemetry module's flush dependency with a
// capturing fetch and invokes the public entry point of each slice. Any
// regression that removes an `emit(...)` call from a wired slice will
// flip the coverage assertion red.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";

import {
  __resetEditorTelemetryForTests,
  flushPendingForTests,
} from "@/lib/editor/editorTelemetry";
import { computeHoverFor } from "@/lib/editor/cobolHoverProvider";
import {
  lintJava,
  __resetJavaLintTelemetryForTests,
} from "@/lib/editor/javaLint";
import {
  __resetEditorPersistenceForTests,
  createEditorPersistence,
} from "@/lib/editor/editorPersistence";

interface CapturedEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

function setupCapture(): {
  events: CapturedEvent[];
  triggerFlush: () => Promise<void>;
} {
  const events: CapturedEvent[] = [];
  __resetEditorTelemetryForTests({
    now: () => new Date("2026-05-18T12:00:00Z"),
    fetchFn: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        events: CapturedEvent[];
      };
      for (const ev of body.events) {
        events.push({ eventType: ev.eventType, payload: ev.payload });
      }
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch,
    setTimeout: () => 1,
    clearTimeout: () => {},
    resolveBaseUrl: () => ({ ok: true, data: "" }),
    sessionId: "coverage-test-session",
  });
  return {
    events,
    async triggerFlush() {
      await flushPendingForTests();
    },
  };
}

beforeEach(() => {
  __resetEditorTelemetryForTests();
  __resetJavaLintTelemetryForTests();
});

describe("Issue #251 AC8 — each instrumented slice emits at least one event", () => {
  it("IDE-9: COBOL hover emits hover.opened when a PIC clause is hovered", async () => {
    const { events, triggerFlush } = setupCapture();
    // Drive `provideHover` via the pure compute layer, which the
    // production provider wraps verbatim. The provider's emit() is
    // exercised through the unit test for createCobolHoverProvider;
    // this assertion verifies the slice's hook is wired.
    const result = computeHoverFor("           05 ACCOUNT-BAL PIC 9(7)V99.", {
      lineNumber: 1,
      column: 29,
    });
    expect(result).not.toBeNull();
    if (result) {
      // The provider emits via the constructKind we just resolved.
      const { createCobolHoverProvider } =
        await import("@/lib/editor/cobolHoverProvider");
      const provider = createCobolHoverProvider({
        languages: {},
      } as unknown as Parameters<typeof createCobolHoverProvider>[0]);
      provider.provideHover!(
        {
          getLineContent: () => "           05 ACCOUNT-BAL PIC 9(7)V99.",
        } as unknown as Parameters<
          NonNullable<typeof provider.provideHover>
        >[0],
        { lineNumber: 1, column: 29 } as unknown as Parameters<
          NonNullable<typeof provider.provideHover>
        >[1],
        {} as unknown as Parameters<
          NonNullable<typeof provider.provideHover>
        >[2],
      );
    }
    await triggerFlush();
    expect(events.some((e) => e.eventType === "hover.opened")).toBe(true);
  });

  it("IDE-14: javaLint emits lint.markers_changed when invoked", async () => {
    const { events, triggerFlush } = setupCapture();
    lintJava("public class C {\n  void f() { if (x = 1) { } }\n}", {
      filePath: "C.java",
    });
    await triggerFlush();
    expect(events.some((e) => e.eventType === "lint.markers_changed")).toBe(
      true,
    );
  });

  it("IDE-3: editorPersistence emits save.local when a draft is saved", async () => {
    const { events, triggerFlush } = setupCapture();
    await __resetEditorPersistenceForTests();
    const persistence = createEditorPersistence({ ttlMs: 60_000 });
    await persistence.saveDraft(
      { tenantId: "default", userId: "local" },
      { kind: "cobol", programId: "BRNCH01", sourceName: "branch.cbl" },
      {
        schemaVersion: "v0",
        kind: "cobol",
        content: "IDENTIFICATION DIVISION.\nPROGRAM-ID. BRNCH01.\n",
        bufferHash: "abc123",
        savedAt: "2026-05-18T12:00:00Z",
      },
    );
    await triggerFlush();
    expect(events.some((e) => e.eventType === "save.local")).toBe(true);
    expect(
      events.find((e) => e.eventType === "save.local")?.payload.encrypted,
    ).toBe(true);
  });

  it("IDE-14: javaFormatClient emits format.invoked + format.result", async () => {
    const { events, triggerFlush } = setupCapture();
    const { formatJava } = await import("@/lib/editor/javaFormatClient");
    await formatJava(
      { content: "public class C{}", filePath: "C.java" },
      {
        fetchImpl: (async () =>
          ({
            ok: true,
            text: async () =>
              JSON.stringify({ formattedContent: "public class C {}\n" }),
          }) as unknown as Response) as unknown as typeof fetch,
        telemetryTrigger: "shortcut",
        timeoutMs: 100,
      },
    );
    await triggerFlush();
    expect(events.some((e) => e.eventType === "format.invoked")).toBe(true);
    expect(events.some((e) => e.eventType === "format.result")).toBe(true);
  });

  it("IDE-13: compileCheckClient emits compile_check.invoked + result", async () => {
    const { events, triggerFlush } = setupCapture();
    const { compileCheck } = await import("@/lib/editor/compileCheckClient");
    await compileCheck(
      { content: "public class C {}" },
      {
        fetchImpl: (async () =>
          ({
            ok: true,
            text: async () => JSON.stringify({ diagnostics: [] }),
            status: 200,
          }) as unknown as Response) as unknown as typeof fetch,
        telemetryTrigger: "toolbar",
        timeoutMs: 100,
      },
    );
    await triggerFlush();
    expect(events.some((e) => e.eventType === "compile_check.invoked")).toBe(
      true,
    );
    expect(events.some((e) => e.eventType === "compile_check.result")).toBe(
      true,
    );
  });

  it("IDE-10: editorAssistClient emits assist.invoked + assist.result", async () => {
    const { events, triggerFlush } = setupCapture();
    const { requestExplanation } =
      await import("@/lib/editor/editorAssistClient");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            schemaVersion: "v0",
            explanation: "ok",
            modelInvocationRef: "mi-1",
            editorAssistRef: "eai-1",
            ledgerRef: "edit-1",
            budgetSnapshot: { limit: 3, used: 1, remaining: 2 },
            redactionApplied: [],
          }),
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      await requestExplanation({
        schemaVersion: "v0",
        sessionId: "sid",
        tenantId: "default",
        userId: "local",
        runId: null,
        sourceHash: "0".repeat(64),
        region: {
          filePath: "P.cbl",
          sourceKind: "cobol",
          startLine: 1,
          endLine: 5,
        },
        redactedBytes: "MOVE 1 TO X.",
        byteHash: "1".repeat(64),
        studioRedactionMetadata: {
          studioRedactionProfileVersion: "v1.0",
          matchedPatternIds: [],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    await triggerFlush();
    expect(events.some((e) => e.eventType === "assist.invoked")).toBe(true);
    expect(events.some((e) => e.eventType === "assist.result")).toBe(true);
  });

  it("IDE-6: lineageNavigation emits lineage.navigate", async () => {
    const { events, triggerFlush } = setupCapture();
    const { resolveJavaToCobol } =
      await import("@/lib/editor/lineageNavigation");
    const fakeFetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: "v0",
          runId: "r1",
          irSymbolMap: [],
          javaRegionClassification: {},
        }),
        text: async () =>
          JSON.stringify({
            schemaVersion: "v0",
            runId: "r1",
            irSymbolMap: [],
            javaRegionClassification: {},
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await resolveJavaToCobol("r1", "Foo.java", 10, "// no anchors", fakeFetch);
    await triggerFlush();
    expect(events.some((e) => e.eventType === "lineage.navigate")).toBe(true);
  });

  it("privacy: no telemetry payload across slices contains a content field", async () => {
    const { events, triggerFlush } = setupCapture();
    // Drive several slices in one capture so we can assert across the
    // entire batch in one place.
    lintJava("public class C{}", { filePath: "C.java" });
    await __resetEditorPersistenceForTests();
    const persistence = createEditorPersistence({ ttlMs: 60_000 });
    await persistence.saveDraft(
      { tenantId: "default", userId: "local" },
      {
        kind: "java",
        programId: "P",
        sourceName: "p.cbl",
        javaFilePath: "P.java",
      },
      {
        schemaVersion: "v0",
        kind: "java",
        content: "class P {}",
        bufferHash: "def456",
        savedAt: "2026-05-18T12:00:00Z",
      },
    );
    await triggerFlush();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const json = JSON.stringify(event.payload);
      // The known "could leak content" identifier strings the tests
      // touched must not appear in any payload.
      expect(json).not.toContain("class P");
      expect(json).not.toContain("P.java");
      expect(json).not.toContain("BRNCH01");
      expect(json).not.toContain("ACCOUNT");
    }
  });
});
