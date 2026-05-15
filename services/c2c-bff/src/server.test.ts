import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

import { createApp } from './server';
import { createRunStore } from './run-store';
import { PLACEHOLDER_JAVA_MARKERS, findPlaceholderMarker } from './placeholder-markers';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SampleDetail, SampleRegistry, SampleSummary } from './samples';
import {
  createEvidenceClient,
  createOrchestratorClient,
  type EvidenceClient,
  type HttpClient,
  type HttpRequestOptions,
  type OrchestratorClient,
  type UpstreamResponse,
} from './upstream';
import type { BffConfig } from './config';

const FIXED_SAMPLE: SampleDetail = {
  programId: 'BRNCH01',
  title: 'Branch approval guard',
  description: 'fixture sample',
  knownDivergenceAtW0: false,
  supportedInProductMode: true,
  w0Subset: ['MOVE', 'PERFORM', 'EVALUATE', 'ADD', 'DISPLAY'],
  oracleMode: 'cobol-runtime',
  knownLimitations: [],
  cobolSource: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. BRNCH01.\n',
  cobolSourcePath: 'corpus/synthetic/programs/branch-account-guard.cbl',
  expectedOutput: 'APPROVED-COUNT=2\nREJECTED-COUNT=2\n',
  expectedOutputPath: 'corpus/synthetic/fixtures/branch-account-guard-output.txt',
};

const FIXED_SAMPLE_2: SampleDetail = {
  ...FIXED_SAMPLE,
  programId: 'BATCH01',
  knownDivergenceAtW0: false,
  w0Subset: ['PERFORM', 'COMPUTE', 'ADD', 'DISPLAY'],
  oracleMode: 'synthetic-fixture',
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
  generatedFile?: UpstreamResponse | ((path: string) => UpstreamResponse | undefined);
  buildTest?: UpstreamResponse;
  evidence?: UpstreamResponse;
  events?: UpstreamResponse;
  artifacts?: UpstreamResponse;
  progress?: UpstreamResponse;
  learning?: UpstreamResponse;
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
  };
  const client: OrchestratorClient = {
    enabled: true,
    async startRun() {
      calls.startRun += 1;
      const response: UpstreamResponse = {
        status: 201,
        body: {
          run: {
            runId: 'live-run-1',
            workflowId: 'w0-migration-v0',
            status: 'updating',
            policyDecision: 'allow',
            message: 'orchestrator accepted',
            evidenceRefs: ['urn:evidence/live-1'],
          },
          status: 'started',
          message: 'orchestrator run started',
        },
      };
      return response;
    },
    async getRun() {
      calls.getRun += 1;
      return {
        status: 200,
        body: {
          runId: 'live-run-1',
          workflowId: 'w0-migration-v0',
          status: 'completed',
          policyDecision: 'allow',
          message: 'orchestrator finished',
          evidenceRefs: ['urn:evidence/live-1'],
        },
      };
    },
    async startTransformRun(input) {
      calls.startTransformRun.push({ ...input });
      return {
        status: 201,
        body: {
          run: {
            runId: 'live-transform-1',
            workflowId: 'w0-migration-v0',
            status: 'updating',
            policyDecision: 'allow',
            message: 'orchestrator accepted transform',
            evidenceRefs: ['urn:evidence/live-transform-1'],
          },
          status: 'started',
          message: 'orchestrator transform started',
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
      if (typeof responder === 'function') {
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
      return { status: 200, body: { packId: 'epk-live-1' } };
    },
  };
}

const baseConfig: BffConfig = {
  serviceName: 'c2c-bff',
  port: 0,
  repoRoot: '/tmp/c2c-test-root',
  staticRoot: '/tmp/c2c-test-static-does-not-exist',
  orchestratorUrl: '',
  evidenceUrl: '',
  experienceLearningUrl: '',
  modelGatewayUrl: '',
  harnessUrl: '',
  upstreamTimeoutMs: 1_000,
  transformSourceMaxBytes: 1_000_000,
  enableDiagnosticFixtures: false,
};

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(handler: http.RequestListener): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  const bodyBytes = init?.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: init?.method ?? 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          accept: 'application/json',
          ...(bodyBytes ? { 'content-type': 'application/json', 'content-length': String(bodyBytes.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
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
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyBytes) req.write(bodyBytes);
    req.end();
  });
}

test('placeholder marker list is non-empty and exposes the documented W0 stubs', () => {
  assert.ok(PLACEHOLDER_JAVA_MARKERS.length >= 2);
  assert.equal(findPlaceholderMarker('public class C {}'), null);
  assert.equal(findPlaceholderMarker('// W0-STUB BRNCH01'), 'W0-STUB');
  assert.equal(findPlaceholderMarker('Synthetic W0 generated-Java stub here'), 'Synthetic W0 generated-Java stub');
});

test('BFF and UI placeholder marker lists are kept in sync', () => {
  // The UI ships its own copy of the placeholder marker list because the two
  // packages do not share a TypeScript module. The lists must remain byte
  // identical so the BFF safeguard matches the UI fallback exactly.
  const uiCopyPath = path.resolve(__dirname, '..', '..', '..', 'apps', 'c2c-ui', 'src', 'placeholder-markers.ts');
  assert.ok(fs.existsSync(uiCopyPath), `UI placeholder-markers.ts not found at ${uiCopyPath}`);
  const uiSource = fs.readFileSync(uiCopyPath, 'utf8');
  for (const marker of PLACEHOLDER_JAVA_MARKERS) {
    const literal = `'${marker}'`;
    assert.ok(
      uiSource.includes(literal),
      `UI placeholder-markers.ts is out of sync: missing marker ${literal}`,
    );
  }
});

test('health endpoint reports service name', async () => {
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
    assert.deepEqual(result.body, { status: 'ok', service: 'c2c-bff' });
  } finally {
    await server.close();
  }
});

test('mode endpoint flips with upstream enabled-ness', async () => {
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
    assert.deepEqual(result.body, { orchestrator: 'live', evidence: 'live' });
  } finally {
    await server.close();
  }
});

test('samples list and detail return registry contents including reference-program contract', async () => {
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
    assert.deepEqual(summaries.map((entry) => entry.programId).sort(), ['BATCH01', 'BRNCH01']);
    for (const summary of summaries) {
      assert.equal(summary.supportedInProductMode, true);
      assert.ok(summary.w0Subset.length > 0, `${summary.programId} must declare w0Subset`);
      assert.ok(
        summary.oracleMode === 'cobol-runtime' || summary.oracleMode === 'synthetic-fixture',
        `${summary.programId} must declare oracleMode`,
      );
      assert.ok(Array.isArray(summary.knownLimitations), `${summary.programId} knownLimitations array`);
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
    assert.equal(body.programId, 'BRNCH01');
    assert.match(body.expectedOutput, /APPROVED-COUNT/);
    assert.equal(body.supportedInProductMode, true);
    assert.deepEqual(body.w0Subset, ['MOVE', 'PERFORM', 'EVALUATE', 'ADD', 'DISPLAY']);
    assert.equal(body.oracleMode, 'cobol-runtime');

    const missing = await fetchJson(`${server.baseUrl}/api/v0/samples/UNKNOWN`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('transform refuses to dispatch a programId that maps to an unsupported reference', async () => {
  const unsupported: SampleDetail = {
    ...FIXED_SAMPLE,
    programId: 'UNSUP01',
    supportedInProductMode: false,
    w0Subset: [],
    oracleMode: null,
    knownLimitations: ['no W0 coverage'],
  };
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: stubSamples([unsupported]),
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const response = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: {
        sourceText: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. UNSUP01.\n',
      },
    });
    assert.equal(response.status, 400);
    const body = response.body as { error: string };
    assert.match(body.error, /UNSUP01/);
    assert.match(body.error, /supportedInProductMode/i);
    assert.equal(calls.startTransformRun.length, 0, 'orchestrator must not be called for unsupported reference');
  } finally {
    await server.close();
  }
});

test('every shipped reference program is loadable and routes its source through /api/v0/transform', async () => {
  // Service-level integration: prove the GET /samples/:id → POST /transform path
  // works for every shipped reference program (Issue #94 acceptance criterion).
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const { loadSampleRegistry } = await import('./samples');
  const realRegistry = loadSampleRegistry(repoRoot);
  const summaries = realRegistry.list().filter((s) => s.supportedInProductMode);
  assert.ok(summaries.length >= 4, `expected at least 4 runnable reference programs, got ${summaries.length}`);

  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: realRegistry,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    for (const summary of summaries) {
      const detailResp = await fetchJson(`${server.baseUrl}/api/v0/samples/${encodeURIComponent(summary.programId)}`);
      assert.equal(detailResp.status, 200, `GET /samples/${summary.programId} must return 200`);
      const detail = detailResp.body as { cobolSource: string; programId: string };
      assert.ok(detail.cobolSource.length > 0, `cobolSource must be present for ${summary.programId}`);

      const before = calls.startTransformRun.length;
      const transformResp = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
        method: 'POST',
        body: { sourceText: detail.cobolSource, programId: detail.programId },
      });
      assert.equal(transformResp.status, 201, `POST /transform must accept ${summary.programId}`);
      assert.equal(
        calls.startTransformRun.length,
        before + 1,
        `orchestrator.startTransformRun must be called exactly once for ${summary.programId}`,
      );
      const lastCall = calls.startTransformRun[calls.startTransformRun.length - 1];
      assert.ok(lastCall, 'expected a recorded call');
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

test('product mode rejects POST /api/v0/runs with 503 when orchestrator is missing and diagnostic fixtures are not enabled', async () => {
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
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(blocked.status, 503);
    assert.match((blocked.body as { error: string }).error, /product mode not ready/i);
    assert.match((blocked.body as { error: string }).error, /C2C_ORCHESTRATOR_URL/);
    assert.match((blocked.body as { error: string }).error, /C2C_ENABLE_DIAGNOSTIC_FIXTURES/);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('diagnostic fixture mode is opt-in, produces diagnostic-fixture run mode, and productMode is unavailable', async () => {
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
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);
    const runBody = started.body as {
      runId: string;
      mode: string;
      productMode: string;
      status: string;
      evidenceRefs: string[];
    };
    assert.equal(runBody.mode, 'diagnostic-fixture');
    assert.equal(runBody.productMode, 'unavailable');
    assert.equal(runBody.status, 'completed');
    assert.ok(runBody.evidenceRefs.length > 0);

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const genBody = generated.body as {
      mode: string;
      productMode: string;
      status: string;
      files: Record<string, string>;
      unsupportedFeatures: string[];
    };
    assert.equal(genBody.mode, 'diagnostic-fixture');
    assert.equal(genBody.productMode, 'unavailable');
    assert.equal(genBody.status, 'generated');
    assert.ok(Object.keys(genBody.files).length > 0);
    assert.equal(genBody.unsupportedFeatures.length, 0);

    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/build-test`);
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as { mode: string; productMode: string; status: string; classification: string; expectedOutput: string };
    assert.equal(btBody.mode, 'diagnostic-fixture');
    assert.equal(btBody.productMode, 'unavailable');
    assert.equal(btBody.status, 'ok');
    assert.equal(btBody.classification, 'match');
    assert.match(btBody.expectedOutput, /APPROVED-COUNT/);

    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/evidence`);
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as { mode: string; productMode: string; packId: string; manifestUri: string };
    assert.equal(evBody.mode, 'diagnostic-fixture');
    assert.equal(evBody.productMode, 'unavailable');
    assert.ok(evBody.packId.startsWith('epk-'));
    assert.ok(evBody.manifestUri.length > 0);
  } finally {
    await server.close();
  }
});

test('starting a run surfaces orchestrator failures instead of silently falling back to mock', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const failingOrchestrator: OrchestratorClient = {
    enabled: true,
    async startRun() {
      throw new Error('upstream offline');
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
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: failingOrchestrator,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(failed.status, 502);
    assert.match((failed.body as { error: string }).error, /upstream offline/);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('starting a run with orchestrator non-2xx response returns 502 and creates no run', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const rejectingOrchestrator: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return { status: 500, body: { error: 'orchestrator internal error' } };
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
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: rejectingOrchestrator,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const failed = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(failed.status, 502);
    assert.match((failed.body as { error: string }).error, /500/);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('starting a run in live mode proxies the orchestrator, syncs status, and reports incomplete artifacts when orchestrator has no data yet', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as {
      runId: string;
      mode: string;
      status: string;
      productMode: string;
      orchestratorRunId: string;
    };
    assert.equal(startedBody.mode, 'live');
    // RunSummary.productMode is 'live' whenever stored mode is 'live'; per-artifact
    // productMode is downgraded to 'unavailable' when upstream payload is incomplete.
    assert.equal(startedBody.productMode, 'live');
    assert.equal(startedBody.orchestratorRunId, 'live-run-1');
    assert.equal(calls.startRun, 1);

    const fetched = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}`);
    assert.equal(fetched.status, 200);
    const fetchedBody = fetched.body as { mode: string; status: string };
    assert.equal(fetchedBody.mode, 'live');
    assert.equal(fetchedBody.status, 'completed');
    assert.equal(calls.getRun, 1);

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const genBody = generated.body as { mode: string; status: string; missingArtifacts: string[] };
    assert.equal(genBody.mode, 'live');
    assert.equal(genBody.status, 'incomplete');
    assert.deepEqual(genBody.missingArtifacts, ['generation-response']);
    assert.equal(calls.getGenerated, 1);

    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`);
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as { mode: string; status: string; classification: string; missingArtifacts: string[] };
    assert.equal(btBody.mode, 'live');
    assert.equal(btBody.status, 'incomplete');
    assert.equal(btBody.classification, 'skipped-no-execution');
    assert.deepEqual(btBody.missingArtifacts, ['build-test-result']);
    assert.equal(calls.getBuildTest, 1);

    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`);
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as { mode: string; status: string; packId: string; missingArtifacts: string[] };
    assert.equal(evBody.mode, 'live');
    assert.equal(evBody.status, 'incomplete');
    assert.equal(evBody.packId, '');
    assert.deepEqual(evBody.missingArtifacts, ['evidence-pack-manifest']);
    assert.equal(calls.getEvidence, 1);
  } finally {
    await server.close();
  }
});

test('live generated/build-test/evidence endpoints return real artifact contents when orchestrator has persisted them', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const generatedJava = 'package c2c;\npublic final class CASE01 {\n    public static void main(String[] a) {}\n}\n';
  const buildResult = {
    status: 'ok',
    classification: 'match',
    actualOutput: 'APPROVED-COUNT=2\nREJECTED-COUNT=2\n',
    outputRef: { uri: 'file:///run/build-test/output.txt', sha256: 'b'.repeat(64), byteSize: 32 },
    programId: 'CASE01',
  };
  const evidenceManifest = {
    runId: 'live-run-1',
    workflowId: 'w0-migration-v0',
    status: 'complete',
    packId: 'epk-live-1',
    artifacts: { sourceCobol: [], generatedJava: { uri: 'file:///run/generated.java' } },
  };
  const trajectoryEvents = [
    { type: 'parse-cobol.executed', status: 'ok', message: 'parse complete', createdAt: '2026-05-14T10:00:00Z' },
    { type: 'generate-java.executed', status: 'ok', message: 'java generated', createdAt: '2026-05-14T10:00:05Z' },
  ];
  const { client: orch, calls } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        entryClass: 'CASE01',
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        fileCount: 1,
        files: { 'src/main/java/c2c/CASE01.java': generatedJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: { uri: 'file:///run/generation-response.json', sha256: 'a'.repeat(64), byteSize: 128 },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        kind: 'build-test-result',
        data: buildResult,
        artifactRef: { uri: 'file:///run/build-test-result.json', sha256: 'c'.repeat(64), byteSize: 256 },
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        data: evidenceManifest,
        artifactRef: { uri: 'file:///run/evidence-pack-manifest.json', sha256: 'd'.repeat(64), byteSize: 512 },
      },
    },
    events: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        events: trajectoryEvents,
      },
    },
    artifacts: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        artifacts: [
          { uri: 'file:///run/source.cbl', sha256: 'a'.repeat(64), byteSize: 64, kind: 'source', path: 'source.cbl', name: 'source.cbl' },
        ],
        createdAt: '2026-05-14T10:00:00Z',
        updatedAt: '2026-05-14T10:00:30Z',
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const genBody = generated.body as { mode: string; status: string; files: Record<string, string>; entryClass: string };
    assert.equal(genBody.mode, 'live');
    assert.equal(genBody.status, 'generated');
    assert.equal(genBody.entryClass, 'CASE01');
    assert.equal(genBody.files['src/main/java/c2c/CASE01.java'], generatedJava);
    assert.equal(calls.getGenerated, 1);

    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`);
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as { mode: string; status: string; classification: string; actualOutput: string };
    assert.equal(btBody.mode, 'live');
    assert.equal(btBody.status, 'ok');
    assert.equal(btBody.classification, 'match');
    assert.match(btBody.actualOutput, /APPROVED-COUNT=2/);

    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`);
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as { mode: string; status: string; packId: string; manifestUri: string; missingArtifacts: string[] };
    assert.equal(evBody.mode, 'live');
    assert.equal(evBody.status, 'complete');
    assert.equal(evBody.packId, 'epk-live-1');
    assert.equal(evBody.manifestUri, 'file:///run/evidence-pack-manifest.json');
    assert.deepEqual(evBody.missingArtifacts, []);

    const events = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/events`);
    assert.equal(events.status, 200);
    const evtBody = events.body as { mode: string; events: Array<{ type: string }>; missingArtifacts: string[] };
    assert.equal(evtBody.mode, 'live');
    assert.equal(evtBody.events.length, 2);
    assert.equal(evtBody.events[0]?.type, 'parse-cobol.executed');
    assert.deepEqual(evtBody.missingArtifacts, []);

    const artifacts = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/artifacts`);
    assert.equal(artifacts.status, 200);
    const artBody = artifacts.body as { mode: string; artifacts: Array<{ path: string }>; programId: string };
    assert.equal(artBody.mode, 'live');
    assert.equal(artBody.programId, 'BRNCH01');
    assert.equal(artBody.artifacts.length, 1);
    assert.equal(artBody.artifacts[0]?.path, 'source.cbl');
  } finally {
    await server.close();
  }
});

test('live generated endpoint exposes outputRef, diagnostics, and rejects placeholder markers from upstream payload', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const generatedJava = 'package c2c;\npublic final class CASE01 {\n    public static void main(String[] a) { System.out.println("APPROVED-COUNT=2"); }\n}\n';
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        entryClass: 'CASE01',
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        fileCount: 1,
        files: { 'src/main/java/c2c/CASE01.java': generatedJava },
        unsupportedFeatures: [],
        openAssumptions: ['IO limited to stdout'],
        generationResponse: {
          diagnostics: [
            { level: 'info', code: 'gen.start', message: 'generation started' },
            { level: 'info', code: 'gen.complete', message: 'generation complete' },
          ],
        },
        generationResponseRef: { uri: 'file:///run/generation-response.json', sha256: 'a'.repeat(64), byteSize: 128 },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const body = generated.body as {
      status: string;
      outputRef: { uri: string; sha256: string; byteSize?: number } | null;
      diagnostics: Array<{ code?: string }>;
      files: Record<string, string>;
    };
    assert.equal(body.status, 'generated');
    assert.ok(body.outputRef, 'outputRef must be present for successful runs');
    assert.equal(body.outputRef?.uri, 'file:///run/generation-response.json');
    assert.equal(body.outputRef?.sha256, 'a'.repeat(64));
    assert.equal(body.diagnostics.length, 2);
    assert.equal(body.diagnostics[0]?.code, 'gen.start');
    // Critical safeguard: successful runs must NOT contain placeholder markers.
    for (const content of Object.values(body.files)) {
      assert.doesNotMatch(content, /W0-STUB/, 'placeholder marker detected in generated Java for a successful run');
      assert.doesNotMatch(content, /Synthetic W0/, 'placeholder marker detected in generated Java for a successful run');
    }
  } finally {
    await server.close();
  }
});

test('live generated endpoint downgrades successful runs containing placeholder Java to incomplete', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  // Simulate a misbehaving upstream that returns a "complete" envelope but
  // the generated Java still contains the W0-STUB placeholder marker. The
  // BFF must refuse to surface this as `status: 'generated'`.
  const placeholderJava = [
    '// Synthetic W0 generated-Java stub for programId=CASE01.',
    'package c2c.w0.generated;',
    'public final class CASE01 {',
    '    public static void main(String[] args) {',
    '        System.out.println("W0-STUB CASE01");',
    '    }',
    '}',
  ].join('\n');
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        entryClass: 'CASE01',
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        fileCount: 1,
        files: { 'src/main/java/c2c/CASE01.java': placeholderJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: { uri: 'file:///run/generation-response.json', sha256: 'a'.repeat(64), byteSize: 128 },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const body = generated.body as {
      status: string;
      missingArtifacts: string[];
      placeholderViolation: { path: string; marker: string };
      note: string;
    };
    assert.equal(body.status, 'incomplete');
    assert.ok(body.missingArtifacts.includes('real-generated-java'));
    assert.equal(body.placeholderViolation.marker, 'W0-STUB');
    assert.equal(body.placeholderViolation.path, 'src/main/java/c2c/CASE01.java');
    assert.match(body.note, /Placeholder marker/);
  } finally {
    await server.close();
  }
});

test('live build-test extracts execution.stdout, goldenMaster.expected, outputRef, diagnostics, and compile/execution status', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const buildResult = {
    status: 'ok',
    classification: 'match',
    build: { compileOk: true, sourceCount: 1, diagnostics: [] },
    execution: { ran: true, ok: true, exitCode: 0, stdout: 'APPROVED-COUNT=2\nREJECTED-COUNT=2\n', stderr: '', durationMs: 12 },
    goldenMaster: { expected: 'APPROVED-COUNT=2\nREJECTED-COUNT=2\n', expectedOutputPath: 'corpus/expected.txt' },
    comparison: { matched: true },
    diagnostics: [
      { level: 'info', code: 'compile.ok', message: 'compile succeeded' },
      { level: 'info', code: 'execution.ok', message: 'execution succeeded' },
    ],
    outputRef: { uri: 'file:///run/build-test-result.json', sha256: 'c'.repeat(64), byteSize: 256 },
    programId: 'CASE01',
  };
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        kind: 'build-test-result',
        data: buildResult,
        artifactRef: { uri: 'file:///run/build-test-result.json', sha256: 'c'.repeat(64), byteSize: 256 },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`);
    assert.equal(buildTest.status, 200);
    const body = buildTest.body as {
      status: string;
      classification: string;
      compileStatus: string;
      executionStatus: string;
      expectedOutput: string;
      actualOutput: string;
      outputRef: { uri: string; sha256: string } | null;
      diagnostics: Array<{ code?: string }>;
    };
    assert.equal(body.status, 'ok');
    assert.equal(body.classification, 'match');
    assert.equal(body.compileStatus, 'ok');
    assert.equal(body.executionStatus, 'ok');
    assert.match(body.actualOutput, /APPROVED-COUNT=2/);
    assert.match(body.expectedOutput, /APPROVED-COUNT=2/);
    assert.equal(body.outputRef?.uri, 'file:///run/build-test-result.json');
    assert.equal(body.outputRef?.sha256, 'c'.repeat(64));
    assert.equal(body.diagnostics.length, 2);
    assert.equal(body.diagnostics[0]?.code, 'compile.ok');
  } finally {
    await server.close();
  }
});

test('live build-test surfaces compile failure as compileStatus=failed and executionStatus=not-run', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const buildResult = {
    status: 'compile-failed',
    classification: 'compile-error',
    build: { compileOk: false, sourceCount: 1, diagnostics: [{ level: 'error', code: 'javac', message: 'cannot resolve symbol' }] },
    execution: { ran: false, ok: false, stdout: '', stderr: '' },
    goldenMaster: {},
    comparison: {},
    diagnostics: [{ level: 'error', code: 'javac', message: 'cannot resolve symbol' }],
    outputRef: { uri: 'file:///run/build-test-result.json', sha256: 'd'.repeat(64) },
  };
  const { client: orch } = stubOrchestrator({
    buildTest: {
      status: 200,
      body: {
        runId: 'live-run-1',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        kind: 'build-test-result',
        data: buildResult,
        artifactRef: { uri: 'file:///run/build-test-result.json', sha256: 'd'.repeat(64) },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`);
    const body = buildTest.body as {
      status: string;
      compileStatus: string;
      executionStatus: string;
      actualOutput: string;
    };
    assert.equal(body.status, 'compile-failed');
    assert.equal(body.compileStatus, 'failed');
    assert.equal(body.executionStatus, 'not-run');
    assert.equal(body.actualOutput, '');
  } finally {
    await server.close();
  }
});

test('live evidence exposes manifestHash, validationStatus, exportRef, and aggregates missing artifacts', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const manifest = {
    schemaVersion: 'v0',
    capability: 'evidence.pack',
    service: 'evidence-service',
    packId: 'epk-live-1',
    runId: 'live-run-1',
    wave: 'w0',
    status: 'incomplete',
    createdAt: '2026-05-14T10:00:30Z',
    artifacts: {},
    validation: {
      status: 'incomplete',
      requiredArtifacts: ['sourceCobol', 'semanticIr', 'generatedJava'],
      missingArtifacts: ['semanticIr'],
      messages: [],
    },
    exports: [
      { format: 'tar.gz', uri: 'file:///run/evidence-pack.tar.gz', sha256: 'e'.repeat(64), byteSize: 1024, createdAt: '2026-05-14T10:00:30Z' },
    ],
  };
  const { client: orch } = stubOrchestrator({
    evidence: {
      status: 200,
      body: {
        runId: 'live-run-1',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        data: manifest,
        artifactRef: { uri: 'file:///run/evidence-pack-manifest.json', sha256: 'f'.repeat(64), byteSize: 768 },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`);
    const body = evidence.body as {
      status: string;
      packId: string;
      manifestUri: string;
      manifestHash: string;
      validationStatus: string;
      missingArtifacts: string[];
      exportRef: { uri: string; sha256: string } | null;
    };
    assert.equal(body.status, 'incomplete');
    assert.equal(body.packId, 'epk-live-1');
    assert.equal(body.manifestUri, 'file:///run/evidence-pack-manifest.json');
    assert.equal(body.manifestHash, 'f'.repeat(64));
    assert.equal(body.validationStatus, 'incomplete');
    assert.deepEqual(body.missingArtifacts, ['semanticIr']);
    assert.equal(body.exportRef?.uri, 'file:///run/evidence-pack.tar.gz');
    assert.equal(body.exportRef?.sha256, 'e'.repeat(64));
  } finally {
    await server.close();
  }
});

test('live evidence with missing manifest reports incomplete status and zero pack id; never claims complete', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch } = stubOrchestrator(); // no evidence stub => returns undefined
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };
    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`);
    const body = evidence.body as { status: string; packId: string; manifestUri: string; missingArtifacts: string[]; validationStatus: string };
    assert.equal(body.status, 'incomplete');
    assert.equal(body.packId, '');
    assert.equal(body.manifestUri, '');
    assert.equal(body.validationStatus, 'unknown');
    assert.deepEqual(body.missingArtifacts, ['evidence-pack-manifest']);
  } finally {
    await server.close();
  }
});

test('transform rejects blank source text and does not create a run', async () => {
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
      method: 'POST',
      body: { sourceText: '   ' },
    });
    assert.equal(rejected.status, 400);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('transform fails clearly when orchestrator url is missing', async () => {
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
      method: 'POST',
      body: { sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. TRANS01.\n' },
    });
    assert.equal(rejected.status, 503);
    assert.match((rejected.body as { error: string }).error, /orchestrator URL/i);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('transform derives program id, calls orchestrator, and returns the full transform contract', async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText = '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n';
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: { sourceText, sourceName: 'hello.cbl', options: { explain: true } },
    });
    assert.equal(started.status, 201);
    assert.equal(calls.startTransformRun.length, 1);
    assert.deepEqual(calls.startTransformRun[0], {
      programId: 'HELLO01',
      sourceText,
      requester: 'c2c-ui',
      sourceName: 'hello.cbl',
      options: { explain: true },
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
    assert.equal(body.programId, 'HELLO01');
    assert.equal(body.mode, 'live');
    // TransformResponse extends RunSummary; productMode follows stored mode.
    assert.equal(body.productMode, 'live');
    assert.equal(body.orchestratorRunId, 'live-transform-1');
    assert.equal(body.status, 'updating');
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
    });
  } finally {
    await server.close();
  }
});

test('transform uses a deterministic fallback program id when none is provided', async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const sourceText = '       IDENTIFICATION DIVISION.\n       DISPLAY "NO PROGRAM ID".\n';
    const expectedProgramId = `SRC-${createHash('sha256').update(sourceText, 'utf8').digest('hex').slice(0, 12).toUpperCase()}`;
    const started = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: { sourceText },
    });
    assert.equal(started.status, 201);
    assert.equal(calls.startTransformRun[0]?.programId, expectedProgramId);
    assert.equal((started.body as { programId: string }).programId, expectedProgramId);
    assert.equal(runStore.list().length, 1);
  } finally {
    await server.close();
  }
});

test('transform does not create a run when the orchestrator returns a non-2xx status', async () => {
  const runStore = createRunStore();
  const client: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      return { status: 502, body: { error: 'upstream rejected' } };
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
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: client,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: { sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. FAIL01.\n' },
    });
    assert.equal(rejected.status, 502);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('transform does not create a run when the orchestrator throws', async () => {
  const runStore = createRunStore();
  const client: OrchestratorClient = {
    enabled: true,
    async startRun() {
      return undefined;
    },
    async startTransformRun() {
      throw new Error('boom');
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
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: client,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: { sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. FAIL02.\n' },
    });
    assert.equal(rejected.status, 502);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('transform rejects oversize source text before calling the orchestrator', async () => {
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream', transformSourceMaxBytes: 32 },
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: orch,
    evidence: disabledEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const rejected = await fetchJson(`${server.baseUrl}/api/v0/transform`, {
      method: 'POST',
      body: { sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. BIG01.\n' },
    });
    assert.equal(rejected.status, 413);
    assert.equal(calls.startTransformRun.length, 0);
    assert.equal(runStore.list().length, 0);
  } finally {
    await server.close();
  }
});

test('product transform calls only orchestrator URL, never capability endpoints', async () => {
  const observed: Array<{ url: string; method: string }> = [];
  const recordingHttp: HttpClient = {
    async request(targetUrl: string, options: HttpRequestOptions): Promise<UpstreamResponse> {
      observed.push({ url: targetUrl, method: options.method ?? 'GET' });
      return {
        status: 201,
        body: {
          run: {
            runId: 'orch-isolation-1',
            workflowId: 'w0-migration-v0',
            status: 'updating',
            policyDecision: 'allow',
            message: 'orchestrator accepted',
            evidenceRefs: [],
          },
          status: 'started',
          message: 'orchestrator run started',
        },
      };
    },
  };

  const orchestratorUrl = 'http://orchestrator.test';
  const evidenceUrl = 'http://evidence.test';
  const orchestrator = createOrchestratorClient(orchestratorUrl, recordingHttp, 1_000);
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
      method: 'POST',
      body: { sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. ISO01.\n' },
    });
    assert.equal(transformed.status, 201);

    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);

    assert.ok(observed.length >= 2, `expected upstream calls, observed=${observed.length}`);
    for (const call of observed) {
      assert.ok(
        call.url.startsWith(orchestratorUrl) || call.url.startsWith(evidenceUrl),
        `BFF must only call orchestrator or evidence URLs in product mode, observed ${call.method} ${call.url}`,
      );
    }
    const capabilityHints = ['/v0/parse', '/v0/ir', '/v0/generate', '/v0/run-verification', '/v0/invoke'];
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

test('rejects malformed run start bodies', async () => {
  const handler = createApp({
    config: baseConfig,
    samples: stubSamples([FIXED_SAMPLE]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const missing = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: {} });
    assert.equal(missing.status, 400);

    const unknown = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: { programId: 'NOPE' } });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test('returns 404 for unknown api paths and run ids', async () => {
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

    const unknownRun = await fetchJson(`${server.baseUrl}/api/v0/runs/run-bogus`);
    assert.equal(unknownRun.status, 404);
  } finally {
    await server.close();
  }
});

// Issue #96: progress + learning route contracts.

function disabledLearning(): { enabled: boolean; baseUrl: string; getRunSummary: () => Promise<undefined> } {
  return {
    enabled: false,
    baseUrl: '',
    async getRunSummary() {
      return undefined;
    },
  };
}

test('progress route proxies orchestrator step timeline for live runs', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator({
    progress: {
      status: 200,
      body: {
        runId: 'live-run-1',
        runStatus: 'updating',
        currentStep: 'generate-java',
        failedStep: null,
        completedSteps: ['accepted', 'parse-cobol', 'generate-ir'],
        stepCount: 4,
        steps: [
          {
            stepId: 1,
            name: 'accepted',
            capabilityId: 'orchestrator-service',
            service: 'orchestrator-service',
            actor: 'orchestrator-service',
            status: 'ok',
            startedAt: '2026-05-15T00:00:00Z',
            finishedAt: '2026-05-15T00:00:00Z',
          },
          {
            stepId: 2,
            name: 'parse-cobol',
            capabilityId: 'cobol.parse',
            service: 'orchestrator-service',
            actor: 'parser-service',
            status: 'ok',
            startedAt: '2026-05-15T00:00:01Z',
            finishedAt: '2026-05-15T00:00:02Z',
            inputRef: { uri: 'urn:in', sha256: 'a'.repeat(64), byteSize: 12 },
            outputRef: { uri: 'urn:out', sha256: 'b'.repeat(64), byteSize: 24 },
          },
          {
            stepId: 3,
            name: 'generate-ir',
            capabilityId: 'cobol.ir',
            service: 'orchestrator-service',
            actor: 'ir-service',
            status: 'ok',
            startedAt: '2026-05-15T00:00:03Z',
            finishedAt: '2026-05-15T00:00:04Z',
          },
          {
            stepId: 4,
            name: 'generate-java',
            capabilityId: 'java.generator',
            service: 'orchestrator-service',
            actor: 'generator-service',
            status: 'running',
            startedAt: '2026-05-15T00:00:05Z',
          },
        ],
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(created.status, 201);
    const runId = (created.body as { runId: string }).runId;

    const progress = await fetchJson(`${server.baseUrl}/api/v0/runs/${runId}/progress`);
    assert.equal(progress.status, 200);
    const body = progress.body as {
      status: string;
      runStatus: string;
      currentStep: string | null;
      failedStep: string | null;
      stepCount: number;
      steps: Array<{ name: string; status: string; capabilityId: string; stepId: number }>;
    };
    assert.equal(body.status, 'complete');
    assert.equal(body.runStatus, 'updating');
    assert.equal(body.currentStep, 'generate-java');
    assert.equal(body.failedStep, null);
    assert.equal(body.stepCount, 4);
    assert.equal(body.steps[3]?.status, 'running');
    assert.equal(body.steps[1]?.capabilityId, 'cobol.parse');
    assert.equal(calls.getProgress, 1);
  } finally {
    await server.close();
  }
});

test('progress route surfaces failed step diagnostic and never reports success', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch } = stubOrchestrator({
    progress: {
      status: 200,
      body: {
        runId: 'live-run-1',
        runStatus: 'failed',
        currentStep: null,
        failedStep: 'generate-java',
        completedSteps: ['accepted', 'parse-cobol', 'generate-ir'],
        stepCount: 5,
        steps: [
          { stepId: 1, name: 'accepted', capabilityId: 'orch', service: 'orch', actor: 'orch', status: 'ok' },
          { stepId: 2, name: 'parse-cobol', capabilityId: 'cobol.parse', service: 'orch', actor: 'parser', status: 'ok' },
          { stepId: 3, name: 'generate-ir', capabilityId: 'cobol.ir', service: 'orch', actor: 'ir', status: 'ok' },
          {
            stepId: 4,
            name: 'generate-java',
            capabilityId: 'java.generator',
            service: 'orch',
            actor: 'generator',
            status: 'failed',
            diagnostic: 'generator backend unavailable',
          },
          {
            stepId: 5,
            name: 'failed',
            capabilityId: 'orch',
            service: 'orch',
            actor: 'orch',
            status: 'failed',
            diagnostic: 'W0 migration workflow failed: step generate-java failed',
          },
        ],
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: { programId: 'BRNCH01' } });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(`${server.baseUrl}/api/v0/runs/${runId}/progress`);
    const body = progress.body as {
      runStatus: string;
      failedStep: string | null;
      steps: Array<{ name: string; status: string; diagnostic?: string }>;
    };
    assert.equal(body.runStatus, 'failed');
    assert.equal(body.failedStep, 'generate-java');
    const failedStep = body.steps.find((entry) => entry.name === 'generate-java');
    assert.ok(failedStep, 'failed step must be present in payload');
    assert.equal(failedStep?.status, 'failed');
    assert.match(failedStep?.diagnostic ?? '', /generator/i);
  } finally {
    await server.close();
  }
});

test('learning route prefers live experience-learning client when configured', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator();
  let learningCalls = 0;
  const liveLearning = {
    enabled: true,
    baseUrl: 'http://el.test',
    async getRunSummary(runId: string) {
      learningCalls += 1;
      return {
        status: 200,
        body: {
          runId,
          runStatus: 'completed',
          candidateCount: 2,
          candidateByPattern: { accepted_pattern: 2 },
          experienceEventIds: ['evt-1', 'evt-2'],
          observedPatterns: ['accepted_pattern'],
          observationOnly: true,
          policyVersion: 'v0',
        },
      };
    },
  };
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: liveLearning,
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: { programId: 'BRNCH01' } });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(`${server.baseUrl}/api/v0/runs/${runId}/learning`);
    assert.equal(learning.status, 200);
    const body = learning.body as { source: string; status: string; summary: { candidateCount: number; observedPatterns: string[] } | null; endpoint: string };
    assert.equal(body.source, 'live');
    assert.equal(body.status, 'complete');
    assert.equal(body.summary?.candidateCount, 2);
    assert.deepEqual(body.summary?.observedPatterns, ['accepted_pattern']);
    assert.match(body.endpoint, /\/v0\/runs\//);
    assert.equal(learningCalls, 1);
    assert.equal(calls.getLearning, 0, 'orchestrator fallback must not be called when EL is live');
  } finally {
    await server.close();
  }
});

test('learning route falls back to orchestrator-cached summary when EL is unavailable', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = stubOrchestrator({
    learning: {
      status: 200,
      body: {
        summary: { runId: 'live-run-1', candidateCount: 1, observedPatterns: ['repeat_action'] },
        endpoint: 'http://el.test/v0/runs/live-run-1/summary',
        source: 'cached',
        missingArtifacts: [],
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: disabledEvidence(),
    experienceLearning: disabledLearning(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: { programId: 'BRNCH01' } });
    const runId = (created.body as { runId: string }).runId;
    const learning = await fetchJson(`${server.baseUrl}/api/v0/runs/${runId}/learning`);
    const body = learning.body as { source: string; summary: { candidateCount: number } | null; endpoint: string };
    assert.equal(body.source, 'cached');
    assert.equal(body.summary?.candidateCount, 1);
    assert.equal(calls.getLearning, 1);
  } finally {
    await server.close();
  }
});

test('progress route is unavailable for diagnostic-fixture runs', async () => {
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
    const created = await fetchJson(`${server.baseUrl}/api/v0/runs`, { method: 'POST', body: { programId: 'BRNCH01' } });
    const runId = (created.body as { runId: string }).runId;
    const progress = await fetchJson(`${server.baseUrl}/api/v0/runs/${runId}/progress`);
    assert.equal(progress.status, 200);
    const body = progress.body as { mode: string; productMode: string; status: string };
    assert.equal(body.mode, 'diagnostic-fixture');
    assert.equal(body.productMode, 'unavailable');
    assert.equal(body.status, 'incomplete');
  } finally {
    await server.close();
  }
});

test('upstream experienceLearning client encodes run id and proxies summary', async () => {
  const { createNodeHttpClient, createExperienceLearningClient } = await import('./upstream');
  const httpClient = createNodeHttpClient();
  const observed: Array<{ url: string; method: string }> = [];
  const target = http.createServer((req, res) => {
    observed.push({ url: req.url ?? '', method: req.method ?? 'GET' });
    const body = JSON.stringify({ runId: 'r-1', candidateCount: 7 });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  try {
    const address = target.address() as net.AddressInfo;
    const client = createExperienceLearningClient(`http://127.0.0.1:${address.port}`, httpClient, 1_000);
    assert.equal(client.enabled, true);
    const result = await client.getRunSummary('run a/b');
    assert.equal(result?.status, 200);
    assert.equal(observed[0]?.url, '/v0/runs/run%20a%2Fb/summary');
  } finally {
    await new Promise<void>((resolve, reject) => target.close((err) => (err ? reject(err) : resolve())));
  }
});

test('product-mode responses never advertise diagnostic-fixture mode or unavailable productMode as a success', async () => {
  // Configure a live orchestrator that returns persisted artifacts so the BFF
  // can build a complete product-mode response. The guard scans every payload
  // for placeholder execution markers and verifies the contained productMode
  // signal is consistent with the artifact status.
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const generatedJava = 'package c2c;\npublic final class CASE01 { public static void main(String[] a) { System.out.println("APPROVED-COUNT=2"); } }\n';
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: 'live-run-1',
        programId: 'CASE01',
        runStatus: 'completed',
        missingArtifacts: [],
        entryClass: 'CASE01',
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        fileCount: 1,
        files: { 'src/main/java/c2c/CASE01.java': generatedJava },
        unsupportedFeatures: [],
        openAssumptions: [],
        generationResponseRef: { uri: 'file:///run/generation-response.json', sha256: 'a'.repeat(64), byteSize: 128 },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: 'live-run-1',
        programId: 'CASE01',
        runStatus: 'completed',
        missingArtifacts: [],
        kind: 'build-test-result',
        data: { status: 'ok', classification: 'match', actualOutput: 'APPROVED-COUNT=2\n' },
        artifactRef: { uri: 'file:///run/build-test-result.json', sha256: 'b'.repeat(64), byteSize: 32 },
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: 'live-run-1',
        programId: 'CASE01',
        runStatus: 'completed',
        missingArtifacts: [],
        data: { packId: 'epk-1', validation: { status: 'valid', missingArtifacts: [] }, exports: [] },
        artifactRef: { uri: 'file:///run/evidence-pack-manifest.json', sha256: 'c'.repeat(64), byteSize: 64 },
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);
    const startedBody = started.body as { runId: string; mode: string; productMode: string };
    assert.equal(startedBody.mode, 'live');
    assert.equal(startedBody.productMode, 'live');

    const endpoints = ['generated', 'build-test', 'evidence', 'events', 'artifacts'];
    for (const endpoint of endpoints) {
      const response = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/${endpoint}`);
      assert.equal(response.status, 200, `${endpoint} must respond 200 for a product run`);
      const payload = response.body as Record<string, unknown>;
      assert.equal(payload.mode, 'live', `${endpoint} must report mode=live for a product run`);
      // Scan the serialized payload for placeholder execution markers.
      const serialized = JSON.stringify(payload);
      for (const marker of PLACEHOLDER_JAVA_MARKERS) {
        assert.ok(
          !serialized.includes(marker),
          `${endpoint} product-mode response must not contain placeholder marker "${marker}"`,
        );
      }
      assert.ok(
        !serialized.includes('diagnostic-fixture'),
        `${endpoint} product-mode response must not contain the literal "diagnostic-fixture"`,
      );
    }
  } finally {
    await server.close();
  }
});

test('mock-data module has been quarantined and is not reachable through the product-mode server module graph', () => {
  // Issue #93: `mock-data.ts` must be deleted or moved into a quarantined
  // subdirectory so it cannot be imported by product-mode server code.
  const bffSrc = path.resolve(__dirname, '..', '..', 'c2c-bff', 'src');
  // The flat `src/mock-data.ts` is gone.
  assert.equal(
    fs.existsSync(path.join(bffSrc, 'mock-data.ts')),
    false,
    'services/c2c-bff/src/mock-data.ts must be removed; diagnostic fixtures live under diagnostic-fixtures/',
  );
  // Product-mode files (server.ts, index.ts) must not import the fixture module.
  const productFiles = ['server.ts', 'index.ts', 'config.ts', 'upstream.ts'];
  for (const file of productFiles) {
    const absolute = path.join(bffSrc, file);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
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

test('W0 browser acceptance fixtures do not enable diagnostic fixtures', () => {
  // Issue #93: diagnostic fixture mode must not be used by W0 acceptance tests.
  // We scan likely browser/playwright config locations at the repo root.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const candidates = [
    path.join(repoRoot, '.github', 'workflows'),
    path.join(repoRoot, 'apps', 'c2c-ui', 'tests'),
    path.join(repoRoot, 'tests'),
    path.join(repoRoot, 'e2e'),
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
          if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-test') continue;
          stack.push(path.join(next, entry));
        }
        continue;
      }
      if (!/\.(ya?ml|json|ts|tsx|js|mjs|cjs|sh)$/.test(next)) continue;
      const text = fs.readFileSync(next, 'utf8');
      assert.ok(
        !/C2C_ENABLE_DIAGNOSTIC_FIXTURES\s*[:=]\s*['"]?(?:1|true|yes|on)['"]?/.test(text),
        `${next} must not enable C2C_ENABLE_DIAGNOSTIC_FIXTURES for browser/acceptance flows`,
      );
    }
  }
});

test('Issue #97: generated/files index proxies orchestrator response and exposes artifactRef', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const javaContent = 'package c2c;\npublic final class CASE01 {}\n';
  const filesIndex = [
    { path: 'pom.xml', sha256: 'a'.repeat(64), byteSize: 16, mimeType: 'application/xml' },
    {
      path: 'src/main/java/c2c/CASE01.java',
      sha256: 'b'.repeat(64),
      byteSize: javaContent.length,
      mimeType: 'text/x-java-source',
    },
  ];
  const { client: orch, calls } = stubOrchestrator({
    generatedFiles: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        files: filesIndex,
        fileCount: filesIndex.length,
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        artifactRef: { uri: 'file:///run/generated-project-manifest.json', sha256: 'c'.repeat(64), byteSize: 512 },
      },
    },
    generatedFile: (filePath) => {
      if (filePath === 'src/main/java/c2c/CASE01.java') {
        return {
          status: 200,
          body: {
            path: filePath,
            absolutePath: 'generated-project/src/main/java/c2c/CASE01.java',
            content: javaContent,
            sha256: 'b'.repeat(64),
            byteSize: javaContent.length,
            mimeType: 'text/x-java-source',
            uri: 'file:///run/generated-project/CASE01.java',
            kind: 'generated-project-file',
          },
        };
      }
      return { status: 404, body: { error: 'generated file not found', path: filePath } };
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
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
    assert.equal(indexBody.status, 'complete');
    assert.equal(indexBody.productMode, 'live');
    assert.equal(indexBody.fileCount, 2);
    assert.equal(indexBody.entryFilePath, 'src/main/java/c2c/CASE01.java');
    assert.equal(indexBody.artifactRef?.sha256, 'c'.repeat(64));
    assert.equal(calls.getGeneratedFiles, 1);

    const file = await fetchJson(
      `${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated/files/src/main/java/c2c/CASE01.java`,
    );
    assert.equal(file.status, 200);
    const fileBody = file.body as { path: string; content: string; sha256: string; byteSize: number };
    assert.equal(fileBody.path, 'src/main/java/c2c/CASE01.java');
    assert.equal(fileBody.content, javaContent);
    assert.equal(fileBody.byteSize, javaContent.length);
    assert.equal(calls.getGeneratedFile.length, 1);
    assert.equal(calls.getGeneratedFile[0]?.path, 'src/main/java/c2c/CASE01.java');

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

test('Issue #97: /generated, /build-test, and /evidence all carry the same generated artifact hash', async () => {
  const samples = stubSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const javaContent = 'package c2c;\npublic final class CASE01 { public static void main(String[] a) {} }\n';
  const manifestHash = 'f'.repeat(64);
  const generatedArtifactRef = {
    uri: 'file:///run/generated-project-manifest.json',
    sha256: manifestHash,
    byteSize: 512,
  };
  const { client: orch } = stubOrchestrator({
    generated: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        entryClass: 'CASE01',
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        fileCount: 1,
        files: { 'src/main/java/c2c/CASE01.java': javaContent },
        unsupportedFeatures: [],
        openAssumptions: [],
        artifactRef: generatedArtifactRef,
        traceability: { programId: 'CASE01', irId: 'ir-CASE01', sourceHash: 'aa' },
      },
    },
    buildTest: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        data: { status: 'ok', classification: 'match', actualOutput: '', outputRef: null },
        artifactRef: { uri: 'file:///run/build-test-result.json', sha256: 'c'.repeat(64), byteSize: 256 },
        generatedArtifactRef,
      },
    },
    evidence: {
      status: 200,
      body: {
        runId: 'live-run-1',
        workflowId: 'w0-migration-v0',
        programId: 'CASE01',
        runStatus: 'completed',
        status: 'complete',
        missingArtifacts: [],
        data: { packId: 'epk-1', status: 'complete' },
        artifactRef: { uri: 'file:///run/evidence-pack-manifest.json', sha256: 'd'.repeat(64), byteSize: 512 },
        generatedArtifactRef,
      },
    },
  });
  const handler = createApp({
    config: { ...baseConfig, orchestratorUrl: 'http://upstream' },
    samples,
    orchestrator: orch,
    evidence: liveEvidence(),
    runStore,
  });
  const server = await startTestServer(handler);
  try {
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    const startedBody = started.body as { runId: string };

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    const genBody = generated.body as {
      artifactRef: { sha256: string } | null;
      traceability: { programId: string; irId: string; sourceHash: string };
    };
    assert.equal(genBody.artifactRef?.sha256, manifestHash);
    assert.equal(genBody.traceability.programId, 'CASE01');
    assert.equal(genBody.traceability.irId, 'ir-CASE01');

    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/build-test`);
    const btBody = buildTest.body as { generatedArtifactRef: { sha256: string } | null };
    assert.equal(btBody.generatedArtifactRef?.sha256, manifestHash);

    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/evidence`);
    const evBody = evidence.body as { generatedArtifactRef: { sha256: string } | null };
    assert.equal(evBody.generatedArtifactRef?.sha256, manifestHash);
  } finally {
    await server.close();
  }
});

// Silence unused-import warnings under strict mode
void net;
