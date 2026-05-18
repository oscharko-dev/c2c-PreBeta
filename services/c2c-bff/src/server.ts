import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
// Studio-IDE-5 (#244): typed Diagnostic surface. The shape and the
// normalization rules live in `./diagnostics.ts` so the BFF handlers
// and the dedicated unit tests share a single source of truth.
import { normalizeDiagnostics, type Diagnostic } from "./diagnostics";
// Studio-IDE-14 (#256): typed request validation + upstream response
// normalisation for the Java formatter route.
import {
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
  validateExplainRequest,
  type BudgetSnapshot,
  type EditorAssistBudgetStore,
  type EditorAssistLedgerEntry,
  type EditorExplainErrorCode,
  type EditorRegion,
  type SequenceCounter,
} from "./editorExplain";

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

const LOCAL_CORS_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface ServerDeps {
  config: BffConfig;
  samples?: SampleRegistry;
  acceptanceFixtures?: AcceptanceFixtureRegistry;
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
  // Per-request collector for ledger entries the BFF would normally
  // forward to the trajectory ledger pipeline. V1 keeps the entry
  // in-process so the audit trail shape is contract-stable today
  // (asserted by tests) and a future task can wire the sink without
  // contract surgery. ``undefined`` means "discard"; tests pass a
  // capturing array to inspect the entry.
  editorAssistLedgerSink?: (entry: EditorAssistLedgerEntry) => void;
  now?: () => Date;
}

interface ResolvedDeps {
  config: BffConfig;
  samples: SampleRegistry;
  acceptanceFixtures: () => AcceptanceFixtureRegistry;
  orchestrator: OrchestratorClient;
  evidence: EvidenceClient;
  experienceLearning: ExperienceLearningClient;
  modelGateway: ModelGatewayClient;
  harness: HarnessClient;
  buildTestRunner: BuildTestRunnerClient;
  runStore: RunStore;
  editorAssistBudgets: EditorAssistBudgetStore;
  editorAssistSequence: SequenceCounter;
  editorAssistLedgerSink: (entry: EditorAssistLedgerEntry) => void;
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
  return {
    config: deps.config,
    samples: deps.samples ?? loadSampleRegistry(deps.config.repoRoot),
    acceptanceFixtures: acceptanceFixturesAccessor,
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
    editorAssistLedgerSink: deps.editorAssistLedgerSink ?? (() => undefined),
    now: deps.now ?? (() => new Date()),
  };
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

function applyLocalApiCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return;
  }

  try {
    const parsed = new URL(origin);
    if (!LOCAL_CORS_HOSTS.has(parsed.hostname)) {
      return;
    }
  } catch {
    return;
  }

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "Origin");
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

function productModeOf(stored: StoredRun): "live" | "unavailable" {
  return stored.mode === "live" ? "live" : "unavailable";
}

function runSummary(stored: StoredRun): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    runId: stored.runId,
    programId: stored.programId,
    status: stored.status,
    mode: stored.mode,
    productMode: productModeOf(stored),
    message: stored.message,
    policyDecision: stored.policyDecision,
    evidenceRefs: [],
    orchestratorRunId: stored.liveRunId ?? "",
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    // Issue #172: W0.2 contract surface. Fields are present on every
    // response so the UI can drive a stable model, even when the underlying
    // run has not produced a workflow contract yet.
    activeStep: stored.activeStep ?? null,
    agentAttemptCount: stored.agentAttemptCount ?? 0,
    repairBudget: stored.repairBudget ?? null,
    // Issue #216 (W0.3-5): expose assist + Model Gateway budgets on the
    // summary endpoint too so listing views can render budget pressure
    // without an extra workflow fetch.
    assistBudget: stored.assistBudget ?? null,
    modelInvocationBudget: stored.modelInvocationBudget ?? null,
    finalClassification: stored.finalClassification ?? null,
    failureCode: stored.failureCode ?? null,
    failureMessage: stored.failureMessage ?? null,
    // Studio-IDE-6 (#248): per-file Java region classification cached from
    // the orchestrator's traceability payload. Absent until first traceability
    // fetch; null when unavailable.
    javaRegionClassification: stored.javaRegionClassification ?? null,
  };
  return summary;
}

function runLinks(runId: string): Record<string, string> {
  return {
    self: `/api/v0/runs/${runId}`,
    generated: `/api/v0/runs/${runId}/generated`,
    generatedFiles: `/api/v0/runs/${runId}/generated/files`,
    buildTest: `/api/v0/runs/${runId}/build-test`,
    evidence: `/api/v0/runs/${runId}/evidence`,
    artifacts: `/api/v0/runs/${runId}/artifacts`,
    progress: `/api/v0/runs/${runId}/progress`,
    learning: `/api/v0/runs/${runId}/learning`,
    experience: `/api/v0/runs/${runId}/experience`,
    workflow: `/api/v0/runs/${runId}/workflow`,
    traceability: `/api/v0/runs/${runId}/traceability`,
  };
}

function isSafeGeneratedRelpath(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.includes("\0")) return false;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) return false;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function transformLinks(runId: string): Record<string, string> {
  return {
    ...runLinks(runId),
    events: `/api/v0/runs/${runId}/events`,
  };
}

function transformResponse(stored: StoredRun): Record<string, unknown> {
  return {
    ...runSummary(stored),
    links: transformLinks(stored.runId),
  };
}

function createSourceTextSample(
  programId: string,
  sourceText: string,
  sourceName?: string,
): SampleDetail {
  return {
    programId,
    title: sourceName
      ? `Transform run from ${sourceName}`
      : `Transform run for ${programId}`,
    description: "Synthetic sample created from source text",
    knownDivergenceAtW0: false,
    supportedInProductMode: true,
    w0Subset: [],
    oracleMode: null,
    knownLimitations: [],
    cobolSource: sourceText,
    cobolSourcePath: `transforms/${programId}.cbl`,
    expectedOutput: "",
    expectedOutputPath: "",
  };
}

function extractProgramIdFromSourceText(sourceText: string): string {
  const match = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i.exec(sourceText);
  if (match?.[1]) {
    return match[1].toUpperCase();
  }
  const digest = createHash("sha256")
    .update(sourceText, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `SRC-${digest}`;
}

function resolveTransformProgramId(
  sourceText: string,
  requestedProgramId?: string,
): string {
  if (
    typeof requestedProgramId === "string" &&
    requestedProgramId.trim().length > 0
  ) {
    return requestedProgramId.trim();
  }
  return extractProgramIdFromSourceText(sourceText);
}

function diagnosticFixtureGeneratedView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    ...stored.fixture.generated,
    files: {},
    fileCount: Object.keys(stored.fixture.generated.files).length,
    fileRefs: Object.keys(stored.fixture.generated.files).map((path) => ({
      path,
    })),
    note: `${stored.fixture.generated.note} Generated source content is intentionally available only through the capped generated-file endpoint in product mode.`,
  };
}

function diagnosticFixtureBuildTestView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    expectedOutput: stored.sample.expectedOutput,
    ...stored.fixture.buildTest,
  };
}

function diagnosticFixtureEvidenceView(
  stored: StoredRun,
): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: "diagnostic-fixture",
    productMode: "unavailable",
    ...stored.fixture.evidence,
  };
}

function liveArtifactRunId(stored: StoredRun): string | undefined {
  return stored.liveRunId && stored.liveRunId.length > 0
    ? stored.liveRunId
    : undefined;
}

function incompleteEnvelope(
  stored: StoredRun,
  missing: string[],
  note: string,
): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
    status: "incomplete",
    missingArtifacts: missing,
    note,
  };
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

function normalizeExperienceViewFromSummary(
  stored: StoredRun,
  learningView: Record<string, unknown>,
  summaryRaw: Record<string, unknown>,
): Record<string, unknown> {
  const candidateCount = asNumber(summaryRaw.candidateCount) ?? 0;
  const sourceEventCount = asNumber(summaryRaw.sourceEventCount);
  const sourceLedgerCount = asNumber(summaryRaw.sourceLedgerCount);
  const observedPatterns = asStringArray(summaryRaw.observedPatterns);
  const experienceEventIds = asStringArray(summaryRaw.experienceEventIds);
  const candidateByPattern = asRecord(summaryRaw.candidateByPattern) ?? {};
  const patternBreakdown = Object.entries(candidateByPattern)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    .map(([pattern, count]) => `${pattern}: ${count}`);
  const observationOnly = asBoolean(summaryRaw.observationOnly) ?? false;
  const policyVersion = asString(summaryRaw.policyVersion);
  const policyFingerprint = asString(summaryRaw.policyFingerprint);
  const learningSignals = normalizeLearningSignals(summaryRaw.signals);

  const summaryParts = [
    `${candidateCount} learning candidate${candidateCount === 1 ? "" : "s"} observed`,
    sourceEventCount !== undefined
      ? `from ${sourceEventCount} source events`
      : "",
    sourceLedgerCount !== undefined
      ? `${sourceLedgerCount} source ledgers considered`
      : "",
    observationOnly ? "observation-only mode" : "",
  ].filter((part) => part.length > 0);

  const observationPolicy = [policyVersion, policyFingerprint]
    .filter((part) => part.length > 0)
    .join(" / ");

  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: learningView.mode,
    productMode: learningView.productMode,
    summary: summaryParts.join(" • "),
    observationPolicy,
    learningSignals,
    detectedPatterns: [...observedPatterns, ...patternBreakdown],
    artifactRefs: experienceEventIds,
  };
}

function normalizeLearningSignals(
  raw: unknown,
): Array<Record<string, unknown>> {
  const signals: Array<Record<string, unknown>> = [];
  if (!Array.isArray(raw)) return signals;
  for (const entry of raw) {
    const item = asRecord(entry);
    if (!item) continue;
    const key = asString(item.key);
    const label = asString(item.label);
    const status = asString(item.status);
    if (!key || !label || !status) continue;
    signals.push({
      key,
      label,
      status,
      summary: asString(item.summary),
      count: asNumber(item.count) ?? 0,
      evidenceRefs: asStringArray(item.evidenceRefs),
    });
  }
  return signals;
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

function normalizeOutputRef(raw: unknown): OutputRef | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  const ref: OutputRef = {
    sha256,
  };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  for (const key of [
    "kind",
    "path",
    "name",
    "mimeType",
    "createdBy",
    "createdAt",
  ] as const) {
    const value = asString(record[key]);
    if (value.length > 0) ref[key] = value;
  }
  return ref;
}

function normalizeGeneratedFileRef(
  raw: unknown,
): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const path = asString(record.path);
  if (!isSafeGeneratedRelpath(path)) return null;
  const ref: Record<string, unknown> = { path };
  for (const key of ["sha256", "mimeType", "kind", "name"] as const) {
    const value = asString(record[key]);
    if (value.length > 0) ref[key] = value;
  }
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  return ref;
}

function normalizeGeneratedFileRefs(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeGeneratedFileRef(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function normalizeRunArtifact(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  const artifact: Record<string, unknown> = { sha256 };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) artifact.byteSize = byteSize;
  for (const key of [
    "kind",
    "name",
    "mimeType",
    "createdBy",
    "createdAt",
  ] as const) {
    const value = asString(record[key]);
    if (value.length > 0) artifact[key] = value;
  }
  const path = asString(record.path);
  if (path.length > 0 && isSafeGeneratedRelpath(path)) {
    artifact.path = path;
  }
  return artifact;
}

type GeneratedStatus = "generated" | "unsupported" | "skipped" | "incomplete";

function classifyGeneratedStatus(
  missing: string[],
  runStatus: string | undefined,
): GeneratedStatus {
  if (missing.length === 0) return "generated";
  if (runStatus === "failed") return "unsupported";
  return "skipped";
}

function classifyBuildTestStatus(
  missing: string[],
  runStatus: string | undefined,
  data: Record<string, unknown> | undefined,
): {
  status:
    | "ok"
    | "compile-failed"
    | "run-failed"
    | "output-divergence"
    | "golden-master-reproduction-failed"
    | "missing-golden-master"
    | "skipped";
  classification:
    | "match"
    | "divergence-known-w0-coverage-gap"
    | "divergence-unknown"
    | "true-golden-master-reproduction-error"
    | "true-golden-master-mismatch"
    | "compile-error"
    | "run-error"
    | "skipped-no-execution";
} {
  if (missing.length > 0) {
    return runStatus === "failed"
      ? { status: "run-failed", classification: "run-error" }
      : { status: "skipped", classification: "skipped-no-execution" };
  }
  const upstreamStatus = typeof data?.status === "string" ? data.status : "";
  const upstreamClassification =
    typeof data?.classification === "string" ? data.classification : "";
  const allowedStatus = new Set([
    "ok",
    "compile-failed",
    "run-failed",
    "output-divergence",
    "golden-master-reproduction-failed",
    "missing-golden-master",
    "skipped",
  ]);
  const allowedClassification = new Set([
    "match",
    "divergence-known-w0-coverage-gap",
    "divergence-unknown",
    "true-golden-master-reproduction-error",
    "true-golden-master-mismatch",
    "compile-error",
    "run-error",
    "skipped-no-execution",
  ]);
  const status = allowedStatus.has(upstreamStatus)
    ? (upstreamStatus as "ok")
    : "ok";
  const classification = allowedClassification.has(upstreamClassification)
    ? (upstreamClassification as "match")
    : "match";
  return { status, classification };
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
    let status: GeneratedStatus = classifyGeneratedStatus(missing, runStatus);
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
    const traceability = asRecord(envelope.traceability) ?? {};
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
      traceability: {
        programId: asString(traceability.programId),
        irId: asString(traceability.irId),
        sourceHash: asString(traceability.sourceHash),
      },
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
  if (execution && typeof execution.stdout === "string")
    return execution.stdout;
  return "";
}

function deriveExpectedOutput(
  data: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!data) return fallback;
  if (typeof data.expectedOutput === "string") return data.expectedOutput;
  const golden = asRecord(data.goldenMaster);
  if (golden && typeof golden.expected === "string") return golden.expected;
  const comparison = asRecord(data.comparison);
  if (comparison && typeof comparison.expected === "string")
    return comparison.expected;
  return fallback;
}

function deriveComparisonOutputRef(
  data: Record<string, unknown> | undefined,
  field: "expectedRef" | "actualRef",
): OutputRef | null {
  const comparison = asRecord(data?.comparison);
  return comparison ? normalizeOutputRef(comparison[field]) : null;
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
      expectedOutput: deriveExpectedOutput(data, stored.sample.expectedOutput),
      actualOutput: deriveActualOutput(data),
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

function deriveValidationStatus(
  data: Record<string, unknown> | undefined,
): "valid" | "invalid" | "incomplete" | "unknown" {
  if (!data) return "unknown";
  const validation = asRecord(data.validation);
  if (validation) {
    const validationStatus = asString(validation.status);
    if (validationStatus === "valid") return "valid";
    if (validationStatus === "invalid") return "invalid";
    if (validationStatus === "incomplete") return "incomplete";
    const missing = Array.isArray(validation.missingArtifacts)
      ? validation.missingArtifacts
      : [];
    if (missing.length > 0) return "incomplete";
    return "valid";
  }
  const manifestStatus = asString(data.status);
  if (manifestStatus === "complete") return "valid";
  if (manifestStatus === "invalid") return "invalid";
  if (manifestStatus === "incomplete") return "incomplete";
  return "unknown";
}

function deriveExportRef(
  data: Record<string, unknown> | undefined,
): OutputRef | null {
  if (!data) return null;
  const exports = data.exports;
  if (!Array.isArray(exports) || exports.length === 0) return null;
  for (const entry of exports) {
    const record = asRecord(entry);
    if (!record) continue;
    const ref = normalizeOutputRef(record);
    if (ref) return ref;
  }
  return null;
}

function deriveMissingFromValidation(
  data: Record<string, unknown> | undefined,
): string[] {
  if (!data) return [];
  const validation = asRecord(data.validation);
  if (!validation) return [];
  const raw = validation.missingArtifacts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
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
  originClass: string;
  verificationOutcome: string;
  mappingClass: string;
}

async function liveTraceabilityView(
  stored: StoredRun,
  orchestrator: OrchestratorClient,
): Promise<Record<string, unknown>> {
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
      ...stubEnvelope,
      note: "Live run id is unavailable; traceability cannot be served.",
    };
  }
  try {
    const upstream = await orchestrator.getTraceability(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...stubEnvelope,
        note: "Live run id is unavailable; traceability cannot be served.",
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
    const jrcRaw = body.javaRegionClassification;
    let javaRegionClassification: Record<
      string,
      JavaRegionClassification[]
    > | null = null;
    if (
      jrcRaw !== null &&
      typeof jrcRaw === "object" &&
      !Array.isArray(jrcRaw)
    ) {
      const jrcRecord = asRecord(jrcRaw) ?? {};
      const result: Record<string, JavaRegionClassification[]> = {};
      for (const [file, arr] of Object.entries(jrcRecord)) {
        if (!Array.isArray(arr)) continue;
        const valid: JavaRegionClassification[] = [];
        for (const entry of arr) {
          const e = asRecord(entry);
          if (!e) continue;
          const lr = asRecord(e.lineRange);
          if (!lr) continue;
          const startLine = asNumber(lr.startLine);
          const endLine = asNumber(lr.endLine);
          const originClass = asString(e.originClass);
          const verificationOutcome = asString(e.verificationOutcome);
          const mappingClass = asString(e.mappingClass);
          if (
            startLine !== undefined &&
            Number.isInteger(startLine) &&
            endLine !== undefined &&
            Number.isInteger(endLine) &&
            originClass &&
            verificationOutcome &&
            mappingClass
          ) {
            valid.push({
              schemaVersion: "v0",
              lineRange: { startLine, endLine },
              originClass,
              verificationOutcome,
              mappingClass,
            });
          }
        }
        result[file] = valid;
      }
      javaRegionClassification = result;
    }
    return {
      schemaVersion: "v0" as const,
      runId: stored.runId,
      programId: stored.programId,
      trace,
      irSymbolMap,
      javaRegionClassification,
    };
  } catch {
    return {
      ...stubEnvelope,
      note: "Live run id is unavailable; traceability cannot be served.",
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

function normalizePipelineStep(raw: unknown): PipelineStep | null {
  const record = asRecord(raw);
  if (!record) return null;
  const name = asString(record.name);
  if (!name) return null;
  const stepId = asNumber(record.stepId) ?? 0;
  const inputRef = normalizeOutputRef(record.inputRef);
  const outputRef = normalizeOutputRef(record.outputRef);
  const step: PipelineStep = {
    stepId,
    name,
    capabilityId: asString(record.capabilityId),
    service: asString(record.service),
    actor: asString(record.actor),
    status: asPipelineStepStatus(record.status),
  };
  const startedAt = asString(record.startedAt);
  if (startedAt) step.startedAt = startedAt;
  const finishedAt = asString(record.finishedAt);
  if (finishedAt) step.finishedAt = finishedAt;
  const diagnostic = asString(record.diagnostic);
  if (diagnostic) {
    step.diagnostic = sanitizeProgressDiagnostic(diagnostic, step.status);
  }
  if (inputRef) step.inputRef = inputRef;
  if (outputRef) step.outputRef = outputRef;
  const latency = asNumber(record.latencyMs);
  if (latency !== undefined) step.latencyMs = latency;
  return step;
}

function sanitizeUiRunEvent(raw: unknown): UiRunEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const event: UiRunEvent = {};
  const type = asString(record.type);
  if (type) event.type = type;
  const status = asString(record.status);
  if (status) event.status = status;
  const message = asString(record.message);
  if (message) {
    const safeMessage = sanitizeUpstreamMessage(message, "");
    if (safeMessage) event.message = safeMessage;
  }
  const createdAt = asString(record.createdAt);
  if (createdAt) event.createdAt = createdAt;
  return Object.keys(event).length > 0 ? event : null;
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

function asFinalClassification(value: unknown): RunFinalClassification | null {
  if (typeof value !== "string") return null;
  if (FINAL_CLASSIFICATIONS_SET.has(value as RunFinalClassification)) {
    return value as RunFinalClassification;
  }
  return null;
}

function asRepairBudget(value: unknown): StoredRepairBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

// Issue #216 (W0.3-5): the assist and model-invocation budgets share the
// repair budget's {limit, used, remaining} shape. Sanitisation rejects
// negative or missing counters so the UI cannot render a corrupt budget,
// then falls back to the obvious arithmetic for ``remaining`` when the
// upstream omitted it.
function asAssistBudget(value: unknown): StoredAssistBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

function asModelInvocationBudget(
  value: unknown,
): StoredModelInvocationBudget | null {
  const record = asRecord(value);
  if (!record) return null;
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined) return null;
  if (limit < 0 || used < 0) return null;
  const remaining = asNumber(record.remaining) ?? Math.max(0, limit - used);
  return { limit, used, remaining };
}

// Active agent is derived from ``activeStep`` so the BFF never echoes
// orchestrator-internal step ids the UI cannot recognise. Anything we
// don't know maps to ``null`` so the UI can suppress the agent badge.
function deriveActiveAgent(activeStep: string | null): string | null {
  if (!activeStep) return null;
  const normalized = activeStep.replace(/_/g, "-").toLowerCase();
  if (normalized.includes("transformation-agent"))
    return "transformation_agent";
  if (
    normalized.includes("verification-repair-agent") ||
    normalized.includes("verification-repair")
  ) {
    return "verification_repair_agent";
  }
  if (normalized.includes("parse-cobol") || normalized.includes("cobol-parser"))
    return "cobol_parser";
  if (normalized.includes("semantic-ir")) return "semantic_ir";
  if (
    normalized.includes("generate-java") ||
    normalized.includes("java-generation")
  )
    return "java_generator";
  if (normalized.includes("compile-test") || normalized.includes("build-test"))
    return "build_test_runner";
  if (normalized.includes("write-evidence") || normalized.includes("evidence"))
    return "evidence_service";
  return null;
}

interface SanitizedRepairAttempt {
  attemptNumber: number;
  repairDecision: string;
  failureCategory: string | null;
  hasModelInvocation: boolean;
  hasRepairInput: boolean;
  hasJavaCandidate: boolean;
  rationale?: string;
}

const REPAIR_DECISION_SET = new Set([
  "propose_candidate",
  "refuse",
  "escalate",
  "no_change",
]);

function sanitizeRepairAttempts(raw: unknown): SanitizedRepairAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedRepairAttempt[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const attemptNumber = asNumber(record.attemptNumber);
    if (attemptNumber === undefined || attemptNumber < 1) continue;
    const decisionRaw = asString(record.repairDecision);
    if (!REPAIR_DECISION_SET.has(decisionRaw)) continue;
    const failureCategoryRaw = asString(record.failureCategory);
    const sanitized: SanitizedRepairAttempt = {
      attemptNumber,
      repairDecision: decisionRaw,
      failureCategory:
        failureCategoryRaw.length > 0 ? failureCategoryRaw : null,
      hasModelInvocation: asRecord(record.modelInvocationRef) !== undefined,
      hasRepairInput: asRecord(record.repairInputRef) !== undefined,
      hasJavaCandidate: asRecord(record.javaCandidateRef) !== undefined,
    };
    const rationaleRaw = record.rationale;
    if (typeof rationaleRaw === "string" && rationaleRaw.length > 0) {
      sanitized.rationale = sanitizeUpstreamMessage(rationaleRaw, "");
    }
    out.push(sanitized);
  }
  return out;
}

function safeArtifactRef(
  value: unknown,
): { sha256: string; byteSize: number; kind: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  return {
    sha256,
    byteSize: asNumber(record.byteSize) ?? 0,
    kind: asString(record.kind),
  };
}

// W0.3 (#214) assist-decision gate summary surfaced to UI consumers.
// Closed-set strings mirror the orchestrator-owned values; the BFF never
// invents values for these fields and silently drops anything it does not
// recognise so the UI cannot render an unknown reason.
export type AssistDecisionOutcome = "assist_required" | "assist_not_required";
// Closed reason-code set mirrors the orchestrator contract. The first four
// entries are the deterministic uncertainty criteria (Issue #215); the
// next two are the caller-driven baseline (Issue #214); the last entry
// (``assist_budget_exhausted``) is the W0.3-5 hard-termination signal
// added by Issue #216 — the caller opted in but the per-run assist
// budget has no units left, so the deterministic baseline is the final
// candidate. The BFF never invents values for this field.
export type AssistDecisionReasonCode =
  | "semantic_ir_bounded_ambiguity"
  | "translation_unsupported_repairable"
  | "baseline_open_assumptions"
  | "deterministic_candidate_low_confidence"
  | "caller_explicit_opt_in"
  | "caller_did_not_opt_in"
  | "assist_budget_exhausted";
export type AssistDecisionAgentRole = "transformation_agent";

export interface AssistDecisionArtifactRef {
  sha256?: string;
  byteSize?: number;
  kind?: string;
  path?: string;
}

export interface AssistDecisionSummary {
  outcome: AssistDecisionOutcome;
  reasonCode: AssistDecisionReasonCode;
  decidedAt: string;
  selectedAgentRole: AssistDecisionAgentRole | null;
  affectedArtifactRefs: AssistDecisionArtifactRef[];
  repairBudgetSnapshot: StoredRepairBudget | null;
  // Issue #216 (W0.3-5): per-run assist + Model Gateway budget snapshots
  // captured at gate time so consumers can audit budget state without
  // having to correlate the live ``assistBudget`` / ``modelInvocationBudget``
  // fields with the gate's decidedAt timestamp.
  assistBudgetSnapshot: StoredAssistBudget | null;
  modelInvocationBudgetSnapshot: StoredModelInvocationBudget | null;
  rationale: string | null;
}

export interface WorkflowSnapshot {
  state: string | null;
  activeStep: string | null;
  activeAgent: string | null;
  agentAttemptCount: number;
  repairBudget: StoredRepairBudget | null;
  // Issue #216 (W0.3-5): assist and Model Gateway budgets surfaced on
  // every snapshot so the UI can render remaining/used counts in real time.
  assistBudget: StoredAssistBudget | null;
  modelInvocationBudget: StoredModelInvocationBudget | null;
  repairAttempts: SanitizedRepairAttempt[];
  assistDecision: AssistDecisionSummary | null;
  finalClassification: RunFinalClassification | null;
  failureCode: W02UiErrorCode | null;
  failureMessage: string | null;
  generatedJavaRef: { sha256: string; byteSize: number; kind: string } | null;
  buildTestResultRef: { sha256: string; byteSize: number; kind: string } | null;
  evidencePackRef: { sha256: string; byteSize: number; kind: string } | null;
}

const EMPTY_WORKFLOW_SNAPSHOT: WorkflowSnapshot = {
  state: null,
  activeStep: null,
  activeAgent: null,
  agentAttemptCount: 0,
  repairBudget: null,
  assistBudget: null,
  modelInvocationBudget: null,
  repairAttempts: [],
  assistDecision: null,
  finalClassification: null,
  failureCode: null,
  failureMessage: null,
  generatedJavaRef: null,
  buildTestResultRef: null,
  evidencePackRef: null,
};

const ASSIST_DECISION_OUTCOMES: ReadonlySet<AssistDecisionOutcome> = new Set([
  "assist_required",
  "assist_not_required",
]);
const ASSIST_DECISION_REASONS: ReadonlySet<AssistDecisionReasonCode> = new Set([
  "semantic_ir_bounded_ambiguity",
  "translation_unsupported_repairable",
  "baseline_open_assumptions",
  "deterministic_candidate_low_confidence",
  "caller_explicit_opt_in",
  "caller_did_not_opt_in",
  "assist_budget_exhausted",
]);
const ASSIST_DECISION_AGENT_ROLES: ReadonlySet<AssistDecisionAgentRole> =
  new Set(["transformation_agent"]);

function sanitizeAssistArtifactRef(
  value: unknown,
): AssistDecisionArtifactRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref: AssistDecisionArtifactRef = {};
  const sha = asString(record.sha256);
  if (sha) ref.sha256 = sha;
  const byteSize = asNumber(record.byteSize);
  if (typeof byteSize === "number" && byteSize >= 0) ref.byteSize = byteSize;
  const kind = asString(record.kind);
  if (kind) ref.kind = kind;
  const refPath = asString(record.path);
  if (refPath) ref.path = refPath;
  return Object.keys(ref).length > 0 ? ref : null;
}

function sanitizeAssistDecision(value: unknown): AssistDecisionSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  const outcome = asString(record.outcome) as AssistDecisionOutcome | "";
  if (!outcome || !ASSIST_DECISION_OUTCOMES.has(outcome)) return null;
  const reasonCode = asString(record.reasonCode) as
    | AssistDecisionReasonCode
    | "";
  if (!reasonCode || !ASSIST_DECISION_REASONS.has(reasonCode)) return null;
  const decidedAt = asString(record.decidedAt) || "";
  if (!decidedAt) return null;
  const rawRole = asString(record.selectedAgentRole);
  const selectedAgentRole: AssistDecisionAgentRole | null =
    rawRole &&
    ASSIST_DECISION_AGENT_ROLES.has(rawRole as AssistDecisionAgentRole)
      ? (rawRole as AssistDecisionAgentRole)
      : null;
  if (outcome === "assist_required" && selectedAgentRole === null) return null;
  if (outcome === "assist_not_required" && selectedAgentRole !== null)
    return null;
  const affected: AssistDecisionArtifactRef[] = [];
  if (Array.isArray(record.affectedArtifactRefs)) {
    for (const entry of record.affectedArtifactRefs) {
      const sanitized = sanitizeAssistArtifactRef(entry);
      if (sanitized) affected.push(sanitized);
    }
  }
  const repairBudgetSnapshot = asRepairBudget(record.repairBudgetSnapshot);
  const assistBudgetSnapshot = asAssistBudget(record.assistBudgetSnapshot);
  const modelInvocationBudgetSnapshot = asModelInvocationBudget(
    record.modelInvocationBudgetSnapshot,
  );
  const rationale = asString(record.rationale) || null;
  return {
    outcome,
    reasonCode,
    decidedAt,
    selectedAgentRole,
    affectedArtifactRefs: affected,
    repairBudgetSnapshot,
    assistBudgetSnapshot,
    modelInvocationBudgetSnapshot,
    rationale,
  };
}

function snapshotFromContract(
  contract: Record<string, unknown> | undefined,
): WorkflowSnapshot {
  if (!contract) return { ...EMPTY_WORKFLOW_SNAPSHOT };
  const state = asString(contract.currentState) || null;
  const activeStep = asString(contract.activeStep) || null;
  const agentAttemptCount = asNumber(contract.agentAttemptCount) ?? 0;
  const repairBudget = asRepairBudget(contract.repairBudget);
  const assistBudget = asAssistBudget(contract.assistBudget);
  const modelInvocationBudget = asModelInvocationBudget(
    contract.modelInvocationBudget,
  );
  const repairAttempts = sanitizeRepairAttempts(contract.repairAttempts);
  const assistDecision = sanitizeAssistDecision(contract.assistDecision);
  const finalClassification = asFinalClassification(
    contract.finalClassification,
  );
  const rawFailureCode = contract.failureCode;
  const rawFailureMessage = contract.failureMessage;
  let failureCode: W02UiErrorCode | null = null;
  let failureMessage: string | null = null;
  const mapped = mapFailure(rawFailureCode, rawFailureMessage);
  if (mapped !== null) {
    failureCode = mapped.code;
    failureMessage = mapped.message;
  } else if (
    finalClassification &&
    finalClassification !== "success" &&
    finalClassification !== "incomplete"
  ) {
    // The contract reports a non-success terminal classification but no
    // canonical failure code: keep the surface honest by emitting
    // ``internal_error`` rather than silently dropping the failure.
    failureCode = "internal_error";
    failureMessage = sanitizeUpstreamMessage(
      rawFailureMessage,
      defaultMessageFor("internal_error"),
    );
  }
  return {
    state,
    activeStep,
    activeAgent: deriveActiveAgent(activeStep),
    agentAttemptCount,
    repairBudget,
    assistBudget,
    modelInvocationBudget,
    repairAttempts,
    assistDecision,
    finalClassification,
    failureCode,
    failureMessage,
    generatedJavaRef: safeArtifactRef(contract.generatedJavaRef),
    buildTestResultRef: safeArtifactRef(contract.buildTestResultRef),
    evidencePackRef: safeArtifactRef(contract.evidencePackRef),
  };
}

function workflowEnvelope(
  stored: StoredRun,
  snapshot: WorkflowSnapshot,
  source: "live" | "cached" | "unavailable",
): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    productMode: productModeOf(stored),
    source,
    state: snapshot.state,
    activeStep: snapshot.activeStep,
    activeAgent: snapshot.activeAgent,
    agentAttemptCount: snapshot.agentAttemptCount,
    repairBudget: snapshot.repairBudget,
    assistBudget: snapshot.assistBudget,
    modelInvocationBudget: snapshot.modelInvocationBudget,
    repairAttempts: snapshot.repairAttempts,
    assistDecision: snapshot.assistDecision,
    finalClassification: snapshot.finalClassification,
    failureCode: snapshot.failureCode,
    failureMessage: snapshot.failureMessage,
    generatedJavaRef: snapshot.generatedJavaRef,
    buildTestResultRef: snapshot.buildTestResultRef,
    evidencePackRef: snapshot.evidencePackRef,
  };
}

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
  };
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
  ledgerSink: (entry: EditorAssistLedgerEntry) => void;
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

async function handleEditorExplain(
  args: HandleEditorExplainArgs,
): Promise<void> {
  const { req, res, modelGateway, budgets, sequence, ledgerSink, now } = args;
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

  const scope = {
    tenantId: request.tenantId,
    userId: request.userId,
    sessionId: request.sessionId,
  };
  const consume = await budgets.consume(scope);
  if (!consume.ok) {
    emitEditorExplainError(res, consume.errorCode, consume.snapshot);
    return;
  }

  const startedAt = now().toISOString();
  let gatewayResponse: UpstreamResponse | undefined;
  let upstreamError = false;
  try {
    gatewayResponse = await modelGateway.explain({
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      sessionId: request.sessionId,
      tenantId: request.tenantId,
      userId: request.userId,
      runId: request.runId,
      sourceHash: request.sourceHash,
      region: request.region,
      redactedBytes: request.redactedBytes,
      byteHash: request.byteHash,
      studioRedactionMetadata: request.studioRedactionMetadata,
    });
  } catch (err) {
    if (err instanceof UpstreamResponseTooLargeError) {
      upstreamError = true;
      // M3: log oversize responses distinctly so operators can tune the cap.
      console.warn(
        JSON.stringify({
          route: "/api/v0/editor/explain",
          event: "gateway_call_failed",
          errorClass: "UpstreamResponseTooLargeError",
          message: sanitizeUpstreamMessage(
            err instanceof Error ? err.message : String(err),
            defaultMessageForErrorCode("gateway_unavailable"),
          ),
        }),
      );
    } else {
      upstreamError = true;
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
            defaultMessageForErrorCode("gateway_unavailable"),
          ),
        }),
      );
    }
  }

  const mapped = upstreamError
    ? ({
        kind: "error",
        errorCode: "gateway_unavailable",
        message: defaultMessageForErrorCode("gateway_unavailable"),
      } as const)
    : mapGatewayResponse(gatewayResponse);

  const endedAt = now().toISOString();
  const seq = sequence.next({
    tenantId: request.tenantId,
    sessionId: request.sessionId,
  });
  const editorAssistRef = buildEditorAssistRef({
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    seq,
  });
  const localLedgerRef = buildLocalLedgerRef({
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    seq,
  });

  if (mapped.kind === "error") {
    const ledgerEntry = buildLedgerEntry({
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      tenantId: request.tenantId,
      userId: request.userId,
      sessionId: request.sessionId,
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
    ledgerSink(ledgerEntry);
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
    tenantId: request.tenantId,
    userId: request.userId,
    sessionId: request.sessionId,
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
  ledgerSink(ledgerEntry);

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
    now: nowFn,
  } = resolved;

  return async function handler(req, res) {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = requestUrl.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (pathname.startsWith("/api/")) {
        applyLocalApiCors(req, res);
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
          raw = await readJsonBody(req, config.formatJavaSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, formatUnavailable("request body too large"));
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
          });
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
        await handleEditorExplain({
          req,
          res,
          modelGateway,
          budgets: editorAssistBudgets,
          sequence: editorAssistSequence,
          ledgerSink: editorAssistLedgerSink,
          now: nowFn,
        });
        return;
      }

      // Studio-IDE-10 (#249): editor-assist channel — budget snapshot
      // endpoint. The Studio uses this on session start to hide the
      // primary action button when the per-session budget is already
      // exhausted (AC8 in the issue body).
      if (pathname === "/api/v0/editor/budget" && method === "GET") {
        const sessionIdRaw = requestUrl.searchParams.get("sessionId");
        if (!sessionIdRaw || sessionIdRaw.trim().length === 0) {
          badRequest(res, "sessionId must be a non-empty string");
          return;
        }
        const tenantIdRaw = requestUrl.searchParams.get("tenantId");
        const userIdRaw = requestUrl.searchParams.get("userId");
        const tenantId =
          tenantIdRaw && tenantIdRaw.trim().length > 0
            ? tenantIdRaw
            : "default";
        const userId =
          userIdRaw && userIdRaw.trim().length > 0 ? userIdRaw : "local";
        const snapshot = editorAssistBudgets.snapshot({
          tenantId,
          userId,
          sessionId: sessionIdRaw,
        });
        jsonResponse(res, 200, {
          schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
          budget: snapshot,
        });
        return;
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
          useTransformationAgentRaw !== undefined &&
          typeof useTransformationAgentRaw !== "boolean"
        ) {
          badRequest(
            res,
            "useTransformationAgent must be a boolean when provided",
          );
          return;
        }
        if (!orchestrator.enabled) {
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
        const useTransformationAgent =
          typeof useTransformationAgentRaw === "boolean"
            ? useTransformationAgentRaw
            : true;

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
            options: optionsRaw,
            targetLanguage,
            expectedOutput,
            oracleInput,
            useTransformationAgent,
          };
          const upstream = await orchestrator.startTransformRun(transformInput);
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            const liveRunId = extractLiveRunId(upstream.body);
            const stored = runStore.create(
              createSourceTextSample(programId, sourceText, sourceName),
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
        if (!orchestrator.enabled) {
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
          const upstream = await orchestrator.startTransformRun(generateInput);
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
        const ccFiles: Record<string, string> = {};
        for (const entry of ccJavaFiles as Array<{
          path: string;
          content: string;
        }>) {
          ccFiles[entry.path] = entry.content;
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
          vFiles[entry.path] = entry.content;
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
        // false/0 when the overlay is absent (per ADR 0007 §4).
        let manualEditsCarriedOver = false;
        let manualDriftRegionCount = 0;
        const vOverlayRaw = vRecord.manualEditOverlay;
        if (
          vOverlayRaw &&
          typeof vOverlayRaw === "object" &&
          !Array.isArray(vOverlayRaw)
        ) {
          const overlayRecord = vOverlayRaw as Record<string, unknown>;
          const overlayRegions = overlayRecord.regions;
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
                  manualDriftRegionCount += 1;
                }
              }
            }
            manualEditsCarriedOver = manualDriftRegionCount > 0;
          }
        }
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
        const programIdRaw = (body as Record<string, unknown>).programId;
        const requesterRaw = (body as Record<string, unknown>).requester;
        if (typeof programIdRaw !== "string" || programIdRaw.length === 0) {
          badRequest(res, "programId is required");
          return;
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
            });
            if (upstream && upstream.status >= 200 && upstream.status < 300) {
              const liveRunId = extractLiveRunId(upstream.body);
              const stored = runStore.create(sample, "live", liveRunId, {
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
        const rawPath = generatedFileContent[2] ?? "";
        const decodedPath = rawPath
          .split("/")
          .filter((segment) => segment.length > 0)
          .map((segment) => decodeURIComponent(segment))
          .join("/");
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
        jsonResponse(
          res,
          200,
          await liveTraceabilityView(stored, orchestrator),
        );
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
  server.listen(deps.config.port);
  return server;
}
