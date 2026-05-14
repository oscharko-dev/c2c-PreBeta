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

export type RunMode = 'live' | 'mock';
export type RunStatus = 'starting' | 'updating' | 'completed' | 'failed';

export interface RunSummary {
  runId: string;
  programId: string;
  status: RunStatus;
  mode: RunMode;
  message: string;
  policyDecision: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export type GeneratedStatus = 'generated' | 'unsupported' | 'skipped';

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
}

export type BuildTestStatus =
  | 'ok'
  | 'compile-failed'
  | 'run-failed'
  | 'output-divergence'
  | 'missing-golden-master'
  | 'skipped';

export type BuildTestClassification =
  | 'match'
  | 'divergence-known-w0-coverage-gap'
  | 'divergence-unknown'
  | 'compile-error'
  | 'run-error'
  | 'skipped-no-execution';

export interface BuildTestView {
  runId: string;
  programId: string;
  mode: RunMode;
  status: BuildTestStatus;
  classification: BuildTestClassification;
  expectedOutput: string;
  actualOutput: string;
  outputRef: string;
  note: string;
}

export type EvidenceStatus = 'complete' | 'incomplete';

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
}
