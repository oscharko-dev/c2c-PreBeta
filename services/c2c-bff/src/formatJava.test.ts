import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "./server";
import { createRunStore } from "./run-store";
import { loadConfig, type BffConfig } from "./config";
import {
  FORMAT_JAVA_SCHEMA_VERSION,
  normaliseUpstreamResponse,
  validateFormatJavaRequest,
} from "./formatJava";
import type {
  BuildTestRunnerClient,
  EvidenceClient,
  OrchestratorClient,
  UpstreamResponse,
} from "./upstream";
import type { SampleRegistry } from "./samples";

function emptySamples(): SampleRegistry {
  return {
    list() {
      return [];
    },
    get() {
      return undefined;
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
  formatJavaTimeoutMs: 1_000,
  formatJavaSourceMaxBytes: 4_096,
  upstreamTimeoutMs: 1_000,
  transformSourceMaxBytes: 1_000_000,
  artifactContentMaxBytes: 1_048_576,
  enableDiagnosticFixtures: false,
};

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

interface FakeRunnerOptions {
  response?: UpstreamResponse;
  error?: Error;
  onCall?: (payload: { content: string; filePath?: string }) => void;
}

function fakeBuildTestRunner(
  options: FakeRunnerOptions,
): BuildTestRunnerClient {
  return {
    enabled: true,
    async formatJava(payload) {
      options.onCall?.(payload);
      if (options.error) {
        throw options.error;
      }
      return options.response;
    },
    async runVerification() {
      return undefined;
    },
  };
}

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: http.RequestListener,
): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  const bodyBytes =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
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

test("loadConfig surfaces format-java defaults and overrides", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.formatJavaTimeoutMs, 5_000);
  assert.equal(defaults.formatJavaSourceMaxBytes, 1_048_576);
  assert.equal(defaults.buildTestRunnerUrl, "");
  assert.equal(defaults.buildTestRunnerControlToken, "");

  const overridden = loadConfig({
    C2C_BUILD_TEST_RUNNER_URL: "http://btr.local:8084",
    C2C_BUILD_TEST_RUNNER_CONTROL_TOKEN: "secret",
    C2C_FORMAT_JAVA_TIMEOUT_MS: "2500",
    C2C_FORMAT_JAVA_SOURCE_MAX_BYTES: "65536",
  });
  assert.equal(overridden.buildTestRunnerUrl, "http://btr.local:8084");
  assert.equal(overridden.buildTestRunnerControlToken, "secret");
  assert.equal(overridden.formatJavaTimeoutMs, 2_500);
  assert.equal(overridden.formatJavaSourceMaxBytes, 65_536);
});

test("validateFormatJavaRequest rejects non-object bodies", () => {
  for (const raw of [null, [], 42, "string", undefined]) {
    const result = validateFormatJavaRequest(raw, { maxContentBytes: 100 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "format_input_invalid");
    }
  }
});

test("validateFormatJavaRequest rejects missing or non-string content", () => {
  const result = validateFormatJavaRequest(
    { content: 42 },
    { maxContentBytes: 100 },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.body.code, "format_input_invalid");
  }
});

test("validateFormatJavaRequest rejects oversized content with 413", () => {
  const content = "x".repeat(200);
  const result = validateFormatJavaRequest(
    { content },
    { maxContentBytes: 100 },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.equal(result.body.code, "format_input_too_large");
  }
});

test("validateFormatJavaRequest accepts an optional filePath", () => {
  const result = validateFormatJavaRequest(
    { content: "public class A {}", filePath: "src/A.java" },
    { maxContentBytes: 4096 },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.filePath, "src/A.java");
  }
});

test("validateFormatJavaRequest rejects empty filePath", () => {
  const result = validateFormatJavaRequest(
    { content: "class A {}", filePath: "" },
    { maxContentBytes: 4096 },
  );
  assert.equal(result.ok, false);
});

test("normaliseUpstreamResponse maps 200 + formattedContent to ok", () => {
  const result = normaliseUpstreamResponse({
    status: 200,
    body: { schemaVersion: "v0", formattedContent: "ok" },
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.body.formattedContent, "ok");
    assert.equal(result.body.schemaVersion, FORMAT_JAVA_SCHEMA_VERSION);
  }
});

test("normaliseUpstreamResponse maps 422 to format_parse_error with line/column", () => {
  const result = normaliseUpstreamResponse({
    status: 422,
    body: {
      schemaVersion: "v0",
      status: "failed",
      error: "missing semicolon",
      line: 10,
      column: 5,
    },
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.equal(result.status, 422);
    assert.equal(result.body.code, "format_parse_error");
    assert.equal(result.body.line, 10);
    assert.equal(result.body.column, 5);
  }
});

test("normaliseUpstreamResponse coerces unexpected payloads to format_upstream_error", () => {
  const noContent = normaliseUpstreamResponse({ status: 200, body: {} });
  assert.equal(noContent.kind, "error");
  if (noContent.kind === "error") {
    assert.equal(noContent.body.code, "format_upstream_error");
  }
  const upstream5xx = normaliseUpstreamResponse({
    status: 500,
    body: { error: "internal" },
  });
  assert.equal(upstream5xx.kind, "error");
  if (upstream5xx.kind === "error") {
    assert.equal(upstream5xx.status, 502);
    assert.equal(upstream5xx.body.error, "internal");
  }
});

test("POST /api/v0/format/java returns 503 when build-test-runner is disabled", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: disabledBuildTestRunner(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: "public class A {}",
    });
    assert.equal(result.status, 503);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.status, "failed");
    assert.equal(body.code, "format_unavailable");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java rejects malformed JSON with 400", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({}),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const target = new URL(`${server.baseUrl}/api/v0/format/java`);
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            method: "POST",
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            headers: {
              "content-type": "application/json",
              "content-length": "5",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf-8"),
              });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write("not-j");
        req.end();
      },
    );
    assert.equal(result.status, 400);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    assert.equal(parsed.code, "format_unavailable");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java rejects oversize body with 413", async () => {
  const handler = createApp({
    config: { ...baseConfig, formatJavaSourceMaxBytes: 32 },
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({}),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: "x".repeat(64),
    });
    assert.equal(result.status, 413);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.code, "format_unavailable");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java rejects non-string content with 400", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({}),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: 42,
    });
    assert.equal(result.status, 400);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.code, "format_input_invalid");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java proxies a successful upstream response", async () => {
  const captured: Array<{ content: string; filePath?: string }> = [];
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({
      onCall: (payload) => captured.push(payload),
      response: {
        status: 200,
        body: {
          schemaVersion: "v0",
          formattedContent: "public class A {}\n",
        },
      },
    }),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: "public class A{}",
      filePath: "src/A.java",
    });
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.formattedContent, "public class A {}\n");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.filePath, "src/A.java");
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java surfaces upstream 422 parse errors", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({
      response: {
        status: 422,
        body: {
          schemaVersion: "v0",
          status: "failed",
          error: "syntax error",
          line: 4,
          column: 12,
        },
      },
    }),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: "public class A {",
    });
    assert.equal(result.status, 422);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.code, "format_parse_error");
    assert.equal(body.line, 4);
    assert.equal(body.column, 12);
  } finally {
    await server.close();
  }
});

test("POST /api/v0/format/java surfaces upstream throw as 503", async () => {
  const handler = createApp({
    config: baseConfig,
    samples: emptySamples(),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    buildTestRunner: fakeBuildTestRunner({
      error: new Error("connect ECONNREFUSED"),
    }),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const result = await postJson(`${server.baseUrl}/api/v0/format/java`, {
      content: "public class A {}",
    });
    assert.equal(result.status, 503);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.code, "format_unavailable");
  } finally {
    await server.close();
  }
});
