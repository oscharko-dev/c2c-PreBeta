export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string; details?: ApiErrorDetails };

export type ApiErrorKind = "config" | "http" | "network" | "parse" | "contract";

export interface ApiErrorDetails {
  kind: ApiErrorKind;
  body?: unknown;
  cause?: unknown;
}

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

export type UpstreamMode = "live" | "mock";

export interface ModeResponse {
  orchestrator: UpstreamMode;
  evidence: UpstreamMode;
  [key: string]: unknown;
}

export interface RunLinks {
  self: string;
  generated: string;
  generatedFiles: string;
  buildTest: string;
  evidence: string;
  progress?: string;
  events: string;
  artifacts: string;
  learning?: string;
  experience?: string;
  // Issue #172: W0.2 workflow contract endpoint.
  workflow?: string;
}

// Issue #172: closed set of UI-safe failure codes the BFF exposes.
export type W02UiErrorCode =
  | "unsupported_cobol"
  | "parse_failed"
  | "semantic_ir_failed"
  | "model_gateway_unavailable"
  | "model_policy_denied"
  | "agent_timeout"
  | "agent_contract_invalid"
  | "java_generation_failed"
  | "java_compile_failed"
  | "java_runtime_failed"
  | "oracle_mismatch"
  | "evidence_incomplete"
  | "cancelled"
  | "service_unavailable"
  | "internal_error";

export type RunFinalClassification =
  | "success"
  | "blocked"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface RepairBudget {
  limit: number;
  used: number;
  remaining: number;
}

// Issue #216 (W0.3-5): per-run assist and Model Gateway invocation budgets.
// Same shape as ``RepairBudget`` so the UI can render any budget uniformly.
export interface AssistBudget {
  limit: number;
  used: number;
  remaining: number;
}

export interface ModelInvocationBudget {
  limit: number;
  used: number;
  remaining: number;
}

export interface W02RunContractFields {
  // Always present on the BFF response; null/zero when no contract exists yet.
  activeStep?: string | null;
  agentAttemptCount?: number;
  repairBudget?: RepairBudget | null;
  // Issue #216 (W0.3-5): assist + model invocation budgets surfaced on
  // every BFF response so the UI can render budget pressure without an
  // extra workflow fetch.
  assistBudget?: AssistBudget | null;
  modelInvocationBudget?: ModelInvocationBudget | null;
  finalClassification?: RunFinalClassification | null;
  failureCode?: W02UiErrorCode | null;
  failureMessage?: string | null;
}

export interface TransformResponse extends W02RunContractFields {
  runId: string;
  orchestratorRunId: string;
  programId: string;
  status: "starting" | "updating" | "completed" | "failed";
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  message?: string;
  evidenceRefs?: string[];
  policyDecision?: string;
  createdAt: string;
  updatedAt: string;
  links: RunLinks;
}

// Issue #241 / ADR 0006: run summary envelope. ``schemaVersion`` is
// optional on the wire; absence means ``"v0"``. Additive-only at
// minor wave boundaries. Studio MUST NOT crash on unknown fields
// from a future BFF; unknown fields are preserved through opaque
// pass-through (ADR 0006 Decision 3).
//
// ``javaRegionClassification`` null-fallback per ADR 0006 Decision 4:
// when absent, the generated-Java buffer renders without trust-pillar
// decoration. Studio MUST NOT infer regions from filename or content.
export interface RunSummary extends W02RunContractFields {
  schemaVersion?: "v0";
  runId: string;
  programId: string;
  status: "starting" | "updating" | "completed" | "failed";
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  message?: string;
  evidenceRefs?: string[];
  policyDecision?: string;
  createdAt: string;
  updatedAt: string;
  javaRegionClassification?: JavaOriginOverlay | null;
}

export interface GeneratedFileRef {
  path: string;
  sha256?: string;
  byteSize?: number;
  mimeType?: string;
  kind?: string;
  name?: string;
}

// Issue #241 / ADR 0006: lineage triple emitted alongside generated
// Java. ``schemaVersion`` is optional on the wire; absence means
// ``"v0"``. Null-fallback rule per ADR 0006 Decision 4: when the
// whole DTO is absent on ``GeneratedView``, the lineage UI renders
// "Lineage unavailable" — Studio MUST NOT infer the value.
export interface GeneratedTraceability {
  schemaVersion?: "v0";
  programId: string;
  irId: string;
  sourceHash: string;
}

export interface OutputRef {
  sha256: string;
  byteSize?: number;
  kind?: string;
  path?: string;
  name?: string;
  mimeType?: string;
  createdBy?: string;
  createdAt?: string;
}

// Issue #241 / ADR 0006: BFF-shaped diagnostic record consumed by
// the Studio Problems panel and editor markers. ``schemaVersion`` is
// optional on the wire; absence means ``"v0"``. Null-fallback rules
// per ADR 0006 Decision 4:
//   - ``line`` absent     → marker at file level; no source jump
//   - ``column`` absent   → marker spans the whole ``line``
//   - ``endLine`` /
//     ``endColumn`` absent → point marker at ``(line, column)``
//   - ``filePath`` absent → run-level Problems entry; no editor tab
//   - ``sourceKind`` absent → treat as ``"unknown"``; do not infer
//   - ``originStep`` absent → suppress originated-step pill
//   - ``artifactRef`` absent → no "jump to artifact" affordance
// Unknown ``severity`` values render at ``"info"`` and surface the
// raw upstream value in the marker tooltip (ADR 0006 Decision 3).

// Studio-IDE-5 (#244): typed severity enum mirrors the BFF
// `diagnostics.ts` module. Unknown upstream values are coerced to
// "info" on the BFF side, so consumers can treat the union as
// exhaustive.
export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

// Studio-IDE-5 (#244): typed source-kind enum mirrors the BFF
// `diagnostics.ts` module. Unknown values are dropped on the BFF.
export type DiagnosticSourceKind =
  | "cobol"
  | "ir"
  | "generated_java"
  | "build"
  | "test";

export interface Diagnostic {
  schemaVersion?: "v0";
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  filePath?: string;
  sourceKind?: DiagnosticSourceKind;
  originStep?: string;
  // Optional reference to the artifact this diagnostic attaches to
  // (semantic-IR node, generated-Java file, etc.). Populated by
  // Studio-IDE-5 (#244) and Studio-IDE-6 (#248); absent on
  // diagnostics from older steps or replayed v0 fixtures.
  artifactRef?: OutputRef | null;
}

export interface RunArtifactMetadata {
  sha256: string;
  byteSize?: number;
  mimeType?: string;
  kind: string;
  createdBy: string;
  createdAt: string;
  path: string;
  name: string;
}

export interface GeneratedView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  status: "generated" | "unsupported" | "skipped" | "incomplete";
  entryClass?: string;
  entryFilePath?: string;
  fileCount?: number;
  fileRefs?: GeneratedFileRef[];
  unsupportedFeatures?: string[];
  openAssumptions?: string[];
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  generationResponseRef?: OutputRef | null;
  artifactRef: OutputRef | null;
  traceability?: GeneratedTraceability;
  diagnostics?: Diagnostic[];
  note?: string;
}

export interface GeneratedFilesIndex {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  status: "complete" | "incomplete";
  files: GeneratedFileRef[];
  fileCount: number;
  entryFilePath?: string;
  artifactRef: OutputRef | null;
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  note?: string;
}

export interface BuildTestView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  status:
    | "ok"
    | "compile-failed"
    | "run-failed"
    | "output-divergence"
    | "golden-master-reproduction-failed"
    | "missing-golden-master"
    | "skipped"
    | "incomplete";
  classification:
    | "match"
    | "divergence-known-w0-coverage-gap"
    | "divergence-unknown"
    | "true-golden-master-reproduction-error"
    | "true-golden-master-mismatch"
    | "compile-error"
    | "run-error"
    | "skipped-no-execution";
  expectedOutput?: string;
  actualOutput?: string;
  outputRef?: OutputRef | null;
  expectedOutputRef?: OutputRef | null;
  actualOutputRef?: OutputRef | null;
  generatedArtifactRef: OutputRef | null;
  diagnostics?: Diagnostic[];
  note?: string;
}

export interface EvidenceView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  status: "complete" | "incomplete" | "invalid";
  packId?: string;
  manifestHash?: string;
  validationStatus?: "valid" | "invalid" | "incomplete" | "unknown";
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  artifactRef?: OutputRef | null;
  exportRef?: OutputRef | null;
  generatedArtifactRef: OutputRef | null;
  note?: string;
}

export interface RunEvent {
  type?: string;
  status?: string;
  message?: string;
  createdAt?: string;
}

export interface RunEventsView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  events: RunEvent[];
}

export type RunProgressStepStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "skipped";

export interface RunProgressStep {
  stepId: number;
  name: string;
  capabilityId: string;
  service: string;
  actor: string;
  status: RunProgressStepStatus;
  startedAt?: string;
  finishedAt?: string;
  diagnostic?: string;
  inputRef?: OutputRef | null;
  outputRef?: OutputRef | null;
  latencyMs?: number;
}

export interface RunProgressView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  status: "complete" | "incomplete";
  runStatus?: "starting" | "updating" | "completed" | "failed";
  currentStep: string | null;
  failedStep: string | null;
  completedSteps: string[];
  stepCount: number;
  steps: RunProgressStep[];
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  progressRef?: RunArtifactMetadata | null;
  updatedAt?: string | null;
  note?: string;
}

export interface RunArtifactsView {
  runId: string;
  programId?: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  orchestratorRunId?: string;
  artifacts: RunArtifactMetadata[];
  summary?: Record<string, unknown>;
  missingArtifacts?: string[];
  createdAt?: string;
  updatedAt?: string;
  note?: string;
}

export interface GeneratedFileContent {
  runId: string;
  programId?: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  path: string;
  content: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  kind?: string;
  orchestratorRunId?: string;
}

// Issue #172: W0.2 workflow contract product-level view.
export type W02ActiveAgent =
  | "transformation_agent"
  | "verification_repair_agent"
  | "cobol_parser"
  | "semantic_ir"
  | "java_generator"
  | "build_test_runner"
  | "evidence_service";

export type W02RepairDecision =
  | "propose_candidate"
  | "refuse"
  | "escalate"
  | "no_change";

export interface RepairAttemptSummary {
  attemptNumber: number;
  repairDecision: W02RepairDecision;
  failureCategory: string | null;
  hasModelInvocation: boolean;
  hasRepairInput: boolean;
  hasJavaCandidate: boolean;
  rationale?: string;
}

export interface WorkflowArtifactRef {
  sha256: string;
  byteSize: number;
  kind: string;
}

// Issue #218 (W0.3-7): the closed-set assist-decision surface the BFF
// publishes on the workflow envelope. Mirrors the BFF types in
// services/c2c-bff/src/server.ts. The Studio refuses to render any
// outcome / reason-code / agent-role value outside these enums so an
// unknown upstream value is surfaced honestly as a contract error
// rather than silently mis-displayed.
export type AssistDecisionOutcome = "assist_required" | "assist_not_required";

// Deterministic uncertainty reason codes (Issue #215) followed by
// caller-driven baseline codes (Issue #214) and the W0.3-5
// hard-termination signal (Issue #216): the caller opted in but the
// per-run assist budget is exhausted so the deterministic baseline is
// the final candidate.
export type AssistDecisionReasonCode =
  | "semantic_ir_bounded_ambiguity"
  | "translation_unsupported_repairable"
  | "baseline_open_assumptions"
  | "deterministic_candidate_low_confidence"
  | "caller_explicit_opt_in"
  | "caller_did_not_opt_in"
  | "assist_budget_exhausted";

export type AssistDecisionAgentRole = "transformation_agent";

export interface AssistDecisionArtifactRef {
  sha256?: string;
  byteSize?: number;
  kind?: string;
  path?: string;
}

export interface AssistDecisionSummary {
  outcome: AssistDecisionOutcome;
  reasonCode: AssistDecisionReasonCode;
  decidedAt: string;
  selectedAgentRole: AssistDecisionAgentRole | null;
  affectedArtifactRefs: AssistDecisionArtifactRef[];
  repairBudgetSnapshot: RepairBudget | null;
  assistBudgetSnapshot: AssistBudget | null;
  modelInvocationBudgetSnapshot: ModelInvocationBudget | null;
  rationale: string | null;
}

export interface RunWorkflowView {
  runId: string;
  programId: string;
  mode: "live" | "diagnostic-fixture";
  productMode: "live" | "unavailable";
  source: "live" | "cached" | "unavailable";
  state: string | null;
  activeStep: string | null;
  activeAgent: W02ActiveAgent | null;
  agentAttemptCount: number;
  repairBudget: RepairBudget | null;
  // Issue #216 (W0.3-5): per-run assist + Model Gateway budgets surfaced
  // on the workflow envelope so the UI can render budget pressure
  // alongside the existing repair budget.
  assistBudget: AssistBudget | null;
  modelInvocationBudget: ModelInvocationBudget | null;
  repairAttempts: RepairAttemptSummary[];
  // Issue #218 (W0.3-7): explicit assist-decision gate result. ``null``
  // while the run has not yet reached the gate; an ``assist_not_required``
  // outcome marks the run as deterministic-only, an ``assist_required``
  // outcome marks it as AI-assisted with the selected agent role and the
  // reason code that justified activation.
  assistDecision: AssistDecisionSummary | null;
  finalClassification: RunFinalClassification | null;
  failureCode: W02UiErrorCode | null;
  failureMessage: string | null;
  generatedJavaRef: WorkflowArtifactRef | null;
  buildTestResultRef: WorkflowArtifactRef | null;
  evidencePackRef: WorkflowArtifactRef | null;
}

// Issue #247 / Studio-ADR-4 (#257): region-granular provenance for generated
// Java files. IDE-6 populates the deterministic / agent_proposed /
// repair_attempted region classes; IDE-13 populates manual_modified /
// manual_edit when the developer edits a region. IDE-3 treats the whole
// envelope as opaque pass-through inside the IndexedDB draft so reloads do
// not lose the overlay alongside the buffer.
export type JavaOriginClass =
  | "deterministic"
  | "agent_proposed"
  | "repair_attempted"
  | "manual_modified"
  | "manual_edit";

// Studio-IDE-6 (#248): per-region verification outcome. ``no_oracle`` means
// the region was generated but the run never reached an oracle comparison;
// the Studio renders this as a "yellow" trust pillar so the user never sees
// a green badge unless an oracle actually passed.
export type JavaVerificationOutcome =
  | "oracle_passed"
  | "oracle_failed"
  | "no_oracle";

// Studio-IDE-6 (#248): how the region maps back to COBOL semantics.
//
//   * ``direct``           — 1:1 statement mapping (a single IR statement
//                            became a single Java statement).
//   * ``aggregated``       — many COBOL statements collapsed into one Java
//                            region (e.g. paragraph fold-in).
//   * ``synthesized``      — Java scaffolding the generator emitted without
//                            a direct COBOL counterpart (e.g. main / try-
//                            finally wrappers).
//   * ``agent_originated`` — produced by an assist or repair agent rather
//                            than the deterministic translator.
export type JavaMappingClass =
  | "direct"
  | "aggregated"
  | "synthesized"
  | "agent_originated";

// Studio-IDE-6 (#248): IDE-13 will extend this with richer overlay fields,
// but the optional shape lands here so the IndexedDB envelope (IDE-3) can
// carry the v1 overlay forward without a schema bump. ``verificationOutcome``
// and ``mappingClass`` are optional so older fixtures and the IDE-4 baseline
// overlay keep typechecking.
export interface JavaOriginRegion {
  lineRange: { startLine: number; endLine: number };
  originClass: JavaOriginClass;
  verificationOutcome?: JavaVerificationOutcome;
  mappingClass?: JavaMappingClass;
}

export interface JavaOriginOverlay {
  schemaVersion: "v0";
  runId: string;
  javaFile: string;
  regions: JavaOriginRegion[];
}

// Studio-IDE-6 (#248): region-granular classification surfaced by the BFF
// traceability envelope. The Java pane uses this to paint trust-pillar
// decorations; the lineage layer uses it to gate Java→COBOL jumps.
//
// ``verificationOutcome`` and ``mappingClass`` are REQUIRED here (in
// contrast to ``JavaOriginRegion``) because the traceability envelope is
// the authoritative source for IDE-6 trust-pillar painting — missing
// fields would force a fallback colour we explicitly do not want.
export interface JavaRegionClassification {
  schemaVersion: "v0";
  lineRange: { startLine: number; endLine: number };
  originClass: JavaOriginClass;
  verificationOutcome: JavaVerificationOutcome;
  mappingClass: JavaMappingClass;
}

// Studio-IDE-6 (#248): anchor an IR symbol back to its originating COBOL
// source line. Used by the inline IR-comment → COBOL lineage resolver.
export interface IrSymbolAnchor {
  cobolFile: string;
  cobolLine: number;
}

// Studio-IDE-6 (#248): the full traceability envelope returned by
// ``GET /api/v0/runs/{runId}/traceability``. ``trace`` is opaque pass-
// through (the IR graph is consumed elsewhere); the two maps are the
// load-bearing surfaces for lineage navigation and trust pillars.
//
// Map keys: ``irSymbolMap`` keyed by IR node id (e.g. ``s-move-x``);
//           ``javaRegionClassification`` keyed by generated Java file path
//           (e.g. ``src/main/java/...``).
export interface TraceabilityEnvelope {
  schemaVersion: "v0";
  runId: string;
  programId: string;
  trace: Record<string, unknown> | null;
  irSymbolMap: Record<string, IrSymbolAnchor>;
  // Nullable to match the BFF wire contract (the diagnostic-fixture stub and
  // the orchestrator-upstream-error fallback both return ``null`` here per
  // ADR-0006 §4). Consumers MUST treat ``null`` as "no classification
  // available" and fall back to the unclassified rendering path.
  javaRegionClassification: Record<string, JavaRegionClassification[]> | null;
}
