export interface Sample {
  programId: string;
  title: string;
  description: string;
  knownDivergenceAtW0: boolean;
  supportedInProductMode: boolean;
  w0Subset: string[];
  oracleMode: 'cobol-runtime' | 'synthetic-fixture' | null;
  knownLimitations: string[];
}

export interface SampleDetail extends Sample {
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
  programId: string;
  status: string;
  [key: string]: unknown;
}
