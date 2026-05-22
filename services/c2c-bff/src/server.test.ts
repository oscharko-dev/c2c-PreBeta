import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import * as os from "node:os";

import {
  createApp,
  createJsonlEditorAssistLedgerSink,
  JAVA_EXECUTION_MAX_FILES,
  type EditorAssistLedgerSink,
} from "./server";
import { createRunStore } from "./run-store";
import {
  PLACEHOLDER_JAVA_MARKERS,
  findPlaceholderMarker,
} from "./placeholder-markers";
import * as path from "node:path";
import * as fs from "node:fs";
import type { SampleDetail, SampleRegistry, SampleSummary } from "./samples";
import {
  createEvidenceClient,
  createOrchestratorClient,
  type BuildTestRunnerClient,
  type EvidenceClient,
  type HttpClient,
  type HttpRequestOptions,
  type ModelGatewayClient,
  type OrchestratorClient,
  type UpstreamResponse,
} from "./upstream";
import { loadConfig, type BffConfig } from "./config";
import {
  DEFAULT_EDITOR_ASSIST_BUDGET,
  createEditorAssistBudgetStore,
  type EditorAssistLedgerEntry,
  type BudgetSnapshot,
} from "./editorExplain";
import { createSessionStore, type SessionStore } from "./sessionStore";
import { SESSION_COOKIE_NAME } from "./sessionCookie";
import type { TrustCaseCatalog, TrustCaseSummary } from "./trust-cases";

const FIXED_SAMPLE: SampleDetail = {
  programId: "BRNCH01",
  title: "Branch approval guard",
  description: "fixture sample",
  knownDivergenceAtW0: false,
  supportedInProductMode: true,
  w0Subset: ["MOVE", "PERFORM", "EVALUATE", "ADD", "DISPLAY"],
  oracleMode: "cobol-runtime",
  knownLimitations: [],
  cobolSource: "IDENTIFICATION DIVISION.\nPROGRAM-ID. BRNCH01.\n",
  cobolSourcePath: "corpus/synthetic/programs/branch-account-guard.cbl",
  expectedOutput: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
  expectedOutputPath:
    "corpus/synthetic/fixtures/branch-account-guard-output.txt",
};

const FIXED_SAMPLE_2: SampleDetail = {
  ...FIXED_SAMPLE,
  programId: "BATCH01",
  knownDivergenceAtW0: false,
  w0Subset: ["PERFORM", "COMPUTE", "ADD", "DISPLAY"],
  oracleMode: "synthetic-fixture",
};

function stubSamples(items: SampleDetail[]): SampleRegistry {
  const byId = new Map(items.map((item) => [item.programId, item]));
  return {
    list(): SampleSummary[] {
      return items.map(
        ({
          programId,
          title,
          description,
          knownDivergenceAtW0,
          supportedInProductMode,
          w0Subset,
          oracleMode,
          knownLimitations,
        }) => ({
          programId,
          title,
          description,
          knownDivergenceAtW0,
          supportedInProductMode,
          w0Subset,
          oracleMode,
          knownLimitations,
        }),
      );
    },
    get(programId: string): SampleDetail | undefined {
      return byId.get(programId);
    },
  };
}

const FIXED_TRUST_CASE: TrustCaseSummary = {
  trustCaseId: "HELLO01-DEFAULT",
  version: "2026-05-21",
  catalogVersion: "2026-05-21",
  catalogHash: "0".repeat(64),
  configurationDigest: "1".repeat(64),
  programId: "HELLO01",
  title: "HELLO01 default parity trust case",
  description: "Default immutable parity case for HELLO01.",
  defaultForProgram: true,
  sourceReferenceFixtureId: "HELLOW02",
  sourceReferenceMode: "reference-fixture",
  environmentProfileId: "generated-java-sandbox-v1",
  comparisonStrategy: "deterministic-output",
  comparisonPolicyVersion: "deterministic-output-v1",
  supportedSubset: ["DISPLAY", "STOP-RUN"],
};

function stubTrustCases(items: TrustCaseSummary[]): TrustCaseCatalog {
  const byId = new Map(items.map((item) => [item.trustCaseId, item]));
  return {
    schemaVersion: "v0",
    catalogVersion: "2026-05-21",
    catalogHash: "0".repeat(64),
    list(programId?: string): TrustCaseSummary[] {
      return items.filter((item) => !programId || item.programId === programId);
    },
    get(trustCaseId: string): TrustCaseSummary | undefined {
      return byId.get(trustCaseId);
    },
    defaultForProgram(programId: string): TrustCaseSummary | undefined {
      return items.find(
        (item) => item.programId === programId && item.defaultForProgram,
      );
    },
  };
}

interface ArtifactStubResponses {
  generated?: UpstreamResponse;
  generatedFiles?: UpstreamResponse;
  generatedFile?:
    | UpstreamResponse
    | ((path: string) => UpstreamResponse | undefined);
  artifactFile?:
    | UpstreamResponse
    | ((path: string) => UpstreamResponse | undefined);
  buildTest?: UpstreamResponse;
  manualCompileRepair?: {
    preview?: UpstreamResponse;
    diagnose?: UpstreamResponse;
    apply?: UpstreamResponse;
    accept?: UpstreamResponse;
    reject?: UpstreamResponse;
  };
  exportParityRegression?: UpstreamResponse;
  evidence?: UpstreamResponse;
  events?: UpstreamResponse;
  artifacts?: UpstreamResponse;
  progress?: UpstreamResponse;
  learning?: UpstreamResponse;
  workflow?: UpstreamResponse;
  // Studio-IDE-6 (#248): per-run trust-pillar traceability payload.
  traceability?: UpstreamResponse;
}

function stubOrchestrator(artifactResponses: ArtifactStubResponses = {}): {
  client: OrchestratorClient;
  calls: {
    startRun: number;
    startRunInputs: Array<{
      programId: string;
      cobolSourcePath: string;
      requester?: string;
      executionMode?: "standard" | "parity";
      trustCaseId?: string;
      sourceReferenceFixtureId?: string;
      sourceReferenceMode?: "reference-fixture" | "native-cobol";
    }>;
    getRun: number;
    startTransformRun: Array<{
      programId: string;
      sourceText: string;
      requester?: string;
      sourceName?: string;
      options?: unknown;
      targetLanguage?: string;
      expectedOutput?: string;
      oracleInput?: string;
      useTransformationAgent?: boolean;
      executionMode?: "standard" | "parity";
      trustCaseId?: string;
      generateOnly?: boolean;
    }>;
    getGenerated: number;
    getGeneratedFiles: number;
    getGeneratedFile: Array<{ runId: string; path: string }>;
    getArtifactFile: Array<{ runId: string; path: string }>;
    getBuildTest: number;
    manualCompileRepair: {
      preview: Array<{ runId: string; payload: unknown }>;
      diagnose: Array<{ runId: string; payload: unknown }>;
      apply: Array<{ runId: string; payload: unknown }>;
      accept: Array<{ runId: string; payload: unknown }>;
      reject: Array<{ runId: string; payload: unknown }>;
    };
    exportParityRegression: Array<{ runId: string; payload: unknown }>;
    getEvidence: number;
    getEvents: number;
    getArtifacts: number;
    getProgress: number;
    getLearning: number;
    getWorkflow: number;
    getTraceability: number;
  };
} {
  const calls = {
    startRun: 0,
    startRunInputs: [] as Array<{
      programId: string;
      cobolSourcePath: string;
      requester?: string;
      executionMode?: "standard" | "parity";
      trustCaseId?: string;
      sourceReferenceFixtureId?: string;
      sourceReferenceMode?: "reference-fixture" | "native-cobol";
    }>,
    getRun: 0,
    startTransformRun: [] as Array<{
      programId: string;
      sourceText: string;
      requester?: string;
      sourceName?: string;
      options?: unknown;
      targetLanguage?: string;
      expectedOutput?: string;
      oracleInput?: string;
      useTransformationAgent?: boolean;
      executionMode?: "standard" | "parity";
      trustCaseId?: string;
      generateOnly?: boolean;
    }>,
    getGenerated: 0,
    getGeneratedFiles: 0,
    getGeneratedFile: [] as Array<{ runId: string; path: string }>,
    getArtifactFile: [] as Array<{ runId: string; path: string }>,
    getBuildTest: 0,
    manualCompileRepair: {
      preview: [] as Array<{ runId: string; payload: unknown }>,
      diagnose: [] as Array<{ runId: string; payload: unknown }>,
      apply: [] as Array<{ runId: string; payload: unknown }>,
      accept: [] as Array<{ runId: string; payload: unknown }>,
      reject: [] as Array<{ runId: string; payload: unknown }>,
    },
    exportParityRegression: [] as Array<{ runId: string; payload: unknown }>,
    getEvidence: 0,
    getEvents: 0,
    getArtifacts: 0,
    getProgress: 0,
    getLearning: 0,
    getWorkflow: 0,
    getTraceability: 0,
  };
  const client: OrchestratorClient = {
    enabled: true,
    async startRun(input) {
      calls.startRun += 1;
      calls.startRunInputs.push({ ...input });
      const response: UpstreamResponse = {
        status: 201,
        body: {
          run: {
            runId: "live-run-1",
            workflowId: "w0-migration-v0",
            status: "updating",
            policyDecision: "allow",
            message: "orchestrator accepted",
            evidenceRefs: ["urn:evidence/live-1"],
          },
          status: "started",
          message: "orchestrator run started",
        },
      };
      return response;
    },
    async getRun() {
      calls.getRun += 1;
      return {
        status: 200,
        body: {
          runId: "live-run-1",
          workflowId: "w0-migration-v0",
          status: "completed",
          policyDecision: "allow",
          message: "orchestrator finished",
          evidenceRefs: ["urn:evidence/live-1"],
        },
      };
    },
    async startTransformRun(input) {
      calls.startTransformRun.push({ ...input });
      return {
        status: 201,
        body: {
          run: {
            runId: "live-transform-1",
            workflowId: "w0-migration-v0",
            status: "updating",
            policyDecision: "allow",
            message: "orchestrator accepted transform",
            evidenceRefs: ["urn:evidence/live-transform-1"],
          },
          status: "started",
          message: "orchestrator transform started",
        },
      };
    },
    async getArtifacts() {
      calls.getArtifacts += 1;
      return artifactResponses.artifacts;
    },
    async getGenerated() {
      calls.getGenerated += 1;
      return artifactResponses.generated;
    },
    async getGeneratedFiles() {
      calls.getGeneratedFiles += 1;
      return artifactResponses.generatedFiles;
    },
    async getGeneratedFile(runId: string, filePath: string) {
      calls.getGeneratedFile.push({ runId, path: filePath });
      const responder = artifactResponses.generatedFile;
      if (typeof responder === "function") {
        return responder(filePath);
      }
      return responder;
    },
    async getArtifactFile(runId: string, filePath: string) {
      calls.getArtifactFile.push({ runId, path: filePath });
      const responder = artifactResponses.artifactFile;
      if (typeof responder === "function") {
        return responder(filePath);
      }
      return responder;
    },
    async getBuildTest() {
      calls.getBuildTest += 1;
      return artifactResponses.buildTest;
    },
    async previewManualCompileRepair(runId: string, payload: unknown) {
      calls.manualCompileRepair.preview.push({ runId, payload });
      return artifactResponses.manualCompileRepair?.preview;
    },
    async diagnoseManualCompileRepair(runId: string, payload: unknown) {
      calls.manualCompileRepair.diagnose.push({ runId, payload });
      return artifactResponses.manualCompileRepair?.diagnose;
    },
    async applyManualCompileRepair(runId: string, payload: unknown) {
      calls.manualCompileRepair.apply.push({ runId, payload });
      return artifactResponses.manualCompileRepair?.apply;
    },
    async acceptManualCompileRepair(runId: string, payload: unknown) {
      calls.manualCompileRepair.accept.push({ runId, payload });
      return artifactResponses.manualCompileRepair?.accept;
    },
    async rejectManualCompileRepair(runId: string, payload: unknown) {
      calls.manualCompileRepair.reject.push({ runId, payload });
      return artifactResponses.manualCompileRepair?.reject;
    },
    async getEvidence() {
      calls.getEvidence += 1;
      return artifactResponses.evidence;
    },
    async exportParityRegression(runId, payload) {
      calls.exportParityRegression.push({ runId, payload });
      return artifactResponses.exportParityRegression;
    },
    async getEvents() {
      calls.getEvents += 1;
      return artifactResponses.events;
    },
    async getProgress() {
      calls.getProgress += 1;
      return artifactResponses.progress;
    },
    async getLearning() {
      calls.getLearning += 1;
      return artifactResponses.learning;
    },
    async getWorkflow() {
      calls.getWorkflow += 1;
      return artifactResponses.workflow;
    },
    async getTraceability() {
      calls.getTraceability += 1;
      return artifactResponses.traceability;
    },
  };
  return { client, calls };
}

function disabledOrchestrator(): OrchestratorClient {
  return {
    enabled: false,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      return undefined;
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
}

function disabledEvidence(): EvidenceClient {
  return {
    enabled: false,
    async getPack() {
      return undefined;
    },
  };
}

function liveEvidence(): EvidenceClient {
  return {
    enabled: true,
    async getPack() {
      return { status: 200, body: { packId: "epk-live-1" } };
    },
  };
}

function availableModelGateway(): ModelGatewayClient {
  return {
    enabled: true,
    async explain() {
      return undefined;
    },
    async getHealth() {
      return {
        status: 200,
        body: {
          service: "model-gateway",
          schema: "v0",
          providers: ["test"],
          activeModels: 1,
          configured: {
            mode: "test",
            dataPolicy: "model-gateway",
            invocationLedgerEnabled: "true",
            harnessEventEmissionEnabled: "true",
          },
        },
      };
    },
    async getModels() {
      return {
        status: 200,
        body: [
          { id: "test-model", displayName: "Test Model", provider: "test" },
        ],
      };
    },
    async getCapabilities() {
      return {
        status: 200,
        body: {
          schema: "v0",
          service: "model-gateway-service",
          status: "ok",
          provider: "test",
          policyId: "test-policy",
          roles: [
            {
              role: "transformation",
              status: "ok",
              policyId: "test-policy",
              availableModels: ["test-model"],
              configuredModels: ["test-model"],
            },
          ],
        },
      };
    },
  };
}

function outputChangeOrchestrator(): OrchestratorClient {
  const outputRef = (
    sha: string,
    kind = "artifact",
  ): Record<string, unknown> => ({
    sha256: sha,
    byteSize: 12,
    kind,
    uri: `urn:test:${sha.slice(0, 8)}`,
  });
  const generatedBodies: Record<string, UpstreamResponse> = {
    "live-prev": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        runStatus: "completed",
        artifactRef: outputRef("1".repeat(64), "generated-project-manifest"),
        traceability: { sourceHash: "source-a" },
      },
    },
    "live-current": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        runStatus: "completed",
        artifactRef: outputRef("1".repeat(64), "generated-project-manifest"),
        traceability: { sourceHash: "source-a" },
      },
    },
  };
  const buildBodies: Record<string, UpstreamResponse> = {
    "live-prev": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        data: {
          status: "ok",
          classification: "match",
          actualOutput: "RESULT=OLD\n",
          comparisonResult: {
            matched: true,
            diffRef: outputRef("2".repeat(64), "parity-comparison-diff"),
          },
        },
      },
    },
    "live-current": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        data: {
          status: "ok",
          classification: "match",
          actualOutput: "RESULT=NEW\n",
          comparisonResult: {
            matched: false,
            diffRef: outputRef("3".repeat(64), "parity-comparison-diff"),
          },
        },
      },
    },
  };
  const evidenceBodies: Record<string, UpstreamResponse> = {
    "live-prev": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        artifactRef: outputRef("4".repeat(64), "evidence-pack-manifest"),
        data: {
          status: "complete",
          packId: "pack-prev",
        },
      },
    },
    "live-current": {
      status: 200,
      body: {
        programId: FIXED_SAMPLE.programId,
        artifactRef: outputRef("5".repeat(64), "evidence-pack-manifest"),
        data: {
          status: "complete",
          packId: "pack-current",
        },
      },
    },
  };
  return {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      return undefined;
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated(runId: string) {
      return generatedBodies[runId];
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest(runId: string) {
      return buildBodies[runId];
    },
    async getEvidence(runId: string) {
      return evidenceBodies[runId];
    },
    async exportParityRegression() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async upsertIntentionalDivergenceDecision() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
    async previewManualCompileRepair() {
      return undefined;
    },
    async diagnoseManualCompileRepair() {
      return undefined;
    },
    async applyManualCompileRepair() {
      return undefined;
    },
    async acceptManualCompileRepair() {
      return undefined;
    },
    async rejectManualCompileRepair() {
      return undefined;
    },
  };
}

const baseRepoRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "c2c-bff-test-root-"),
);

const baseConfig: BffConfig = {
  serviceName: "c2c-bff",
  port: 0,
  host: "127.0.0.1",
  repoRoot: baseRepoRoot,
  staticRoot: path.join(baseRepoRoot, "static-does-not-exist"),
  orchestratorUrl: "",
  orchestratorControlToken: "",
  evidenceUrl: "",
  experienceLearningUrl: "",
  experienceLearningControlToken: "",
  modelGatewayUrl: "",
  harnessUrl: "",
  buildTestRunnerUrl: "",
  buildTestRunnerControlToken: "",
  formatJavaTimeoutMs: 5_000,
  formatJavaSourceMaxBytes: 1_048_576,
  upstreamTimeoutMs: 1_000,
  transformSourceMaxBytes: 1_000_000,
  artifactContentMaxBytes: 1_048_576,
  enableDiagnosticFixtures: false,
  enableFixtureSessions: true,
  forceSecureSessionCookies: false,
  studioCorsOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
};

test("loadConfig rejects live orchestrator URL without a control token", () => {
  assert.throws(
    () =>
      loadConfig(
        {
          C2C_ORCHESTRATOR_URL: "http://orchestrator",
          C2C_REPO_ROOT: "/tmp/c2c-test-root",
        } as NodeJS.ProcessEnv,
        __dirname,
      ),
    /C2C_ORCHESTRATOR_CONTROL_TOKEN is required/,
  );
});

test("loadConfig surfaces the default and override editor-assist ledger path", () => {
  const defaults = loadConfig(
    { C2C_REPO_ROOT: "/tmp/c2c-test-root" } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.equal(
    defaults.editorAssistLedgerPath,
    path.resolve(
      "/tmp/c2c-test-root",
      "var",
      "c2c-local",
      "trajectory-ledger",
      "editor-assist.jsonl",
    ),
  );

  const overridden = loadConfig(
    {
      C2C_REPO_ROOT: "/tmp/c2c-test-root",
      C2C_EDITOR_ASSIST_LEDGER_PATH:
        "var/c2c-local/trajectory-ledger/custom-editor-assist.jsonl",
    } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.equal(
    overridden.editorAssistLedgerPath,
    path.resolve(
      "/tmp/c2c-test-root",
      "var",
      "c2c-local",
      "trajectory-ledger",
      "custom-editor-assist.jsonl",
    ),
  );

  assert.throws(
    () =>
      loadConfig(
        {
          C2C_REPO_ROOT: "/tmp/c2c-test-root",
          C2C_EDITOR_ASSIST_LEDGER_PATH: "/tmp/c2c-editor-assist.jsonl",
        } as NodeJS.ProcessEnv,
        __dirname,
      ),
    /C2C_EDITOR_ASSIST_LEDGER_PATH must resolve inside C2C_REPO_ROOT/,
  );
});

test("loadConfig surfaces exact Studio CORS origins", () => {
  const defaults = loadConfig(
    { C2C_REPO_ROOT: "/tmp/c2c-test-root" } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.equal(defaults.host, "127.0.0.1");
  assert.deepEqual(defaults.studioCorsOrigins, [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]);

  const customPort = loadConfig(
    {
      C2C_REPO_ROOT: "/tmp/c2c-test-root",
      C2C_LOCAL_STUDIO_PORT: "5173",
    } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.deepEqual(customPort.studioCorsOrigins, [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ]);

  const explicit = loadConfig(
    {
      C2C_REPO_ROOT: "/tmp/c2c-test-root",
      C2C_STUDIO_CORS_ORIGINS: "http://localhost:5173/, http://127.0.0.1:5174",
    } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.deepEqual(explicit.studioCorsOrigins, [
    "http://localhost:5173",
    "http://127.0.0.1:5174",
  ]);

  const explicitHost = loadConfig(
    {
      C2C_REPO_ROOT: "/tmp/c2c-test-root",
      C2C_BFF_HOST: "0.0.0.0",
      C2C_ALLOW_NON_LOOPBACK_BIND: "true",
    } as NodeJS.ProcessEnv,
    __dirname,
  );
  assert.equal(explicitHost.host, "0.0.0.0");

  assert.throws(
    () =>
      loadConfig(
        {
          C2C_REPO_ROOT: "/tmp/c2c-test-root",
          C2C_STUDIO_CORS_ORIGINS: "http://localhost:3000/path",
        } as NodeJS.ProcessEnv,
        __dirname,
      ),
    /C2C_STUDIO_CORS_ORIGINS origins must not include path/,
  );
});

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: http.RequestListener,
): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function fetchJson(
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}> {
  const target = new URL(url);
  const bodyBytes =
    init?.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(init.body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: init?.method ?? "GET",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          accept: "application/json",
          ...(init?.headers ?? {}),
          ...(bodyBytes
            ? {
                "content-type": "application/json",
                "content-length": String(bodyBytes.length),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown = raw;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsed,
            headers: res.headers,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyBytes) req.write(bodyBytes);
    req.end();
  });
}

function createRouteAuth(): {
  sessionStore: SessionStore;
  headers: Record<string, string>;
  post: (
    body: unknown,
    headers?: Record<string, string>,
  ) => { method: "POST"; body: unknown; headers: Record<string, string> };
} {
  const sessionStore = createSessionStore({ idleTimeoutMs: 0 });
  const record = sessionStore.create({
    tenantId: "tenant-a",
    userId: "user-a",
  });
  return {
    sessionStore,
    headers: {
      origin: "http://127.0.0.1:3000",
      cookie: `${SESSION_COOKIE_NAME}=${record.sessionId}`,
    },
    post: (body, headers = {}) => ({
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: `${SESSION_COOKIE_NAME}=${record.sessionId}`,
        ...headers,
      },
      body,
    }),
  };
}

test("placeholder marker list is non-empty and exposes the documented W0 stubs", () => {
  assert.ok(PLACEHOLDER_JAVA_MARKERS.length >= 2);
  assert.equal(findPlaceholderMarker("public class C {}"), null);
  assert.equal(findPlaceholderMarker("// W0-STUB BRNCH01"), "W0-STUB");
  assert.equal(
    findPlaceholderMarker("Synthetic W0 generated-Java stub here"),
    "Synthetic W0 generated-Java stub",
  );
});

test("health endpoint reports service name", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(`${server.baseUrl}/api/v0/health`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: "ok", service: "c2c-bff" });
  } finally {
    await server.close();
  }
});

test("mode endpoint flips with upstream enabled-ness", async () => {
  const { client: orch } = stubOrchestrator();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(`${server.baseUrl}/api/v0/mode`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { orchestrator: "live", evidence: "live" });
  } finally {
    await server.close();
  }
});

test("API endpoints allow local split-server CORS requests from Studio", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const preflight = await fetch(`${server.baseUrl}/api/v0/transform`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3000",
    );
    assert.match(
      preflight.headers.get("access-control-allow-methods") ?? "",
      /POST/,
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /Content-Type/,
    );

    const health = await fetch(`${server.baseUrl}/api/v0/health`, {
      headers: {
        Origin: "http://127.0.0.1:3000",
      },
    });
    assert.equal(health.status, 200);
    assert.equal(
      health.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3000",
    );

    const blocked = await fetch(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    assert.equal(blocked.headers.get("access-control-allow-credentials"), null);
  } finally {
    await server.close();
  }
});

test("samples list and detail return registry contents including reference-program contract", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE, FIXED_SAMPLE_2]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const list = await fetchJson(`${server.baseUrl}/api/v0/samples`);
    assert.equal(list.status, 200);
    const summaries = list.body as Array<{
      programId: string;
      supportedInProductMode: boolean;
      w0Subset: string[];
      oracleMode: string | null;
      knownLimitations: string[];
    }>;
    assert.deepEqual(summaries.map((entry) => entry.programId).sort(), [
      "BATCH01",
      "BRNCH01",
    ]);
    for (const summary of summaries) {
      assert.equal(summary.supportedInProductMode, true);
      assert.ok(
        summary.w0Subset.length > 0,
        `${summary.programId} must declare w0Subset`,
      );
      assert.ok(
        summary.oracleMode === "cobol-runtime" ||
          summary.oracleMode === "synthetic-fixture",
        `${summary.programId} must declare oracleMode`,
      );
      assert.ok(
        Array.isArray(summary.knownLimitations),
        `${summary.programId} knownLimitations array`,
      );
    }

    const detail = await fetchJson(`${server.baseUrl}/api/v0/samples/BRNCH01`);
    assert.equal(detail.status, 200);
    const body = detail.body as {
      programId: string;
      expectedOutput: string;
      supportedInProductMode: boolean;
      w0Subset: string[];
      oracleMode: string;
    };
    assert.equal(body.programId, "BRNCH01");
    assert.match(body.expectedOutput, /APPROVED-COUNT/);
    assert.equal(body.supportedInProductMode, true);
    assert.deepEqual(body.w0Subset, [
      "MOVE",
      "PERFORM",
      "EVALUATE",
      "ADD",
      "DISPLAY",
    ]);
    assert.equal(body.oracleMode, "cobol-runtime");

    const missing = await fetchJson(`${server.baseUrl}/api/v0/samples/UNKNOWN`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/acceptance-fixtures exposes W0.2 fixture oracle contract", async () => {
  const handler = createApp({
    config: { ...baseConfig, repoRoot: path.resolve(__dirname, "../../..") },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const list = await fetchJson(
      `${server.baseUrl}/api/v0/acceptance-fixtures`,
    );
    assert.equal(list.status, 200);
    const summaries = list.body as Array<{
      fixtureId: string;
      expectedFinalClassification: string;
      modes: string[];
    }>;
    assert.ok(summaries.some((entry) => entry.fixtureId === "HELLOW02"));
    assert.ok(
      summaries.some((entry) => entry.fixtureId === "FILEIO-UNSUPPORTED"),
    );
    assert.ok(summaries.every((entry) => entry.modes.includes("file-backed")));
    assert.ok(summaries.every((entry) => entry.modes.includes("paste-mode")));

    const hello = await fetchJson(
      `${server.baseUrl}/api/v0/acceptance-fixtures/HELLOW02`,
    );
    assert.equal(hello.status, 200);
    const helloBody = hello.body as {
      fixtureId: string;
      oracleGenerationMode: string | null;
      expectedOutput: string | null;
      expectedOutputArtifactRef: { sha256: string; kind: string } | null;
      supportedSubset: string[];
    };
    assert.equal(helloBody.fixtureId, "HELLOW02");
    assert.equal(helloBody.oracleGenerationMode, "cobol-runtime");
    assert.match(helloBody.expectedOutput ?? "", /HELLO-W02 DONE/);
    assert.equal(helloBody.expectedOutputArtifactRef?.kind, "golden-master");
    assert.ok(helloBody.supportedSubset.includes("PERFORM-VARYING"));

    const unsupported = await fetchJson(
      `${server.baseUrl}/api/v0/acceptance-fixtures/FILEIO-UNSUPPORTED`,
    );
    assert.equal(unsupported.status, 200);
    const unsupportedBody = unsupported.body as {
      expectedOutput: string | null;
      expectedOutputArtifactRef: unknown;
      expectedFinalClassification: string;
      expectedFailureCode: string;
      unsupportedConstructs: Array<{ code: string; construct: string }>;
    };
    assert.equal(unsupportedBody.expectedOutput, null);
    assert.equal(unsupportedBody.expectedOutputArtifactRef, null);
    assert.equal(unsupportedBody.expectedFinalClassification, "blocked");
    assert.equal(unsupportedBody.expectedFailureCode, "unsupported_cobol");
    assert.ok(
      unsupportedBody.unsupportedConstructs.some(
        (entry) => entry.construct === "FILE SECTION",
      ),
    );

    const missing = await fetchJson(
      `${server.baseUrl}/api/v0/acceptance-fixtures/UNKNOWN`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("transform refuses to dispatch a programId that maps to an unsupported reference", async () => {
  const unsupported: SampleDetail = {
    ...FIXED_SAMPLE,
    programId: "UNSUP01",
    supportedInProductMode: false,
    w0Subset: [],
    oracleMode: null,
    knownLimitations: ["no W0 coverage"],
  };
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([unsupported]),
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText:
          "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. UNSUP01.\n",
      },
    });
    assert.equal(response.status, 400);
    const body = response.body as { error: string };
    assert.match(body.error, /UNSUP01/);
    assert.match(body.error, /supportedInProductMode/i);
    assert.equal(
      calls.startTransformRun.length,
      0,
      "orchestrator must not be called for unsupported reference",
    );
  } finally {
    await server.close();
  }
});

test("every shipped reference program is loadable and routes its source through /api/v0/transform", async () => {
  // Service-level integration: prove the GET /samples/:id → POST /transform path
  // works for every shipped reference program (Issue #94 acceptance criterion).
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const { loadSampleRegistry } = await import("./samples");
  const realRegistry = loadSampleRegistry(repoRoot);
  const summaries = realRegistry.list().filter((s) => s.supportedInProductMode);
  assert.ok(
    summaries.length >= 4,
    `expected at least 4 runnable reference programs, got ${summaries.length}`,
  );

  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: realRegistry,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    for (const summary of summaries) {
      const detailResp = await fetchJson(
        `${server.baseUrl}/api/v0/samples/${encodeURIComponent(summary.programId)}`,
      );
      assert.equal(
        detailResp.status,
        200,
        `GET /samples/${summary.programId} must return 200`,
      );
      const detail = detailResp.body as {
        cobolSource: string;
        programId: string;
      };
      assert.ok(
        detail.cobolSource.length > 0,
        `cobolSource must be present for ${summary.programId}`,
      );

      const before = calls.startTransformRun.length;
      const transformResp = await fetchJson(
        `${server.baseUrl}/api/v0/transform`,
        {
          method: "POST",
          headers: auth.headers,
          body: {
            sourceText: detail.cobolSource,
            programId: detail.programId,
            useTransformationAgent: false,
          },
        },
      );
      assert.equal(
        transformResp.status,
        201,
        `POST /transform must accept ${summary.programId}`,
      );
      assert.equal(
        calls.startTransformRun.length,
        before + 1,
        `orchestrator.startTransformRun must be called exactly once for ${summary.programId}`,
      );
      const lastCall =
        calls.startTransformRun[calls.startTransformRun.length - 1];
      assert.ok(lastCall, "expected a recorded call");
      assert.equal(lastCall.programId, detail.programId);
      assert.equal(
        lastCall.sourceText,
        detail.cobolSource,
        `orchestrator must receive the same source text the UI loaded for ${summary.programId}`,
      );
    }
  } finally {
    await server.close();
  }
});

test("product mode rejects POST /api/v0/runs with 503 when orchestrator is missing and diagnostic fixtures are not enabled", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const blocked = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(blocked.status, 503);
    assert.match(
      (blocked.body as { error: string }).error,
      /product mode not ready/i,
    );
    assert.match(
      (blocked.body as { error: string }).error,
      /C2C_ORCHESTRATOR_URL/,
    );
    assert.match(
      (blocked.body as { error: string }).error,
      /C2C_ENABLE_DIAGNOSTIC_FIXTURES/,
    );
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("diagnostic fixture mode is opt-in, produces diagnostic-fixture run mode, and productMode is unavailable", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const runBody = started.body as {
      runId: string;
      mode: string;
      productMode: string;
      status: string;
      evidenceRefs: string[];
    };
    assert.equal(runBody.mode, "diagnostic-fixture");
    assert.equal(runBody.productMode, "unavailable");
    assert.equal(runBody.status, "completed");
    assert.deepEqual(runBody.evidenceRefs, []);

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const genBody = generated.body as {
      mode: string;
      productMode: string;
      status: string;
      files: Record<string, string>;
      fileRefs: Array<{ path: string }>;
      unsupportedFeatures: string[];
    };
    assert.equal(genBody.mode, "diagnostic-fixture");
    assert.equal(genBody.productMode, "unavailable");
    assert.equal(genBody.status, "generated");
    assert.deepEqual(genBody.files, {});
    assert.ok(genBody.fileRefs.some((entry) => entry.path.endsWith(".java")));
    assert.equal(genBody.unsupportedFeatures.length, 0);

    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as {
      mode: string;
      productMode: string;
      status: string;
      classification: string;
      expectedOutput: string;
    };
    assert.equal(btBody.mode, "diagnostic-fixture");
    assert.equal(btBody.productMode, "unavailable");
    assert.equal(btBody.status, "ok");
    assert.equal(btBody.classification, "match");
    assert.match(btBody.expectedOutput, /APPROVED-COUNT/);

    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runBody.runId}/evidence`,
      { headers: auth.headers },
    );
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as {
      mode: string;
      productMode: string;
      packId: string;
      manifestUri?: string;
    };
    assert.equal(evBody.mode, "diagnostic-fixture");
    assert.equal(evBody.productMode, "unavailable");
    assert.ok(evBody.packId.startsWith("epk-"));
    assert.equal(evBody.manifestUri, undefined);
  } finally {
    await server.close();
  }
});

test("starting a run surfaces orchestrator failures instead of silently falling back to mock", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const failingOrchestrator: OrchestratorClient = {
    enabled: true,
    async startRun() {
      throw new Error("upstream offline");
    },
    async startTransformRun() {
      return undefined;
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: failingOrchestrator,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(failed.status, 502);
    assert.match((failed.body as { error: string }).error, /upstream offline/);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("starting a run with orchestrator non-2xx response returns 502 and creates no run", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const rejectingOrchestrator: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return { status: 500, body: { error: "orchestrator internal error" } };
    },
    async startTransformRun() {
      return undefined;
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: rejectingOrchestrator,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(failed.status, 502);
    assert.match((failed.body as { error: string }).error, /500/);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("starting a run in live mode proxies the orchestrator, syncs status, and reports incomplete artifacts when orchestrator has no data yet", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as {
      runId: string;
      mode: string;
      status: string;
      productMode: string;
      orchestratorRunId: string;
    };
    assert.equal(startedBody.mode, "live");
    // RunSummary.productMode is 'live' whenever stored mode is 'live'; per-artifact
    // productMode is downgraded to 'unavailable' when upstream payload is incomplete.
    assert.equal(startedBody.productMode, "live");
    assert.equal(startedBody.orchestratorRunId, "live-run-1");
    assert.equal(calls.startRun, 1);

    const fetched = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    assert.equal(fetched.status, 200);
    const fetchedBody = fetched.body as { mode: string; status: string };
    assert.equal(fetchedBody.mode, "live");
    assert.equal(fetchedBody.status, "completed");
    assert.equal(calls.getRun, 1);

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const genBody = generated.body as {
      mode: string;
      status: string;
      missingArtifacts: string[];
    };
    assert.equal(genBody.mode, "live");
    assert.equal(genBody.status, "incomplete");
    assert.deepEqual(genBody.missingArtifacts, ["generation-response"]);
    assert.equal(calls.getGenerated, 1);

    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as {
      mode: string;
      status: string;
      classification: string;
      missingArtifacts: string[];
    };
    assert.equal(btBody.mode, "live");
    assert.equal(btBody.status, "incomplete");
    assert.equal(btBody.classification, "skipped-no-execution");
    assert.deepEqual(btBody.missingArtifacts, ["build-test-result"]);
    assert.equal(calls.getBuildTest, 1);

    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as {
      mode: string;
      status: string;
      packId: string;
      missingArtifacts: string[];
    };
    assert.equal(evBody.mode, "live");
    assert.equal(evBody.status, "incomplete");
    assert.equal(evBody.packId, "");
    assert.deepEqual(evBody.missingArtifacts, ["evidence-pack-manifest"]);
    assert.equal(calls.getEvidence, 1);
  } finally {
    await server.close();
  }
});

test("starting a parity run forwards curated reference configuration to the orchestrator and preserves mode metadata", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {
        programId: "BRNCH01",
        requester: "studio",
        executionMode: "parity",
        trustCaseId: "TRUST-BRANCH-APPROVAL",
        sourceReferenceFixtureId: "branch-account-guard-v0",
        sourceReferenceMode: "reference-fixture",
      },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as {
      runId: string;
      executionMode: string;
      trustCaseId: string;
      sourceReferenceFixtureId: string;
      sourceReferenceMode: string;
    };
    assert.equal(startedBody.executionMode, "parity");
    assert.equal(startedBody.trustCaseId, "TRUST-BRANCH-APPROVAL");
    assert.equal(
      startedBody.sourceReferenceFixtureId,
      "branch-account-guard-v0",
    );
    assert.equal(startedBody.sourceReferenceMode, "reference-fixture");
    assert.deepEqual(calls.startRunInputs[0], {
      programId: "BRNCH01",
      cobolSourcePath: "corpus/synthetic/programs/branch-account-guard.cbl",
      requester: "studio",
      executionMode: "parity",
      trustCaseId: "TRUST-BRANCH-APPROVAL",
      sourceReferenceFixtureId: "branch-account-guard-v0",
      sourceReferenceMode: "reference-fixture",
    });

    const fetched = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    assert.equal(fetched.status, 200);
    const fetchedBody = fetched.body as { executionMode: string };
    assert.equal(fetchedBody.executionMode, "parity");
  } finally {
    await server.close();
  }
});

test("starting a parity run rejects unsupported mode and missing fixture before dispatch", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const unsupported = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01", executionMode: "repair" },
    });
    assert.equal(unsupported.status, 400);
    assert.match(
      (unsupported.body as { error: string }).error,
      /executionMode must be standard or parity/,
    );

    const missingFixture = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01", executionMode: "parity" },
    });
    assert.equal(missingFixture.status, 400);
    assert.match(
      (missingFixture.body as { error: string }).error,
      /sourceReferenceFixtureId is required/,
    );
    assert.equal(calls.startRun, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs rejects a pattern-invalid trustCaseId before dispatch", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    // Lower-case characters fall outside the trust-case id allow-list.
    // The BFF must reject this with 400 rather than forwarding it.
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {
        programId: "BRNCH01",
        executionMode: "parity",
        trustCaseId: "trust-branch-approval",
        sourceReferenceFixtureId: "branch-account-guard-v0",
        sourceReferenceMode: "reference-fixture",
      },
    });
    assert.equal(rejected.status, 400);
    assert.match(
      (rejected.body as { error: string }).error,
      /trustCaseId must match the trust-case identifier pattern/,
    );
    assert.equal(calls.startRun, 0);
  } finally {
    await server.close();
  }
});

test("starting a parity run requires a configured orchestrator instead of diagnostic fixture fallback", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {
        programId: "BRNCH01",
        executionMode: "parity",
        sourceReferenceFixtureId: "branch-account-guard-v0",
      },
    });
    assert.equal(response.status, 503);
    assert.match((response.body as { error: string }).error, /Orchestrator/i);
  } finally {
    await server.close();
  }
});

test("live generated/build-test/evidence endpoints return real artifact contents when orchestrator has persisted them", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const generatedJava =
    "package c2c;\npublic final class CASE01 {\n    public static void main(String[] a) {}\n}\n";
  const buildResult = {
    status: "ok",
    classification: "match",
    actualOutput: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
    outputRef: {
      uri: "file:///run/build-test/output.txt",
      sha256: "b".repeat(64),
      byteSize: 32,
    },
    programId: "CASE01",
  };
  const evidenceManifest = {
    runId: "live-run-1",
    workflowId: "w0-migration-v0",
    status: "complete",
    packId: "epk-live-1",
    artifacts: {
      sourceCobol: [],
      generatedJava: { uri: "file:///run/generated.java" },
    },
  };
  const trajectoryEvents = [
    {
      type: "parse-cobol.executed",
      status: "ok",
      message: "parse complete",
      createdAt: "2026-05-14T10:00:00Z",
      payload: { input: { sourceText: "IDENTIFICATION DIVISION." } },
      inputRef: { uri: "file:///run/source.cbl", sha256: "e".repeat(64) },
    },
    {
      type: "generate-java.executed",
      status: "ok",
      message: "java generated at http://internal.service/run",
      createdAt: "2026-05-14T10:00:05Z",
      outputRef: { uri: "file:///run/generated.java", sha256: "f".repeat(64) },
    },
  ];
  const { client: orch, calls } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": generatedJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: {
          uri: "file:///run/generation-response.json",
          sha256: "a".repeat(64),
          byteSize: 128,
        },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: buildResult,
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "c".repeat(64),
          byteSize: 256,
        },
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: evidenceManifest,
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "d".repeat(64),
          byteSize: 512,
        },
      },
    },
    events: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        events: trajectoryEvents,
      },
    },
    artifacts: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        artifacts: [
          {
            uri: "file:///run/source.cbl",
            sha256: "a".repeat(64),
            byteSize: 64,
            kind: "source",
            path: "source.cbl",
            name: "source.cbl",
          },
        ],
        createdAt: "2026-05-14T10:00:00Z",
        updatedAt: "2026-05-14T10:00:30Z",
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const genBody = generated.body as {
      mode: string;
      status: string;
      files: Record<string, string>;
      entryClass: string;
    };
    assert.equal(genBody.mode, "live");
    assert.equal(genBody.status, "generated");
    assert.equal(genBody.entryClass, "CASE01");
    assert.deepEqual(genBody.files, {});
    assert.equal(calls.getGenerated, 1);

    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as {
      mode: string;
      status: string;
      classification: string;
      actualOutput: string;
    };
    assert.equal(btBody.mode, "live");
    assert.equal(btBody.status, "ok");
    assert.equal(btBody.classification, "match");
    assert.match(btBody.actualOutput, /APPROVED-COUNT=2/);

    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as {
      mode: string;
      status: string;
      packId: string;
      manifestHash: string;
      missingArtifacts: string[];
      manifestUri?: string;
    };
    assert.equal(evBody.mode, "live");
    assert.equal(evBody.status, "complete");
    assert.equal(evBody.packId, "epk-live-1");
    assert.equal(evBody.manifestUri, undefined);
    assert.equal(evBody.manifestHash, "d".repeat(64));
    assert.deepEqual(evBody.missingArtifacts, []);

    const events = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/events`,
      { headers: auth.headers },
    );
    assert.equal(events.status, 200);
    const evtBody = events.body as {
      mode: string;
      events: Array<{ type: string }>;
      missingArtifacts: string[];
    };
    assert.equal(evtBody.mode, "live");
    assert.equal(evtBody.events.length, 2);
    assert.equal(evtBody.events[0]?.type, "parse-cobol.executed");
    const serializedEvents = JSON.stringify(evtBody.events);
    assert.ok(!serializedEvents.includes("sourceText"));
    assert.ok(!serializedEvents.includes("inputRef"));
    assert.ok(!serializedEvents.includes("outputRef"));
    assert.ok(!serializedEvents.includes("file:///"));
    assert.ok(serializedEvents.includes("[redacted]"));
    assert.deepEqual(evtBody.missingArtifacts, []);

    const artifacts = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts`,
      { headers: auth.headers },
    );
    assert.equal(artifacts.status, 200);
    const artBody = artifacts.body as {
      mode: string;
      artifacts: Array<{ path: string }>;
      programId: string;
    };
    assert.equal(artBody.mode, "live");
    assert.equal(artBody.programId, "BRNCH01");
    assert.equal(artBody.artifacts.length, 1);
    assert.equal(artBody.artifacts[0]?.path, "source.cbl");
  } finally {
    await server.close();
  }
});

test("live generated endpoint exposes outputRef, diagnostics, and rejects placeholder markers from upstream payload", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const generatedJava =
    'package c2c;\npublic final class CASE01 {\n    public static void main(String[] a) { System.out.println("APPROVED-COUNT=2"); }\n}\n';
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": generatedJava },
        unsupportedFeatures: [],
        openAssumptions: ["IO limited to stdout"],
        generationResponse: {
          diagnostics: [
            {
              level: "info",
              code: "gen.start",
              line: 8,
              originStep: "parse-cobol",
              message: "generation started",
              artifactRef: {
                sha256: "f".repeat(64),
                byteSize: 64,
                kind: "semantic-ir-node",
                path: "ir/node/01.json",
              },
            },
            {
              level: "info",
              code: "gen.complete",
              message: "generation complete",
            },
          ],
        },
        generationResponseRef: {
          uri: "file:///run/generation-response.json",
          sha256: "a".repeat(64),
          byteSize: 128,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const body = generated.body as {
      status: string;
      outputRef: { sha256: string; byteSize?: number } | null;
      diagnostics: Array<{
        schemaVersion?: string;
        severity?: string;
        code?: string;
        line?: number;
        originStep?: string;
      }>;
      files: Record<string, string>;
    };
    assert.equal(body.status, "generated");
    assert.ok(body.outputRef, "outputRef must be present for successful runs");
    assert.equal(body.outputRef?.sha256, "a".repeat(64));
    assert.equal(body.diagnostics.length, 2);
    assert.equal(body.diagnostics[0]?.schemaVersion, "v0");
    assert.equal(body.diagnostics[0]?.severity, "info");
    assert.equal(body.diagnostics[0]?.code, "gen.start");
    assert.equal(body.diagnostics[0]?.line, 8);
    assert.equal(body.diagnostics[0]?.originStep, "parse-cobol");
    // Studio-IDE-5 (#244): artifactRef survives normalization with its
    // sha256 and metadata intact so the Studio Problems panel can
    // jump to the originating artifact.
    assert.equal(
      (body.diagnostics[0] as { artifactRef?: { sha256: string } })?.artifactRef
        ?.sha256,
      "f".repeat(64),
    );
    assert.deepEqual(body.files, {});
  } finally {
    await server.close();
  }
});

test("live generated endpoint never inlines upstream Java content", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const oversizedJava = "A".repeat(1_200_000);
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": oversizedJava },
        fileRefs: [
          {
            path: "src/main/java/c2c/CASE01.java",
            absolutePath: "/var/lib/orchestrator/generated/CASE01.java",
            uri: "https://storage.internal/generated/CASE01.java?token=secret",
            sha256: "b".repeat(64),
            byteSize: oversizedJava.length,
          },
        ],
        unsupportedFeatures: [],
        openAssumptions: [],
        artifactRef: {
          uri: "https://storage.internal/generated-project-manifest.json?token=secret",
          sha256: "c".repeat(64),
          byteSize: 512,
          kind: "generated-project-manifest",
        },
      },
    },
  });
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      artifactContentMaxBytes: 1024,
    },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const body = generated.body as {
      files: Record<string, string>;
      fileRefs: Array<{ path: string; absolutePath?: string; uri?: string }>;
      artifactRef: { sha256: string; kind?: string } | null;
    };
    assert.deepEqual(body.files, {});
    assert.equal(body.fileRefs[0]?.path, "src/main/java/c2c/CASE01.java");
    assert.equal(body.fileRefs[0]?.absolutePath, undefined);
    assert.equal(body.fileRefs[0]?.uri, undefined);
    assert.equal(body.artifactRef?.sha256, "c".repeat(64));
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "traceability"),
      false,
    );
    const serialized = JSON.stringify(generated.body);
    assert.ok(!serialized.includes(oversizedJava.slice(0, 128)));
    assert.doesNotMatch(
      serialized,
      /storage\.internal|\/var\/lib|token=secret/,
    );
  } finally {
    await server.close();
  }
});

test("live generated endpoint downgrades successful runs containing placeholder Java to incomplete", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  // Simulate a misbehaving upstream that returns a "complete" envelope but
  // the generated Java still contains the W0-STUB placeholder marker. The
  // BFF must refuse to surface this as `status: 'generated'`.
  const placeholderJava = [
    "// Synthetic W0 generated-Java stub for programId=CASE01.",
    "package c2c.w0.generated;",
    "public final class CASE01 {",
    "    public static void main(String[] args) {",
    '        System.out.println("W0-STUB CASE01");',
    "    }",
    "}",
  ].join("\n");
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": placeholderJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: {
          uri: "file:///run/generation-response.json",
          sha256: "a".repeat(64),
          byteSize: 128,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    assert.equal(generated.status, 200);
    const body = generated.body as {
      status: string;
      missingArtifacts: string[];
      placeholderViolation: { path: string; marker: string };
      note: string;
    };
    assert.equal(body.status, "incomplete");
    assert.ok(body.missingArtifacts.includes("real-generated-java"));
    assert.equal(body.placeholderViolation.marker, "W0-STUB");
    assert.equal(
      body.placeholderViolation.path,
      "src/main/java/c2c/CASE01.java",
    );
    assert.match(body.note, /Placeholder marker/);
  } finally {
    await server.close();
  }
});

test("live build-test extracts execution.stdout, goldenMaster.expected, outputRef, diagnostics, and compile/execution status", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const buildResult = {
    status: "ok",
    classification: "match",
    build: { compileOk: true, sourceCount: 1, diagnostics: [] },
    execution: {
      ran: true,
      ok: true,
      exitCode: 0,
      stdout: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
      stderr: "",
      durationMs: 12,
    },
    goldenMaster: {
      expected: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
      expectedOutputPath: "corpus/expected.txt",
    },
    comparison: {
      matched: true,
      status: "passed",
      comparisonPolicyVersion: "deterministic-output-v1",
      diffSummary: "Outputs matched after deterministic normalization.",
      expectedRef: {
        uri: "urn:build-test/expected",
        sha256: "e".repeat(64),
        byteSize: 36,
        kind: "cobol-oracle-stdout",
      },
      actualRef: {
        uri: "urn:build-test/actual",
        sha256: "a".repeat(64),
        byteSize: 36,
        kind: "java-stdout",
      },
    },
    diagnostics: [
      {
        severity: "warning",
        code: "javac-deprecation",
        line: 12,
        column: 7,
        source: "src/main/java/c2c/CASE01.java",
        sourceKind: "generated_java",
        message: "uses a deprecated API",
      },
      { level: "info", code: "execution.ok", message: "execution succeeded" },
    ],
    outputRef: {
      uri: "file:///run/build-test-result.json",
      sha256: "c".repeat(64),
      byteSize: 256,
    },
    programId: "CASE01",
  };
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: buildResult,
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "c".repeat(64),
          byteSize: 256,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const body = buildTest.body as {
      status: string;
      classification: string;
      compileStatus: string;
      executionStatus: string;
      expectedOutput: string;
      actualOutput: string;
      outputRef: { sha256: string } | null;
      expectedOutputRef: { sha256: string; kind: string } | null;
      actualOutputRef: { sha256: string; kind: string } | null;
      comparison: {
        matched: boolean;
        status: string;
        comparisonPolicyVersion: string;
        diffSummary: string;
        expectedRef: { sha256: string; kind: string };
        actualRef: { sha256: string; kind: string };
      } | null;
      diffSummary: string;
      diagnostics: Array<{
        schemaVersion?: string;
        severity?: string;
        code?: string;
        line?: number;
        column?: number;
        filePath?: string;
        sourceKind?: string;
      }>;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.classification, "match");
    assert.equal(body.compileStatus, "ok");
    assert.equal(body.executionStatus, "ok");
    assert.match(body.actualOutput, /APPROVED-COUNT=2/);
    assert.match(body.expectedOutput, /APPROVED-COUNT=2/);
    assert.equal(body.outputRef?.sha256, "c".repeat(64));
    assert.equal(body.expectedOutputRef?.sha256, "e".repeat(64));
    assert.equal(body.expectedOutputRef?.kind, "cobol-oracle-stdout");
    assert.equal(body.actualOutputRef?.sha256, "a".repeat(64));
    assert.equal(body.actualOutputRef?.kind, "java-stdout");
    assert.equal(body.comparison?.matched, true);
    assert.equal(body.comparison?.status, "passed");
    assert.equal(
      body.comparison?.comparisonPolicyVersion,
      "deterministic-output-v1",
    );
    assert.equal(
      body.diffSummary,
      "Outputs matched after deterministic normalization.",
    );
    assert.equal(body.comparison?.expectedRef.sha256, "e".repeat(64));
    assert.equal(body.comparison?.actualRef.sha256, "a".repeat(64));
    assert.equal(body.diagnostics.length, 2);
    assert.equal(body.diagnostics[0]?.schemaVersion, "v0");
    assert.equal(body.diagnostics[0]?.severity, "warning");
    assert.equal(body.diagnostics[0]?.code, "javac-deprecation");
    assert.equal(body.diagnostics[0]?.line, 12);
    assert.equal(body.diagnostics[0]?.column, 7);
    assert.equal(
      body.diagnostics[0]?.filePath,
      "src/main/java/c2c/CASE01.java",
    );
    assert.equal(body.diagnostics[0]?.sourceKind, "generated_java");
  } finally {
    await server.close();
  }
});

test("live build-test accepts Trust-2 shared build and execution fields", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const buildResult = {
    status: "ok",
    classification: "match",
    build: { status: "ok", sourceCount: 1, diagnostics: [] },
    execution: {
      exitCode: 0,
      actualOutput: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
      expectedOutput: "APPROVED-COUNT=2\nREJECTED-COUNT=2\n",
      stderr: "",
      durationMs: 12,
    },
    goldenMaster: null,
    comparison: {
      matched: true,
      expectedRef: {
        uri: "urn:build-test/expected",
        sha256: "e".repeat(64),
        byteSize: 36,
        kind: "cobol-oracle-stdout",
      },
      actualRef: {
        uri: "urn:build-test/actual",
        sha256: "a".repeat(64),
        byteSize: 36,
        kind: "java-stdout",
      },
    },
    diagnostics: [],
    outputRef: {
      uri: "file:///run/build-test-result.json",
      sha256: "c".repeat(64),
      byteSize: 256,
    },
    programId: "CASE01",
  };
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: buildResult,
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "c".repeat(64),
          byteSize: 256,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const body = buildTest.body as {
      compileStatus: string;
      executionStatus: string;
      expectedOutput: string;
      actualOutput: string;
    };
    assert.equal(body.compileStatus, "ok");
    assert.equal(body.executionStatus, "ok");
    assert.match(body.actualOutput, /APPROVED-COUNT=2/);
    assert.match(body.expectedOutput, /APPROVED-COUNT=2/);
  } finally {
    await server.close();
  }
});

test("live build-test surfaces compile failure as compileStatus=failed and executionStatus=not-run", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const buildResult = {
    status: "compile-failed",
    classification: "compile-error",
    build: {
      compileOk: false,
      sourceCount: 1,
      diagnostics: [
        { level: "error", code: "javac", message: "cannot resolve symbol" },
      ],
    },
    execution: { ran: false, ok: false, stdout: "", stderr: "" },
    goldenMaster: {},
    comparison: {},
    diagnostics: [
      { level: "error", code: "javac", message: "cannot resolve symbol" },
    ],
    outputRef: {
      uri: "file:///run/build-test-result.json",
      sha256: "d".repeat(64),
    },
  };
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: buildResult,
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "d".repeat(64),
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    const body = buildTest.body as {
      status: string;
      compileStatus: string;
      executionStatus: string;
      actualOutput: string;
    };
    assert.equal(body.status, "compile-failed");
    assert.equal(body.compileStatus, "failed");
    assert.equal(body.executionStatus, "not-run");
    assert.equal(body.actualOutput, "");
  } finally {
    await server.close();
  }
});

test("live evidence exposes manifestHash, validationStatus, exportRef, and aggregates missing artifacts", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const manifest = {
    schemaVersion: "v0",
    capability: "evidence.pack",
    service: "evidence-service",
    packId: "epk-live-1",
    runId: "live-run-1",
    wave: "w0",
    status: "incomplete",
    createdAt: "2026-05-14T10:00:30Z",
    artifacts: {},
    validation: {
      status: "incomplete",
      requiredArtifacts: ["sourceCobol", "semanticIr", "generatedJava"],
      missingArtifacts: ["semanticIr"],
      messages: [],
    },
    exports: [
      {
        format: "tar.gz",
        uri: "file:///run/evidence-pack.tar.gz",
        sha256: "e".repeat(64),
        byteSize: 1024,
        createdAt: "2026-05-14T10:00:30Z",
      },
    ],
  };
  const { client: orch } = stubOrchestrator({
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: manifest,
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "f".repeat(64),
          byteSize: 768,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    const body = evidence.body as {
      status: string;
      packId: string;
      manifestUri?: string;
      manifestHash: string;
      validationStatus: string;
      missingArtifacts: string[];
      exportRef: { sha256: string } | null;
    };
    assert.equal(body.status, "incomplete");
    assert.equal(body.packId, "epk-live-1");
    assert.equal(body.manifestUri, undefined);
    assert.equal(body.manifestHash, "f".repeat(64));
    assert.equal(body.validationStatus, "incomplete");
    assert.deepEqual(body.missingArtifacts, ["semanticIr"]);
    assert.equal(body.exportRef?.sha256, "e".repeat(64));
  } finally {
    await server.close();
  }
});

test("live evidence prefers the newest exportRef when multiple exports exist", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const manifest = {
    schemaVersion: "v0",
    capability: "evidence.pack",
    service: "evidence-service",
    packId: "epk-live-2",
    runId: "live-run-2",
    wave: "w0",
    status: "complete",
    createdAt: "2026-05-14T10:00:30Z",
    artifacts: {},
    validation: {
      status: "valid",
      requiredArtifacts: [],
      missingArtifacts: [],
      messages: [],
    },
    exports: [
      {
        format: "java-junit5",
        uri: "file:///run/older-export.java",
        sha256: "1".repeat(64),
        byteSize: 1024,
        createdAt: "2026-05-14T10:00:30Z",
      },
      {
        format: "java-junit5",
        uri: "file:///run/newer-export.java",
        sha256: "2".repeat(64),
        byteSize: 2048,
        createdAt: "2026-05-14T11:00:30Z",
      },
    ],
  };
  const { client: orch } = stubOrchestrator({
    evidence: {
      status: 200,
      body: {
        runId: "live-run-2",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: manifest,
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "f".repeat(64),
          byteSize: 768,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    const body = evidence.body as {
      exportRef: { sha256: string } | null;
    };
    assert.equal(body.exportRef?.sha256, "2".repeat(64));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/evidence/export proxies the orchestrator export response", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch, calls } = stubOrchestrator({
    exportParityRegression: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        status: "created",
        export: {
          exportId: "hello-regression",
          qualification: "clean",
          scaffoldRef: {
            sha256: "a".repeat(64),
            path: "exports/java-regression/case01/hello/src/test/java/CASE01ParityRegressionTest.java",
          },
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const exported = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence/export`,
      {
        method: "POST",
        headers: auth.headers,
        body: { exportName: "hello-regression" },
      },
    );
    const body = exported.body as {
      status: string;
      export: { scaffoldRef: { path: string } };
    };
    assert.equal(body.status, "created");
    assert.equal(
      body.export.scaffoldRef.path,
      "exports/java-regression/case01/hello/src/test/java/CASE01ParityRegressionTest.java",
    );
    // The BFF-local runId and the Orchestrator-assigned liveRunId must differ
    // so this assertion is meaningful — a regression to BFF-local id would be caught.
    assert.notEqual(startedBody.runId, "live-run-1");
    assert.deepEqual(calls.exportParityRegression, [
      {
        runId: "live-run-1",
        payload: {
          requester: "studio:tenant-a:user-a",
          exportName: "hello-regression",
        },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/evidence/export rejects unauthenticated requests", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch, calls } = stubOrchestrator({
    exportParityRegression: {
      status: 200,
      body: { runId: "live-run-1", status: "created", export: {} },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const exported = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence/export`,
      {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3000" },
        body: { exportName: "hello-regression" },
      },
    );
    assert.equal(exported.status, 401);
    assert.deepEqual(calls.exportParityRegression, []);
  } finally {
    await server.close();
  }
});

// ADR 0007 (#257, Issue #279): the BFF /evidence view surfaces the
// orchestrator's manual-edit provenance run-summary fields plus the
// persisted manualEditOverlay reference so the Studio can fetch the
// per-region overlay JSON for audit review.
test("live evidence surfaces manualEditOverlay reference and run-summary fields", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const overlay = {
    uri: "urn:c2c/manual-edit-overlay/live-run-1",
    sha256: "a".repeat(64),
    byteSize: 256,
    mimeType: "application/json",
    kind: "manual-edit-overlay",
    schemaVersion: "v0",
    regionCount: 2,
  };
  const manifest = {
    schemaVersion: "v0",
    capability: "evidence.pack",
    service: "evidence-service",
    packId: "epk-live-overlay-1",
    runId: "live-run-1",
    wave: "w0.2",
    status: "complete",
    completenessStatus: "complete",
    classification: "success",
    createdAt: "2026-05-19T10:00:30Z",
    manualEditsCarriedOver: true,
    manualDriftRegionCount: 2,
    artifacts: {
      manualEditOverlay: overlay,
    },
    validation: {
      ok: true,
      requiredArtifacts: [],
      missingArtifacts: [],
      messages: [],
      completenessStatus: "complete",
    },
  };
  const { client: orch } = stubOrchestrator({
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: manifest,
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "f".repeat(64),
          byteSize: 768,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    assert.equal(evidence.status, 200);
    const body = evidence.body as {
      packId: string;
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
      manualEditOverlay: {
        uri: string;
        sha256: string;
        byteSize: number;
        mimeType?: string;
        kind?: string;
        schemaVersion?: "v0";
        regionCount: number;
      } | null;
    };
    assert.equal(body.packId, "epk-live-overlay-1");
    assert.equal(body.manualEditsCarriedOver, true);
    assert.equal(body.manualDriftRegionCount, 2);
    assert.ok(body.manualEditOverlay, "manualEditOverlay must be surfaced");
    assert.equal(body.manualEditOverlay!.uri, overlay.uri);
    assert.equal(body.manualEditOverlay!.sha256, overlay.sha256);
    assert.equal(body.manualEditOverlay!.byteSize, overlay.byteSize);
    assert.equal(body.manualEditOverlay!.regionCount, 2);
    assert.equal(body.manualEditOverlay!.schemaVersion, "v0");
  } finally {
    await server.close();
  }
});

test("live evidence omits manualEditOverlay and defaults run-summary fields when no manual edits", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const manifest = {
    schemaVersion: "v0",
    capability: "evidence.pack",
    service: "evidence-service",
    packId: "epk-live-overlay-2",
    runId: "live-run-1",
    wave: "w0.2",
    status: "complete",
    completenessStatus: "complete",
    classification: "success",
    createdAt: "2026-05-19T10:00:30Z",
    artifacts: {},
    validation: {
      ok: true,
      requiredArtifacts: [],
      missingArtifacts: [],
      messages: [],
      completenessStatus: "complete",
    },
  };
  const { client: orch } = stubOrchestrator({
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: manifest,
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "f".repeat(64),
          byteSize: 768,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    const body = evidence.body as {
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
      manualEditOverlay: unknown;
    };
    assert.equal(body.manualEditsCarriedOver, false);
    assert.equal(body.manualDriftRegionCount, 0);
    assert.equal(body.manualEditOverlay, null);
  } finally {
    await server.close();
  }
});

test("live evidence with missing manifest reports incomplete status and zero pack id; never claims complete", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator(); // no evidence stub => returns undefined
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    const body = evidence.body as {
      status: string;
      packId: string;
      manifestUri?: string;
      missingArtifacts: string[];
      validationStatus: string;
    };
    assert.equal(body.status, "incomplete");
    assert.equal(body.packId, "");
    assert.equal(body.manifestUri, undefined);
    assert.equal(body.validationStatus, "unknown");
    assert.deepEqual(body.missingArtifacts, ["evidence-pack-manifest"]);
  } finally {
    await server.close();
  }
});

test("transform rejects blank source text and does not create a run", async () => {
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "   " },
    });
    assert.equal(rejected.status, 400);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("transform fails clearly when orchestrator url is missing", async () => {
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. TRANS01.\n" },
    });
    assert.equal(rejected.status, 503);
    assert.match(
      (rejected.body as { error: string }).error,
      /orchestrator URL/i,
    );
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("transform derives program id, calls orchestrator, and returns the full transform contract", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      modelGatewayUrl: "http://gateway",
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n";
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText, sourceName: "hello.cbl", options: { explain: true } },
    });
    assert.equal(started.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.deepEqual(calls.startTransformRun[0], {
      programId: "HELLO01",
      sourceText,
      requester: "c2c-ui",
      sourceName: "hello.cbl",
      options: { explain: true },
      targetLanguage: "java",
      expectedOutput: undefined,
      oracleInput: undefined,
      useTransformationAgent: false,
    });
    assert.equal(runStore.list().length, 1);

    const body = started.body as {
      runId: string;
      orchestratorRunId: string;
      programId: string;
      mode: string;
      status: string;
      productMode: string;
      links: Record<string, string>;
    };
    assert.equal(body.programId, "HELLO01");
    assert.equal(body.mode, "live");
    // TransformResponse extends RunSummary; productMode follows stored mode.
    assert.equal(body.productMode, "live");
    assert.equal(body.orchestratorRunId, "live-transform-1");
    assert.equal(body.status, "updating");
    assert.deepEqual(body.links, {
      self: `/api/v0/runs/${body.runId}`,
      generated: `/api/v0/runs/${body.runId}/generated`,
      generatedFiles: `/api/v0/runs/${body.runId}/generated/files`,
      buildTest: `/api/v0/runs/${body.runId}/build-test`,
      evidence: `/api/v0/runs/${body.runId}/evidence`,
      events: `/api/v0/runs/${body.runId}/events`,
      artifacts: `/api/v0/runs/${body.runId}/artifacts`,
      progress: `/api/v0/runs/${body.runId}/progress`,
      learning: `/api/v0/runs/${body.runId}/learning`,
      experience: `/api/v0/runs/${body.runId}/experience`,
      workflow: `/api/v0/runs/${body.runId}/workflow`,
      traceability: `/api/v0/runs/${body.runId}/traceability`,
    });
  } finally {
    await server.close();
  }
});

test("trust-case catalog lists defaults and saves a session preference", async () => {
  const sessionStore = createSessionStore({
    randomBytes: (size) => Buffer.alloc(size, 3),
    idleTimeoutMs: 0,
  });
  const session = sessionStore.create({
    tenantId: "tenant-1",
    userId: "user-1",
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const listed = await fetchJson(
      `${server.baseUrl}/api/v0/trust-cases?programId=HELLO01`,
      {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` },
      },
    );
    assert.equal(listed.status, 200);
    assert.match(String(listed.headers.vary), /(?:^|,\s*)Cookie(?:,|$)/i);
    assert.equal(
      (listed.body as { defaultTrustCaseId: string }).defaultTrustCaseId,
      "HELLO01-DEFAULT",
    );
    assert.equal(
      (listed.body as { savedTrustCaseId: string | null }).savedTrustCaseId,
      null,
    );

    const saved = await fetchJson(
      `${server.baseUrl}/api/v0/session/trust-case-preference`,
      {
        method: "PUT",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` },
        body: { programId: "HELLO01", trustCaseId: "HELLO01-DEFAULT" },
      },
    );
    assert.equal(saved.status, 200);
    assert.equal(
      (saved.body as { trustCaseId: string }).trustCaseId,
      "HELLO01-DEFAULT",
    );

    const preference = await fetchJson(
      `${server.baseUrl}/api/v0/session/trust-case-preference?programId=HELLO01`,
      {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` },
      },
    );
    assert.equal(preference.status, 200);
    assert.match(String(preference.headers.vary), /(?:^|,\s*)Cookie(?:,|$)/i);
    assert.equal(
      (preference.body as { trustCaseId: string }).trustCaseId,
      "HELLO01-DEFAULT",
    );

    const listedWithPreference = await fetchJson(
      `${server.baseUrl}/api/v0/trust-cases?programId=HELLO01`,
      {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` },
      },
    );
    assert.match(
      String(listedWithPreference.headers.vary),
      /(?:^|,\s*)Cookie(?:,|$)/i,
    );
    assert.equal(
      (listedWithPreference.body as { savedTrustCaseId: string })
        .savedTrustCaseId,
      "HELLO01-DEFAULT",
    );
  } finally {
    await server.close();
  }
});

test("transform carries trustCaseId through the parity-aware path only", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      modelGatewayUrl: "http://gateway",
    },
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n";
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText,
        sourceName: "hello.cbl",
        trustCaseId: "HELLO01-DEFAULT",
      },
    });
    assert.equal(started.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.deepEqual(calls.startTransformRun[0], {
      programId: "HELLO01",
      sourceText,
      requester: "c2c-ui",
      sourceName: "hello.cbl",
      options: undefined,
      targetLanguage: "java",
      expectedOutput: undefined,
      oracleInput: undefined,
      useTransformationAgent: false,
      executionMode: "parity",
      trustCaseId: "HELLO01-DEFAULT",
    });
    const stored = runStore.list()[0];
    assert.equal(stored?.executionMode, "parity");
    assert.equal(stored?.trustCaseId, "HELLO01-DEFAULT");
    assert.equal(stored?.trustCaseConfigurationDigest, "1".repeat(64));
  } finally {
    await server.close();
  }
});

test("transform rejects unknown trust cases and browser-authored runtime internals", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n";
    const unknown = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText, trustCaseId: "MISSING-CASE" },
    });
    assert.equal(unknown.status, 400);
    assert.match(
      (unknown.body as { error: string }).error,
      /unknown trustCaseId/,
    );

    const unsafe = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText,
        trustCaseId: "HELLO01-DEFAULT",
        runtime: { programArgs: ["--tamper"] },
      },
    });
    assert.equal(unsafe.status, 400);
    assert.match(
      (unsafe.body as { error: string }).error,
      /browser-authored runtime internals/,
    );
    assert.equal(calls.startTransformRun.length, 0);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("transform uses a deterministic fallback program id when none is provided", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      '       IDENTIFICATION DIVISION.\n       DISPLAY "NO PROGRAM ID".\n';
    const expectedProgramId = `SRC-${createHash("sha256").update(sourceText, "utf8").digest("hex").slice(0, 12).toUpperCase()}`;
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText },
    });
    assert.equal(started.status, 201);
    assert.equal(calls.startTransformRun[0]?.programId, expectedProgramId);
    assert.equal(
      (started.body as { programId: string }).programId,
      expectedProgramId,
    );
    assert.equal(runStore.list().length, 1);
  } finally {
    await server.close();
  }
});

test("transform does not create a run when the orchestrator returns a non-2xx status", async () => {
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const client: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      return { status: 502, body: { error: "upstream rejected" } };
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: client,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. FAIL01.\n" },
    });
    assert.equal(rejected.status, 502);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("transform does not create a run when the orchestrator throws", async () => {
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const client: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      throw new Error("boom");
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: client,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. FAIL02.\n" },
    });
    assert.equal(rejected.status, 502);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("transform rejects oversize source text before calling the orchestrator", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      transformSourceMaxBytes: 32,
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. BIG01.\n" },
    });
    assert.equal(rejected.status, 413);
    assert.equal(calls.startTransformRun.length, 0);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("product transform calls only orchestrator URL, never capability endpoints", async () => {
  const observed: Array<{ url: string; method: string }> = [];
  const auth = createRouteAuth();
  const recordingHttp: HttpClient = {
    async request(
      targetUrl: string,
      options: HttpRequestOptions,
    ): Promise<UpstreamResponse> {
      observed.push({ url: targetUrl, method: options.method ?? "GET" });
      return {
        status: 201,
        body: {
          run: {
            runId: "orch-isolation-1",
            workflowId: "w0-migration-v0",
            status: "updating",
            policyDecision: "allow",
            message: "orchestrator accepted",
            evidenceRefs: [],
          },
          status: "started",
          message: "orchestrator run started",
        },
      };
    },
  };

  const orchestratorUrl = "http://orchestrator.test";
  const evidenceUrl = "http://evidence.test";
  const orchestrator = createOrchestratorClient(
    orchestratorUrl,
    recordingHttp,
    1_000,
  );
  const evidence = createEvidenceClient(evidenceUrl, recordingHttp, 1_000);

  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl, evidenceUrl },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator,
    evidence,
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const transformed = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. ISO01.\n",
        useTransformationAgent: false,
      },
    });
    assert.equal(transformed.status, 201);

    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);

    assert.ok(
      observed.length >= 2,
      `expected upstream calls, observed=${observed.length}`,
    );
    for (const call of observed) {
      assert.ok(
        call.url.startsWith(orchestratorUrl) ||
          call.url.startsWith(evidenceUrl),
        `BFF must only call orchestrator or evidence URLs in product mode, observed ${call.method} ${call.url}`,
      );
    }
    const capabilityHints = [
      "/v0/parse",
      "/v0/ir",
      "/v0/generate",
      "/v0/run-verification",
      "/v0/invoke",
    ];
    for (const call of observed) {
      for (const hint of capabilityHints) {
        assert.ok(
          !call.url.endsWith(hint),
          `BFF must not call capability endpoint ${hint} directly; observed ${call.url}`,
        );
      }
    }
  } finally {
    await server.close();
  }
});

test("rejects malformed run start bodies", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const missing = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {},
    });
    assert.equal(missing.status, 400);

    const unknown = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "NOPE" },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("returns 404 for unknown api paths and run ids", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const unknownApi = await fetchJson(`${server.baseUrl}/api/v0/nope`);
    assert.equal(unknownApi.status, 404);

    const unknownRun = await fetchJson(
      `${server.baseUrl}/api/v0/runs/run-bogus`,
      { headers: auth.headers },
    );
    assert.equal(unknownRun.status, 404);
  } finally {
    await server.close();
  }
});

// Issue #96: progress + learning route contracts.

function disabledLearning(): {
  enabled: boolean;
  baseUrl: string;
  getRunSummary: () => Promise<undefined>;
  submitEditorTelemetry: () => Promise<undefined>;
} {
  return {
    enabled: false,
    baseUrl: "",
    async getRunSummary() {
      return undefined;
    },
    async submitEditorTelemetry() {
      return undefined;
    },
  };
}

test("model gateway health route normalizes upstream service payload to the Studio contract", async () => {
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: {
      enabled: true,
      async explain() {
        return undefined;
      },
      async getHealth() {
        return {
          status: 200,
          body: {
            status: "ok",
            service: "model-gateway",
            schema: "v0",
            providers: ["foundry"],
            activeModels: 2,
            configured: {
              mode: "foundry-dev",
              dataPolicy: "model-gateway",
              invocationLedgerEnabled: "true",
              harnessEventEmissionEnabled: "false",
            },
          },
        };
      },
      async getModels() {
        return undefined;
      },
      async getCapabilities() {
        return {
          status: 200,
          body: {
            schema: "v0",
            service: "model-gateway-service",
            status: "ok",
            provider: "foundry-development",
            policyId: "foundry-development-v0",
            roles: [
              {
                role: "transformation",
                status: "ok",
                policyId: "foundry-development-v0",
                availableModels: ["gpt-oss-120b"],
                configuredModels: ["gpt-oss-120b"],
              },
            ],
          },
        };
      },
    },
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/model-gateway/health`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "ok",
      providerMode: "foundry-dev",
      activeModelCount: 2,
      dataPolicy: "model-gateway",
      ledgerEnabled: true,
      eventEmission: false,
      policyId: "",
      roleAvailability: [
        {
          role: "transformation",
          status: "ok",
          policyId: "foundry-development-v0",
          availableModels: ["gpt-oss-120b"],
          configuredModels: ["gpt-oss-120b"],
          reason: "",
        },
      ],
    });
  } finally {
    await server.close();
  }
});

test("model gateway models route normalizes upstream registry payload to the Studio contract", async () => {
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: {
      enabled: true,
      async explain() {
        return undefined;
      },
      async getHealth() {
        return undefined;
      },
      async getModels() {
        return {
          status: 200,
          body: [
            { id: "gpt-4.1", displayName: "GPT 4.1", provider: "foundry" },
            {
              ID: "internal-a",
              DisplayName: "Internal A",
              Provider: "customer-internal",
            },
          ],
        };
      },
      async getCapabilities() {
        return undefined;
      },
    },
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/model-gateway/models`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      models: [
        { id: "gpt-4.1", name: "GPT 4.1", provider: "foundry" },
        { id: "internal-a", name: "Internal A", provider: "customer-internal" },
      ],
    });
  } finally {
    await server.close();
  }
});

test("model gateway capabilities route exposes per-role availability for blocked-state UI", async () => {
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: {
      enabled: true,
      async explain() {
        return undefined;
      },
      async getHealth() {
        return undefined;
      },
      async getModels() {
        return undefined;
      },
      async getCapabilities() {
        return {
          status: 200,
          body: {
            schema: "v0",
            service: "model-gateway-service",
            status: "degraded",
            provider: "foundry-development",
            policyId: "foundry-development-v0",
            roles: [
              {
                role: "transformation",
                status: "ok",
                policyId: "foundry-development-v0",
                availableModels: ["gpt-oss-120b"],
                configuredModels: ["gpt-oss-120b"],
              },
              {
                role: "verification-repair",
                status: "unavailable",
                policyId: "foundry-development-v0",
                availableModels: [],
                configuredModels: ["missing-model"],
                reason: "no approved active model for role",
              },
            ],
          },
        };
      },
    },
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/model-gateway/capabilities`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "degraded",
      providerMode: "foundry-development",
      policyId: "foundry-development-v0",
      roles: [
        {
          role: "transformation",
          status: "ok",
          policyId: "foundry-development-v0",
          availableModels: ["gpt-oss-120b"],
          configuredModels: ["gpt-oss-120b"],
          reason: "",
        },
        {
          role: "verification-repair",
          status: "unavailable",
          policyId: "foundry-development-v0",
          availableModels: [],
          configuredModels: ["missing-model"],
          reason: "no approved active model for role",
        },
      ],
    });
  } finally {
    await server.close();
  }
});

test("harness ready route keeps upstream ready payload parser-compatible for the Studio", async () => {
  const handler = createApp({
    config: { ...baseConfig, harnessUrl: "http://harness" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    harness: {
      enabled: true,
      async getReady() {
        return {
          status: 200,
          body: {
            status: "ready",
            capabilities: 2,
            runs: 1,
            policyGateway: "enabled",
          },
        };
      },
    },
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/harness/ready`);
    assert.equal(response.status, 200);
    assert.equal((response.body as { status: string }).status, "ok");
    assert.match(
      (response.body as { summary: string }).summary,
      /2 capabilities registered/i,
    );
  } finally {
    await server.close();
  }
});

test("progress route proxies orchestrator step timeline for live runs", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch, calls } = stubOrchestrator({
    progress: {
      status: 200,
      body: {
        runId: "live-run-1",
        runStatus: "updating",
        currentStep: "generate-java",
        failedStep: null,
        completedSteps: ["accepted", "parse-cobol", "generate-ir"],
        stepCount: 4,
        steps: [
          {
            stepId: 1,
            name: "accepted",
            capabilityId: "orchestrator-service",
            service: "orchestrator-service",
            actor: "orchestrator-service",
            status: "ok",
            startedAt: "2026-05-15T00:00:00Z",
            finishedAt: "2026-05-15T00:00:00Z",
          },
          {
            stepId: 2,
            name: "parse-cobol",
            capabilityId: "cobol.parse",
            service: "orchestrator-service",
            actor: "parser-service",
            status: "ok",
            startedAt: "2026-05-15T00:00:01Z",
            finishedAt: "2026-05-15T00:00:02Z",
            inputRef: { uri: "urn:in", sha256: "a".repeat(64), byteSize: 12 },
            outputRef: { uri: "urn:out", sha256: "b".repeat(64), byteSize: 24 },
          },
          {
            stepId: 3,
            name: "generate-ir",
            capabilityId: "cobol.ir",
            service: "orchestrator-service",
            actor: "ir-service",
            status: "ok",
            startedAt: "2026-05-15T00:00:03Z",
            finishedAt: "2026-05-15T00:00:04Z",
          },
          {
            stepId: 4,
            name: "generate-java",
            capabilityId: "java.generator",
            service: "orchestrator-service",
            actor: "generator-service",
            status: "running",
            startedAt: "2026-05-15T00:00:05Z",
          },
        ],
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(created.status, 201);
    const runId = (created.body as { runId: string }).runId;

    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
      { headers: auth.headers },
    );
    assert.equal(progress.status, 200);
    const body = progress.body as {
      status: string;
      runStatus: string;
      currentStep: string | null;
      failedStep: string | null;
      stepCount: number;
      steps: Array<{
        name: string;
        status: string;
        capabilityId: string;
        stepId: number;
        inputRef?: { uri?: string };
        outputRef?: { uri?: string };
      }>;
    };
    assert.equal(body.status, "complete");
    assert.equal(body.runStatus, "updating");
    assert.equal(body.currentStep, "generate-java");
    assert.equal(body.failedStep, null);
    assert.equal(body.stepCount, 4);
    assert.equal(body.steps[3]?.status, "running");
    assert.equal(body.steps[1]?.capabilityId, "cobol.parse");
    assert.equal(body.steps[1]?.inputRef?.uri, undefined);
    assert.equal(body.steps[1]?.outputRef?.uri, undefined);
    assert.equal(calls.getProgress, 1);
  } finally {
    await server.close();
  }
});

test("progress route sanitizes failed step diagnostics and never reports success", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    progress: {
      status: 200,
      body: {
        runId: "live-run-1",
        runStatus: "failed",
        currentStep: null,
        failedStep: "generate-java",
        completedSteps: ["accepted", "parse-cobol", "generate-ir"],
        stepCount: 5,
        steps: [
          {
            stepId: 1,
            name: "accepted",
            capabilityId: "orch",
            service: "orch",
            actor: "orch",
            status: "ok",
          },
          {
            stepId: 2,
            name: "parse-cobol",
            capabilityId: "cobol.parse",
            service: "orch",
            actor: "parser",
            status: "ok",
          },
          {
            stepId: 3,
            name: "generate-ir",
            capabilityId: "cobol.ir",
            service: "orch",
            actor: "ir",
            status: "ok",
          },
          {
            stepId: 4,
            name: "generate-java",
            capabilityId: "java.generator",
            service: "orch",
            actor: "generator",
            status: "failed",
            diagnostic:
              "generator backend unavailable at http://generator.internal/v0",
          },
          {
            stepId: 5,
            name: "repair-java",
            capabilityId: "java.repair",
            service: "orch",
            actor: "repair",
            status: "failed",
            diagnostic:
              'repair rejected payload {"sourceText":"IDENTIFICATION DIVISION.","expectedOutput":"ok","inputRef":{"uri":"s3://internal/artifact"}}',
          },
          {
            stepId: 6,
            name: "failed",
            capabilityId: "orch",
            service: "orch",
            actor: "orch",
            status: "failed",
            diagnostic:
              "W0 migration workflow failed: step generate-java failed",
          },
        ],
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
      { headers: auth.headers },
    );
    const body = progress.body as {
      runStatus: string;
      failedStep: string | null;
      steps: Array<{ name: string; status: string; diagnostic?: string }>;
    };
    assert.equal(body.runStatus, "failed");
    assert.equal(body.failedStep, "generate-java");
    const failedStep = body.steps.find(
      (entry) => entry.name === "generate-java",
    );
    assert.ok(failedStep, "failed step must be present in payload");
    assert.equal(failedStep?.status, "failed");
    assert.equal(
      failedStep?.diagnostic,
      "generator backend unavailable at [redacted]",
    );
    const payloadStep = body.steps.find(
      (entry) => entry.name === "repair-java",
    );
    assert.equal(
      payloadStep?.diagnostic,
      "Step failed. See workflow failure details for the classified reason.",
    );
    const workflowFailureStep = body.steps.find(
      (entry) => entry.name === "failed",
    );
    assert.equal(
      workflowFailureStep?.diagnostic,
      "W0 migration workflow failed: step generate-java failed",
    );
    const serialized = JSON.stringify(body.steps);
    assert.ok(!serialized.includes("http://generator.internal"));
    assert.ok(!serialized.includes("sourceText"));
    assert.ok(!serialized.includes("s3://internal"));
  } finally {
    await server.close();
  }
});

test("learning route prefers live experience-learning client when configured", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  let learningCalls = 0;
  const liveLearning = {
    enabled: true,
    baseUrl: "http://el.test",
    async getRunSummary(runId: string) {
      learningCalls += 1;
      return {
        status: 200,
        body: {
          runId,
          runStatus: "completed",
          candidateCount: 2,
          candidateByPattern: { accepted_pattern: 2 },
          experienceEventIds: ["evt-1", "evt-2"],
          observedPatterns: ["accepted_pattern"],
          observationOnly: true,
          policyVersion: "v0",
        },
      };
    },
    async submitEditorTelemetry() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: liveLearning,
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/learning`,
      { headers: auth.headers },
    );
    assert.equal(learning.status, 200);
    const body = learning.body as {
      source: string;
      status: string;
      summary: { candidateCount: number; observedPatterns: string[] } | null;
      endpoint?: string;
    };
    assert.equal(body.source, "live");
    assert.equal(body.status, "complete");
    assert.equal(body.summary?.candidateCount, 2);
    assert.deepEqual(body.summary?.observedPatterns, ["accepted_pattern"]);
    assert.equal(body.endpoint, undefined);
    assert.equal(learningCalls, 1);
    assert.equal(
      calls.getLearning,
      0,
      "orchestrator fallback must not be called when EL is live",
    );
  } finally {
    await server.close();
  }
});

test("experience route maps live learning summaries into the Studio contract", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch } = stubOrchestrator();
  const auth = createRouteAuth();
  const liveLearning = {
    enabled: true,
    baseUrl: "http://el.test",
    async getRunSummary(runId: string) {
      return {
        status: 200,
        body: {
          runId,
          runStatus: "completed",
          sourceEventCount: 4,
          sourceLedgerCount: 2,
          candidateCount: 2,
          candidateByPattern: { repeated_action: 2 },
          experienceEventIds: ["evt-1", "evt-2"],
          observedPatterns: ["repeated_action"],
          signals: [
            {
              key: "model_invocation_outcome",
              label: "Model invocation outcome",
              status: "observed",
              summary: "1 model-gateway outcome observed.",
              count: 1,
              evidenceRefs: ["evt-model"],
            },
          ],
          observationOnly: true,
          policyVersion: "v0",
          policyFingerprint: "fp-1",
        },
      };
    },
    async submitEditorTelemetry() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: liveLearning,
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/experience`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      runId,
      programId: "BRNCH01",
      mode: "live",
      productMode: "live",
      summary:
        "2 learning candidates observed • from 4 source events • 2 source ledgers considered • observation-only mode",
      observationPolicy: "v0 / fp-1",
      learningSignals: [
        {
          key: "model_invocation_outcome",
          label: "Model invocation outcome",
          status: "observed",
          summary: "1 model-gateway outcome observed.",
          count: 1,
          evidenceRefs: ["evt-model"],
        },
      ],
      detectedPatterns: ["repeated_action", "repeated_action: 2"],
      artifactRefs: ["evt-1", "evt-2"],
    });
  } finally {
    await server.close();
  }
});

test("learning route falls back to orchestrator-cached summary when EL is unavailable", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator({
    learning: {
      status: 200,
      body: {
        summary: {
          runId: "live-run-1",
          candidateCount: 1,
          observedPatterns: ["repeat_action"],
        },
        endpoint: "http://el.test/v0/runs/live-run-1/summary",
        source: "cached",
        missingArtifacts: [],
      },
    },
  });
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/learning`,
      { headers: auth.headers },
    );
    const body = learning.body as {
      source: string;
      summary: { candidateCount: number } | null;
      endpoint?: string;
    };
    assert.equal(body.source, "cached");
    assert.equal(body.summary?.candidateCount, 1);
    assert.equal(body.endpoint, undefined);
    assert.equal(calls.getLearning, 1);
  } finally {
    await server.close();
  }
});

test("progress route is unavailable for diagnostic-fixture runs", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
      { headers: auth.headers },
    );
    assert.equal(progress.status, 200);
    const body = progress.body as {
      mode: string;
      productMode: string;
      status: string;
    };
    assert.equal(body.mode, "diagnostic-fixture");
    assert.equal(body.productMode, "unavailable");
    assert.equal(body.status, "incomplete");
  } finally {
    await server.close();
  }
});

test("upstream experienceLearning client encodes run id and proxies summary", async () => {
  const { createNodeHttpClient, createExperienceLearningClient } =
    await import("./upstream");
  const httpClient = createNodeHttpClient();
  const observed: Array<{ url: string; method: string }> = [];
  const target = http.createServer((req, res) => {
    observed.push({ url: req.url ?? "", method: req.method ?? "GET" });
    const body = JSON.stringify({ runId: "r-1", candidateCount: 7 });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  try {
    const address = target.address() as net.AddressInfo;
    const client = createExperienceLearningClient(
      `http://127.0.0.1:${address.port}`,
      httpClient,
      1_000,
    );
    assert.equal(client.enabled, true);
    const result = await client.getRunSummary("run a/b");
    assert.equal(result?.status, 200);
    assert.equal(observed[0]?.url, "/v0/runs/run%20a%2Fb/summary");
  } finally {
    await new Promise<void>((resolve, reject) =>
      target.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("product-mode responses never advertise diagnostic-fixture mode or unavailable productMode as a success", async () => {
  // Configure a live orchestrator that returns persisted artifacts so the BFF
  // can build a complete product-mode response. The guard scans every payload
  // for placeholder execution markers and verifies the contained productMode
  // signal is consistent with the artifact status.
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const generatedJava =
    'package c2c;\npublic final class CASE01 { public static void main(String[] a) { System.out.println("APPROVED-COUNT=2"); } }\n';
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": generatedJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: {
          uri: "file:///run/generation-response.json",
          sha256: "a".repeat(64),
          byteSize: 128,
        },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        missingArtifacts: [],
        kind: "build-test-result",
        data: {
          status: "ok",
          classification: "match",
          actualOutput: "APPROVED-COUNT=2\n",
        },
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "b".repeat(64),
          byteSize: 32,
        },
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        programId: "CASE01",
        runStatus: "completed",
        missingArtifacts: [],
        data: {
          packId: "epk-1",
          validation: { status: "valid", missingArtifacts: [] },
          exports: [],
        },
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "c".repeat(64),
          byteSize: 64,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as {
      runId: string;
      mode: string;
      productMode: string;
    };
    assert.equal(startedBody.mode, "live");
    assert.equal(startedBody.productMode, "live");

    const endpoints = [
      "generated",
      "build-test",
      "evidence",
      "events",
      "artifacts",
    ];
    for (const endpoint of endpoints) {
      const response = await fetchJson(
        `${server.baseUrl}/api/v0/runs/${startedBody.runId}/${endpoint}`,
        { headers: auth.headers },
      );
      assert.equal(
        response.status,
        200,
        `${endpoint} must respond 200 for a product run`,
      );
      const payload = response.body as Record<string, unknown>;
      assert.equal(
        payload.mode,
        "live",
        `${endpoint} must report mode=live for a product run`,
      );
      // Scan the serialized payload for placeholder execution markers.
      const serialized = JSON.stringify(payload);
      for (const marker of PLACEHOLDER_JAVA_MARKERS) {
        assert.ok(
          !serialized.includes(marker),
          `${endpoint} product-mode response must not contain placeholder marker "${marker}"`,
        );
      }
      assert.ok(
        !serialized.includes("diagnostic-fixture"),
        `${endpoint} product-mode response must not contain the literal "diagnostic-fixture"`,
      );
      assert.doesNotMatch(
        serialized,
        /file:\/\/|https?:\/\/|\/var\/lib|absolutePath|uri"/,
        `${endpoint} product-mode response must not leak artifact locations`,
      );
    }
  } finally {
    await server.close();
  }
});

test("mock-data module has been quarantined and is not reachable through the product-mode server module graph", () => {
  // Issue #93: `mock-data.ts` must be deleted or moved into a quarantined
  // subdirectory so it cannot be imported by product-mode server code.
  const bffSrc = path.resolve(__dirname, "..", "..", "c2c-bff", "src");
  // The flat `src/mock-data.ts` is gone.
  assert.equal(
    fs.existsSync(path.join(bffSrc, "mock-data.ts")),
    false,
    "services/c2c-bff/src/mock-data.ts must be removed; diagnostic fixtures live under diagnostic-fixtures/",
  );
  // Product-mode files (server.ts, index.ts) must not import the fixture module.
  const productFiles = ["server.ts", "index.ts", "config.ts", "upstream.ts"];
  for (const file of productFiles) {
    const absolute = path.join(bffSrc, file);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, "utf8");
    assert.ok(
      !/diagnostic-fixtures\/fixture-data/.test(source),
      `${file} must not import diagnostic-fixtures/fixture-data; only run-store may do so`,
    );
    assert.ok(
      !/from ['"]\.\/mock-data['"]/.test(source),
      `${file} must not import the legacy mock-data module`,
    );
  }
});

test("W0 browser acceptance fixtures do not enable diagnostic fixtures", () => {
  // Issue #93: diagnostic fixture mode must not be used by W0 acceptance tests.
  // We scan likely browser/playwright config locations at the repo root.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const candidates = [
    path.join(repoRoot, ".github", "workflows"),
    path.join(repoRoot, "apps", "c2c-studio", "tests"),
    path.join(repoRoot, "apps", "c2c-ui", "tests"),
    path.join(repoRoot, "tests"),
    path.join(repoRoot, "e2e"),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) continue;
      const stat = fs.statSync(next);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(next)) {
          if (
            entry === "node_modules" ||
            entry === "dist" ||
            entry === "dist-test"
          )
            continue;
          stack.push(path.join(next, entry));
        }
        continue;
      }
      if (!/\.(ya?ml|json|ts|tsx|js|mjs|cjs|sh)$/.test(next)) continue;
      const text = fs.readFileSync(next, "utf8");
      assert.ok(
        !/C2C_ENABLE_DIAGNOSTIC_FIXTURES\s*[:=]\s*['"]?(?:1|true|yes|on)['"]?/.test(
          text,
        ),
        `${next} must not enable C2C_ENABLE_DIAGNOSTIC_FIXTURES for browser/acceptance flows`,
      );
    }
  }
});

test("Issue #97: generated/files index proxies orchestrator response and exposes artifactRef", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const javaContent = "package c2c;\npublic final class CASE01 {}\n";
  const comparisonContent = "comparison ok\n";
  const filesIndex = [
    {
      path: "pom.xml",
      sha256: "a".repeat(64),
      byteSize: 16,
      mimeType: "application/xml",
    },
    {
      path: "src/main/java/c2c/CASE01.java",
      absolutePath:
        "/var/lib/orchestrator/generated/src/main/java/c2c/CASE01.java",
      uri: "https://storage.internal/generated/CASE01.java?token=secret",
      sha256: "b".repeat(64),
      byteSize: javaContent.length,
      mimeType: "text/x-java-source",
    },
  ];
  const { client: orch, calls } = stubOrchestrator({
    generatedFiles: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        files: filesIndex,
        fileCount: filesIndex.length,
        entryFilePath: "src/main/java/c2c/CASE01.java",
        artifactRef: {
          uri: "file:///run/generated-project-manifest.json",
          sha256: "c".repeat(64),
          byteSize: 512,
        },
      },
    },
    generatedFile: (filePath) => {
      if (filePath === "src/main/java/c2c/CASE01.java") {
        return {
          status: 200,
          body: {
            path: filePath,
            absolutePath: "generated-project/src/main/java/c2c/CASE01.java",
            content: javaContent,
            sha256: "b".repeat(64),
            byteSize: javaContent.length,
            mimeType: "text/x-java-source",
            uri: "file:///run/generated-project/CASE01.java",
            kind: "generated-project-file",
          },
        };
      }
      return {
        status: 404,
        body: { error: "generated file not found", path: filePath },
      };
    },
    artifactFile: (filePath) => {
      if (filePath === "logs/studio/comparison.log") {
        return {
          status: 200,
          body: {
            path: filePath,
            content: comparisonContent,
            sha256: "d".repeat(64),
            byteSize: comparisonContent.length,
            mimeType: "text/plain",
            kind: "trajectory-ledger",
          },
        };
      }
      return {
        status: 404,
        body: { error: "artifact not found", path: filePath },
      };
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string };

    const index = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files`,
      { headers: auth.headers },
    );
    assert.equal(index.status, 200);
    const indexBody = index.body as {
      status: string;
      productMode: string;
      fileCount: number;
      files: Array<{ path: string; sha256: string; byteSize: number }>;
      entryFilePath: string;
      artifactRef: { sha256: string; byteSize: number } | null;
    };
    assert.equal(indexBody.status, "complete");
    assert.equal(indexBody.productMode, "live");
    assert.equal(indexBody.fileCount, 2);
    assert.equal(indexBody.entryFilePath, "src/main/java/c2c/CASE01.java");
    assert.equal(indexBody.artifactRef?.sha256, "c".repeat(64));
    assert.doesNotMatch(
      JSON.stringify(index.body),
      /storage\.internal|\/var\/lib|file:\/\//,
    );
    assert.equal(calls.getGeneratedFiles, 1);

    const file = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/CASE01.java`,
      { headers: auth.headers },
    );
    assert.equal(file.status, 200);
    const fileBody = file.body as {
      path: string;
      content: string;
      sha256: string;
      byteSize: number;
    };
    assert.equal(fileBody.path, "src/main/java/c2c/CASE01.java");
    assert.equal(fileBody.content, javaContent);
    assert.equal(fileBody.byteSize, javaContent.length);
    assert.doesNotMatch(
      JSON.stringify(file.body),
      /storage\.internal|\/var\/lib|file:\/\//,
    );
    assert.equal(calls.getGeneratedFile.length, 1);
    assert.equal(
      calls.getGeneratedFile[0]?.path,
      "src/main/java/c2c/CASE01.java",
    );

    const artifact = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts/files/logs/studio/comparison.log`,
      { headers: auth.headers },
    );
    assert.equal(artifact.status, 200);
    const artifactBody = artifact.body as {
      path: string;
      content: string;
      sha256: string;
      byteSize: number;
      kind: string;
    };
    assert.equal(artifactBody.path, "logs/studio/comparison.log");
    assert.equal(artifactBody.content, comparisonContent);
    assert.equal(artifactBody.kind, "trajectory-ledger");
    assert.doesNotMatch(
      JSON.stringify(artifact.body),
      /storage\.internal|\/var\/lib|file:\/\//,
    );
    assert.equal(calls.getArtifactFile.length, 1);
    assert.equal(calls.getArtifactFile[0]?.path, "logs/studio/comparison.log");

    // Path traversal attempts are rejected by the BFF before reaching the orchestrator.
    const traversal = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/..%2F..%2Fetc%2Fpasswd`,
      { headers: auth.headers },
    );
    assert.equal(traversal.status, 400);

    const artifactTraversal = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts/files/..%2F..%2Fetc%2Fpasswd`,
      { headers: auth.headers },
    );
    assert.equal(artifactTraversal.status, 400);

    const malformedGeneratedPath = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/%E0%A4%A`,
      { headers: auth.headers },
    );
    assert.equal(malformedGeneratedPath.status, 400);

    const malformedArtifactPath = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts/files/%E0%A4%A`,
      { headers: auth.headers },
    );
    assert.equal(malformedArtifactPath.status, 400);

    const malformedGeneratedRunId = await fetchJson(
      `${server.baseUrl}/api/v0/runs/%E0%A4%A/generated/files/src/main/java/c2c/CASE01.java`,
      { headers: auth.headers },
    );
    assert.equal(malformedGeneratedRunId.status, 400);

    const malformedArtifactRunId = await fetchJson(
      `${server.baseUrl}/api/v0/runs/%E0%A4%A/artifacts/files/logs/studio/comparison.log`,
      { headers: auth.headers },
    );
    assert.equal(malformedArtifactRunId.status, 400);

    assert.equal(calls.getGeneratedFile.length, 1);
    assert.equal(calls.getArtifactFile.length, 1);

    // Unknown file inside the generated tree returns 404, not 200.
    const missing = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/does/not/exist.java`,
      { headers: auth.headers },
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("Issue #97: /generated, /build-test, and /evidence all carry the same generated artifact hash", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const javaContent =
    "package c2c;\npublic final class CASE01 { public static void main(String[] a) {} }\n";
  const manifestHash = "f".repeat(64);
  const generatedArtifactRef = {
    uri: "file:///run/generated-project-manifest.json",
    sha256: manifestHash,
    byteSize: 512,
  };
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        entryClass: "CASE01",
        entryFilePath: "src/main/java/c2c/CASE01.java",
        fileCount: 1,
        files: { "src/main/java/c2c/CASE01.java": javaContent },
        unsupportedFeatures: [],
        openAssumptions: [],
        artifactRef: generatedArtifactRef,
        traceability: {
          programId: "CASE01",
          irId: "ir-CASE01",
          sourceHash: "aa",
        },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: {
          status: "ok",
          classification: "match",
          actualOutput: "",
          outputRef: null,
        },
        artifactRef: {
          uri: "file:///run/build-test-result.json",
          sha256: "c".repeat(64),
          byteSize: 256,
        },
        generatedArtifactRef,
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "CASE01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        data: { packId: "epk-1", status: "complete" },
        artifactRef: {
          uri: "file:///run/evidence-pack-manifest.json",
          sha256: "d".repeat(64),
          byteSize: 512,
        },
        generatedArtifactRef,
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
      { headers: auth.headers },
    );
    const genBody = generated.body as {
      artifactRef: { sha256: string } | null;
      traceability: {
        schemaVersion: string;
        programId: string;
        irId: string;
        sourceHash: string;
      };
    };
    assert.equal(genBody.artifactRef?.sha256, manifestHash);
    assert.equal(genBody.traceability.schemaVersion, "v0");
    assert.equal(genBody.traceability.programId, "CASE01");
    assert.equal(genBody.traceability.irId, "ir-CASE01");

    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    const btBody = buildTest.body as {
      generatedArtifactRef: { sha256: string } | null;
    };
    assert.equal(btBody.generatedArtifactRef?.sha256, manifestHash);

    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
      { headers: auth.headers },
    );
    const evBody = evidence.body as {
      generatedArtifactRef: { sha256: string } | null;
    };
    assert.equal(evBody.generatedArtifactRef?.sha256, manifestHash);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Issue #172: W0.2 BFF contract — workflow endpoint, sanitized failure codes,
// run-summary surface, transform input validation, and generated-file size
// limit. The tests below assert that the browser never sees orchestrator
// stack traces, raw URLs, or unknown failure codes.
// ---------------------------------------------------------------------------

test("GET /api/v0/runs/{runId}/workflow normalizes the W0.2 contract and maps the failure code", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        runStatus: "failed",
        status: "complete",
        source: "live",
        contract: {
          schemaVersion: 1,
          runId: "live-run-1",
          currentState: "final_classification",
          activeStep: "verification_repair_agent",
          agentAttemptCount: 2,
          repairBudget: { limit: 2, used: 2, remaining: 0 },
          repairAttempts: [
            {
              attemptNumber: 1,
              repairDecision: "propose_candidate",
              failureCategory: "java_compile_failed",
              createdAt: "2026-05-16T12:00:00Z",
              modelInvocationRef: {
                uri: "urn:mg/invocation/123",
                sha256: "a".repeat(64),
              },
              repairInputRef: { uri: "urn:repair/input/1" },
              javaCandidateRef: { uri: "urn:java/cand/1" },
              rationale: "compile error in line 12",
            },
            {
              attemptNumber: 2,
              repairDecision: "no_change",
              failureCategory: "java_compile_failed",
              createdAt: "2026-05-16T12:01:00Z",
            },
          ],
          finalClassification: "blocked",
          failureCode: "java_compile_failed",
          manualEditsCarriedOver: true,
          manualDriftRegionCount: 2,
          failureMessage:
            "compile at http://orchestrator.internal:18088/v0/runs/live-run-1 failed at module.fn (/Users/me/repo/file.java:10:5)",
          generatedJavaRef: {
            uri: "urn:c2c/gen/1",
            sha256: "b".repeat(64),
            byteSize: 1024,
            kind: "generated-project-manifest",
          },
          buildTestResultRef: {
            uri: "urn:c2c/bt/1",
            sha256: "c".repeat(64),
            byteSize: 256,
            kind: "build-test-result",
          },
          evidencePackRef: {
            uri: "urn:c2c/ev/1",
            sha256: "d".repeat(64),
            byteSize: 512,
            kind: "evidence-pack-manifest",
          },
        },
        contractRef: null,
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    assert.equal(workflow.status, 200);
    const wfBody = workflow.body as {
      mode: string;
      productMode: string;
      source: string;
      state: string;
      activeStep: string;
      activeAgent: string;
      agentAttemptCount: number;
      repairBudget: { limit: number; used: number; remaining: number };
      repairAttempts: Array<{
        attemptNumber: number;
        repairDecision: string;
        failureCategory: string | null;
        hasModelInvocation: boolean;
        hasRepairInput: boolean;
        hasJavaCandidate: boolean;
        rationale?: string;
      }>;
      finalClassification: string;
      failureCode: string;
      failureMessage: string;
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
      generatedJavaRef: {
        sha256: string;
        byteSize: number;
        kind: string;
      } | null;
      buildTestResultRef: {
        sha256: string;
        byteSize: number;
        kind: string;
      } | null;
      evidencePackRef: {
        sha256: string;
        byteSize: number;
        kind: string;
      } | null;
    };
    assert.equal(wfBody.mode, "live");
    assert.equal(wfBody.productMode, "live");
    assert.equal(wfBody.source, "live");
    assert.equal(wfBody.state, "final_classification");
    assert.equal(wfBody.activeStep, "verification_repair_agent");
    assert.equal(wfBody.activeAgent, "verification_repair_agent");
    assert.equal(wfBody.agentAttemptCount, 2);
    assert.deepEqual(wfBody.repairBudget, { limit: 2, used: 2, remaining: 0 });
    assert.equal(wfBody.repairAttempts.length, 2);
    assert.deepEqual(wfBody.repairAttempts[0], {
      attemptNumber: 1,
      repairDecision: "propose_candidate",
      failureCategory: "java_compile_failed",
      hasModelInvocation: true,
      hasRepairInput: true,
      hasJavaCandidate: true,
      rationale: "compile error in line 12",
    });
    assert.equal(wfBody.repairAttempts[1]?.repairDecision, "no_change");
    assert.equal(wfBody.finalClassification, "blocked");
    assert.equal(wfBody.failureCode, "java_compile_failed");
    assert.equal(wfBody.manualEditsCarriedOver, true);
    assert.equal(wfBody.manualDriftRegionCount, 2);
    assert.ok(
      !wfBody.failureMessage.includes("http://"),
      "failureMessage must not leak orchestrator URL",
    );
    assert.ok(
      !wfBody.failureMessage.includes("/Users/"),
      "failureMessage must not leak filesystem paths",
    );
    assert.equal(wfBody.generatedJavaRef?.sha256, "b".repeat(64));
    assert.equal(wfBody.buildTestResultRef?.sha256, "c".repeat(64));
    assert.equal(wfBody.evidencePackRef?.sha256, "d".repeat(64));
    const summary = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    const summaryBody = summary.body as {
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
    };
    assert.equal(summaryBody.manualEditsCarriedOver, true);
    assert.equal(summaryBody.manualDriftRegionCount, 2);
    // None of the contract response must carry the raw modelInvocationRef URI.
    const serialised = JSON.stringify(wfBody);
    assert.ok(
      !serialised.includes("urn:mg/invocation/123"),
      "model invocation ref must be sanitized out",
    );
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow surfaces the W0.3 assist-decision gate when present", async () => {
  // W0.3 (#214): consumers must be able to read the assist decision (outcome,
  // reason code, selected agent role, budget snapshot, affected artifacts)
  // directly from the workflow envelope without inferring from
  // ``agentAttemptCount`` or ``activeAgent``.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        runId: "live-run-2",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        runStatus: "in-progress",
        status: "complete",
        source: "live",
        contract: {
          currentState: "transformation_agent_invoked",
          activeStep: "transformation-agent",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          assistDecision: {
            outcome: "assist_required",
            reasonCode: "caller_explicit_opt_in",
            decidedAt: "2026-05-17T12:00:00Z",
            selectedAgentRole: "transformation_agent",
            affectedArtifactRefs: [
              {
                sha256: "a".repeat(64),
                byteSize: 4096,
                kind: "generated-project-manifest",
                path: "baseline.json",
              },
            ],
            repairBudgetSnapshot: { limit: 2, used: 0, remaining: 2 },
            rationale: "caller opted in",
          },
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
        contractRef: null,
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    assert.equal(workflow.status, 200);
    const body = workflow.body as {
      assistDecision: Record<string, unknown> | null;
    };
    assert.ok(
      body.assistDecision,
      "assistDecision must be exposed on the workflow envelope",
    );
    assert.equal(body.assistDecision.outcome, "assist_required");
    assert.equal(body.assistDecision.reasonCode, "caller_explicit_opt_in");
    assert.equal(body.assistDecision.selectedAgentRole, "transformation_agent");
    assert.equal(body.assistDecision.decidedAt, "2026-05-17T12:00:00Z");
    assert.equal(body.assistDecision.rationale, "caller opted in");
    assert.deepEqual(body.assistDecision.repairBudgetSnapshot, {
      limit: 2,
      used: 0,
      remaining: 2,
    });
    const refs = body.assistDecision.affectedArtifactRefs as Array<{
      sha256?: string;
      kind?: string;
    }>;
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.kind, "generated-project-manifest");
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow passes through deterministic uncertainty reason codes", async () => {
  // W0.3-4 (#215): the deterministic uncertainty reason codes — semantic
  // IR bounded ambiguity, translation unsupported-but-repairable, baseline
  // open assumptions, and deterministic candidate low-confidence — are
  // members of the closed reasonCode set and must flow through the BFF
  // sanitiser unchanged. The UI consumers depend on the specific code to
  // render a causal "why AI was used" surface.
  const uncertaintyCodes = [
    "semantic_ir_bounded_ambiguity",
    "translation_unsupported_repairable",
    "baseline_open_assumptions",
    "deterministic_candidate_low_confidence",
  ] as const;
  for (const reasonCode of uncertaintyCodes) {
    const runStore = createRunStore();
    const samples = stubSamples([FIXED_SAMPLE]);
    const auth = createRouteAuth();
    const { client: orch } = stubOrchestrator({
      workflow: {
        status: 200,
        body: {
          runId: "live-run-uncertain",
          workflowId: "w0-migration-v0",
          programId: "BRNCH01",
          runStatus: "in-progress",
          status: "complete",
          source: "live",
          contract: {
            currentState: "transformation_agent_invoked",
            activeStep: "transformation-agent",
            agentAttemptCount: 1,
            repairBudget: { limit: 2, used: 0, remaining: 2 },
            repairAttempts: [],
            assistDecision: {
              outcome: "assist_required",
              reasonCode,
              decidedAt: "2026-05-17T12:00:00Z",
              selectedAgentRole: "transformation_agent",
              affectedArtifactRefs: [
                {
                  sha256: "b".repeat(64),
                  byteSize: 4096,
                  kind: "generated-project-manifest",
                },
              ],
              repairBudgetSnapshot: { limit: 2, used: 0, remaining: 2 },
              rationale: `deterministic uncertainty marker: ${reasonCode}`,
            },
            finalClassification: null,
            failureCode: null,
            failureMessage: null,
          },
          contractRef: null,
          missingArtifacts: [],
        },
      },
    });
    const handler = createApp({
      config: { ...baseConfig, orchestratorUrl: "http://upstream" },
      samples,
      orchestrator: orch,
      evidence: disabledEvidence(),
      runStore,
      sessionStore: auth.sessionStore,
    });
    const server = await startTestServer(handler);
    try {
      const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
        method: "POST",
        headers: auth.headers,
        body: { programId: "BRNCH01" },
      });
      const startedBody = started.body as { runId: string };
      const workflow = await fetchJson(
        `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
        { headers: auth.headers },
      );
      const body = workflow.body as {
        assistDecision: Record<string, unknown> | null;
      };
      assert.ok(
        body.assistDecision,
        `assistDecision must survive sanitisation for ${reasonCode}`,
      );
      assert.equal(body.assistDecision.reasonCode, reasonCode);
      assert.equal(body.assistDecision.outcome, "assist_required");
      assert.equal(
        body.assistDecision.selectedAgentRole,
        "transformation_agent",
      );
    } finally {
      await server.close();
    }
  }
});

test("GET /api/v0/runs/{runId}/workflow drops assistDecision with unknown reason code", async () => {
  // W0.3-4 (#215): every reason code outside the closed set MUST be
  // sanitised to ``assistDecision: null`` so the UI cannot render an
  // unrecognised reason silently. The check is symmetrical with the
  // unknown-outcome case from #214.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "baseline_generation_attempted",
          activeStep: "assist-decision",
          agentAttemptCount: 0,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          assistDecision: {
            outcome: "assist_required",
            reasonCode: "generator_felt_unsure",
            decidedAt: "2026-05-17T12:00:00Z",
            selectedAgentRole: "transformation_agent",
          },
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const body = workflow.body as { assistDecision: unknown };
    assert.equal(body.assistDecision, null);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow drops assistDecision with unknown outcome", async () => {
  // W0.3 (#214): the BFF must never surface an unrecognised assist-decision
  // outcome to the UI. Any contract that carries an unknown outcome is
  // sanitised to ``assistDecision: null`` so the UI cannot render an
  // unknown reason silently.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "baseline_generation_attempted",
          activeStep: "assist-decision",
          agentAttemptCount: 0,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          assistDecision: {
            outcome: "maybe_later",
            reasonCode: "caller_explicit_opt_in",
            decidedAt: "2026-05-17T12:00:00Z",
          },
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const body = workflow.body as { assistDecision: unknown };
    assert.equal(body.assistDecision, null);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId} surfaces W0.2 contract fields on the run summary", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "transformation_agent_invoked",
          activeStep: "transformation_agent",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const run = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    const body = run.body as {
      activeStep: string;
      agentAttemptCount: number;
      repairBudget: { limit: number; used: number; remaining: number };
      finalClassification: string | null;
      failureCode: string | null;
      failureMessage: string | null;
    };
    assert.equal(body.activeStep, "transformation_agent");
    assert.equal(body.agentAttemptCount, 1);
    assert.deepEqual(body.repairBudget, { limit: 2, used: 0, remaining: 2 });
    assert.equal(body.finalClassification, null);
    assert.equal(body.failureCode, null);
    assert.equal(body.failureMessage, null);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow preserves cached W0.2 contract source", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        source: "cached",
        contract: {
          currentState: "final_classification",
          activeStep: "write-evidence",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          finalClassification: "success",
          failureCode: null,
          failureMessage: null,
          generatedJavaRef: {
            uri: "urn:c2c/gen/1",
            sha256: "b".repeat(64),
            byteSize: 1024,
            kind: "generated-project-manifest",
          },
          buildTestResultRef: {
            uri: "urn:c2c/bt/1",
            sha256: "c".repeat(64),
            byteSize: 256,
            kind: "build-test-result",
          },
          evidencePackRef: {
            uri: "urn:c2c/ev/1",
            sha256: "d".repeat(64),
            byteSize: 512,
            kind: "evidence-pack-manifest",
          },
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    assert.equal(workflow.status, 200);
    const body = workflow.body as {
      source: string;
      activeStep: string;
      activeAgent: string;
      finalClassification: string;
      generatedJavaRef: {
        sha256: string;
        byteSize: number;
        kind: string;
      } | null;
    };
    assert.equal(body.source, "cached");
    assert.equal(body.activeStep, "write-evidence");
    assert.equal(body.activeAgent, "evidence_service");
    assert.equal(body.finalClassification, "success");
    assert.deepEqual(body.generatedJavaRef, {
      sha256: "b".repeat(64),
      byteSize: 1024,
      kind: "generated-project-manifest",
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId} preserves normalized trustSummary across repeated reads", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const studioHeaders = auth.post({}, {}).headers;
  const trustSummary = {
    trustCaseId: "HELLO01-DEFAULT",
    verdict: "pass",
    evidenceRefs: ["urn:evidence/one", "urn:evidence/two"],
    createdAt: "2026-05-21T10:00:00Z",
    updatedAt: "2026-05-21T10:05:00Z",
    manualReviewAt: "2026-05-21T10:06:00Z",
    details: {
      source: "orchestrator",
      revision: 3,
    },
  };
  const { client: orch, calls } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        source: "live",
        contract: {
          currentState: "final_classification",
          finalClassification: "success",
          trustSummary,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
      headers: studioHeaders,
    });
    const startedBody = started.body as { runId: string };

    const first = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: studioHeaders },
    );
    const second = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: studioHeaders },
    );
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: studioHeaders },
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(workflow.status, 200);
    const firstBody = first.body as { trustSummary: typeof trustSummary };
    const secondBody = second.body as { trustSummary: typeof trustSummary };
    const workflowBody = workflow.body as { trustSummary: typeof trustSummary };

    assert.deepEqual(firstBody.trustSummary, trustSummary);
    assert.deepEqual(secondBody.trustSummary, trustSummary);
    assert.deepEqual(workflowBody.trustSummary, trustSummary);
    assert.deepEqual(firstBody.trustSummary, secondBody.trustSummary);
    assert.equal(calls.getRun, 2);
    assert.equal(calls.getWorkflow, 3);
  } finally {
    await server.close();
  }
});

test("PUT /api/v0/runs/{runId}/intentional-divergence caches the orchestrator trustSummary for repeated reads", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const studioHeaders = auth.post({}, {}).headers;
  const trustSummary = {
    trustCaseId: "HELLO01-DEFAULT",
    trustState: "intentional_divergence",
    divergenceDisposition: "intentional",
    evidenceRefs: ["urn:evidence/one"],
    decisionRecordRef: {
      sha256: "3".repeat(64),
      byteSize: 10,
      kind: "decision-record",
    },
    createdAt: "2026-05-21T10:00:00Z",
    updatedAt: "2026-05-21T10:05:00Z",
  };
  const { client: baseOrch, calls } = stubOrchestrator();
  type DivergenceRationale = {
    summary: string;
    technicalBasis: string;
    businessImpact: string;
  };
  type DivergencePayload = {
    reasonCode: string;
    rationale: DivergenceRationale;
    reviewer: string;
    evidenceRefs: string[];
    affectedOutputs: string[];
    invalidationTriggers: string[];
    expiresAt?: string;
    requester?: string;
  };
  const decisionRequests: Array<{
    runId: string;
    payload: DivergencePayload;
  }> = [];
  const orch: OrchestratorClient = {
    ...baseOrch,
    async upsertIntentionalDivergenceDecision(
      runId: string,
      payload: DivergencePayload,
    ) {
      decisionRequests.push({ runId, payload });
      return {
        status: 200,
        body: {
          runId,
          decisionRef: {
            sha256: "3".repeat(64),
            byteSize: 10,
            kind: "decision-record",
          },
          decision: {
            decisionId: "decision-1",
            reviewer: {
              reviewerId: payload.reviewer,
              displayName: payload.reviewer,
              role: "reviewer",
            },
            rationale: {
              summary: payload.rationale.summary,
              technicalBasis: payload.rationale.technicalBasis,
              businessImpact: payload.rationale.businessImpact,
            },
            linkedEvidenceRefs: payload.evidenceRefs.map((ref) => ({
              uri: ref,
              sha256: "4".repeat(64),
              byteSize: 20,
              kind: "evidence-record",
            })),
            affectedOutputs: payload.affectedOutputs,
            invalidationTriggers: payload.invalidationTriggers,
            ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
            decisionRecordRef: {
              sha256: "3".repeat(64),
              byteSize: 10,
              kind: "decision-record",
            },
          },
          trustSummary,
        },
      };
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
      headers: studioHeaders,
    });
    const startedBody = started.body as { runId: string };

    const decision = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/intentional-divergence-decision`,
      {
        method: "PUT",
        headers: studioHeaders,
        body: {
          decisionId: null,
          rationale: {
            summary: "The divergence is approved by the product owner.",
            technicalBasis:
              "Generated Java emits ISO timestamps where COBOL emits packed dates.",
            businessImpact:
              "Downstream ledgers ingest ISO timestamps without a converter.",
          },
          linkedEvidenceRefs: ["urn:evidence/one"],
          affectedOutputs: ["urn:output/one"],
          supersedesPreviousDecision: true,
          invalidationNote:
            "The product intentionally diverges from the baseline.",
        },
      },
    );
    assert.equal(decision.status, 200);
    const decisionBody = decision.body as {
      decisionRecordRef: { sha256: string; byteSize: number; kind: string };
      trustSummary: typeof trustSummary;
    };
    assert.deepEqual(decisionBody.decisionRecordRef, {
      sha256: "3".repeat(64),
      byteSize: 10,
      kind: "decision-record",
    });
    assert.deepEqual(decisionBody.trustSummary, trustSummary);
    assert.equal(decisionRequests.length, 1);
    assert.equal(decisionRequests[0]?.runId, startedBody.runId);
    assert.equal(
      decisionRequests[0]?.payload.reasonCode,
      "accepted_functional_change",
    );
    // Issue #368 finding-4: the structured rationale is forwarded verbatim;
    // no synthesized ``behaviorChange``/``rationaleSummary`` flat fields.
    assert.deepEqual(decisionRequests[0]?.payload.rationale, {
      summary: "The divergence is approved by the product owner.",
      technicalBasis:
        "Generated Java emits ISO timestamps where COBOL emits packed dates.",
      businessImpact:
        "Downstream ledgers ingest ISO timestamps without a converter.",
    });
    assert.deepEqual(decisionRequests[0]?.payload.evidenceRefs, [
      "urn:evidence/one",
    ]);
    assert.deepEqual(decisionRequests[0]?.payload.affectedOutputs, [
      "java_output",
    ]);
    assert.deepEqual(decisionRequests[0]?.payload.invalidationTriggers, [
      "comparison_result_changed",
      "affected_outputs_changed",
      "linked_evidence_changed",
    ]);
    assert.equal(
      decisionRequests[0]?.payload.requester,
      "studio:tenant-a:user-a",
    );
    // Issue #368 finding-5: reviewer is session-derived, identical to the
    // requester principal — never taken from the request body.
    assert.equal(
      decisionRequests[0]?.payload.reviewer,
      "studio:tenant-a:user-a",
    );

    const first = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: studioHeaders },
    );
    const second = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: studioHeaders },
    );
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: studioHeaders },
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(workflow.status, 200);
    const firstBody = first.body as { trustSummary: typeof trustSummary };
    const secondBody = second.body as { trustSummary: typeof trustSummary };
    const workflowBody = workflow.body as { trustSummary: typeof trustSummary };
    assert.deepEqual(firstBody.trustSummary, trustSummary);
    assert.deepEqual(secondBody.trustSummary, trustSummary);
    assert.deepEqual(workflowBody.trustSummary, trustSummary);
    assert.deepEqual(firstBody.trustSummary, secondBody.trustSummary);
    assert.equal(calls.getRun, 2);
    assert.equal(calls.getWorkflow, 3);
  } finally {
    await server.close();
  }
});

// Issue #368 finding-4/finding-5: the divergence decision contract requires
// a structured rationale and rejects any client-supplied reviewer identity.
async function withDivergenceDecisionServer(
  run: (ctx: {
    baseUrl: string;
    runId: string;
    studioHeaders: Record<string, string>;
    decisionRequests: Array<Record<string, unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const studioHeaders = auth.post({}, {}).headers;
  const { client: baseOrch } = stubOrchestrator();
  const decisionRequests: Array<Record<string, unknown>> = [];
  const orch: OrchestratorClient = {
    ...baseOrch,
    async upsertIntentionalDivergenceDecision(
      runId: string,
      payload: Record<string, unknown>,
    ) {
      decisionRequests.push(payload);
      return {
        status: 200,
        body: {
          runId,
          decisionRef: {
            sha256: "3".repeat(64),
            byteSize: 10,
            kind: "decision-record",
          },
          decision: { decisionId: "decision-1" },
        },
      };
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
      headers: studioHeaders,
    });
    const startedBody = started.body as { runId: string };
    await run({
      baseUrl: server.baseUrl,
      runId: startedBody.runId,
      studioHeaders,
      decisionRequests,
    });
  } finally {
    await server.close();
  }
}

const VALID_DIVERGENCE_RATIONALE = {
  summary: "The divergence is approved by the product owner.",
  technicalBasis:
    "Generated Java emits ISO timestamps where COBOL emits packed dates.",
  businessImpact:
    "Downstream ledgers ingest ISO timestamps without a converter.",
};

test("PUT /api/v0/runs/{runId}/intentional-divergence rejects a missing structured rationale member", async () => {
  await withDivergenceDecisionServer(
    async ({ baseUrl, runId, studioHeaders, decisionRequests }) => {
      for (const omitted of [
        "summary",
        "technicalBasis",
        "businessImpact",
      ] as const) {
        const rationale = { ...VALID_DIVERGENCE_RATIONALE };
        delete (rationale as Record<string, unknown>)[omitted];
        const response = await fetchJson(
          `${baseUrl}/api/v0/runs/${runId}/intentional-divergence-decision`,
          {
            method: "PUT",
            headers: studioHeaders,
            body: {
              rationale,
              linkedEvidenceRefs: ["urn:evidence/one"],
              affectedOutputs: ["java_output"],
              supersedesPreviousDecision: false,
            },
          },
        );
        assert.equal(response.status, 400);
      }
      assert.equal(decisionRequests.length, 0);
    },
  );
});

test("PUT /api/v0/runs/{runId}/intentional-divergence rejects an empty structured rationale member", async () => {
  await withDivergenceDecisionServer(
    async ({ baseUrl, runId, studioHeaders, decisionRequests }) => {
      const response = await fetchJson(
        `${baseUrl}/api/v0/runs/${runId}/intentional-divergence-decision`,
        {
          method: "PUT",
          headers: studioHeaders,
          body: {
            rationale: { ...VALID_DIVERGENCE_RATIONALE, businessImpact: "   " },
            linkedEvidenceRefs: ["urn:evidence/one"],
            affectedOutputs: ["java_output"],
            supersedesPreviousDecision: false,
          },
        },
      );
      assert.equal(response.status, 400);
      assert.equal(decisionRequests.length, 0);
    },
  );
});

test("PUT /api/v0/runs/{runId}/intentional-divergence rejects a client-supplied reviewer field", async () => {
  await withDivergenceDecisionServer(
    async ({ baseUrl, runId, studioHeaders, decisionRequests }) => {
      const response = await fetchJson(
        `${baseUrl}/api/v0/runs/${runId}/intentional-divergence-decision`,
        {
          method: "PUT",
          headers: studioHeaders,
          body: {
            rationale: VALID_DIVERGENCE_RATIONALE,
            reviewer: "attacker-controlled reviewer",
            linkedEvidenceRefs: ["urn:evidence/one"],
            affectedOutputs: ["java_output"],
            supersedesPreviousDecision: false,
          },
        },
      );
      assert.equal(response.status, 400);
      assert.equal(decisionRequests.length, 0);
    },
  );
});

test("PUT /api/v0/runs/{runId}/intentional-divergence derives the reviewer from the session", async () => {
  await withDivergenceDecisionServer(
    async ({ baseUrl, runId, studioHeaders, decisionRequests }) => {
      const response = await fetchJson(
        `${baseUrl}/api/v0/runs/${runId}/intentional-divergence-decision`,
        {
          method: "PUT",
          headers: studioHeaders,
          body: {
            rationale: VALID_DIVERGENCE_RATIONALE,
            linkedEvidenceRefs: ["urn:evidence/one"],
            affectedOutputs: ["java_output"],
            supersedesPreviousDecision: false,
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(decisionRequests.length, 1);
      const payload = decisionRequests[0] ?? {};
      assert.equal(payload.reviewer, "studio:tenant-a:user-a");
      assert.equal(payload.requester, "studio:tenant-a:user-a");
      assert.deepEqual(payload.rationale, VALID_DIVERGENCE_RATIONALE);
    },
  );
});

test("GET /api/v0/runs/{runId}/workflow returns an empty W0.2 envelope when the orchestrator is unreachable", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator(); // no workflow stub -> undefined
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    assert.equal(workflow.status, 200);
    const body = workflow.body as {
      source: string;
      state: string | null;
      activeStep: string | null;
      activeAgent: string | null;
      agentAttemptCount: number;
      repairBudget: unknown;
      finalClassification: string | null;
      failureCode: string | null;
    };
    assert.equal(body.source, "unavailable");
    assert.equal(body.state, null);
    assert.equal(body.activeStep, null);
    assert.equal(body.activeAgent, null);
    assert.equal(body.agentAttemptCount, 0);
    assert.equal(body.repairBudget, null);
    assert.equal(body.finalClassification, null);
    assert.equal(body.failureCode, null);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow returns internal_error when contract reports a blocked run without a canonical code", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "final_classification",
          activeStep: null,
          agentAttemptCount: 1,
          repairBudget: { limit: 1, used: 1, remaining: 0 },
          repairAttempts: [],
          finalClassification: "blocked",
          failureCode: "__never_existed__",
          failureMessage: "some upstream error",
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const body = workflow.body as { failureCode: string };
    assert.equal(body.failureCode, "internal_error");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform rejects unsupported targetLanguage", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "python",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(calls.startTransformRun.length, 0);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform forwards expectedOutput and oracleInput to the orchestrator client", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
        expectedOutput: "HELLO WORLD\n",
        oracleInput: "",
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.equal(calls.startTransformRun[0]?.targetLanguage, "java");
    assert.equal(calls.startTransformRun[0]?.expectedOutput, "HELLO WORLD\n");
    assert.equal(calls.startTransformRun[0]?.oracleInput, "");
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, false);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform disables transformation-agent assist by default", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      modelGatewayUrl: "http://gateway",
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, false);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform does not require model gateway when assist flag is omitted", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, false);
    assert.equal(runStore.list().length, 1);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform forwards explicit transformation-agent opt-out", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      modelGatewayUrl: "http://gateway",
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
        useTransformationAgent: false,
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, false);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform rejects non-boolean transformation-agent opt-in", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        useTransformationAgent: "true",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(calls.startTransformRun.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform rejects expectedOutput when it is not a string", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        expectedOutput: 42,
      },
    });
    assert.equal(response.status, 400);
    assert.equal(calls.startTransformRun.length, 0);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/generated/files/{path} returns 413 when artifact exceeds configured limit", async () => {
  const runStore = createRunStore();
  const oversizedContent = "A".repeat(2048);
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    generatedFile: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        path: "src/main/java/c2c/BRNCH01.java",
        content: oversizedContent,
        sha256: "a".repeat(64),
        byteSize: oversizedContent.length,
        mimeType: "text/x-java",
        uri: "urn:c2c/gen/1",
        kind: "generated-project-file",
      },
    },
  });
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      artifactContentMaxBytes: 1024,
    },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/BRNCH01.java`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 413);
    const body = response.body as {
      error: string;
      limit: number;
      byteSize: number;
    };
    assert.equal(body.error, "artifact_too_large");
    assert.equal(body.limit, 1024);
    assert.equal(body.byteSize, oversizedContent.length);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/generated/files/{path} measures content when upstream underreports byteSize", async () => {
  const runStore = createRunStore();
  const oversizedContent = "A".repeat(2048);
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    generatedFile: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        path: "src/main/java/c2c/BRNCH01.java",
        content: oversizedContent,
        sha256: "a".repeat(64),
        byteSize: 1,
        mimeType: "text/x-java",
        uri: "urn:c2c/gen/1",
        kind: "generated-project-file",
      },
    },
  });
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      artifactContentMaxBytes: 1024,
    },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/BRNCH01.java`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 413);
    const body = response.body as {
      error: string;
      limit: number;
      byteSize: number;
    };
    assert.equal(body.error, "artifact_too_large");
    assert.equal(body.limit, 1024);
    assert.equal(body.byteSize, oversizedContent.length);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/artifacts/files/{path} returns 413 when artifact exceeds configured limit", async () => {
  const runStore = createRunStore();
  const oversizedContent = "A".repeat(2048);
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    artifactFile: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        path: "logs/studio/comparison.log",
        content: oversizedContent,
        sha256: "a".repeat(64),
        byteSize: oversizedContent.length,
        mimeType: "text/plain",
        uri: "urn:c2c/artifact/1",
        kind: "trajectory-ledger",
      },
    },
  });
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      artifactContentMaxBytes: 1024,
    },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts/files/logs/studio/comparison.log`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 413);
    const body = response.body as {
      error: string;
      limit: number;
      byteSize: number;
    };
    assert.equal(body.error, "artifact_too_large");
    assert.equal(body.limit, 1024);
    assert.equal(body.byteSize, oversizedContent.length);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/artifacts/files/{path} measures content when upstream underreports byteSize", async () => {
  const runStore = createRunStore();
  const oversizedContent = "A".repeat(2048);
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    artifactFile: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        path: "logs/studio/comparison.log",
        content: oversizedContent,
        sha256: "a".repeat(64),
        byteSize: 1,
        mimeType: "text/plain",
        uri: "urn:c2c/artifact/1",
        kind: "trajectory-ledger",
      },
    },
  });
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      artifactContentMaxBytes: 1024,
    },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts/files/logs/studio/comparison.log`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 413);
    const body = response.body as {
      error: string;
      limit: number;
      byteSize: number;
    };
    assert.equal(body.error, "artifact_too_large");
    assert.equal(body.limit, 1024);
    assert.equal(body.byteSize, oversizedContent.length);
  } finally {
    await server.close();
  }
});

test("transform 502 response carries a UI-safe failureCode and never leaks orchestrator URL", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const failingOrchestrator: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      throw new Error(
        "connect ECONNREFUSED 127.0.0.1:18088 to http://orchestrator.internal:18088/v0/runs",
      );
    },
    async getRun() {
      return undefined;
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      return undefined;
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: failingOrchestrator,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: { sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n" },
    });
    assert.equal(response.status, 502);
    const body = response.body as { error: string; failureCode: string };
    assert.equal(body.failureCode, "service_unavailable");
    assert.ok(
      !body.error.includes("http://orchestrator"),
      `error must not leak upstream url: ${body.error}`,
    );
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("concurrent /api/v0/runs/{runId} polls produce a deterministic final cached W0.2 snapshot", async () => {
  // Issue #172 follow-up: every poll of /api/v0/runs/{runId} also fetches
  // the workflow contract and writes it back into the run store. The Node
  // event loop is single-threaded but async tasks can interleave: while
  // one poll awaits the upstream response, another poll can start. This
  // test fires multiple concurrent polls against a stub orchestrator that
  // returns a stable contract under artificial delay, and asserts that
  // every cached field on the run store matches the upstream snapshot
  // when all polls settle — i.e. there is no torn write.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  let workflowCallCount = 0;
  const failureCode = "java_compile_failed";
  const contract = {
    currentState: "final_classification",
    activeStep: "verification_repair_agent",
    agentAttemptCount: 3,
    repairBudget: { limit: 2, used: 2, remaining: 0 },
    repairAttempts: [
      {
        attemptNumber: 1,
        repairDecision: "propose_candidate",
        createdAt: "2026-05-16T12:00:00Z",
      },
      {
        attemptNumber: 2,
        repairDecision: "no_change",
        createdAt: "2026-05-16T12:01:00Z",
      },
    ],
    finalClassification: "blocked",
    failureCode,
    failureMessage: "compile error",
  };
  const orch: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return {
        status: 201,
        body: { run: { runId: "live-run-1", status: "updating" } },
      };
    },
    async startTransformRun() {
      return undefined;
    },
    async getRun() {
      // tiny delay so concurrent polls interleave around it
      await new Promise((r) => setTimeout(r, 1));
      return {
        status: 200,
        body: {
          runId: "live-run-1",
          status: "completed",
          message: "orchestrator completed",
        },
      };
    },
    async getArtifacts() {
      return undefined;
    },
    async getGenerated() {
      return undefined;
    },
    async getGeneratedFiles() {
      return undefined;
    },
    async getGeneratedFile() {
      return undefined;
    },
    async getArtifactFile() {
      return undefined;
    },
    async getBuildTest() {
      return undefined;
    },
    async getEvidence() {
      return undefined;
    },
    async getEvents() {
      return undefined;
    },
    async getProgress() {
      return undefined;
    },
    async getLearning() {
      return undefined;
    },
    async getWorkflow() {
      workflowCallCount += 1;
      // jitter to maximize interleave between concurrent polls
      await new Promise((r) => setTimeout(r, 1 + (workflowCallCount % 3)));
      return {
        status: 200,
        body: { status: "complete", source: "live", contract },
      };
    },
    async getTraceability() {
      return undefined;
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    // Fire 12 concurrent polls. Each one runs getRun -> applyLiveRunPayload
    // -> fetchWorkflowSnapshot -> applyWorkflowSnapshotToStore. The final
    // cached state must reflect the upstream contract exactly, with no
    // half-applied patch.
    const polls = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}`, {
          headers: auth.headers,
        }),
      ),
    );
    for (const poll of polls) {
      const body = poll.body as {
        activeStep: string;
        agentAttemptCount: number;
        repairBudget: { limit: number; used: number; remaining: number };
        finalClassification: string;
        failureCode: string;
      };
      assert.equal(body.activeStep, "verification_repair_agent");
      assert.equal(body.agentAttemptCount, 3);
      assert.deepEqual(body.repairBudget, { limit: 2, used: 2, remaining: 0 });
      assert.equal(body.finalClassification, "blocked");
      assert.equal(body.failureCode, failureCode);
    }
    // Each poll triggered exactly one workflow fetch.
    assert.equal(workflowCallCount, 12);
    // The run store retains the latest snapshot deterministically.
    const stored = runStore.get(startedBody.runId);
    assert.ok(stored);
    assert.equal(stored?.activeStep, "verification_repair_agent");
    assert.equal(stored?.agentAttemptCount, 3);
    assert.deepEqual(stored?.repairBudget, { limit: 2, used: 2, remaining: 0 });
    assert.equal(stored?.finalClassification, "blocked");
    assert.equal(stored?.failureCode, failureCode);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// W0.3-5 (#216) — Budget hardening: assist + model invocation budgets and the
// ``assist_budget_exhausted`` reason code surfacing through the BFF envelope.
// ---------------------------------------------------------------------------

test("GET /api/v0/runs/{runId}/workflow surfaces the W0.3-5 assist + model invocation budgets", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "transformation_agent_invoked",
          activeStep: "transformation-agent",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 2, remaining: 4 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
        contractRef: null,
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    assert.equal(workflow.status, 200);
    const body = workflow.body as {
      repairBudget: { limit: number; used: number; remaining: number };
      assistBudget: { limit: number; used: number; remaining: number };
      modelInvocationBudget: { limit: number; used: number; remaining: number };
    };
    assert.deepEqual(body.repairBudget, { limit: 2, used: 0, remaining: 2 });
    assert.deepEqual(body.assistBudget, { limit: 1, used: 1, remaining: 0 });
    assert.deepEqual(body.modelInvocationBudget, {
      limit: 6,
      used: 2,
      remaining: 4,
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow rejects malformed budget shapes", async () => {
  // The BFF must drop budgets whose limit/used/remaining are missing or
  // negative so the UI never renders a corrupt {limit: NaN} budget.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "transformation_agent_invoked",
          activeStep: "transformation-agent",
          agentAttemptCount: 0,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          assistBudget: { limit: -1, used: 0, remaining: 0 },
          modelInvocationBudget: { limit: "six", used: 0, remaining: 6 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
        contractRef: null,
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const body = workflow.body as {
      assistBudget: unknown;
      modelInvocationBudget: unknown;
    };
    assert.equal(body.assistBudget, null, "negative limit must be dropped");
    assert.equal(
      body.modelInvocationBudget,
      null,
      "non-numeric limit must be dropped",
    );
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/workflow accepts the assist_budget_exhausted reason code", async () => {
  // Issue #216 adds ``assist_budget_exhausted`` to the closed reason-code
  // set. The BFF must pass it through unchanged so the UI can render the
  // hard-termination signal causally.
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "baseline_generation_attempted",
          activeStep: "assist-decision",
          agentAttemptCount: 0,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 0, remaining: 6 },
          repairAttempts: [],
          assistDecision: {
            outcome: "assist_not_required",
            reasonCode: "assist_budget_exhausted",
            decidedAt: "2026-05-17T12:00:00Z",
            selectedAgentRole: null,
            affectedArtifactRefs: [],
            repairBudgetSnapshot: { limit: 2, used: 0, remaining: 2 },
            assistBudgetSnapshot: { limit: 1, used: 1, remaining: 0 },
            modelInvocationBudgetSnapshot: { limit: 6, used: 0, remaining: 6 },
            rationale: "caller opted in but assist budget exhausted",
          },
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
        contractRef: null,
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const body = workflow.body as {
      assistDecision: Record<string, unknown> | null;
    };
    assert.ok(body.assistDecision);
    assert.equal(body.assistDecision.outcome, "assist_not_required");
    assert.equal(body.assistDecision.reasonCode, "assist_budget_exhausted");
    assert.equal(body.assistDecision.selectedAgentRole, null);
    assert.deepEqual(body.assistDecision.assistBudgetSnapshot, {
      limit: 1,
      used: 1,
      remaining: 0,
    });
    assert.deepEqual(body.assistDecision.modelInvocationBudgetSnapshot, {
      limit: 6,
      used: 0,
      remaining: 6,
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId} surfaces the W0.3-5 budgets on the run summary", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "transformation_agent_invoked",
          activeStep: "transformation-agent",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 1, remaining: 5 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    // Drive the workflow fetch so the BFF caches the budgets on the run.
    await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
      { headers: auth.headers },
    );
    const summary = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    const body = summary.body as {
      assistBudget: { limit: number; used: number; remaining: number };
      modelInvocationBudget: { limit: number; used: number; remaining: number };
    };
    assert.deepEqual(body.assistBudget, { limit: 1, used: 1, remaining: 0 });
    assert.deepEqual(body.modelInvocationBudget, {
      limit: 6,
      used: 1,
      remaining: 5,
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-6 (#248): GET /api/v0/runs/{runId}/traceability
// ---------------------------------------------------------------------------

test("GET /api/v0/runs/{runId}/traceability returns the traceability envelope on happy path", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const traceabilityBody = {
    schemaVersion: "v0",
    runId: "live-run-1",
    programId: "CASE01",
    trace: {
      irId: "ir-CASE01",
      files: { "src/main/java/Foo.java": ["s-move-1"] },
    },
    irSymbolMap: { "s-move-1": { cobolFile: "CASE01.cbl", cobolLine: 42 } },
    javaRegionClassification: {
      "src/main/java/Foo.java": [
        {
          schemaVersion: "v0",
          lineRange: { startLine: 10, endLine: 15 },
          originClass: "deterministic",
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
        {
          schemaVersion: "v1",
          lineRange: { startLine: 16, endLine: 20 },
          originClass: "future_origin",
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
        {
          schemaVersion: "v0",
          lineRange: { startLine: 21, endLine: 20 },
          originClass: "agent_proposed",
          verificationOutcome: "oracle_failed",
          mappingClass: "agent_originated",
        },
      ],
      constructor: [
        {
          schemaVersion: "v0",
          lineRange: { startLine: 1, endLine: 1 },
          originClass: "deterministic",
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
      ],
    },
  };
  const { client: orch, calls } = stubOrchestrator({
    traceability: { status: 200, body: traceabilityBody },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
      { headers: auth.headers },
    );
    assert.equal(result.status, 200);
    const body = result.body as {
      schemaVersion: string;
      runId: string;
      programId: string;
      trace: Record<string, unknown> | null;
      irSymbolMap: Record<string, { cobolFile: string; cobolLine: number }>;
      javaRegionClassification: Record<
        string,
        Array<{
          schemaVersion: string;
          lineRange: { startLine: number; endLine: number };
          originClass: string;
          verificationOutcome: string;
          mappingClass: string;
        }>
      > | null;
    };
    assert.equal(body.schemaVersion, "v0");
    assert.equal(calls.getTraceability, 1);
    assert.deepEqual(body.irSymbolMap["s-move-1"], {
      cobolFile: "CASE01.cbl",
      cobolLine: 42,
    });
    assert.ok(body.javaRegionClassification !== null);
    const jrc = body.javaRegionClassification!["src/main/java/Foo.java"];
    assert.ok(Array.isArray(jrc) && jrc.length === 1);
    assert.equal(jrc[0]?.schemaVersion, "v0");
    assert.deepEqual(jrc[0]?.lineRange, { startLine: 10, endLine: 15 });
    assert.equal(jrc[0]?.originClass, "deterministic");
    assert.equal(jrc[0]?.verificationOutcome, "oracle_passed");
    assert.equal(jrc[0]?.mappingClass, "direct");

    const summary = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    const summaryBody = summary.body as {
      schemaVersion?: string;
      javaRegionClassification: Record<string, unknown[]> | null;
    };
    assert.equal(summaryBody.schemaVersion, "v0");
    assert.deepEqual(summaryBody.javaRegionClassification, {
      "src/main/java/Foo.java": [jrc[0]],
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/traceability preserves cached classifications across upstream outages", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const classification = {
    schemaVersion: "v0",
    lineRange: { startLine: 10, endLine: 15 },
    originClass: "deterministic",
    verificationOutcome: "oracle_passed",
    mappingClass: "direct",
  };
  const artifactResponses: ArtifactStubResponses = {
    traceability: {
      status: 200,
      body: {
        schemaVersion: "v0",
        runId: "live-run-1",
        programId: "CASE01",
        trace: null,
        irSymbolMap: {},
        javaRegionClassification: {
          "src/main/java/Foo.java": [classification],
        },
      },
    },
  };
  const { client: orch } = stubOrchestrator(artifactResponses);
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
      { headers: auth.headers },
    );
    artifactResponses.traceability = {
      status: 503,
      body: { error: "traceability temporarily unavailable" },
    };
    const outage = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
      { headers: auth.headers },
    );
    const outageBody = outage.body as {
      javaRegionClassification: unknown;
      note?: string;
    };
    assert.equal(outage.status, 200);
    assert.equal(outageBody.javaRegionClassification, null);
    assert.equal(
      outageBody.note,
      "Traceability upstream returned 503; traceability cannot be served.",
    );

    const summary = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    const summaryBody = summary.body as {
      javaRegionClassification: Record<string, unknown[]> | null;
    };
    assert.deepEqual(summaryBody.javaRegionClassification, {
      "src/main/java/Foo.java": [{ ...classification, schemaVersion: "v0" }],
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/traceability reports request failures distinctly", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator();
  const throwingOrchestrator: OrchestratorClient = {
    ...orch,
    async getTraceability() {
      throw new Error("upstream network failure");
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: throwingOrchestrator,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
      { headers: auth.headers },
    );
    const body = result.body as {
      javaRegionClassification: unknown;
      note?: string;
    };
    assert.equal(result.status, 200);
    assert.equal(body.javaRegionClassification, null);
    assert.equal(
      body.note,
      "Traceability upstream request failed; traceability cannot be served.",
    );
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/traceability returns 404 for unknown run", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/does-not-exist/traceability`,
      { headers: auth.headers },
    );
    assert.equal(result.status, 404);
    const body = result.body as { error: string };
    assert.ok(
      body.error.includes("unknown runId"),
      `expected "unknown runId" in error, got: ${body.error}`,
    );
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/traceability returns stub envelope for diagnostic-fixture run", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  // diagnostic-fixture mode requires a disabled orchestrator (no orchestratorUrl)
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string; mode: string };
    assert.equal(startedBody.mode, "diagnostic-fixture");

    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
      { headers: auth.headers },
    );
    assert.equal(result.status, 200);
    const body = result.body as {
      schemaVersion: string;
      trace: unknown;
      irSymbolMap: Record<string, unknown>;
      javaRegionClassification: unknown;
    };
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.trace, null);
    assert.deepEqual(body.irSymbolMap, {});
    assert.equal(body.javaRegionClassification, null);
    // diagnostic-fixture runs must not proxy to the orchestrator (getTraceability === 0
    // is verified structurally: disabledOrchestrator has enabled:false so the route
    // returns the stub envelope directly without calling getTraceability).
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-13 (#255): POST /api/v0/generate
// ---------------------------------------------------------------------------

function stubBuildTestRunner(
  verificationResponse?: UpstreamResponse,
): BuildTestRunnerClient {
  return {
    enabled: true,
    async formatJava() {
      return undefined;
    },
    async runVerification() {
      return verificationResponse;
    },
  };
}

function disabledBuildTestRunner(): BuildTestRunnerClient {
  return {
    enabled: false,
    async formatJava() {
      return undefined;
    },
    async runVerification() {
      return undefined;
    },
  };
}

test("POST /api/v0/generate returns 400 when sourceText is missing", async () => {
  const runStore = createRunStore();
  const { client: orch } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "HELLO01" },
    });
    assert.equal(response.status, 400);
    assert.ok(
      (response.body as { error: string }).error.includes("sourceText"),
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/generate returns 413 when body is too large", async () => {
  const runStore = createRunStore();
  const { client: orch } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      orchestratorUrl: "http://upstream",
      transformSourceMaxBytes: 10,
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
      },
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/generate happy path returns 201 with runMode=generate", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        useTransformationAgent: false,
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    const body = response.body as { runMode: string; runId: string };
    assert.equal(body.runMode, "generate");
    assert.ok(typeof body.runId === "string" && body.runId.length > 0);
    // Studio-IDE-13 (#255) AC1: /api/v0/generate forwards generateOnly:
    // true so the orchestrator short-circuits after generate-java and
    // does NOT run build/test/oracle for this user-initiated generator-
    // only action. Pinning this here protects against accidental
    // regressions in the BFF→orchestrator payload mapping.
    assert.equal(calls.startTransformRun[0]?.generateOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform does NOT forward generateOnly to the orchestrator", async () => {
  // Companion to the /generate happy-path assertion above: the legacy
  // composed Generate & Verify path must preserve its full pipeline by
  // never setting the generateOnly flag. If a future refactor reuses
  // /generate validation for /transform, this assertion fires.
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        useTransformationAgent: false,
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    // The composed pipeline relies on the absence of generateOnly so
    // build-test, repair, and evidence-write all run as today.
    assert.equal(calls.startTransformRun[0]?.generateOnly, undefined);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/generate returns 503 when orchestrator is not configured", async () => {
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
      headers: auth.headers,
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
      },
    });
    assert.equal(response.status, 503);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-13 (#255): POST /api/v0/compile-check
// ---------------------------------------------------------------------------

test("Java editor execution routes reject unauthenticated or cross-origin requests before upstream work", async () => {
  let upstreamCalls = 0;
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: {
      enabled: true,
      async formatJava() {
        upstreamCalls += 1;
        return {
          status: 200,
          body: { schemaVersion: "v0", formattedContent: "class Pwn {}" },
        };
      },
      async runVerification() {
        upstreamCalls += 1;
        return {
          status: 200,
          body: {
            status: "success",
            classification: "success",
            diagnostics: [],
          },
        };
      },
    },
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const noCookie = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
      body: {
        runId: "run-1",
        javaFiles: [{ path: "Pwn.java", content: "class Pwn {}" }],
      },
    });
    assert.equal(noCookie.status, 401);

    const badOrigin = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post(
        { javaFiles: [{ path: "Pwn.java", content: "class Pwn {}" }] },
        { origin: "http://evil.example" },
      ),
    );
    assert.equal(badOrigin.status, 403);

    const textPlain = await fetch(`${server.baseUrl}/api/v0/format/java`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: auth.post({}).headers.cookie ?? "",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ content: "class Pwn {}" }),
    });
    assert.equal(textPlain.status, 415);
    assert.equal(upstreamCalls, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 400 when javaFiles is missing", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({ runId: "r1" }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 400 when javaFiles is empty array", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({ javaFiles: [] }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 400 when javaFiles entry has no path", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({ javaFiles: [{ path: "", content: "class Foo {}" }] }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("path"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check rejects unsafe javaFiles paths before upstream work", async () => {
  const auth = createRouteAuth();
  let upstreamCalls = 0;
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: {
      enabled: true,
      async formatJava() {
        return undefined;
      },
      async runVerification() {
        upstreamCalls += 1;
        return { status: 200, body: { status: "success", diagnostics: [] } };
      },
    },
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    for (const path of [
      "../Pwn.java",
      "/tmp/Pwn.java",
      String.raw`\tmp\Pwn.java`,
      "C:\\tmp\\Pwn.java",
      String.raw`\\server\share\Foo.java`,
      String.raw`\\?\C:\tmp\Foo.java`,
      "file:/tmp/Pwn.java",
      "https://internal.example/Pwn.java",
    ]) {
      const response = await fetchJson(
        `${server.baseUrl}/api/v0/compile-check`,
        auth.post({ javaFiles: [{ path, content: "class Pwn {}" }] }),
      );
      assert.equal(response.status, 400);
      assert.ok(
        (response.body as { error: string }).error.includes("safe relative"),
      );
    }
    for (const entryFilePath of ["../Pwn.java", "Missing.java"]) {
      const response = await fetchJson(
        `${server.baseUrl}/api/v0/compile-check`,
        auth.post({
          javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
          entryFilePath,
        }),
      );
      assert.equal(response.status, 400);
      assert.ok(
        (response.body as { error: string }).error.includes("entryFilePath"),
      );
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check rejects non-Java, duplicate, and excessive file lists before upstream work", async () => {
  const auth = createRouteAuth();
  let upstreamCalls = 0;
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: {
      enabled: true,
      async formatJava() {
        return undefined;
      },
      async runVerification() {
        upstreamCalls += 1;
        return { status: 200, body: { status: "success", diagnostics: [] } };
      },
    },
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const nonJava = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({ javaFiles: [{ path: "pom.xml", content: "<project />" }] }),
    );
    assert.equal(nonJava.status, 400);
    assert.match((nonJava.body as { error: string }).error, /\.java/);

    const duplicate = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: [
          { path: "Foo.java", content: "class Foo {}" },
          { path: "Foo.java", content: "class Foo {}" },
        ],
      }),
    );
    assert.equal(duplicate.status, 400);
    assert.match((duplicate.body as { error: string }).error, /unique/);

    const tooMany = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: Array.from({ length: 513 }, (_, idx) => ({
          path: `Foo${idx}.java`,
          content: "",
        })),
      }),
    );
    assert.equal(tooMany.status, 413);
    assert.equal(upstreamCalls, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 413 when total content exceeds cap", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, transformSourceMaxBytes: 10 },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: [
          { path: "Foo.java", content: "class Foo { /* large content */ }" },
        ],
      }),
    );
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check happy path returns 200 with diagnostics", async () => {
  const auth = createRouteAuth();
  const upstreamBody = {
    status: "build_failed",
    diagnostics: [
      {
        severity: "error",
        code: "compiler.err.cant.resolve.sym",
        message: "cannot find symbol",
        line: 3,
        column: 5,
        filePath: "Foo.java",
        sourceKind: "build",
      },
    ],
  };
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({ status: 200, body: upstreamBody }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      schemaVersion: string;
      diagnostics: Array<{
        severity: string;
        code: string;
        message: string;
        sourceKind: string;
      }>;
    };
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.diagnostics.length, 1);
    assert.equal(body.diagnostics[0]?.severity, "error");
    assert.equal(body.diagnostics[0]?.sourceKind, "build");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 503 when build-test-runner is not configured", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: disabledBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 503);
    assert.ok(
      (response.body as { error: string }).error.includes(
        "build-test-runner-service URL is not configured",
      ),
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 503 when build-test-runner returns 5xx", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({
      status: 500,
      body: { error: "internal error" },
    }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/compile-check`,
      auth.post({
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(
      (response.body as { failureCode: string }).failureCode,
      "service_unavailable",
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// #360: POST /api/v0/manual-compile-repair/*
// Issue #361 extends this same compatibility lane to generalized
// manual diagnosis/repair payloads, including runtime/parity failures.
// ---------------------------------------------------------------------------

test("POST /api/v0/manual-compile-repair routes forward the Studio requester and preserve the upstream payloads", async () => {
  const auth = createRouteAuth();
  const currentJavaFile = {
    path: "src/main/java/com/c2c/generated/CASE01.java",
    content: "package com.c2c.generated;\npublic class CASE01 {}\n",
  };
  const previewResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    preview: {
      schemaVersion: "v0",
      previewId: "preview-1",
      runId: "run-1",
      workflowId: "w0-migration-v0",
      failureCategory: "oracle_mismatch",
      sourceRevisionRef: {
        uri: "urn:preview/run-1/source",
        sha256: "0".repeat(64),
        byteSize: 64,
        kind: "generated-project-manifest",
      },
      currentHeadRef: {
        uri: "urn:preview/run-1/head",
        sha256: "1".repeat(64),
        byteSize: 64,
        kind: "manual-compile-repair-snapshot",
      },
      buildTestResultRef: {
        uri: "urn:preview/run-1/build-test",
        sha256: "2".repeat(64),
        byteSize: 64,
        kind: "build-test-result",
      },
      includedFiles: [
        {
          path: currentJavaFile.path,
          sha256: "3".repeat(64),
          byteSize: currentJavaFile.content.length,
          role: "entry-file",
        },
      ],
      diagnostics: [
        {
          severity: "error",
          code: "cannot-find-symbol",
          message: "cannot find symbol",
          filePath: currentJavaFile.path,
          line: 2,
        },
      ],
      manualRegions: [
        {
          filePath: currentJavaFile.path,
          originClass: "manual_modified",
          startLine: 1,
          endLine: 2,
        },
        {
          filePath: currentJavaFile.path,
          originClass: "manual_edit",
          startLine: 3,
          endLine: 4,
        },
      ],
      constraints: {
        reviewRequiredBeforeAgentStart: true,
      },
      exclusionSummary: {
        excludedJavaFileCount: 0,
        excludedDiagnosticCount: 0,
        redactionsApplied: true,
      },
    },
  };
  const diagnoseResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    diagnosis: {
      diagnosisId: "run-1-runtime-diagnosis",
      workflowId: "w0-migration-v0",
      buildResultRef: {
        uri: "urn:diagnosis/run-1/build-result",
        sha256: "1".repeat(64),
        byteSize: 128,
        kind: "parity-build-result",
      },
      executionResultRef: {
        uri: "urn:diagnosis/run-1/execution-result",
        sha256: "2".repeat(64),
        byteSize: 96,
        kind: "parity-execution-result",
      },
      comparisonResultRef: {
        uri: "urn:diagnosis/run-1/comparison-result",
        sha256: "3".repeat(64),
        byteSize: 80,
        kind: "parity-comparison-result",
      },
      failureClass: "runtime_failure",
      scopeClass: "generated_code",
      likelyRootCause: "runtime output diverges from the reference execution",
      summary:
        "Parity comparison failed after the generated Java execution completed.",
      confidence: {
        level: "high",
        basis:
          "The orchestrator observed both runtime output and parity mismatch artifacts.",
      },
      recommendedNextAction: "repair_generated_code",
      evidenceRefs: [
        {
          uri: "urn:diagnosis/run-1/evidence",
          sha256: "4".repeat(64),
          byteSize: 64,
          kind: "repair-diagnosis-evidence",
        },
      ],
      createdAt: "2026-05-15T10:00:00Z",
    },
    proposal: {
      proposalId: "proposal-1",
      patchSha256: "a".repeat(64),
      applicationState: "review_pending",
      approvalState: "pending",
    },
    candidateProject: {
      entryClass: "CASE01",
      entryFilePath: currentJavaFile.path,
      files: {
        [currentJavaFile.path]: currentJavaFile.content,
      },
    },
    buildTest: {
      status: "failed",
      reason: "compile_failed",
    },
  };
  const applyResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    proposal: {
      ...diagnoseResponse.proposal,
      applicationState: "sandbox_applied",
      approvalState: "pending",
    },
    candidateProject: diagnoseResponse.candidateProject,
    buildTest: {
      status: "ok",
      outputRef: { uri: "urn:build-output/run-1" },
    },
  };
  const acceptResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    proposal: {
      ...diagnoseResponse.proposal,
      applicationState: "applied",
      approvalState: "approved",
    },
    candidateProject: diagnoseResponse.candidateProject,
    buildTest: {
      status: "ok",
      outputRef: { uri: "urn:build-output/run-1" },
    },
  };
  const rejectResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    proposal: {
      ...diagnoseResponse.proposal,
      applicationState: "rejected",
      approvalState: "rejected",
    },
  };
  const { client: orch, calls } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: previewResponse },
      diagnose: { status: 200, body: diagnoseResponse },
      apply: { status: 200, body: applyResponse },
      accept: { status: 200, body: acceptResponse },
      reject: { status: 200, body: rejectResponse },
    },
  });
  const runStore = createRunStore();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    // The BFF-local runId and the Orchestrator-assigned liveRunId must differ
    // so assertions below are meaningful — a regression to BFF-local id would be caught.
    assert.notEqual(startedBody.runId, "live-run-1");
    const preview = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/preview`,
      auth.post({
        runId: startedBody.runId,
        entryClass: "CASE01",
        entryFilePath: currentJavaFile.path,
        javaFiles: [currentJavaFile],
        manualEditOverlays: [
          {
            regions: [
              {
                filePath: currentJavaFile.path,
                originClass: "manual_modified",
                startLine: 1,
                endLine: 2,
              },
            ],
          },
          {
            regions: [
              {
                filePath: currentJavaFile.path,
                originClass: "manual_edit",
                startLine: 3,
                endLine: 4,
              },
            ],
          },
        ],
      }),
    );
    assert.equal(preview.status, 200);
    assert.equal(calls.manualCompileRepair.preview.length, 1);
    const previewCall = calls.manualCompileRepair.preview[0];
    assert.equal(previewCall?.runId, "live-run-1");
    assert.deepEqual(
      (previewCall?.payload as { manualOverlay: unknown; requester: string })
        .manualOverlay,
      {
        schemaVersion: "v0",
        regions: [
          {
            filePath: currentJavaFile.path,
            originClass: "manual_modified",
            startLine: 1,
            endLine: 2,
          },
          {
            filePath: currentJavaFile.path,
            originClass: "manual_edit",
            startLine: 3,
            endLine: 4,
          },
        ],
      },
    );
    assert.equal(
      (previewCall?.payload as { requester: string }).requester,
      "studio:tenant-a:user-a",
    );

    const previewBody = preview.body as {
      schemaVersion: string;
      preview: { previewId: string };
    };
    assert.equal(previewBody.schemaVersion, "v0");

    const diagnose = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/diagnose`,
      auth.post({
        runId: startedBody.runId,
        previewId: previewBody.preview.previewId,
      }),
    );
    assert.equal(diagnose.status, 200);
    const diagnoseBody = diagnose.body as {
      schemaVersion: string;
      diagnosis: {
        failureClass?: string;
        scopeClass?: string;
        executionResultRef?: { sha256: string; kind?: string };
        comparisonResultRef?: { sha256: string; kind?: string };
        recommendedNextAction?: string;
      };
      proposal: { proposalId: string };
      candidateProject: {
        entryClass: string;
        entryFilePath: string;
        files: Record<string, string>;
      };
    };
    assert.equal(diagnoseBody.schemaVersion, "v0");
    assert.equal(calls.manualCompileRepair.diagnose.length, 1);
    const diagnoseCall = calls.manualCompileRepair.diagnose[0];
    assert.equal(diagnoseCall?.runId, "live-run-1");
    assert.deepEqual(diagnoseCall?.payload, {
      runId: startedBody.runId,
      previewId: "preview-1",
      requester: "studio:tenant-a:user-a",
    });
    assert.equal(diagnoseBody.proposal.proposalId, "proposal-1");
    assert.equal(diagnoseBody.diagnosis.failureClass, "runtime_failure");
    assert.equal(diagnoseBody.diagnosis.scopeClass, "generated_code");
    assert.equal(
      diagnoseBody.diagnosis.executionResultRef?.sha256,
      "2".repeat(64),
    );
    assert.equal(
      diagnoseBody.diagnosis.comparisonResultRef?.sha256,
      "3".repeat(64),
    );
    assert.equal(
      diagnoseBody.diagnosis.recommendedNextAction,
      "repair_generated_code",
    );

    const reject = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/reject`,
      auth.post({
        runId: startedBody.runId,
        proposalId: diagnoseBody.proposal.proposalId,
      }),
    );
    assert.equal(reject.status, 200);
    assert.equal(calls.manualCompileRepair.reject.length, 1);
    assert.equal(calls.manualCompileRepair.reject[0]?.runId, "live-run-1");
    assert.deepEqual(calls.manualCompileRepair.reject[0]?.payload, {
      runId: startedBody.runId,
      proposalId: "proposal-1",
      requester: "studio:tenant-a:user-a",
    });
    assert.equal(
      (calls.manualCompileRepair.reject[0]?.payload as { requester: string })
        .requester,
      "studio:tenant-a:user-a",
    );

    const apply = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/apply`,
      auth.post({
        runId: startedBody.runId,
        previewId: previewBody.preview.previewId,
        proposalId: diagnoseBody.proposal.proposalId,
        patchSha256: "a".repeat(64),
      }),
    );
    assert.equal(apply.status, 200);
    assert.equal(calls.manualCompileRepair.apply.length, 1);
    assert.equal(calls.manualCompileRepair.apply[0]?.runId, "live-run-1");
    assert.deepEqual(calls.manualCompileRepair.apply[0]?.payload, {
      runId: startedBody.runId,
      previewId: "preview-1",
      proposalId: "proposal-1",
      patchSha256: "a".repeat(64),
      requester: "studio:tenant-a:user-a",
    });
    assert.equal(
      (calls.manualCompileRepair.apply[0]?.payload as { requester: string })
        .requester,
      "studio:tenant-a:user-a",
    );

    const accept = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/accept`,
      auth.post({
        runId: startedBody.runId,
        proposalId: diagnoseBody.proposal.proposalId,
        patchSha256: "a".repeat(64),
      }),
    );
    assert.equal(accept.status, 200);
    assert.equal(calls.manualCompileRepair.accept.length, 1);
    assert.equal(calls.manualCompileRepair.accept[0]?.runId, "live-run-1");
    assert.deepEqual(calls.manualCompileRepair.accept[0]?.payload, {
      runId: startedBody.runId,
      proposalId: "proposal-1",
      patchSha256: "a".repeat(64),
      requester: "studio:tenant-a:user-a",
    });

    const invalidDiagnose = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/diagnose`,
      auth.post({
        runId: startedBody.runId,
        previewId: "preview-1",
        buildTestContext: { status: "forbidden" },
      }),
    );
    assert.equal(invalidDiagnose.status, 400);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// #360: manual-compile-repair edge-case coverage
// ---------------------------------------------------------------------------

test("POST /api/v0/manual-compile-repair/diagnose returns 400 when runId is missing", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/diagnose`,
      auth.post({ previewId: "preview-1" }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("runId"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/reject returns 200 with valid stub", async () => {
  const rejectResponse = {
    schemaVersion: "v0",
    runId: "run-1",
    proposal: {
      proposalId: "proposal-1",
      runId: "run-1",
      files: [],
      applicationState: "rejected",
      approvalState: "rejected",
    },
  };
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: rejectResponse },
    },
  });
  const runStore = createRunStore();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/reject`,
      auth.post({ runId: startedBody.runId, proposalId: "proposal-1" }),
    );
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test(`POST /api/v0/manual-compile-repair/preview returns 413 when javaFiles exceeds ${JAVA_EXECUTION_MAX_FILES} entries`, async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const runStore = createRunStore();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const javaFiles = Array.from(
      { length: JAVA_EXECUTION_MAX_FILES + 1 },
      (_, i) => ({
        path: `src/main/java/com/c2c/generated/File${i}.java`,
        content: `class File${i} {}`,
      }),
    );
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/preview`,
      auth.post({
        runId: startedBody.runId,
        entryFilePath: "src/main/java/com/c2c/generated/File0.java",
        javaFiles,
      }),
    );
    assert.equal(response.status, 413);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// #366: manual-compile-repair unknown-runId → 404
// ---------------------------------------------------------------------------

test("POST /api/v0/manual-compile-repair/preview returns 404 when runId is not in runStore", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/preview`,
      auth.post({ runId: "unknown-run", entryClass: "CASE01" }),
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/diagnose returns 404 when runId is not in runStore", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/diagnose`,
      auth.post({ runId: "unknown-run", previewId: "preview-1" }),
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/apply returns 404 when runId is not in runStore", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/apply`,
      auth.post({
        runId: "unknown-run",
        previewId: "preview-1",
        proposalId: "proposal-1",
        patchSha256: "a".repeat(64),
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/accept returns 404 when runId is not in runStore", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/accept`,
      auth.post({
        runId: "unknown-run",
        proposalId: "proposal-1",
        patchSha256: "a".repeat(64),
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/reject returns 404 when runId is not in runStore", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/reject`,
      auth.post({ runId: "unknown-run", proposalId: "proposal-1" }),
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/manual-compile-repair/preview returns 503 when run has no orchestrator liveRunId", async () => {
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    manualCompileRepair: {
      preview: { status: 200, body: {} },
      diagnose: { status: 200, body: {} },
      apply: { status: 200, body: {} },
      accept: { status: 200, body: {} },
      reject: { status: 200, body: {} },
    },
  });
  const runStore = createRunStore();
  // Seed a run with no liveRunId so liveArtifactRunId(stored) returns undefined.
  const seeded = runStore.create(FIXED_SAMPLE, "live");
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/manual-compile-repair/preview`,
      auth.post({ runId: seeded.runId, entryClass: "CASE01" }),
    );
    assert.equal(response.status, 503);
    assert.ok(
      (response.body as { error: string }).error.includes(
        "orchestrator run is not available",
      ),
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-13 (#255): POST /api/v0/verify
// ---------------------------------------------------------------------------

test("POST /api/v0/verify returns 400 when runId is missing", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({ javaFiles: [{ path: "Foo.java", content: "class Foo {}" }] }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("runId"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 400 when javaFiles is missing", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({ runId: "run-1" }),
    );
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify rejects unsafe javaFiles paths before upstream work", async () => {
  const auth = createRouteAuth();
  let upstreamCalls = 0;
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: {
      enabled: true,
      async formatJava() {
        return undefined;
      },
      async runVerification() {
        upstreamCalls += 1;
        return { status: 200, body: { status: "success", diagnostics: [] } };
      },
    },
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    for (const body of [
      {
        runId: "run-1",
        javaFiles: [{ path: "../../Pwn.java", content: "class Pwn {}" }],
        expectedError: "safe relative",
      },
      {
        runId: "run-1",
        javaFiles: [
          {
            path: String.raw`\\server\share\Foo.java`,
            content: "class Foo {}",
          },
        ],
        expectedError: "safe relative",
      },
      {
        runId: "run-1",
        javaFiles: [{ path: "file:/tmp/Pwn.java", content: "class Pwn {}" }],
        expectedError: "safe relative",
      },
      {
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
        entryFilePath: "/tmp/Foo.java",
        expectedError: "entryFilePath",
      },
      {
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
        entryFilePath: "Missing.java",
        expectedError: "entryFilePath",
      },
    ]) {
      const { expectedError, ...requestBody } = body;
      const response = await fetchJson(
        `${server.baseUrl}/api/v0/verify`,
        auth.post(requestBody),
      );
      assert.equal(response.status, 400);
      assert.ok(
        (response.body as { error: string }).error.includes(expectedError),
      );
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify rejects non-Java, duplicate, and excessive file lists before upstream work", async () => {
  const auth = createRouteAuth();
  let upstreamCalls = 0;
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: {
      enabled: true,
      async formatJava() {
        return undefined;
      },
      async runVerification() {
        upstreamCalls += 1;
        return { status: 200, body: { status: "success", diagnostics: [] } };
      },
    },
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const nonJava = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: [{ path: "manifest.json", content: "{}" }],
      }),
    );
    assert.equal(nonJava.status, 400);
    assert.match((nonJava.body as { error: string }).error, /\.java/);

    const duplicate = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: [
          { path: "Foo.java", content: "class Foo {}" },
          { path: "Foo.java", content: "class Foo {}" },
        ],
      }),
    );
    assert.equal(duplicate.status, 400);
    assert.match((duplicate.body as { error: string }).error, /unique/);

    const tooMany = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: Array.from({ length: 513 }, (_, idx) => ({
          path: `Foo${idx}.java`,
          content: "",
        })),
      }),
    );
    assert.equal(tooMany.status, 413);
    assert.equal(upstreamCalls, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 413 when total content exceeds cap", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, transformSourceMaxBytes: 10 },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: [
          { path: "Foo.java", content: "class Foo { /* lots of content */ }" },
        ],
      }),
    );
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify happy path returns 200 with verify response shape", async () => {
  const auth = createRouteAuth();
  const upstreamBody = {
    status: "success",
    classification: "success",
    build: { status: "ok" },
    execution: { exitCode: 0 },
    tests: { total: 1, passed: 1, failed: 0 },
    goldenMaster: null,
    comparison: { match: true },
    diagnostics: [],
    outputRef: null,
  };
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({ status: 200, body: upstreamBody }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-abc",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      schemaVersion: string;
      runId: string;
      programId: string;
      status: string;
      classification: string;
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
      diagnostics: unknown[];
    };
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.runId, "run-abc");
    assert.equal(body.programId, "verify-run-abc");
    assert.equal(body.status, "success");
    assert.equal(body.classification, "success");
    assert.equal(body.manualEditsCarriedOver, false);
    assert.equal(body.manualDriftRegionCount, 0);
    assert.ok(Array.isArray(body.diagnostics));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 503 when build-test-runner is not configured", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: disabledBuildTestRunner(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 503);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 503 when build-test-runner returns 5xx", async () => {
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({
      status: 503,
      body: { error: "service down" },
    }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(
      (response.body as { failureCode: string }).failureCode,
      "service_unavailable",
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify stamps manualEditsCarriedOver and manualDriftRegionCount from overlay", async () => {
  const auth = createRouteAuth();
  const upstreamBody = {
    status: "success",
    classification: "success",
    diagnostics: [],
  };
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({ status: 200, body: upstreamBody }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-xyz",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
        manualEditOverlay: {
          schemaVersion: "v0",
          runId: "run-xyz",
          javaFile: "Foo.java",
          regions: [
            {
              lineRange: { startLine: 10, endLine: 12 },
              originClass: "manual_modified",
            },
            {
              lineRange: { startLine: 20, endLine: 25 },
              originClass: "manual_edit",
            },
            {
              lineRange: { startLine: 1, endLine: 9 },
              originClass: "deterministic",
            },
          ],
        },
      }),
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
    };
    assert.equal(body.manualEditsCarriedOver, true);
    assert.equal(body.manualDriftRegionCount, 2);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify aggregates manual drift across multi-file overlays", async () => {
  const auth = createRouteAuth();
  const upstreamBody = {
    status: "success",
    classification: "success",
    diagnostics: [],
  };
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner({ status: 200, body: upstreamBody }),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/verify`,
      auth.post({
        runId: "run-multi",
        javaFiles: [
          { path: "Foo.java", content: "class Foo {}" },
          { path: "Bar.java", content: "class Bar {}" },
        ],
        manualEditOverlays: [
          {
            schemaVersion: "v0",
            runId: "run-multi",
            javaFile: "Foo.java",
            regions: [
              {
                lineRange: { startLine: 1, endLine: 1 },
                originClass: "manual_modified",
              },
            ],
          },
          {
            schemaVersion: "v0",
            runId: "run-multi",
            javaFile: "Bar.java",
            regions: [
              {
                lineRange: { startLine: 2, endLine: 2 },
                originClass: "manual_edit",
              },
              {
                lineRange: { startLine: 3, endLine: 3 },
                originClass: "deterministic",
              },
            ],
          },
        ],
      }),
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      manualEditsCarriedOver: boolean;
      manualDriftRegionCount: number;
    };
    assert.equal(body.manualEditsCarriedOver, true);
    assert.equal(body.manualDriftRegionCount, 2);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-10 (#249): POST /api/v0/editor/explain + GET /api/v0/editor/budget
// ---------------------------------------------------------------------------

function explainGateway(
  response: UpstreamResponse | undefined,
  options: { enabled?: boolean; throwError?: Error } = {},
): {
  client: ModelGatewayClient;
  calls: Array<{ payload: unknown }>;
} {
  const calls: Array<{ payload: unknown }> = [];
  const enabled = options.enabled ?? true;
  const client: ModelGatewayClient = {
    enabled,
    async explain(payload) {
      calls.push({ payload });
      if (options.throwError) {
        throw options.throwError;
      }
      return response;
    },
    async getHealth() {
      return undefined;
    },
    async getModels() {
      return undefined;
    },
    async getCapabilities() {
      return undefined;
    },
  };
  return { client, calls };
}

function explainRequestBody(overrides: Record<string, unknown> = {}): unknown {
  const redacted = "MOVE WS-A TO WS-B.";
  const byteHash = createHash("sha256").update(redacted, "utf8").digest("hex");
  return {
    schemaVersion: "v0",
    sessionId: "studio-session-explain-1",
    tenantId: "tenant-a",
    userId: "user-a",
    runId: null,
    sourceHash: "a".repeat(64),
    region: {
      filePath: "src/cobol/HELLO.cbl",
      sourceKind: "cobol",
      startLine: 12,
      endLine: 18,
    },
    redactedBytes: redacted,
    byteHash,
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.0.0",
      matchedPatternIds: ["ssn-us"],
    },
    ...overrides,
  };
}

function createEditorAssistAuth(
  identity: { tenantId: string; userId: string } = {
    tenantId: "tenant-a",
    userId: "user-a",
  },
): {
  sessionStore: SessionStore;
  headers: Record<string, string>;
  sessionId: string;
} {
  const sessionStore = createSessionStore({ idleTimeoutMs: 0 });
  const record = sessionStore.create(identity);
  return {
    sessionStore,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${record.sessionId}` },
    sessionId: record.sessionId,
  };
}

function minimalEditorAssistLedgerEntry(): EditorAssistLedgerEntry {
  return {
    schemaVersion: "v0",
    kind: "editor_assist",
    ledgerEntryId: "eai-tenant-a-studio-session-1-1",
    invocationId: "mi-test",
    tenantId: "tenant-a",
    userId: "user-a",
    sessionId: "studio-session-1",
    requestSource: "editor",
    requestRegion: {
      filePath: "src/cobol/HELLO.cbl",
      sourceKind: "cobol",
      startLine: 1,
      endLine: 1,
      byteHash: `sha256:${"a".repeat(64)}`,
    },
    redactedFields: [],
    ledgerRef: "urn:c2c/editor-assist/tenant-a/studio-session-1/1",
    editorAssistRef: "eai-tenant-a-studio-session-1-1",
    budgetSnapshot: {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 1,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
    },
    startedAt: "2026-05-19T00:00:00.000Z",
    endedAt: "2026-05-19T00:00:01.000Z",
    status: "success",
    failureCode: null,
    runIdRef: null,
  };
}

test("POST /api/v0/editor/explain returns the success body and consumes one budget unit", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: {
      explanation: "MOVE moves bytes from WS-A to WS-B.",
      invocationId: "mi-explain-1",
      ledgerRef: "urn:ledger/explain/abc",
      redactedFields: ["customerName"],
    },
  });
  const ledger: Array<Record<string, unknown>> = [];
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistLedgerSink: (entry) =>
      ledger.push(entry as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const bodyWithoutClientIdentity = explainRequestBody();
    delete (bodyWithoutClientIdentity as Record<string, unknown>).tenantId;
    delete (bodyWithoutClientIdentity as Record<string, unknown>).userId;
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: bodyWithoutClientIdentity,
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.explanation, "MOVE moves bytes from WS-A to WS-B.");
    assert.equal(body.ledgerRef, "urn:ledger/explain/abc");
    assert.equal(
      typeof body.editorAssistRef === "string" &&
        (body.editorAssistRef as string).startsWith("eai-tenant-a-"),
      true,
    );
    assert.deepEqual(body.budgetSnapshot, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 1,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
    });
    const redaction = body.redactionApplied as string[];
    // Union of studio + gateway redactions, order-insensitive.
    assert.equal(redaction.includes("ssn-us"), true);
    assert.equal(redaction.includes("customerName"), true);
    assert.equal(calls.length, 1);
    const forwarded = calls[0]?.payload as Record<string, unknown>;
    assert.equal(forwarded.tenantId, "tenant-a");
    assert.equal(forwarded.userId, "user-a");
    assert.equal(ledger.length, 1);
    const entry = ledger[0] as Record<string, unknown>;
    assert.equal(entry.kind, "editor_assist");
    assert.equal(entry.status, "success");
    assert.equal(entry.tenantId, "tenant-a");
    assert.equal(entry.userId, "user-a");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain binds identity to the active session cookie", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: { explanation: "ok", invocationId: "mi-identity" },
  });
  const auth = createEditorAssistAuth();
  const ledger: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistLedgerSink: (entry) =>
      ledger.push(entry as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const mismatched = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ tenantId: "tenant-b" }),
      },
    );
    assert.equal(mismatched.status, 403);
    assert.equal(
      (mismatched.body as Record<string, unknown>).errorCode,
      "policy_denied",
    );
    assert.equal(calls.length, 0);
    assert.equal(ledger.length, 0);

    const missingCookie = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: explainRequestBody(),
      },
    );
    assert.equal(missingCookie.status, 403);
    assert.equal(
      (missingCookie.body as Record<string, unknown>).errorCode,
      "policy_denied",
    );
  } finally {
    await server.close();
  }
});

test("editor-assist routes reject credentialed requests from unlisted browser origins", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: { explanation: "should not be reached", invocationId: "mi-csrf" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  const maliciousHeaders = {
    ...auth.headers,
    Origin: "http://localhost:5173",
  };
  try {
    const explain = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      headers: maliciousHeaders,
      body: explainRequestBody({ sessionId: "origin-denied-session" }),
    });
    assert.equal(explain.status, 403);
    assert.equal(
      (explain.body as Record<string, unknown>).error,
      "origin not allowed",
    );
    assert.equal(calls.length, 0);

    const budget = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=origin-denied-session`,
      { headers: maliciousHeaders },
    );
    assert.equal(budget.status, 403);
    assert.equal(
      (budget.body as Record<string, unknown>).error,
      "origin not allowed",
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain persists the default JSONL ledger entry", async () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "c2c-bff-editor-ledger-"),
  );
  const ledgerPath = path.join(
    repoRoot,
    "var",
    "c2c-local",
    "trajectory-ledger",
    "editor-assist.jsonl",
  );
  const { client: gateway } = explainGateway({
    status: 200,
    body: {
      explanation: "MOVE moves bytes from WS-A to WS-B.",
      invocationId: "mi-explain-jsonl",
      ledgerRef: "urn:ledger/explain/jsonl",
      redactedFields: ["customerName"],
    },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: {
      ...baseConfig,
      repoRoot,
      modelGatewayUrl: "http://gateway",
      editorAssistLedgerPath: ledgerPath,
    },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ sessionId: "jsonl-session" }),
      },
    );
    assert.equal(response.status, 200);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const line = lines[0];
    if (line === undefined) {
      throw new Error("expected one editor-assist ledger JSONL line");
    }
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.kind, "editor_assist");
    assert.equal(
      entry.editorAssistRef,
      (response.body as Record<string, unknown>).editorAssistRef,
    );
    assert.equal(entry.ledgerRef, "urn:ledger/explain/jsonl");
    assert.equal(entry.status, "success");
  } finally {
    await server.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("createJsonlEditorAssistLedgerSink rejects symlink ledger targets", () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "c2c-bff-editor-ledger-symlink-"),
  );
  try {
    const realPath = path.join(repoRoot, "real-ledger.jsonl");
    fs.writeFileSync(realPath, "", { mode: 0o600 });
    const symlinkPath = path.join(repoRoot, "editor-assist.jsonl");
    fs.symlinkSync(realPath, symlinkPath);
    const sink = createJsonlEditorAssistLedgerSink(symlinkPath, {
      allowedRoot: repoRoot,
    });
    assert.throws(
      () => sink(minimalEditorAssistLedgerEntry()),
      /regular file|ELOOP/i,
    );
    assert.equal(fs.readFileSync(realPath, "utf8"), "");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("createJsonlEditorAssistLedgerSink rejects symlink parent directories", () => {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "c2c-bff-editor-ledger-parent-"),
  );
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "c2c-bff-editor-ledger-outside-"),
  );
  try {
    fs.mkdirSync(path.join(repoRoot, "var"), { recursive: true });
    const symlinkParent = path.join(repoRoot, "var", "linked");
    fs.symlinkSync(outsideRoot, symlinkParent, "dir");
    const escapedLedgerPath = path.join(symlinkParent, "editor-assist.jsonl");
    const sink = createJsonlEditorAssistLedgerSink(escapedLedgerPath, {
      allowedRoot: repoRoot,
    });

    assert.throws(
      () => sink(minimalEditorAssistLedgerEntry()),
      /symlink|escapes|allowed root/i,
    );
    assert.equal(
      fs.existsSync(path.join(outsideRoot, "editor-assist.jsonl")),
      false,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("POST /api/v0/editor/explain preflights the ledger before budget and gateway", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: {
      explanation: "should not be reached",
      invocationId: "mi-preflight-fail",
    },
  });
  const auth = createEditorAssistAuth();
  const failingSink: EditorAssistLedgerSink = () => {
    throw new Error("unexpected ledger write");
  };
  failingSink.preflight = () => {
    throw new Error("EACCES /tmp/c2c-secret-ledger/editor-assist.jsonl");
  };
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistLedgerSink: failingSink,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ sessionId: "preflight-fail-session" }),
      },
    );
    assert.equal(response.status, 503);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "gateway_unavailable");
    assert.equal(
      body.message,
      "Editor-assist audit ledger unavailable. Try again shortly.",
    );
    assert.equal(body.budgetSnapshot, null);
    assert.doesNotMatch(JSON.stringify(body), /c2c-secret-ledger|EACCES/);
    assert.equal(calls.length, 0);

    const budget = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=preflight-fail-session`,
      { headers: auth.headers },
    );
    assert.equal(budget.status, 200);
    assert.deepEqual((budget.body as Record<string, unknown>).budget, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 0,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET,
    });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain fails closed when ledger persistence fails", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: {
      explanation: "MOVE moves bytes from WS-A to WS-B.",
      invocationId: "mi-ledger-fail",
      ledgerRef: "urn:ledger/explain/fail",
    },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistLedgerSink: () => {
      throw new Error("EACCES /tmp/c2c-secret-ledger/editor-assist.jsonl");
    },
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ sessionId: "ledger-fail-session" }),
      },
    );
    assert.equal(response.status, 503);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "gateway_unavailable");
    assert.equal(
      body.message,
      "Editor-assist audit ledger unavailable. Try again shortly.",
    );
    assert.doesNotMatch(JSON.stringify(body), /c2c-secret-ledger|EACCES/);
    assert.deepEqual(body.budgetSnapshot, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 1,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
    });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain returns 503 gateway_unavailable when modelGateway is disabled", async () => {
  const { client: gateway, calls } = explainGateway(undefined, {
    enabled: false,
  });
  const ledger: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    editorAssistLedgerSink: (entry) =>
      ledger.push(entry as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 503);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "gateway_unavailable");
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.budgetSnapshot, null);
    // No budget consumed, no ledger entry when the gateway is disabled.
    assert.equal(calls.length, 0);
    assert.equal(ledger.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain returns 400 invalid_region on byteHash mismatch and does NOT consume budget", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: { explanation: "should not be reached", invocationId: "mi-x" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const tampered = explainRequestBody({ byteHash: "f".repeat(64) });
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: tampered,
      },
    );
    assert.equal(response.status, 400);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "invalid_region");
    assert.equal(body.schemaVersion, "v0");
    assert.match(body.message as string, /byteHash mismatch/);
    assert.equal(calls.length, 0);

    // Budget endpoint confirms used=0.
    const budget = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=studio-session-explain-1&tenantId=tenant-a&userId=user-a`,
      { headers: auth.headers },
    );
    assert.deepEqual((budget.body as { budget: BudgetSnapshot }).budget, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 0,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET,
    });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain maps gateway 403 to policy_denied with HTTP 403", async () => {
  const { client: gateway } = explainGateway({
    status: 403,
    body: { error: "policy denied" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 403);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "policy_denied");
    assert.deepEqual(body.budgetSnapshot, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 1,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
    });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain maps gateway 504 to timeout with HTTP 504", async () => {
  const { client: gateway } = explainGateway({
    status: 504,
    body: { error: "slow" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 504);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "timeout");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain maps transport timeouts to HTTP 504", async () => {
  const timeoutError = new Error("upstream request timed out after 5000ms");
  const { client: gateway } = explainGateway(undefined, {
    throwError: timeoutError,
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 504);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "timeout");
    assert.doesNotMatch(body.message as string, /5000ms|upstream request/i);
  } finally {
    console.warn = originalWarn;
    await server.close();
  }
});

test("POST /api/v0/editor/explain maps gateway 500 to gateway_unavailable with HTTP 503", async () => {
  const { client: gateway } = explainGateway({
    status: 500,
    body: {
      error:
        "Traceback (most recent call last): leak\nsk-deadbeefdeadbeefdeadbeef",
    },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 503);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "gateway_unavailable");
    // The user-facing message must NOT include the upstream stack
    // trace marker or the leaked secret pattern.
    assert.doesNotMatch(body.message as string, /Traceback/);
    assert.doesNotMatch(body.message as string, /sk-deadbeef/);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain returns 429 budget_exhausted when the session is empty", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: { explanation: "ok", invocationId: "mi-1", ledgerRef: "urn:l/1" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    // Inject a 1-unit budget store so a single call exhausts the
    // session.
    editorAssistBudgets: createEditorAssistBudgetStore({ defaultLimit: 1 }),
  });
  const server = await startTestServer(handler);
  try {
    const first = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      headers: auth.headers,
      body: explainRequestBody(),
    });
    assert.equal(first.status, 200);

    const second = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      headers: auth.headers,
      body: explainRequestBody(),
    });
    assert.equal(second.status, 429);
    const body = second.body as Record<string, unknown>;
    assert.equal(body.errorCode, "budget_exhausted");
    assert.deepEqual(body.budgetSnapshot, { limit: 1, used: 1, remaining: 0 });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain enforces the per-tenant-per-day ceiling across sessions", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: { explanation: "ok", invocationId: "mi-1", ledgerRef: "urn:l/1" },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistBudgets: createEditorAssistBudgetStore({
      defaultLimit: 10,
      tenantDailyCap: 1,
    }),
  });
  const server = await startTestServer(handler);
  try {
    const first = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      headers: auth.headers,
      body: explainRequestBody({ sessionId: "sess-A" }),
    });
    assert.equal(first.status, 200);
    // Fresh sessionId, same tenantId — must still hit the daily cap.
    const second = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      headers: auth.headers,
      body: explainRequestBody({ sessionId: "sess-B" }),
    });
    assert.equal(second.status, 429);
    const body = second.body as Record<string, unknown>;
    assert.equal(body.errorCode, "budget_exhausted");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain rejects malformed payloads with invalid_region", async () => {
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: { explanation: "ok", invocationId: "mi-1" },
  });
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
  });
  const server = await startTestServer(handler);
  try {
    // Missing sessionId
    const noSession = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: { ...(explainRequestBody() as object), sessionId: "" },
      },
    );
    assert.equal(noSession.status, 400);
    assert.equal(
      (noSession.body as Record<string, unknown>).errorCode,
      "invalid_region",
    );

    // Empty redactedBytes
    const empty = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      body: {
        ...(explainRequestBody() as object),
        redactedBytes: "",
        byteHash: createHash("sha256").update("", "utf8").digest("hex"),
      },
    });
    assert.equal(empty.status, 400);

    // sourceKind outside cobol|java
    const wrongKind = explainRequestBody() as Record<string, unknown>;
    (wrongKind.region as Record<string, unknown>).sourceKind = "python";
    const wrongKindRes = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      { method: "POST", body: wrongKind },
    );
    assert.equal(wrongKindRes.status, 400);

    const extraField = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: { ...(explainRequestBody() as object), unsupported: true },
      },
    );
    assert.equal(extraField.status, 400);
    assert.match(
      (extraField.body as Record<string, unknown>).message as string,
      /unsupported field unsupported/,
    );
    assert.equal(calls.length, 0);
  } finally {
    await server.close();
  }
});

test("GET /api/v0/editor/budget returns the current session snapshot", async () => {
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: explainGateway(undefined).client,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&tenantId=tenant-a&userId=user-a`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.deepEqual(body.budget, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 0,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET,
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/editor/budget treats query sessionId as correlation only", async () => {
  const auth = createEditorAssistAuth();
  const budgets = createEditorAssistBudgetStore();
  const consumed = await budgets.consume({
    tenantId: "tenant-a",
    userId: "user-a",
    sessionId: auth.sessionId,
  });
  assert.equal(consumed.ok, true);
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: explainGateway(undefined).client,
    editorAssistBudgets: budgets,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=another-studio-session`,
      { headers: auth.headers },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as Record<string, unknown>).budget, {
      limit: DEFAULT_EDITOR_ASSIST_BUDGET,
      used: 1,
      remaining: DEFAULT_EDITOR_ASSIST_BUDGET - 1,
    });
  } finally {
    await server.close();
  }
});

test("GET /api/v0/editor/budget rejects missing sessionId with 400", async () => {
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: explainGateway(undefined).client,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/editor/budget`);
    assert.equal(response.status, 400);
    assert.match(
      (response.body as Record<string, unknown>).error as string,
      /sessionId/,
    );
  } finally {
    await server.close();
  }
});

test("GET /api/v0/editor/budget validates identifiers against the active session", async () => {
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: explainGateway(undefined).client,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const invalidSession = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=bad%20session`,
      { headers: auth.headers },
    );
    assert.equal(invalidSession.status, 400);
    assert.match(
      (invalidSession.body as Record<string, unknown>).error as string,
      /sessionId/,
    );

    const invalidTenant = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&tenantId=bad%20tenant`,
      { headers: auth.headers },
    );
    assert.equal(invalidTenant.status, 400);
    assert.match(
      (invalidTenant.body as Record<string, unknown>).error as string,
      /tenantId/,
    );

    const blankTenant = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&tenantId=`,
      { headers: auth.headers },
    );
    assert.equal(blankTenant.status, 400);
    assert.match(
      (blankTenant.body as Record<string, unknown>).error as string,
      /tenantId/,
    );

    const blankUser = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&userId=`,
      { headers: auth.headers },
    );
    assert.equal(blankUser.status, 400);
    assert.match(
      (blankUser.body as Record<string, unknown>).error as string,
      /userId/,
    );

    const mismatchedUser = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&userId=user-b`,
      { headers: auth.headers },
    );
    assert.equal(mismatchedUser.status, 403);
    assert.match(
      (mismatchedUser.body as Record<string, unknown>).error as string,
      /userId/,
    );

    const missingCookie = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1`,
    );
    assert.equal(missingCookie.status, 401);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain falls back to local ledgerRef when gateway omits it", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: {
      explanation: "ok",
      invocationId: "mi-2",
      // No ledgerRef from gateway — BFF must emit the local placeholder.
    },
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ sessionId: "fallback-sess" }),
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(
      typeof body.ledgerRef === "string" &&
        (body.ledgerRef as string).startsWith(
          "urn:c2c/editor-assist/tenant-a/fallback-sess/",
        ),
      true,
    );
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain drops unsafe gateway metadata before responding or writing ledger", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: {
      explanation: "ok",
      invocationId: "https://internal.example/inv/123",
      ledgerRef: "urn:https://internal.example/run?token=opaque",
      redactedFields: [
        "field-name-class:email",
        "internal.example",
        "alice@example.invalid",
        "https://internal.example/redaction/1",
      ],
    },
  });
  const ledger: Array<Record<string, unknown>> = [];
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
    editorAssistLedgerSink: (entry) =>
      ledger.push(entry as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody({ sessionId: "safe-gateway-metadata" }),
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.match(
      body.ledgerRef as string,
      /^urn:c2c\/editor-assist\/tenant-a\/safe-gateway-metadata\//,
    );
    assert.match(
      body.modelInvocationRef as string,
      /^mi-\d+-eai-tenant-a-safe-gateway-metadata-\d+$/,
    );
    assert.deepEqual(
      (body.redactionApplied as string[]).sort(),
      ["field-name-class:email", "ssn-us"].sort(),
    );
    assert.equal(JSON.stringify(body).includes("alice@example.invalid"), false);
    assert.equal(JSON.stringify(body).includes("internal.example"), false);

    assert.equal(ledger.length, 1);
    const entry = ledger[0] as Record<string, unknown>;
    assert.equal(entry.ledgerRef, body.ledgerRef);
    assert.equal(entry.invocationId, null);
    assert.deepEqual(
      (entry.redactedFields as string[]).sort(),
      ["field-name-class:email", "ssn-us"].sort(),
    );
    assert.equal(
      JSON.stringify(entry).includes("alice@example.invalid"),
      false,
    );
    assert.equal(JSON.stringify(entry).includes("internal.example"), false);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain returns 415 when Content-Type is not application/json", async () => {
  // M1: the route must reject non-JSON content types before reading the body.
  // No budget is consumed and no ledger entry is written.
  const { client: gateway, calls } = explainGateway({
    status: 200,
    body: { explanation: "ok", invocationId: "mi-1" },
  });
  const ledger: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    editorAssistLedgerSink: (entry) =>
      ledger.push(entry as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const bodyBytes = Buffer.from(JSON.stringify(explainRequestBody()));
    const response = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const req = http.request(
          {
            method: "POST",
            hostname: "127.0.0.1",
            port: new URL(server.baseUrl).port,
            path: "/api/v0/editor/explain",
            headers: {
              accept: "application/json",
              "content-type": "text/plain",
              "content-length": String(bodyBytes.length),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf-8");
              let parsed: unknown = raw;
              try {
                parsed = JSON.parse(raw);
              } catch {
                // leave as string
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(bodyBytes);
        req.end();
      },
    );
    assert.equal(response.status, 415);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.errorCode, "invalid_region");
    assert.match(body.message as string, /Content-Type: application\/json/);
    assert.equal(body.budgetSnapshot, null);
    // No gateway call, no budget consumed, no ledger entry.
    assert.equal(calls.length, 0);
    assert.equal(ledger.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain emits structured console.warn on gateway throw", async () => {
  // M3: when the gateway client throws, the BFF must log a JSON-structured
  // warning containing route, event, errorClass, and message before
  // returning 503 gateway_unavailable.
  const { client: gateway } = explainGateway(undefined, {
    throwError: new Error("transport failure: ECONNREFUSED"),
  });
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        headers: auth.headers,
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 503);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "gateway_unavailable");
    // The structured warn must have been called at least once.
    assert.ok(
      warnings.length >= 1,
      "expected console.warn to be called at least once",
    );
    // The first warn entry must be valid JSON with the required fields.
    const parsed = JSON.parse(warnings[0] as string) as Record<string, unknown>;
    assert.equal(parsed.route, "/api/v0/editor/explain");
    assert.equal(parsed.event, "gateway_call_failed");
    assert.equal(typeof parsed.errorClass, "string");
    assert.equal(typeof parsed.message, "string");
    // The raw error text must not have been echoed into the response body.
    assert.doesNotMatch(body.message as string, /ECONNREFUSED/);
  } finally {
    console.warn = originalWarn;
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Studio-IDE-11 (#251): editor telemetry intake — route-level integration
// tests. Cover the happy path (valid batch → 202 accepted), the
// upstream-disabled fallback ("drop silently when no UL configured"),
// upstream failure, and several boundary rejections.
// ---------------------------------------------------------------------------

function liveLearningTelemetryCapture(): {
  calls: unknown[];
  client: {
    enabled: true;
    baseUrl: string;
    getRunSummary: () => Promise<undefined>;
    submitEditorTelemetry: (payload: unknown) => Promise<UpstreamResponse>;
  };
} {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      enabled: true,
      baseUrl: "http://el.test",
      async getRunSummary() {
        return undefined;
      },
      async submitEditorTelemetry(payload: unknown) {
        calls.push(payload);
        return { status: 201, body: { accepted: 1, service: "el-test" } };
      },
    },
  };
}

function brokenLearningTelemetry(): {
  enabled: true;
  baseUrl: string;
  getRunSummary: () => Promise<undefined>;
  submitEditorTelemetry: () => Promise<UpstreamResponse>;
} {
  return {
    enabled: true,
    baseUrl: "http://el.test",
    async getRunSummary() {
      return undefined;
    },
    async submitEditorTelemetry() {
      throw new Error("ECONNREFUSED: experience-learning-service unreachable");
    },
  };
}

function telemetryBatch(events: unknown[]) {
  return { schemaVersion: "v0", events };
}

function validHoverEvent() {
  return {
    schemaVersion: "v0",
    eventType: "hover.opened",
    occurredAt: "2026-05-18T12:00:00Z",
    sessionId: "studio-test-session",
    payload: { constructKind: "pic" },
  };
}

test("editor telemetry route accepts a valid batch and forwards to experience-learning", async () => {
  const { client, calls } = liveLearningTelemetryCapture();
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, experienceLearningUrl: "http://el.test" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: client,
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/editor/telemetry`,
      {
        method: "POST",
        headers: auth.headers,
        body: telemetryBatch([validHoverEvent()]),
      },
    );
    assert.equal(result.status, 202);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.accepted, 1);
    assert.equal(body.forwarded, true);
    assert.equal(calls.length, 1);
    const forwarded = calls[0] as { events: Array<Record<string, unknown>> };
    assert.equal(forwarded.events.length, 1);
    assert.equal(forwarded.events[0]?.tenantId, "tenant-a");
    assert.equal(forwarded.events[0]?.userId, "user-a");
    assert.equal(typeof forwarded.events[0]?.receivedAt, "string");
  } finally {
    await server.close();
  }
});

test("editor telemetry route accepts 202 when upstream is disabled", async () => {
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/editor/telemetry`,
      {
        method: "POST",
        headers: auth.headers,
        body: telemetryBatch([validHoverEvent()]),
      },
    );
    assert.equal(result.status, 202);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.forwarded, false);
  } finally {
    await server.close();
  }
});

test("editor telemetry route rejects requests without an active Studio session", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/editor/telemetry`,
      {
        method: "POST",
        body: telemetryBatch([validHoverEvent()]),
      },
    );
    assert.equal(result.status, 401);
  } finally {
    await server.close();
  }
});

test("editor telemetry route returns 502 when upstream throws", async () => {
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: { ...baseConfig, experienceLearningUrl: "http://el.test" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: brokenLearningTelemetry(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args[0]);
  };
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/editor/telemetry`,
      {
        method: "POST",
        headers: auth.headers,
        body: telemetryBatch([validHoverEvent()]),
      },
    );
    assert.equal(result.status, 502);
    const body = result.body as Record<string, unknown>;
    assert.equal(typeof body.error, "string");
    // Upstream raw error text must not be echoed.
    assert.doesNotMatch(body.error as string, /ECONNREFUSED/);
    assert.ok(
      warnings.length >= 1,
      "expected upstream failure to be logged via console.warn",
    );
  } finally {
    console.warn = originalWarn;
    await server.close();
  }
});

test("editor telemetry route rejects bad JSON with 400", async () => {
  const auth = createEditorAssistAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/editor/telemetry`,
      {
        method: "POST",
        headers: auth.headers,
        body: {
          schemaVersion: "v0",
          events: [{ ...validHoverEvent(), eventType: "not.real" }],
        },
      },
    );
    assert.equal(result.status, 400);
    const body = result.body as Record<string, unknown>;
    assert.equal(typeof body.error, "string");
    assert.equal(body.errorCode, "invalid_event");
  } finally {
    await server.close();
  }
});

test("editor telemetry route rejects non-JSON content-type with 415", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    // Use a raw http.request so we can override the content-type. The
    // fetchJson helper hardcodes JSON.
    const target = new URL(`${server.baseUrl}/api/v0/editor/telemetry`);
    const body = JSON.stringify(telemetryBatch([validHoverEvent()]));
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: {
            accept: "application/json",
            "content-type": "text/plain",
            "content-length": String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    assert.equal(status, 415);
  } finally {
    await server.close();
  }
});

// Issue #271 / ADR-0005 §6: POST /api/v0/csp-report receiver. The
// integration tests below pin the on-wire contract (status codes,
// content-type negotiation, body-size cap) and the PII gate (no
// query strings / fragments reach the sink). Unit tests for the
// parser live in `cspReport.test.ts`.

async function postRaw(
  url: string,
  contentType: string,
  body: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: {
          "content-type": contentType,
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("POST /api/v0/csp-report accepts application/csp-report and returns 204", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/csp-report",
      JSON.stringify({
        "csp-report": {
          "document-uri": "http://127.0.0.1/page",
          "violated-directive": "script-src",
          "blocked-uri": "inline",
        },
      }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.body, "");
    assert.equal(sink.length, 1);
    const first = sink[0];
    assert.ok(first);
    assert.equal(first["violated-directive"], "script-src");
    assert.equal(first["blocked-uri"], "inline");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report strips query strings and fragments before logging", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/csp-report",
      JSON.stringify({
        "csp-report": {
          "document-uri":
            "http://127.0.0.1/page?session=secret-token&user=alice@example.com#frag",
          "violated-directive": "script-src",
          "blocked-uri": "http://127.0.0.1/asset.js?cb=1",
          referrer: "http://127.0.0.1/from?token=abc",
        },
      }),
    );
    assert.equal(response.status, 204);
    assert.equal(sink.length, 1);
    const first = sink[0];
    assert.ok(first);
    const serialised = JSON.stringify(first);
    // The PII tokens must not appear in the sink record.
    assert.equal(serialised.includes("secret-token"), false);
    assert.equal(serialised.includes("alice@example.com"), false);
    assert.equal(serialised.includes("abc"), false);
    // The pathname is preserved so we can still triage which page
    // tripped the policy.
    assert.equal(first["document-uri"], "http://127.0.0.1/page");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report accepts application/reports+json batches", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/reports+json",
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            "violated-directive": "script-src",
            "blocked-uri": "inline",
          },
        },
        {
          type: "deprecation",
          body: { id: "x" },
        },
        {
          type: "csp-violation",
          body: {
            "violated-directive": "style-src",
            "blocked-uri": "inline",
          },
        },
      ]),
    );
    assert.equal(response.status, 204);
    assert.equal(sink.length, 2);
    const [first, second] = sink;
    assert.ok(first);
    assert.ok(second);
    assert.equal(first["violated-directive"], "script-src");
    assert.equal(second["violated-directive"], "style-src");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report rejects unsupported content-type with 415", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "text/plain",
      "not a report",
    );
    assert.equal(response.status, 415);
    assert.equal(sink.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report rejects malformed JSON with 400", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/csp-report",
      "{not json",
    );
    assert.equal(response.status, 400);
    assert.equal(sink.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report rejects an empty envelope with 400", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/csp-report",
      JSON.stringify({ "csp-report": {} }),
    );
    assert.equal(response.status, 400);
    assert.equal(sink.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/csp-report rejects oversize bodies with 413", async () => {
  const sink: Array<Record<string, unknown>> = [];
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    cspReportSink: (report) =>
      sink.push(report as unknown as Record<string, unknown>),
  });
  const server = await startTestServer(handler);
  try {
    // 128 KiB body — over the 64 KiB cap.
    const huge = "x".repeat(128 * 1024);
    const response = await postRaw(
      `${server.baseUrl}/api/v0/csp-report`,
      "application/csp-report",
      JSON.stringify({
        "csp-report": { "violated-directive": "script-src", padding: huge },
      }),
    );
    assert.equal(response.status, 413);
    assert.equal(sink.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/output-change-explanation returns a deterministic repair-patch explanation", async () => {
  const runStore = createRunStore();
  const previous = runStore.create(FIXED_SAMPLE, "live", "live-prev", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "b".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "2".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "6".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const current = runStore.create(FIXED_SAMPLE, "live", "live-current", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "c".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "3".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "7".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    runStore,
    orchestrator: outputChangeOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: availableModelGateway(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${current.runId}/output-change-explanation`,
      {
        method: "POST",
        headers: auth.headers,
        body: { previousRunId: previous.runId },
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.status, "available");
    assert.equal(body.primaryCategory, "repair_patch");
    assert.match(String(body.summary), /repair patch/i);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/output-change-explanation returns unavailable when the previous run is unknown", async () => {
  const runStore = createRunStore();
  const current = runStore.create(FIXED_SAMPLE, "live", "live-current", {
    status: "completed",
    executionMode: "parity",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      javaResult: { normalizedOutputRef: { sha256: "c".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    runStore,
    orchestrator: outputChangeOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${current.runId}/output-change-explanation`,
      {
        method: "POST",
        headers: auth.headers,
        body: { previousRunId: "missing-run" },
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.status, "unavailable");
    assert.equal(body.unavailableReason, "previous_run_missing");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/output-change-explanation can attach an AI-assisted summary", async () => {
  const runStore = createRunStore();
  const previous = runStore.create(FIXED_SAMPLE, "live", "live-prev", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "b".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "2".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "6".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const current = runStore.create(FIXED_SAMPLE, "live", "live-current", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "c".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "3".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "7".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    runStore,
    orchestrator: outputChangeOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: {
      ...availableModelGateway(),
      async explain() {
        return {
          status: 200,
          body: {
            explanation:
              "The repaired Java candidate changed the observed output.",
            invocationId: "inv-output-change-1",
            ledgerRef: "urn:ledger:output-change-1",
          },
        };
      },
    },
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${current.runId}/output-change-explanation`,
      {
        method: "POST",
        headers: auth.headers,
        body: {
          previousRunId: previous.runId,
          includeAiSummary: true,
        },
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    const aiSummary = body.aiSummary as Record<string, unknown>;
    assert.equal(aiSummary.status, "available");
    assert.match(String(aiSummary.explanation), /repaired Java candidate/i);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/output-change-explanation rejects unauthenticated requests with 401", async () => {
  const runStore = createRunStore();
  const current = runStore.create(FIXED_SAMPLE, "live", "live-current", {
    status: "completed",
    executionMode: "parity",
  });
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    runStore,
    orchestrator: outputChangeOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${current.runId}/output-change-explanation`,
      {
        method: "POST",
        body: { previousRunId: "live-prev" },
      },
    );
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs/:runId/output-change-explanation strips raw output excerpts from the model-gateway payload", async () => {
  const runStore = createRunStore();
  const previous = runStore.create(FIXED_SAMPLE, "live", "live-prev", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "b".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "2".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "6".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  const current = runStore.create(FIXED_SAMPLE, "live", "live-current", {
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "same-digest",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "same-digest",
      },
      cobolResult: { normalizedOutputRef: { sha256: "a".repeat(64) } },
      javaResult: { normalizedOutputRef: { sha256: "c".repeat(64) } },
      comparisonResult: { diffRef: { sha256: "3".repeat(64) } },
      repair: { repairDecisionRef: { sha256: "7".repeat(64) } },
      evidence: { status: "current" },
    },
  });
  let capturedExcerptCount = -1;
  const auth = createRouteAuth();
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    trustCases: stubTrustCases([FIXED_TRUST_CASE]),
    runStore,
    orchestrator: outputChangeOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: {
      ...availableModelGateway(),
      async explain(payload: unknown) {
        const analysis = (
          payload as {
            analysis?: { outputDelta?: { excerpt?: unknown[] } };
          }
        ).analysis;
        capturedExcerptCount = analysis?.outputDelta?.excerpt?.length ?? -1;
        return {
          status: 200,
          body: {
            explanation: "The repaired Java candidate changed the output.",
            invocationId: "inv-output-change-strip",
            ledgerRef: "urn:ledger:output-change-strip",
          },
        };
      },
    },
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${current.runId}/output-change-explanation`,
      {
        method: "POST",
        headers: auth.headers,
        body: {
          previousRunId: previous.runId,
          includeAiSummary: true,
        },
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    const outputDelta = body.outputDelta as { excerpt: unknown[] };
    assert.ok(outputDelta.excerpt.length > 0);
    assert.equal(capturedExcerptCount, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Issue #356 — bound parity request input and trust-case projection fields.
// ---------------------------------------------------------------------------

test("POST /api/v0/runs rejects trustCaseId exceeding 128 characters with 400", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {
        programId: "BRNCH01",
        executionMode: "parity",
        trustCaseId: "t".repeat(129),
        sourceReferenceFixtureId: "fixture-v0",
      },
    });
    assert.equal(response.status, 400);
    assert.match(
      (response.body as { error: string }).error,
      /trustCaseId exceeds maximum length/,
    );
    assert.equal(calls.startRun, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/runs rejects sourceReferenceFixtureId exceeding 128 characters with 400", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const { client: orch, calls } = stubOrchestrator();
  const auth = createRouteAuth();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: {
        programId: "BRNCH01",
        executionMode: "parity",
        sourceReferenceFixtureId: "f".repeat(129),
      },
    });
    assert.equal(response.status, 400);
    assert.match(
      (response.body as { error: string }).error,
      /sourceReferenceFixtureId exceeds maximum length/,
    );
    assert.equal(calls.startRun, 0);
  } finally {
    await server.close();
  }
});

test("build-test projection truncates oversize comparisonPolicyVersion to 128 characters", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const oversizePolicy = "p".repeat(200);
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: {
          status: "ok",
          classification: "match",
          build: { compileOk: true, sourceCount: 1, diagnostics: [] },
          execution: {
            ran: true,
            ok: true,
            exitCode: 0,
            stdout: "APPROVED-COUNT=2\n",
            stderr: "",
            durationMs: 5,
          },
          comparison: {
            matched: true,
            status: "passed",
            comparisonPolicyVersion: oversizePolicy,
          },
          diagnostics: [],
          programId: "BRNCH01",
        },
        artifactRef: {
          uri: "file:///run/result.json",
          sha256: "c".repeat(64),
          byteSize: 128,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const body = buildTest.body as {
      comparison: { comparisonPolicyVersion: string } | null;
    };
    assert.ok(body.comparison !== null);
    assert.equal(body.comparison?.comparisonPolicyVersion.length, 128);
    assert.equal(
      body.comparison?.comparisonPolicyVersion,
      oversizePolicy.slice(0, 128),
    );
  } finally {
    await server.close();
  }
});

test("build-test projection merges canonical comparisonResult refs with legacy comparison refs", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const auth = createRouteAuth();
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: "live-run-1",
        workflowId: "w0-migration-v0",
        programId: "BRNCH01",
        runStatus: "completed",
        status: "complete",
        missingArtifacts: [],
        kind: "build-test-result",
        data: {
          status: "output-divergence",
          classification: "divergence-unknown",
          build: { compileOk: true, sourceCount: 1, diagnostics: [] },
          execution: {
            ran: true,
            ok: true,
            exitCode: 0,
            stdout: "JAVA\n",
            stderr: "",
            durationMs: 5,
          },
          comparison: {
            matched: false,
            expectedRef: {
              uri: "urn:build-test/expected",
              sha256: "e".repeat(64),
              byteSize: 5,
              kind: "cobol-oracle-stdout",
            },
            actualRef: {
              uri: "urn:build-test/actual",
              sha256: "a".repeat(64),
              byteSize: 5,
              kind: "java-stdout",
            },
          },
          comparisonResult: {
            status: "failed",
            matched: false,
            comparisonPolicyVersion: "deterministic-output-v1",
            mismatchClassification: "content",
            diffSummary: "Outputs diverged during parity comparison.",
            comparisonResultRef: {
              uri: "urn:build-test/comparison-result",
              sha256: "b".repeat(64),
              byteSize: 64,
              kind: "parity-comparison-result",
            },
            diffRef: {
              uri: "urn:build-test/comparison-diff",
              sha256: "c".repeat(64),
              byteSize: 32,
              kind: "parity-comparison-diff",
            },
            sourceOutputRef: {
              uri: "urn:build-test/source-output",
              sha256: "d".repeat(64),
              byteSize: 5,
              kind: "reference-output",
            },
            javaOutputRef: {
              uri: "urn:build-test/java-output",
              sha256: "f".repeat(64),
              byteSize: 5,
              kind: "java-stdout",
            },
          },
          diagnostics: [],
          programId: "BRNCH01",
        },
        artifactRef: {
          uri: "file:///run/result.json",
          sha256: "9".repeat(64),
          byteSize: 256,
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
      { headers: auth.headers },
    );
    assert.equal(buildTest.status, 200);
    const body = buildTest.body as {
      expectedOutputRef: { sha256: string; kind: string } | null;
      actualOutputRef: { sha256: string; kind: string } | null;
      comparison: {
        status: string;
        comparisonPolicyVersion: string;
        mismatchClassification: string;
        diffSummary: string;
        expectedRef?: { sha256: string; kind: string };
        actualRef?: { sha256: string; kind: string };
        comparisonResultRef?: { sha256: string; kind: string };
        diffRef?: { sha256: string; kind: string };
        sourceOutputRef?: { sha256: string; kind: string };
        javaOutputRef?: { sha256: string; kind: string };
      } | null;
    };
    assert.equal(body.expectedOutputRef?.sha256, "e".repeat(64));
    assert.equal(body.actualOutputRef?.sha256, "a".repeat(64));
    assert.equal(body.comparison?.status, "failed");
    assert.equal(
      body.comparison?.comparisonPolicyVersion,
      "deterministic-output-v1",
    );
    assert.equal(body.comparison?.mismatchClassification, "content");
    assert.equal(
      body.comparison?.diffSummary,
      "Outputs diverged during parity comparison.",
    );
    assert.equal(body.comparison?.expectedRef?.sha256, "e".repeat(64));
    assert.equal(body.comparison?.actualRef?.sha256, "a".repeat(64));
    assert.equal(body.comparison?.comparisonResultRef?.sha256, "b".repeat(64));
    assert.equal(body.comparison?.diffRef?.sha256, "c".repeat(64));
    assert.equal(body.comparison?.sourceOutputRef?.sha256, "d".repeat(64));
    assert.equal(body.comparison?.javaOutputRef?.sha256, "f".repeat(64));
  } finally {
    await server.close();
  }
});

test("workflow contract with oversize trust-case fields is truncated in the run summary", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const auth = createRouteAuth();
  const oversizeCatalogHash = "h".repeat(300);
  const oversizeTrustCaseId = "i".repeat(200);
  const { client: orch } = stubOrchestrator({
    workflow: {
      status: 200,
      body: {
        status: "complete",
        contract: {
          currentState: "final_classification",
          activeStep: "write-evidence",
          agentAttemptCount: 1,
          repairBudget: { limit: 2, used: 0, remaining: 2 },
          repairAttempts: [],
          finalClassification: "success",
          failureCode: null,
          failureMessage: null,
          trustCase: {
            trustCaseId: oversizeTrustCaseId,
            version: "v1",
            catalogVersion: "2026-05-21",
            catalogHash: oversizeCatalogHash,
            configurationDigest: "d".repeat(300),
            sourceReferenceFixtureId: "fixture-v0",
            sourceReferenceMode: "reference-fixture",
            environmentProfileId: "sandbox-v1",
            comparisonPolicyVersion: "deterministic-v1",
          },
        },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
    sessionStore: auth.sessionStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: auth.headers,
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const run = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
      { headers: auth.headers },
    );
    assert.equal(run.status, 200);
    const body = run.body as {
      trustCaseId: string;
      trustCaseCatalogHash: string;
      trustCaseConfigurationDigest: string;
    };
    assert.equal(body.trustCaseId.length, 128);
    assert.equal(body.trustCaseId, oversizeTrustCaseId.slice(0, 128));
    assert.equal(body.trustCaseCatalogHash.length, 256);
    assert.equal(body.trustCaseCatalogHash, oversizeCatalogHash.slice(0, 256));
    assert.equal(body.trustCaseConfigurationDigest.length, 256);
  } finally {
    await server.close();
  }
});

// Silence unused-import warnings under strict mode
void net;
