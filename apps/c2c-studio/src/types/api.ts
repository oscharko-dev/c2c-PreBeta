export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string; details?: ApiErrorDetails };

export type ApiErrorKind = 'config' | 'http' | 'network' | 'parse' | 'contract';

export interface ApiErrorDetails {
  kind: ApiErrorKind;
  body?: unknown;
  cause?: unknown;
}

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

export type UpstreamMode = 'live' | 'mock';

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
  events: string;
  artifacts: string;
}

export interface TransformResponse {
  runId: string;
  orchestratorRunId: string;
  programId: string;
  status: 'starting' | 'updating' | 'completed' | 'failed';
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  message?: string;
  evidenceRefs?: string[];
  policyDecision?: string;
  createdAt: string;
  updatedAt: string;
  links: RunLinks;
}

export interface RunSummary {
  runId: string;
  programId: string;
  status: 'starting' | 'updating' | 'completed' | 'failed';
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  message?: string;
  evidenceRefs?: string[];
  policyDecision?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedFileRef {
  path: string;
  absolutePath?: string;
  uri?: string;
  sha256?: string;
  byteSize?: number;
  mimeType?: string;
}

export interface GeneratedTraceability {
  programId: string;
  irId: string;
  sourceHash: string;
}

export interface OutputRef {
  uri: string;
  sha256: string;
  byteSize?: number;
}

export interface RunArtifactMetadata {
  uri: string;
  sha256: string;
  byteSize?: number;
  mimeType?: string;
  kind: string;
  createdBy: string;
  createdAt: string;
  runId: string;
  workflowId: string;
  path: string;
  name: string;
}

export interface GeneratedView {
  runId: string;
  programId: string;
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  status: 'generated' | 'unsupported' | 'skipped' | 'incomplete';
  entryClass?: string;
  entryFilePath?: string;
  fileCount?: number;
  files?: Record<string, string>;
  fileRefs?: GeneratedFileRef[];
  unsupportedFeatures?: string[];
  openAssumptions?: string[];
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  generationResponseRef?: RunArtifactMetadata | null;
  artifactRef: OutputRef | null;
  traceability?: GeneratedTraceability;
  note?: string;
}

export interface GeneratedFilesIndex {
  runId: string;
  programId: string;
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  status: 'complete' | 'incomplete';
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
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  status: 'ok' | 'compile-failed' | 'run-failed' | 'output-divergence' | 'golden-master-reproduction-failed' | 'missing-golden-master' | 'skipped' | 'incomplete';
  classification: string;
  expectedOutput?: string;
  actualOutput?: string;
  outputRef?: string;
  generatedArtifactRef: OutputRef | null;
  note?: string;
}

export interface EvidenceView {
  runId: string;
  programId: string;
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  status: 'complete' | 'incomplete' | 'invalid';
  packId?: string;
  manifestUri?: string;
  missingArtifacts?: string[];
  orchestratorRunId?: string;
  artifactRef?: RunArtifactMetadata | null;
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
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  events: RunEvent[];
}

export interface RunArtifactsView {
  runId: string;
  programId?: string;
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
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
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  path: string;
  absolutePath?: string;
  content: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  uri?: string;
  kind?: string;
  orchestratorRunId?: string;
}
