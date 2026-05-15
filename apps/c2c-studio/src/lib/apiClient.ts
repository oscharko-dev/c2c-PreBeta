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
  RunArtifactsView,
  RunEvent,
  RunArtifactMetadata,
  GeneratedFileContent,
} from '../types/api';
import { Sample, SampleDetail, TransformRequest } from '../types/reference-program';

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
    isString(payload.events) &&
    isString(payload.artifacts)
  );
}

function isRunArtifactMetadata(payload: unknown): payload is RunArtifactMetadata {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.uri) &&
    isString(payload.sha256) &&
    isNonNegativeInteger(payload.byteSize) &&
    isString(payload.mimeType) &&
    isString(payload.kind) &&
    isString(payload.createdBy) &&
    isString(payload.createdAt) &&
    isString(payload.runId) &&
    isString(payload.workflowId) &&
    isString(payload.path) &&
    isString(payload.name)
  );
}

function isOutputRef(payload: unknown): payload is OutputRef {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.uri) &&
    isString(payload.sha256) &&
    (payload.byteSize === undefined || isNonNegativeInteger(payload.byteSize))
  );
}

function isGeneratedFileRef(payload: unknown): payload is GeneratedFileRef {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    isString(payload.path) &&
    (payload.absolutePath === undefined || isString(payload.absolutePath)) &&
    (payload.uri === undefined || isString(payload.uri)) &&
    (payload.sha256 === undefined || isString(payload.sha256)) &&
    (payload.byteSize === undefined || isNonNegativeInteger(payload.byteSize)) &&
    (payload.mimeType === undefined || isString(payload.mimeType))
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
    (payload.files === undefined || isRecord(payload.files)) &&
    (payload.fileRefs === undefined || (Array.isArray(payload.fileRefs) && payload.fileRefs.every(isGeneratedFileRef))) &&
    (payload.unsupportedFeatures === undefined || isStringArray(payload.unsupportedFeatures)) &&
    (payload.openAssumptions === undefined || isStringArray(payload.openAssumptions)) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.generationResponseRef === undefined || payload.generationResponseRef === null || isRunArtifactMetadata(payload.generationResponseRef)) &&
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
    (payload.absolutePath === undefined || isString(payload.absolutePath)) &&
    isString(payload.content) &&
    isString(payload.sha256) &&
    isNonNegativeInteger(payload.byteSize) &&
    isString(payload.mimeType) &&
    (payload.uri === undefined || isString(payload.uri)) &&
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
    (payload.manifestUri === undefined || isString(payload.manifestUri)) &&
    (payload.missingArtifacts === undefined || isStringArray(payload.missingArtifacts)) &&
    (payload.orchestratorRunId === undefined || isString(payload.orchestratorRunId)) &&
    (payload.artifactRef === undefined || payload.artifactRef === null || isRunArtifactMetadata(payload.artifactRef)) &&
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
    (payload.policyDecision === undefined || isString(payload.policyDecision))
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
    (payload.policyDecision === undefined || isString(payload.policyDecision))
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

function isSample(payload: unknown): payload is Sample {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    typeof payload.programId === 'string' &&
    typeof payload.title === 'string' &&
    typeof payload.description === 'string' &&
    typeof payload.knownDivergenceAtW0 === 'boolean' &&
    typeof payload.supportedInProductMode === 'boolean' &&
    isStringArray(payload.w0Subset) &&
    (payload.oracleMode === null ||
      payload.oracleMode === 'cobol-runtime' ||
      payload.oracleMode === 'synthetic-fixture') &&
    isStringArray(payload.knownLimitations)
  );
}

function isSampleDetail(payload: unknown): payload is SampleDetail {
  if (!isSample(payload)) {
    return false;
  }

  const detail = payload as SampleDetail;
  return (
    typeof detail.cobolSource === 'string' &&
    typeof detail.cobolSourcePath === 'string' &&
    typeof detail.expectedOutput === 'string' &&
    typeof detail.expectedOutputPath === 'string'
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

function parseSamplesResponse(payload: unknown): ApiResult<Sample[]> {
  if (!Array.isArray(payload)) {
    return createFailure('Contract error: samples payload must be an array.', {
      kind: 'contract',
      body: payload,
    });
  }
  if (!payload.every(isSample)) {
    return createFailure('Contract error: samples payload contains invalid entries.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload };
}

function parseSampleDetailResponse(payload: unknown): ApiResult<SampleDetail> {
  if (!isSampleDetail(payload)) {
    return createFailure('Contract error: sample detail payload has missing or invalid fields.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload };
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

export const apiClient = {
  getHealth: () => fetchJson('/api/v0/health', parseHealthResponse),
  getMode: () => fetchJson('/api/v0/mode', parseModeResponse),
  getSamples: () => fetchJson('/api/v0/samples', parseSamplesResponse),
  getSampleDetail: (programId: string) => fetchJson(`/api/v0/samples/${encodeURIComponent(programId)}`, parseSampleDetailResponse),
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
  getRunArtifacts: (runId: string) => fetchJson(`/api/v0/runs/${encodeURIComponent(runId)}/artifacts`, parseRunArtifactsView),
};
