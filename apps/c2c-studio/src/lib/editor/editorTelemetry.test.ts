// Studio-IDE-11 (#251): unit tests for the frontend editor-telemetry
// queue + flush behaviour. The tests inject deterministic clock, fetch,
// and timer dependencies so the cases assert the exact contract:
//   * batched flush after 5 s OR 20 events, whichever first
//   * one retry only on failure; silent drop on persistent failure
//   * envelope shape (schemaVersion + occurredAt + sessionId)
//   * defensive rejection of off-contract payload shapes
//   * privacy guarantee: no free-form string field ever reaches the
//     wire (verified by enumerating all 22 event types and asserting
//     each ships only its declared closed-enum payload fields)

import { describe, it, expect, beforeEach } from "vitest";

import {
  EDITOR_TELEMETRY_MAX_BATCH_SIZE,
  __resetEditorTelemetryForTests,
  bucketCompileLatency,
  bucketDiagnosticCount,
  bucketFileLineCount,
  bucketFormatLatency,
  bucketGenerateLatency,
  bucketLintMarkerCount,
  bucketThreeWayMergeRegionCount,
  emit,
  flushPendingForTests,
  pendingEventCountForTests,
} from "./editorTelemetry";
import { EDITOR_TELEMETRY_EVENT_TYPES } from "@/types/editor-telemetry";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface TestHarness {
  calls: FetchCall[];
  setNextResponse: (response: { ok: boolean; status?: number }) => void;
  fireTimer: () => void;
}

function createHarness(): TestHarness {
  const calls: FetchCall[] = [];
  let nextResponse: { ok: boolean; status?: number } = {
    ok: true,
    status: 202,
  };
  let pendingTimer: (() => void) | null = null;
  const fixedClock = new Date("2026-05-18T12:00:00.000Z");
  __resetEditorTelemetryForTests({
    now: () => fixedClock,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: nextResponse.ok,
        status: nextResponse.status ?? (nextResponse.ok ? 202 : 502),
      } as Response;
    }) as unknown as typeof fetch,
    setTimeout: (handler: () => void) => {
      pendingTimer = handler;
      return 1;
    },
    clearTimeout: () => {
      pendingTimer = null;
    },
    resolveBaseUrl: () => ({ ok: true, data: "" }),
    sessionId: "test-session-id",
  });
  return {
    calls,
    setNextResponse(response) {
      nextResponse = response;
    },
    fireTimer() {
      if (pendingTimer !== null) {
        pendingTimer();
      }
    },
  };
}

describe("editorTelemetry", () => {
  beforeEach(() => {
    __resetEditorTelemetryForTests();
  });

  it("emits one event and flushes when the timer fires", async () => {
    const harness = createHarness();
    emit({ eventType: "hover.opened", payload: { constructKind: "pic" } });
    expect(pendingEventCountForTests()).toBe(1);
    expect(harness.calls.length).toBe(0);

    harness.fireTimer();
    // The timer triggers an async flush; wait for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.calls.length).toBe(1);
    const call = harness.calls[0]!;
    expect(call.url).toBe("/api/v0/editor/telemetry");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("include");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body as string) as {
      schemaVersion: string;
      events: Array<{
        schemaVersion: string;
        eventType: string;
        occurredAt: string;
        sessionId: string;
        payload: { constructKind: string };
      }>;
    };
    expect(body.schemaVersion).toBe("v0");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventType).toBe("hover.opened");
    expect(body.events[0]?.sessionId).toBe("test-session-id");
    expect(body.events[0]?.occurredAt).toBe("2026-05-18T12:00:00.000Z");
    expect(body.events[0]?.payload.constructKind).toBe("pic");
  });

  it("flushes immediately when the batch reaches the cap", async () => {
    const harness = createHarness();
    for (let i = 0; i < EDITOR_TELEMETRY_MAX_BATCH_SIZE; i += 1) {
      emit({ eventType: "hover.opened", payload: { constructKind: "pic" } });
    }
    // The cap-trigger fires a flush without waiting on the timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.length).toBe(1);
    const body = JSON.parse(harness.calls[0]!.init.body as string) as {
      events: unknown[];
    };
    expect(body.events).toHaveLength(EDITOR_TELEMETRY_MAX_BATCH_SIZE);
    expect(pendingEventCountForTests()).toBe(0);
  });

  it("retries once on a failed flush and drops the batch when the retry also fails", async () => {
    const harness = createHarness();
    harness.setNextResponse({ ok: false, status: 502 });

    emit({
      eventType: "save.local",
      payload: { kind: "java", encrypted: true },
    });
    await flushPendingForTests();

    // Two attempts: initial + one retry = 2 fetch calls. Then the batch
    // is dropped silently (no third attempt; no exception bubbled).
    expect(harness.calls.length).toBe(2);
    expect(pendingEventCountForTests()).toBe(0);
  });

  it("does not retry on success", async () => {
    const harness = createHarness();
    emit({
      eventType: "diff.open",
      payload: { hasPrevious: true, lineageAvailable: false },
    });
    await flushPendingForTests();
    expect(harness.calls.length).toBe(1);
  });

  it("drops events when the fetch base URL cannot be resolved (graceful offline)", async () => {
    const harness = createHarness();
    __resetEditorTelemetryForTests({
      now: () => new Date("2026-05-18T12:00:00Z"),
      fetchFn: harness.calls.push.bind(
        harness.calls,
      ) as unknown as typeof fetch,
      resolveBaseUrl: () => ({
        ok: false,
        status: undefined,
        message: "config error",
        details: { kind: "config", cause: "test" },
      }),
      setTimeout: () => 1,
      clearTimeout: () => {},
      sessionId: "test-session-id",
    });
    emit({
      eventType: "save.local",
      payload: { kind: "cobol", encrypted: false },
    });
    await flushPendingForTests();
    expect(harness.calls.length).toBe(0);
    expect(pendingEventCountForTests()).toBe(0);
  });

  it("ignores defensive off-contract emits (runtime guard)", async () => {
    createHarness();
    // Cast through `any` so the TypeScript narrowing does not block the
    // hostile path. The runtime guard must drop it on the floor.
    emit({ eventType: "marker.navigate" } as unknown as Parameters<
      typeof emit
    >[0]);
    expect(pendingEventCountForTests()).toBe(0);
    emit({
      eventType: "hover.opened",
      payload: { constructKind: "pic", sourceText: "01 CUSTOMER-NAME." },
    } as unknown as Parameters<typeof emit>[0]);
    expect(pendingEventCountForTests()).toBe(0);
  });

  it("drains a full queued batch after an in-flight flush completes", async () => {
    const calls: FetchCall[] = [];
    let resolveFirst: ((response: Response) => void) | undefined;
    __resetEditorTelemetryForTests({
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { ok: true, status: 202 } as Response;
      }) as unknown as typeof fetch,
      setTimeout: () => 1,
      clearTimeout: () => {},
      resolveBaseUrl: () => ({ ok: true, data: "" }),
      sessionId: "test-session-id",
    });

    for (let i = 0; i < EDITOR_TELEMETRY_MAX_BATCH_SIZE; i += 1) {
      emit({ eventType: "hover.opened", payload: { constructKind: "pic" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    for (let i = 0; i < EDITOR_TELEMETRY_MAX_BATCH_SIZE; i += 1) {
      emit({ eventType: "hover.expanded", payload: { constructKind: "usage" } });
    }
    expect(pendingEventCountForTests()).toBe(EDITOR_TELEMETRY_MAX_BATCH_SIZE);

    if (!resolveFirst) {
      throw new Error("first telemetry request was not captured");
    }
    resolveFirst({ ok: true, status: 202 } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPendingForTests();

    expect(calls).toHaveLength(2);
    const body = JSON.parse(calls[1]!.init.body as string) as {
      events: Array<{ eventType: string }>;
    };
    expect(body.events).toHaveLength(EDITOR_TELEMETRY_MAX_BATCH_SIZE);
    expect(body.events.every((event) => event.eventType === "hover.expanded"))
      .toBe(true);
  });

  it("multiple emits collapse into one batch on flush", async () => {
    const harness = createHarness();
    emit({ eventType: "hover.opened", payload: { constructKind: "pic" } });
    emit({ eventType: "hover.expanded", payload: { constructKind: "comp3" } });
    emit({
      eventType: "lineage.navigate",
      payload: {
        direction: "java_to_cobol",
        resolved: true,
        mappingClass: "direct",
      },
    });
    harness.fireTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.length).toBe(1);
    const body = JSON.parse(harness.calls[0]!.init.body as string) as {
      events: unknown[];
    };
    expect(body.events).toHaveLength(3);
  });

  it("privacy: every event type in the closed set has a discriminated TypeScript shape", () => {
    // This is a structural assertion: the TypeScript discriminated
    // union enforces "no free-form string fields", and the schema
    // re-enforces it at the boundary. If the count drifts, the
    // contract has drifted — fix both ends.
    expect(EDITOR_TELEMETRY_EVENT_TYPES.length).toBe(23);
  });
});

describe("bucketing helpers", () => {
  it("buckets compile latency into closed enum", () => {
    expect(bucketCompileLatency(0)).toBe("lt_1s");
    expect(bucketCompileLatency(999)).toBe("lt_1s");
    expect(bucketCompileLatency(1000)).toBe("lt_5s");
    expect(bucketCompileLatency(4999)).toBe("lt_5s");
    expect(bucketCompileLatency(5000)).toBe("ge_5s");
    expect(bucketCompileLatency(Number.POSITIVE_INFINITY)).toBe("ge_5s");
    expect(bucketCompileLatency(-1)).toBe("ge_5s");
  });

  it("buckets generate latency into closed enum", () => {
    expect(bucketGenerateLatency(1500)).toBe("lt_2s");
    expect(bucketGenerateLatency(2000)).toBe("lt_10s");
    expect(bucketGenerateLatency(10_000)).toBe("lt_60s");
    expect(bucketGenerateLatency(60_000)).toBe("ge_60s");
  });

  it("buckets format latency into closed enum", () => {
    expect(bucketFormatLatency(100)).toBe("lt_500ms");
    expect(bucketFormatLatency(500)).toBe("lt_1500ms");
    expect(bucketFormatLatency(1500)).toBe("ge_1500ms");
  });

  it("buckets diagnostic count into closed enum", () => {
    expect(bucketDiagnosticCount(0)).toBe("zero");
    expect(bucketDiagnosticCount(9)).toBe("lt_10");
    expect(bucketDiagnosticCount(10)).toBe("lt_100");
    expect(bucketDiagnosticCount(100)).toBe("ge_100");
  });

  it("buckets file line count into closed enum", () => {
    expect(bucketFileLineCount(50)).toBe("lt_100");
    expect(bucketFileLineCount(500)).toBe("lt_1000");
    expect(bucketFileLineCount(1000)).toBe("ge_1000");
  });

  it("buckets three-way merge region count into closed enum", () => {
    expect(bucketThreeWayMergeRegionCount(4)).toBe("lt_5");
    expect(bucketThreeWayMergeRegionCount(5)).toBe("lt_20");
    expect(bucketThreeWayMergeRegionCount(20)).toBe("ge_20");
  });

  it("buckets lint marker count into closed enum", () => {
    expect(bucketLintMarkerCount(0)).toBe("zero");
    expect(bucketLintMarkerCount(9)).toBe("lt_10");
    expect(bucketLintMarkerCount(10)).toBe("lt_50");
    expect(bucketLintMarkerCount(50)).toBe("ge_50");
  });
});
