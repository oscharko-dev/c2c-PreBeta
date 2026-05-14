import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

import { createApp } from './server';
import { createRunStore } from './run-store';
import type { SampleDetail, SampleRegistry, SampleSummary } from './samples';
import type { EvidenceClient, OrchestratorClient, UpstreamResponse } from './upstream';
import type { BffConfig } from './config';

const FIXED_SAMPLE: SampleDetail = {
  programId: 'BRNCH01',
  title: 'Branch approval guard',
  description: 'fixture sample',
  knownDivergenceAtW0: false,
  cobolSource: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. BRNCH01.\n',
  cobolSourcePath: 'corpus/synthetic/programs/branch-account-guard.cbl',
  expectedOutput: 'APPROVED-COUNT=2\nREJECTED-COUNT=2\n',
};

const FIXED_SAMPLE_2: SampleDetail = {
  ...FIXED_SAMPLE,
  programId: 'BATCH01',
  knownDivergenceAtW0: false,
};

function fakeSamples(items: SampleDetail[]): SampleRegistry {
  const byId = new Map(items.map((item) => [item.programId, item]));
  return {
    list(): SampleSummary[] {
      return items.map(({ programId, title, description, knownDivergenceAtW0 }) => ({
        programId,
        title,
        description,
        knownDivergenceAtW0,
      }));
    },
    get(programId: string): SampleDetail | undefined {
      return byId.get(programId);
    },
  };
}

function fakeOrchestrator(): { client: OrchestratorClient; calls: { startRun: number; getRun: number } } {
  const calls = { startRun: 0, getRun: 0 };
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
  };
  return { client, calls };
}

function disabledOrchestrator(): OrchestratorClient {
  return {
    enabled: false,
    async startRun() {
      return undefined;
    },
    async getRun() {
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
  upstreamTimeoutMs: 1_000,
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

test('health endpoint reports service name', async () => {
  const handler = createApp({
    config: baseConfig,
    samples: fakeSamples([FIXED_SAMPLE]),
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
  const { client: orch } = fakeOrchestrator();
  const handler = createApp({
    config: baseConfig,
    samples: fakeSamples([FIXED_SAMPLE]),
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

test('samples list and detail return registry contents', async () => {
  const handler = createApp({
    config: baseConfig,
    samples: fakeSamples([FIXED_SAMPLE, FIXED_SAMPLE_2]),
    orchestrator: disabledOrchestrator(),
    evidence: disabledEvidence(),
    runStore: createRunStore(),
  });
  const server = await startTestServer(handler);
  try {
    const list = await fetchJson(`${server.baseUrl}/api/v0/samples`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body as Array<{ programId: string }>).map((entry) => entry.programId).sort(),
      ['BATCH01', 'BRNCH01'],
    );

    const detail = await fetchJson(`${server.baseUrl}/api/v0/samples/BRNCH01`);
    assert.equal(detail.status, 200);
    const body = detail.body as { programId: string; expectedOutput: string };
    assert.equal(body.programId, 'BRNCH01');
    assert.match(body.expectedOutput, /APPROVED-COUNT/);

    const missing = await fetchJson(`${server.baseUrl}/api/v0/samples/UNKNOWN`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('starting a run in mock mode returns a completed run with mock evidence', async () => {
  const samples = fakeSamples([FIXED_SAMPLE]);
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
    const started = await fetchJson(`${server.baseUrl}/api/v0/runs`, {
      method: 'POST',
      body: { programId: 'BRNCH01' },
    });
    assert.equal(started.status, 201);
    const runBody = started.body as { runId: string; mode: string; status: string; evidenceRefs: string[] };
    assert.equal(runBody.mode, 'mock');
    assert.equal(runBody.status, 'completed');
    assert.ok(runBody.evidenceRefs.length > 0);

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const genBody = generated.body as {
      mode: string;
      status: string;
      files: Record<string, string>;
      unsupportedFeatures: string[];
    };
    assert.equal(genBody.mode, 'mock');
    assert.equal(genBody.status, 'generated');
    assert.ok(Object.keys(genBody.files).length > 0);
    assert.equal(genBody.unsupportedFeatures.length, 0);

    const buildTest = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/build-test`);
    assert.equal(buildTest.status, 200);
    const btBody = buildTest.body as { status: string; classification: string; expectedOutput: string };
    assert.equal(btBody.status, 'ok');
    assert.equal(btBody.classification, 'match');
    assert.match(btBody.expectedOutput, /APPROVED-COUNT/);

    const evidence = await fetchJson(`${server.baseUrl}/api/v0/runs/${runBody.runId}/evidence`);
    assert.equal(evidence.status, 200);
    const evBody = evidence.body as { mode: string; packId: string; manifestUri: string };
    assert.equal(evBody.mode, 'mock');
    assert.ok(evBody.packId.startsWith('epk-'));
    assert.ok(evBody.manifestUri.length > 0);
  } finally {
    await server.close();
  }
});

test('starting a run in live mode proxies the orchestrator and syncs status on get', async () => {
  const samples = fakeSamples([FIXED_SAMPLE]);
  const runStore = createRunStore();
  const { client: orch, calls } = fakeOrchestrator();
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
    const startedBody = started.body as { runId: string; mode: string; status: string };
    assert.equal(startedBody.mode, 'live');
    assert.equal(calls.startRun, 1);

    const fetched = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}`);
    assert.equal(fetched.status, 200);
    const fetchedBody = fetched.body as { mode: string; status: string };
    assert.equal(fetchedBody.mode, 'live');
    assert.equal(fetchedBody.status, 'completed');
    assert.equal(calls.getRun, 1);

    const generated = await fetchJson(`${server.baseUrl}/api/v0/runs/${startedBody.runId}/generated`);
    assert.equal(generated.status, 200);
    const genBody = generated.body as { mode: string; status: string; note: string };
    assert.equal(genBody.mode, 'live');
    assert.equal(genBody.status, 'skipped');
    assert.match(genBody.note, /Live generated-Java retrieval/);
  } finally {
    await server.close();
  }
});

test('rejects malformed run start bodies', async () => {
  const handler = createApp({
    config: baseConfig,
    samples: fakeSamples([FIXED_SAMPLE]),
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
    samples: fakeSamples([FIXED_SAMPLE]),
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

// Silence unused-import warnings under strict mode
void net;
