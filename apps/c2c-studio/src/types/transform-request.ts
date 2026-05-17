export interface TransformRequest {
  sourceText: string;
  programId?: string;
  sourceName?: string;
  targetLanguage?: 'java';
  expectedOutput?: string;
  oracleInput?: string;
  useTransformationAgent?: boolean;
  options?: Record<string, unknown>;
}
