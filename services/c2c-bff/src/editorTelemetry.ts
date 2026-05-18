// Studio-IDE-11 (#251): editor telemetry intake module.
//
// Mirror of the closed-enum contract declared in
// `apps/c2c-studio/src/types/editor-telemetry.ts` and
// `schemas/editor-telemetry-event-v0.json`. The BFF re-validates every
// payload at the boundary (defence in depth — content must never appear)
// and forwards accepted batches through the existing
// ``ExperienceLearningClient`` so the experience-learning-service stays
// the single ingest sink for learning signals.
//
// The validator is intentionally function-oriented so the route handler
// stays thin (mirrors `editorExplain.ts`). Tests exercise the per-event
// validation rules directly without spinning up the HTTP layer.
//
// Privacy policy enforced here (AC1, AC5, AC8 in Issue #251):
//   * Every event payload is a closed-enum object. `additionalProperties`
//     is rejected at the boundary.
//   * No free-form string field exists anywhere in the contract. The
//     validator rejects any payload that includes a property not listed
//     for the discriminated `eventType`.
//   * Optional `irCodeOrIRNodeKind` is constrained to an SCREAMING_SNAKE
//     IR-node-kind regex so a hostile client cannot smuggle source
//     content through the only string-valued enum-adjacent field.

// ---------------------------------------------------------------------------
// Schema version + closed enums
// ---------------------------------------------------------------------------

export const EDITOR_TELEMETRY_SCHEMA_VERSION = "v0" as const;
export type EditorTelemetrySchemaVersion =
  typeof EDITOR_TELEMETRY_SCHEMA_VERSION;

// Maximum batch size accepted in a single intake call. Matches the
// frontend ``EDITOR_TELEMETRY_MAX_BATCH_SIZE`` plus a small safety
// margin for batches that include the trailing flush of a long session.
export const EDITOR_TELEMETRY_MAX_BATCH_EVENTS = 100;

// Hard cap on the request body. Each event is ~200-300 bytes of JSON;
// 100 events × 1 KB safety budget per event = 100 KB. The intake
// rejects anything larger long before the BFF parses it.
export const EDITOR_TELEMETRY_MAX_BODY_BYTES = 100_000;

export const EDITOR_TELEMETRY_EVENT_TYPES = [
  "marker.navigate",
  "hover.opened",
  "hover.expanded",
  "lineage.navigate",
  "stacktrace.frame_click",
  "diff.open",
  "assist.invoked",
  "assist.result",
  "save.local",
  "conflict.resolved",
  "generate.invoked",
  "generate.result",
  "compile_check.invoked",
  "compile_check.result",
  "verify.invoked",
  "verify.result",
  "three_way_merge.opened",
  "three_way_merge.resolved",
  "manual_edit.region_classified",
  "format.invoked",
  "format.result",
  "lint.markers_changed",
] as const;

export type EditorTelemetryEventType =
  (typeof EDITOR_TELEMETRY_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<EditorTelemetryEventType> = new Set(
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
  // ``usage`` is the bucket for non-COMP-3 USAGE families (COMP-1,
  // COMP-2, COMP-4, COMP-5, BINARY, POINTER, INDEX, DISPLAY-as-USAGE).
  // Keeping ``comp3`` distinct so the analyzer can still single out
  // packed-decimal data layouts.
  "usage",
  "occurs",
  "redefines",
  "value",
  "section",
  "paragraph",
  "fixed-format-zone",
] as const;
const ASSIST_RESULT_OUTCOMES = [
  "success",
  "budget_exhausted",
  "policy_denied",
  "gateway_unavailable",
  "timeout",
  "invalid_region",
] as const;
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
const COMPILE_OUTCOMES = [
  "ok",
  "errors",
  "gateway_unavailable",
  "timeout",
] as const;
const DIAGNOSTIC_COUNT_BUCKETS = ["zero", "lt_10", "lt_100", "ge_100"] as const;
const COMPILE_LATENCY_BUCKETS = ["lt_1s", "lt_5s", "ge_5s"] as const;
const VERIFY_OUTCOMES = [
  "success",
  "compile_failed",
  "run_failed",
  "output_divergence",
  "blocked",
  "cancelled",
  "gateway_unavailable",
] as const;
const TOOLBAR_OR_SHORTCUT = ["toolbar", "shortcut"] as const;
const SHORTCUT_OR_ON_SAVE = ["shortcut", "on_save"] as const;
const NEXT_OR_PREV = ["next", "prev"] as const;
const LINEAGE_DIRECTIONS = ["java_to_cobol", "cobol_to_java"] as const;
const UNRESOLVED_REASONS = [
  "no_mapping",
  "stale_manual_edit",
  "manual_only",
] as const;
const THREE_WAY_BUCKETS = ["lt_5", "lt_20", "ge_20"] as const;
const ORIGIN_CLASSES = ["manual_modified", "manual_edit"] as const;
const FILE_LINE_BUCKETS = ["lt_100", "lt_1000", "ge_1000"] as const;
const FORMAT_OUTCOMES = ["success", "unavailable", "timeout", "noop"] as const;
const FORMAT_LATENCY_BUCKETS = ["lt_500ms", "lt_1500ms", "ge_1500ms"] as const;
const LINT_COUNT_BUCKETS = ["zero", "lt_10", "lt_50", "ge_50"] as const;

// SCREAMING_SNAKE IR-node-kind / IR-code pattern. Tight by design: the
// optional `irCodeOrIRNodeKind` field is the only string-valued payload
// field that is not a closed enum, so the validator forces it into the
// vocabulary IRs already use (`DATA_DIVISION`, `IR0_002`, etc.). A
// hostile client cannot smuggle source content through this gate.
const IR_CODE_OR_KIND_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// Identifier shape for sessionId / tenantId / userId. Matches the
// allow-list already used by ``editorExplain.ts`` (alphanumeric plus
// `.`, `_`, `-`, 1-128 chars). The BFF augments tenantId/userId from
// its auth context but the validator still enforces the shape so a
// hostile or buggy client cannot ship characters that would corrupt
// the audit log line.
const SAFE_ID_PATTERN = /^[A-Za-z0-9._\-]{1,128}$/u;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Types — wire envelope + per-event payload shapes
// ---------------------------------------------------------------------------

export type EditorTelemetrySourceKind = (typeof SOURCE_KINDS)[number];
export type EditorTelemetrySeverity = (typeof SEVERITIES)[number];
export type EditorTelemetryMappingClass = (typeof MAPPING_CLASSES)[number];

export interface ValidatedEditorTelemetryEvent {
  schemaVersion: EditorTelemetrySchemaVersion;
  eventType: EditorTelemetryEventType;
  occurredAt: string;
  sessionId: string;
  // Tag-only payload; the validator has already proven the shape
  // against the discriminated set, so a payload here is safe to forward
  // verbatim.
  payload: Record<string, unknown>;
}

export interface EditorTelemetryBatch {
  schemaVersion: EditorTelemetrySchemaVersion;
  events: ValidatedEditorTelemetryEvent[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type EditorTelemetryValidationErrorCode =
  | "invalid_envelope"
  | "invalid_event"
  | "batch_too_large";

export interface EditorTelemetryValidationOk {
  ok: true;
  value: EditorTelemetryBatch;
}

export interface EditorTelemetryValidationError {
  ok: false;
  errorCode: EditorTelemetryValidationErrorCode;
  message: string;
}

export type EditorTelemetryValidation =
  | EditorTelemetryValidationOk
  | EditorTelemetryValidationError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function hasOnlyKnownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  for (const key of Object.keys(record)) {
    if (!(allowedKeys as readonly string[]).includes(key)) {
      return false;
    }
  }
  return true;
}

function rejectEvent(message: string): EditorTelemetryValidationError {
  return { ok: false, errorCode: "invalid_event", message };
}

function rejectEnvelope(message: string): EditorTelemetryValidationError {
  return { ok: false, errorCode: "invalid_envelope", message };
}

function validateMarkerNavigatePayload(
  payload: Record<string, unknown>,
): true | string {
  const allowed = ["direction", "sourceKind", "severity", "irCodeOrIRNodeKind"];
  if (!hasOnlyKnownKeys(payload, allowed)) {
    return "marker.navigate payload contains an unknown property";
  }
  if (!isOneOf(payload.direction, NEXT_OR_PREV)) {
    return "marker.navigate.direction must be 'next' or 'prev'";
  }
  if (!isOneOf(payload.sourceKind, SOURCE_KINDS)) {
    return "marker.navigate.sourceKind must be 'cobol' or 'java'";
  }
  if (!isOneOf(payload.severity, SEVERITIES)) {
    return "marker.navigate.severity must be a closed severity enum value";
  }
  if (payload.irCodeOrIRNodeKind !== undefined) {
    if (
      typeof payload.irCodeOrIRNodeKind !== "string" ||
      !IR_CODE_OR_KIND_PATTERN.test(payload.irCodeOrIRNodeKind)
    ) {
      return "marker.navigate.irCodeOrIRNodeKind must be SCREAMING_SNAKE_CASE (1-64 chars)";
    }
  }
  return true;
}

function validateHoverPayload(
  payload: Record<string, unknown>,
  eventType: string,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["constructKind"])) {
    return `${eventType} payload contains an unknown property`;
  }
  if (!isOneOf(payload.constructKind, HOVER_CONSTRUCT_KINDS)) {
    return `${eventType}.constructKind must be a closed hover-construct enum value`;
  }
  return true;
}

function validateLineageNavigatePayload(
  payload: Record<string, unknown>,
): true | string {
  const allowed = ["direction", "resolved", "mappingClass", "unresolvedReason"];
  if (!hasOnlyKnownKeys(payload, allowed)) {
    return "lineage.navigate payload contains an unknown property";
  }
  if (!isOneOf(payload.direction, LINEAGE_DIRECTIONS)) {
    return "lineage.navigate.direction must be 'java_to_cobol' or 'cobol_to_java'";
  }
  if (!isBoolean(payload.resolved)) {
    return "lineage.navigate.resolved must be a boolean";
  }
  if (
    payload.mappingClass !== undefined &&
    !isOneOf(payload.mappingClass, MAPPING_CLASSES)
  ) {
    return "lineage.navigate.mappingClass must be a closed mapping-class enum value";
  }
  if (
    payload.unresolvedReason !== undefined &&
    !isOneOf(payload.unresolvedReason, UNRESOLVED_REASONS)
  ) {
    return "lineage.navigate.unresolvedReason must be a closed unresolved-reason enum value";
  }
  return true;
}

function validateStacktraceFrameClickPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["resolved"])) {
    return "stacktrace.frame_click payload contains an unknown property";
  }
  if (!isBoolean(payload.resolved)) {
    return "stacktrace.frame_click.resolved must be a boolean";
  }
  return true;
}

function validateDiffOpenPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["hasPrevious", "lineageAvailable"])) {
    return "diff.open payload contains an unknown property";
  }
  if (!isBoolean(payload.hasPrevious)) {
    return "diff.open.hasPrevious must be a boolean";
  }
  if (!isBoolean(payload.lineageAvailable)) {
    return "diff.open.lineageAvailable must be a boolean";
  }
  return true;
}

function validateAssistInvokedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (
    !hasOnlyKnownKeys(payload, [
      "sourceKind",
      "regionLineCount",
      "redactionApplied",
    ])
  ) {
    return "assist.invoked payload contains an unknown property";
  }
  if (!isOneOf(payload.sourceKind, SOURCE_KINDS)) {
    return "assist.invoked.sourceKind must be 'cobol' or 'java'";
  }
  if (!isNonNegativeInteger(payload.regionLineCount)) {
    return "assist.invoked.regionLineCount must be a non-negative integer";
  }
  if (!isNonNegativeInteger(payload.redactionApplied)) {
    return "assist.invoked.redactionApplied must be a non-negative integer";
  }
  return true;
}

function validateAssistResultPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["outcome"])) {
    return "assist.result payload contains an unknown property";
  }
  if (!isOneOf(payload.outcome, ASSIST_RESULT_OUTCOMES)) {
    return "assist.result.outcome must be a closed assist-result enum value";
  }
  return true;
}

function validateSaveLocalPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["kind", "encrypted"])) {
    return "save.local payload contains an unknown property";
  }
  if (!isOneOf(payload.kind, SOURCE_KINDS)) {
    return "save.local.kind must be 'cobol' or 'java'";
  }
  if (!isBoolean(payload.encrypted)) {
    return "save.local.encrypted must be a boolean";
  }
  return true;
}

function validateConflictResolvedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["kind", "pick"])) {
    return "conflict.resolved payload contains an unknown property";
  }
  if (!isOneOf(payload.kind, SOURCE_KINDS)) {
    return "conflict.resolved.kind must be 'cobol' or 'java'";
  }
  if (!isOneOf(payload.pick, CONFLICT_PICKS)) {
    return "conflict.resolved.pick must be a closed conflict-pick enum value";
  }
  return true;
}

function validateGenerateInvokedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["trigger", "hadManualEdits"])) {
    return "generate.invoked payload contains an unknown property";
  }
  if (!isOneOf(payload.trigger, GENERATE_TRIGGERS)) {
    return "generate.invoked.trigger must be a closed generate-trigger enum value";
  }
  if (!isBoolean(payload.hadManualEdits)) {
    return "generate.invoked.hadManualEdits must be a boolean";
  }
  return true;
}

function validateGenerateResultPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["outcome", "latencyBucket"])) {
    return "generate.result payload contains an unknown property";
  }
  if (!isOneOf(payload.outcome, GENERATE_OUTCOMES)) {
    return "generate.result.outcome must be a closed generate-outcome enum value";
  }
  if (!isOneOf(payload.latencyBucket, GENERATE_LATENCY_BUCKETS)) {
    return "generate.result.latencyBucket must be a closed generate-latency-bucket enum value";
  }
  return true;
}

function validateCompileCheckInvokedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["trigger"])) {
    return "compile_check.invoked payload contains an unknown property";
  }
  if (!isOneOf(payload.trigger, TOOLBAR_OR_SHORTCUT)) {
    return "compile_check.invoked.trigger must be 'toolbar' or 'shortcut'";
  }
  return true;
}

function validateCompileCheckResultPayload(
  payload: Record<string, unknown>,
): true | string {
  if (
    !hasOnlyKnownKeys(payload, [
      "outcome",
      "diagnosticCountBucket",
      "latencyBucket",
    ])
  ) {
    return "compile_check.result payload contains an unknown property";
  }
  if (!isOneOf(payload.outcome, COMPILE_OUTCOMES)) {
    return "compile_check.result.outcome must be a closed compile-outcome enum value";
  }
  if (!isOneOf(payload.diagnosticCountBucket, DIAGNOSTIC_COUNT_BUCKETS)) {
    return "compile_check.result.diagnosticCountBucket must be a closed diagnostic-count-bucket enum value";
  }
  if (!isOneOf(payload.latencyBucket, COMPILE_LATENCY_BUCKETS)) {
    return "compile_check.result.latencyBucket must be a closed compile-latency-bucket enum value";
  }
  return true;
}

function validateVerifyInvokedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["trigger", "hadManualEdits"])) {
    return "verify.invoked payload contains an unknown property";
  }
  if (!isOneOf(payload.trigger, TOOLBAR_OR_SHORTCUT)) {
    return "verify.invoked.trigger must be 'toolbar' or 'shortcut'";
  }
  if (!isBoolean(payload.hadManualEdits)) {
    return "verify.invoked.hadManualEdits must be a boolean";
  }
  return true;
}

function validateVerifyResultPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["outcome"])) {
    return "verify.result payload contains an unknown property";
  }
  if (!isOneOf(payload.outcome, VERIFY_OUTCOMES)) {
    return "verify.result.outcome must be a closed verify-outcome enum value";
  }
  return true;
}

function validateThreeWayMergeOpenedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["regionCountBucket"])) {
    return "three_way_merge.opened payload contains an unknown property";
  }
  if (!isOneOf(payload.regionCountBucket, THREE_WAY_BUCKETS)) {
    return "three_way_merge.opened.regionCountBucket must be a closed bucket enum value";
  }
  return true;
}

function validateThreeWayMergeResolvedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["regionsPickedPerSource", "cancelled"])) {
    return "three_way_merge.resolved payload contains an unknown property";
  }
  if (!isBoolean(payload.cancelled)) {
    return "three_way_merge.resolved.cancelled must be a boolean";
  }
  const regions = payload.regionsPickedPerSource;
  if (!isRecord(regions)) {
    return "three_way_merge.resolved.regionsPickedPerSource must be an object";
  }
  if (!hasOnlyKnownKeys(regions, ["manual", "new_generator", "baseline"])) {
    return "three_way_merge.resolved.regionsPickedPerSource contains an unknown property";
  }
  if (
    !isNonNegativeInteger(regions.manual) ||
    !isNonNegativeInteger(regions.new_generator) ||
    !isNonNegativeInteger(regions.baseline)
  ) {
    return "three_way_merge.resolved.regionsPickedPerSource counts must be non-negative integers";
  }
  return true;
}

function validateManualEditRegionClassifiedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["originClass", "mappingClass"])) {
    return "manual_edit.region_classified payload contains an unknown property";
  }
  if (!isOneOf(payload.originClass, ORIGIN_CLASSES)) {
    return "manual_edit.region_classified.originClass must be a closed origin-class enum value";
  }
  if (
    payload.mappingClass !== undefined &&
    !isOneOf(payload.mappingClass, MAPPING_CLASSES)
  ) {
    return "manual_edit.region_classified.mappingClass must be a closed mapping-class enum value";
  }
  return true;
}

function validateFormatInvokedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["trigger", "fileLineCountBucket"])) {
    return "format.invoked payload contains an unknown property";
  }
  if (!isOneOf(payload.trigger, SHORTCUT_OR_ON_SAVE)) {
    return "format.invoked.trigger must be 'shortcut' or 'on_save'";
  }
  if (!isOneOf(payload.fileLineCountBucket, FILE_LINE_BUCKETS)) {
    return "format.invoked.fileLineCountBucket must be a closed file-line bucket enum value";
  }
  return true;
}

function validateFormatResultPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["outcome", "latencyBucket"])) {
    return "format.result payload contains an unknown property";
  }
  if (!isOneOf(payload.outcome, FORMAT_OUTCOMES)) {
    return "format.result.outcome must be a closed format-outcome enum value";
  }
  if (!isOneOf(payload.latencyBucket, FORMAT_LATENCY_BUCKETS)) {
    return "format.result.latencyBucket must be a closed format-latency bucket enum value";
  }
  return true;
}

function validateLintMarkersChangedPayload(
  payload: Record<string, unknown>,
): true | string {
  if (!hasOnlyKnownKeys(payload, ["countBucket"])) {
    return "lint.markers_changed payload contains an unknown property";
  }
  if (!isOneOf(payload.countBucket, LINT_COUNT_BUCKETS)) {
    return "lint.markers_changed.countBucket must be a closed lint-count bucket enum value";
  }
  return true;
}

const PAYLOAD_VALIDATORS: Record<
  EditorTelemetryEventType,
  (payload: Record<string, unknown>) => true | string
> = {
  "marker.navigate": validateMarkerNavigatePayload,
  "hover.opened": (p) => validateHoverPayload(p, "hover.opened"),
  "hover.expanded": (p) => validateHoverPayload(p, "hover.expanded"),
  "lineage.navigate": validateLineageNavigatePayload,
  "stacktrace.frame_click": validateStacktraceFrameClickPayload,
  "diff.open": validateDiffOpenPayload,
  "assist.invoked": validateAssistInvokedPayload,
  "assist.result": validateAssistResultPayload,
  "save.local": validateSaveLocalPayload,
  "conflict.resolved": validateConflictResolvedPayload,
  "generate.invoked": validateGenerateInvokedPayload,
  "generate.result": validateGenerateResultPayload,
  "compile_check.invoked": validateCompileCheckInvokedPayload,
  "compile_check.result": validateCompileCheckResultPayload,
  "verify.invoked": validateVerifyInvokedPayload,
  "verify.result": validateVerifyResultPayload,
  "three_way_merge.opened": validateThreeWayMergeOpenedPayload,
  "three_way_merge.resolved": validateThreeWayMergeResolvedPayload,
  "manual_edit.region_classified": validateManualEditRegionClassifiedPayload,
  "format.invoked": validateFormatInvokedPayload,
  "format.result": validateFormatResultPayload,
  "lint.markers_changed": validateLintMarkersChangedPayload,
};

export function validateTelemetryEvent(
  raw: unknown,
):
  | { ok: true; value: ValidatedEditorTelemetryEvent }
  | { ok: false; message: string } {
  if (!isRecord(raw)) {
    return { ok: false, message: "event must be a JSON object" };
  }
  const allowed = [
    "schemaVersion",
    "eventType",
    "occurredAt",
    "sessionId",
    "payload",
  ];
  if (!hasOnlyKnownKeys(raw, allowed)) {
    return {
      ok: false,
      message: "event contains an unknown top-level property",
    };
  }
  if (raw.schemaVersion !== EDITOR_TELEMETRY_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `event.schemaVersion must be ${JSON.stringify(EDITOR_TELEMETRY_SCHEMA_VERSION)}`,
    };
  }
  if (
    !isNonEmptyString(raw.eventType) ||
    !EVENT_TYPE_SET.has(raw.eventType as EditorTelemetryEventType)
  ) {
    return {
      ok: false,
      message: "event.eventType must be a closed editor-telemetry event type",
    };
  }
  if (
    !isNonEmptyString(raw.occurredAt) ||
    !ISO_DATE_PATTERN.test(raw.occurredAt)
  ) {
    return {
      ok: false,
      message: "event.occurredAt must be an RFC 3339 timestamp",
    };
  }
  if (
    !isNonEmptyString(raw.sessionId) ||
    !SAFE_ID_PATTERN.test(raw.sessionId)
  ) {
    return {
      ok: false,
      message: "event.sessionId must match ^[A-Za-z0-9._-]{1,128}$",
    };
  }
  if (!isRecord(raw.payload)) {
    return { ok: false, message: "event.payload must be a JSON object" };
  }
  const validator =
    PAYLOAD_VALIDATORS[raw.eventType as EditorTelemetryEventType];
  const validation = validator(raw.payload);
  if (validation !== true) {
    return { ok: false, message: validation };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
      eventType: raw.eventType as EditorTelemetryEventType,
      occurredAt: raw.occurredAt,
      sessionId: raw.sessionId,
      payload: raw.payload,
    },
  };
}

export function validateTelemetryBatch(
  raw: unknown,
): EditorTelemetryValidation {
  if (!isRecord(raw)) {
    return rejectEnvelope("request body must be a JSON object");
  }
  if (!hasOnlyKnownKeys(raw, ["schemaVersion", "events"])) {
    return rejectEnvelope(
      "request body contains an unknown top-level property",
    );
  }
  if (raw.schemaVersion !== EDITOR_TELEMETRY_SCHEMA_VERSION) {
    return rejectEnvelope(
      `schemaVersion must be ${JSON.stringify(EDITOR_TELEMETRY_SCHEMA_VERSION)}`,
    );
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    return rejectEnvelope("events must be a non-empty array");
  }
  if (raw.events.length > EDITOR_TELEMETRY_MAX_BATCH_EVENTS) {
    return {
      ok: false,
      errorCode: "batch_too_large",
      message: `events array must not exceed ${EDITOR_TELEMETRY_MAX_BATCH_EVENTS} entries`,
    };
  }
  const validated: ValidatedEditorTelemetryEvent[] = [];
  for (let i = 0; i < raw.events.length; i += 1) {
    const result = validateTelemetryEvent(raw.events[i]);
    if (!result.ok) {
      return rejectEvent(`events[${i}]: ${result.message}`);
    }
    validated.push(result.value);
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
      events: validated,
    },
  };
}

// ---------------------------------------------------------------------------
// BFF augmentation — adds tenantId, userId, server-side occurredAt clock
// stamp the experience-learning-service correlates against.
// ---------------------------------------------------------------------------

export interface AugmentationContext {
  tenantId: string;
  userId: string;
  // Server-side wall clock used to stamp ``receivedAt``. The client
  // ``occurredAt`` is preserved verbatim; ``receivedAt`` is added so a
  // clock-skewed client cannot evade time-bucket analysis downstream.
  now: () => Date;
}

export interface AugmentedEditorTelemetryEvent extends ValidatedEditorTelemetryEvent {
  tenantId: string;
  userId: string;
  receivedAt: string;
}

export interface AugmentedEditorTelemetryBatch {
  schemaVersion: EditorTelemetrySchemaVersion;
  events: AugmentedEditorTelemetryEvent[];
}

export function augmentBatch(
  batch: EditorTelemetryBatch,
  context: AugmentationContext,
): AugmentedEditorTelemetryBatch {
  if (!SAFE_ID_PATTERN.test(context.tenantId)) {
    throw new Error("tenantId must match the safe identifier pattern");
  }
  if (!SAFE_ID_PATTERN.test(context.userId)) {
    throw new Error("userId must match the safe identifier pattern");
  }
  const receivedAt = context.now().toISOString();
  return {
    schemaVersion: batch.schemaVersion,
    events: batch.events.map((event) => ({
      ...event,
      tenantId: context.tenantId,
      userId: context.userId,
      receivedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Identity extraction — the BFF reads tenantId / userId from request
// headers when present and falls back to the same defaults editorExplain
// uses ("default" / "local") so the BFF can boot without an
// authentication layer in front of it. ``sessionId`` is taken from the
// event itself (AC6 — session id is derived from the same session token
// used by the BFF auth, not a separate identifier).
// ---------------------------------------------------------------------------

export interface ExtractedIdentity {
  tenantId: string;
  userId: string;
}

const DEFAULT_TENANT_ID = "default";
const DEFAULT_USER_ID = "local";

export function extractIdentity(
  headers: Record<string, string | string[] | undefined>,
): ExtractedIdentity {
  const tenantHeader = headers["x-c2c-tenant-id"];
  const userHeader = headers["x-c2c-user-id"];
  const tenantId = pickFirstHeader(tenantHeader);
  const userId = pickFirstHeader(userHeader);
  return {
    tenantId:
      isNonEmptyString(tenantId) && SAFE_ID_PATTERN.test(tenantId)
        ? tenantId
        : DEFAULT_TENANT_ID,
    userId:
      isNonEmptyString(userId) && SAFE_ID_PATTERN.test(userId)
        ? userId
        : DEFAULT_USER_ID,
  };
}

function pickFirstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string")
    return value[0].trim();
  return null;
}

// ---------------------------------------------------------------------------
// HTTP status mapping
// ---------------------------------------------------------------------------

export function statusForValidationErrorCode(
  code: EditorTelemetryValidationErrorCode,
): number {
  switch (code) {
    case "batch_too_large":
      return 413;
    case "invalid_envelope":
    case "invalid_event":
    default:
      return 400;
  }
}
