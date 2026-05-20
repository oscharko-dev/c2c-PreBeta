import { createHash } from "node:crypto";

import {
  defaultMessageFor,
  mapFailure,
  sanitizeUpstreamMessage,
  type W02UiErrorCode,
} from "./error-codes";
import type {
  RunFinalClassification,
  StoredAssistBudget,
  StoredModelInvocationBudget,
  StoredRepairBudget,
  StoredRun,
} from "./run-store";
import type { SampleDetail } from "./samples";

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

interface JavaRegionClassification {
  schemaVersion: "v0";
  lineRange: { startLine: number; endLine: number };
  originClass: JavaOriginClass;
  verificationOutcome: JavaVerificationOutcome;
  mappingClass: JavaMappingClass;
}

type JavaOriginClass =
  | "deterministic"
  | "agent_proposed"
  | "repair_attempted"
  | "manual_modified"
  | "manual_edit";

type JavaVerificationOutcome =
  | "oracle_passed"
  | "oracle_failed"
  | "no_oracle";

type JavaMappingClass =
  | "direct"
  | "aggregated"
  | "synthesized"
  | "agent_originated";

export interface WorkflowSnapshot {
  state: string | null;
  activeStep: string | null;
  activeAgent: string | null;
  agentAttemptCount: number;
  repairBudget: StoredRepairBudget | null;
  assistBudget: StoredAssistBudget | null;
  modelInvocationBudget: StoredModelInvocationBudget | null;
  repairAttempts: SanitizedRepairAttempt[];
  assistDecision: AssistDecisionSummary | null;
  finalClassification: RunFinalClassification | null;
  failureCode: W02UiErrorCode | null;
  failureMessage: string | null;
  manualEditsCarriedOver: boolean;
  manualDriftRegionCount: number;
  generatedJavaRef: OutputRef | null;
  buildTestResultRef: OutputRef | null;
  evidencePackRef: OutputRef | null;
}

interface AssistDecisionArtifactRef {
  sha256?: string;
  byteSize?: number;
  kind?: string;
  path?: string;
}

interface AssistDecisionSummary {
  outcome: AssistDecisionOutcome;
  reasonCode: AssistDecisionReasonCode;
  decidedAt: string;
  selectedAgentRole: AssistDecisionAgentRole | null;
  affectedArtifactRefs: AssistDecisionArtifactRef[];
  repairBudgetSnapshot: StoredRepairBudget | null;
  assistBudgetSnapshot: StoredAssistBudget | null;
  modelInvocationBudgetSnapshot: StoredModelInvocationBudget | null;
  rationale: string | null;
}

interface SanitizedRepairAttempt {
  attemptNumber: number;
  repairDecision: string;
  failureCategory: string | null;
  hasModelInvocation: boolean;
  hasRepairInput: boolean;
  hasJavaCandidate: boolean;
  rationale?: string;
}

export type AssistDecisionOutcome = "assist_required" | "assist_not_required";
export type AssistDecisionReasonCode =
  | "semantic_ir_bounded_ambiguity"
  | "translation_unsupported_repairable"
  | "baseline_open_assumptions"
  | "deterministic_candidate_low_confidence"
  | "caller_explicit_opt_in"
  | "caller_did_not_opt_in"
  | "assist_budget_exhausted";
export type AssistDecisionAgentRole = "transformation_agent";

const JAVA_ORIGIN_CLASSES = new Set<string>([
  "deterministic",
  "agent_proposed",
  "repair_attempted",
  "manual_modified",
  "manual_edit",
]);

const JAVA_VERIFICATION_OUTCOMES = new Set<string>([
  "oracle_passed",
  "oracle_failed",
  "no_oracle",
]);

const JAVA_MAPPING_CLASSES = new Set<string>([
  "direct",
  "aggregated",
  "synthesized",
  "agent_originated",
]);

const FINAL_CLASSIFICATIONS_SET: ReadonlySet<RunFinalClassification> = new Set([
  "success",
  "blocked",
  "failed",
  "cancelled",
  "incomplete",
]);

const REPAIR_DECISION_SET = new Set([
  "propose_candidate",
  "refuse",
  "escalate",
  "no_change",
]);

const ASSIST_DECISION_OUTCOMES: ReadonlySet<AssistDecisionOutcome> = new Set([
  "assist_required",
  "assist_not_required",
]);
const ASSIST_DECISION_REASONS: ReadonlySet<AssistDecisionReasonCode> = new Set([
  "semantic_ir_bounded_ambiguity",
  "translation_unsupported_repairable",
  "baseline_open_assumptions",
  "deterministic_candidate_low_confidence",
  "caller_explicit_opt_in",
  "caller_did_not_opt_in",
  "assist_budget_exhausted",
]);
const ASSIST_DECISION_AGENT_ROLES: ReadonlySet<AssistDecisionAgentRole> =
  new Set(["transformation_agent"]);

export const EMPTY_WORKFLOW_SNAPSHOT: WorkflowSnapshot = {
  state: null,
  activeStep: null,
  activeAgent: null,
  agentAttemptCount: 0,
  repairBudget: null,
  assistBudget: null,
  modelInvocationBudget: null,
  repairAttempts: [],
  assistDecision: null,
  finalClassification: null,
  failureCode: null,
  failureMessage: null,
  manualEditsCarriedOver: false,
  manualDriftRegionCount: 0,
  generatedJavaRef: null,
  buildTestResultRef: null,
  evidencePackRef: null,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};

  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseBooleanString(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function isSafeGeneratedRelpath(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.includes("\0")) return false;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) return false;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function isSafeClassificationMapKey(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

export function productModeOf(stored: StoredRun): "live" | "unavailable" {
  return stored.mode === "live" ? "live" : "unavailable";
}

export function runSummary(stored: StoredRun): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    schemaVersion: "v0",
    runId: stored.runId,
    programId: stored.programId,
    status: stored.status,
    mode: stored.mode,
    productMode: productModeOf(stored),
    message: stored.message,
    policyDecision: stored.policyDecision,
    evidenceRefs: [],
    orchestratorRunId: stored.liveRunId ?? "",
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    activeStep: stored.activeStep ?? null,
    agentAttemptCount: stored.agentAttemptCount ?? 0,
    repairBudget: stored.repairBudget ?? null,
    assistBudget: stored.assistBudget ?? null,
    modelInvocationBudget: stored.modelInvocationBudget ?? null,
    finalClassification: stored.finalClassification ?? null,
    failureCode: stored.failureCode ?? null,
    failureMessage: stored.failureMessage ?? null,
    manualEditsCarriedOver: stored.manualEditsCarriedOver === true,
    manualDriftRegionCount:
      typeof stored.manualDriftRegionCount === "number" &&
      Number.isInteger(stored.manualDriftRegionCount) &&
      stored.manualDriftRegionCount >= 0
        ? stored.manualDriftRegionCount
        : 0,
    javaRegionClassification: normalizeJavaRegionClassification(
      stored.javaRegionClassification,
    ),
  };
  return summary;
}

export function runLinks(runId: string): Record<string, string> {
  return {
    self: `/api/v0/runs/${runId}`,
    generated: `/api/v0/runs/${runId}/generated`,
    generatedFiles: `/api/v0/runs/${runId}/generated/files`,
    buildTest: `/api/v0/runs/${runId}/build-test`,
    evidence: `/api/v0/runs/${runId}/evidence`,
    artifacts: `/api/v0/runs/${runId}/artifacts`,
    progress: `/api/v0/runs/${runId}/progress`,
    learning: `/api/v0/runs/${runId}/learning`,
    experience: `/api/v0/runs/${runId}/experience`,
    workflow: `/api/v0/runs/${runId}/workflow`,
    traceability: `/api/v0/runs/${runId}/traceability`,
  };
}

export function normalizeRequestJavaFilePath(raw: string): string {
  return raw.replace(/\\/g, "/");
}

export function isSafeRequestJavaFilePath(raw: string): boolean {
  const normalized = normalizeRequestJavaFilePath(raw);
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return false;
  return isSafeGeneratedRelpath(normalized);
}

export function transformLinks(runId: string): Record<string, string> {
  return {
    ...runLinks(runId),
    events: `/api/v0/runs/${runId}/events`,
  };
}

export function transformResponse(stored: StoredRun): Record<string, unknown> {
  return {
    ...runSummary(stored),
    links: transformLinks(stored.runId),
  };
}

export function createSourceTextSample(
  programId: string,
  sourceText: string,
  sourceName?: string,
): SampleDetail {
  return {
    programId,
    title: sourceName
      ? `Transform run from ${sourceName}`
      : `Transform run for ${programId}`,
    description: "Synthetic sample created from source text",
    knownDivergenceAtW0: false,
    supportedInProductMode: true,
    w0Subset: [],
    oracleMode: null,
    knownLimitations: [],
    cobolSource: sourceText,
    cobolSourcePath: `transforms/${programId}.cbl`,
    expectedOutput: "",
    expectedOutputPath: "",
  };
}

export function extractProgramIdFromSourceText(sourceText: string): string {
  const match = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i.exec(sourceText);
  if (match?.[1]) {
    return match[1].toUpperCase();
  }
  const digest = createHash("sha256")
    .update(sourceText, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `SRC-${digest}`;
}

export function resolveTransformProgramId(
  sourceText: string,
  requestedProgramId?: string,
): string {
  if (
    typeof requestedProgramId === "string" &&
    requestedProgramId.trim().length > 0
  ) {
    return requestedProgramId.trim();
  }
  return extractProgramIdFromSourceText(sourceText);
}

export function diagnosticFixtureGeneratedView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    ...stored.fixture.generated,
    files: {},
    fileCount: Object.keys(stored.fixture.generated.files).length,
    fileRefs: Object.keys(stored.fixture.generated.files).map((path) => ({
      path,
    })),
    note: `${stored.fixture.generated.note} Generated source content is intentionally available only through the capped generated-file endpoint in product mode.`,
  };
}

export function diagnosticFixtureBuildTestView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    expectedOutput: stored.sample.expectedOutput,
    ...stored.fixture.buildTest,
  };
}

export function diagnosticFixtureEvidenceView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    ...stored.fixture.evidence,
  };
}

export function liveArtifactRunId(stored: StoredRun): string | undefined {
  return stored.liveRunId && stored.liveRunId.length > 0
    ? stored.liveRunId
    : undefined;
}

export function incompleteEnvelope(
  stored: StoredRun,
  missing: string[],
  note: string,
): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
    status: "incomplete",
    missingArtifacts: missing,
    note,
  };
}

export function normalizeExperienceViewFromSummary(
  stored: StoredRun,
  learningView: Record<string, unknown>,
  summaryRaw: Record<string, unknown>,
): Record<string, unknown> {
  const candidateCount = asNumber(summaryRaw.candidateCount) ?? 0;
  const sourceEventCount = asNumber(summaryRaw.sourceEventCount);
  const sourceLedgerCount = asNumber(summaryRaw.sourceLedgerCount);
  const observedPatterns = asStringArray(summaryRaw.observedPatterns);
  const experienceEventIds = asStringArray(summaryRaw.experienceEventIds);
  const candidateByPattern = asRecord(summaryRaw.candidateByPattern) ?? {};
  const patternBreakdown = Object.entries(candidateByPattern)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    .map(([pattern, count]) => `${pattern}: ${count}`);
  const observationOnly = asBoolean(summaryRaw.observationOnly) ?? false;
  const policyVersion = asString(summaryRaw.policyVersion);
  const policyFingerprint = asString(summaryRaw.policyFingerprint);
  const learningSignals = normalizeLearningSignals(summaryRaw.signals);

  const summaryParts = [
    `${candidateCount} learning candidate${candidateCount === 1 ? "" : "s"} observed`,
    sourceEventCount !== undefined
      ? `from ${sourceEventCount} source events`
      : "",
    sourceLedgerCount !== undefined
      ? `${sourceLedgerCount} source ledgers considered`
      : "",
    observationOnly ? "observation-only mode" : "",
  ].filter((part) => part.length > 0);

  const observationPolicy = [policyVersion, policyFingerprint]
    .filter((part) => part.length > 0)
    .join(" / ");

  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: learningView.mode,
    productMode: learningView.productMode,
    summary: summaryParts.join(" • "),
    observationPolicy,
    learningSignals,
    detectedPatterns: [...observedPatterns, ...patternBreakdown],
    artifactRefs: experienceEventIds,
  };
}

export function normalizeLearningSignals(
  raw: unknown,
): Array<Record<string, unknown>> {
  const signals: Array<Record<string, unknown>> = [];
  if (!Array.isArray(raw)) return signals;
  for (const entry of raw) {
    const item = asRecord(entry);
    if (!item) continue;
    const key = asString(item.key);
    const label = asString(item.label);
    const status = asString(item.status);
    if (!key || !label || !status) continue;
    signals.push({
      key,
      label,
      status,
      summary: asString(item.summary),
      count: asNumber(item.count) ?? 0,
      evidenceRefs: asStringArray(item.evidenceRefs),
    });
  }
  return signals;
}

export function normalizeOutputRef(raw: unknown): OutputRef | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  const ref: OutputRef = {
    sha256,
  };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  for (const key of [
    "kind",
    "path",
    "name",
    "mimeType",
    "createdBy",
    "createdAt",
  ] as const) {
    const value = asString(record[key]);
    if (value.length > 0) ref[key] = value;
  }
  return ref;
}

function normalizeGeneratedFileRef(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const path = asString(record.path);
  if (!isSafeGeneratedRelpath(path)) return null;
  const ref: Record<string, unknown> = { path };
  for (const key of ["sha256", "mimeType", "kind", "name"] as const) {
    const value = asString(record[key]);
    if (value.length > 0) ref[key] = value;
  }
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  return ref;
}

export function normalizeGeneratedFileRefs(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeGeneratedFileRef(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export function normalizeRunArtifact(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  const artifact: Record<string, unknown> = { sha256 };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) artifact.byteSize = byteSize;
  for (const key of [
    "kind",
    "name",
    "mimeType",
    "createdBy",
    "createdAt",
  ] as const) {
    const value = asString(record[key]);
    if (value.length > 0) artifact[key] = value;
  }
  const path = asString(record.path);
  if (path.length > 0 && isSafeGeneratedRelpath(path)) {
    artifact.path = path;
  }
  return artifact;
}

export type GeneratedStatus =
  | "generated"
  | "unsupported"
  | "skipped"
  | "incomplete";

export function classifyGeneratedStatus(
  missing: string[],
  runStatus: string | undefined,
): GeneratedStatus {
  if (missing.length === 0) return "generated";
  if (runStatus === "failed") return "unsupported";
  return "skipped";
}

export function classifyBuildTestStatus(
  missing: string[],
  runStatus: string | undefined,
  data: Record<string, unknown> | undefined,
): {
  status:
    | "ok"
    | "compile-failed"
    | "run-failed"
    | "output-divergence"
    | "golden-master-reproduction-failed"
    | "missing-golden-master"
    | "skipped";
  classification:
    | "match"
    | "divergence-known-w0-coverage-gap"
    | "divergence-unknown"
    | "true-golden-master-reproduction-error"
    | "true-golden-master-mismatch"
    | "compile-error"
    | "run-error"
    | "skipped-no-execution";
} {
  if (missing.length > 0) {
    return runStatus === "failed"
      ? { status: "run-failed", classification: "run-error" }
      : { status: "skipped", classification: "skipped-no-execution" };
  }
  const upstreamStatus = typeof data?.status === "string" ? data.status : "";
  const upstreamClassification =
    typeof data?.classification === "string" ? data.classification : "";
  const allowedStatus = new Set([
    "ok",
    "compile-failed",
    "run-failed",
    "output-divergence",
    "golden-master-reproduction-failed",
    "missing-golden-master",
    "skipped",
  ]);
  const allowedClassification = new Set([
    "match",
    "divergence-known-w0-coverage-gap",
    "divergence-unknown",
    "true-golden-master-reproduction-error",
    "true-golden-master-mismatch",
    "compile-error",
    "run-error",
    "skipped-no-execution",
  ]);
  const status = allowedStatus.has(upstreamStatus)
    ? (upstreamStatus as "ok")
    : "ok";
  const classification = allowedClassification.has(upstreamClassification)
    ? (upstreamClassification as "match")
    : "match";
  return { status, classification };
}

function deriveCompileStatus(
  data: Record<string, unknown> | undefined,
  status: string,
): "ok" | "failed" | "skipped" | "unknown" {
  const build = asRecord(data?.build);
  if (build && typeof build.compileOk === "boolean") {
    return build.compileOk ? "ok" : "failed";
  }
  if (status === "compile-failed") return "failed";
  if (status === "skipped") return "skipped";
  return "unknown";
}

function deriveExecutionStatus(
  data: Record<string, unknown> | undefined,
  status: string,
): "ok" | "failed" | "skipped" | "not-run" | "unknown" {
  const execution = asRecord(data?.execution);
  if (execution) {
    if (execution.ran === false) {
      return status === "skipped" ? "skipped" : "not-run";
    }
    if (typeof execution.ok === "boolean") return execution.ok ? "ok" : "failed";
  }
  if (status === "run-failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "compile-failed") return "not-run";
  return "unknown";
}

function deriveActualOutput(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  if (typeof data.actualOutput === "string") return data.actualOutput;
  const execution = asRecord(data.execution);
  if (execution && typeof execution.stdout === "string") return execution.stdout;
  return "";
}

function deriveExpectedOutput(
  data: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!data) return fallback;
  if (typeof data.expectedOutput === "string") return data.expectedOutput;
  const golden = asRecord(data.goldenMaster);
  if (golden && typeof golden.expected === "string") return golden.expected;
  const comparison = asRecord(data.comparison);
  if (comparison && typeof comparison.expected === "string")
    return comparison.expected;
  return fallback;
}

export function deriveComparisonOutputRef(
  data: Record<string, unknown> | undefined,
  field: "expectedRef" | "actualRef",
): OutputRef | null {
  const comparison = asRecord(data?.comparison);
  return comparison ? normalizeOutputRef(comparison[field]) : null;
}

export function deriveValidationStatus(
  data: Record<string, unknown> | undefined,
): "valid" | "invalid" | "incomplete" | "unknown" {
  if (!data) return "unknown";
  const validation = asRecord(data.validation);
  if (validation) {
    const validationStatus = asString(validation.status);
    if (validationStatus === "valid") return "valid";
    if (validationStatus === "invalid") return "invalid";
    if (validationStatus === "incomplete") return "incomplete";
    const missing = Array.isArray(validation.missingArtifacts)
      ? validation.missingArtifacts
      : [];
    if (missing.length > 0) return "incomplete";
    return "valid";
  }
  const manifestStatus = asString(data.status);
  if (manifestStatus === "complete") return "valid";
  if (manifestStatus === "invalid") return "invalid";
  if (manifestStatus === "incomplete") return "incomplete";
  return "unknown";
}

export function deriveExportRef(
  data: Record<string, unknown> | undefined,
): OutputRef | null {
  if (!data) return null;
  const exports = data.exports;
  if (!Array.isArray(exports) || exports.length === 0) return null;
  for (const entry of exports) {
    const record = asRecord(entry);
    if (!record) continue;
    const ref = normalizeOutputRef(record);
    if (ref) return ref;
  }
  return null;
}

export function deriveMissingFromValidation(
  data: Record<string, unknown> | undefined,
): string[] {
  if (!data) return [];
  const validation = asRecord(data.validation);
  if (!validation) return [];
  const raw = validation.missingArtifacts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

interface ManualEditOverlayView {
  uri: string;
  sha256: string;
  byteSize?: number;
  mimeType?: string;
  kind?: string;
  schemaVersion?: "v0";
  regionCount: number;
}

export function deriveManualEditOverlayRef(
  data: Record<string, unknown> | undefined,
): ManualEditOverlayView | null {
  if (!data) return null;
  const artifacts = asRecord(data.artifacts);
  if (!artifacts) return null;
  const overlayRaw = artifacts.manualEditOverlay;
  if (overlayRaw === null || overlayRaw === undefined) return null;
  const record = asRecord(overlayRaw);
  if (!record) return null;
  const uri = asString(record.uri);
  const sha256 = asString(record.sha256);
  if (uri.length === 0 || sha256.length === 0) return null;
  const view: ManualEditOverlayView = {
    uri,
    sha256,
    regionCount: 0,
  };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) view.byteSize = byteSize;
  const mimeType = asString(record.mimeType);
  if (mimeType.length > 0) view.mimeType = mimeType;
  const kind = asString(record.kind);
  if (kind.length > 0) view.kind = kind;
  const schemaVersion = asString(record.schemaVersion);
  if (schemaVersion === "v0") view.schemaVersion = "v0";
  const regionCount = asNumber(record.regionCount);
  if (
    regionCount !== undefined &&
    Number.isInteger(regionCount) &&
    regionCount >= 0
  ) {
    view.regionCount = regionCount;
  }
  return view;
}

export function normalizeGeneratedTraceability(
  raw: unknown,
): {
  schemaVersion: "v0";
  programId: string;
  irId: string;
  sourceHash: string;
} | undefined {
  const traceability = asRecord(raw);
  if (!traceability) return undefined;
  const programId = asString(traceability.programId);
  const irId = asString(traceability.irId);
  const sourceHash = asString(traceability.sourceHash);
  if (!programId || !irId || !sourceHash) return undefined;
  return {
    schemaVersion: "v0",
    programId,
    irId,
    sourceHash,
  };
}

export function normalizeJavaRegionClassification(
  raw: unknown,
): Record<string, JavaRegionClassification[]> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const jrcRecord = asRecord(raw) ?? {};
  const result: Record<string, JavaRegionClassification[]> = {};
  for (const [file, arr] of Object.entries(jrcRecord)) {
    if (!isSafeClassificationMapKey(file)) continue;
    if (!Array.isArray(arr)) continue;
    const valid: JavaRegionClassification[] = [];
    for (const entry of arr) {
      const e = asRecord(entry);
      if (!e) continue;
      const lr = asRecord(e.lineRange);
      if (!lr) continue;
      const startLine = asNumber(lr.startLine);
      const endLine = asNumber(lr.endLine);
      const originClass = asString(e.originClass);
      const verificationOutcome = asString(e.verificationOutcome);
      const mappingClass = asString(e.mappingClass);
      if (
        startLine !== undefined &&
        Number.isInteger(startLine) &&
        startLine > 0 &&
        endLine !== undefined &&
        Number.isInteger(endLine) &&
        endLine >= startLine &&
        JAVA_ORIGIN_CLASSES.has(originClass) &&
        JAVA_VERIFICATION_OUTCOMES.has(verificationOutcome) &&
        JAVA_MAPPING_CLASSES.has(mappingClass)
      ) {
        valid.push({
          schemaVersion: "v0",
          lineRange: { startLine, endLine },
          originClass: originClass as JavaOriginClass,
          verificationOutcome: verificationOutcome as JavaVerificationOutcome,
          mappingClass: mappingClass as JavaMappingClass,
        });
      }
    }
    if (valid.length > 0) {
      result[file] = valid;
    }
  }
  return result;
}

export function normalizePipelineStep(raw: unknown): PipelineStep | null {
  const record = asRecord(raw);
  if (!record) return null;
  const name = asString(record.name);
  if (!name) return null;
  const stepId = asNumber(record.stepId) ?? 0;
  const inputRef = normalizeOutputRef(record.inputRef);
  const outputRef = normalizeOutputRef(record.outputRef);
  const step: PipelineStep = {
    stepId,
    name,
    capabilityId: asString(record.capabilityId),
    service: asString(record.service),
    actor: asString(record.actor),
    status: asPipelineStepStatus(record.status),
  };
  const startedAt = asString(record.startedAt);
  if (startedAt) step.startedAt = startedAt;
  const finishedAt = asString(record.finishedAt);
  if (finishedAt) step.finishedAt = finishedAt;
  const diagnostic = asString(record.diagnostic);
  if (diagnostic) {
    step.diagnostic = sanitizeProgressDiagnostic(diagnostic, step.status);
  }
  if (inputRef) step.inputRef = inputRef;
  if (outputRef) step.outputRef = outputRef;
  const latency = asNumber(record.latencyMs);
  if (latency !== undefined) step.latencyMs = latency;
  return step;
}

export function sanitizeUiRunEvent(raw: unknown): UiRunEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const event: UiRunEvent = {};
  const type = asString(record.type);
  if (type) event.type = type;
  const status = asString(record.status);
  if (status) event.status = status;
  const message = asString(record.message);
  if (message) {
    const safeMessage = sanitizeUpstreamMessage(message, "");
    if (safeMessage) event.message = safeMessage;
  }
  const createdAt = asString(record.createdAt);
  if (createdAt) event.createdAt = createdAt;
  return Object.keys(event).length > 0 ? event : null;
}

interface UiRunEvent {
  type?: string;
  status?: string;
  message?: string;
  createdAt?: string;
}

function asPipelineStepStatus(value: unknown): PipelineStepStatus {
  if (typeof value === "string") {
    for (const candidate of PIPELINE_STEP_STATUSES) {
      if (candidate === value) return candidate;
    }
  }
  return "pending";
}

const PIPELINE_STEP_STATUSES: ReadonlyArray<PipelineStepStatus> = [
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
];

const FAILED_STEP_DIAGNOSTIC_FALLBACK =
  "Step failed. See workflow failure details for the classified reason.";
const SKIPPED_STEP_DIAGNOSTIC_FALLBACK = "Step skipped by workflow policy.";
const UNSAFE_PROGRESS_DIAGNOSTIC_PATTERNS: ReadonlyArray<RegExp> = [
  /["']?(sourceText|expectedOutput|oracleInput|baselineFiles|previousJavaFiles|buildTestPayload|inputRef|outputRef)["']?\s*:/i,
  /\bIDENTIFICATION\s+DIVISION\b/i,
  /\bPROCEDURE\s+DIVISION\b/i,
  /\bpublic\s+class\b/i,
];

function sanitizeProgressDiagnostic(
  diagnostic: string,
  status: PipelineStepStatus,
): string {
  if (status === "skipped") return SKIPPED_STEP_DIAGNOSTIC_FALLBACK;
  const fallback =
    status === "failed"
      ? FAILED_STEP_DIAGNOSTIC_FALLBACK
      : "Step diagnostic unavailable.";
  const sanitized = sanitizeUpstreamMessage(diagnostic, fallback);
  if (status !== "failed") return sanitized;
  if (sanitized === fallback) return fallback;
  if (
    UNSAFE_PROGRESS_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(sanitized))
  ) {
    return fallback;
  }
  return sanitized;
}

interface PipelineStep {
  stepId: number;
  name: string;
  capabilityId: string;
  service: string;
  actor: string;
  status: PipelineStepStatus;
  startedAt?: string;
  finishedAt?: string;
  diagnostic?: string;
  inputRef?: OutputRef | null;
  outputRef?: OutputRef | null;
  latencyMs?: number;
}

type PipelineStepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

function safeArtifactRef(
  value: unknown,
): { sha256: string; byteSize: number; kind: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  return {
    sha256,
    byteSize: asNumber(record.byteSize) ?? 0,
    kind: asString(record.kind),
  };
}

function asFinalClassification(value: unknown): RunFinalClassification | null {
  if (typeof value !== "string") return null;
  if (FINAL_CLASSIFICATIONS_SET.has(value as RunFinalClassification)) {
    return value as RunFinalClassification;
  }
  return null;
}

function asRepairBudget(value: unknown): StoredRepairBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

function asAssistBudget(value: unknown): StoredAssistBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

function asModelInvocationBudget(
  value: unknown,
): StoredModelInvocationBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

function deriveActiveAgent(activeStep: string | null): string | null {
  if (!activeStep) return null;
  const normalized = activeStep.replace(/_/g, "-").toLowerCase();
  if (normalized.includes("transformation-agent")) return "transformation_agent";
  if (
    normalized.includes("verification-repair-agent") ||
    normalized.includes("verification-repair")
  ) {
    return "verification_repair_agent";
  }
  if (normalized.includes("parse-cobol") || normalized.includes("cobol-parser"))
    return "cobol_parser";
  if (normalized.includes("semantic-ir")) return "semantic_ir";
  if (
    normalized.includes("generate-java") ||
    normalized.includes("java-generation")
  )
    return "java_generator";
  if (normalized.includes("compile-test") || normalized.includes("build-test"))
    return "build_test_runner";
  if (normalized.includes("write-evidence") || normalized.includes("evidence"))
    return "evidence_service";
  return null;
}

function sanitizeRepairAttempts(raw: unknown): SanitizedRepairAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedRepairAttempt[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const attemptNumber = asNumber(record.attemptNumber);
    if (attemptNumber === undefined || attemptNumber < 1) continue;
    const decisionRaw = asString(record.repairDecision);
    if (!REPAIR_DECISION_SET.has(decisionRaw)) continue;
    const failureCategoryRaw = asString(record.failureCategory);
    const sanitized: SanitizedRepairAttempt = {
      attemptNumber,
      repairDecision: decisionRaw,
      failureCategory:
        failureCategoryRaw.length > 0 ? failureCategoryRaw : null,
      hasModelInvocation: asRecord(record.modelInvocationRef) !== undefined,
      hasRepairInput: asRecord(record.repairInputRef) !== undefined,
      hasJavaCandidate: asRecord(record.javaCandidateRef) !== undefined,
    };
    const rationaleRaw = record.rationale;
    if (typeof rationaleRaw === "string" && rationaleRaw.length > 0) {
      sanitized.rationale = sanitizeUpstreamMessage(rationaleRaw, "");
    }
    out.push(sanitized);
  }
  return out;
}

function sanitizeAssistArtifactRef(
  value: unknown,
): AssistDecisionArtifactRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref: AssistDecisionArtifactRef = {};
  const sha = asString(record.sha256);
  if (sha) ref.sha256 = sha;
  const byteSize = asNumber(record.byteSize);
  if (typeof byteSize === "number" && byteSize >= 0) ref.byteSize = byteSize;
  const kind = asString(record.kind);
  if (kind) ref.kind = kind;
  const refPath = asString(record.path);
  if (refPath) ref.path = refPath;
  return Object.keys(ref).length > 0 ? ref : null;
}

function sanitizeAssistDecision(value: unknown): AssistDecisionSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  const outcome = asString(record.outcome) as AssistDecisionOutcome | "";
  if (!outcome || !ASSIST_DECISION_OUTCOMES.has(outcome)) return null;
  const reasonCode = asString(record.reasonCode) as AssistDecisionReasonCode | "";
  if (!reasonCode || !ASSIST_DECISION_REASONS.has(reasonCode)) return null;
  const decidedAt = asString(record.decidedAt) || "";
  if (!decidedAt) return null;
  const rawRole = asString(record.selectedAgentRole);
  const selectedAgentRole: AssistDecisionAgentRole | null =
    rawRole &&
    ASSIST_DECISION_AGENT_ROLES.has(rawRole as AssistDecisionAgentRole)
      ? (rawRole as AssistDecisionAgentRole)
      : null;
  if (outcome === "assist_required" && selectedAgentRole === null) return null;
  if (outcome === "assist_not_required" && selectedAgentRole !== null)
    return null;
  const affected: AssistDecisionArtifactRef[] = [];
  if (Array.isArray(record.affectedArtifactRefs)) {
    for (const entry of record.affectedArtifactRefs) {
      const sanitized = sanitizeAssistArtifactRef(entry);
      if (sanitized) affected.push(sanitized);
    }
  }
  const repairBudgetSnapshot = asRepairBudget(record.repairBudgetSnapshot);
  const assistBudgetSnapshot = asAssistBudget(record.assistBudgetSnapshot);
  const modelInvocationBudgetSnapshot = asModelInvocationBudget(
    record.modelInvocationBudgetSnapshot,
  );
  const rationale = asString(record.rationale) || null;
  return {
    outcome,
    reasonCode,
    decidedAt,
    selectedAgentRole,
    affectedArtifactRefs: affected,
    repairBudgetSnapshot,
    assistBudgetSnapshot,
    modelInvocationBudgetSnapshot,
    rationale,
  };
}

export function snapshotFromContract(
  contract: Record<string, unknown> | undefined,
): WorkflowSnapshot {
  if (!contract) return { ...EMPTY_WORKFLOW_SNAPSHOT };
  const state = asString(contract.currentState) || null;
  const activeStep = asString(contract.activeStep) || null;
  const agentAttemptCount = asNumber(contract.agentAttemptCount) ?? 0;
  const repairBudget = asRepairBudget(contract.repairBudget);
  const assistBudget = asAssistBudget(contract.assistBudget);
  const modelInvocationBudget = asModelInvocationBudget(
    contract.modelInvocationBudget,
  );
  const repairAttempts = sanitizeRepairAttempts(contract.repairAttempts);
  const assistDecision = sanitizeAssistDecision(contract.assistDecision);
  const finalClassification = asFinalClassification(contract.finalClassification);
  const rawFailureCode = contract.failureCode;
  const rawFailureMessage = contract.failureMessage;
  let failureCode: W02UiErrorCode | null = null;
  let failureMessage: string | null = null;
  const mapped = mapFailure(rawFailureCode, rawFailureMessage);
  if (mapped !== null) {
    failureCode = mapped.code;
    failureMessage = mapped.message;
  } else if (
    finalClassification &&
    finalClassification !== "success" &&
    finalClassification !== "incomplete"
  ) {
    failureCode = "internal_error";
    failureMessage = sanitizeUpstreamMessage(
      rawFailureMessage,
      defaultMessageFor("internal_error"),
    );
  }
  const manualDriftRegionCountRaw = asNumber(contract.manualDriftRegionCount);
  const manualDriftRegionCount =
    manualDriftRegionCountRaw !== undefined &&
    Number.isInteger(manualDriftRegionCountRaw) &&
    manualDriftRegionCountRaw >= 0
      ? manualDriftRegionCountRaw
      : 0;
  const manualEditsCarriedOver =
    contract.manualEditsCarriedOver === true && manualDriftRegionCount > 0;
  const normalizedManualDriftRegionCount = manualEditsCarriedOver
    ? manualDriftRegionCount
    : 0;
  return {
    state,
    activeStep,
    activeAgent: deriveActiveAgent(activeStep),
    agentAttemptCount,
    repairBudget,
    assistBudget,
    modelInvocationBudget,
    repairAttempts,
    assistDecision,
    finalClassification,
    failureCode,
    failureMessage,
    manualEditsCarriedOver,
    manualDriftRegionCount: normalizedManualDriftRegionCount,
    generatedJavaRef: safeArtifactRef(contract.generatedJavaRef),
    buildTestResultRef: safeArtifactRef(contract.buildTestResultRef),
    evidencePackRef: safeArtifactRef(contract.evidencePackRef),
  };
}

export function workflowEnvelope(
  stored: StoredRun,
  snapshot: WorkflowSnapshot,
  source: "live" | "cached" | "unavailable",
): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
    source,
    state: snapshot.state,
    activeStep: snapshot.activeStep,
    activeAgent: snapshot.activeAgent,
    agentAttemptCount: snapshot.agentAttemptCount,
    repairBudget: snapshot.repairBudget,
    assistBudget: snapshot.assistBudget,
    modelInvocationBudget: snapshot.modelInvocationBudget,
    repairAttempts: snapshot.repairAttempts,
    assistDecision: snapshot.assistDecision,
    finalClassification: snapshot.finalClassification,
    failureCode: snapshot.failureCode,
    failureMessage: snapshot.failureMessage,
    manualEditsCarriedOver: snapshot.manualEditsCarriedOver,
    manualDriftRegionCount: snapshot.manualDriftRegionCount,
    generatedJavaRef: snapshot.generatedJavaRef,
    buildTestResultRef: snapshot.buildTestResultRef,
    evidencePackRef: snapshot.evidencePackRef,
  };
}
