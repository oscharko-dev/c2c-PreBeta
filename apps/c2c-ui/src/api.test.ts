import test from 'node:test';
import assert from 'node:assert/strict';

import { BffError, createBffApi, type FetchLike } from './api.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetch(responses: Array<{ status: number; body: string }>): { fetchImpl: FetchLike; captured: Captured[] } {
  const captured: Captured[] = [];
  let cursor = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const response = responses[cursor];
    cursor += 1;
    if (!response) throw new Error(`no response queued for request ${cursor}`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async text() {
        return response.body;
      },
    };
  };
  return { fetchImpl, captured };
}

test('createBffApi.getMode parses the mode response', async () => {
  const { fetchImpl, captured } = makeFetch([
    { status: 200, body: JSON.stringify({ orchestrator: 'live', evidence: 'mock' }) },
  ]);
  const api = createBffApi({ baseUrl: 'http://bff', fetchImpl });
  const mode = await api.getMode();
  assert.deepEqual(mode, { orchestrator: 'live', evidence: 'mock' });
  assert.equal(captured[0]?.url, 'http://bff/api/v0/mode');
  assert.equal(captured[0]?.method, 'GET');
});

test('createBffApi.startRun posts the program id and parses response', async () => {
  const { fetchImpl, captured } = makeFetch([
    {
      status: 201,
      body: JSON.stringify({
        runId: 'run-1',
        programId: 'BRNCH01',
        status: 'completed',
        mode: 'diagnostic-fixture',
        productMode: 'unavailable',
        message: 'diagnostic fixture run',
        policyDecision: '',
        evidenceRefs: [],
        createdAt: '',
        updatedAt: '',
      }),
    },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  const result = await api.startRun('BRNCH01');
  assert.equal(result.runId, 'run-1');
  assert.equal(captured[0]?.method, 'POST');
  assert.equal(captured[0]?.url, '/api/v0/runs');
  assert.equal(captured[0]?.headers['content-type'], 'application/json');
  const parsed = JSON.parse(captured[0]?.body ?? '{}');
  assert.deepEqual(parsed, { programId: 'BRNCH01' });
});

test('createBffApi.transform posts COBOL source with optional metadata', async () => {
  const { fetchImpl, captured } = makeFetch([
    {
      status: 201,
      body: JSON.stringify({
        runId: 'run-2',
        orchestratorRunId: 'orch-2',
        status: 'starting',
        programId: 'BRNCH01',
        productMode: 'live',
        links: {
          self: '/api/v0/runs/run-2',
        },
      }),
    },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  const result = await api.transform({
    sourceText: 'IDENTIFICATION DIVISION.',
    programId: 'BRNCH01',
    sourceName: 'fixtures/BRNCH01.cbl',
    options: { skipExecution: true },
  });
  assert.equal(result.runId, 'run-2');
  assert.equal(result.orchestratorRunId, 'orch-2');
  assert.equal(result.status, 'starting');
  assert.equal(result.programId, 'BRNCH01');
  assert.equal(result.productMode, 'live');
  assert.deepEqual(result.links, { self: '/api/v0/runs/run-2' });
  assert.equal(captured[0]?.method, 'POST');
  assert.equal(captured[0]?.url, '/api/v0/transform');
  assert.equal(captured[0]?.headers['content-type'], 'application/json');
  const parsed = JSON.parse(captured[0]?.body ?? '{}');
  assert.deepEqual(parsed, {
    sourceText: 'IDENTIFICATION DIVISION.',
    programId: 'BRNCH01',
    sourceName: 'fixtures/BRNCH01.cbl',
    options: { skipExecution: true },
  });
});

test('createBffApi raises BffError on non-2xx', async () => {
  const { fetchImpl } = makeFetch([
    { status: 404, body: JSON.stringify({ error: 'unknown programId "NOPE"' }) },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  await assert.rejects(
    () => api.getSample('NOPE'),
    (err: unknown) => {
      assert.ok(err instanceof BffError);
      assert.equal((err as BffError).status, 404);
      assert.match((err as BffError).message, /unknown programId/);
      return true;
    },
  );
});

test('createBffApi url-encodes path parameters', async () => {
  const { fetchImpl, captured } = makeFetch([
    { status: 200, body: JSON.stringify({}) },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  await api.getSample('a/b c').catch(() => undefined);
  assert.equal(captured[0]?.url, '/api/v0/samples/a%2Fb%20c');
});

test('createBffApi.getGeneratedFiles requests the generated index endpoint', async () => {
  const { fetchImpl, captured } = makeFetch([
    {
      status: 200,
      body: JSON.stringify({
        runId: 'run-1',
        programId: 'CASE01',
        mode: 'live',
        productMode: 'live',
        status: 'complete',
        fileCount: 1,
        entryFilePath: 'src/main/java/c2c/CASE01.java',
        artifactRef: { sha256: 'a'.repeat(64), byteSize: 1 },
        missingArtifacts: [],
        files: [
          {
            path: 'src/main/java/c2c/CASE01.java',
            sha256: 'b'.repeat(64),
            byteSize: 10,
            mimeType: 'text/x-java-source',
          },
        ],
      }),
    },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  const result = await api.getGeneratedFiles('run-1');
  assert.equal(captured[0]?.url, '/api/v0/runs/run-1/generated/files');
  assert.equal(result.fileCount, 1);
  assert.equal(result.entryFilePath, 'src/main/java/c2c/CASE01.java');
  assert.equal(result.artifactRef?.sha256, 'a'.repeat(64));
});

test('createBffApi.getGeneratedFile encodes path segments but preserves slashes', async () => {
  const { fetchImpl, captured } = makeFetch([
    {
      status: 200,
      body: JSON.stringify({
        runId: 'run-1',
        programId: 'CASE01',
        mode: 'live',
        path: 'src/main/java/c2c/CASE 01.java',
        content: 'class C {}',
        sha256: 'b'.repeat(64),
        byteSize: 10,
        mimeType: 'text/x-java-source',
        kind: 'generated-project-file',
      }),
    },
  ]);
  const api = createBffApi({ baseUrl: '', fetchImpl });
  const result = await api.getGeneratedFile('run-1', 'src/main/java/c2c/CASE 01.java');
  assert.equal(
    captured[0]?.url,
    '/api/v0/runs/run-1/generated/files/src/main/java/c2c/CASE%2001.java',
  );
  assert.equal(result.content, 'class C {}');
  assert.equal(result.byteSize, 10);
  assert.equal(result.path, 'src/main/java/c2c/CASE 01.java');
});
