import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  createEvidenceClient,
  createNodeHttpClient,
  createOrchestratorClient,
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
        cobolSourcePath: 'corpus/synthetic/programs/demo.cbl',
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

test('orchestrator and evidence clients are disabled when no base url is configured', async () => {
  const client = createNodeHttpClient();
  const orch = createOrchestratorClient('', client, 1_000);
  assert.equal(orch.enabled, false);
  assert.equal(await orch.startRun({ programId: 'x', cobolSourcePath: 'y' }), undefined);
  assert.equal(await orch.getRun('z'), undefined);

  const ev = createEvidenceClient('', client, 1_000);
  assert.equal(ev.enabled, false);
  assert.equal(await ev.getPack('any'), undefined);
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
