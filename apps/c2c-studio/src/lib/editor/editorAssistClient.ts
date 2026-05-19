// Studio-IDE-10 (#249): client for the Editor-Assist channel.
//
// Talks only to the BFF endpoints:
//   POST /api/v0/editor/explain   — request a region explanation.
//   GET  /api/v0/editor/budget    — read the per-session assist budget.
//
// The boundary is hardened in the apiClient.ts style: every wire payload
// is parse-and-validated against a closed schema, unknown error codes
// are downgraded to `gateway_unavailable` rather than silently rendered,
// and an unparseable body always yields a normalised structured error
// (`gateway_unavailable` with a fixed user-facing message). Studio MUST
// NOT contact the Model Gateway directly — every Editor-Assist call
// flows through the BFF.

import { resolveApiBaseUrl } from "@/lib/apiClient";
import { emit as emitTelemetry } from "@/lib/editor/editorTelemetry";
import {
  EDITOR_ASSIST_ERROR_CODES,
  EDITOR_ASSIST_SCHEMA_VERSION,
  type EditorAssistBudgetResult,
  type EditorAssistBudgetScope,
  type EditorAssistBudgetSnapshot,
  type EditorAssistErrorCode,
  type EditorAssistRequest,
  type EditorAssistResult,
  type EditorAssistSuccessResponse,
} from "@/types/editor-assist";

// Fixed user-facing message synthesised when the server response cannot
// be parsed (malformed JSON, HTML error page, etc.) or when the network
// rejects. The UI translates `errorCode` into the localised string; this
// fallback exists so the panel always has *something* to render.
const UNAVAILABLE_MESSAGE =
  "Editor-Assist is temporarily unavailable. Please retry in a moment.";

const ERROR_CODE_SET: ReadonlySet<EditorAssistErrorCode> = new Set(
  EDITOR_ASSIST_ERROR_CODES,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBudgetSnapshot(value: unknown): value is EditorAssistBudgetSnapshot {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.used) &&
    isNonNegativeInteger(value.remaining)
  );
}

function isEditorAssistErrorCode(
  value: unknown,
): value is EditorAssistErrorCode {
  return (
    typeof value === "string" &&
    ERROR_CODE_SET.has(value as EditorAssistErrorCode)
  );
}

function stripClientAssertedIdentity(
  payload: EditorAssistRequest,
): Omit<EditorAssistRequest, "tenantId" | "userId"> {
  const serverPayload = { ...payload };
  delete serverPayload.tenantId;
  delete serverPayload.userId;
  return serverPayload;
}

function isSuccessResponse(
  value: unknown,
): value is EditorAssistSuccessResponse {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === EDITOR_ASSIST_SCHEMA_VERSION &&
    isString(value.explanation) &&
    isString(value.modelInvocationRef) &&
    isString(value.editorAssistRef) &&
    isString(value.ledgerRef) &&
    isBudgetSnapshot(value.budgetSnapshot) &&
    isStringArray(value.redactionApplied)
  );
}

// Build a normalised `gateway_unavailable` result. Centralising the
// shape ensures the panel only ever sees a single failure dialect for
// the "we could not talk to the server" class of error.
function unavailableResult(
  message: string = UNAVAILABLE_MESSAGE,
): EditorAssistResult {
  return {
    ok: false,
    errorCode: "gateway_unavailable",
    message,
    budgetSnapshot: null,
  };
}

// Try to parse a raw text body into JSON. Returns `null` on any failure
// — the caller maps `null` to a synthesised gateway-unavailable error.
function safeParseJson(rawBody: string): unknown {
  if (rawBody.length === 0) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

// Exported so tests can exercise the structured-error parsing path
// without spinning up a fetch double. `payload` is whatever the body
// parsed to (already JSON-decoded, or an already-decoded object). The
// `status` argument is informational only — we surface it via the
// `gateway_unavailable` fallback in case the BFF returns a body that
// neither matches the success nor the error contract.
export function parseEditorAssistError(
  payload: unknown,
  _status: number,
): EditorAssistResult {
  void _status;
  if (!isRecord(payload)) {
    return unavailableResult();
  }
  if (payload.schemaVersion !== EDITOR_ASSIST_SCHEMA_VERSION) {
    return unavailableResult();
  }
  const rawCode = payload.errorCode;
  const errorCode: EditorAssistErrorCode = isEditorAssistErrorCode(rawCode)
    ? rawCode
    : "gateway_unavailable";
  const message = isString(payload.message)
    ? payload.message
    : UNAVAILABLE_MESSAGE;
  const budgetSnapshot = isBudgetSnapshot(payload.budgetSnapshot)
    ? payload.budgetSnapshot
    : null;
  return {
    ok: false,
    errorCode,
    message,
    budgetSnapshot,
  };
}

export interface RequestExplanationOptions {
  signal?: AbortSignal;
}

// Issues `POST /api/v0/editor/explain`. Studio is the authoritative
// producer of redacted bytes, hashes, and the redaction metadata, but
// tenantId/userId are not sent because the BFF binds identity to the
// HttpOnly session cookie. The response is parse-and-validated;
// anything off-contract is normalised into a
// `gateway_unavailable` failure so the side panel never has to render
// an unlabelled state.
export async function requestExplanation(
  payload: EditorAssistRequest,
  options: RequestExplanationOptions = {},
): Promise<EditorAssistResult> {
  // Studio-IDE-11 (#251): assist.invoked tagged event — only the
  // redaction count (never the field names) and the bucketed region
  // size are reported.
  const regionLineCount = Math.max(
    0,
    payload.region.endLine - payload.region.startLine + 1,
  );
  emitTelemetry({
    eventType: "assist.invoked",
    payload: {
      sourceKind: payload.region.sourceKind,
      regionLineCount,
      redactionApplied:
        payload.studioRedactionMetadata.matchedPatternIds.length,
    },
  });

  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    emitTelemetry({
      eventType: "assist.result",
      payload: { outcome: "gateway_unavailable" },
    });
    return unavailableResult(baseUrlResult.message);
  }

  let response: Response;
  try {
    const serverPayload = stripClientAssertedIdentity(payload);
    response = await fetch(`${baseUrlResult.data}/api/v0/editor/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(serverPayload),
      signal: options.signal,
    });
  } catch {
    emitTelemetry({
      eventType: "assist.result",
      payload: { outcome: "gateway_unavailable" },
    });
    return unavailableResult();
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    emitTelemetry({
      eventType: "assist.result",
      payload: { outcome: "gateway_unavailable" },
    });
    return unavailableResult();
  }
  const parsed = safeParseJson(rawBody);

  if (!response.ok) {
    if (parsed === null) {
      emitTelemetry({
        eventType: "assist.result",
        payload: { outcome: "gateway_unavailable" },
      });
      return unavailableResult();
    }
    const errorResult = parseEditorAssistError(parsed, response.status);
    emitTelemetry({
      eventType: "assist.result",
      payload: {
        outcome: errorResult.ok ? "success" : errorResult.errorCode,
      },
    });
    return errorResult;
  }

  if (!isSuccessResponse(parsed)) {
    emitTelemetry({
      eventType: "assist.result",
      payload: { outcome: "gateway_unavailable" },
    });
    return unavailableResult();
  }
  emitTelemetry({
    eventType: "assist.result",
    payload: { outcome: "success" },
  });
  return { ok: true, data: parsed };
}

export interface GetBudgetOptions {
  signal?: AbortSignal;
}

// Encodes the budget scope into the query string. The BFF derives
// tenantId/userId from the HttpOnly session cookie, so the preflight
// only sends the client-issued editor session identifier.
function buildBudgetUrl(base: string, scope: EditorAssistBudgetScope): string {
  const params: string[] = [`sessionId=${encodeURIComponent(scope.sessionId)}`];
  return `${base}/api/v0/editor/budget?${params.join("&")}`;
}

function isBudgetResponse(value: unknown): value is {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  budget: EditorAssistBudgetSnapshot;
} {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === EDITOR_ASSIST_SCHEMA_VERSION &&
    isBudgetSnapshot(value.budget)
  );
}

// Issues `GET /api/v0/editor/budget?...`. Failure modes are flattened
// into `{ ok: false, message }` because the panel only needs to know
// the budget could not be fetched; it falls back to the most recent
// snapshot it has cached locally.
export async function getBudget(
  scope: EditorAssistBudgetScope,
  options: GetBudgetOptions = {},
): Promise<EditorAssistBudgetResult> {
  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    return { ok: false, message: baseUrlResult.message };
  }

  let response: Response;
  try {
    response = await fetch(buildBudgetUrl(baseUrlResult.data, scope), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      signal: options.signal,
    });
  } catch {
    return { ok: false, message: UNAVAILABLE_MESSAGE };
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    return { ok: false, message: UNAVAILABLE_MESSAGE };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Budget unavailable (HTTP ${response.status})`,
    };
  }

  const parsed = safeParseJson(rawBody);
  if (!isBudgetResponse(parsed)) {
    return { ok: false, message: "Budget response failed contract check." };
  }
  return { ok: true, data: parsed };
}
