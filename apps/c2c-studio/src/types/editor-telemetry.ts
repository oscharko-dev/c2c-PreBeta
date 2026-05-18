// Studio-IDE-11 (#251): editor telemetry — closed-enum, tag-only event
// types. The frontend, BFF, and JSON schema
// (`schemas/editor-telemetry-event-v0.json`) share this exact shape: any
// drift would either silently drop events at the BFF boundary or, worse,
// allow a free-form string field to leak through and carry source
// content. Every variable field below is either a discriminated union
// member, a literal enum, or a non-negative integer count.

export const EDITOR_TELEMETRY_SCHEMA_VERSION = "v0" as const;

export type EditorTelemetrySchemaVersion =
  typeof EDITOR_TELEMETRY_SCHEMA_VERSION;

export type EditorTelemetrySourceKind = "cobol" | "java";

export type EditorTelemetrySeverity = "error" | "warning" | "info" | "hint";

export type EditorTelemetryMappingClass =
  | "direct"
  | "aggregated"
  | "synthesized"
  | "agent_originated";

// -----------------------------------------------------------------------
// Per-eventType payload shapes (closed-enum, tag-only).
// -----------------------------------------------------------------------

export interface MarkerNavigatePayload {
  direction: "next" | "prev";
  sourceKind: EditorTelemetrySourceKind;
  severity: EditorTelemetrySeverity;
  irCodeOrIRNodeKind?: string;
}

export type HoverConstructKind =
  | "pic"
  | "comp3"
  | "occurs"
  | "redefines"
  | "value"
  | "section"
  | "paragraph"
  | "fixed-format-zone";

export interface HoverOpenedPayload {
  constructKind: HoverConstructKind;
}

export type HoverExpandedPayload = HoverOpenedPayload;

export interface LineageNavigatePayload {
  direction: "java_to_cobol" | "cobol_to_java";
  resolved: boolean;
  mappingClass?: EditorTelemetryMappingClass;
  unresolvedReason?: "no_mapping" | "stale_manual_edit" | "manual_only";
}

export interface StacktraceFrameClickPayload {
  resolved: boolean;
}

export interface DiffOpenPayload {
  hasPrevious: boolean;
  lineageAvailable: boolean;
}

export interface AssistInvokedPayload {
  sourceKind: EditorTelemetrySourceKind;
  regionLineCount: number;
  redactionApplied: number;
}

export type AssistResultOutcome =
  | "success"
  | "budget_exhausted"
  | "policy_denied"
  | "gateway_unavailable"
  | "timeout"
  | "invalid_region";

export interface AssistResultPayload {
  outcome: AssistResultOutcome;
}

export interface SaveLocalPayload {
  kind: "cobol" | "java";
  encrypted: boolean;
}

export interface ConflictResolvedPayload {
  kind: "cobol" | "java";
  pick: "backend_sample" | "local_draft" | "last_run_input";
}

export interface GenerateInvokedPayload {
  trigger: "generate" | "regenerate" | "generate_and_verify";
  hadManualEdits: boolean;
}

export type GenerateLatencyBucket = "lt_2s" | "lt_10s" | "lt_60s" | "ge_60s";

export interface GenerateResultPayload {
  outcome: "success" | "merge_required" | "failed" | "cancelled";
  latencyBucket: GenerateLatencyBucket;
}

export interface CompileCheckInvokedPayload {
  trigger: "toolbar" | "shortcut";
}

export type DiagnosticCountBucket = "zero" | "lt_10" | "lt_100" | "ge_100";

export type CompileCheckLatencyBucket = "lt_1s" | "lt_5s" | "ge_5s";

export interface CompileCheckResultPayload {
  outcome: "ok" | "errors" | "gateway_unavailable" | "timeout";
  diagnosticCountBucket: DiagnosticCountBucket;
  latencyBucket: CompileCheckLatencyBucket;
}

export interface VerifyInvokedPayload {
  trigger: "toolbar" | "shortcut";
  hadManualEdits: boolean;
}

export interface VerifyResultPayload {
  outcome:
    | "success"
    | "compile_failed"
    | "run_failed"
    | "output_divergence"
    | "blocked"
    | "cancelled"
    | "gateway_unavailable";
}

export type ThreeWayMergeRegionCountBucket = "lt_5" | "lt_20" | "ge_20";

export interface ThreeWayMergeOpenedPayload {
  regionCountBucket: ThreeWayMergeRegionCountBucket;
}

export interface ThreeWayMergeResolvedPayload {
  regionsPickedPerSource: {
    manual: number;
    new_generator: number;
    baseline: number;
  };
  cancelled: boolean;
}

export interface ManualEditRegionClassifiedPayload {
  originClass: "manual_modified" | "manual_edit";
  mappingClass?: EditorTelemetryMappingClass;
}

export type FormatFileLineCountBucket = "lt_100" | "lt_1000" | "ge_1000";

export interface FormatInvokedPayload {
  trigger: "shortcut" | "on_save";
  fileLineCountBucket: FormatFileLineCountBucket;
}

export type FormatLatencyBucket = "lt_500ms" | "lt_1500ms" | "ge_1500ms";

export interface FormatResultPayload {
  outcome: "success" | "unavailable" | "timeout" | "noop";
  latencyBucket: FormatLatencyBucket;
}

export type LintMarkerCountBucket = "zero" | "lt_10" | "lt_50" | "ge_50";

export interface LintMarkersChangedPayload {
  countBucket: LintMarkerCountBucket;
}

// -----------------------------------------------------------------------
// Discriminated event union.
// -----------------------------------------------------------------------

export type EditorTelemetryEventInput =
  | { eventType: "marker.navigate"; payload: MarkerNavigatePayload }
  | { eventType: "hover.opened"; payload: HoverOpenedPayload }
  | { eventType: "hover.expanded"; payload: HoverExpandedPayload }
  | { eventType: "lineage.navigate"; payload: LineageNavigatePayload }
  | {
      eventType: "stacktrace.frame_click";
      payload: StacktraceFrameClickPayload;
    }
  | { eventType: "diff.open"; payload: DiffOpenPayload }
  | { eventType: "assist.invoked"; payload: AssistInvokedPayload }
  | { eventType: "assist.result"; payload: AssistResultPayload }
  | { eventType: "save.local"; payload: SaveLocalPayload }
  | { eventType: "conflict.resolved"; payload: ConflictResolvedPayload }
  | { eventType: "generate.invoked"; payload: GenerateInvokedPayload }
  | { eventType: "generate.result"; payload: GenerateResultPayload }
  | {
      eventType: "compile_check.invoked";
      payload: CompileCheckInvokedPayload;
    }
  | { eventType: "compile_check.result"; payload: CompileCheckResultPayload }
  | { eventType: "verify.invoked"; payload: VerifyInvokedPayload }
  | { eventType: "verify.result"; payload: VerifyResultPayload }
  | {
      eventType: "three_way_merge.opened";
      payload: ThreeWayMergeOpenedPayload;
    }
  | {
      eventType: "three_way_merge.resolved";
      payload: ThreeWayMergeResolvedPayload;
    }
  | {
      eventType: "manual_edit.region_classified";
      payload: ManualEditRegionClassifiedPayload;
    }
  | { eventType: "format.invoked"; payload: FormatInvokedPayload }
  | { eventType: "format.result"; payload: FormatResultPayload }
  | {
      eventType: "lint.markers_changed";
      payload: LintMarkersChangedPayload;
    };

export type EditorTelemetryEventType = EditorTelemetryEventInput["eventType"];

// The wire envelope adds schemaVersion + occurredAt + identity fields the
// BFF augments. The frontend ships the schemaVersion + eventType +
// payload + occurredAt + sessionId; the BFF resolves tenantId and userId
// from its auth context and forwards.
export type EditorTelemetryEventEnvelope = EditorTelemetryEventInput & {
  schemaVersion: EditorTelemetrySchemaVersion;
  occurredAt: string;
  sessionId: string;
};

export const EDITOR_TELEMETRY_EVENT_TYPES: readonly EditorTelemetryEventType[] =
  [
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
