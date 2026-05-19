// Studio-IDE-10 (#249): editor-assist channel module.
//
// Implements the wire contract for the BFF "Explain this region" action
// per ADR 0004 (Editor-Assist Channel) and ADR 0005 §4 (AI-Explain
// payload pre-redaction). The module is intentionally function-oriented
// so route handlers stay thin and unit tests exercise the rules in
// isolation:
//
//   * validateExplainRequest — closed-set field validation, region
//     bounds, redacted-bytes size cap, and the SHA-256 byteHash
//     verification ADR 0005 §4 makes load-bearing.
//   * createEditorAssistBudgetStore — in-process budget store with
//     per-(tenantId, userId, sessionId) atomic consume. The BFF route
//     passes its server-issued auth session id as `sessionId`, while
//     retaining the client-issued editor session id only for correlation
//     fields. Both session and tenant counters are serialized so
//     concurrent sessions cannot overshoot the daily cap.
//   * mapGatewayResponse — normalises the Model Gateway /v0/explain
//     reply into the closed editor-assist error code set. Upstream
//     error text is NEVER reflected to the user; only fixed default
//     messages flow into the BFF response.
//   * buildLedgerEntry — produces the kind=editor_assist trajectory
//     ledger entry shape sketched in ADR 0004.

import { createHash } from "node:crypto";

import { sanitizeUpstreamMessage } from "./error-codes";
import type { UpstreamResponse } from "./upstream";

// ---------------------------------------------------------------------------
// Schema + bounds
// ---------------------------------------------------------------------------

export const EDITOR_ASSIST_SCHEMA_VERSION = "v0" as const;

// Bounds per ADR 0004 "editorAssistBudget" section.
export const EDITOR_ASSIST_BUDGET_MIN = 1;
export const EDITOR_ASSIST_BUDGET_MAX = 10;
export const DEFAULT_EDITOR_ASSIST_BUDGET = 3;

// Per-(tenant, calendarDateUTC) ceiling defended in ADR 0004 §"Why
// per-session plus per-tenant-per-day". Tighter than the
// editorAssistBudget * sessions-per-day product on purpose: it is the
// abuse boundary, not the productive ceiling. Configurable so
// integration tests can exercise the rollover and cap behaviour.
export const EDITOR_ASSIST_DEFAULT_TENANT_DAILY_CAP = 100;

// Hard cap on the redacted region the client may submit. ADR 0005 §4
// hashes over what leaves the client; the cap protects the BFF and
// gateway from a single oversized request. 200 KB is generous for a
// COBOL paragraph but small enough that a hostile client cannot use
// the explain channel as a free upload surface.
export const EDITOR_ASSIST_REDACTED_BYTES_MAX = 200_000;

export function clampEditorAssistBudget(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_ASSIST_BUDGET_MIN;
  if (value < EDITOR_ASSIST_BUDGET_MIN) return EDITOR_ASSIST_BUDGET_MIN;
  if (value > EDITOR_ASSIST_BUDGET_MAX) return EDITOR_ASSIST_BUDGET_MAX;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Error code closed set + HTTP status mapping
// ---------------------------------------------------------------------------

export type EditorExplainErrorCode =
  | "budget_exhausted"
  | "policy_denied"
  | "gateway_unavailable"
  | "timeout"
  | "invalid_region";

const HTTP_STATUS_BY_ERROR_CODE: Record<EditorExplainErrorCode, number> = {
  budget_exhausted: 429,
  policy_denied: 403,
  gateway_unavailable: 503,
  timeout: 504,
  invalid_region: 400,
};

const EDITOR_EXPLAIN_ERROR_CODES: readonly EditorExplainErrorCode[] = [
  "budget_exhausted",
  "policy_denied",
  "gateway_unavailable",
  "timeout",
  "invalid_region",
];

export function statusForErrorCode(code: EditorExplainErrorCode): number {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

export function isEditorAssistErrorCode(
  value: unknown,
): value is EditorExplainErrorCode {
  if (typeof value !== "string") return false;
  return (EDITOR_EXPLAIN_ERROR_CODES as readonly string[]).includes(value);
}

// User-facing default messages. The BFF never echoes upstream error
// text into the user response (per AC); when the gateway returns an
// error we log/audit upstream details but only these strings flow
// back to the Studio.
const DEFAULT_ERROR_MESSAGES: Record<EditorExplainErrorCode, string> = {
  budget_exhausted:
    "Editor-assist budget exhausted for this session. Try again later or request more from your administrator.",
  policy_denied:
    "Editor-assist policy denied this request. The selected region or context is not eligible.",
  gateway_unavailable: "The Model Gateway is unavailable. Try again shortly.",
  timeout:
    "Editor-assist timed out before the Model Gateway responded. Try again.",
  invalid_region:
    "The selected region is invalid. Select a smaller, non-empty block and retry.",
};

export function defaultMessageForErrorCode(
  code: EditorExplainErrorCode,
): string {
  return DEFAULT_ERROR_MESSAGES[code];
}

// ---------------------------------------------------------------------------
// Region + request types
// ---------------------------------------------------------------------------

export type EditorRegionSourceKind = "cobol" | "java";

export interface EditorRegion {
  filePath: string;
  sourceKind: EditorRegionSourceKind;
  startLine: number;
  endLine: number;
}

export interface StudioRedactionMetadata {
  studioRedactionProfileVersion: string;
  matchedPatternIds: string[];
}

export interface EditorExplainRequest {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  sessionId: string;
  tenantId: string;
  userId: string;
  runId: string | null;
  sourceHash: string;
  region: EditorRegion;
  redactedBytes: string;
  byteHash: string;
  studioRedactionMetadata: StudioRedactionMetadata;
}

export interface BudgetSnapshot {
  limit: number;
  used: number;
  remaining: number;
}

export interface EditorExplainErrorBody {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  errorCode: EditorExplainErrorCode;
  message: string;
  budgetSnapshot: BudgetSnapshot | null;
}

export interface EditorExplainSuccessBody {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  explanation: string;
  modelInvocationRef: string;
  editorAssistRef: string;
  ledgerRef: string;
  budgetSnapshot: BudgetSnapshot;
  redactionApplied: string[];
}

export interface EditorExplainValidationOk {
  ok: true;
  value: EditorExplainRequest;
}

export interface EditorExplainValidationError {
  ok: false;
  errorCode: EditorExplainErrorCode;
  message: string;
}

export type EditorExplainValidation =
  | EditorExplainValidationOk
  | EditorExplainValidationError;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HEX64 = /^[a-fA-F0-9]{64}$/;

// L3: allow-lists for identifier fields echoed into the ledger / forwarded
// to the gateway. Unicode property escapes require the `u` flag.
const SAFE_ID_PATTERN = /^[A-Za-z0-9._\-]+$/u;
// filePath allows letters, digits, dots, underscores, forward-slashes, and
// hyphens. The `u` flag enables Unicode property escapes; \p{L} and \p{N}
// cover non-ASCII identifiers that appear in some enterprise file layouts.
const SAFE_FILEPATH_PATTERN = /^[\p{L}\p{N}._/\-]+$/u;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/u;
const INVALID_FILEPATH_MESSAGE =
  "filePath must be a workspace-relative path without drive prefixes or parent-directory traversal";
const EXPLAIN_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "sessionId",
  "tenantId",
  "userId",
  "runId",
  "sourceHash",
  "region",
  "redactedBytes",
  "byteHash",
  "studioRedactionMetadata",
]);
const REGION_FIELDS = new Set([
  "filePath",
  "sourceKind",
  "startLine",
  "endLine",
]);
const REDACTION_METADATA_FIELDS = new Set([
  "studioRedactionProfileVersion",
  "matchedPatternIds",
]);

function rejectInvalidRegion(message: string): EditorExplainValidationError {
  return {
    ok: false,
    errorCode: "invalid_region",
    message,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    Number.isFinite(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function rejectUnsupportedFields(
  record: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  objectName: string,
): EditorExplainValidationError | null {
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) {
      return rejectInvalidRegion(
        `${objectName} contains unsupported field ${key}`,
      );
    }
  }
  return null;
}

// L3: validate identifier-class string fields before they are echoed into
// the ledger or forwarded to the gateway.

export function validateEditorAssistIdentifier(
  value: string,
  fieldName: string,
  maxLen = 128,
): EditorExplainValidationError | null {
  if (value.length > maxLen) {
    return rejectInvalidRegion(
      `${fieldName} must be alphanumeric (1-128 chars; allowed: . _ -)`,
    );
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    return rejectInvalidRegion(
      `${fieldName} must be alphanumeric (1-128 chars; allowed: . _ -)`,
    );
  }
  return null;
}

function validateFilePath(value: string): EditorExplainValidationError | null {
  if (value.length > 512) {
    return rejectInvalidRegion(INVALID_FILEPATH_MESSAGE);
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(value)
  ) {
    return rejectInvalidRegion(INVALID_FILEPATH_MESSAGE);
  }
  if (!SAFE_FILEPATH_PATTERN.test(value)) {
    return rejectInvalidRegion(INVALID_FILEPATH_MESSAGE);
  }
  if (value.split("/").some((segment) => segment === "..")) {
    return rejectInvalidRegion(INVALID_FILEPATH_MESSAGE);
  }
  return null;
}

function validateRegion(
  raw: unknown,
): EditorRegion | EditorExplainValidationError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return rejectInvalidRegion("region must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unknownField = rejectUnsupportedFields(record, REGION_FIELDS, "region");
  if (unknownField) return unknownField;
  if (!isNonEmptyString(record.filePath)) {
    return rejectInvalidRegion("region.filePath must be a non-empty string");
  }
  const filePathErr = validateFilePath(record.filePath);
  if (filePathErr) return filePathErr;
  if (record.sourceKind !== "cobol" && record.sourceKind !== "java") {
    return rejectInvalidRegion(
      "region.sourceKind must be either 'cobol' or 'java'",
    );
  }
  if (!isPositiveInteger(record.startLine)) {
    return rejectInvalidRegion(
      "region.startLine must be an integer greater than or equal to 1",
    );
  }
  if (!isPositiveInteger(record.endLine)) {
    return rejectInvalidRegion(
      "region.endLine must be an integer greater than or equal to 1",
    );
  }
  if (record.endLine < record.startLine) {
    return rejectInvalidRegion(
      "region.endLine must be greater than or equal to region.startLine",
    );
  }
  return {
    filePath: record.filePath,
    sourceKind: record.sourceKind,
    startLine: record.startLine,
    endLine: record.endLine,
  };
}

function validateRedactionMetadata(
  raw: unknown,
): StudioRedactionMetadata | EditorExplainValidationError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return rejectInvalidRegion("studioRedactionMetadata must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unknownField = rejectUnsupportedFields(
    record,
    REDACTION_METADATA_FIELDS,
    "studioRedactionMetadata",
  );
  if (unknownField) return unknownField;
  if (!isNonEmptyString(record.studioRedactionProfileVersion)) {
    return rejectInvalidRegion(
      "studioRedactionMetadata.studioRedactionProfileVersion must be a non-empty string",
    );
  }
  if (!isStringArray(record.matchedPatternIds)) {
    return rejectInvalidRegion(
      "studioRedactionMetadata.matchedPatternIds must be an array of strings",
    );
  }
  return {
    studioRedactionProfileVersion: record.studioRedactionProfileVersion,
    matchedPatternIds: [...record.matchedPatternIds],
  };
}

export function computeByteHashHex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function validateExplainRequest(raw: unknown): EditorExplainValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return rejectInvalidRegion("request body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const unknownField = rejectUnsupportedFields(
    record,
    EXPLAIN_REQUEST_FIELDS,
    "request body",
  );
  if (unknownField) return unknownField;

  // schemaVersion is required; we only accept v0.
  if (record.schemaVersion !== EDITOR_ASSIST_SCHEMA_VERSION) {
    return rejectInvalidRegion(
      `schemaVersion must be ${JSON.stringify(EDITOR_ASSIST_SCHEMA_VERSION)}`,
    );
  }
  if (!isNonEmptyString(record.sessionId)) {
    return rejectInvalidRegion("sessionId must be a non-empty string");
  }
  // L3: validate sessionId allow-list before it is echoed into the ledger.
  const sessionIdErr = validateEditorAssistIdentifier(
    record.sessionId,
    "sessionId",
  );
  if (sessionIdErr) return sessionIdErr;

  if (!isNonEmptyString(record.sourceHash)) {
    return rejectInvalidRegion("sourceHash must be a non-empty string");
  }
  // L3: sourceHash must be a 64-char SHA-256 hex string.
  if (!HEX64.test(record.sourceHash)) {
    return rejectInvalidRegion(
      "sourceHash must be a 64-char SHA-256 hex string",
    );
  }

  let tenantId = "default";
  let userId = "local";

  // L3: validate tenantId and userId allow-lists when explicitly provided.
  if (Object.prototype.hasOwnProperty.call(record, "tenantId")) {
    if (!isNonEmptyString(record.tenantId)) {
      return rejectInvalidRegion(
        "tenantId must be a non-empty string when provided",
      );
    }
    const tenantIdErr = validateEditorAssistIdentifier(
      record.tenantId,
      "tenantId",
    );
    if (tenantIdErr) return tenantIdErr;
    tenantId = record.tenantId;
  }
  if (Object.prototype.hasOwnProperty.call(record, "userId")) {
    if (!isNonEmptyString(record.userId)) {
      return rejectInvalidRegion(
        "userId must be a non-empty string when provided",
      );
    }
    const userIdErr = validateEditorAssistIdentifier(record.userId, "userId");
    if (userIdErr) return userIdErr;
    userId = record.userId;
  }

  let runId: string | null = null;
  if (record.runId !== undefined && record.runId !== null) {
    if (!isNonEmptyString(record.runId)) {
      return rejectInvalidRegion(
        "runId must be a non-empty string or null when provided",
      );
    }
    // L3: validate runId allow-list before it is forwarded to the gateway.
    const runIdErr = validateEditorAssistIdentifier(record.runId, "runId");
    if (runIdErr) return runIdErr;
    runId = record.runId;
  }

  if (typeof record.redactedBytes !== "string") {
    return rejectInvalidRegion("redactedBytes must be a string");
  }
  if (record.redactedBytes.length === 0) {
    return rejectInvalidRegion("redactedBytes must not be empty");
  }
  const byteSize = Buffer.byteLength(record.redactedBytes, "utf8");
  if (byteSize > EDITOR_ASSIST_REDACTED_BYTES_MAX) {
    return rejectInvalidRegion(
      `redactedBytes is too large (${byteSize} bytes exceeds the ${EDITOR_ASSIST_REDACTED_BYTES_MAX}-byte cap)`,
    );
  }

  if (!isNonEmptyString(record.byteHash) || !HEX64.test(record.byteHash)) {
    return rejectInvalidRegion(
      "byteHash must be a 64-character lowercase or uppercase hex string",
    );
  }

  const region = validateRegion(record.region);
  if ("ok" in region && region.ok === false) {
    return region;
  }
  const meta = validateRedactionMetadata(record.studioRedactionMetadata);
  if ("ok" in meta && meta.ok === false) {
    return meta;
  }

  // ADR 0005 §4: the BFF recomputes the SHA-256 of the exact bytes that
  // were transmitted and verifies it equals the client-supplied hash.
  const computed = computeByteHashHex(record.redactedBytes);
  if (computed.toLowerCase() !== record.byteHash.toLowerCase()) {
    return rejectInvalidRegion("redaction byteHash mismatch");
  }

  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      sessionId: record.sessionId,
      tenantId,
      userId,
      runId,
      sourceHash: record.sourceHash,
      region: region as EditorRegion,
      redactedBytes: record.redactedBytes,
      byteHash: record.byteHash,
      studioRedactionMetadata: meta as StudioRedactionMetadata,
    },
  };
}

// ---------------------------------------------------------------------------
// Budget store
// ---------------------------------------------------------------------------

export interface BudgetScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface BudgetConsumeOk {
  ok: true;
  snapshot: BudgetSnapshot;
}

export interface BudgetConsumeError {
  ok: false;
  errorCode: "budget_exhausted";
  snapshot: BudgetSnapshot;
}

export type BudgetConsumeResult = BudgetConsumeOk | BudgetConsumeError;

export interface EditorAssistBudgetStore {
  snapshot(scope: BudgetScope): BudgetSnapshot;
  consume(scope: BudgetScope): Promise<BudgetConsumeResult>;
  /**
   * Restore one unit to a session's budget. Reserved API.
   *
   * Not invoked from the editor-explain route handler. ADR-0004 favors
   * audit-trail consistency: a failed call still consumed a model attempt
   * and is ledger-recorded. Future use cases (explicit pre-send abort,
   * admin reset) call this; the route does not.
   */
  refund(scope: BudgetScope): void;
}

export interface CreateBudgetStoreOptions {
  defaultLimit?: number;
  tenantDailyCap?: number;
  now?: () => Date;
}

interface LockEntry {
  tail: Promise<void>;
}

interface SessionEntry extends LockEntry {
  used: number;
}

interface TenantEntry extends LockEntry {
  dateUtc: string;
  used: number;
}

function scopeKey(scope: BudgetScope): string {
  return `${scope.tenantId}\0${scope.userId}\0${scope.sessionId}`;
}

function utcDateKey(now: Date): string {
  // YYYY-MM-DD in UTC.
  return now.toISOString().slice(0, 10);
}

async function withLock<T>(
  entry: LockEntry,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Chain onto the previous tail so concurrent consumes serialize. The
  // closure body stays synchronous in production; the Promise return keeps
  // the helper usable in focused tests without changing the lock contract.
  let releaseLock: () => void = () => {};
  const previousTail = entry.tail;
  const nextTail = previousTail.then(
    () =>
      new Promise<void>((resolve) => {
        releaseLock = resolve;
      }),
  );
  entry.tail = nextTail;
  await previousTail;
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

export function createEditorAssistBudgetStore(
  options: CreateBudgetStoreOptions = {},
): EditorAssistBudgetStore {
  const defaultLimit = clampEditorAssistBudget(
    options.defaultLimit ?? DEFAULT_EDITOR_ASSIST_BUDGET,
  );
  const tenantDailyCap =
    options.tenantDailyCap ?? EDITOR_ASSIST_DEFAULT_TENANT_DAILY_CAP;
  const nowFn = options.now ?? (() => new Date());

  const sessions = new Map<string, SessionEntry>();
  const tenants = new Map<string, TenantEntry>();

  function getOrInitSession(scope: BudgetScope): SessionEntry {
    const key = scopeKey(scope);
    const existing = sessions.get(key);
    if (existing) return existing;
    const entry: SessionEntry = { used: 0, tail: Promise.resolve() };
    sessions.set(key, entry);
    return entry;
  }

  function getOrInitTenant(tenantId: string): TenantEntry {
    const today = utcDateKey(nowFn());
    const existing = tenants.get(tenantId);
    if (existing) return existing;
    const entry: TenantEntry = {
      dateUtc: today,
      used: 0,
      tail: Promise.resolve(),
    };
    tenants.set(tenantId, entry);
    return entry;
  }

  function refreshTenantForToday(entry: TenantEntry): TenantEntry {
    const today = utcDateKey(nowFn());
    if (entry.dateUtc !== today) {
      entry.dateUtc = today;
      entry.used = 0;
    }
    return entry;
  }

  function snapshotForSession(used: number): BudgetSnapshot {
    return {
      limit: defaultLimit,
      used,
      remaining: Math.max(0, defaultLimit - used),
    };
  }

  return {
    snapshot(scope) {
      const session = sessions.get(scopeKey(scope));
      const used = session ? session.used : 0;
      return snapshotForSession(used);
    },
    async consume(scope) {
      const entry = getOrInitSession(scope);
      const tenantEntry = getOrInitTenant(scope.tenantId);
      return withLock(entry, () =>
        withLock(tenantEntry, () => {
          const tenant = refreshTenantForToday(tenantEntry);
          // Per-tenant-per-day ceiling first: it is the abuse boundary and
          // must reject even when the session still has remaining budget.
          if (tenant.used >= tenantDailyCap) {
            return {
              ok: false,
              errorCode: "budget_exhausted",
              snapshot: snapshotForSession(entry.used),
            };
          }
          if (entry.used >= defaultLimit) {
            return {
              ok: false,
              errorCode: "budget_exhausted",
              snapshot: snapshotForSession(entry.used),
            };
          }
          entry.used += 1;
          tenant.used += 1;
          return {
            ok: true,
            snapshot: snapshotForSession(entry.used),
          };
        }),
      );
    },
    refund(scope) {
      const entry = sessions.get(scopeKey(scope));
      if (entry && entry.used > 0) {
        entry.used -= 1;
      }
      const tenant = tenants.get(scope.tenantId);
      if (tenant && tenant.used > 0) {
        tenant.used -= 1;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Reference builders
// ---------------------------------------------------------------------------

export interface RefBuilderArgs {
  tenantId: string;
  sessionId: string;
  seq: number;
}

export function buildEditorAssistRef(args: RefBuilderArgs): string {
  return `eai-${args.tenantId}-${args.sessionId}-${args.seq}`;
}

export function buildLocalLedgerRef(args: RefBuilderArgs): string {
  return `urn:c2c/editor-assist/${args.tenantId}/${args.sessionId}/${args.seq}`;
}

export function extractLedgerRef(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidate = (body as Record<string, unknown>).ledgerRef;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  // ADR-aligned mapping ref (e.g. orchestrator clients embed
  // ``ledgerRef`` as ``{ uri, sha256 }``). Accept the same shape so the
  // BFF passes the opaque value through verbatim.
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const uri = (candidate as Record<string, unknown>).uri;
    if (typeof uri === "string" && uri.length > 0) return uri;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gateway response mapping
// ---------------------------------------------------------------------------

export interface GatewayMappingOk {
  kind: "ok";
  explanation: string;
  invocationId: string | null;
  gatewayLedgerRef: string | null;
  gatewayRedactedFields: string[];
}

export interface GatewayMappingError {
  kind: "error";
  errorCode: EditorExplainErrorCode;
  message: string;
}

export type GatewayMappingResult = GatewayMappingOk | GatewayMappingError;

export function mapGatewayResponse(
  response: UpstreamResponse | undefined,
): GatewayMappingResult {
  if (!response) {
    return {
      kind: "error",
      errorCode: "gateway_unavailable",
      message: defaultMessageForErrorCode("gateway_unavailable"),
    };
  }
  const { status, body } = response;
  if (status >= 200 && status < 300) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const explanation = record.explanation;
      if (typeof explanation === "string" && explanation.length > 0) {
        const invocationIdRaw = record.invocationId;
        const invocationId =
          typeof invocationIdRaw === "string" && invocationIdRaw.length > 0
            ? invocationIdRaw
            : null;
        const gatewayLedgerRef = extractLedgerRef(record);
        const gatewayRedactedFields = Array.isArray(record.redactedFields)
          ? record.redactedFields.filter(
              (field): field is string => typeof field === "string",
            )
          : [];
        return {
          kind: "ok",
          explanation,
          invocationId,
          gatewayLedgerRef,
          gatewayRedactedFields,
        };
      }
    }
    // 2xx without a usable explanation is treated as a transport-level
    // failure; the BFF cannot surface a partial result to the editor.
    return {
      kind: "error",
      errorCode: "gateway_unavailable",
      message: defaultMessageForErrorCode("gateway_unavailable"),
    };
  }
  if (status === 403) {
    // Run sanitization for audit purposes but discard the result —
    // see comment on the success branch above and AC7. The user only
    // ever sees the fixed default message.
    sanitizeUpstreamMessage(body, defaultMessageForErrorCode("policy_denied"));
    return {
      kind: "error",
      errorCode: "policy_denied",
      message: defaultMessageForErrorCode("policy_denied"),
    };
  }
  if (status === 504) {
    sanitizeUpstreamMessage(body, defaultMessageForErrorCode("timeout"));
    return {
      kind: "error",
      errorCode: "timeout",
      message: defaultMessageForErrorCode("timeout"),
    };
  }
  // All other non-2xx (including 5xx) collapse to gateway_unavailable.
  // The wire contract intentionally does not surface upstream text to
  // the user; only the canonical default message is returned.
  sanitizeUpstreamMessage(
    body,
    defaultMessageForErrorCode("gateway_unavailable"),
  );
  return {
    kind: "error",
    errorCode: "gateway_unavailable",
    message: defaultMessageForErrorCode("gateway_unavailable"),
  };
}

// ---------------------------------------------------------------------------
// Redacted-field normalisation
// ---------------------------------------------------------------------------

export interface NormaliseRedactedFieldsArgs {
  studioMatchedPatternIds: string[];
  gatewayRedactedFields: string[] | undefined;
}

export function normaliseGatewayRedactedFields(
  args: NormaliseRedactedFieldsArgs,
): string[] {
  const union = new Set<string>();
  for (const id of args.studioMatchedPatternIds) {
    if (typeof id === "string" && id.length > 0) {
      union.add(id);
    }
  }
  const gateway = args.gatewayRedactedFields ?? [];
  for (const id of gateway) {
    if (typeof id === "string" && id.length > 0) {
      union.add(id);
    }
  }
  return Array.from(union);
}

// ---------------------------------------------------------------------------
// Ledger entry shape (ADR 0004 sketch)
// ---------------------------------------------------------------------------

export type EditorAssistLedgerStatus = "success" | "failed";

export interface EditorAssistLedgerEntry {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  kind: "editor_assist";
  ledgerEntryId: string;
  invocationId: string | null;
  tenantId: string;
  userId: string;
  sessionId: string;
  requestSource: "editor";
  requestRegion: {
    filePath: string;
    sourceKind: EditorRegionSourceKind;
    startLine: number;
    endLine: number;
    byteHash: string;
  };
  redactedFields: string[];
  ledgerRef: string;
  editorAssistRef: string;
  budgetSnapshot: BudgetSnapshot;
  startedAt: string;
  endedAt: string;
  status: EditorAssistLedgerStatus;
  failureCode: EditorExplainErrorCode | null;
  runIdRef: string | null;
}

export interface BuildLedgerEntryArgs {
  schemaVersion: typeof EDITOR_ASSIST_SCHEMA_VERSION;
  tenantId: string;
  userId: string;
  sessionId: string;
  region: EditorRegion;
  byteHash: string;
  redactionApplied: string[];
  editorAssistRef: string;
  ledgerRef: string;
  invocationId: string | null;
  budgetSnapshot: BudgetSnapshot;
  startedAt: string;
  endedAt: string;
  status: EditorAssistLedgerStatus;
  failureCode: EditorExplainErrorCode | null;
  runIdRef: string | null;
}

export function buildLedgerEntry(
  args: BuildLedgerEntryArgs,
): EditorAssistLedgerEntry {
  return {
    schemaVersion: args.schemaVersion,
    kind: "editor_assist",
    // Per ADR 0004, the entry id mirrors the editor-assist ref so the
    // audit trail is self-referential. Tests assert this equality.
    ledgerEntryId: args.editorAssistRef,
    invocationId: args.invocationId,
    tenantId: args.tenantId,
    userId: args.userId,
    sessionId: args.sessionId,
    requestSource: "editor",
    requestRegion: {
      filePath: args.region.filePath,
      sourceKind: args.region.sourceKind,
      startLine: args.region.startLine,
      endLine: args.region.endLine,
      byteHash: `sha256:${args.byteHash}`,
    },
    redactedFields: [...args.redactionApplied],
    ledgerRef: args.ledgerRef,
    editorAssistRef: args.editorAssistRef,
    budgetSnapshot: args.budgetSnapshot,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    status: args.status,
    failureCode: args.failureCode,
    runIdRef: args.runIdRef,
  };
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

// Per-(tenantId, sessionId) monotonic counter used to construct
// editorAssistRef / local ledgerRef. Kept independent of the budget
// store so a refund (which un-consumes budget) does NOT rewind the
// audit sequence. The counter is in-process for V1; mirrors the
// run-store ephemeral pattern.
export interface SequenceCounter {
  next(scope: { tenantId: string; sessionId: string }): number;
}

export function createSequenceCounter(): SequenceCounter {
  const counters = new Map<string, number>();
  return {
    next(scope) {
      const key = `${scope.tenantId}\0${scope.sessionId}`;
      const current = counters.get(key) ?? 0;
      const next = current + 1;
      counters.set(key, next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function buildErrorBody(
  errorCode: EditorExplainErrorCode,
  snapshot: BudgetSnapshot | null,
  messageOverride?: string,
): EditorExplainErrorBody {
  return {
    schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
    errorCode,
    message: messageOverride ?? defaultMessageForErrorCode(errorCode),
    budgetSnapshot: snapshot,
  };
}

export interface BuildSuccessBodyArgs {
  explanation: string;
  modelInvocationRef: string;
  editorAssistRef: string;
  ledgerRef: string;
  budgetSnapshot: BudgetSnapshot;
  redactionApplied: string[];
}

export function buildSuccessBody(
  args: BuildSuccessBodyArgs,
): EditorExplainSuccessBody {
  return {
    schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
    explanation: args.explanation,
    modelInvocationRef: args.modelInvocationRef,
    editorAssistRef: args.editorAssistRef,
    ledgerRef: args.ledgerRef,
    budgetSnapshot: args.budgetSnapshot,
    redactionApplied: [...args.redactionApplied],
  };
}
