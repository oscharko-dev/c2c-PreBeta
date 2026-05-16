import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';

import {
  createEvidenceClient,
  createNodeHttpClient,
  createOrchestratorClient,
  UpstreamResponseTooLargeError,
} from './upstream';

interface CapturedRequest {
  method: string;
  path: string;
  body: string;
}

async function withEchoServer<T>(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  test: (baseUrl: string, captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      captured.push({ method: req.method ?? 'GET', path: req.url ?? '/', body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await test(`http://127.0.0.1:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('node http client returns parsed json body and status', async () => {
  const client = createNodeHttpClient();
  const result = await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl) => client.request(`${baseUrl}/anything`, { method: 'GET', timeoutMs: 1_000 }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
});

test('orchestrator client posts the expected payload shape', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ run: { runId: 'live-1', status: 'updating' }, status: 'started' });
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      assert.equal(orch.enabled, true);
      const response = await orch.startRun({
        programId: 'BRNCH01',
        cobolSourcePath: 'corpus/synthetic/programs/reference.cbl',
        requester: 'unit-test',
      });
      assert.ok(response);
      assert.equal(response?.status, 201);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.method, 'POST');
      assert.equal(captured[0]?.path, '/v0/runs');
      const parsed = JSON.parse(captured[0]?.body ?? '{}');
      assert.equal(parsed.requester, 'unit-test');
      assert.equal(parsed.programId, 'BRNCH01');
      assert.equal(parsed.inputRef.uri, 'urn:c2c-bff/sample/BRNCH01');
    },
  );
});

test('transform orchestrator client includes source text metadata and default requester', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ run: { runId: 'live-transform-1', status: 'updating' }, status: 'started' });
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      const sourceText = '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO01.\n';
      const expectedSha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');
      const response = await orch.startTransformRun({
        programId: 'HELLO01',
        sourceText,
        sourceName: 'hello.cbl',
        options: { explain: true },
      });
      assert.equal(response?.status, 201);
      assert.equal(captured.length, 1);
      const parsed = JSON.parse(captured[0]?.body ?? '{}');
      assert.equal(parsed.requester, 'c2c-ui');
      assert.equal(parsed.programId, 'HELLO01');
      assert.equal(parsed.sourceName, 'hello.cbl');
      assert.deepEqual(parsed.options, { explain: true });
      assert.equal(parsed.inputRef.kind, 'source');
      assert.equal(parsed.inputRef.uri, `urn:c2c/ui-source/${expectedSha256}`);
      assert.equal(parsed.inputRef.sourceText, sourceText);
      assert.equal(parsed.inputRef.mimeType, 'text/x-cobol');
      assert.equal(parsed.inputRef.byteSize, Buffer.byteLength(sourceText, 'utf8'));
      assert.equal(parsed.inputRef.sha256, expectedSha256);
    },
  );
});

test('orchestrator and evidence clients are disabled when no base url is configured', async () => {
  const client = createNodeHttpClient();
  const orch = createOrchestratorClient('', client, 1_000);
  assert.equal(orch.enabled, false);
  assert.equal(await orch.startRun({ programId: 'x', cobolSourcePath: 'y' }), undefined);
  assert.equal(await orch.startTransformRun({ programId: 'x', sourceText: 'y' }), undefined);
  assert.equal(await orch.getRun('z'), undefined);
  assert.equal(await orch.getArtifacts('z'), undefined);
  assert.equal(await orch.getGenerated('z'), undefined);
  assert.equal(await orch.getBuildTest('z'), undefined);
  assert.equal(await orch.getEvidence('z'), undefined);
  assert.equal(await orch.getEvents('z'), undefined);
  assert.equal(await orch.getWorkflow('z'), undefined);

  const ev = createEvidenceClient('', client, 1_000);
  assert.equal(ev.enabled, false);
  assert.equal(await ev.getPack('any'), undefined);
});

test('startTransformRun forwards W0.2 targetLanguage and oracle metadata on the inputRef', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ run: { runId: 'live-1', status: 'updating' }, status: 'started' });
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      await orch.startTransformRun({
        programId: 'HELLO01',
        sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n',
        targetLanguage: 'java',
        expectedOutput: 'HELLO WORLD\n',
        oracleInput: '',
      });
      const parsed = JSON.parse(captured[0]?.body ?? '{}');
      assert.equal(parsed.targetLanguage, 'java');
      assert.equal(parsed.inputRef.expectedOutput, 'HELLO WORLD\n');
      assert.equal(parsed.inputRef.oracleInput, undefined);
    },
  );
});

test('startTransformRun omits empty W0.2 oracle metadata from the inputRef', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ run: { runId: 'live-1', status: 'updating' }, status: 'started' });
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      await orch.startTransformRun({
        programId: 'HELLO01',
        sourceText: 'IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO01.\n',
        targetLanguage: 'java',
        expectedOutput: '',
        oracleInput: '',
      });
      const parsed = JSON.parse(captured[0]?.body ?? '{}');
      assert.equal(parsed.inputRef.expectedOutput, undefined);
      assert.equal(parsed.inputRef.oracleInput, undefined);
    },
  );
});

test('orchestrator client encodes workflow endpoint with the run id', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ status: 'complete', contract: { runId: 'run a/b' } });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      const response = await orch.getWorkflow('run a/b');
      assert.equal(response?.status, 200);
      assert.equal(captured[0]?.path, '/v0/runs/run%20a%2Fb/workflow');
    },
  );
});

test('orchestrator client encodes run id and routes artifact endpoints', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ runId: 'run-1' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const orch = createOrchestratorClient(baseUrl, client, 1_000);
      await orch.getArtifacts('run a/b');
      await orch.getGenerated('run a/b');
      await orch.getBuildTest('run a/b');
      await orch.getEvidence('run a/b');
      await orch.getEvents('run a/b');
      assert.deepEqual(
        captured.map((entry) => entry.path),
        [
          '/v0/runs/run%20a%2Fb/artifacts',
          '/v0/runs/run%20a%2Fb/generated',
          '/v0/runs/run%20a%2Fb/build-test',
          '/v0/runs/run%20a%2Fb/evidence',
          '/v0/runs/run%20a%2Fb/events',
        ],
      );
    },
  );
});

test('evidence client encodes pack id and proxies status', async () => {
  const client = createNodeHttpClient();
  await withEchoServer(
    (_req, res) => {
      const body = JSON.stringify({ packId: 'epk-1' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async (baseUrl, captured) => {
      const ev = createEvidenceClient(baseUrl, client, 1_000);
      const response = await ev.getPack('epk a/b');
      assert.equal(response?.status, 200);
      assert.equal(captured[0]?.path, '/v0/packs/epk%20a%2Fb');
    },
  );
});

test('http client rejects upstream responses whose declared content-length exceeds the cap', async () => {
  const client = createNodeHttpClient();
  const big = 'A'.repeat(8_192);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(big),
    });
    res.end(big);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await assert.rejects(
      client.request(`http://127.0.0.1:${address.port}/over`, {
        method: 'GET',
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
      (err: unknown) =>
        err instanceof UpstreamResponseTooLargeError && err.limit === 1_024 && (err.declaredByteSize ?? 0) > 1_024,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('http client truncates and aborts when upstream streams more bytes than the cap', async () => {
  const client = createNodeHttpClient();
  const server = http.createServer((_req, res) => {
    // No content-length header so the early reject path does not fire;
    // the streaming check must catch this.
    res.writeHead(200, { 'content-type': 'text/plain' });
    let chunks = 0;
    const interval = setInterval(() => {
      if (chunks >= 20) {
        clearInterval(interval);
        res.end();
        return;
      }
      try {
        res.write('A'.repeat(512));
      } catch {
        clearInterval(interval);
      }
      chunks += 1;
    }, 5);
    res.on('close', () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await client.request(`http://127.0.0.1:${address.port}/stream`, {
      method: 'GET',
      timeoutMs: 2_000,
      maxResponseBytes: 1_024,
    });
    assert.equal(response.truncated, true);
    assert.equal(response.body, null);
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('http client returns the full body when the upstream stays under the cap', async () => {
  const client = createNodeHttpClient();
  const server = http.createServer((_req, res) => {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await client.request(`http://127.0.0.1:${address.port}/ok`, {
      method: 'GET',
      timeoutMs: 1_000,
      maxResponseBytes: 1_048_576,
    });
    assert.equal(response.truncated, undefined);
    assert.deepEqual(response.body, { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
