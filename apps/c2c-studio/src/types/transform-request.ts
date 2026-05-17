export interface TransformRequest {
  sourceText: string;
  programId?: string;
  sourceName?: string;
  targetLanguage?: 'java';
  expectedOutput?: string;
  oracleInput?: string;
  options?: Record<string, unknown>;
}
