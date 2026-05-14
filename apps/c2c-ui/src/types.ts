export interface HealthResponse {
  status: 'ok';
  service: string;
}

export interface ModeResponse {
  orchestrator: 'live' | 'mock';
  evidence: 'live' | 'mock';
}

export type OracleMode = 'cobol-runtime' | 'synthetic-fixture';

export interface SampleSummary {
  programId: string;
  title: string;
  description: string;
  knownDivergenceAtW0: boolean;
  supportedInProductMode: boolean;
  w0Subset: string[];
  oracleMode: OracleMode | null;
  knownLimitations: string[];
}

export interface SampleDetail extends SampleSummary {
  cobolSource: string;
  cobolSourcePath: string;
  expectedOutput: string;
  expectedOutputPath: string;
}

export interface TransformRequest {
  sourceText: string;
  programId?: string;
  sourceName?: string;
  options?: Record<string, unknown>;
}

export interface TransformResponse {
  runId: string;
  orchestratorRunId: string;
  status: RunStatus;
  programId: string;
  productMode: ProductMode;
  links: Record<string, string>;
}

// `diagnostic-fixture` is an opt-in developer mode behind
// C2C_ENABLE_DIAGNOSTIC_FIXTURES. The UI must never label its output as a
// product result. `productMode` is the contained signal: it is `'live'` only
// when the response represents a real orchestrated product outcome.
export type RunMode = 'live' | 'diagnostic-fixture';
export type ProductMode = 'live' | 'unavailable';
export type RunStatus = 'starting' | 'updating' | 'completed' | 'failed';

export interface RunSummary {
  runId: string;
  programId: string;
  status: RunStatus;
  mode: RunMode;
  productMode: ProductMode;
  message: string;
  policyDecision: string;
  evidenceRefs: string[];
  orchestratorRunId: string;
  createdAt: string;
  updatedAt: string;
}

export type GeneratedStatus = 'generated' | 'unsupported' | 'skipped' | 'incomplete';

export interface OutputRef {
  uri: string;
  sha256: string;
  byteSize?: number;
}

export interface Diagnostic {
  level: string;
  code: string;
  message: string;
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

export interface GeneratedView {
  runId: string;
  programId: string;
  mode: RunMode;
  productMode?: ProductMode;
  status: GeneratedStatus;
  entryClass: string;
  entryFilePath: string;
  files: Record<string, string>;
  fileRefs?: GeneratedFileRef[];
  fileCount?: number;
  unsupportedFeatures: string[];
  openAssumptions: string[];
  note: string;
  outputRef?: OutputRef | null;
  artifactRef?: OutputRef | null;
  traceability?: GeneratedTraceability;
  diagnostics?: Diagnostic[];
  missingArtifacts?: string[];
}

export interface GeneratedFilesIndex {
  runId: string;
  programId: string;
  mode: RunMode;
  productMode?: ProductMode;
  status: 'complete' | 'incomplete';
  files: GeneratedFileRef[];
  fileCount: number;
  entryFilePath: string;
  artifactRef: OutputRef | null;
  missingArtifacts: string[];
  note?: string;
  orchestratorRunId?: string;
}

export interface GeneratedFileContent {
  runId: string;
  programId: string;
  mode: RunMode;
  productMode?: ProductMode;
  path: string;
  absolutePath: string;
  content: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  uri: string;
  kind: string;
  orchestratorRunId?: string;
}

export type BuildTestStatus =
  | 'ok'
  | 'compile-failed'
  | 'run-failed'
  | 'output-divergence'
  | 'missing-golden-master'
  | 'incomplete'
  | 'skipped';

export type BuildTestClassification =
  | 'match'
  | 'divergence-known-w0-coverage-gap'
  | 'divergence-unknown'
  | 'compile-error'
  | 'run-error'
  | 'skipped-no-execution';

export type CompileStatus = 'ok' | 'failed' | 'skipped' | 'unknown';
export type ExecutionStatus = 'ok' | 'failed' | 'skipped' | 'not-run' | 'unknown';

export interface BuildTestView {
  runId: string;
  programId: string;
  mode: RunMode;
  productMode?: ProductMode;
  status: BuildTestStatus;
  classification: BuildTestClassification;
  expectedOutput: string;
  actualOutput: string;
  outputRef: OutputRef | null;
  note: string;
  compileStatus?: CompileStatus;
  executionStatus?: ExecutionStatus;
  diagnostics?: Diagnostic[];
  missingArtifacts?: string[];
}

export type EvidenceStatus = 'complete' | 'incomplete' | 'invalid';
export type ValidationStatus = 'valid' | 'invalid' | 'incomplete' | 'unknown';

export interface EvidenceView {
  runId: string;
  programId: string;
  mode: RunMode;
  productMode?: ProductMode;
  status: EvidenceStatus;
  packId: string;
  manifestUri: string;
  exportUri?: string;
  missingArtifacts: string[];
  note: string;
  manifestHash?: string;
  validationStatus?: ValidationStatus;
  exportRef?: OutputRef | null;
}
