export interface TransformRequest {
  sourceText: string;
  programId?: string;
  sourceName?: string;
  targetLanguage?: "java";
  trustCaseId?: string;
  expectedOutput?: string;
  oracleInput?: string;
  useTransformationAgent?: boolean;
  options?: Record<string, unknown>;
}
