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
  EDITOR_TELEMETRY_EVENT_TYPES,
  EDITOR_TELEMETRY_SCHEMA_VERSION,
  type EditorTelemetryEventEnvelope,
  type EditorTelemetryEventInput,
  type EditorTelemetryEventType,
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

type PayloadRule = {
  allowed: readonly string[];
  required: readonly string[];
  stringEnums?: Record<string, readonly string[]>;
  booleans?: readonly string[];
  nonNegativeIntegers?: readonly string[];
  patterns?: Record<string, RegExp>;
  nestedNonNegativeIntegerObjects?: Record<string, readonly string[]>;
};

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  EDITOR_TELEMETRY_EVENT_TYPES,
);
const SOURCE_KINDS = ["cobol", "java"] as const;
const SEVERITIES = ["error", "warning", "info", "hint"] as const;
const MAPPING_CLASSES = [
  "direct",
  "aggregated",
  "synthesized",
  "agent_originated",
] as const;
const HOVER_CONSTRUCT_KINDS = [
  "pic",
  "comp3",
  "usage",
  "occurs",
  "redefines",
  "value",
  "section",
  "paragraph",
  "fixed-format-zone",
] as const;
const NEXT_OR_PREV = ["next", "prev"] as const;
const LINEAGE_DIRECTIONS = ["java_to_cobol", "cobol_to_java"] as const;
const UNRESOLVED_REASONS = [
  "no_mapping",
  "stale_manual_edit",
  "manual_only",
] as const;
const ASSIST_RESULT_OUTCOMES = [
  "success",
  "budget_exhausted",
  "policy_denied",
  "gateway_unavailable",
  "timeout",
  "invalid_region",
] as const;
const DRAFT_COUNT_BUCKETS = ["zero", "lt_10", "lt_100", "ge_100"] as const;
const CONFLICT_PICKS = [
  "backend_sample",
  "local_draft",
  "last_run_input",
] as const;
const GENERATE_TRIGGERS = [
  "generate",
  "regenerate",
  "generate_and_verify",
] as const;
const GENERATE_OUTCOMES = [
  "success",
  "merge_required",
  "failed",
  "cancelled",
] as const;
const GENERATE_LATENCY_BUCKETS = [
  "lt_2s",
  "lt_10s",
  "lt_60s",
  "ge_60s",
] as const;
const TOOLBAR_OR_SHORTCUT = ["toolbar", "shortcut"] as const;
const DIAGNOSTIC_COUNT_BUCKETS = ["zero", "lt_10", "lt_100", "ge_100"] as const;
const COMPILE_LATENCY_BUCKETS = ["lt_1s", "lt_5s", "ge_5s"] as const;
const COMPILE_OUTCOMES = [
  "ok",
  "errors",
  "gateway_unavailable",
  "timeout",
] as const;
const VERIFY_OUTCOMES = [
  "success",
  "compile_failed",
  "run_failed",
  "output_divergence",
  "blocked",
  "cancelled",
  "gateway_unavailable",
] as const;
const THREE_WAY_BUCKETS = ["lt_5", "lt_20", "ge_20"] as const;
const ORIGIN_CLASSES = ["manual_modified", "manual_edit"] as const;
const SHORTCUT_OR_ON_SAVE = ["shortcut", "on_save"] as const;
const FILE_LINE_BUCKETS = ["lt_100", "lt_1000", "ge_1000"] as const;
const FORMAT_OUTCOMES = ["success", "unavailable", "timeout", "noop"] as const;
const FORMAT_LATENCY_BUCKETS = ["lt_500ms", "lt_1500ms", "ge_1500ms"] as const;
const LINT_COUNT_BUCKETS = ["zero", "lt_10", "lt_50", "ge_50"] as const;
const IR_CODE_OR_KIND_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

const PAYLOAD_RULES: Record<EditorTelemetryEventType, PayloadRule> = {
  "marker.navigate": {
    allowed: ["direction", "sourceKind", "severity", "irCodeOrIRNodeKind"],
    required: ["direction", "sourceKind", "severity"],
    stringEnums: {
      direction: NEXT_OR_PREV,
      sourceKind: SOURCE_KINDS,
      severity: SEVERITIES,
    },
    patterns: { irCodeOrIRNodeKind: IR_CODE_OR_KIND_PATTERN },
  },
  "hover.opened": {
    allowed: ["constructKind"],
    required: ["constructKind"],
    stringEnums: { constructKind: HOVER_CONSTRUCT_KINDS },
  },
  "hover.expanded": {
    allowed: ["constructKind"],
    required: ["constructKind"],
    stringEnums: { constructKind: HOVER_CONSTRUCT_KINDS },
  },
  "lineage.navigate": {
    allowed: ["direction", "resolved", "mappingClass", "unresolvedReason"],
    required: ["direction", "resolved"],
    stringEnums: {
      direction: LINEAGE_DIRECTIONS,
      mappingClass: MAPPING_CLASSES,
      unresolvedReason: UNRESOLVED_REASONS,
    },
    booleans: ["resolved"],
  },
  "stacktrace.frame_click": {
    allowed: ["resolved"],
    required: ["resolved"],
    booleans: ["resolved"],
  },
  "diff.open": {
    allowed: ["hasPrevious", "lineageAvailable"],
    required: ["hasPrevious", "lineageAvailable"],
    booleans: ["hasPrevious", "lineageAvailable"],
  },
  "assist.invoked": {
    allowed: ["sourceKind", "regionLineCount", "redactionApplied"],
    required: ["sourceKind", "regionLineCount", "redactionApplied"],
    stringEnums: { sourceKind: SOURCE_KINDS },
    nonNegativeIntegers: ["regionLineCount", "redactionApplied"],
  },
  "assist.result": {
    allowed: ["outcome"],
    required: ["outcome"],
    stringEnums: { outcome: ASSIST_RESULT_OUTCOMES },
  },
  "save.local": {
    allowed: ["kind", "encrypted"],
    required: ["kind", "encrypted"],
    stringEnums: { kind: SOURCE_KINDS },
    booleans: ["encrypted"],
  },
  "drafts.cleared": {
    allowed: ["purgedCountBucket"],
    required: ["purgedCountBucket"],
    stringEnums: { purgedCountBucket: DRAFT_COUNT_BUCKETS },
  },
  "conflict.resolved": {
    allowed: ["kind", "pick"],
    required: ["kind", "pick"],
    stringEnums: { kind: SOURCE_KINDS, pick: CONFLICT_PICKS },
  },
  "generate.invoked": {
    allowed: ["trigger", "hadManualEdits"],
    required: ["trigger", "hadManualEdits"],
    stringEnums: { trigger: GENERATE_TRIGGERS },
    booleans: ["hadManualEdits"],
  },
  "generate.result": {
    allowed: ["outcome", "latencyBucket"],
    required: ["outcome", "latencyBucket"],
    stringEnums: {
      outcome: GENERATE_OUTCOMES,
      latencyBucket: GENERATE_LATENCY_BUCKETS,
    },
  },
  "compile_check.invoked": {
    allowed: ["trigger"],
    required: ["trigger"],
    stringEnums: { trigger: TOOLBAR_OR_SHORTCUT },
  },
  "compile_check.result": {
    allowed: ["outcome", "diagnosticCountBucket", "latencyBucket"],
    required: ["outcome", "diagnosticCountBucket", "latencyBucket"],
    stringEnums: {
      outcome: COMPILE_OUTCOMES,
      diagnosticCountBucket: DIAGNOSTIC_COUNT_BUCKETS,
      latencyBucket: COMPILE_LATENCY_BUCKETS,
    },
  },
  "verify.invoked": {
    allowed: ["trigger", "hadManualEdits"],
    required: ["trigger", "hadManualEdits"],
    stringEnums: { trigger: TOOLBAR_OR_SHORTCUT },
    booleans: ["hadManualEdits"],
  },
  "verify.result": {
    allowed: ["outcome"],
    required: ["outcome"],
    stringEnums: { outcome: VERIFY_OUTCOMES },
  },
  "three_way_merge.opened": {
    allowed: ["regionCountBucket"],
    required: ["regionCountBucket"],
    stringEnums: { regionCountBucket: THREE_WAY_BUCKETS },
  },
  "three_way_merge.resolved": {
    allowed: ["regionsPickedPerSource", "cancelled"],
    required: ["regionsPickedPerSource", "cancelled"],
    booleans: ["cancelled"],
    nestedNonNegativeIntegerObjects: {
      regionsPickedPerSource: ["manual", "new_generator", "baseline"],
    },
  },
  "manual_edit.region_classified": {
    allowed: ["originClass", "mappingClass"],
    required: ["originClass"],
    stringEnums: {
      originClass: ORIGIN_CLASSES,
      mappingClass: MAPPING_CLASSES,
    },
  },
  "format.invoked": {
    allowed: ["trigger", "fileLineCountBucket"],
    required: ["trigger", "fileLineCountBucket"],
    stringEnums: {
      trigger: SHORTCUT_OR_ON_SAVE,
      fileLineCountBucket: FILE_LINE_BUCKETS,
    },
  },
  "format.result": {
    allowed: ["outcome", "latencyBucket"],
    required: ["outcome", "latencyBucket"],
    stringEnums: {
      outcome: FORMAT_OUTCOMES,
      latencyBucket: FORMAT_LATENCY_BUCKETS,
    },
  },
  "lint.markers_changed": {
    allowed: ["countBucket"],
    required: ["countBucket"],
    stringEnums: { countBucket: LINT_COUNT_BUCKETS },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validatePayloadShape(
  payload: unknown,
  rule: PayloadRule,
): payload is Record<string, unknown> {
  if (!isRecord(payload) || !hasOnlyKnownKeys(payload, rule.allowed)) {
    return false;
  }
  for (const key of rule.required) {
    if (payload[key] === undefined) {
      return false;
    }
  }
  for (const [key, allowed] of Object.entries(rule.stringEnums ?? {})) {
    const value = payload[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || !allowed.includes(value))
    ) {
      return false;
    }
  }
  for (const key of rule.booleans ?? []) {
    if (payload[key] !== undefined && typeof payload[key] !== "boolean") {
      return false;
    }
  }
  for (const key of rule.nonNegativeIntegers ?? []) {
    if (payload[key] !== undefined && !isNonNegativeInteger(payload[key])) {
      return false;
    }
  }
  for (const [key, pattern] of Object.entries(rule.patterns ?? {})) {
    const value = payload[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || !pattern.test(value))
    ) {
      return false;
    }
  }
  for (const [key, nestedKeys] of Object.entries(
    rule.nestedNonNegativeIntegerObjects ?? {},
  )) {
    const nested = payload[key];
    if (!isRecord(nested) || !hasOnlyKnownKeys(nested, nestedKeys)) {
      return false;
    }
    for (const nestedKey of nestedKeys) {
      if (!isNonNegativeInteger(nested[nestedKey])) {
        return false;
      }
    }
  }
  return true;
}

function isEditorTelemetryEventInput(
  input: unknown,
): input is EditorTelemetryEventInput {
  if (!isRecord(input) || !hasOnlyKnownKeys(input, ["eventType", "payload"])) {
    return false;
  }
  const eventType = input.eventType;
  if (typeof eventType !== "string" || !EVENT_TYPE_SET.has(eventType)) {
    return false;
  }
  return validatePayloadShape(
    input.payload,
    PAYLOAD_RULES[eventType as EditorTelemetryEventType],
  );
}

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
        credentials: "include",
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
    if (queue.length >= EDITOR_TELEMETRY_MAX_BATCH_SIZE) {
      void flush();
    } else if (queue.length > 0) {
      scheduleFlush();
    }
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
  if (!isEditorTelemetryEventInput(input)) {
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
