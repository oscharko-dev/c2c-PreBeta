import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";

import type { BffConfig } from "./config";
import {
  loadSampleRegistry,
  type SampleRegistry,
  type SampleDetail,
} from "./samples";
import {
  loadAcceptanceFixtureRegistry,
  type AcceptanceFixtureRegistry,
  type AcceptanceFixtureDetail,
} from "./acceptance-fixtures";
import {
  loadTrustCaseCatalog,
  type TrustCaseCatalog,
  type TrustCaseSummary,
} from "./trust-cases";
import {
  createBuildTestRunnerClient,
  createEvidenceClient,
  createExperienceLearningClient,
  createModelGatewayClient,
  createHarnessClient,
  type BuildTestRunnerClient,
  type ModelGatewayClient,
  type HarnessClient,
  createNodeHttpClient,
  createOrchestratorClient,
  UpstreamResponseTooLargeError,
  type EvidenceClient,
  type ExperienceLearningClient,
  type HttpClient,
  type OrchestratorClient,
  type UpstreamResponse,
} from "./upstream";
import {
  coerceLiveStatus,
  createRunStore,
  type RunStore,
  type StoredRun,
  type RunFinalClassification,
  type RunExecutionMode,
  type SourceReferenceMode,
  type StoredAssistBudget,
  type StoredModelInvocationBudget,
  type StoredRepairBudget,
} from "./run-store";
import { findPlaceholderInFiles } from "./placeholder-markers";
import {
  W02_UI_ERROR_CODES,
  defaultMessageFor,
  mapFailure,
  mapOrchestratorFailureCode,
  mapUpstreamUnavailable,
  sanitizeUpstreamMessage,
  type W02UiErrorCode,
} from "./error-codes";
import {
  classifyBuildTestStatus,
  classifyGeneratedStatus,
  createSourceTextSample,
  deriveComparisonOutputRef,
  deriveExportRef,
  deriveManualEditOverlayRef,
  deriveMissingFromValidation,
  deriveValidationStatus,
  diagnosticFixtureBuildTestView,
  diagnosticFixtureEvidenceView,
  diagnosticFixtureGeneratedView,
  extractProgramIdFromSourceText,
  EMPTY_WORKFLOW_SNAPSHOT,
  incompleteEnvelope,
  liveArtifactRunId,
  normalizeExperienceViewFromSummary,
  normalizeGeneratedFileRefs,
  normalizeGeneratedTraceability,
  normalizeJavaRegionClassification,
  isSafeGeneratedRelpath,
  isSafeRequestJavaFilePath,
  normalizeOutputRef,
  normalizePipelineStep,
  normalizeRunArtifact,
  normalizeRequestJavaFilePath,
  productModeOf,
  resolveTransformProgramId,
  runLinks,
  runSummary,
  snapshotFromContract,
  sanitizeUiRunEvent,
  workflowEnvelope,
  transformLinks,
  transformResponse,
  type WorkflowSnapshot,
} from "./runViews";
// Studio-IDE-5 (#244): typed Diagnostic surface. The shape and the
// normalization rules live in `./diagnostics.ts` so the BFF handlers
// and the dedicated unit tests share a single source of truth.
import { normalizeDiagnostics, type Diagnostic } from "./diagnostics";
// Studio-IDE-14 (#256): typed request validation + upstream response
// normalisation for the Java formatter route.
import {
  formatInputTooLarge,
  formatUnavailable,
  normaliseUpstreamResponse,
  validateFormatJavaRequest,
} from "./formatJava";
// Studio-IDE-10 (#249): editor-assist channel — validation, budget
// store, gateway response mapping, and ledger-entry construction live
// in their own module so the route handler stays thin and the rules
// have direct unit-test coverage.
import {
  EDITOR_ASSIST_SCHEMA_VERSION,
  buildEditorAssistRef,
  buildErrorBody,
  buildLedgerEntry,
  buildLocalLedgerRef,
  buildSuccessBody,
  createEditorAssistBudgetStore,
  createSequenceCounter,
  defaultMessageForErrorCode,
  mapGatewayResponse,
  normaliseGatewayRedactedFields,
  statusForErrorCode,
  validateEditorAssistIdentifier,
  validateExplainRequest,
  type BudgetSnapshot,
  type EditorAssistBudgetStore,
  type EditorAssistLedgerEntry,
  type EditorExplainErrorCode,
  type EditorRegion,
  type SequenceCounter,
} from "./editorExplain";
// Studio-IDE-11 (#251): editor telemetry intake — closed-enum, tag-only
// learning signals. Validation lives in `./editorTelemetry.ts`; the
// route handler below augments accepted batches with tenant/user
// context and forwards them through the existing
// experience-learning client (`upstream.ts`).
import {
  EDITOR_TELEMETRY_MAX_BODY_BYTES,
  EDITOR_TELEMETRY_SCHEMA_VERSION,
  augmentBatch,
  statusForValidationErrorCode,
  validateTelemetryBatch,
} from "./editorTelemetry";
// Issue #271 / ADR-0005 §6: receiver for browser CSP violation
// reports. Parser + PII gate + canonical log shape live in
// `./cspReport.ts`; the route handler below is intentionally thin.
import {
  CSP_REPORT_LOG_SCHEMA_VERSION,
  CSP_REPORT_MAX_BODY_BYTES,
  isAcceptedCspReportContentType,
  parseCspReportPayload,
  type SanitizedCspReport,
} from "./cspReport";
// Issue #272 / ADR-0005 §2 "Encryption at Rest" + "Named prerequisites":
// the BFF session-bootstrap surface that issues the draft-key wrapping
// secret to the Studio. The store is in-process; the cookie helpers
// own the HttpOnly / SameSite / Secure flag plumbing.
import {
  createSessionStore,
  validateSessionIdentity,
  SessionIdentifierError,
  type RedactionPatternAddition,
  type SessionRecord,
  type SessionStore,
} from "./sessionStore";
import {
  isRequestSecure,
  parseSessionCookieFromRequest,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./sessionCookie";
import {
  createRateLimiter,
  resolveClientBucketKey,
  type RateLimiter,
} from "./rateLimit";

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const FORMAT_JAVA_JSON_ENVELOPE_BYTES = 8192;
const JAVA_EXECUTION_MAX_FILES = 512;
const TRUST_CASE_PREFERENCE_MAX_BODY_BYTES = 2048;
const FORBIDDEN_TRUST_CASE_TRANSFORM_FIELDS = [
  "sourceReferenceFixtureId",
  "sourceReferenceMode",
  "runtime",
  "runtimeArgs",
  "programArgs",
  "environment",
  "environmentProfile",
  "comparison",
  "comparisonStrategy",
  "trustCase",
  "trustCaseDefinition",
  "catalogVersion",
  "catalogHash",
  "configurationDigest",
  "evidenceIdentity",
] as const;

function formatJavaRawBodyMaxBytes(maxContentBytes: number): number {
  return maxContentBytes * 2 + FORMAT_JAVA_JSON_ENVELOPE_BYTES;
}

function isJavaSourceFilePath(filePath: string): boolean {
  return normalizeRequestJavaFilePath(filePath).toLowerCase().endsWith(".java");
}

function decodeRequestPath(rawPath: string): string {
  return rawPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

export interface ServerDeps {
  config: BffConfig;
  samples?: SampleRegistry;
  acceptanceFixtures?: AcceptanceFixtureRegistry;
  trustCases?: TrustCaseCatalog;
  orchestrator?: OrchestratorClient;
  evidence?: EvidenceClient;
  experienceLearning?: ExperienceLearningClient;
  modelGateway?: ModelGatewayClient;
  harness?: HarnessClient;
  // Studio-IDE-14 (#256): direct client for the deterministic Java
  // formatter on the build-test-runner-service. Optional so tests can
  // stub it.
  buildTestRunner?: BuildTestRunnerClient;
  httpClient?: HttpClient;
  runStore?: RunStore;
  // Studio-IDE-10 (#249): the editor-assist budget store and sequence
  // counter are process-scoped state. Tests inject pre-seeded
  // instances so individual integration tests can drive the
  // budget-exhaustion and per-tenant-per-day cap paths
  // deterministically.
  editorAssistBudgets?: EditorAssistBudgetStore;
  editorAssistSequence?: SequenceCounter;
  // Per-request collector for editor-assist trajectory ledger entries.
  // Production defaults to an append-only JSONL sink under
  // var/c2c-local; tests pass a capturing array to inspect the entry.
  editorAssistLedgerSink?: EditorAssistLedgerSink;
  // Issue #271 / ADR-0005 §6: sink for sanitized CSP violation
  // reports. Default writes one ``console.warn`` per report so the
  // existing log pipeline picks them up without new infra. Tests
  // pass a capturing array to assert on the canonical log shape and
  // to prove no PII leaks into the record.
  cspReportSink?: (report: SanitizedCspReport) => void;
  // Issue #272 / ADR-0005 §2: in-memory session store for the
  // draft-key wrapping secret. Tests inject a deterministic store
  // (seeded ``randomBytes``) to assert on exact secret values
  // without leaking platform randomness into the snapshot.
  sessionStore?: SessionStore;
  // Issue #272: rate limiter applied to ``POST /api/v0/session/sign-in``.
  // Tests inject a stub to make limit decisions deterministic.
  sessionSignInRateLimiter?: RateLimiter;
  now?: () => Date;
}

interface ResolvedDeps {
  config: BffConfig;
  samples: SampleRegistry;
  acceptanceFixtures: () => AcceptanceFixtureRegistry;
  trustCases: () => TrustCaseCatalog;
  orchestrator: OrchestratorClient;
  evidence: EvidenceClient;
  experienceLearning: ExperienceLearningClient;
  modelGateway: ModelGatewayClient;
  harness: HarnessClient;
  buildTestRunner: BuildTestRunnerClient;
  runStore: RunStore;
  editorAssistBudgets: EditorAssistBudgetStore;
  editorAssistSequence: SequenceCounter;
  editorAssistLedgerSink: EditorAssistLedgerSink;
  cspReportSink: (report: SanitizedCspReport) => void;
  sessionStore: SessionStore;
  sessionSignInRateLimiter: RateLimiter;
  now: () => Date;
}

function resolveDeps(deps: ServerDeps): ResolvedDeps {
  const httpClient = deps.httpClient ?? createNodeHttpClient();
  // Lazy-load the acceptance-fixture registry so the BFF can boot without
  // a populated fixtures/acceptance/index.json (kept out of unit-test
  // synthetic repos). Both success and failure are cached so a misconfigured
  // deployment doesn't re-hash the full corpus on every request.
  let acceptanceFixturesResult:
    | { ok: true; value: AcceptanceFixtureRegistry }
    | { ok: false; error: Error }
    | undefined = deps.acceptanceFixtures
    ? { ok: true, value: deps.acceptanceFixtures }
    : undefined;
  const acceptanceFixturesAccessor = (): AcceptanceFixtureRegistry => {
    if (!acceptanceFixturesResult) {
      try {
        acceptanceFixturesResult = {
          ok: true,
          value: loadAcceptanceFixtureRegistry(deps.config.repoRoot),
        };
      } catch (err) {
        acceptanceFixturesResult = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    if (!acceptanceFixturesResult.ok) {
      throw acceptanceFixturesResult.error;
    }
    return acceptanceFixturesResult.value;
  };
  let trustCasesResult:
    | { ok: true; value: TrustCaseCatalog }
    | { ok: false; error: Error }
    | undefined = deps.trustCases
    ? { ok: true, value: deps.trustCases }
    : undefined;
  const trustCasesAccessor = (): TrustCaseCatalog => {
    if (!trustCasesResult) {
      try {
        trustCasesResult = {
          ok: true,
          value: loadTrustCaseCatalog(
            deps.config.repoRoot,
            acceptanceFixturesAccessor(),
          ),
        };
      } catch (err) {
        trustCasesResult = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    if (!trustCasesResult.ok) {
      throw trustCasesResult.error;
    }
    return trustCasesResult.value;
  };
  return {
    config: deps.config,
    samples: deps.samples ?? loadSampleRegistry(deps.config.repoRoot),
    acceptanceFixtures: acceptanceFixturesAccessor,
    trustCases: trustCasesAccessor,
    orchestrator:
      deps.orchestrator ??
      createOrchestratorClient(
        deps.config.orchestratorUrl,
        httpClient,
        deps.config.upstreamTimeoutMs,
        deps.config.orchestratorControlToken,
      ),
    evidence:
      deps.evidence ??
      createEvidenceClient(
        deps.config.evidenceUrl,
        httpClient,
        deps.config.upstreamTimeoutMs,
      ),
    experienceLearning:
      deps.experienceLearning ??
      createExperienceLearningClient(
        deps.config.experienceLearningUrl,
        httpClient,
        deps.config.upstreamTimeoutMs,
      ),
    modelGateway:
      deps.modelGateway ??
      createModelGatewayClient(
        deps.config.modelGatewayUrl,
        httpClient,
        deps.config.upstreamTimeoutMs,
      ),
    harness:
      deps.harness ??
      createHarnessClient(
        deps.config.harnessUrl,
        httpClient,
        deps.config.upstreamTimeoutMs,
      ),
    buildTestRunner:
      deps.buildTestRunner ??
      createBuildTestRunnerClient(
        deps.config.buildTestRunnerUrl,
        httpClient,
        deps.config.formatJavaTimeoutMs,
        deps.config.buildTestRunnerControlToken,
      ),
    runStore: deps.runStore ?? createRunStore(deps.now),
    editorAssistBudgets:
      deps.editorAssistBudgets ??
      createEditorAssistBudgetStore({ now: deps.now }),
    editorAssistSequence: deps.editorAssistSequence ?? createSequenceCounter(),
    editorAssistLedgerSink:
      deps.editorAssistLedgerSink ??
      createJsonlEditorAssistLedgerSink(
        deps.config.editorAssistLedgerPath ??
          defaultEditorAssistLedgerPath(deps.config.repoRoot),
        { allowedRoot: deps.config.repoRoot },
      ),
    cspReportSink: deps.cspReportSink ?? defaultCspReportSink,
    sessionStore:
      deps.sessionStore ??
      createSessionStore({ now: deps.now ?? (() => new Date()) }),
    sessionSignInRateLimiter:
      deps.sessionSignInRateLimiter ?? createRateLimiter(),
    now: deps.now ?? (() => new Date()),
  };
}

function defaultEditorAssistLedgerPath(repoRoot: string): string {
  return path.resolve(
    repoRoot,
    "var",
    "c2c-local",
    "trajectory-ledger",
    "editor-assist.jsonl",
  );
}

export interface EditorAssistLedgerSink {
  (entry: EditorAssistLedgerEntry): void;
  preflight?: () => void;
}

export interface JsonlEditorAssistLedgerSinkOptions {
  allowedRoot?: string;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative))
  );
}

function ensureEditorAssistLedgerParentDirectory(
  targetPath: string,
  allowedRoot?: string,
): void {
  const parentPath = path.dirname(targetPath);
  if (allowedRoot === undefined) {
    fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    return;
  }

  const rootPath = path.resolve(allowedRoot);
  if (!isPathWithin(rootPath, targetPath)) {
    throw new Error("editor-assist ledger path escapes the allowed root");
  }

  const rootRealPath = fs.realpathSync.native(rootPath);
  const relativeParent = path.relative(rootPath, parentPath);
  let currentPath = rootPath;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const stat = fs.lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          "editor-assist ledger parent path contains a symlink",
        );
      }
      if (!stat.isDirectory()) {
        throw new Error(
          "editor-assist ledger parent path is not a directory",
        );
      }
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        throw err;
      }
      fs.mkdirSync(currentPath, { mode: 0o700 });
    }
  }

  const parentRealPath = fs.realpathSync.native(parentPath);
  if (!isPathWithin(rootRealPath, parentRealPath)) {
    throw new Error("editor-assist ledger parent path escapes the allowed root");
  }
}

export function createJsonlEditorAssistLedgerSink(
  ledgerPath: string,
  options: JsonlEditorAssistLedgerSinkOptions = {},
): EditorAssistLedgerSink {
  const targetPath = path.resolve(ledgerPath);
  const openFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_APPEND |
    fs.constants.O_NONBLOCK |
    (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | null = null;

  function openLedgerFile(): number {
    ensureEditorAssistLedgerParentDirectory(targetPath, options.allowedRoot);
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile()) {
        throw new Error("editor-assist ledger path is not a regular file");
      }
    } catch (err) {
      if (
        !(
          err &&
          typeof err === "object" &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }
    const opened = fs.openSync(targetPath, openFlags, 0o600);
    const stat = fs.fstatSync(opened);
    if (!stat.isFile()) {
      fs.closeSync(opened);
      throw new Error("editor-assist ledger path is not a regular file");
    }
    return opened;
  }

  const sink: EditorAssistLedgerSink = (entry) => {
    if (fd === null) fd = openLedgerFile();
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, "utf8");
  };
  sink.preflight = () => {
    if (fd === null) fd = openLedgerFile();
  };
  return sink;
}

// Default CSP-report log shape: one structured ``warn`` per report
// so existing log shippers can pick the records up without
// dedicated infra. The shape is intentionally stable — any change
// requires a ``CSP_REPORT_LOG_SCHEMA_VERSION`` bump in
// ``./cspReport.ts``. PII has already been stripped at the
// boundary; this function only formats.
function defaultCspReportSink(report: SanitizedCspReport): void {
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      kind: "csp_violation",
      schemaVersion: CSP_REPORT_LOG_SCHEMA_VERSION,
      report,
    }),
  );
}

// Issue #272 — body size cap for fixture sign-in. The endpoint only
// reads optional ``{tenantId, userId}`` plus reviewed literal
// redaction additions. 10 KiB covers the bounded addition list while
// staying far below any pathological payload.
const SESSION_SIGN_IN_MAX_BODY_BYTES = 10_240;

// Issue #272 — opaque pseudonymous identifier minting for the dev /
// fixture sign-in path. When the request body omits an override, the
// BFF mints a UUID-shaped opaque token using the session store's
// own random source (so tests with a seeded ``randomBytes`` see
// deterministic values).
//
// The body override is accepted so test harnesses and dev tooling
// can drive specific ``(tenantId, userId)`` pairs through the
// system. The validator rejects ``@`` / whitespace / out-of-class
// characters per ADR-0005 §3, so a hostile client cannot smuggle
// an email or display-name through this path.
function resolveFixtureSignInIdentity(
  raw: unknown,
  _store: SessionStore,
): {
  tenantId: string;
  userId: string;
  studioRedactionPatternAdditions?: RedactionPatternAddition[];
} {
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const tenantOverride =
    typeof body.tenantId === "string" ? body.tenantId : undefined;
  const userOverride =
    typeof body.userId === "string" ? body.userId : undefined;
  const tenantId = tenantOverride ?? mintFixtureIdentifier("tenant");
  const userId = userOverride ?? mintFixtureIdentifier("user");
  const rawAdditions = body.studioRedactionPatternAdditions;
  if (rawAdditions !== undefined && !Array.isArray(rawAdditions)) {
    throw new SessionIdentifierError(
      "studioRedactionPatternAdditions must be an array",
    );
  }
  const additions = rawAdditions
    ? rawAdditions.map((entry) => entry as RedactionPatternAddition)
    : undefined;
  // Re-validate even when minted internally so a regression in the
  // mint helper cannot bypass the @ / whitespace rule.
  validateSessionIdentity({
    tenantId,
    userId,
    ...(additions ? { studioRedactionPatternAdditions: additions } : {}),
  });
  return {
    tenantId,
    userId,
    ...(additions ? { studioRedactionPatternAdditions: additions } : {}),
  };
}

// Mints a ``<prefix>-<16 random hex chars>`` opaque identifier for
// the fixture sign-in path. Production deployments with a real
// identity layer behind the bootstrap supply ``tenantId`` / ``userId``
// from the IdP response and never call this helper (the route
// handler returns 404 when ``enableFixtureSessions`` is false).
function mintFixtureIdentifier(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFound(res: http.ServerResponse, message = "not found"): void {
  jsonResponse(res, 404, { error: message });
}

function badRequest(res: http.ServerResponse, message: string): void {
  jsonResponse(res, 400, { error: message });
}

function trustCaseCatalogResponse(
  catalog: TrustCaseCatalog,
  programId: string | undefined,
  savedTrustCaseId: string | null,
): Record<string, unknown> {
  const trustCases = catalog.list(programId);
  const defaultTrustCaseId = programId
    ? catalog.defaultForProgram(programId)?.trustCaseId ?? null
    : trustCases.find((entry) => entry.defaultForProgram)?.trustCaseId ?? null;
  return {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    catalogHash: catalog.catalogHash,
    programId: programId ?? null,
    defaultTrustCaseId,
    savedTrustCaseId,
    trustCases,
  };
}

function sessionTrustCasePreference(
  req: http.IncomingMessage,
  sessionStore: SessionStore,
  programId: string,
): string | null {
  const sessionId = parseSessionCookieFromRequest(req);
  if (!sessionId) return null;
  return sessionStore.getTrustCasePreference(sessionId, programId);
}

function forbiddenTrustCaseTransformFields(
  body: Record<string, unknown>,
): string[] {
  return FORBIDDEN_TRUST_CASE_TRANSFORM_FIELDS.filter(
    (field) => body[field] !== undefined,
  ).map((field) => String(field));
}

function parseRequestOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isSameRequestHost(req: http.IncomingMessage, origin: string): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(
  req: http.IncomingMessage,
  allowedOrigins: readonly string[],
): boolean {
  const rawOrigin = req.headers.origin;
  if (rawOrigin !== undefined) {
    if (typeof rawOrigin !== "string" || rawOrigin.length === 0) return false;
  }
  const origin = parseRequestOrigin(req);
  if (origin === null) return rawOrigin === undefined;
  return isSameRequestHost(req, origin) || allowedOrigins.includes(origin);
}

function rejectDisallowedBrowserOrigin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: readonly string[],
): boolean {
  if (isAllowedBrowserOrigin(req, allowedOrigins)) return false;
  jsonResponse(res, 403, { error: "origin not allowed" });
  return true;
}

function rejectNonJsonContentType(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.toLowerCase().startsWith("application/json")) return false;
  jsonResponse(res, 415, {
    error: "request must use Content-Type: application/json",
  });
  return true;
}

function appendVaryHeader(res: http.ServerResponse, fieldName: string): void {
  const existing = res.getHeader("vary");
  if (existing === undefined) {
    res.setHeader("vary", fieldName);
    return;
  }
  const value = Array.isArray(existing) ? existing.join(", ") : String(existing);
  const fields = value.split(",").map((field) => field.trim().toLowerCase());
  if (fields.includes("*") || fields.includes(fieldName.toLowerCase())) return;
  res.setHeader("vary", value.length > 0 ? `${value}, ${fieldName}` : fieldName);
}

function applyLocalApiCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const origin = parseRequestOrigin(req);
  if (origin === null || !allowedOrigins.includes(origin)) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  // Cookie-authenticated routes require credentials, but only for exact
  // configured Studio origins. Reflecting arbitrary localhost origins would
  // let another local page read and spend a user's editor-assist session.
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-max-age", "600");
  appendVaryHeader(res, "Origin");
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 1_000_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBytes) {
        tooLarge = true;
        reject(new Error("request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(root: string, requested: string): string | undefined {
  const normalized = path.posix.normalize(requested);
  if (normalized.includes("\0")) return undefined;
  const candidate = path.resolve(
    root,
    "." + (normalized.startsWith("/") ? normalized : "/" + normalized),
  );
  if (candidate !== root && !candidate.startsWith(root + path.sep))
    return undefined;
  return candidate;
}

function serveStatic(
  res: http.ServerResponse,
  staticRoot: string,
  requestedPath: string,
): boolean {
  if (!fs.existsSync(staticRoot)) return false;
  let target = requestedPath;
  if (target === "/" || target === "") target = "/index.html";
  const resolved = safeJoin(staticRoot, target);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) {
    // SPA fallback to index.html for unknown paths
    const indexFile = path.join(staticRoot, "index.html");
    if (!fs.existsSync(indexFile)) return false;
    const html = fs.readFileSync(indexFile);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
      "cache-control": "no-store",
    });
    res.end(html);
    return true;
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const indexFile = path.join(resolved, "index.html");
    if (!fs.existsSync(indexFile)) return false;
    const html = fs.readFileSync(indexFile);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
      "cache-control": "no-store",
    });
    res.end(html);
    return true;
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = STATIC_MIME[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};

  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseBooleanString(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function normalizeModelGatewayRoleAvailability(
  payload: unknown,
): Record<string, unknown>[] {
  const body = asRecord(payload) ?? {};
  const roles = Array.isArray(body.roles) ? body.roles : [];
  return roles
    .map((entry) => {
      const role = asRecord(entry) ?? {};
      return {
        role: asString(role.role),
        status: asString(role.status),
        policyId: asString(role.policyId),
        availableModels: asStringArray(role.availableModels),
        configuredModels: asStringArray(role.configuredModels),
        reason: asString(role.reason),
      };
    })
    .filter((entry) => entry.role.length > 0 && entry.status.length > 0);
}

function normalizeModelGatewayCapabilitiesView(
  payload: unknown,
): Record<string, unknown> {
  const body = asRecord(payload) ?? {};
  const providerMode = asString(body.provider);
  const policyId = asString(body.policyId);
  const roles = normalizeModelGatewayRoleAvailability(body);
  const anyUnavailable = roles.some((entry) => entry.status !== "ok");
  return {
    status: anyUnavailable ? "degraded" : "ok",
    providerMode,
    policyId,
    roles,
  };
}

function normalizeModelGatewayHealthView(
  payload: unknown,
  capabilitiesPayload?: unknown,
): Record<string, unknown> {
  const body = asRecord(payload) ?? {};
  const configured = asStringRecord(body.configured);
  const providerMode =
    configured.mode || configured.modelProvider || asString(body.status);
  const activeModelCount =
    asNumber(body.activeModels) ?? asNumber(body.activeModelCount) ?? 0;
  const dataPolicy = configured.dataPolicy;
  const ledgerEnabled =
    parseBooleanString(configured.invocationLedgerEnabled ?? "") ??
    asBoolean(body.ledgerEnabled) ??
    false;
  const eventEmission =
    parseBooleanString(configured.harnessEventEmissionEnabled ?? "") ??
    asBoolean(body.eventEmission) ??
    false;

  return {
    status: "ok",
    providerMode,
    activeModelCount,
    dataPolicy,
    ledgerEnabled,
    eventEmission,
    policyId: asString(body.policyId) || configured.policyId || "",
    roleAvailability:
      normalizeModelGatewayRoleAvailability(capabilitiesPayload),
  };
}

function modelGatewayViewHasCallableTransformationModel(
  payload: Record<string, unknown>,
): boolean {
  const activeModelCount = asNumber(payload.activeModelCount);
  if (activeModelCount !== undefined && activeModelCount > 0) {
    return true;
  }

  const roles = Array.isArray(payload.roleAvailability)
    ? payload.roleAvailability
    : [];
  return roles.some((entry) => {
    const role = asRecord(entry) ?? {};
    return (
      asString(role.role) === "transformation" &&
      asString(role.status) === "ok" &&
      asStringArray(role.availableModels).length > 0
    );
  });
}

async function verifyTransformationModelGatewayAvailable(
  modelGateway: ModelGatewayClient,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!modelGateway.enabled) {
    return {
      ok: false,
      message: "Model Gateway is required while AI Assist is enabled.",
    };
  }

  try {
    const health = await modelGateway.getHealth();
    if (!health || health.status < 200 || health.status >= 300) {
      return {
        ok: false,
        message: "Model Gateway is unavailable while AI Assist is enabled.",
      };
    }

    let capabilitiesBody: unknown;
    try {
      const capabilities = await modelGateway.getCapabilities();
      if (
        capabilities &&
        capabilities.status >= 200 &&
        capabilities.status < 300
      ) {
        capabilitiesBody = capabilities.body;
      }
    } catch {
      capabilitiesBody = undefined;
    }

    const view = normalizeModelGatewayHealthView(health.body, capabilitiesBody);
    if (!modelGatewayViewHasCallableTransformationModel(view)) {
      return {
        ok: false,
        message: "No transformation model is currently available.",
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Model Gateway is unavailable while AI Assist is enabled.",
    };
  }
}

function normalizeModelGatewayModelsView(
  payload: unknown,
): Record<string, unknown> {
  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray((asRecord(payload) ?? {}).models)
      ? ((asRecord(payload) ?? {}).models as unknown[])
      : [];

  return {
    models: rawModels
      .map((entry) => {
        const model = asRecord(entry) ?? {};
        return {
          id: asString(model.id) || asString(model.ID),
          name:
            asString(model.name) ||
            asString(model.displayName) ||
            asString(model.DisplayName),
          provider: asString(model.provider) || asString(model.Provider),
        };
      })
      .filter(
        (entry) =>
          entry.id.length > 0 &&
          entry.name.length > 0 &&
          entry.provider.length > 0,
      ),
  };
}

function normalizeHarnessReadyView(payload: unknown): Record<string, unknown> {
  const body = asRecord(payload) ?? {};
  const capabilities = asNumber(body.capabilities);
  const runs = asNumber(body.runs);
  const policyGateway = asString(body.policyGateway);
  const summaryParts = [
    capabilities !== undefined ? `${capabilities} capabilities registered` : "",
    runs !== undefined ? `${runs} runs tracked` : "",
    policyGateway ? `policy gateway ${policyGateway}` : "",
  ].filter((part) => part.length > 0);

  return {
    ...body,
    status: "ok",
    summary: summaryParts.join(" • "),
  };
}

interface OutputRef {
  sha256: string;
  byteSize?: number;
  kind?: string;
  path?: string;
  name?: string;
  mimeType?: string;
  createdBy?: string;
  createdAt?: string;
}

function sanitizeManualRepairArtifactRef(raw: unknown): OutputRef | null {
  return normalizeOutputRef(raw);
}

function sanitizeManualRepairDiagnosis(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sanitized: Record<string, unknown> = { ...record };
  for (const key of [
    "buildResultRef",
    "executionResultRef",
    "comparisonResultRef",
    "sourceRevisionRef",
    "currentHeadRef",
  ] as const) {
    if (record[key] !== undefined) {
      sanitized[key] = sanitizeManualRepairArtifactRef(record[key]);
    }
  }
  if (Array.isArray(record.evidenceRefs)) {
    sanitized.evidenceRefs = record.evidenceRefs
      .map((entry) => sanitizeManualRepairArtifactRef(entry))
      .filter((entry): entry is OutputRef => entry !== null);
  }
  const followUp = asRecord(record.followUpRecommendation);
  if (followUp) {
    const sanitizedFollowUp: Record<string, unknown> = { ...followUp };
    if (Array.isArray(followUp.evidenceRefs)) {
      sanitizedFollowUp.evidenceRefs = followUp.evidenceRefs
        .map((entry) => sanitizeManualRepairArtifactRef(entry))
        .filter((entry): entry is OutputRef => entry !== null);
    }
    sanitized.followUpRecommendation = sanitizedFollowUp;
  }
  return sanitized;
}

function sanitizeManualRepairProposal(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sanitized: Record<string, unknown> = { ...record };
  for (const key of ["sourceRevisionRef", "currentHeadRef"] as const) {
    if (record[key] !== undefined) {
      sanitized[key] = sanitizeManualRepairArtifactRef(record[key]);
    }
  }
  if (Array.isArray(record.evidenceRefs)) {
    sanitized.evidenceRefs = record.evidenceRefs
      .map((entry) => sanitizeManualRepairArtifactRef(entry))
      .filter((entry): entry is OutputRef => entry !== null);
  }
  return sanitized;
}

function sanitizeManualRepairResponseBody(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const sanitized: Record<string, unknown> = { ...record };
  if (record.diagnosis !== undefined) {
    sanitized.diagnosis =
      sanitizeManualRepairDiagnosis(record.diagnosis) ?? record.diagnosis;
  }
  if (record.proposal !== undefined && record.proposal !== null) {
    sanitized.proposal =
      sanitizeManualRepairProposal(record.proposal) ?? record.proposal;
  }
  return sanitized;
}

async function liveGeneratedView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(
        stored,
        ["generation-response"],
        "Live run id is unavailable; orchestrator has not yet accepted this run.",
      ),
      entryClass: "",
      entryFilePath: "",
      files: {},
      fileRefs: [],
      outputRef: null,
      diagnostics: [],
      unsupportedFeatures: [],
      openAssumptions: [],
    };
  }
  try {
    const upstream = await orchestrator.getGenerated(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(
          stored,
          ["generation-response"],
          "Orchestrator did not return generated-Java artifacts for this run.",
        ),
        entryClass: "",
        entryFilePath: "",
        files: {},
        fileRefs: [],
        outputRef: null,
        diagnostics: [],
        unsupportedFeatures: [],
        openAssumptions: [],
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const runStatus = asString(envelope.runStatus);
    const filesRaw = asRecord(envelope.files) ?? {};
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(filesRaw)) {
      if (typeof value === "string") files[key] = value;
    }
    let status = classifyGeneratedStatus(missing, runStatus);
    const generationResponse = asRecord(envelope.generationResponse);
    const outputRef = normalizeOutputRef(envelope.generationResponseRef);
    const diagnostics = normalizeDiagnostics(generationResponse?.diagnostics, {
      defaultSourceKind: "generated_java",
    });
    const entryFilePath = asString(envelope.entryFilePath);
    let missingArtifacts = missing;
    let placeholderViolation: { path: string; marker: string } | null = null;
    if (status === "generated") {
      const hit = findPlaceholderInFiles(files);
      if (hit) {
        // Safeguard (Issue #85): never let placeholder Java reach the UI as a
        // successful product run. Downgrade to incomplete and mark the offence.
        status = "incomplete";
        placeholderViolation = { path: hit.path, marker: hit.marker };
        missingArtifacts = [...missingArtifacts, "real-generated-java"];
      }
    }
    const artifactRef = normalizeOutputRef(envelope.artifactRef);
    const traceability = normalizeGeneratedTraceability(envelope.traceability);
    const fileRefs = normalizeGeneratedFileRefs(envelope.fileRefs);
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: "live",
      productMode:
        status === "generated" && !placeholderViolation
          ? "live"
          : "unavailable",
      status,
      entryClass: asString(envelope.entryClass),
      entryFilePath,
      files: {},
      fileCount: asNumber(envelope.fileCount) ?? Object.keys(files).length,
      fileRefs,
      unsupportedFeatures: Array.isArray(envelope.unsupportedFeatures)
        ? envelope.unsupportedFeatures
        : [],
      openAssumptions: Array.isArray(envelope.openAssumptions)
        ? envelope.openAssumptions
        : [],
      missingArtifacts,
      orchestratorRunId: liveRunId,
      outputRef,
      artifactRef,
      ...(traceability ? { traceability } : {}),
      generationResponseRef: outputRef,
      diagnostics,
      ...(placeholderViolation ? { placeholderViolation } : {}),
      ...(placeholderViolation
        ? {
            note: `Placeholder marker "${placeholderViolation.marker}" detected in ${placeholderViolation.path}; refusing to serve as product output.`,
          }
        : {}),
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(
        stored,
        ["generation-response"],
        sanitizeUpstreamMessage(
          err instanceof Error ? err.message : "",
          "orchestrator request failed",
        ),
      ),
      entryClass: "",
      entryFilePath: "",
      files: {},
      fileRefs: [],
      outputRef: null,
      diagnostics: [],
      unsupportedFeatures: [],
      openAssumptions: [],
    };
  }
}

function deriveCompileStatus(
  data: Record<string, unknown> | undefined,
  status: string,
): "ok" | "failed" | "skipped" | "unknown" {
  const build = asRecord(data?.build);
  if (build && typeof build.compileOk === "boolean") {
    return build.compileOk ? "ok" : "failed";
  }
  if (build) {
    const buildStatus = asString(build.status).toLowerCase();
    if (buildStatus === "ok" || buildStatus === "success" || buildStatus === "passed") {
      return "ok";
    }
    if (
      buildStatus === "failed" ||
      buildStatus === "failure" ||
      buildStatus === "error"
    ) {
      return "failed";
    }
    if (buildStatus === "skipped") {
      return "skipped";
    }
  }
  if (status === "compile-failed") return "failed";
  if (status === "skipped") return "skipped";
  return "unknown";
}

function deriveExecutionStatus(
  data: Record<string, unknown> | undefined,
  status: string,
): "ok" | "failed" | "skipped" | "not-run" | "unknown" {
  const execution = asRecord(data?.execution);
  if (execution) {
    if (execution.ran === false) {
      return status === "skipped" ? "skipped" : "not-run";
    }
    if (typeof execution.ok === "boolean")
      return execution.ok ? "ok" : "failed";
    const executionStatus = asString(execution.status).toLowerCase();
    if (
      executionStatus === "ok" ||
      executionStatus === "success" ||
      executionStatus === "passed"
    ) {
      return "ok";
    }
    if (
      executionStatus === "failed" ||
      executionStatus === "failure" ||
      executionStatus === "error"
    ) {
      return "failed";
    }
    if (executionStatus === "skipped") return "skipped";
    if (executionStatus === "not-run") return "not-run";
    const exitCode = execution.exitCode;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      return exitCode === 0 ? "ok" : "failed";
    }
  }
  if (status === "run-failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "compile-failed") return "not-run";
  return "unknown";
}

function deriveActualOutput(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  if (typeof data.actualOutput === "string") return data.actualOutput;
  const execution = asRecord(data.execution);
  if (execution && typeof execution.actualOutput === "string")
    return execution.actualOutput;
  if (execution && typeof execution.stdout === "string")
    return execution.stdout;
  if (execution && typeof execution.output === "string")
    return execution.output;
  return "";
}

function deriveExpectedOutput(
  data: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!data) return fallback;
  if (typeof data.expectedOutput === "string") return data.expectedOutput;
  const execution = asRecord(data.execution);
  if (execution && typeof execution.expectedOutput === "string")
    return execution.expectedOutput;
  const golden = asRecord(data.goldenMaster);
  if (golden && typeof golden.expected === "string") return golden.expected;
  if (golden && typeof golden.expectedOutput === "string")
    return golden.expectedOutput;
  const comparison = asRecord(data.comparison);
  if (comparison && typeof comparison.expected === "string")
    return comparison.expected;
  if (comparison && typeof comparison.expectedOutput === "string")
    return comparison.expectedOutput;
  return fallback;
}

const BUILD_TEST_TEXT_FIELD_MAX_CHARS = 16_384;
const PARITY_DIFF_SUMMARY_MAX_CHARS = 4_000;

function boundedStudioText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated for Studio payload boundary]`;
}

function normalizeParityComparison(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const comparisonResult = asRecord(data?.comparisonResult);
  const comparison = comparisonResult ?? asRecord(data?.comparison);
  if (!comparison) return null;
  const result: Record<string, unknown> = {};
  const matched = asBoolean(comparison.matched);
  if (matched !== undefined) result.matched = matched;
  const status = asString(comparison.status);
  if (status.length > 0) result.status = status;
  const comparisonPolicyVersion = asString(comparison.comparisonPolicyVersion);
  if (comparisonPolicyVersion.length > 0) {
    result.comparisonPolicyVersion = comparisonPolicyVersion;
  }
  const mismatchClassification = asString(comparison.mismatchClassification);
  if (mismatchClassification.length > 0) {
    result.mismatchClassification = mismatchClassification;
  }
  const diffSummary = asString(comparison.diffSummary);
  if (diffSummary.length > 0) {
    result.diffSummary = boundedStudioText(
      diffSummary,
      PARITY_DIFF_SUMMARY_MAX_CHARS,
    );
  }
  for (const key of [
    "comparisonPolicyRef",
    "comparisonResultRef",
    "diffRef",
    "expectedRef",
    "actualRef",
    "sourceOutputRef",
    "javaOutputRef",
    "sourceNormalizedOutputRef",
    "javaNormalizedOutputRef",
    "normalizedDiffRef",
  ] as const) {
    const ref = normalizeOutputRef(comparison[key]);
    if (ref) result[key] = ref;
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function liveBuildTestView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(
        stored,
        ["build-test-result"],
        "Live run id is unavailable; orchestrator has not yet accepted this run.",
      ),
      classification: "skipped-no-execution",
      compileStatus: "unknown",
      executionStatus: "unknown",
      expectedOutput: stored.sample.expectedOutput,
      actualOutput: "",
      outputRef: null,
      expectedOutputRef: null,
      actualOutputRef: null,
      diagnostics: [],
    };
  }
  try {
    const upstream = await orchestrator.getBuildTest(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(
          stored,
          ["build-test-result"],
          "Orchestrator did not return a build/test result for this run.",
        ),
        classification: "skipped-no-execution",
        compileStatus: "unknown",
        executionStatus: "unknown",
        expectedOutput: stored.sample.expectedOutput,
        actualOutput: "",
        outputRef: null,
        expectedOutputRef: null,
        actualOutputRef: null,
        diagnostics: [],
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const runStatus = asString(envelope.runStatus);
    const { status, classification } = classifyBuildTestStatus(
      missing,
      runStatus,
      data,
    );
    const outputRef = normalizeOutputRef(data?.outputRef);
    const comparison = normalizeParityComparison(data);
    const diagnostics = normalizeDiagnostics(data?.diagnostics, {
      defaultSourceKind: "build",
    });
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: "live",
      productMode: status === "ok" ? "live" : "unavailable",
      status,
      classification,
      compileStatus: deriveCompileStatus(data, status),
      executionStatus: deriveExecutionStatus(data, status),
      expectedOutput: boundedStudioText(
        deriveExpectedOutput(data, stored.sample.expectedOutput),
        BUILD_TEST_TEXT_FIELD_MAX_CHARS,
      ),
      actualOutput: boundedStudioText(
        deriveActualOutput(data),
        BUILD_TEST_TEXT_FIELD_MAX_CHARS,
      ),
      comparison,
      diffSummary:
        typeof comparison?.diffSummary === "string"
          ? comparison.diffSummary
          : "",
      outputRef,
      expectedOutputRef: deriveComparisonOutputRef(data, "expectedRef"),
      actualOutputRef: deriveComparisonOutputRef(data, "actualRef"),
      diagnostics,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      generatedArtifactRef: normalizeOutputRef(envelope.generatedArtifactRef),
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(
        stored,
        ["build-test-result"],
        sanitizeUpstreamMessage(
          err instanceof Error ? err.message : "",
          "orchestrator request failed",
        ),
      ),
      classification: "skipped-no-execution",
      compileStatus: "unknown",
      executionStatus: "unknown",
      expectedOutput: stored.sample.expectedOutput,
      actualOutput: "",
      outputRef: null,
      expectedOutputRef: null,
      actualOutputRef: null,
      diagnostics: [],
    };
  }
}

async function liveEvidenceView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(
        stored,
        ["evidence-pack-manifest"],
        "Live run id is unavailable; orchestrator has not yet accepted this run.",
      ),
      packId: "",
      manifestHash: "",
      validationStatus: "unknown",
      exportRef: null,
    };
  }
  try {
    const upstream = await orchestrator.getEvidence(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(
          stored,
          ["evidence-pack-manifest"],
          "Orchestrator did not return an evidence pack manifest for this run.",
        ),
        packId: "",
        manifestHash: "",
        validationStatus: "unknown",
        exportRef: null,
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const artifactRef = asRecord(envelope.artifactRef);
    const envelopeMissing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const validationMissing = deriveMissingFromValidation(data);
    const missing = Array.from(
      new Set([...envelopeMissing, ...validationMissing]),
    );
    const packId = asString(data?.packId);
    const manifestHash = asString(artifactRef?.sha256);
    const exportRef = deriveExportRef(data);
    const validationStatus = deriveValidationStatus(data);
    const status: "complete" | "incomplete" | "invalid" =
      missing.length === 0 && validationStatus === "valid"
        ? "complete"
        : validationStatus === "invalid"
          ? "invalid"
          : "incomplete";
    // ADR 0007 (#257, Issue #279): surface the orchestrator's manual-edit
    // provenance summary and the persisted overlay reference so the Studio
    // can fetch the per-region overlay JSON for audit review. The signals
    // mirror the W02RunContract / evidence-pack manifest fields; absence is
    // legal (pre-ADR-0007 runs, or runs with no manual edits) and consumers
    // treat absence as ``false`` / ``0`` / ``null`` per ADR 0006 §2.
    const manualEditsCarriedOver = data?.manualEditsCarriedOver === true;
    const manualDriftRegionCountRaw = asNumber(data?.manualDriftRegionCount);
    const manualDriftRegionCount =
      manualDriftRegionCountRaw !== undefined &&
      Number.isInteger(manualDriftRegionCountRaw) &&
      manualDriftRegionCountRaw >= 0
        ? manualDriftRegionCountRaw
        : 0;
    const manualEditOverlay = deriveManualEditOverlayRef(data);
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: "live",
      productMode: status === "complete" ? "live" : "unavailable",
      status,
      packId,
      manifestHash,
      validationStatus,
      exportRef,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      artifactRef: normalizeOutputRef(artifactRef),
      generatedArtifactRef: normalizeOutputRef(envelope.generatedArtifactRef),
      manualEditsCarriedOver,
      manualDriftRegionCount,
      manualEditOverlay,
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(
        stored,
        ["evidence-pack-manifest"],
        sanitizeUpstreamMessage(
          err instanceof Error ? err.message : "",
          "orchestrator request failed",
        ),
      ),
      packId: "",
      manifestHash: "",
      validationStatus: "unknown",
      exportRef: null,
    };
  }
}

// Studio-IDE-6 (#248): trust-pillar traceability types.
interface JavaRegionClassification {
  schemaVersion: "v0";
  lineRange: { startLine: number; endLine: number };
  originClass: JavaOriginClass;
  verificationOutcome: JavaVerificationOutcome;
  mappingClass: JavaMappingClass;
}

type JavaOriginClass =
  | "deterministic"
  | "agent_proposed"
  | "repair_attempted"
  | "manual_modified"
  | "manual_edit";

type JavaVerificationOutcome =
  | "oracle_passed"
  | "oracle_failed"
  | "no_oracle";

type JavaMappingClass =
  | "direct"
  | "aggregated"
  | "synthesized"
  | "agent_originated";

const JAVA_ORIGIN_CLASSES = new Set<string>([
  "deterministic",
  "agent_proposed",
  "repair_attempted",
  "manual_modified",
  "manual_edit",
]);

const JAVA_VERIFICATION_OUTCOMES = new Set<string>([
  "oracle_passed",
  "oracle_failed",
  "no_oracle",
]);

const JAVA_MAPPING_CLASSES = new Set<string>([
  "direct",
  "aggregated",
  "synthesized",
  "agent_originated",
]);

function isSafeClassificationMapKey(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

async function liveTraceabilityView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<{
  view: Record<string, unknown>;
  cacheJavaRegionClassification: boolean;
}> {
  const stubEnvelope = {
    schemaVersion: "v0" as const,
    runId: stored.runId,
    programId: stored.programId,
    trace: null,
    irSymbolMap: {},
    javaRegionClassification: null,
  };
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      view: {
        ...stubEnvelope,
        note: "Live run id is unavailable; traceability cannot be served.",
      },
      cacheJavaRegionClassification: false,
    };
  }
  try {
    const upstream = await orchestrator.getTraceability(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        view: {
          ...stubEnvelope,
          note: `Traceability upstream returned ${
            upstream?.status ?? "no response"
          }; traceability cannot be served.`,
        },
        cacheJavaRegionClassification: false,
      };
    }
    const body = asRecord(upstream.body) ?? {};
    const traceRaw = body.trace;
    const trace =
      traceRaw !== null &&
      typeof traceRaw === "object" &&
      !Array.isArray(traceRaw)
        ? (traceRaw as Record<string, unknown>)
        : null;
    const irSymbolMapRaw = asRecord(body.irSymbolMap) ?? {};
    const irSymbolMap: Record<
      string,
      { cobolFile: string; cobolLine: number }
    > = {};
    for (const [key, val] of Object.entries(irSymbolMapRaw)) {
      const entry = asRecord(val);
      if (!entry) continue;
      const cobolFile = asString(entry.cobolFile);
      const cobolLine = asNumber(entry.cobolLine);
      if (cobolFile && cobolLine !== undefined && Number.isInteger(cobolLine)) {
        irSymbolMap[key] = { cobolFile, cobolLine };
      }
    }
    const javaRegionClassification = normalizeJavaRegionClassification(
      body.javaRegionClassification,
    );
    return {
      view: {
        schemaVersion: "v0" as const,
        runId: stored.runId,
        programId: stored.programId,
        trace,
        irSymbolMap,
        javaRegionClassification,
      },
      cacheJavaRegionClassification: true,
    };
  } catch {
    return {
      view: {
        ...stubEnvelope,
        note:
          "Traceability upstream request failed; traceability cannot be served.",
      },
      cacheJavaRegionClassification: false,
    };
  }
}

// Issue #96: pipeline progress envelope shown by the UI.
type PipelineStepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

interface PipelineStep {
  stepId: number;
  name: string;
  capabilityId: string;
  service: string;
  actor: string;
  status: PipelineStepStatus;
  startedAt?: string;
  finishedAt?: string;
  diagnostic?: string;
  inputRef?: OutputRef | null;
  outputRef?: OutputRef | null;
  latencyMs?: number;
}

interface UiRunEvent {
  type?: string;
  status?: string;
  message?: string;
  createdAt?: string;
}

const PIPELINE_STEP_STATUSES: ReadonlyArray<PipelineStepStatus> = [
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
];

const FAILED_STEP_DIAGNOSTIC_FALLBACK =
  "Step failed. See workflow failure details for the classified reason.";
const SKIPPED_STEP_DIAGNOSTIC_FALLBACK = "Step skipped by workflow policy.";
const UNSAFE_PROGRESS_DIAGNOSTIC_PATTERNS: ReadonlyArray<RegExp> = [
  /["']?(sourceText|expectedOutput|oracleInput|baselineFiles|previousJavaFiles|buildTestPayload|inputRef|outputRef)["']?\s*:/i,
  /\bIDENTIFICATION\s+DIVISION\b/i,
  /\bPROCEDURE\s+DIVISION\b/i,
  /\bpublic\s+class\b/i,
];

function asPipelineStepStatus(value: unknown): PipelineStepStatus {
  if (typeof value === "string") {
    for (const candidate of PIPELINE_STEP_STATUSES) {
      if (candidate === value) return candidate;
    }
  }
  return "pending";
}

function sanitizeProgressDiagnostic(
  diagnostic: string,
  status: PipelineStepStatus,
): string {
  if (status === "skipped") return SKIPPED_STEP_DIAGNOSTIC_FALLBACK;
  const fallback =
    status === "failed"
      ? FAILED_STEP_DIAGNOSTIC_FALLBACK
      : "Step diagnostic unavailable.";
  const sanitized = sanitizeUpstreamMessage(diagnostic, fallback);
  if (status !== "failed") return sanitized;
  if (sanitized === fallback) return fallback;
  if (
    UNSAFE_PROGRESS_DIAGNOSTIC_PATTERNS.some((pattern) =>
      pattern.test(sanitized),
    )
  ) {
    return fallback;
  }
  return sanitized;
}

async function liveProgressView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  const baseEnvelope = {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
  };
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...baseEnvelope,
      status: "incomplete",
      runStatus: stored.status,
      currentStep: null,
      failedStep: null,
      completedSteps: [],
      stepCount: 0,
      steps: [],
      missingArtifacts: ["run-progress"],
      note: "Live run id is unavailable; orchestrator has not yet accepted this run.",
    };
  }
  try {
    const upstream = await orchestrator.getProgress(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...baseEnvelope,
        status: "incomplete",
        runStatus: stored.status,
        currentStep: null,
        failedStep: null,
        completedSteps: [],
        stepCount: 0,
        steps: [],
        missingArtifacts: ["run-progress"],
        orchestratorRunId: liveRunId,
        note: "Orchestrator did not return a progress timeline for this run.",
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const rawSteps = Array.isArray(envelope.steps) ? envelope.steps : [];
    const steps = rawSteps
      .map((entry) => normalizePipelineStep(entry))
      .filter((entry): entry is PipelineStep => entry !== null);
    const failedStepRaw = envelope.failedStep;
    const currentStepRaw = envelope.currentStep;
    const completedRaw = Array.isArray(envelope.completedSteps)
      ? envelope.completedSteps
      : [];
    const completed = completedRaw.filter(
      (entry): entry is string => typeof entry === "string",
    );
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      ...baseEnvelope,
      mode: "live",
      productMode: "live",
      status: missing.length === 0 ? "complete" : "incomplete",
      runStatus: asString(envelope.runStatus) || stored.status,
      currentStep: typeof currentStepRaw === "string" ? currentStepRaw : null,
      failedStep: typeof failedStepRaw === "string" ? failedStepRaw : null,
      completedSteps: completed,
      stepCount: steps.length,
      steps,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
    };
  } catch (err) {
    return {
      ...baseEnvelope,
      status: "incomplete",
      runStatus: stored.status,
      currentStep: null,
      failedStep: null,
      completedSteps: [],
      stepCount: 0,
      steps: [],
      missingArtifacts: ["run-progress"],
      note: sanitizeUpstreamMessage(
        err instanceof Error ? err.message : "",
        "orchestrator request failed",
      ),
    };
  }
}

async function liveLearningView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
  experienceLearning: ExperienceLearningClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  const baseEnvelope = {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
  };
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...baseEnvelope,
      status: "incomplete",
      summary: null,
      source: "unavailable",
      missingArtifacts: ["learning-summary"],
      note: "Live run id is unavailable; orchestrator has not yet accepted this run.",
    };
  }
  // Prefer the EL service when configured directly, fall back to the
  // orchestrator's cached copy. The browser contract reports only the
  // source mode and summary, never internal service endpoint URLs.
  if (experienceLearning.enabled) {
    try {
      const upstream = await experienceLearning.getRunSummary(liveRunId);
      if (upstream && upstream.status >= 200 && upstream.status < 300) {
        return {
          ...baseEnvelope,
          mode: "live",
          productMode: "live",
          status: "complete",
          summary: asRecord(upstream.body) ?? null,
          source: "live",
          missingArtifacts: [],
          orchestratorRunId: liveRunId,
        };
      }
    } catch {
      // fall through to orchestrator-cached copy
    }
  }
  try {
    const upstream = await orchestrator.getLearning(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...baseEnvelope,
        status: "incomplete",
        summary: null,
        source: "unavailable",
        missingArtifacts: ["learning-summary"],
        orchestratorRunId: liveRunId,
        note: "Orchestrator did not return a learning summary for this run.",
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      ...baseEnvelope,
      mode: "live",
      productMode: "live",
      status: missing.length === 0 ? "complete" : "incomplete",
      summary: asRecord(envelope.summary) ?? null,
      source: asString(envelope.source) || "cached",
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
    };
  } catch (err) {
    return {
      ...baseEnvelope,
      status: "incomplete",
      summary: null,
      source: "unavailable",
      missingArtifacts: ["learning-summary"],
      note: sanitizeUpstreamMessage(
        err instanceof Error ? err.message : "",
        "orchestrator request failed",
      ),
    };
  }
}

async function liveExperienceView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
  experienceLearning: ExperienceLearningClient,
): Promise<Record<string, unknown>> {
  const learningView = await liveLearningView(
    stored,
    orchestrator,
    experienceLearning,
  );
  if (learningView.status !== "complete") {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      productMode: productModeOf(stored),
    };
  }
  const summaryRaw = asRecord(learningView.summary) ?? {};

  return normalizeExperienceViewFromSummary(stored, learningView, summaryRaw);
}

async function liveEventsView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      productMode: productModeOf(stored),
      events: [],
      missingArtifacts: ["trajectory-ledger"],
      note: "Live run id is unavailable; orchestrator has not yet accepted this run.",
    };
  }
  try {
    const upstream = await orchestrator.getEvents(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        runId: stored.runId,
        programId: stored.programId,
        mode: stored.mode,
        productMode: productModeOf(stored),
        events: [],
        missingArtifacts: ["trajectory-ledger"],
        note: "Orchestrator did not return a trajectory ledger for this run.",
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const events = Array.isArray(envelope.events)
      ? envelope.events
          .map((event) => sanitizeUiRunEvent(event))
          .filter((event): event is UiRunEvent => event !== null)
      : [];
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      runId: stored.runId,
      programId:
        stored.programId ||
        (typeof envelope.programId === "string" ? envelope.programId : ""),
      mode: "live",
      productMode: "live",
      events,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
    };
  } catch (err) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      productMode: productModeOf(stored),
      events: [],
      missingArtifacts: ["trajectory-ledger"],
      note: sanitizeUpstreamMessage(
        err instanceof Error ? err.message : "",
        "orchestrator request failed",
      ),
    };
  }
}

// Issue #172: W0.2 workflow contract product-level view.
//
// The orchestrator's ``GET /v0/runs/{runId}/workflow`` returns a verbose
// envelope that mixes internal references (artifact URIs, raw model
// invocation refs, persisted workflow_id) with the product-level signals
// the browser actually needs. ``liveWorkflowView`` strips internal-only
// fields, maps the orchestrator failure code to a UI-safe code, and
// guarantees a stable response shape regardless of orchestrator state.

const FINAL_CLASSIFICATIONS_SET: ReadonlySet<RunFinalClassification> = new Set([
  "success",
  "blocked",
  "failed",
  "cancelled",
  "incomplete",
]);

function applyWorkflowSnapshotToStore(
  stored: StoredRun,
  runStore: RunStore,
  snapshot: WorkflowSnapshot,
): StoredRun {
  const patch: Partial<StoredRun> = {
    activeStep: snapshot.activeStep ?? undefined,
    agentAttemptCount: snapshot.agentAttemptCount,
    repairBudget: snapshot.repairBudget ?? undefined,
    assistBudget: snapshot.assistBudget ?? undefined,
    modelInvocationBudget: snapshot.modelInvocationBudget ?? undefined,
    finalClassification: snapshot.finalClassification ?? undefined,
    failureCode: snapshot.failureCode ?? undefined,
    failureMessage: snapshot.failureMessage ?? undefined,
    manualEditsCarriedOver: snapshot.manualEditsCarriedOver,
    manualDriftRegionCount: snapshot.manualDriftRegionCount,
  };
  if (snapshot.trustCase) {
    patch.trustCaseId = snapshot.trustCase.trustCaseId;
    patch.trustCaseVersion = snapshot.trustCase.version;
    patch.trustCaseCatalogVersion = snapshot.trustCase.catalogVersion;
    patch.trustCaseCatalogHash = snapshot.trustCase.catalogHash;
    patch.trustCaseConfigurationDigest =
      snapshot.trustCase.configurationDigest;
    patch.trustCaseEnvironmentProfileId =
      snapshot.trustCase.environmentProfileId;
    patch.trustCaseComparisonPolicyVersion =
      snapshot.trustCase.comparisonPolicyVersion;
    patch.sourceReferenceFixtureId =
      snapshot.trustCase.sourceReferenceFixtureId;
    if (
      snapshot.trustCase.sourceReferenceMode === "reference-fixture" ||
      snapshot.trustCase.sourceReferenceMode === "native-cobol"
    ) {
      patch.sourceReferenceMode = snapshot.trustCase.sourceReferenceMode;
    }
  }
  const updated = runStore.update(stored.runId, patch);
  return updated ?? stored;
}

async function fetchWorkflowSnapshot(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
  runStore: RunStore,
): Promise<{
  stored: StoredRun;
  snapshot: WorkflowSnapshot;
  source: "live" | "cached" | "unavailable";
}> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      stored,
      snapshot: { ...EMPTY_WORKFLOW_SNAPSHOT },
      source: "unavailable",
    };
  }
  try {
    const upstream = await orchestrator.getWorkflow(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        stored,
        snapshot: { ...EMPTY_WORKFLOW_SNAPSHOT },
        source: "unavailable",
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const contract = asRecord(envelope.contract);
    const snapshot = snapshotFromContract(contract);
    const reportedSource = asString(envelope.source);
    const source: "live" | "cached" | "unavailable" =
      reportedSource === "cached"
        ? "cached"
        : reportedSource === "live"
          ? "live"
          : contract
            ? "live"
            : "unavailable";
    const updatedStored = applyWorkflowSnapshotToStore(
      stored,
      runStore,
      snapshot,
    );
    return { stored: updatedStored, snapshot, source };
  } catch {
    return {
      stored,
      snapshot: { ...EMPTY_WORKFLOW_SNAPSHOT },
      source: "unavailable",
    };
  }
}

function extractLiveRunId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  const direct = obj.runId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const run = obj.run;
  if (run && typeof run === "object") {
    const nested = (run as Record<string, unknown>).runId;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

function applyLiveRunPayload(
  stored: StoredRun,
  runStore: RunStore,
  payload: unknown,
): StoredRun {
  if (!payload || typeof payload !== "object") return stored;
  const obj = payload as Record<string, unknown>;
  const runObj =
    obj.run && typeof obj.run === "object"
      ? (obj.run as Record<string, unknown>)
      : obj;
  const status = coerceLiveStatus(runObj.status);
  const message =
    typeof runObj.message === "string" ? runObj.message : stored.message;
  const policyDecision =
    typeof runObj.policyDecision === "string"
      ? runObj.policyDecision
      : stored.policyDecision;
  const evidenceRefs = Array.isArray(runObj.evidenceRefs)
    ? (runObj.evidenceRefs as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : stored.evidenceRefs;
  const updated = runStore.update(stored.runId, {
    status,
    message,
    policyDecision,
    evidenceRefs,
  });
  return updated ?? stored;
}

// Studio-IDE-10 (#249): editor-assist channel route handler. Pulled
// out of ``createApp`` so the handler is one cohesive unit instead of
// 200 lines of inline route body — `editorExplain.ts` carries the
// rules, this function applies them. The body intentionally never
// echoes upstream error text; only the closed-set default messages
// flow back to the client.
interface HandleEditorExplainArgs {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  modelGateway: ModelGatewayClient;
  budgets: EditorAssistBudgetStore;
  sequence: SequenceCounter;
  ledgerSink: EditorAssistLedgerSink;
  sessionStore: SessionStore;
  forceSecureSessionCookies: boolean;
  now: () => Date;
}

const EDITOR_EXPLAIN_MAX_BODY_BYTES = 256_000;

function emitEditorExplainError(
  res: http.ServerResponse,
  errorCode: EditorExplainErrorCode,
  snapshot: BudgetSnapshot | null,
  messageOverride?: string,
): void {
  jsonResponse(
    res,
    statusForErrorCode(errorCode),
    buildErrorBody(errorCode, snapshot, messageOverride),
  );
}

const EDITOR_ASSIST_LEDGER_UNAVAILABLE_MESSAGE =
  "Editor-assist audit ledger unavailable. Try again shortly.";
const EDITOR_ASSIST_SESSION_UNAVAILABLE_MESSAGE =
  "Editor-assist session is unavailable. Sign in again.";

function resolveEditorAssistSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionStore: SessionStore,
  forceSecureSessionCookies = false,
): { ok: true; record: SessionRecord } | { ok: false; message: string } {
  const authSessionId = parseSessionCookieFromRequest(req);
  if (!authSessionId) {
    return { ok: false, message: "session cookie missing" };
  }
  const record = sessionStore.get(authSessionId);
  if (!record) {
    const secureCookie = forceSecureSessionCookies || isRequestSecure(req);
    res.setHeader(
      "set-cookie",
      serializeClearedSessionCookie({ secure: secureCookie }),
    );
    return { ok: false, message: "session not found" };
  }
  return { ok: true, record };
}

function rejectUnauthenticatedStudioJsonRequest(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  allowedOrigins: readonly string[];
  sessionStore: SessionStore;
  forceSecureSessionCookies: boolean;
}): boolean {
  if (
    rejectDisallowedBrowserOrigin(args.req, args.res, args.allowedOrigins) ||
    rejectNonJsonContentType(args.req, args.res)
  ) {
    return true;
  }
  const session = resolveEditorAssistSession(
    args.req,
    args.res,
    args.sessionStore,
    args.forceSecureSessionCookies,
  );
  if (!session.ok) {
    jsonResponse(args.res, 401, { error: session.message });
    return true;
  }
  appendVaryHeader(args.res, "Cookie");
  return false;
}

function explicitStringField(
  raw: unknown,
  fieldName: string,
): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[fieldName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateOptionalIdentityMatchesSession(
  raw: unknown,
  record: SessionRecord,
): string | null {
  const tenantId = explicitStringField(raw, "tenantId");
  if (tenantId !== null && tenantId !== record.tenantId) {
    return "tenantId does not match the active editor-assist session";
  }
  const userId = explicitStringField(raw, "userId");
  if (userId !== null && userId !== record.userId) {
    return "userId does not match the active editor-assist session";
  }
  return null;
}

function logEditorAssistLedgerFailure(event: string, err: unknown): void {
  // The ledger path may be deployment-specific. Sanitize before logging and
  // return a fixed user-facing message so filesystem details never leak.
  console.warn(
    JSON.stringify({
      route: "/api/v0/editor/explain",
      event,
      errorClass:
        err != null &&
        typeof (err as Record<string, unknown>).constructor === "function"
          ? ((err as { constructor: { name: string } }).constructor.name ??
            "Unknown")
          : "Unknown",
      message: sanitizeUpstreamMessage(
        err instanceof Error ? err.message : String(err),
        EDITOR_ASSIST_LEDGER_UNAVAILABLE_MESSAGE,
      ),
    }),
  );
}

function preflightEditorAssistLedgerSink(
  ledgerSink: EditorAssistLedgerSink,
): boolean {
  try {
    ledgerSink.preflight?.();
    return true;
  } catch (err) {
    logEditorAssistLedgerFailure("ledger_preflight_failed", err);
    return false;
  }
}

function writeEditorAssistLedgerEntry(
  ledgerSink: EditorAssistLedgerSink,
  entry: EditorAssistLedgerEntry,
): boolean {
  try {
    ledgerSink(entry);
    return true;
  } catch (err) {
    logEditorAssistLedgerFailure("ledger_write_failed", err);
    return false;
  }
}

function isEditorAssistTransportTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return true;
  return /\btimed?\s*out\b|timeout/i.test(err.message);
}

async function handleEditorExplain(
  args: HandleEditorExplainArgs,
): Promise<void> {
  const {
    req,
    res,
    modelGateway,
    budgets,
    sequence,
    ledgerSink,
    sessionStore,
    forceSecureSessionCookies,
    now,
  } = args;
  // Fast-path: gateway disabled means we never consume budget and never
  // write a ledger entry — see ADR 0004 "Required follow-up" and the
  // explicit AC in the issue body.
  if (!modelGateway.enabled) {
    emitEditorExplainError(res, "gateway_unavailable", null);
    return;
  }

  // M1: reject requests whose Content-Type is not application/json.
  // 415 Unsupported Media Type is the correct status for a media-type
  // mismatch (not 400). DOMPurify and downstream parsing are not reached
  // until this gate passes.
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    jsonResponse(
      res,
      415,
      buildErrorBody(
        "invalid_region",
        null,
        "request must use Content-Type: application/json",
      ),
    );
    return;
  }

  let raw: unknown;
  try {
    raw = await readJsonBody(req, EDITOR_EXPLAIN_MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof Error && /too large/i.test(err.message)) {
      emitEditorExplainError(
        res,
        "invalid_region",
        null,
        "request body too large",
      );
      return;
    }
    emitEditorExplainError(
      res,
      "invalid_region",
      null,
      err instanceof Error ? err.message : "invalid body",
    );
    return;
  }

  const validation = validateExplainRequest(raw);
  if (!validation.ok) {
    emitEditorExplainError(res, validation.errorCode, null, validation.message);
    return;
  }
  const request = validation.value;

  const session = resolveEditorAssistSession(
    req,
    res,
    sessionStore,
    forceSecureSessionCookies,
  );
  if (!session.ok) {
    emitEditorExplainError(
      res,
      "policy_denied",
      null,
      EDITOR_ASSIST_SESSION_UNAVAILABLE_MESSAGE,
    );
    return;
  }
  const identityMismatch = validateOptionalIdentityMatchesSession(
    raw,
    session.record,
  );
  if (identityMismatch !== null) {
    emitEditorExplainError(res, "policy_denied", null, identityMismatch);
    return;
  }

  const tenantId = session.record.tenantId;
  const userId = session.record.userId;
  const studioSessionId = request.sessionId;
  const scope = {
    tenantId,
    userId,
    sessionId: session.record.sessionId,
  };
  if (!preflightEditorAssistLedgerSink(ledgerSink)) {
    emitEditorExplainError(
      res,
      "gateway_unavailable",
      null,
      EDITOR_ASSIST_LEDGER_UNAVAILABLE_MESSAGE,
    );
    return;
  }
  const consume = await budgets.consume(scope);
  if (!consume.ok) {
    emitEditorExplainError(res, consume.errorCode, consume.snapshot);
    return;
  }

  const startedAt = now().toISOString();
  let gatewayResponse: UpstreamResponse | undefined;
  let upstreamErrorCode: EditorExplainErrorCode | null = null;
  try {
    gatewayResponse = await modelGateway.explain({
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      sessionId: studioSessionId,
      tenantId,
      userId,
      runId: request.runId,
      sourceHash: request.sourceHash,
      region: request.region,
      redactedBytes: request.redactedBytes,
      byteHash: request.byteHash,
      studioRedactionMetadata: request.studioRedactionMetadata,
    });
  } catch (err) {
    upstreamErrorCode = isEditorAssistTransportTimeout(err)
      ? "timeout"
      : "gateway_unavailable";
    if (err instanceof UpstreamResponseTooLargeError) {
      // M3: log oversize responses distinctly so operators can tune the cap.
      console.warn(
        JSON.stringify({
          route: "/api/v0/editor/explain",
          event: "gateway_call_failed",
          errorClass: "UpstreamResponseTooLargeError",
          message: sanitizeUpstreamMessage(
            err instanceof Error ? err.message : String(err),
            defaultMessageForErrorCode(upstreamErrorCode),
          ),
        }),
      );
    } else {
      // M3: log transport/gateway failures so operators can see failure patterns.
      // sanitizeUpstreamMessage strips API keys, JWTs, URLs, file paths, and
      // stack traces before the message is written to the log.
      console.warn(
        JSON.stringify({
          route: "/api/v0/editor/explain",
          event: "gateway_call_failed",
          errorClass:
            err != null &&
            typeof (err as Record<string, unknown>).constructor === "function"
              ? ((err as { constructor: { name: string } }).constructor.name ??
                "Unknown")
              : "Unknown",
          message: sanitizeUpstreamMessage(
            err instanceof Error ? err.message : String(err),
            defaultMessageForErrorCode(upstreamErrorCode),
          ),
        }),
      );
    }
  }

  const mapped = upstreamErrorCode
    ? ({
        kind: "error",
        errorCode: upstreamErrorCode,
        message: defaultMessageForErrorCode(upstreamErrorCode),
      } as const)
    : mapGatewayResponse(gatewayResponse);

  const endedAt = now().toISOString();
  const seq = sequence.next({
    tenantId,
    sessionId: studioSessionId,
  });
  const editorAssistRef = buildEditorAssistRef({
    tenantId,
    sessionId: studioSessionId,
    seq,
  });
  const localLedgerRef = buildLocalLedgerRef({
    tenantId,
    sessionId: studioSessionId,
    seq,
  });

  if (mapped.kind === "error") {
    const ledgerEntry = buildLedgerEntry({
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      tenantId,
      userId,
      sessionId: studioSessionId,
      region: request.region,
      byteHash: request.byteHash,
      redactionApplied:
        request.studioRedactionMetadata.matchedPatternIds.slice(),
      editorAssistRef,
      ledgerRef: localLedgerRef,
      invocationId: null,
      budgetSnapshot: consume.snapshot,
      startedAt,
      endedAt,
      status: "failed",
      failureCode: mapped.errorCode,
      runIdRef: request.runId,
    });
    if (!writeEditorAssistLedgerEntry(ledgerSink, ledgerEntry)) {
      emitEditorExplainError(
        res,
        "gateway_unavailable",
        consume.snapshot,
        EDITOR_ASSIST_LEDGER_UNAVAILABLE_MESSAGE,
      );
      return;
    }
    emitEditorExplainError(res, mapped.errorCode, consume.snapshot);
    return;
  }

  const gatewayLedgerRef = mapped.gatewayLedgerRef;
  const ledgerRef =
    gatewayLedgerRef !== null && gatewayLedgerRef.length > 0
      ? gatewayLedgerRef
      : localLedgerRef;
  const redactionApplied = normaliseGatewayRedactedFields({
    studioMatchedPatternIds: request.studioRedactionMetadata.matchedPatternIds,
    gatewayRedactedFields: mapped.gatewayRedactedFields,
  });
  const modelInvocationRef =
    mapped.invocationId ?? `mi-${seq}-${editorAssistRef}`;

  const ledgerEntry = buildLedgerEntry({
    schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
    tenantId,
    userId,
    sessionId: studioSessionId,
    region: request.region,
    byteHash: request.byteHash,
    redactionApplied,
    editorAssistRef,
    ledgerRef,
    invocationId: mapped.invocationId,
    budgetSnapshot: consume.snapshot,
    startedAt,
    endedAt,
    status: "success",
    failureCode: null,
    runIdRef: request.runId,
  });
  if (!writeEditorAssistLedgerEntry(ledgerSink, ledgerEntry)) {
    emitEditorExplainError(
      res,
      "gateway_unavailable",
      consume.snapshot,
      EDITOR_ASSIST_LEDGER_UNAVAILABLE_MESSAGE,
    );
    return;
  }

  jsonResponse(
    res,
    200,
    buildSuccessBody({
      explanation: mapped.explanation,
      modelInvocationRef,
      editorAssistRef,
      ledgerRef,
      budgetSnapshot: consume.snapshot,
      redactionApplied,
    }),
  );
}

export function createApp(deps: ServerDeps): http.RequestListener {
  const resolved = resolveDeps(deps);
  const {
    config,
    samples,
    acceptanceFixtures,
    trustCases,
    orchestrator,
    evidence,
    experienceLearning,
    modelGateway,
    harness,
    buildTestRunner,
    runStore,
    editorAssistBudgets,
    editorAssistSequence,
    editorAssistLedgerSink,
    cspReportSink,
    sessionStore,
    sessionSignInRateLimiter,
    now: nowFn,
  } = resolved;

  return async function handler(req, res) {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = requestUrl.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (pathname.startsWith("/api/")) {
        applyLocalApiCors(req, res, config.studioCorsOrigins);
        if (method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      if (pathname === "/api/v0/health" && method === "GET") {
        jsonResponse(res, 200, { status: "ok", service: config.serviceName });
        return;
      }

      // Issue #271 / ADR-0005 §6: receiver for browser CSP violation
      // reports. The endpoint is intentionally unauthenticated — the
      // browser cannot attach credentials to ``report-uri`` requests —
      // and intentionally generous on Content-Type so it accepts both
      // the legacy ``application/csp-report`` and the modern
      // ``application/reports+json`` payloads. The PII gate lives in
      // ``./cspReport.ts``.
      if (pathname === "/api/v0/csp-report" && method === "POST") {
        const contentType = req.headers["content-type"];
        if (!isAcceptedCspReportContentType(contentType)) {
          jsonResponse(res, 415, {
            error: `unsupported content-type: ${typeof contentType === "string" && contentType.length > 0 ? contentType : "<missing>"}`,
          });
          return;
        }
        let raw: unknown;
        try {
          raw = await readJsonBody(req, CSP_REPORT_MAX_BODY_BYTES);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "csp report body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        const parsed = parseCspReportPayload(contentType, raw);
        if (!parsed.ok) {
          jsonResponse(res, parsed.status, { error: parsed.error });
          return;
        }
        for (const report of parsed.reports) cspReportSink(report);
        res.writeHead(204);
        res.end();
        return;
      }

      // Issue #272 / ADR-0005 §2 "Encryption at Rest" + "Named
      // prerequisites": dev-mode session sign-in. Mints an opaque
      // pseudonymous ``(tenantId, userId)`` pair, allocates a fresh
      // ``draftKeyWrappingSecret`` keyed by ``sessionId``, and sets
      // the ``HttpOnly`` session cookie. The endpoint returns 404
      // in deployments that have disabled fixture sessions via
      // ``C2C_ENABLE_FIXTURE_SESSIONS=false`` (production with a
      // real identity layer behind the bootstrap). The response
      // body is intentionally narrow — only ``{tenantId, userId}``
      // — because the wrapping secret is the bootstrap response's
      // contract, not the sign-in's.
      if (pathname === "/api/v0/session/sign-in" && method === "POST") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)
        ) {
          return;
        }
        if (!config.enableFixtureSessions) {
          notFound(res);
          return;
        }
        // Issue #272: rate-limit fixture sign-in to bound the
        // in-memory session-store growth under a flood. The
        // per-IP bucket is itself bounded so a varying-source flood
        // cannot pin the limiter map either.
        if (!sessionSignInRateLimiter.consume(resolveClientBucketKey(req))) {
          jsonResponse(res, 429, { error: "rate limit exceeded" });
          return;
        }
        let raw: unknown;
        try {
          raw = await readJsonBody(req, SESSION_SIGN_IN_MAX_BODY_BYTES);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "request body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        let identity: {
          tenantId: string;
          userId: string;
          studioRedactionPatternAdditions?: RedactionPatternAddition[];
        };
        try {
          identity = resolveFixtureSignInIdentity(raw, sessionStore);
        } catch (err) {
          if (err instanceof SessionIdentifierError) {
            badRequest(res, err.message);
            return;
          }
          throw err;
        }
        const record = sessionStore.create(identity);
        const secureCookie =
          config.forceSecureSessionCookies || isRequestSecure(req);
        res.setHeader(
          "set-cookie",
          serializeSessionCookie(record.sessionId, { secure: secureCookie }),
        );
        jsonResponse(res, 200, {
          tenantId: record.tenantId,
          userId: record.userId,
        });
        return;
      }

      // Issue #272 / ADR-0005 §2: draft-key bootstrap. Requires the
      // session cookie set by ``/api/v0/session/sign-in`` (or by a
      // future real identity layer). Returns the **same**
      // ``draftKeyWrappingSecret`` on every call within the same
      // auth session, so a Studio reload re-fetches the secret and
      // can decrypt drafts written earlier in the session. The
      // wrapping secret is **not** an authentication credential —
      // it grants only the ability to decrypt local drafts on the
      // user's device — but is treated with the same hygiene
      // (no logging, no echoing in error paths).
      if (pathname === "/api/v0/session/bootstrap" && method === "POST") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)
        ) {
          return;
        }
        const sessionId = parseSessionCookieFromRequest(req);
        if (!sessionId) {
          jsonResponse(res, 401, { error: "session cookie missing" });
          return;
        }
        const record = sessionStore.get(sessionId);
        if (!record) {
          // The cookie value did not match any in-memory session.
          // Either the BFF restarted, the session was deleted via
          // logout, or the cookie was forged. Clear the cookie on
          // the way out so the browser does not keep replaying a
          // dead identifier.
          const secureCookie =
            config.forceSecureSessionCookies || isRequestSecure(req);
          res.setHeader(
            "set-cookie",
            serializeClearedSessionCookie({ secure: secureCookie }),
          );
          jsonResponse(res, 401, { error: "session not found" });
          return;
        }
        // Issue #272: the bootstrap response varies per cookie. The
        // ``jsonResponse`` helper already sends ``Cache-Control:
        // no-store`` (which is strictly stronger than ``Vary``), but
        // an extra ``Vary: Cookie`` header is cheap defence in depth
        // against an upstream proxy that ignores ``no-store`` and
        // would otherwise serve one user's wrapping secret to
        // another.
        appendVaryHeader(res, "Cookie");
        jsonResponse(res, 200, {
          tenantId: record.tenantId,
          userId: record.userId,
          draftKeyWrappingSecret: record.draftKeyWrappingSecret,
          studioRedactionPatternAdditions:
            record.studioRedactionPatternAdditions,
        });
        return;
      }

      // Issue #272 / ADR-0005 §2: explicit logout. Deletes the
      // server-side session record and clears the cookie. Drafts
      // encrypted under the deleted secret become permanently
      // unreadable per ADR-0005 §2 "Rotation". Idempotent: returns
      // 204 whether or not the cookie / record existed.
      if (pathname === "/api/v0/session/logout" && method === "POST") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)
        ) {
          return;
        }
        const sessionId = parseSessionCookieFromRequest(req);
        if (sessionId) sessionStore.delete(sessionId);
        const secureCookie =
          config.forceSecureSessionCookies || isRequestSecure(req);
        res.setHeader(
          "set-cookie",
          serializeClearedSessionCookie({ secure: secureCookie }),
        );
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === "/api/v0/trust-cases" && method === "GET") {
        try {
          const programIdRaw = requestUrl.searchParams.get("programId");
          const programId =
            typeof programIdRaw === "string" && programIdRaw.trim().length > 0
              ? programIdRaw.trim()
              : undefined;
          const catalog = trustCases();
          const savedTrustCaseId = programId
            ? sessionTrustCasePreference(req, sessionStore, programId)
            : null;
          const savedSummary =
            savedTrustCaseId === null ? undefined : catalog.get(savedTrustCaseId);
          appendVaryHeader(res, "Cookie");
          jsonResponse(
            res,
            200,
            trustCaseCatalogResponse(
              catalog,
              programId,
              savedSummary && (!programId || savedSummary.programId === programId)
                ? savedSummary.trustCaseId
                : null,
            ),
          );
        } catch (err) {
          jsonResponse(res, 500, {
            error: "trust-case catalog unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (
        pathname === "/api/v0/session/trust-case-preference" &&
        method === "GET"
      ) {
        const programIdRaw = requestUrl.searchParams.get("programId");
        if (!programIdRaw || programIdRaw.trim().length === 0) {
          badRequest(res, "programId must be a non-empty string");
          return;
        }
        const programId = programIdRaw.trim();
        const sessionId = parseSessionCookieFromRequest(req);
        const sessionRecord = sessionId ? sessionStore.get(sessionId) : null;
        appendVaryHeader(res, "Cookie");
        jsonResponse(res, 200, {
          programId,
          trustCaseId: sessionRecord?.trustCasePreferences[programId] ?? null,
          persisted: Boolean(sessionRecord),
        });
        return;
      }

      if (
        pathname === "/api/v0/session/trust-case-preference" &&
        method === "PUT"
      ) {
        if (rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)) {
          return;
        }
        if (rejectNonJsonContentType(req, res)) return;
        const sessionId = parseSessionCookieFromRequest(req);
        if (!sessionId) {
          jsonResponse(res, 401, { error: "session cookie missing" });
          return;
        }
        let raw: unknown;
        try {
          raw = await readJsonBody(req, TRUST_CASE_PREFERENCE_MAX_BODY_BYTES);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        const requestBody = asRecord(raw);
        if (!requestBody) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const programId =
          typeof requestBody.programId === "string" &&
          requestBody.programId.trim().length > 0
            ? requestBody.programId.trim()
            : undefined;
        const trustCaseId =
          typeof requestBody.trustCaseId === "string" &&
          requestBody.trustCaseId.trim().length > 0
            ? requestBody.trustCaseId.trim()
            : undefined;
        if (!programId) {
          badRequest(res, "programId must be a non-empty string");
          return;
        }
        if (!trustCaseId) {
          badRequest(res, "trustCaseId must be a non-empty string");
          return;
        }
        let selected: TrustCaseSummary | undefined;
        try {
          selected = trustCases().get(trustCaseId);
        } catch (err) {
          jsonResponse(res, 500, {
            error: "trust-case catalog unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (!selected) {
          badRequest(res, `unknown trustCaseId ${JSON.stringify(trustCaseId)}`);
          return;
        }
        if (selected.programId !== programId) {
          badRequest(
            res,
            `trustCaseId ${JSON.stringify(trustCaseId)} does not apply to programId ${JSON.stringify(programId)}`,
          );
          return;
        }
        const record = sessionStore.setTrustCasePreference(
          sessionId,
          programId,
          trustCaseId,
        );
        if (!record) {
          jsonResponse(res, 401, { error: "session not found" });
          return;
        }
        appendVaryHeader(res, "Cookie");
        jsonResponse(res, 200, {
          programId,
          trustCaseId,
          persisted: true,
          selected,
        });
        return;
      }

      if (pathname === "/api/v0/mode" && method === "GET") {
        jsonResponse(res, 200, {
          orchestrator: orchestrator.enabled ? "live" : "mock",
          evidence: evidence.enabled ? "live" : "mock",
        });
        return;
      }

      if (pathname === "/api/v0/samples" && method === "GET") {
        jsonResponse(res, 200, samples.list());
        return;
      }

      if (pathname === "/api/v0/acceptance-fixtures" && method === "GET") {
        try {
          jsonResponse(res, 200, acceptanceFixtures().list());
        } catch (err) {
          jsonResponse(res, 503, {
            error: `acceptance fixture registry unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
          });
        }
        return;
      }

      // Studio-IDE-14 (#256): deterministic Java formatter route. Proxies
      // to /v0/format-java on the build-test-runner-service. The Studio
      // client (lib/editor/javaFormatClient.ts) calls this on
      // Cmd/Ctrl+Shift+F and on opt-in format-on-save.
      if (pathname === "/api/v0/format/java" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        if (!buildTestRunner.enabled) {
          jsonResponse(
            res,
            503,
            formatUnavailable(
              "formatter unavailable: build-test-runner-service URL is not configured",
            ),
          );
          return;
        }
        let raw: unknown;
        try {
          raw = await readJsonBody(
            req,
            formatJavaRawBodyMaxBytes(config.formatJavaSourceMaxBytes),
          );
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(
              res,
              413,
              formatInputTooLarge(config.formatJavaSourceMaxBytes),
            );
            return;
          }
          jsonResponse(
            res,
            400,
            formatUnavailable(
              err instanceof Error ? err.message : "invalid body",
            ),
          );
          return;
        }
        const validation = validateFormatJavaRequest(raw, {
          maxContentBytes: config.formatJavaSourceMaxBytes,
        });
        if (!validation.ok) {
          jsonResponse(res, validation.status, validation.body);
          return;
        }
        try {
          const upstream = await buildTestRunner.formatJava({
            content: validation.value.content,
            ...(validation.value.filePath
              ? { filePath: validation.value.filePath }
              : {}),
          }, config.formatJavaTimeoutMs, config.artifactContentMaxBytes);
          if (!upstream) {
            jsonResponse(
              res,
              503,
              formatUnavailable("formatter returned no response"),
            );
            return;
          }
          if (upstream.truncated) {
            jsonResponse(
              res,
              502,
              formatUnavailable("formatter response exceeded the BFF size cap"),
            );
            return;
          }
          const normalised = normaliseUpstreamResponse({
            status: upstream.status,
            body: upstream.body,
          });
          if (normalised.kind === "ok") {
            jsonResponse(res, 200, normalised.body);
            return;
          }
          jsonResponse(res, normalised.status, normalised.body);
          return;
        } catch (err) {
          if (err instanceof UpstreamResponseTooLargeError) {
            jsonResponse(
              res,
              502,
              formatUnavailable("formatter response exceeded the BFF size cap"),
            );
            return;
          }
          jsonResponse(
            res,
            503,
            formatUnavailable(
              err instanceof Error
                ? `formatter unavailable: ${err.message}`
                : "formatter unavailable",
            ),
          );
          return;
        }
      }

      // Studio-IDE-10 (#249): editor-assist channel — explain endpoint.
      // Architecture: ADR 0004 (parallel-governed channel, distinct
      // budget, distinct ledger kind). Pre-redaction contract: ADR
      // 0005 §4 (BFF receives already-redacted bytes + matching
      // byteHash). All model calls go through the Model Gateway.
      if (pathname === "/api/v0/editor/explain" && method === "POST") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)
        ) {
          return;
        }
        await handleEditorExplain({
          req,
          res,
          modelGateway,
          budgets: editorAssistBudgets,
          sequence: editorAssistSequence,
          ledgerSink: editorAssistLedgerSink,
          sessionStore,
          forceSecureSessionCookies: config.forceSecureSessionCookies,
          now: nowFn,
        });
        return;
      }

      // Studio-IDE-10 (#249): editor-assist channel — budget snapshot
      // endpoint. The Studio uses this on session start to hide the
      // primary action button when the per-session budget is already
      // exhausted (AC8 in the issue body).
      if (pathname === "/api/v0/editor/budget" && method === "GET") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins)
        ) {
          return;
        }
        const sessionIdRaw = requestUrl.searchParams.get("sessionId");
        if (!sessionIdRaw || sessionIdRaw.trim().length === 0) {
          badRequest(res, "sessionId must be a non-empty string");
          return;
        }
        const sessionIdErr = validateEditorAssistIdentifier(
          sessionIdRaw,
          "sessionId",
        );
        if (sessionIdErr) {
          badRequest(res, sessionIdErr.message);
          return;
        }
        const tenantIdRaw = requestUrl.searchParams.get("tenantId");
        const userIdRaw = requestUrl.searchParams.get("userId");
        if (tenantIdRaw !== null) {
          if (tenantIdRaw.trim().length === 0) {
            badRequest(res, "tenantId must be a non-empty string when provided");
            return;
          }
          const tenantIdErr = validateEditorAssistIdentifier(
            tenantIdRaw,
            "tenantId",
          );
          if (tenantIdErr) {
            badRequest(res, tenantIdErr.message);
            return;
          }
        }
        if (userIdRaw !== null) {
          if (userIdRaw.trim().length === 0) {
            badRequest(res, "userId must be a non-empty string when provided");
            return;
          }
          const userIdErr = validateEditorAssistIdentifier(userIdRaw, "userId");
          if (userIdErr) {
            badRequest(res, userIdErr.message);
            return;
          }
        }
        const session = resolveEditorAssistSession(
          req,
          res,
          sessionStore,
          config.forceSecureSessionCookies,
        );
        if (!session.ok) {
          jsonResponse(res, 401, { error: session.message });
          return;
        }
        if (
          tenantIdRaw !== null &&
          tenantIdRaw.trim().length > 0 &&
          tenantIdRaw !== session.record.tenantId
        ) {
          jsonResponse(res, 403, {
            error: "tenantId does not match the active editor-assist session",
          });
          return;
        }
        if (
          userIdRaw !== null &&
          userIdRaw.trim().length > 0 &&
          userIdRaw !== session.record.userId
        ) {
          jsonResponse(res, 403, {
            error: "userId does not match the active editor-assist session",
          });
          return;
        }
        const snapshot = editorAssistBudgets.snapshot({
          tenantId: session.record.tenantId,
          userId: session.record.userId,
          sessionId: session.record.sessionId,
        });
        jsonResponse(res, 200, {
          schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
          budget: snapshot,
        });
        return;
      }

      // Studio-IDE-11 (#251): editor telemetry intake. Validates a
      // batched, closed-enum, tag-only payload against the contract
      // declared in `editorTelemetry.ts` (mirrors
      // `schemas/editor-telemetry-event-v0.json` and the Studio
      // discriminated union) and forwards the augmented batch through
      // the existing experience-learning client. Returns 202 Accepted
      // when the upstream is offline so the Studio's "drop silently on
      // offline" path stays UI-stable.
      if (pathname === "/api/v0/editor/telemetry" && method === "POST") {
        if (
          rejectDisallowedBrowserOrigin(req, res, config.studioCorsOrigins) ||
          rejectNonJsonContentType(req, res)
        ) {
          return;
        }
        const authSession = resolveEditorAssistSession(
          req,
          res,
          sessionStore,
          config.forceSecureSessionCookies,
        );
        if (!authSession.ok) {
          jsonResponse(res, 401, { error: authSession.message });
          return;
        }
        appendVaryHeader(res, "Cookie");
        let raw: unknown;
        try {
          raw = await readJsonBody(req, EDITOR_TELEMETRY_MAX_BODY_BYTES);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "telemetry batch too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        const validation = validateTelemetryBatch(raw);
        if (!validation.ok) {
          jsonResponse(
            res,
            statusForValidationErrorCode(validation.errorCode),
            { error: validation.message, errorCode: validation.errorCode },
          );
          return;
        }
        let augmented;
        try {
          augmented = augmentBatch(validation.value, {
            tenantId: authSession.record.tenantId,
            userId: authSession.record.userId,
            now: nowFn,
          });
        } catch (err) {
          badRequest(
            res,
            err instanceof Error ? err.message : "augmentation failed",
          );
          return;
        }
        if (!experienceLearning.enabled) {
          // No upstream configured — accept the batch so the Studio's
          // optimistic emitter does not retry or surface an error to
          // the user. The batch is dropped on the floor here, matching
          // the AC ("dropped silently after at most one retry attempt;
          // no UI degradation").
          jsonResponse(res, 202, {
            schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
            accepted: augmented.events.length,
            forwarded: false,
          });
          return;
        }
        try {
          const upstream = await experienceLearning.submitEditorTelemetry({
            schemaVersion: augmented.schemaVersion,
            events: augmented.events,
          });
          if (!upstream) {
            jsonResponse(res, 202, {
              schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
              accepted: augmented.events.length,
              forwarded: false,
            });
            return;
          }
          if (upstream.status >= 200 && upstream.status < 300) {
            jsonResponse(res, 202, {
              schemaVersion: EDITOR_TELEMETRY_SCHEMA_VERSION,
              accepted: augmented.events.length,
              forwarded: true,
            });
            return;
          }
          // Upstream rejected the batch — log without echoing the
          // upstream message body (which may not be sanitised) and
          // return 502 so the Studio's bounded retry policy kicks in.
          console.warn(
            JSON.stringify({
              route: "/api/v0/editor/telemetry",
              event: "upstream_rejected",
              status: upstream.status,
            }),
          );
          jsonResponse(res, 502, {
            error: "experience-learning-service rejected the batch",
          });
          return;
        } catch (err) {
          console.warn(
            JSON.stringify({
              route: "/api/v0/editor/telemetry",
              event: "upstream_call_failed",
              errorClass:
                err != null &&
                typeof (err as Record<string, unknown>).constructor ===
                  "function"
                  ? ((err as { constructor: { name: string } }).constructor
                      .name ?? "Unknown")
                  : "Unknown",
              message: sanitizeUpstreamMessage(
                err instanceof Error ? err.message : String(err),
                "experience-learning-service unavailable",
              ),
            }),
          );
          jsonResponse(res, 502, {
            error: "experience-learning-service unavailable",
          });
          return;
        }
      }

      if (pathname === "/api/v0/transform" && method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "request body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object") {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const sourceTextRaw = (body as Record<string, unknown>).sourceText;
        const requestedProgramIdRaw = (body as Record<string, unknown>)
          .programId;
        const sourceNameRaw = (body as Record<string, unknown>).sourceName;
        const optionsRaw = (body as Record<string, unknown>).options;
        // Issue #172: W0.2 transform contract — optional expected output /
        // oracle input and explicit target language (must be ``java``).
        const targetLanguageRaw = (body as Record<string, unknown>)
          .targetLanguage;
        const expectedOutputRaw = (body as Record<string, unknown>)
          .expectedOutput;
        const oracleInputRaw = (body as Record<string, unknown>).oracleInput;
        const trustCaseIdRaw = (body as Record<string, unknown>).trustCaseId;
        const useTransformationAgentRaw = (body as Record<string, unknown>)
          .useTransformationAgent;
        if (
          typeof sourceTextRaw !== "string" ||
          sourceTextRaw.trim().length === 0
        ) {
          badRequest(res, "sourceText must be a non-empty string");
          return;
        }
        if (
          requestedProgramIdRaw !== undefined &&
          (typeof requestedProgramIdRaw !== "string" ||
            requestedProgramIdRaw.trim().length === 0)
        ) {
          badRequest(res, "programId must be a non-empty string when provided");
          return;
        }
        if (
          sourceNameRaw !== undefined &&
          (typeof sourceNameRaw !== "string" ||
            sourceNameRaw.trim().length === 0)
        ) {
          badRequest(
            res,
            "sourceName must be a non-empty string when provided",
          );
          return;
        }
        if (
          optionsRaw !== undefined &&
          (typeof optionsRaw !== "object" ||
            optionsRaw === null ||
            Array.isArray(optionsRaw))
        ) {
          badRequest(res, "options must be an object when provided");
          return;
        }
        let targetLanguage: "java" = "java";
        if (targetLanguageRaw !== undefined) {
          if (
            typeof targetLanguageRaw !== "string" ||
            targetLanguageRaw.trim().length === 0
          ) {
            badRequest(
              res,
              "targetLanguage must be a non-empty string when provided",
            );
            return;
          }
          const normalizedLang = targetLanguageRaw.trim().toLowerCase();
          if (normalizedLang !== "java") {
            badRequest(
              res,
              `targetLanguage ${JSON.stringify(targetLanguageRaw)} is not supported; only \"java\" is available in W0.2`,
            );
            return;
          }
          targetLanguage = "java";
        }
        if (
          expectedOutputRaw !== undefined &&
          typeof expectedOutputRaw !== "string"
        ) {
          badRequest(res, "expectedOutput must be a string when provided");
          return;
        }
        if (
          oracleInputRaw !== undefined &&
          typeof oracleInputRaw !== "string"
        ) {
          badRequest(res, "oracleInput must be a string when provided");
          return;
        }
        if (
          trustCaseIdRaw !== undefined &&
          (typeof trustCaseIdRaw !== "string" ||
            trustCaseIdRaw.trim().length === 0)
        ) {
          badRequest(res, "trustCaseId must be a non-empty string when provided");
          return;
        }
        if (
          useTransformationAgentRaw !== undefined &&
          typeof useTransformationAgentRaw !== "boolean"
        ) {
          badRequest(
            res,
            "useTransformationAgent must be a boolean when provided",
          );
          return;
        }
        const startTransformRun = orchestrator.startTransformRun;
        if (!orchestrator.enabled || !startTransformRun) {
          jsonResponse(res, 503, {
            error: "orchestrator URL is required for /api/v0/transform",
          });
          return;
        }

        const sourceText = sourceTextRaw;
        const programId = resolveTransformProgramId(
          sourceText,
          typeof requestedProgramIdRaw === "string"
            ? requestedProgramIdRaw
            : undefined,
        );
        const sourceName =
          typeof sourceNameRaw === "string" ? sourceNameRaw : undefined;
        const expectedOutput =
          typeof expectedOutputRaw === "string" ? expectedOutputRaw : undefined;
        const oracleInput =
          typeof oracleInputRaw === "string" ? oracleInputRaw : undefined;
        const trustCaseId =
          typeof trustCaseIdRaw === "string" ? trustCaseIdRaw.trim() : undefined;
        const useTransformationAgent =
          typeof useTransformationAgentRaw === "boolean"
            ? useTransformationAgentRaw
            : true;

        let selectedTrustCase: TrustCaseSummary | undefined;
        if (trustCaseId) {
          const forbiddenFields = forbiddenTrustCaseTransformFields(
            body as Record<string, unknown>,
          );
          if (optionsRaw !== undefined) forbiddenFields.push("options");
          if (expectedOutputRaw !== undefined) {
            forbiddenFields.push("expectedOutput");
          }
          if (oracleInputRaw !== undefined) forbiddenFields.push("oracleInput");
          if (forbiddenFields.length > 0) {
            badRequest(
              res,
              `trustCaseId submissions may not include browser-authored runtime internals: ${forbiddenFields.join(", ")}`,
            );
            return;
          }
          try {
            selectedTrustCase = trustCases().get(trustCaseId);
          } catch (err) {
            jsonResponse(res, 500, {
              error: "trust-case catalog unavailable",
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          if (!selectedTrustCase) {
            badRequest(res, `unknown trustCaseId ${JSON.stringify(trustCaseId)}`);
            return;
          }
          if (selectedTrustCase.programId !== programId) {
            badRequest(
              res,
              `trustCaseId ${JSON.stringify(trustCaseId)} does not apply to programId ${JSON.stringify(programId)}`,
            );
            return;
          }
        }

        const referenceMatch = samples.get(programId);
        if (referenceMatch && !referenceMatch.supportedInProductMode) {
          jsonResponse(res, 400, {
            error: `reference program ${programId} is not supportedInProductMode; refusing to dispatch through /api/v0/transform`,
          });
          return;
        }
        if (useTransformationAgent) {
          const gatewayAvailability =
            await verifyTransformationModelGatewayAvailable(modelGateway);
          if (!gatewayAvailability.ok) {
            jsonResponse(res, 503, {
              error: gatewayAvailability.message,
              failureCode: "model_gateway_unavailable",
            });
            return;
          }
        }

        try {
          const transformInput: Parameters<
            typeof orchestrator.startTransformRun
          >[0] = {
            programId,
            sourceText,
            requester: "c2c-ui",
            sourceName,
            options: selectedTrustCase ? undefined : optionsRaw,
            targetLanguage,
            expectedOutput: selectedTrustCase ? undefined : expectedOutput,
            oracleInput: selectedTrustCase ? undefined : oracleInput,
            useTransformationAgent,
            ...(selectedTrustCase
              ? {
                  executionMode: "parity" as const,
                  trustCaseId: selectedTrustCase.trustCaseId,
                }
              : {}),
          };
          const upstream = await startTransformRun(transformInput);
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            const liveRunId = extractLiveRunId(upstream.body);
            const stored = runStore.create(
              createSourceTextSample(programId, sourceText, sourceName),
              "live",
              liveRunId,
              {
                executionMode: selectedTrustCase ? "parity" : undefined,
                trustCaseId: selectedTrustCase?.trustCaseId,
                trustCaseVersion: selectedTrustCase?.version,
                trustCaseCatalogVersion: selectedTrustCase?.catalogVersion,
                trustCaseCatalogHash: selectedTrustCase?.catalogHash,
                trustCaseConfigurationDigest:
                  selectedTrustCase?.configurationDigest,
                trustCaseEnvironmentProfileId:
                  selectedTrustCase?.environmentProfileId,
                trustCaseComparisonPolicyVersion:
                  selectedTrustCase?.comparisonPolicyVersion,
                status: "starting",
                message: "run accepted by orchestrator",
              },
            );
            const synced = applyLiveRunPayload(stored, runStore, upstream.body);
            res.writeHead(201, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify(transformResponse(synced)));
            return;
          }
          const status = upstream?.status ?? 502;
          const failure = mapUpstreamUnavailable(
            `orchestrator rejected transform request${status ? ` (status ${status})` : ""}`,
          );
          jsonResponse(res, 502, {
            error: failure.message,
            failureCode: failure.code,
          });
          return;
        } catch (err) {
          const failure = mapUpstreamUnavailable(
            sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          );
          jsonResponse(res, 502, {
            error: failure.message,
            failureCode: failure.code,
          });
          return;
        }
      }

      // Studio-IDE-13 (#255): semantic-intent alias for the orchestrator
      // transform entry point. Delegates to startTransformRun identically to
      // /api/v0/transform, but signals "Generator-only invocation; verification
      // is invoked separately via /verify". Returns 201 with a `runMode` marker.
      if (pathname === "/api/v0/generate" && method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "request body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object") {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const genBody = body as Record<string, unknown>;
        const genSourceTextRaw = genBody.sourceText;
        const genProgramIdRaw = genBody.programId;
        const genSourceNameRaw = genBody.sourceName;
        const genOptionsRaw = genBody.options;
        const genTargetLanguageRaw = genBody.targetLanguage;
        const genExpectedOutputRaw = genBody.expectedOutput;
        const genOracleInputRaw = genBody.oracleInput;
        const genUseTransformationAgentRaw = genBody.useTransformationAgent;
        if (
          typeof genSourceTextRaw !== "string" ||
          genSourceTextRaw.trim().length === 0
        ) {
          badRequest(res, "sourceText must be a non-empty string");
          return;
        }
        if (
          genProgramIdRaw !== undefined &&
          (typeof genProgramIdRaw !== "string" ||
            genProgramIdRaw.trim().length === 0)
        ) {
          badRequest(res, "programId must be a non-empty string when provided");
          return;
        }
        if (
          genSourceNameRaw !== undefined &&
          (typeof genSourceNameRaw !== "string" ||
            genSourceNameRaw.trim().length === 0)
        ) {
          badRequest(
            res,
            "sourceName must be a non-empty string when provided",
          );
          return;
        }
        if (
          genOptionsRaw !== undefined &&
          (typeof genOptionsRaw !== "object" ||
            genOptionsRaw === null ||
            Array.isArray(genOptionsRaw))
        ) {
          badRequest(res, "options must be an object when provided");
          return;
        }
        let genTargetLanguage: "java" = "java";
        if (genTargetLanguageRaw !== undefined) {
          if (
            typeof genTargetLanguageRaw !== "string" ||
            genTargetLanguageRaw.trim().length === 0
          ) {
            badRequest(
              res,
              "targetLanguage must be a non-empty string when provided",
            );
            return;
          }
          const normalizedLang = genTargetLanguageRaw.trim().toLowerCase();
          if (normalizedLang !== "java") {
            badRequest(
              res,
              `targetLanguage ${JSON.stringify(genTargetLanguageRaw)} is not supported; only "java" is available in W0.2`,
            );
            return;
          }
          genTargetLanguage = "java";
        }
        if (
          genExpectedOutputRaw !== undefined &&
          typeof genExpectedOutputRaw !== "string"
        ) {
          badRequest(res, "expectedOutput must be a string when provided");
          return;
        }
        if (
          genOracleInputRaw !== undefined &&
          typeof genOracleInputRaw !== "string"
        ) {
          badRequest(res, "oracleInput must be a string when provided");
          return;
        }
        if (
          genUseTransformationAgentRaw !== undefined &&
          typeof genUseTransformationAgentRaw !== "boolean"
        ) {
          badRequest(
            res,
            "useTransformationAgent must be a boolean when provided",
          );
          return;
        }
        const startTransformRun = orchestrator.startTransformRun;
        if (!orchestrator.enabled || !startTransformRun) {
          jsonResponse(res, 503, {
            error: "orchestrator URL is required for /api/v0/generate",
          });
          return;
        }
        const genSourceText = genSourceTextRaw;
        const genProgramId = resolveTransformProgramId(
          genSourceText,
          typeof genProgramIdRaw === "string" ? genProgramIdRaw : undefined,
        );
        const genSourceName =
          typeof genSourceNameRaw === "string" ? genSourceNameRaw : undefined;
        const genExpectedOutput =
          typeof genExpectedOutputRaw === "string"
            ? genExpectedOutputRaw
            : undefined;
        const genOracleInput =
          typeof genOracleInputRaw === "string" ? genOracleInputRaw : undefined;
        const genUseTransformationAgent =
          typeof genUseTransformationAgentRaw === "boolean"
            ? genUseTransformationAgentRaw
            : true;
        if (genUseTransformationAgent) {
          const gatewayAvailability =
            await verifyTransformationModelGatewayAvailable(modelGateway);
          if (!gatewayAvailability.ok) {
            jsonResponse(res, 503, {
              error: gatewayAvailability.message,
              failureCode: "model_gateway_unavailable",
            });
            return;
          }
        }
        try {
          const generateInput: Parameters<
            typeof orchestrator.startTransformRun
          >[0] = {
            programId: genProgramId,
            sourceText: genSourceText,
            requester: "c2c-ui",
            sourceName: genSourceName,
            options: genOptionsRaw,
            targetLanguage: genTargetLanguage,
            expectedOutput: genExpectedOutput,
            oracleInput: genOracleInput,
            useTransformationAgent: genUseTransformationAgent,
            // Studio-IDE-13 (#255): generator-only intent — the
            // orchestrator stops after the generate-java step and
            // finalises with the ``generate_only_complete`` failure
            // code. ``/api/v0/transform`` does NOT set this so the
            // composed Generate & Verify pipeline keeps running unchanged.
            generateOnly: true,
          };
          const upstream = await startTransformRun(generateInput);
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            const liveRunId = extractLiveRunId(upstream.body);
            const stored = runStore.create(
              createSourceTextSample(
                genProgramId,
                genSourceText,
                genSourceName,
              ),
              "live",
              liveRunId,
              {
                status: "starting",
                message: "run accepted by orchestrator",
              },
            );
            const synced = applyLiveRunPayload(stored, runStore, upstream.body);
            res.writeHead(201, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(
              JSON.stringify({
                ...transformResponse(synced),
                runMode: "generate",
              }),
            );
            return;
          }
          const genStatus = upstream?.status ?? 502;
          const genFailure = mapUpstreamUnavailable(
            `orchestrator rejected generate request${genStatus ? ` (status ${genStatus})` : ""}`,
          );
          jsonResponse(res, 502, {
            error: genFailure.message,
            failureCode: genFailure.code,
          });
          return;
        } catch (err) {
          const genFailure = mapUpstreamUnavailable(
            sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          );
          jsonResponse(res, 502, {
            error: genFailure.message,
            failureCode: genFailure.code,
          });
          return;
        }
      }

      // Studio-IDE-13 (#255): compile-check route. Sends the provided Java
      // files to the build-test-runner-service for a build-only check
      // (skipExecution: true). Returns normalised diagnostics.
      if (pathname === "/api/v0/compile-check" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        if (!buildTestRunner.enabled) {
          jsonResponse(res, 503, {
            error:
              "compile-check unavailable: build-test-runner-service URL is not configured",
          });
          return;
        }
        let ccBody: unknown;
        try {
          ccBody = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "request body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!ccBody || typeof ccBody !== "object" || Array.isArray(ccBody)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const ccRecord = ccBody as Record<string, unknown>;
        const ccJavaFiles = ccRecord.javaFiles;
        if (!Array.isArray(ccJavaFiles) || ccJavaFiles.length === 0) {
          badRequest(res, "javaFiles must be a non-empty array");
          return;
        }
        if (ccJavaFiles.length > JAVA_EXECUTION_MAX_FILES) {
          jsonResponse(res, 413, {
            error: `javaFiles must contain at most ${JAVA_EXECUTION_MAX_FILES} files`,
          });
          return;
        }
        const ccFilePaths = new Set<string>();
        for (let i = 0; i < ccJavaFiles.length; i += 1) {
          const entry = ccJavaFiles[i];
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            badRequest(res, `javaFiles[${i}] must be an object`);
            return;
          }
          const entryRecord = entry as Record<string, unknown>;
          if (
            typeof entryRecord.path !== "string" ||
            entryRecord.path.length === 0
          ) {
            badRequest(res, `javaFiles[${i}].path must be a non-empty string`);
            return;
          }
          if (!isSafeRequestJavaFilePath(entryRecord.path)) {
            badRequest(res, `javaFiles[${i}].path must be a safe relative path`);
            return;
          }
          if (!isJavaSourceFilePath(entryRecord.path)) {
            badRequest(res, `javaFiles[${i}].path must end with .java`);
            return;
          }
          const normalizedPath = normalizeRequestJavaFilePath(entryRecord.path);
          if (ccFilePaths.has(normalizedPath)) {
            badRequest(res, `javaFiles[${i}].path must be unique`);
            return;
          }
          ccFilePaths.add(normalizedPath);
          if (typeof entryRecord.content !== "string") {
            badRequest(res, `javaFiles[${i}].content must be a string`);
            return;
          }
        }
        // Total content size guard (mirrors /transform body cap).
        let ccTotalBytes = 0;
        for (const entry of ccJavaFiles as Array<{
          path: string;
          content: string;
        }>) {
          ccTotalBytes += Buffer.byteLength(entry.content, "utf8");
        }
        if (ccTotalBytes > config.transformSourceMaxBytes) {
          jsonResponse(res, 413, { error: "request body too large" });
          return;
        }
        const ccRunId =
          typeof ccRecord.runId === "string" && ccRecord.runId.length > 0
            ? ccRecord.runId
            : "compile-check";
        const ccEntryClass =
          typeof ccRecord.entryClass === "string" ? ccRecord.entryClass : "";
        const ccEntryFilePath =
          typeof ccRecord.entryFilePath === "string"
            ? ccRecord.entryFilePath
            : "";
        if (
          ccEntryFilePath.length > 0 &&
          (!isSafeRequestJavaFilePath(ccEntryFilePath) ||
            !ccFilePaths.has(normalizeRequestJavaFilePath(ccEntryFilePath)))
        ) {
          badRequest(
            res,
            "entryFilePath must be a safe relative path from javaFiles",
          );
          return;
        }
        const ccFiles: Record<string, string> = {};
        for (const entry of ccJavaFiles as Array<{
          path: string;
          content: string;
        }>) {
          ccFiles[normalizeRequestJavaFilePath(entry.path)] = entry.content;
        }
        const ccPayload = {
          programId: ccRunId,
          generatedProject: {
            files: ccFiles,
            entryClass: ccEntryClass,
            entryFilePath: ccEntryFilePath,
          },
          options: {
            skipExecution: true,
            compareOutput: false,
            timeoutMs: 5000,
          },
          oracle: {},
        };
        try {
          const upstream = await buildTestRunner.runVerification(
            ccPayload,
            5000,
          );
          if (!upstream) {
            jsonResponse(res, 503, {
              error:
                "compile check unavailable: no response from build-test-runner",
              failureCode: "service_unavailable",
            });
            return;
          }
          if (upstream.status >= 200 && upstream.status < 300) {
            const upRecord =
              upstream.body &&
              typeof upstream.body === "object" &&
              !Array.isArray(upstream.body)
                ? (upstream.body as Record<string, unknown>)
                : {};
            const rawDiagnostics = upRecord.diagnostics;
            const diagnostics = normalizeDiagnostics(rawDiagnostics, {
              defaultSourceKind: "build",
            });
            jsonResponse(res, 200, {
              schemaVersion: "v0",
              diagnostics,
            });
            return;
          }
          const upstreamError =
            upstream.body &&
            typeof upstream.body === "object" &&
            !Array.isArray(upstream.body)
              ? String((upstream.body as Record<string, unknown>).error ?? "")
              : "";
          jsonResponse(res, 503, {
            error: `compile check unavailable: ${upstreamError || `status ${upstream.status}`}`,
            failureCode: "service_unavailable",
          });
          return;
        } catch (err) {
          jsonResponse(res, 503, {
            error: `compile check unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
            failureCode: "service_unavailable",
          });
          return;
        }
      }

      // Studio-IDE-13 (#255): explicit verify route. Sends the provided Java
      // files to the build-test-runner-service for a full verification run
      // (build + test + oracle). Returns the run summary including manual-edit
      // provenance fields derived from the optional manualEditOverlay.
      if (pathname === "/api/v0/verify" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        if (!buildTestRunner.enabled) {
          jsonResponse(res, 503, {
            error:
              "verify unavailable: build-test-runner-service URL is not configured",
          });
          return;
        }
        let vBody: unknown;
        try {
          vBody = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: "request body too large" });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!vBody || typeof vBody !== "object" || Array.isArray(vBody)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const vRecord = vBody as Record<string, unknown>;
        if (typeof vRecord.runId !== "string" || vRecord.runId.length === 0) {
          badRequest(res, "runId must be a non-empty string");
          return;
        }
        const vRunId = vRecord.runId;
        const vJavaFiles = vRecord.javaFiles;
        if (!Array.isArray(vJavaFiles) || vJavaFiles.length === 0) {
          badRequest(res, "javaFiles must be a non-empty array");
          return;
        }
        if (vJavaFiles.length > JAVA_EXECUTION_MAX_FILES) {
          jsonResponse(res, 413, {
            error: `javaFiles must contain at most ${JAVA_EXECUTION_MAX_FILES} files`,
          });
          return;
        }
        const vFilePaths = new Set<string>();
        for (let i = 0; i < vJavaFiles.length; i += 1) {
          const entry = vJavaFiles[i];
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            badRequest(res, `javaFiles[${i}] must be an object`);
            return;
          }
          const entryRecord = entry as Record<string, unknown>;
          if (
            typeof entryRecord.path !== "string" ||
            entryRecord.path.length === 0
          ) {
            badRequest(res, `javaFiles[${i}].path must be a non-empty string`);
            return;
          }
          if (!isSafeRequestJavaFilePath(entryRecord.path)) {
            badRequest(res, `javaFiles[${i}].path must be a safe relative path`);
            return;
          }
          if (!isJavaSourceFilePath(entryRecord.path)) {
            badRequest(res, `javaFiles[${i}].path must end with .java`);
            return;
          }
          const normalizedPath = normalizeRequestJavaFilePath(entryRecord.path);
          if (vFilePaths.has(normalizedPath)) {
            badRequest(res, `javaFiles[${i}].path must be unique`);
            return;
          }
          vFilePaths.add(normalizedPath);
          if (typeof entryRecord.content !== "string") {
            badRequest(res, `javaFiles[${i}].content must be a string`);
            return;
          }
        }
        // Total content size guard.
        let vTotalBytes = 0;
        for (const entry of vJavaFiles as Array<{
          path: string;
          content: string;
        }>) {
          vTotalBytes += Buffer.byteLength(entry.content, "utf8");
        }
        if (vTotalBytes > config.transformSourceMaxBytes) {
          jsonResponse(res, 413, { error: "request body too large" });
          return;
        }
        const vProgramId =
          typeof vRecord.programId === "string" && vRecord.programId.length > 0
            ? vRecord.programId
            : `verify-${vRunId}`;
        const vEntryClass =
          typeof vRecord.entryClass === "string" ? vRecord.entryClass : "";
        const vEntryFilePath =
          typeof vRecord.entryFilePath === "string"
            ? vRecord.entryFilePath
            : "";
        if (
          vEntryFilePath.length > 0 &&
          (!isSafeRequestJavaFilePath(vEntryFilePath) ||
            !vFilePaths.has(normalizeRequestJavaFilePath(vEntryFilePath)))
        ) {
          badRequest(
            res,
            "entryFilePath must be a safe relative path from javaFiles",
          );
          return;
        }
        const vExpectedOutput =
          typeof vRecord.expectedOutput === "string"
            ? vRecord.expectedOutput
            : undefined;
        const vOracleInput =
          typeof vRecord.oracleInput === "string"
            ? vRecord.oracleInput
            : undefined;
        const vFiles: Record<string, string> = {};
        for (const entry of vJavaFiles as Array<{
          path: string;
          content: string;
        }>) {
          vFiles[normalizeRequestJavaFilePath(entry.path)] = entry.content;
        }
        const vOracle: Record<string, unknown> = {};
        if (vExpectedOutput !== undefined)
          vOracle.expectedOutput = vExpectedOutput;
        if (vOracleInput !== undefined) vOracle.oracleInput = vOracleInput;
        const vPayload = {
          runId: vRunId,
          programId: vProgramId,
          generatedProject: {
            files: vFiles,
            entryClass: vEntryClass,
            entryFilePath: vEntryFilePath,
          },
          options: {
            skipExecution: false,
            compareOutput: true,
            timeoutMs: 30000,
          },
          oracle: vOracle,
        };
        // Studio-IDE-13 / ADR-0007: derive manual-edit provenance fields from
        // the optional overlay submitted by the Studio. Both fields default to
        // false/0 when the overlay is absent (per ADR 0007 §4). Multi-file
        // Studio verification sends manualEditOverlays so every file's manual
        // regions contribute to the aggregate run-summary count.
        let manualEditsCarriedOver = false;
        let manualDriftRegionCount = 0;
        const countManualRegions = (vOverlayRaw: unknown): number => {
          if (
            !vOverlayRaw ||
            typeof vOverlayRaw !== "object" ||
            Array.isArray(vOverlayRaw)
          ) {
            return 0;
          }
          const overlayRecord = vOverlayRaw as Record<string, unknown>;
          const overlayRegions = overlayRecord.regions;
          let count = 0;
          if (Array.isArray(overlayRegions)) {
            for (const region of overlayRegions) {
              if (
                region &&
                typeof region === "object" &&
                !Array.isArray(region)
              ) {
                const regionRecord = region as Record<string, unknown>;
                if (
                  regionRecord.originClass === "manual_modified" ||
                  regionRecord.originClass === "manual_edit"
                ) {
                  count += 1;
                }
              }
            }
          }
          return count;
        };
        if (vRecord.manualEditOverlays !== undefined) {
          if (!Array.isArray(vRecord.manualEditOverlays)) {
            badRequest(res, "manualEditOverlays must be an array");
            return;
          }
          for (const overlay of vRecord.manualEditOverlays) {
            manualDriftRegionCount += countManualRegions(overlay);
          }
        } else {
          manualDriftRegionCount += countManualRegions(vRecord.manualEditOverlay);
        }
        manualEditsCarriedOver = manualDriftRegionCount > 0;
        try {
          const upstream = await buildTestRunner.runVerification(
            vPayload,
            30000,
          );
          if (!upstream) {
            jsonResponse(res, 503, {
              error: "verify unavailable: no response from build-test-runner",
              failureCode: "service_unavailable",
            });
            return;
          }
          if (upstream.status >= 200 && upstream.status < 300) {
            const upRecord =
              upstream.body &&
              typeof upstream.body === "object" &&
              !Array.isArray(upstream.body)
                ? (upstream.body as Record<string, unknown>)
                : {};
            const rawDiagnostics = upRecord.diagnostics;
            const diagnostics = normalizeDiagnostics(rawDiagnostics, {
              defaultSourceKind: "build",
            });
            // Studio-IDE-13 / ADR-0007: ``status`` and ``classification`` are
            // string fields on the wire. The build-test-runner always
            // populates them; defaulting to "incomplete" guards the
            // (defensive) case where an upstream returns 2xx with a partial
            // body, so the Studio's parser never sees a missing field.
            const verifyStatus =
              typeof upRecord.status === "string" && upRecord.status.length > 0
                ? upRecord.status
                : "incomplete";
            const verifyClassification =
              typeof upRecord.classification === "string" &&
              upRecord.classification.length > 0
                ? upRecord.classification
                : "skipped-no-execution";
            jsonResponse(res, 200, {
              schemaVersion: "v0",
              runId: vRunId,
              programId: vProgramId,
              status: verifyStatus,
              classification: verifyClassification,
              build: upRecord.build ?? null,
              execution: upRecord.execution ?? null,
              tests: upRecord.tests ?? null,
              goldenMaster: upRecord.goldenMaster ?? null,
              comparison: upRecord.comparison ?? null,
              diagnostics,
              outputRef: upRecord.outputRef ?? null,
              manualEditsCarriedOver,
              manualDriftRegionCount,
            });
            return;
          }
          const vUpstreamError =
            upstream.body &&
            typeof upstream.body === "object" &&
            !Array.isArray(upstream.body)
              ? String((upstream.body as Record<string, unknown>).error ?? "")
              : "";
          if (upstream.status >= 400 && upstream.status < 500) {
            jsonResponse(res, 400, {
              error:
                vUpstreamError ||
                `upstream rejected verify request (status ${upstream.status})`,
            });
            return;
          }
          jsonResponse(res, 503, {
            error: `verify unavailable: ${vUpstreamError || `status ${upstream.status}`}`,
            failureCode: "service_unavailable",
          });
          return;
        } catch (err) {
          jsonResponse(res, 503, {
            error: `verify unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
            failureCode: "service_unavailable",
          });
          return;
        }
      }

      // Issue #361: generalized manual diagnosis/repair lane.
      // Keep the legacy manual-compile-repair route stable, but forward the
      // request body opaquely so runtime/parity diagnosis fields survive
      // unchanged when the orchestrator emits the broader repair schema.
      if (pathname === "/api/v0/manual-compile-repair/diagnose" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        const diagnoseManualCompileRepair =
          orchestrator.diagnoseManualCompileRepair;
        if (!orchestrator.enabled || !diagnoseManualCompileRepair) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: orchestrator is not configured",
          });
          return;
        }
        const authSession = resolveEditorAssistSession(
          req,
          res,
          sessionStore,
          config.forceSecureSessionCookies,
        );
        if (!authSession.ok) {
          jsonResponse(res, 401, { error: authSession.message });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const record = body as Record<string, unknown>;
        const runId = typeof record.runId === "string" ? record.runId : "";
        if (!runId) {
          badRequest(res, "runId must be a non-empty string");
          return;
        }
        // Preserve the single-file and multi-file Studio overlay shapes.
        // The orchestrator still expects the legacy ``manualOverlay`` name,
        // so we keep the compatibility shim in one place.
        const manualOverlayEnvelope =
          Array.isArray(record.manualEditOverlays)
            ? {
                schemaVersion: "v0",
                regions: (record.manualEditOverlays as unknown[]).flatMap((overlay) => {
                  if (
                    overlay &&
                    typeof overlay === "object" &&
                    !Array.isArray(overlay) &&
                    Array.isArray((overlay as Record<string, unknown>).regions)
                  ) {
                    return (overlay as { regions: unknown[] }).regions;
                  }
                  return [];
                }),
              }
            : record.manualEditOverlay;
        const upstream = await diagnoseManualCompileRepair(runId, {
          ...record,
          requester: `studio:${authSession.record.tenantId}:${authSession.record.userId}`,
          manualOverlay: manualOverlayEnvelope,
        });
        if (!upstream) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: no orchestrator response",
          });
          return;
        }
        jsonResponse(
          res,
          upstream.status || 502,
          sanitizeManualRepairResponseBody(upstream.body),
        );
        return;
      }

      if (pathname === "/api/v0/manual-compile-repair/apply" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        const applyManualCompileRepair = orchestrator.applyManualCompileRepair;
        if (!orchestrator.enabled || !applyManualCompileRepair) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: orchestrator is not configured",
          });
          return;
        }
        const authSession = resolveEditorAssistSession(
          req,
          res,
          sessionStore,
          config.forceSecureSessionCookies,
        );
        if (!authSession.ok) {
          jsonResponse(res, 401, { error: authSession.message });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const record = body as Record<string, unknown>;
        const runId = typeof record.runId === "string" ? record.runId : "";
        if (!runId) {
          badRequest(res, "runId must be a non-empty string");
          return;
        }
        const upstream = await applyManualCompileRepair(runId, {
          ...record,
          requester: `studio:${authSession.record.tenantId}:${authSession.record.userId}`,
        });
        if (!upstream) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: no orchestrator response",
          });
          return;
        }
        jsonResponse(
          res,
          upstream.status || 502,
          sanitizeManualRepairResponseBody(upstream.body),
        );
        return;
      }

      if (pathname === "/api/v0/manual-compile-repair/reject" && method === "POST") {
        if (
          rejectUnauthenticatedStudioJsonRequest({
            req,
            res,
            allowedOrigins: config.studioCorsOrigins,
            sessionStore,
            forceSecureSessionCookies: config.forceSecureSessionCookies,
          })
        ) {
          return;
        }
        const rejectManualCompileRepair =
          orchestrator.rejectManualCompileRepair;
        if (!orchestrator.enabled || !rejectManualCompileRepair) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: orchestrator is not configured",
          });
          return;
        }
        const authSession = resolveEditorAssistSession(
          req,
          res,
          sessionStore,
          config.forceSecureSessionCookies,
        );
        if (!authSession.ok) {
          jsonResponse(res, 401, { error: authSession.message });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const record = body as Record<string, unknown>;
        const runId = typeof record.runId === "string" ? record.runId : "";
        if (!runId) {
          badRequest(res, "runId must be a non-empty string");
          return;
        }
        const upstream = await rejectManualCompileRepair(runId, {
          ...record,
          requester: `studio:${authSession.record.tenantId}:${authSession.record.userId}`,
        });
        if (!upstream) {
          jsonResponse(res, 503, {
            error: "manual compile repair unavailable: no orchestrator response",
          });
          return;
        }
        jsonResponse(
          res,
          upstream.status || 502,
          sanitizeManualRepairResponseBody(upstream.body),
        );
        return;
      }

      if (pathname === "/api/v0/model-gateway/health" && method === "GET") {
        if (!modelGateway.enabled) {
          jsonResponse(res, 503, {
            error: "Model Gateway unavailable in deterministic W0 mode",
          });
          return;
        }
        try {
          const upstream = await modelGateway.getHealth();
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            let capabilitiesBody: unknown;
            try {
              const capabilities = await modelGateway.getCapabilities();
              if (
                capabilities &&
                capabilities.status >= 200 &&
                capabilities.status < 300
              ) {
                capabilitiesBody = capabilities.body;
              }
            } catch {
              capabilitiesBody = undefined;
            }
            jsonResponse(
              res,
              upstream.status,
              normalizeModelGatewayHealthView(upstream.body, capabilitiesBody),
            );
            return;
          }
          jsonResponse(res, 503, {
            error: "Model Gateway upstream unavailable",
          });
        } catch (err) {
          jsonResponse(res, 503, { error: "Model Gateway upstream failed" });
        }
        return;
      }

      if (pathname === "/api/v0/model-gateway/models" && method === "GET") {
        if (!modelGateway.enabled) {
          jsonResponse(res, 503, {
            error: "Model Gateway unavailable in deterministic W0 mode",
          });
          return;
        }
        try {
          const upstream = await modelGateway.getModels();
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            jsonResponse(
              res,
              upstream.status,
              normalizeModelGatewayModelsView(upstream.body),
            );
            return;
          }
          jsonResponse(res, 503, {
            error: "Model Gateway upstream unavailable",
          });
        } catch (err) {
          jsonResponse(res, 503, { error: "Model Gateway upstream failed" });
        }
        return;
      }

      if (
        pathname === "/api/v0/model-gateway/capabilities" &&
        method === "GET"
      ) {
        if (!modelGateway.enabled) {
          jsonResponse(res, 503, {
            error: "Model Gateway unavailable in deterministic W0 mode",
          });
          return;
        }
        try {
          const upstream = await modelGateway.getCapabilities();
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            jsonResponse(
              res,
              upstream.status,
              normalizeModelGatewayCapabilitiesView(upstream.body),
            );
            return;
          }
          jsonResponse(res, 503, {
            error: "Model Gateway upstream unavailable",
          });
        } catch (err) {
          jsonResponse(res, 503, { error: "Model Gateway upstream failed" });
        }
        return;
      }

      if (pathname === "/api/v0/harness/ready" && method === "GET") {
        if (!harness.enabled) {
          jsonResponse(res, 503, { error: "Harness unavailable" });
          return;
        }
        try {
          const upstream = await harness.getReady();
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            jsonResponse(res, 200, normalizeHarnessReadyView(upstream.body));
            return;
          }
          jsonResponse(res, 503, { error: "Harness upstream unavailable" });
        } catch (err) {
          jsonResponse(res, 503, { error: "Harness upstream failed" });
        }
        return;
      }

      const sampleMatch = /^\/api\/v0\/samples\/([^\/]+)$/.exec(pathname);
      if (sampleMatch && method === "GET") {
        const programId = decodeURIComponent(sampleMatch[1] ?? "");
        const detail = samples.get(programId);
        if (!detail) {
          notFound(res, `unknown programId ${JSON.stringify(programId)}`);
          return;
        }
        jsonResponse(res, 200, detail satisfies SampleDetail);
        return;
      }

      const acceptanceFixtureMatch =
        /^\/api\/v0\/acceptance-fixtures\/([^\/]+)$/.exec(pathname);
      if (acceptanceFixtureMatch && method === "GET") {
        const fixtureId = decodeURIComponent(acceptanceFixtureMatch[1] ?? "");
        try {
          const detail = acceptanceFixtures().get(fixtureId);
          if (!detail) {
            notFound(
              res,
              `unknown acceptance fixtureId ${JSON.stringify(fixtureId)}`,
            );
            return;
          }
          jsonResponse(res, 200, detail satisfies AcceptanceFixtureDetail);
        } catch (err) {
          jsonResponse(res, 503, {
            error: `acceptance fixture registry unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
          });
        }
        return;
      }

      if (pathname === "/api/v0/runs" && method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : "invalid body");
          return;
        }
        if (!body || typeof body !== "object") {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const requestBody = body as Record<string, unknown>;
        const programIdRaw = requestBody.programId;
        const requesterRaw = requestBody.requester;
        if (typeof programIdRaw !== "string" || programIdRaw.length === 0) {
          badRequest(res, "programId is required");
          return;
        }
        let executionMode: RunExecutionMode = "standard";
        if (requestBody.executionMode !== undefined) {
          if (typeof requestBody.executionMode !== "string") {
            badRequest(res, "executionMode must be standard or parity");
            return;
          }
          const normalized = requestBody.executionMode.trim().toLowerCase();
          if (normalized !== "standard" && normalized !== "parity") {
            badRequest(res, "executionMode must be standard or parity");
            return;
          }
          executionMode = normalized;
        }
        let sourceReferenceMode: SourceReferenceMode | undefined;
        if (requestBody.sourceReferenceMode !== undefined) {
          if (typeof requestBody.sourceReferenceMode !== "string") {
            badRequest(
              res,
              "sourceReferenceMode must be reference-fixture or native-cobol",
            );
            return;
          }
          const normalized = requestBody.sourceReferenceMode
            .trim()
            .toLowerCase();
          if (
            normalized !== "reference-fixture" &&
            normalized !== "native-cobol"
          ) {
            badRequest(
              res,
              "sourceReferenceMode must be reference-fixture or native-cobol",
            );
            return;
          }
          sourceReferenceMode = normalized;
        }
        const trustCaseId =
          typeof requestBody.trustCaseId === "string" &&
          requestBody.trustCaseId.trim().length > 0
            ? requestBody.trustCaseId.trim()
            : undefined;
        if (
          requestBody.trustCaseId !== undefined &&
          requestBody.trustCaseId !== null &&
          trustCaseId === undefined
        ) {
          badRequest(res, "trustCaseId must be a non-empty string");
          return;
        }
        const sourceReferenceFixtureId =
          typeof requestBody.sourceReferenceFixtureId === "string" &&
          requestBody.sourceReferenceFixtureId.trim().length > 0
            ? requestBody.sourceReferenceFixtureId.trim()
            : undefined;
        if (
          requestBody.sourceReferenceFixtureId !== undefined &&
          requestBody.sourceReferenceFixtureId !== null &&
          sourceReferenceFixtureId === undefined
        ) {
          badRequest(res, "sourceReferenceFixtureId must be a non-empty string");
          return;
        }
        const parityRequested =
          executionMode === "parity" ||
          trustCaseId !== undefined ||
          sourceReferenceFixtureId !== undefined ||
          sourceReferenceMode !== undefined;
        if (parityRequested) {
          executionMode = "parity";
          sourceReferenceMode = sourceReferenceMode ?? "reference-fixture";
          if (!sourceReferenceFixtureId) {
            badRequest(res, "sourceReferenceFixtureId is required for parity runs");
            return;
          }
        }
        const sample = samples.get(programIdRaw);
        if (!sample) {
          notFound(res, `unknown programId ${JSON.stringify(programIdRaw)}`);
          return;
        }

        if (orchestrator.enabled) {
          try {
            const upstream = await orchestrator.startRun({
              programId: sample.programId,
              cobolSourcePath: sample.cobolSourcePath,
              requester:
                typeof requesterRaw === "string" ? requesterRaw : undefined,
              executionMode,
              trustCaseId,
              sourceReferenceFixtureId,
              sourceReferenceMode,
            });
            if (upstream && upstream.status >= 200 && upstream.status < 300) {
              const liveRunId = extractLiveRunId(upstream.body);
              const stored = runStore.create(sample, "live", liveRunId, {
                executionMode,
                trustCaseId,
                sourceReferenceFixtureId,
                sourceReferenceMode,
                status: "starting",
                message: "run accepted by orchestrator",
              });
              const synced = applyLiveRunPayload(
                stored,
                runStore,
                upstream.body,
              );
              res.writeHead(201, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify(runSummary(synced)));
              return;
            }
            const status = upstream?.status ?? 502;
            jsonResponse(res, 502, {
              error: `orchestrator rejected run request${status ? ` (${status})` : ""}`,
            });
            return;
          } catch (err) {
            jsonResponse(res, 502, {
              error: sanitizeUpstreamMessage(
                err instanceof Error ? err.message : "",
                "orchestrator request failed",
              ),
            });
            return;
          }
        }

        if (parityRequested) {
          jsonResponse(res, 503, {
            error:
              "orchestrator URL is required for parity runs; the BFF delegates parity workflow authority to the Orchestrator",
          });
          return;
        }

        if (!config.enableDiagnosticFixtures) {
          jsonResponse(res, 503, {
            error:
              "product mode not ready: orchestrator URL is required (set C2C_ORCHESTRATOR_URL). Developer-only diagnostic fixtures can be opted into with C2C_ENABLE_DIAGNOSTIC_FIXTURES=true; the resulting run is labelled diagnostic-fixture and is never a product result.",
          });
          return;
        }

        const stored = runStore.create(sample, "diagnostic-fixture");
        const completed =
          runStore.update(stored.runId, {
            status: "completed",
            message:
              "diagnostic fixture run completed (C2C_ENABLE_DIAGNOSTIC_FIXTURES); not a product result",
            evidenceRefs: [],
          }) ?? stored;
        res.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(runSummary(completed)));
        return;
      }

      const runMatch = /^\/api\/v0\/runs\/([^\/]+)$/.exec(pathname);
      if (runMatch && method === "GET") {
        const runId = decodeURIComponent(runMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        let current = stored;
        if (
          current.mode === "live" &&
          orchestrator.enabled &&
          current.liveRunId
        ) {
          try {
            const upstream = await orchestrator.getRun(current.liveRunId);
            if (upstream && upstream.status >= 200 && upstream.status < 300) {
              current = applyLiveRunPayload(current, runStore, upstream.body);
            }
          } catch {
            // keep last-known state; UI shows updatedAt
          }
          // Issue #172: refresh the W0.2 contract surface on every poll so
          // the UI sees activeStep/repairBudget/failureCode update in real
          // time without an extra round trip.
          const workflowResult = await fetchWorkflowSnapshot(
            current,
            orchestrator,
            runStore,
          );
          current = workflowResult.stored;
        }
        jsonResponse(res, 200, runSummary(current));
        return;
      }

      // Issue #172: dedicated endpoint for the full W0.2 workflow view
      // (state, active step/agent, repair budget+attempts, failure code).
      const workflowMatch = /^\/api\/v0\/runs\/([^\/]+)\/workflow$/.exec(
        pathname,
      );
      if (workflowMatch && method === "GET") {
        const runId = decodeURIComponent(workflowMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(
            res,
            200,
            workflowEnvelope(
              stored,
              { ...EMPTY_WORKFLOW_SNAPSHOT },
              "unavailable",
            ),
          );
          return;
        }
        const {
          stored: refreshed,
          snapshot,
          source,
        } = await fetchWorkflowSnapshot(stored, orchestrator, runStore);
        jsonResponse(res, 200, workflowEnvelope(refreshed, snapshot, source));
        return;
      }

      const genMatch = /^\/api\/v0\/runs\/([^\/]+)\/generated$/.exec(pathname);
      if (genMatch && method === "GET") {
        const runId = decodeURIComponent(genMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture" && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureGeneratedView(stored));
          return;
        }
        jsonResponse(res, 200, await liveGeneratedView(stored, orchestrator));
        return;
      }

      const generatedFilesIndex =
        /^\/api\/v0\/runs\/([^\/]+)\/generated\/files$/.exec(pathname);
      if (generatedFilesIndex && method === "GET") {
        const runId = decodeURIComponent(generatedFilesIndex[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "diagnostic-fixture",
            productMode: "unavailable",
            status: "incomplete",
            missingArtifacts: ["generated-project"],
            files: [],
            note: "Diagnostic-fixture runs do not expose a generated Java project.",
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "live",
            productMode: "unavailable",
            status: "incomplete",
            missingArtifacts: ["generated-project"],
            files: [],
            note: "Live run id is unavailable; orchestrator has not yet accepted this run.",
          });
          return;
        }
        try {
          const upstream = await orchestrator.getGeneratedFiles(liveRunId);
          if (!upstream || upstream.status < 200 || upstream.status >= 300) {
            jsonResponse(res, 200, {
              runId: stored.runId,
              programId: stored.programId,
              mode: "live",
              productMode: "unavailable",
              status: "incomplete",
              missingArtifacts: ["generated-project"],
              files: [],
              orchestratorRunId: liveRunId,
              note: "Orchestrator did not return a generated-Java file index for this run.",
            });
            return;
          }
          const envelope = asRecord(upstream.body) ?? {};
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId || asString(envelope.programId),
            mode: "live",
            productMode: "live",
            status: asString(envelope.status) || "incomplete",
            missingArtifacts: Array.isArray(envelope.missingArtifacts)
              ? (envelope.missingArtifacts as unknown[]).filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
            files: normalizeGeneratedFileRefs(envelope.files),
            fileCount:
              asNumber(envelope.fileCount) ??
              normalizeGeneratedFileRefs(envelope.files).length,
            entryFilePath: asString(envelope.entryFilePath),
            artifactRef: normalizeOutputRef(envelope.artifactRef),
            orchestratorRunId: liveRunId,
          });
          return;
        } catch (err) {
          jsonResponse(res, 502, {
            error: sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          });
          return;
        }
      }

      const generatedFileContent =
        /^\/api\/v0\/runs\/([^\/]+)\/generated\/files\/(.+)$/.exec(pathname);
      if (generatedFileContent && method === "GET") {
        const runId = decodeURIComponent(generatedFileContent[1] ?? "");
        const decodedPath = decodeRequestPath(generatedFileContent[2] ?? "");
        if (!isSafeGeneratedRelpath(decodedPath)) {
          jsonResponse(res, 400, { error: "invalid generated file path" });
          return;
        }
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 404, {
            error: "generated file unavailable for diagnostic-fixture runs",
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 503, {
            error: "orchestrator unavailable; generated file cannot be served",
          });
          return;
        }
        try {
          const upstream = await orchestrator.getGeneratedFile(
            liveRunId,
            decodedPath,
            config.artifactContentMaxBytes,
          );
          if (!upstream) {
            jsonResponse(res, 502, { error: "orchestrator request failed" });
            return;
          }
          // Issue #172 follow-up: the streaming reader aborted because the
          // upstream payload exceeded the cap. Refuse before any further
          // processing so a malicious orchestrator cannot smuggle oversized
          // content through the JSON envelope.
          if (upstream.truncated) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              limit: config.artifactContentMaxBytes,
            });
            return;
          }
          if (upstream.status === 404) {
            jsonResponse(res, 404, {
              error: "generated file not found",
              path: decodedPath,
            });
            return;
          }
          if (upstream.status === 400) {
            jsonResponse(res, 400, {
              error: "invalid generated file path",
              path: decodedPath,
            });
            return;
          }
          if (upstream.status < 200 || upstream.status >= 300) {
            jsonResponse(res, 502, {
              error: `orchestrator returned status ${upstream.status}`,
            });
            return;
          }
          const envelope = asRecord(upstream.body) ?? {};
          const content = asString(envelope.content);
          // Issue #172: trust the upstream's declared byteSize *only* when
          // it agrees with the served content. A malicious orchestrator
          // could otherwise report ``byteSize: 1`` and still smuggle a
          // larger payload through ``content``. We compare both and take
          // the maximum so the cap cannot be bypassed.
          const declaredByteSize = asNumber(envelope.byteSize);
          const measuredByteSize = Buffer.byteLength(content, "utf-8");
          const byteSize =
            declaredByteSize === undefined
              ? measuredByteSize
              : Math.max(declaredByteSize, measuredByteSize);
          if (byteSize > config.artifactContentMaxBytes) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              byteSize,
              limit: config.artifactContentMaxBytes,
            });
            return;
          }
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "live",
            productMode: "live",
            path: asString(envelope.path) || decodedPath,
            content,
            sha256: asString(envelope.sha256),
            byteSize,
            mimeType: asString(envelope.mimeType),
            kind: asString(envelope.kind),
            orchestratorRunId: liveRunId,
          });
          return;
        } catch (err) {
          if (err instanceof UpstreamResponseTooLargeError) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              byteSize: err.declaredByteSize,
              limit: err.limit,
            });
            return;
          }
          jsonResponse(res, 502, {
            error: sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          });
          return;
        }
      }

      const artifactFileContent =
        /^\/api\/v0\/runs\/([^\/]+)\/artifacts\/files\/(.+)$/.exec(pathname);
      if (artifactFileContent && method === "GET") {
        const runId = decodeURIComponent(artifactFileContent[1] ?? "");
        const decodedPath = decodeRequestPath(artifactFileContent[2] ?? "");
        if (!isSafeGeneratedRelpath(decodedPath)) {
          jsonResponse(res, 400, { error: "invalid artifact path" });
          return;
        }
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 404, {
            error: "artifact unavailable for diagnostic-fixture runs",
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 503, {
            error: "orchestrator unavailable; artifact cannot be served",
          });
          return;
        }
        try {
          const getArtifactFile = orchestrator.getArtifactFile;
          if (typeof getArtifactFile !== "function") {
            jsonResponse(res, 503, {
              error: "orchestrator unavailable; artifact cannot be served",
            });
            return;
          }
          const upstream = await getArtifactFile(
            liveRunId,
            decodedPath,
            config.artifactContentMaxBytes,
          );
          if (!upstream) {
            jsonResponse(res, 502, { error: "orchestrator request failed" });
            return;
          }
          if (upstream.truncated) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              limit: config.artifactContentMaxBytes,
            });
            return;
          }
          if (upstream.status === 404) {
            jsonResponse(res, 404, {
              error: "artifact not found",
              path: decodedPath,
            });
            return;
          }
          if (upstream.status === 400) {
            jsonResponse(res, 400, {
              error: "invalid artifact path",
              path: decodedPath,
            });
            return;
          }
          if (upstream.status < 200 || upstream.status >= 300) {
            jsonResponse(res, 502, {
              error: `orchestrator returned status ${upstream.status}`,
            });
            return;
          }
          const envelope = asRecord(upstream.body) ?? {};
          const content = asString(envelope.content);
          const declaredByteSize = asNumber(envelope.byteSize);
          const measuredByteSize = Buffer.byteLength(content, "utf-8");
          const byteSize =
            declaredByteSize === undefined
              ? measuredByteSize
              : Math.max(declaredByteSize, measuredByteSize);
          if (byteSize > config.artifactContentMaxBytes) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              byteSize,
              limit: config.artifactContentMaxBytes,
            });
            return;
          }
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "live",
            productMode: "live",
            path: asString(envelope.path) || decodedPath,
            content,
            sha256: asString(envelope.sha256),
            byteSize,
            mimeType: asString(envelope.mimeType),
            kind: asString(envelope.kind),
            orchestratorRunId: liveRunId,
          });
          return;
        } catch (err) {
          if (err instanceof UpstreamResponseTooLargeError) {
            jsonResponse(res, 413, {
              error: "artifact_too_large",
              path: decodedPath,
              byteSize: err.declaredByteSize,
              limit: err.limit,
            });
            return;
          }
          jsonResponse(res, 502, {
            error: sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          });
          return;
        }
      }

      const btMatch = /^\/api\/v0\/runs\/([^\/]+)\/build-test$/.exec(pathname);
      if (btMatch && method === "GET") {
        const runId = decodeURIComponent(btMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture" && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureBuildTestView(stored));
          return;
        }
        jsonResponse(res, 200, await liveBuildTestView(stored, orchestrator));
        return;
      }

      const evMatch = /^\/api\/v0\/runs\/([^\/]+)\/evidence$/.exec(pathname);
      if (evMatch && method === "GET") {
        const runId = decodeURIComponent(evMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture" && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureEvidenceView(stored));
          return;
        }
        jsonResponse(res, 200, await liveEvidenceView(stored, orchestrator));
        return;
      }

      const progressMatch = /^\/api\/v0\/runs\/([^\/]+)\/progress$/.exec(
        pathname,
      );
      if (progressMatch && method === "GET") {
        const runId = decodeURIComponent(progressMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            productMode: "unavailable",
            status: "incomplete",
            runStatus: stored.status,
            currentStep: null,
            failedStep: null,
            completedSteps: [],
            stepCount: 0,
            steps: [],
            missingArtifacts: ["run-progress"],
            note: "Diagnostic-fixture runs do not produce a pipeline progress timeline.",
          });
          return;
        }
        jsonResponse(res, 200, await liveProgressView(stored, orchestrator));
        return;
      }

      const learningMatch = /^\/api\/v0\/runs\/([^\/]+)\/learning$/.exec(
        pathname,
      );
      if (learningMatch && method === "GET") {
        const runId = decodeURIComponent(learningMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            productMode: "unavailable",
            status: "incomplete",
            summary: null,
            source: "unavailable",
            missingArtifacts: ["learning-summary"],
            note: "Diagnostic-fixture runs are never observed by experience-learning.",
          });
          return;
        }
        jsonResponse(
          res,
          200,
          await liveLearningView(stored, orchestrator, experienceLearning),
        );
        return;
      }

      const experienceMatch = /^\/api\/v0\/runs\/([^\/]+)\/experience$/.exec(
        pathname,
      );
      if (experienceMatch && method === "GET") {
        const runId = decodeURIComponent(experienceMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            productMode: "unavailable",
          });
          return;
        }
        jsonResponse(
          res,
          200,
          await liveExperienceView(stored, orchestrator, experienceLearning),
        );
        return;
      }

      const eventsMatch = /^\/api\/v0\/runs\/([^\/]+)\/events$/.exec(pathname);
      if (eventsMatch && method === "GET") {
        const runId = decodeURIComponent(eventsMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            productMode: "unavailable",
            events: [],
          });
          return;
        }
        jsonResponse(res, 200, await liveEventsView(stored, orchestrator));
        return;
      }

      const traceabilityMatch =
        /^\/api\/v0\/runs\/([^\/]+)\/traceability$/.exec(pathname);
      if (traceabilityMatch && method === "GET") {
        const runId = decodeURIComponent(traceabilityMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            schemaVersion: "v0" as const,
            runId: stored.runId,
            programId: stored.programId,
            trace: null,
            irSymbolMap: {},
            javaRegionClassification: null,
          });
          return;
        }
        const { view, cacheJavaRegionClassification } =
          await liveTraceabilityView(stored, orchestrator);
        const viewRecord = asRecord(view);
        if (
          cacheJavaRegionClassification &&
          viewRecord &&
          "javaRegionClassification" in viewRecord
        ) {
          const javaRegionClassification =
            viewRecord.javaRegionClassification === null
              ? null
              : normalizeJavaRegionClassification(
                  viewRecord.javaRegionClassification,
                );
          runStore.update(stored.runId, { javaRegionClassification });
        }
        jsonResponse(res, 200, view);
        return;
      }

      const artifactsMatch = /^\/api\/v0\/runs\/([^\/]+)\/artifacts$/.exec(
        pathname,
      );
      if (artifactsMatch && method === "GET") {
        const runId = decodeURIComponent(artifactsMatch[1] ?? "");
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === "diagnostic-fixture") {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "diagnostic-fixture",
            productMode: "unavailable",
            artifacts: [],
            note: "Diagnostic-fixture runs do not persist on-disk artifacts; not a product result.",
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: "live",
            productMode: "unavailable",
            artifacts: [],
            missingArtifacts: ["artifacts-index"],
            note: "Live run id is unavailable; orchestrator has not yet accepted this run.",
          });
          return;
        }
        try {
          const upstream = await orchestrator.getArtifacts(liveRunId);
          if (!upstream || upstream.status < 200 || upstream.status >= 300) {
            jsonResponse(res, 200, {
              runId: stored.runId,
              programId: stored.programId,
              mode: "live",
              productMode: "unavailable",
              artifacts: [],
              missingArtifacts: ["artifacts-index"],
              orchestratorRunId: liveRunId,
              note: "Orchestrator did not return an artifacts index for this run.",
            });
            return;
          }
          const envelope = asRecord(upstream.body) ?? {};
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId:
              stored.programId ||
              (typeof envelope.programId === "string"
                ? envelope.programId
                : ""),
            mode: "live",
            productMode: "live",
            orchestratorRunId: liveRunId,
            artifacts: Array.isArray(envelope.artifacts)
              ? envelope.artifacts
                  .map((entry) => normalizeRunArtifact(entry))
                  .filter(
                    (entry): entry is Record<string, unknown> => entry !== null,
                  )
              : [],
            summary: envelope.summary ?? null,
            createdAt: envelope.createdAt ?? null,
            updatedAt: envelope.updatedAt ?? null,
          });
          return;
        } catch (err) {
          jsonResponse(res, 502, {
            error: sanitizeUpstreamMessage(
              err instanceof Error ? err.message : "",
              "orchestrator request failed",
            ),
          });
          return;
        }
      }

      if (pathname.startsWith("/api/")) {
        notFound(res);
        return;
      }

      if (method === "GET" && serveStatic(res, config.staticRoot, pathname)) {
        return;
      }

      notFound(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      jsonResponse(res, 500, { error: message });
    }
  };
}

export function startServer(deps: ServerDeps): http.Server {
  const handler = createApp(deps);
  const server = http.createServer(handler);
  server.listen(deps.config.port, deps.config.host);
  return server;
}
