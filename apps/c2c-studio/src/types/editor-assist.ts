// Studio-IDE-10 (#249): wire contract for the Editor-Assist channel.
//
// The contract is binding and shared verbatim with the BFF agent. The
// closed enums and interfaces here MUST stay in lockstep with the
// payload shapes documented in ADR 0004 and the W0.3 workflow
// contract. Boundary parse-and-validate guards live in
// ``editorAssistClient.ts``.

export const EDITOR_ASSIST_SCHEMA_VERSION = "v0" as const;

export type EditorAssistSchemaVersion = typeof EDITOR_ASSIST_SCHEMA_VERSION;

// Closed set of source kinds accepted by ``POST /api/v0/editor/explain``.
// Mirrors the ADR 0004 ``requestRegion.sourceKind`` set. Adding a kind
// requires a co-ordinated BFF change.
export const EDITOR_ASSIST_SOURCE_KINDS = ["cobol", "java"] as const;

export type EditorAssistSourceKind =
  (typeof EDITOR_ASSIST_SOURCE_KINDS)[number];

// Closed set of structured error codes returned by the BFF. Studio rejects
// any unknown code loudly at the wire boundary so a backend regression
// surfaces as a contract error instead of an unlabelled UI state.
export const EDITOR_ASSIST_ERROR_CODES = [
  "budget_exhausted",
  "policy_denied",
  "gateway_unavailable",
  "timeout",
  "invalid_region",
] as const;

export type EditorAssistErrorCode = (typeof EDITOR_ASSIST_ERROR_CODES)[number];

export interface EditorAssistBudgetSnapshot {
  limit: number;
  used: number;
  remaining: number;
}

export interface EditorAssistRegion {
  filePath: string;
  sourceKind: EditorAssistSourceKind;
  startLine: number;
  endLine: number;
}

export interface EditorAssistRedactionMetadata {
  studioRedactionProfileVersion: string;
  matchedPatternIds: string[];
}

export interface EditorAssistRequest {
  schemaVersion: EditorAssistSchemaVersion;
  sessionId: string;
  tenantId?: string;
  userId?: string;
  runId?: string | null;
  sourceHash: string;
  region: EditorAssistRegion;
  redactedBytes: string;
  byteHash: string;
  studioRedactionMetadata: EditorAssistRedactionMetadata;
}

export interface EditorAssistSuccessResponse {
  schemaVersion: EditorAssistSchemaVersion;
  explanation: string;
  modelInvocationRef: string;
  editorAssistRef: string;
  ledgerRef: string;
  budgetSnapshot: EditorAssistBudgetSnapshot;
  redactionApplied: string[];
}

export interface EditorAssistErrorPayload {
  schemaVersion: EditorAssistSchemaVersion;
  errorCode: EditorAssistErrorCode;
  message: string;
  budgetSnapshot: EditorAssistBudgetSnapshot | null;
}

// Result of a successful or structured-error call. Discriminated by
// ``ok`` so callers can narrow without poking at HTTP status codes.
export type EditorAssistResult =
  | { ok: true; data: EditorAssistSuccessResponse }
  | {
      ok: false;
      errorCode: EditorAssistErrorCode;
      message: string;
      budgetSnapshot: EditorAssistBudgetSnapshot | null;
    };

export interface EditorAssistBudgetResponse {
  schemaVersion: EditorAssistSchemaVersion;
  budget: EditorAssistBudgetSnapshot;
}

export type EditorAssistBudgetResult =
  | { ok: true; data: EditorAssistBudgetResponse }
  | { ok: false; message: string };

export interface EditorAssistBudgetScope {
  sessionId: string;
  tenantId?: string;
  userId?: string;
}
