import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { AddressInfo } from "node:net";

import { createApp } from "./server";
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
  createEditorAssistBudgetStore,
  type BudgetSnapshot,
} from "./editorExplain";

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

interface ArtifactStubResponses {
  generated?: UpstreamResponse;
  generatedFiles?: UpstreamResponse;
  generatedFile?:
    | UpstreamResponse
    | ((path: string) => UpstreamResponse | undefined);
  buildTest?: UpstreamResponse;
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
      generateOnly?: boolean;
    }>;
    getGenerated: number;
    getGeneratedFiles: number;
    getGeneratedFile: Array<{ runId: string; path: string }>;
    getBuildTest: number;
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
    }>,
    getGenerated: 0,
    getGeneratedFiles: 0,
    getGeneratedFile: [] as Array<{ runId: string; path: string }>,
    getBuildTest: 0,
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
    async startRun() {
      calls.startRun += 1;
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
    async getBuildTest() {
      calls.getBuildTest += 1;
      return artifactResponses.buildTest;
    },
    async getEvidence() {
      calls.getEvidence += 1;
      return artifactResponses.evidence;
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

const baseConfig: BffConfig = {
  serviceName: "c2c-bff",
  port: 0,
  repoRoot: "/tmp/c2c-test-root",
  staticRoot: "/tmp/c2c-test-static-does-not-exist",
  orchestratorUrl: "",
  orchestratorControlToken: "",
  evidenceUrl: "",
  experienceLearningUrl: "",
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
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyBytes) req.write(bodyBytes);
    req.end();
  });
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([unsupported]),
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: realRegistry,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
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
  const handler = createApp({
    config: baseConfig,
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const blocked = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
    );
    assert.equal(fetched.status, 200);
    const fetchedBody = fetched.body as { mode: string; status: string };
    assert.equal(fetchedBody.mode, "live");
    assert.equal(fetchedBody.status, "completed");
    assert.equal(calls.getRun, 1);

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
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

test("live generated/build-test/evidence endpoints return real artifact contents when orchestrator has persisted them", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
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

test("live build-test surfaces compile failure as compileStatus=failed and executionStatus=not-run", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
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

// ADR 0007 (#257, Issue #279): the BFF /evidence view surfaces the
// orchestrator's manual-edit provenance run-summary fields plus the
// persisted manualEditOverlay reference so the Studio can fetch the
// per-region overlay JSON for audit review.
test("live evidence surfaces manualEditOverlay reference and run-summary fields", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
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
  const { client: orch } = stubOrchestrator(); // no evidence stub => returns undefined
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n";
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
      useTransformationAgent: true,
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

test("transform uses a deterministic fallback program id when none is provided", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText =
      '       IDENTIFICATION DIVISION.\n       DISPLAY "NO PROGRAM ID".\n';
    const expectedProgramId = `SRC-${createHash("sha256").update(sourceText, "utf8").digest("hex").slice(0, 12).toUpperCase()}`;
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const transformed = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. ISO01.\n",
        useTransformationAgent: false,
      },
    });
    assert.equal(transformed.status, 201);

    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const missing = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: {},
    });
    assert.equal(missing.status, 400);

    const unknown = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "NOPE" },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("returns 404 for unknown api paths and run ids", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const unknownApi = await fetchJson(`${server.baseUrl}/api/v0/nope`);
    assert.equal(unknownApi.status, 404);

    const unknownRun = await fetchJson(
      `${server.baseUrl}/api/v0/runs/run-bogus`,
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
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    assert.equal(created.status, 201);
    const runId = (created.body as { runId: string }).runId;

    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
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
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
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
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/learning`,
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
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/experience`,
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/learning`,
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
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${runId}/progress`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
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
  const javaContent = "package c2c;\npublic final class CASE01 {}\n";
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
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string };

    const index = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files`,
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

    // Path traversal attempts are rejected by the BFF before reaching the orchestrator.
    const traversal = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/..%2F..%2Fetc%2Fpasswd`,
    );
    assert.equal(traversal.status, 400);

    // Unknown file inside the generated tree returns 404, not 200.
    const missing = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/does/not/exist.java`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("Issue #97: /generated, /build-test, and /evidence all carry the same generated artifact hash", async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`,
    );
    const genBody = generated.body as {
      artifactRef: { sha256: string } | null;
      traceability: { programId: string; irId: string; sourceHash: string };
    };
    assert.equal(genBody.artifactRef?.sha256, manifestHash);
    assert.equal(genBody.traceability.programId, "CASE01");
    assert.equal(genBody.traceability.irId, "ir-CASE01");

    const buildTest = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`,
    );
    const btBody = buildTest.body as {
      generatedArtifactRef: { sha256: string } | null;
    };
    assert.equal(btBody.generatedArtifactRef?.sha256, manifestHash);

    const evidence = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
    });
    const server = await startTestServer(handler);
    try {
      const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
        method: "POST",
        body: { programId: "BRNCH01" },
      });
      const startedBody = started.body as { runId: string };
      const workflow = await fetchJson(
        `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const run = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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

test("GET /api/v0/runs/{runId}/workflow returns an empty W0.2 envelope when the orchestrator is unreachable", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const { client: orch } = stubOrchestrator(); // no workflow stub -> undefined
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, true);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform enables transformation-agent assist by default", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
      },
    });
    assert.equal(response.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.equal(calls.startTransformRun[0]?.useTransformationAgent, true);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform rejects default AI assist when no model is available", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
      body: {
        sourceText: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n",
        targetLanguage: "java",
      },
    });
    assert.equal(response.status, 503);
    assert.equal(
      (response.body as { failureCode: string }).failureCode,
      "model_gateway_unavailable",
    );
    assert.equal(calls.startTransformRun.length, 0);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/transform forwards explicit transformation-agent opt-out", async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/BRNCH01.java`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/BRNCH01.java`,
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    // Fire 12 concurrent polls. Each one runs getRun -> applyLiveRunPayload
    // -> fetchWorkflowSnapshot -> applyWorkflowSnapshotToStore. The final
    // cached state must reflect the upstream contract exactly, with no
    // half-applied patch.
    const polls = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}`),
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    const workflow = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };
    // Drive the workflow fetch so the BFF caches the budgets on the run.
    await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/workflow`,
    );
    const summary = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}`,
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
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string };

    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
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
  } finally {
    await server.close();
  }
});

test("GET /api/v0/runs/{runId}/traceability returns 404 for unknown run", async () => {
  const runStore = createRunStore();
  const samples = stubSamples([FIXED_SAMPLE]);
  const { client: orch } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/does-not-exist/traceability`,
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
  // diagnostic-fixture mode requires a disabled orchestrator (no orchestratorUrl)
  const handler = createApp({
    config: { ...baseConfig, enableDiagnosticFixtures: true },
    samples,
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: "POST",
      body: { programId: "BRNCH01" },
    });
    const startedBody = started.body as { runId: string; mode: string };
    assert.equal(startedBody.mode, "diagnostic-fixture");

    const result = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/traceability`,
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: "http://upstream" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    modelGateway: availableModelGateway(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: "POST",
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/generate`, {
      method: "POST",
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

test("POST /api/v0/compile-check returns 400 when javaFiles is missing", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: { runId: "r1" },
    });
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 400 when javaFiles is empty array", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: { javaFiles: [] },
    });
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 400 when javaFiles entry has no path", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: { javaFiles: [{ path: "", content: "class Foo {}" }] },
    });
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("path"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check returns 413 when total content exceeds cap", async () => {
  const handler = createApp({
    config: { ...baseConfig, transformSourceMaxBytes: 10 },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: {
        javaFiles: [
          { path: "Foo.java", content: "class Foo { /* large content */ }" },
        ],
      },
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/compile-check happy path returns 200 with diagnostics", async () => {
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: {
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: disabledBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: {
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/compile-check`, {
      method: "POST",
      body: {
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
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
// Studio-IDE-13 (#255): POST /api/v0/verify
// ---------------------------------------------------------------------------

test("POST /api/v0/verify returns 400 when runId is missing", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: { javaFiles: [{ path: "Foo.java", content: "class Foo {}" }] },
    });
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("runId"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 400 when javaFiles is missing", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: { runId: "run-1" },
    });
    assert.equal(response.status, 400);
    assert.ok((response.body as { error: string }).error.includes("javaFiles"));
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 413 when total content exceeds cap", async () => {
  const handler = createApp({
    config: { ...baseConfig, transformSourceMaxBytes: 10 },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: stubBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: {
        runId: "run-1",
        javaFiles: [
          { path: "Foo.java", content: "class Foo { /* lots of content */ }" },
        ],
      },
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify happy path returns 200 with verify response shape", async () => {
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: {
        runId: "run-abc",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
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
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: disabledBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: {
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
    assert.equal(response.status, 503);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/verify returns 503 when build-test-runner returns 5xx", async () => {
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: {
        runId: "run-1",
        javaFiles: [{ path: "Foo.java", content: "class Foo {}" }],
      },
    });
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
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/verify`, {
      method: "POST",
      body: {
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
      },
    });
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
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: explainRequestBody(),
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
    assert.deepEqual(body.budgetSnapshot, { limit: 3, used: 1, remaining: 2 });
    const redaction = body.redactionApplied as string[];
    // Union of studio + gateway redactions, order-insensitive.
    assert.equal(redaction.includes("ssn-us"), true);
    assert.equal(redaction.includes("customerName"), true);
    assert.equal(calls.length, 1);
    assert.equal(ledger.length, 1);
    const entry = ledger[0] as Record<string, unknown>;
    assert.equal(entry.kind, "editor_assist");
    assert.equal(entry.status, "success");
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
    );
    assert.deepEqual((budget.body as { budget: BudgetSnapshot }).budget, {
      limit: 3,
      used: 0,
      remaining: 3,
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
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: explainRequestBody(),
      },
    );
    assert.equal(response.status, 403);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, "policy_denied");
    assert.deepEqual(body.budgetSnapshot, { limit: 3, used: 1, remaining: 2 });
  } finally {
    await server.close();
  }
});

test("POST /api/v0/editor/explain maps gateway 504 to timeout with HTTP 504", async () => {
  const { client: gateway } = explainGateway({
    status: 504,
    body: { error: "slow" },
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
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
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

test("POST /api/v0/editor/explain maps gateway 500 to gateway_unavailable with HTTP 503", async () => {
  const { client: gateway } = explainGateway({
    status: 500,
    body: {
      error:
        "Traceback (most recent call last): leak\nsk-deadbeefdeadbeefdeadbeef",
    },
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
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    // Inject a 1-unit budget store so a single call exhausts the
    // session.
    editorAssistBudgets: createEditorAssistBudgetStore({ defaultLimit: 1 }),
  });
  const server = await startTestServer(handler);
  try {
    const first = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      body: explainRequestBody(),
    });
    assert.equal(first.status, 200);

    const second = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
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
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
    editorAssistBudgets: createEditorAssistBudgetStore({
      defaultLimit: 10,
      tenantDailyCap: 1,
    }),
  });
  const server = await startTestServer(handler);
  try {
    const first = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
      body: explainRequestBody({ sessionId: "sess-A" }),
    });
    assert.equal(first.status, 200);
    // Fresh sessionId, same tenantId — must still hit the daily cap.
    const second = await fetchJson(`${server.baseUrl}/api/v0/editor/explain`, {
      method: "POST",
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
  const { client: gateway } = explainGateway({
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
  } finally {
    await server.close();
  }
});

test("GET /api/v0/editor/budget returns the current session snapshot", async () => {
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
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/budget?sessionId=s-1&tenantId=t-1&userId=u-1`,
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.deepEqual(body.budget, { limit: 3, used: 0, remaining: 3 });
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

test("POST /api/v0/editor/explain falls back to local ledgerRef when gateway omits it", async () => {
  const { client: gateway } = explainGateway({
    status: 200,
    body: {
      explanation: "ok",
      invocationId: "mi-2",
      // No ledgerRef from gateway — BFF must emit the local placeholder.
    },
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
    const response = await fetchJson(
      `${server.baseUrl}/api/v0/editor/explain`,
      {
        method: "POST",
        body: explainRequestBody({ sessionId: "fallback-sess" }),
      },
    );
    assert.equal(response.status, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(
      typeof body.ledgerRef === "string" &&
        (body.ledgerRef as string).startsWith("edit-tenant-a-fallback-sess-"),
      true,
    );
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
  const handler = createApp({
    config: { ...baseConfig, modelGatewayUrl: "http://gateway" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    modelGateway: gateway,
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
  const handler = createApp({
    config: { ...baseConfig, experienceLearningUrl: "http://el.test" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: client,
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
    assert.equal(result.status, 202);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.schemaVersion, "v0");
    assert.equal(body.accepted, 1);
    assert.equal(body.forwarded, true);
    assert.equal(calls.length, 1);
    const forwarded = calls[0] as { events: Array<Record<string, unknown>> };
    assert.equal(forwarded.events.length, 1);
    assert.equal(forwarded.events[0]?.tenantId, "default");
    assert.equal(forwarded.events[0]?.userId, "local");
    assert.equal(typeof forwarded.events[0]?.receivedAt, "string");
  } finally {
    await server.close();
  }
});

test("editor telemetry route accepts 202 when upstream is disabled", async () => {
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
    assert.equal(result.status, 202);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.forwarded, false);
  } finally {
    await server.close();
  }
});

test("editor telemetry route returns 502 when upstream throws", async () => {
  const handler = createApp({
    config: { ...baseConfig, experienceLearningUrl: "http://el.test" },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    experienceLearning: brokenLearningTelemetry(),
    runStore: createRunStore(),
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

// Silence unused-import warnings under strict mode
void net;
