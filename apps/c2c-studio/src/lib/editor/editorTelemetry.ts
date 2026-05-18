// Studio-IDE-11 (#251): editor telemetry hook — closed-set, tag-only
// learning signal pipeline from the Studio editor to the
// experience-learning-service via the BFF intake at
// `/api/v0/editor/telemetry`.
//
// Design notes:
//
//   * **Tag-only**: every event payload is constrained by the closed
//     enum types in `@/types/editor-telemetry`. The TypeScript compiler
//     enforces the contract; the JSON schema
//     (`schemas/editor-telemetry-event-v0.json`) re-enforces it at the
//     BFF boundary. There is no path by which a free-form string field
//     (source content, field name, file path, identifier) reaches the
//     wire.
//
//   * **Batched flush**: emits are queued in-memory; the flusher drains
//     when either window — 20 events or 5 seconds — closes. The queue
//     is a transient list; nothing is persisted, so a tab close drops
//     un-flushed events cleanly.
//
//   * **Offline / failure**: a failed flush retries at most once. If
//     the retry fails too, the batch is dropped on the floor and the UI
//     is not affected. The acceptance criterion explicitly demands no
//     UI degradation when the experience-learning-service is offline.
//
//   * **Session correlation**: the session id is derived from the same
//     per-tab session token Editor-Assist uses
//     (`getOrCreateEditorAssistSessionId`). One id per Studio tab keeps
//     learning-signal correlation aligned with the BFF auth scope (AC6).
//
//   * **SSR / test safety**: the module never touches `window`,
//     `fetch`, or timers at import time. The first `emit()` lazily
//     initialises the queue; the flusher runs only in the browser. The
//     module also exposes `__resetEditorTelemetryForTests` so vitest can
//     drop accumulated state between cases.

import { resolveApiBaseUrl } from "@/lib/apiBaseUrl";
import { getOrCreateEditorAssistSessionId } from "@/lib/editor/editorAssistSession";
import {
  EDITOR_TELEMETRY_SCHEMA_VERSION,
  type EditorTelemetryEventEnvelope,
  type EditorTelemetryEventInput,
} from "@/types/editor-telemetry";

// 5-second flush window per Issue #251 ("Batching window: 5 seconds OR
// 20 events, whichever first"). Exported so tests can drive the timer.
export const EDITOR_TELEMETRY_FLUSH_INTERVAL_MS = 5_000;

// Hard cap on a single batch — drains immediately when reached.
export const EDITOR_TELEMETRY_MAX_BATCH_SIZE = 20;

// In-process safety net so a buggy emit-loop cannot grow the queue
// without bound. When the queue exceeds this hard cap the oldest entry
// is dropped silently. 200 events ≈ 10 ordinary batches; well above
// anything a real editor session would produce inside one flush window.
export const EDITOR_TELEMETRY_MAX_QUEUE_SIZE = 200;

// One retry on failure ("dropped silently after at most one retry
// attempt; no UI degradation"). The constant lets tests assert the
// behaviour without simulating long retry chains.
export const EDITOR_TELEMETRY_MAX_RETRY_ATTEMPTS = 1;

interface TelemetryDeps {
  // Wall-clock generator. Injected so vitest can pin `occurredAt`
  // without mocking `Date`.
  now: () => Date;
  // `fetch` indirection so tests can intercept without globalThis
  // gymnastics. Defaults to the browser/Node `fetch`.
  fetchFn: typeof fetch;
  // Timer helpers. Tests pass vitest fake timers; production uses the
  // real `setTimeout`/`clearTimeout`.
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  // Resolves the BFF base URL. Indirection mirrors apiClient.ts so the
  // same resolver / failure modes apply.
  resolveBaseUrl: typeof resolveApiBaseUrl;
}

const defaultDeps: TelemetryDeps = {
  now: () => new Date(),
  fetchFn:
    typeof fetch === "function"
      ? fetch.bind(globalThis)
      : ((() => {
          throw new Error("fetch is unavailable in this environment");
        }) as typeof fetch),
  setTimeout: (handler, ms) =>
    typeof setTimeout === "function" ? setTimeout(handler, ms) : 0,
  clearTimeout: (handle) => {
    if (typeof clearTimeout === "function" && handle !== null) {
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }
  },
  resolveBaseUrl: resolveApiBaseUrl,
};

let activeDeps: TelemetryDeps = defaultDeps;
let queue: EditorTelemetryEventEnvelope[] = [];
let flushTimer: unknown = null;
let flushInFlight: Promise<void> | null = null;
let sessionIdOverride: string | null = null;

// Compute the wire envelope for an input event. Adding the
// schemaVersion + occurredAt + sessionId here keeps the caller surface
// minimal and the wire shape uniform.
function toEnvelope(
  input: EditorTelemetryEventInput,
  occurredAt: string,
  sessionId: string,
): EditorTelemetryEventEnvelope {
  // The spread is type-safe: `input` is a discriminated union member
  // and the result narrows to `EditorTelemetryEventEnvelope` thanks to
  // the schemaVersion + sessionId + occurredAt additions.
  return {
    schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
    occurredAt,
    sessionId,
    ...input,
  };
}

function readSessionId(): string {
  // Tests inject a deterministic id via `__resetEditorTelemetryForTests`
  // so they don't have to seed sessionStorage.
  if (sessionIdOverride !== null) return sessionIdOverride;
  return getOrCreateEditorAssistSessionId();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = activeDeps.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, EDITOR_TELEMETRY_FLUSH_INTERVAL_MS);
}

function cancelFlushTimer(): void {
  if (flushTimer !== null) {
    activeDeps.clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// POST one batch of events to the BFF intake. Returns `true` when the
// server returned a 2xx (or 204 No Content); any other outcome counts
// as a failure so the caller can drive the single retry policy.
async function sendBatch(
  batch: EditorTelemetryEventEnvelope[],
): Promise<boolean> {
  const baseUrlResult = activeDeps.resolveBaseUrl();
  if (!baseUrlResult.ok) {
    return false;
  }
  let response: Response;
  try {
    response = await activeDeps.fetchFn(
      `${baseUrlResult.data}/api/v0/editor/telemetry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
          events: batch,
        }),
        // The browser's navigator.sendBeacon would be tempting here,
        // but it bypasses the same-origin Content-Type negotiation and
        // gives no failure signal — both bad for an intake the BFF
        // strictly validates. A regular fetch is fine; the queue and
        // 5 s window keep the request rate trivial.
        keepalive: true,
      },
    );
  } catch {
    return false;
  }
  return response.ok || response.status === 204;
}

// Drain the queue once. Called by the timer (5 s window) and by emit()
// when the batch cap (20 events) is hit. Concurrent calls collapse onto
// the in-flight promise so the queue never sends a batch twice.
async function flush(): Promise<void> {
  if (flushInFlight !== null) {
    return flushInFlight;
  }
  const promise = (async () => {
    cancelFlushTimer();
    if (queue.length === 0) {
      return;
    }
    const batch = queue;
    queue = [];
    let attempts = 0;
    while (attempts <= EDITOR_TELEMETRY_MAX_RETRY_ATTEMPTS) {
      const ok = await sendBatch(batch);
      if (ok) {
        return;
      }
      attempts += 1;
    }
    // Both attempts failed — drop silently per AC ("dropped silently
    // after at most one retry attempt; no UI degradation").
  })();
  flushInFlight = promise;
  try {
    await promise;
  } finally {
    flushInFlight = null;
  }
}

// Public: enqueue one closed-enum event for the next flush window. The
// signature is the discriminated union — TypeScript rejects any event
// shape that is not a member of `EditorTelemetryEventInput`, which is
// what makes the "no free-form string field" guarantee static.
export function emit(input: EditorTelemetryEventInput): void {
  // Defensive: if a caller passes an off-contract shape (e.g. an `any`
  // cast at a slice integration site), drop it on the floor. The
  // TypeScript types make this unreachable in well-typed code, but the
  // runtime guard prevents an outage if a regression slips through.
  if (
    input === null ||
    typeof input !== "object" ||
    typeof (input as { eventType?: unknown }).eventType !== "string" ||
    typeof (input as { payload?: unknown }).payload !== "object" ||
    (input as { payload: unknown }).payload === null
  ) {
    return;
  }
  const occurredAt = activeDeps.now().toISOString();
  const sessionId = readSessionId();
  const envelope = toEnvelope(input, occurredAt, sessionId);
  queue.push(envelope);
  // Bounded queue: drop the oldest entry if a buggy caller floods it.
  if (queue.length > EDITOR_TELEMETRY_MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - EDITOR_TELEMETRY_MAX_QUEUE_SIZE);
  }
  if (queue.length >= EDITOR_TELEMETRY_MAX_BATCH_SIZE) {
    // Drain immediately when the batch cap is reached.
    void flush();
    return;
  }
  scheduleFlush();
}

// Public: drain any pending events synchronously. Useful for tests that
// want to assert "the emitter sent X events" without waiting for the
// flush timer.
export async function flushPendingForTests(): Promise<void> {
  await flush();
}

// Public: returns the current pending-batch size. Tests use this; the
// production UI does not.
export function pendingEventCountForTests(): number {
  return queue.length;
}

// Test-only escape hatch. Resets state and lets a vitest case substitute
// dependencies. Calling with `{}` restores defaults.
export interface EditorTelemetryTestOverrides {
  now?: () => Date;
  fetchFn?: typeof fetch;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  resolveBaseUrl?: typeof resolveApiBaseUrl;
  sessionId?: string;
}

export function __resetEditorTelemetryForTests(
  overrides: EditorTelemetryTestOverrides = {},
): void {
  cancelFlushTimer();
  queue = [];
  flushInFlight = null;
  sessionIdOverride = overrides.sessionId ?? null;
  activeDeps = {
    now: overrides.now ?? defaultDeps.now,
    fetchFn: overrides.fetchFn ?? defaultDeps.fetchFn,
    setTimeout: overrides.setTimeout ?? defaultDeps.setTimeout,
    clearTimeout: overrides.clearTimeout ?? defaultDeps.clearTimeout,
    resolveBaseUrl: overrides.resolveBaseUrl ?? defaultDeps.resolveBaseUrl,
  };
}

// -----------------------------------------------------------------------
// Bucket helpers — exported so slice integrations can produce
// closed-set bucket labels consistently. Every bucket has a single
// source of truth so no slice can drift from the schema enum.
// -----------------------------------------------------------------------

export function bucketCompileLatency(ms: number): "lt_1s" | "lt_5s" | "ge_5s" {
  if (!Number.isFinite(ms) || ms < 0) return "ge_5s";
  if (ms < 1_000) return "lt_1s";
  if (ms < 5_000) return "lt_5s";
  return "ge_5s";
}

export function bucketGenerateLatency(
  ms: number,
): "lt_2s" | "lt_10s" | "lt_60s" | "ge_60s" {
  if (!Number.isFinite(ms) || ms < 0) return "ge_60s";
  if (ms < 2_000) return "lt_2s";
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_60s";
  return "ge_60s";
}

export function bucketFormatLatency(
  ms: number,
): "lt_500ms" | "lt_1500ms" | "ge_1500ms" {
  if (!Number.isFinite(ms) || ms < 0) return "ge_1500ms";
  if (ms < 500) return "lt_500ms";
  if (ms < 1_500) return "lt_1500ms";
  return "ge_1500ms";
}

export function bucketDiagnosticCount(
  count: number,
): "zero" | "lt_10" | "lt_100" | "ge_100" {
  if (!Number.isFinite(count) || count <= 0) return "zero";
  if (count < 10) return "lt_10";
  if (count < 100) return "lt_100";
  return "ge_100";
}

export function bucketFileLineCount(
  count: number,
): "lt_100" | "lt_1000" | "ge_1000" {
  if (!Number.isFinite(count) || count < 100) return "lt_100";
  if (count < 1_000) return "lt_1000";
  return "ge_1000";
}

export function bucketThreeWayMergeRegionCount(
  count: number,
): "lt_5" | "lt_20" | "ge_20" {
  if (!Number.isFinite(count) || count < 5) return "lt_5";
  if (count < 20) return "lt_20";
  return "ge_20";
}

export function bucketLintMarkerCount(
  count: number,
): "zero" | "lt_10" | "lt_50" | "ge_50" {
  if (!Number.isFinite(count) || count <= 0) return "zero";
  if (count < 10) return "lt_10";
  if (count < 50) return "lt_50";
  return "ge_50";
}
