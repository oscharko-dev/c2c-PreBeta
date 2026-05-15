export interface Sample {
  programId: string;
  title: string;
  description: string;
  supportedInProductMode: boolean;
  w0Subset: boolean;
  oracleMode: boolean;
  knownLimitations: string[];
}

export interface SampleDetail {
  programId: string;
  cobolSource: string;
  expectedOutput: string;
  sourcePath: string;
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
  status: string;
  [key: string]: unknown;
}
