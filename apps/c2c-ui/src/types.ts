export interface HealthResponse {
  status: 'ok';
  service: string;
}

export interface ModeResponse {
  orchestrator: 'live' | 'mock';
  evidence: 'live' | 'mock';
}

export interface SampleSummary {
  programId: string;
  title: string;
  description: string;
  knownDivergenceAtW0: boolean;
}

export interface SampleDetail extends SampleSummary {
  cobolSource: string;
  cobolSourcePath: string;
  expectedOutput: string;
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
  productMode: RunMode;
  links: Record<string, string>;
}

export type RunMode = 'live' | 'mock';
export type RunStatus = 'starting' | 'updating' | 'completed' | 'failed';

export interface RunSummary {
  runId: string;
  programId: string;
  status: RunStatus;
  mode: RunMode;
  productMode: RunMode;
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
  level?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface GeneratedView {
  runId: string;
  programId: string;
  mode: RunMode;
  status: GeneratedStatus;
  entryClass: string;
  entryFilePath: string;
  files: Record<string, string>;
  unsupportedFeatures: string[];
  openAssumptions: string[];
  note: string;
  outputRef?: OutputRef | null;
  diagnostics?: Diagnostic[];
  missingArtifacts?: string[];
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
  status: BuildTestStatus;
  classification: BuildTestClassification;
  expectedOutput: string;
  actualOutput: string;
  outputRef: string | OutputRef | null;
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
