import { 
  ApiErrorDetails, 
  ApiResult, 
  HealthResponse, 
  ModeResponse,
  TransformResponse,
  RunLinks,
  RunSummary,
  GeneratedView,
  GeneratedFileRef,
  GeneratedFilesIndex,
  BuildTestView,
  EvidenceView,
  OutputRef,
  RunEventsView,
  RunProgressStep,
  RunProgressView,
  RunArtifactsView,
  RunEvent,
  RunArtifactMetadata,
  GeneratedFileContent,
  RunWorkflowView,
  RepairAttemptSummary,
  RepairBudget,
  WorkflowArtifactRef,
  W02UiErrorCode,
  W02ActiveAgent,
  W02RepairDecision,
  RunFinalClassification,
} from '../types/api';
import { TransformRequest } from '../types/transform-request';

const LOCAL_OVERRIDE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function createFailure<T>(message: string, details: ApiErrorDetails, status?: number): ApiResult<T> {
  return { ok: false, status, message, details } as ApiResult<T>;
}

export function resolveApiBaseUrl(envValue = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL): ApiResult<string> {
  if (!envValue) {
    return { ok: true, data: '' };
  }

  let parsed: URL;
  try {
    parsed = new URL(envValue);
  } catch (cause) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must be an absolute URL.',
      { kind: 'config', cause },
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must use http or https.',
      { kind: 'config', cause: parsed.protocol },
    );
  }

  if (!LOCAL_OVERRIDE_HOSTS.has(parsed.hostname)) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL is limited to local split-server development.',
      { kind: 'config', cause: parsed.hostname },
    );
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must not include a path, query, or hash.',
      { kind: 'config', cause: envValue },
    );
  }

  return { ok: true, data: parsed.origin };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRunStatus(value: unknown): value is RunSummary['status'] {
  return value === 'starting' || value === 'updating' || value === 'completed' || value === 'failed';
}

function isTransformStatus(value: unknown): value is TransformResponse['status'] {
  return isRunStatus(value);
}

function isRunMode(value: unknown): value is RunSummary['mode'] {
  return value === 'live' || value === 'diagnostic-fixture';
}

function isRunProductMode(value: unknown): value is RunSummary['productMode'] {
  return value === 'live' || value === 'unavailable';
}

function isRunLinks(payload: unknown): payload is RunLinks {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.self) &&
    isString(payload.generated) &&
    isString(payload.generatedFiles) &&
    isString(payload.buildTest) &&
    isString(payload.evidence) &&
    (payload.progress === undefined || isString(payload.progress)) &&
    isString(payload.events) &&
    isString(payload.artifacts) &&
    (payload.learning === undefined || isString(payload.learning)) &&
    (payload.experience === undefined || isString(payload.experience)) &&
    // Issue #172: W0.2 workflow contract endpoint may be absent for legacy
    // diagnostic-fixture responses, present for every live run.
    (payload.workflow === undefined || isString(payload.workflow))
  );
}

function isRunArtifactMetadata(payload: unknown): payload is RunArtifactMetadata {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.sha256) &&
    isNonNegativeInteger(payload.byteSize) &&
    isString(payload.mimeType) &&
    isString(payload.kind) &&
    isString(payload.createdBy) &&
    isString(payload.createdAt) &&
    isString(payload.path) &&
    isString(payload.name)
  );
}

function isOutputRef(payload: unknown): payload is OutputRef {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.sha256) &&
    (payload.byteSize === undefined || isNonNegativeInteger(payload.byteSize)) &&
    (payload.kind === undefined || isString(payload.kind)) &&
    (payload.path === undefined || isString(payload.path)) &&
    (payload.name === undefined || isString(payload.name)) &&
    (payload.mimeType === undefined || isString(payload.mimeType)) &&
    (payload.createdBy === undefined || isString(payload.createdBy)) &&
    (payload.createdAt === undefined || isString(payload.createdAt))
  );
}

function isGeneratedFileRef(payload: unknown): payload is GeneratedFileRef {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.path) &&
    (payload.sha256 === undefined || isString(payload.sha256)) &&
    (payload.byteSize === undefined || isNonNegativeInteger(payload.byteSize)) &&
    (payload.mimeType === undefined || isString(payload.mimeType)) &&
    (payload.kind === undefined || isString(payload.kind)) &&
    (payload.name === undefined || isString(payload.name))
  );
}

function isGeneratedViewStatus(value: unknown): value is GeneratedView['status'] {
  return value === 'generated' || value === 'unsupported' || value === 'skipped' || value === 'incomplete';
}

function isGeneratedFilesStatus(value: unknown): value is GeneratedFilesIndex['status'] {
  return value === 'complete' || value === 'incomplete';
}

function isBuildTestStatus(value: unknown): value is BuildTestView['status'] {
  return (
    value === 'ok' ||
    value === 'compile-failed' ||
    value === 'run-failed' ||
    value === 'output-divergence' ||
    value === 'golden-master-reproduction-failed' ||
    value === 'missing-golden-master' ||
    value === 'skipped' ||
    value === 'incomplete'
  );
}

function isBuildTestClassification(value: unknown): value is BuildTestView['classification'] {
  return (
    value === 'match' ||
    value === 'divergence-known-w0-coverage-gap' ||
    value === 'divergence-unknown' ||
    value === 'true-golden-master-reproduction-error' ||
    value === 'true-golden-master-mismatch' ||
    value === 'compile-error' ||
    value === 'run-error' ||
    value === 'skipped-no-execution'
  );
}

function isEvidenceStatus(value: unknown): value is EvidenceView['status'] {
  return value === 'complete' || value === 'incomplete' || value === 'invalid';
}

function isRunEvent(payload: unknown): payload is RunEvent {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    (payload.type === undefined || isString(payload.type)) &&
    (payload.status === undefined || isString(payload.status)) &&
    (payload.message === undefined || isString(payload.message)) &&
    (payload.createdAt === undefined || isString(payload.createdAt))
  );
}

function isRunProgressStepStatus(value: unknown): value is RunProgressStep['status'] {
  return value === 'pending' || value === 'running' || value === 'ok' || value === 'failed' || value === 'skipped';
}

function isRunProgressViewStatus(value: unknown): value is RunProgressView['status'] {
  return value === 'complete' || value === 'incomplete';
}

function isRunProgressStepPayload(payload: unknown): payload is RunProgressStep {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isNonNegativeInteger(payload.stepId) &&
    isString(payload.name) &&
    isString(payload.capabilityId) &&
    isString(payload.service) &&
    isString(payload.actor) &&
    isRunProgressStepStatus(payload.status) &&
    (payload.startedAt === undefined || isString(payload.startedAt)) &&
    (payload.finishedAt === undefined || isString(payload.finishedAt)) &&
    (payload.diagnostic === undefined || isString(payload.diagnostic)) &&
    (payload.inputRef === undefined || payload.inputRef === null || isOutputRef(payload.inputRef)) &&
    (payload.outputRef === undefined || payload.outputRef === null || isOutputRef(payload.outputRef)) &&
    (payload.latencyMs === undefined || isNonNegativeInteger(payload.latencyMs))
  );
}

function isGeneratedViewPayload(payload: unknown): payload is GeneratedView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isGeneratedViewStatus(payload.status) &&
    (payload.entryClass === undefined || isString(payload.entryClass)) &&
    (payload.entryFilePath === undefined || isString(payload.entryFilePath)) &&
    (payload.fileCount === undefined || isNonNegativeInteger(payload.fileCount)) &&
    (payload.fileRefs === undefined || (Array.isArray(payload.fileRefs) && payload.fileRefs.every(isGeneratedFileRef))) &&
    (payload.unsupportedFeatures === undefined || isStringArray(payload.unsupportedFeatures)) &&
    (payload.openAssumptions === undefined || isStringArray(payload.openAssumptions)) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.generationResponseRef === undefined || payload.generationResponseRef === null || isOutputRef(payload.generationResponseRef)) &&
    (payload.artifactRef === null || isOutputRef(payload.artifactRef)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function isGeneratedFilesIndexPayload(payload: unknown): payload is GeneratedFilesIndex {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isGeneratedFilesStatus(payload.status) &&
    Array.isArray(payload.files) &&
    payload.files.every(isGeneratedFileRef) &&
    isNonNegativeInteger(payload.fileCount) &&
    (payload.entryFilePath === undefined || isString(payload.entryFilePath)) &&
    (payload.artifactRef === null || isOutputRef(payload.artifactRef)) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function isGeneratedFileContentPayload(payload: unknown): payload is GeneratedFileContent {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    (payload.programId === undefined || isString(payload.programId)) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isString(payload.path) &&
    isString(payload.content) &&
    isString(payload.sha256) &&
    isNonNegativeInteger(payload.byteSize) &&
    isString(payload.mimeType) &&
    (payload.kind === undefined || isString(payload.kind)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId))
  );
}

function isBuildTestViewPayload(payload: unknown): payload is BuildTestView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isBuildTestStatus(payload.status) &&
    isBuildTestClassification(payload.classification) &&
    (payload.expectedOutput === undefined || isString(payload.expectedOutput)) &&
    (payload.actualOutput === undefined || isString(payload.actualOutput)) &&
    (payload.outputRef === undefined || payload.outputRef === null || isOutputRef(payload.outputRef)) &&
    (payload.expectedOutputRef === undefined || payload.expectedOutputRef === null || isOutputRef(payload.expectedOutputRef)) &&
    (payload.actualOutputRef === undefined || payload.actualOutputRef === null || isOutputRef(payload.actualOutputRef)) &&
    (payload.generatedArtifactRef === null || isOutputRef(payload.generatedArtifactRef)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function isEvidenceViewPayload(payload: unknown): payload is EvidenceView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isEvidenceStatus(payload.status) &&
    (payload.packId === undefined || isString(payload.packId)) &&
    (payload.manifestHash === undefined || isString(payload.manifestHash)) &&
    (payload.validationStatus === undefined || payload.validationStatus === 'valid' || payload.validationStatus === 'invalid' || payload.validationStatus === 'incomplete' || payload.validationStatus === 'unknown') &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.artifactRef === undefined || payload.artifactRef === null || isOutputRef(payload.artifactRef)) &&
    (payload.exportRef === undefined || payload.exportRef === null || isOutputRef(payload.exportRef)) &&
    (payload.generatedArtifactRef === null || isOutputRef(payload.generatedArtifactRef)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function isRunEventsViewPayload(payload: unknown): payload is RunEventsView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    Array.isArray(payload.events) &&
    payload.events.every(isRunEvent)
  );
}

function isRunProgressViewPayload(payload: unknown): payload is RunProgressView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isRunProgressViewStatus(payload.status) &&
    (payload.runStatus === undefined || isRunStatus(payload.runStatus)) &&
    (payload.currentStep === null || isString(payload.currentStep)) &&
    (payload.failedStep === null || isString(payload.failedStep)) &&
    isStringArray(payload.completedSteps) &&
    isNonNegativeInteger(payload.stepCount) &&
    Array.isArray(payload.steps) &&
    payload.steps.every(isRunProgressStepPayload) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.progressRef === undefined || payload.progressRef === null || isRunArtifactMetadata(payload.progressRef)) &&
    (payload.updatedAt === undefined || payload.updatedAt === null || isString(payload.updatedAt)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function isTransformResponsePayload(payload: unknown): payload is TransformResponse {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.orchestratorRunId) &&
    isString(payload.programId) &&
    isTransformStatus(payload.status) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isString(payload.createdAt) &&
    isString(payload.updatedAt) &&
    isRunLinks(payload.links) &&
    (payload.message === undefined || isString(payload.message)) &&
    (payload.evidenceRefs === undefined || isStringArray(payload.evidenceRefs)) &&
    (payload.policyDecision === undefined || isString(payload.policyDecision)) &&
    hasW02ContractFields(payload)
  );
}

// Issue #172: closed enums for the W0.2 surface. Predicates are deliberately
// strict so the Studio refuses to render an unknown failure code, agent, or
// classification rather than silently mis-displaying it.
const W02_UI_ERROR_CODES: ReadonlySet<W02UiErrorCode> = new Set([
  'unsupported_cobol',
  'parse_failed',
  'semantic_ir_failed',
  'model_gateway_unavailable',
  'model_policy_denied',
  'agent_timeout',
  'agent_contract_invalid',
  'java_generation_failed',
  'java_compile_failed',
  'java_runtime_failed',
  'oracle_mismatch',
  'evidence_incomplete',
  'cancelled',
  'service_unavailable',
  'internal_error',
]);

const W02_ACTIVE_AGENTS: ReadonlySet<W02ActiveAgent> = new Set([
  'transformation_agent',
  'verification_repair_agent',
  'cobol_parser',
  'semantic_ir',
  'java_generator',
  'build_test_runner',
  'evidence_service',
]);

const W02_REPAIR_DECISIONS: ReadonlySet<W02RepairDecision> = new Set([
  'propose_candidate',
  'refuse',
  'escalate',
  'no_change',
]);

const W02_FINAL_CLASSIFICATIONS: ReadonlySet<RunFinalClassification> = new Set([
  'success',
  'blocked',
  'failed',
  'cancelled',
  'incomplete',
]);

function isW02UiErrorCode(value: unknown): value is W02UiErrorCode {
  return typeof value === 'string' && W02_UI_ERROR_CODES.has(value as W02UiErrorCode);
}

function isW02ActiveAgent(value: unknown): value is W02ActiveAgent {
  return typeof value === 'string' && W02_ACTIVE_AGENTS.has(value as W02ActiveAgent);
}

function isW02RepairDecision(value: unknown): value is W02RepairDecision {
  return typeof value === 'string' && W02_REPAIR_DECISIONS.has(value as W02RepairDecision);
}

function isRunFinalClassification(value: unknown): value is RunFinalClassification {
  return typeof value === 'string' && W02_FINAL_CLASSIFICATIONS.has(value as RunFinalClassification);
}

function isRepairBudgetPayload(payload: unknown): payload is RepairBudget {
  if (!isRecord(payload)) return false;
  return (
    isNonNegativeInteger(payload.limit) &&
    isNonNegativeInteger(payload.used) &&
    isNonNegativeInteger(payload.remaining)
  );
}

function isRepairAttemptSummaryPayload(payload: unknown): payload is RepairAttemptSummary {
  if (!isRecord(payload)) return false;
  return (
    typeof payload.attemptNumber === 'number' &&
    Number.isInteger(payload.attemptNumber) &&
    payload.attemptNumber >= 1 &&
    isW02RepairDecision(payload.repairDecision) &&
    (payload.failureCategory === null || isString(payload.failureCategory)) &&
    typeof payload.hasModelInvocation === 'boolean' &&
    typeof payload.hasRepairInput === 'boolean' &&
    typeof payload.hasJavaCandidate === 'boolean' &&
    (payload.rationale === undefined || isString(payload.rationale))
  );
}

function isWorkflowArtifactRefPayload(payload: unknown): payload is WorkflowArtifactRef {
  if (!isRecord(payload)) return false;
  return isString(payload.sha256) && isNonNegativeInteger(payload.byteSize) && isString(payload.kind);
}

// W0.2 contract fields validate as ``undefined`` | ``null`` | a typed value.
// The production BFF always emits explicit ``null``/``0`` (see runSummary in
// services/c2c-bff/src/server.ts) — but legacy mocks/fixtures can omit the
// fields entirely. We accept ``undefined`` so the Studio keeps rendering when
// the BFF response predates Issue #172, but we still reject wrong *types*
// (e.g. ``failureCode: 'not_a_real_code'``) so a real BFF regression fails
// contract validation loudly rather than silently mis-rendering.
function hasW02ContractFields(payload: Record<string, unknown>): boolean {
  return (
    (payload.activeStep === undefined || payload.activeStep === null || isString(payload.activeStep)) &&
    (payload.agentAttemptCount === undefined || isNonNegativeInteger(payload.agentAttemptCount)) &&
    (payload.repairBudget === undefined || payload.repairBudget === null || isRepairBudgetPayload(payload.repairBudget)) &&
    (payload.finalClassification === undefined || payload.finalClassification === null || isRunFinalClassification(payload.finalClassification)) &&
    (payload.failureCode === undefined || payload.failureCode === null || isW02UiErrorCode(payload.failureCode)) &&
    (payload.failureMessage === undefined || payload.failureMessage === null || isString(payload.failureMessage))
  );
}

function isRunSummaryPayload(payload: unknown): payload is RunSummary {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunStatus(payload.status) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isString(payload.createdAt) &&
    isString(payload.updatedAt) &&
    (payload.message === undefined || isString(payload.message)) &&
    (payload.evidenceRefs === undefined || isStringArray(payload.evidenceRefs)) &&
    (payload.policyDecision === undefined || isString(payload.policyDecision)) &&
    hasW02ContractFields(payload)
  );
}

function isRunWorkflowSource(value: unknown): value is RunWorkflowView['source'] {
  return value === 'live' || value === 'cached' || value === 'unavailable';
}

function isRunWorkflowViewPayload(payload: unknown): payload is RunWorkflowView {
  if (!isRecord(payload)) return false;
  return (
    isString(payload.runId) &&
    isString(payload.programId) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    isRunWorkflowSource(payload.source) &&
    (payload.state === null || isString(payload.state)) &&
    (payload.activeStep === null || isString(payload.activeStep)) &&
    (payload.activeAgent === null || isW02ActiveAgent(payload.activeAgent)) &&
    isNonNegativeInteger(payload.agentAttemptCount) &&
    (payload.repairBudget === null || isRepairBudgetPayload(payload.repairBudget)) &&
    Array.isArray(payload.repairAttempts) &&
    payload.repairAttempts.every(isRepairAttemptSummaryPayload) &&
    (payload.finalClassification === null || isRunFinalClassification(payload.finalClassification)) &&
    (payload.failureCode === null || isW02UiErrorCode(payload.failureCode)) &&
    (payload.failureMessage === null || isString(payload.failureMessage)) &&
    (payload.generatedJavaRef === null || isWorkflowArtifactRefPayload(payload.generatedJavaRef)) &&
    (payload.buildTestResultRef === null || isWorkflowArtifactRefPayload(payload.buildTestResultRef)) &&
    (payload.evidencePackRef === null || isWorkflowArtifactRefPayload(payload.evidencePackRef))
  );
}

function isRunArtifactsViewPayload(payload: unknown): payload is RunArtifactsView {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.runId) &&
    (payload.programId === undefined || isString(payload.programId)) &&
    isRunMode(payload.mode) &&
    isRunProductMode(payload.productMode) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    Array.isArray(payload.artifacts) &&
    payload.artifacts.every(isRunArtifactMetadata) &&
    (payload.summary === undefined || payload.summary === null || isRecord(payload.summary)) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.createdAt === undefined || payload.createdAt === null || isString(payload.createdAt)) &&
    (payload.updatedAt === undefined || payload.updatedAt === null || isString(payload.updatedAt)) &&
    (payload.note === undefined || isString(payload.note))
  );
}

function parseHealthResponse(payload: unknown): ApiResult<HealthResponse> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: health payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }

  if (payload.status !== 'ok') {
    return createFailure('Contract error: health payload must contain status="ok".', {
      kind: 'contract',
      body: payload,
    });
  }

  return { ok: true, data: payload as HealthResponse };
}

function parseModeResponse(payload: unknown): ApiResult<ModeResponse> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: mode payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }

  if (
    (payload.orchestrator !== 'live' && payload.orchestrator !== 'mock') ||
    (payload.evidence !== 'live' && payload.evidence !== 'mock')
  ) {
    return createFailure(
      'Contract error: mode payload must contain orchestrator/evidence fields with "live" or "mock".',
      { kind: 'contract', body: payload },
    );
  }

  return { ok: true, data: payload as ModeResponse };
}

async function fetchJson<T>(
  path: string,
  parser: (payload: unknown) => ApiResult<T>,
  options?: RequestInit,
): Promise<ApiResult<T>> {
  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    return baseUrlResult;
  }

  try {
    const response = await fetch(`${baseUrlResult.data}${path}`, options);
    const rawBody = await response.text();
    let payload: unknown = null;

    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch (cause) {
        return createFailure('Contract error: API returned malformed JSON.', {
          kind: 'parse',
          body: rawBody,
          cause,
        });
      }
    }

    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `HTTP error ${response.status}`;
      return createFailure(message, { kind: 'http', body: payload }, response.status);
    }

    return parser(payload);
  } catch (cause) {
    return createFailure(
      cause instanceof Error ? cause.message : 'Network error',
      { kind: 'network', cause },
    );
  }
}

function parseTransformResponse(payload: unknown): ApiResult<TransformResponse> {
  if (!isTransformResponsePayload(payload)) {
    return createFailure('Contract error: transform payload has missing or invalid fields.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload };
}

function parseRunSummary(payload: unknown): ApiResult<RunSummary> {
  if (!isRunSummaryPayload(payload)) {
    return createFailure('Contract error: RunSummary payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseGeneratedView(payload: unknown): ApiResult<GeneratedView> {
  if (!isGeneratedViewPayload(payload)) {
    return createFailure('Contract error: GeneratedView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseGeneratedFilesIndex(payload: unknown): ApiResult<GeneratedFilesIndex> {
  if (!isGeneratedFilesIndexPayload(payload)) {
    return createFailure('Contract error: GeneratedFilesIndex payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseBuildTestView(payload: unknown): ApiResult<BuildTestView> {
  if (!isBuildTestViewPayload(payload)) {
    return createFailure('Contract error: BuildTestView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseEvidenceView(payload: unknown): ApiResult<EvidenceView> {
  if (!isEvidenceViewPayload(payload)) {
    return createFailure('Contract error: EvidenceView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseRunEventsView(payload: unknown): ApiResult<RunEventsView> {
  if (!isRunEventsViewPayload(payload)) {
    return createFailure('Contract error: RunEventsView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseRunProgressView(payload: unknown): ApiResult<RunProgressView> {
  if (!isRunProgressViewPayload(payload)) {
    return createFailure('Contract error: RunProgressView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseRunArtifactsView(payload: unknown): ApiResult<RunArtifactsView> {
  if (!isRunArtifactsViewPayload(payload)) {
    return createFailure('Contract error: RunArtifactsView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseGeneratedFileContent(payload: unknown): ApiResult<GeneratedFileContent> {
  if (!isGeneratedFileContentPayload(payload)) {
    return createFailure('Contract error: GeneratedFileContent payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseRunWorkflowView(payload: unknown): ApiResult<RunWorkflowView> {
  if (!isRunWorkflowViewPayload(payload)) {
    return createFailure('Contract error: RunWorkflowView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function encodeGeneratedFilePath(filePath: string): string {
  const segments = filePath.split('/');
  if (
    filePath.length === 0 ||
    filePath.startsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Generated file path must be a relative, normalized path.');
  }

  return segments.map(encodeURIComponent).join('/');
}


import {
  RunExperienceView,
  ModelGatewayHealth,
  ModelGatewayModels,
  HarnessReady
} from '../types/observability';

function isRunExperienceViewPayload(payload: unknown): payload is RunExperienceView {
  if (!isRecord(payload)) return false;
  return isString(payload.runId) &&
         isString(payload.programId) &&
         isRunMode(payload.mode) &&
         isRunProductMode(payload.productMode) &&
         (payload.summary === undefined || isString(payload.summary)) &&
         (payload.observationPolicy === undefined || isString(payload.observationPolicy)) &&
         (payload.learningSignals === undefined || isLearningSignalArray(payload.learningSignals)) &&
         (payload.detectedPatterns === undefined || isStringArray(payload.detectedPatterns)) &&
         (payload.artifactRefs === undefined || isStringArray(payload.artifactRefs));
}

function isLearningSignalArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item)) return false;
    return isString(item.key) &&
           isString(item.label) &&
           (item.status === 'observed' || item.status === 'absent') &&
           typeof item.count === 'number' &&
           (item.summary === undefined || isString(item.summary)) &&
           (item.evidenceRefs === undefined || isStringArray(item.evidenceRefs));
  });
}

function parseRunExperienceView(payload: unknown): ApiResult<RunExperienceView> {
  if (!isRunExperienceViewPayload(payload)) {
    return createFailure('Contract error: RunExperienceView payload has missing or invalid fields.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload };
}

function parseModelGatewayHealth(payload: unknown): ApiResult<ModelGatewayHealth> {
  if (!isRecord(payload)) return createFailure('Contract error: ModelGatewayHealth must be an object.', { kind: 'contract', body: payload });
  if (payload.status !== 'ok' && payload.status !== 'unavailable') {
    return createFailure('Contract error: ModelGatewayHealth payload must contain status="ok" or "unavailable".', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload as unknown as ModelGatewayHealth };
}

function parseModelGatewayModels(payload: unknown): ApiResult<ModelGatewayModels> {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return createFailure('Contract error: ModelGatewayModels must contain models array.', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload as unknown as ModelGatewayModels };
}

function parseHarnessReady(payload: unknown): ApiResult<HarnessReady> {
  if (!isRecord(payload)) return createFailure('Contract error: HarnessReady must be an object.', { kind: 'contract', body: payload });
  if (payload.status !== 'ok' && payload.status !== 'unavailable') {
    return createFailure('Contract error: HarnessReady payload must contain status="ok" or "unavailable".', { kind: 'contract', body: payload });
  }
  return { ok: true, data: payload as unknown as HarnessReady };
}

export const apiClient = {
  getHealth: () => fetchJson('/api/v0/health', parseHealthResponse),
  getMode: () => fetchJson('/api/v0/mode', parseModeResponse),
  transform: (request: TransformRequest) => 
    fetchJson('/api/v0/transform', parseTransformResponse, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    }),
  getRun: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}`, parseRunSummary),
  getGenerated: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/generated`, parseGeneratedView),
  getGeneratedFiles: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/generated/files`, parseGeneratedFilesIndex),
  getGeneratedFile: (runId: string, filePath: string) =>
    fetchJson(
      `/api/v0/runs/${encodeURIComponent(runId)}/generated/files/${encodeGeneratedFilePath(filePath)}`,
      parseGeneratedFileContent,
    ),
  getBuildTest: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/build-test`, parseBuildTestView),
  getEvidence: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/evidence`, parseEvidenceView),
  getRunEvents: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/events`, parseRunEventsView),
  getRunProgress: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/progress`, parseRunProgressView),
  getRunArtifacts: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/artifacts`, parseRunArtifactsView),
  getRunExperience: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/experience`, parseRunExperienceView),
  // Issue #172: W0.2 workflow contract view.
  getRunWorkflow: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/workflow`, parseRunWorkflowView),
  getModelGatewayHealth: () => fetchJson(`/api/v0/model-gateway/health`, parseModelGatewayHealth),
  getModelGatewayModels: () => fetchJson(`/api/v0/model-gateway/models`, parseModelGatewayModels),
  getHarnessReady: () => fetchJson(`/api/v0/harness/ready`, parseHarnessReady),
};
