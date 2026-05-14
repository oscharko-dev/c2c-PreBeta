import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';

import type { BffConfig } from './config';
import { loadSampleRegistry, type SampleRegistry, type SampleDetail } from './samples';
import {
  createEvidenceClient,
  createNodeHttpClient,
  createOrchestratorClient,
  type EvidenceClient,
  type HttpClient,
  type OrchestratorClient,
} from './upstream';
import { coerceLiveStatus, createRunStore, type RunStore, type StoredRun } from './run-store';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export interface ServerDeps {
  config: BffConfig;
  samples?: SampleRegistry;
  orchestrator?: OrchestratorClient;
  evidence?: EvidenceClient;
  httpClient?: HttpClient;
  runStore?: RunStore;
  now?: () => Date;
}

interface ResolvedDeps {
  config: BffConfig;
  samples: SampleRegistry;
  orchestrator: OrchestratorClient;
  evidence: EvidenceClient;
  runStore: RunStore;
}

function resolveDeps(deps: ServerDeps): ResolvedDeps {
  const httpClient = deps.httpClient ?? createNodeHttpClient();
  return {
    config: deps.config,
    samples: deps.samples ?? loadSampleRegistry(deps.config.repoRoot),
    orchestrator: deps.orchestrator ?? createOrchestratorClient(deps.config.orchestratorUrl, httpClient, deps.config.upstreamTimeoutMs),
    evidence: deps.evidence ?? createEvidenceClient(deps.config.evidenceUrl, httpClient, deps.config.upstreamTimeoutMs),
    runStore: deps.runStore ?? createRunStore(deps.now),
  };
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function notFound(res: http.ServerResponse, message = 'not found'): void {
  jsonResponse(res, 404, { error: message });
}

function badRequest(res: http.ServerResponse, message: string): void {
  jsonResponse(res, 400, { error: message });
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(root: string, requested: string): string | undefined {
  const normalized = path.posix.normalize(requested);
  if (normalized.includes('\0')) return undefined;
  const candidate = path.resolve(root, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
  return candidate;
}

function serveStatic(res: http.ServerResponse, staticRoot: string, requestedPath: string): boolean {
  if (!fs.existsSync(staticRoot)) return false;
  let target = requestedPath;
  if (target === '/' || target === '') target = '/index.html';
  const resolved = safeJoin(staticRoot, target);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) {
    // SPA fallback to index.html for unknown paths
    const indexFile = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexFile)) return false;
    const html = fs.readFileSync(indexFile);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
    });
    res.end(html);
    return true;
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const indexFile = path.join(resolved, 'index.html');
    if (!fs.existsSync(indexFile)) return false;
    const html = fs.readFileSync(indexFile);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
    });
    res.end(html);
    return true;
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'content-type': mime,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}

function runSummary(stored: StoredRun): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    status: stored.status,
    mode: stored.mode,
    message: stored.message,
    policyDecision: stored.policyDecision,
    evidenceRefs: stored.evidenceRefs,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function generatedView(stored: StoredRun): Record<string, unknown> {
  if (stored.mode === 'mock' && stored.mock) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: 'mock',
      ...stored.mock.generated,
    };
  }
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    status: 'skipped',
    entryClass: '',
    entryFilePath: '',
    files: {},
    unsupportedFeatures: [],
    openAssumptions: [],
    note: 'Live generated-Java retrieval is not wired in W0 BFF; consult target-java-generation-service directly when running the full mesh.',
  };
}

function buildTestView(stored: StoredRun): Record<string, unknown> {
  if (stored.mode === 'mock' && stored.mock) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: 'mock',
      expectedOutput: stored.sample.expectedOutput,
      ...stored.mock.buildTest,
    };
  }
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    status: 'skipped',
    classification: 'skipped-no-execution',
    expectedOutput: stored.sample.expectedOutput,
    actualOutput: '',
    outputRef: '',
    note: 'Live build/test retrieval is not wired in W0 BFF; consult build-test-runner-service directly when running the full mesh.',
  };
}

function evidenceView(stored: StoredRun): Record<string, unknown> {
  if (stored.mode === 'mock' && stored.mock) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: 'mock',
      ...stored.mock.evidence,
    };
  }
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: stored.mode,
    status: 'incomplete',
    packId: '',
    manifestUri: '',
    missingArtifacts: [],
    note: 'Live evidence retrieval requires evidence-service to expose a pack id for this run. Use the orchestrator response or evidence-service /v0/packs to look it up.',
  };
}

function extractLiveRunId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const direct = obj.runId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const run = obj.run;
  if (run && typeof run === 'object') {
    const nested = (run as Record<string, unknown>).runId;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}

function applyLiveRunPayload(stored: StoredRun, runStore: RunStore, payload: unknown): StoredRun {
  if (!payload || typeof payload !== 'object') return stored;
  const obj = payload as Record<string, unknown>;
  const runObj = (obj.run && typeof obj.run === 'object') ? (obj.run as Record<string, unknown>) : obj;
  const status = coerceLiveStatus(runObj.status);
  const message = typeof runObj.message === 'string' ? runObj.message : stored.message;
  const policyDecision = typeof runObj.policyDecision === 'string' ? runObj.policyDecision : stored.policyDecision;
  const evidenceRefs = Array.isArray(runObj.evidenceRefs)
    ? (runObj.evidenceRefs as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : stored.evidenceRefs;
  const updated = runStore.update(stored.runId, {
    status,
    message,
    policyDecision,
    evidenceRefs,
  });
  return updated ?? stored;
}

export function createApp(deps: ServerDeps): http.RequestListener {
  const resolved = resolveDeps(deps);
  const { config, samples, orchestrator, evidence, runStore } = resolved;

  return async function handler(req, res) {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const pathname = requestUrl.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (pathname === '/api/v0/health' && method === 'GET') {
        jsonResponse(res, 200, { status: 'ok', service: config.serviceName });
        return;
      }

      if (pathname === '/api/v0/mode' && method === 'GET') {
        jsonResponse(res, 200, {
          orchestrator: orchestrator.enabled ? 'live' : 'mock',
          evidence: evidence.enabled ? 'live' : 'mock',
        });
        return;
      }

      if (pathname === '/api/v0/samples' && method === 'GET') {
        jsonResponse(res, 200, samples.list());
        return;
      }

      const sampleMatch = /^\/api\/v0\/samples\/([^\/]+)$/.exec(pathname);
      if (sampleMatch && method === 'GET') {
        const programId = decodeURIComponent(sampleMatch[1] ?? '');
        const detail = samples.get(programId);
        if (!detail) {
          notFound(res, `unknown programId ${JSON.stringify(programId)}`);
          return;
        }
        jsonResponse(res, 200, detail satisfies SampleDetail);
        return;
      }

      if (pathname === '/api/v0/runs' && method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : 'invalid body');
          return;
        }
        if (!body || typeof body !== 'object') {
          badRequest(res, 'request body must be a JSON object');
          return;
        }
        const programIdRaw = (body as Record<string, unknown>).programId;
        const requesterRaw = (body as Record<string, unknown>).requester;
        if (typeof programIdRaw !== 'string' || programIdRaw.length === 0) {
          badRequest(res, 'programId is required');
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
              requester: typeof requesterRaw === 'string' ? requesterRaw : undefined,
            });
            if (upstream && upstream.status >= 200 && upstream.status < 300) {
              const liveRunId = extractLiveRunId(upstream.body);
              const stored = runStore.create(sample, 'live', liveRunId, {
                status: 'starting',
                message: 'run accepted by orchestrator',
              });
              const synced = applyLiveRunPayload(stored, runStore, upstream.body);
              res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(runSummary(synced)));
              return;
            }
          } catch {
            // fall through to mock so the demo stays usable when upstream is misconfigured
          }
        }

        const stored = runStore.create(sample, 'mock');
        const completed = runStore.update(stored.runId, {
          status: 'completed',
          message: 'mock run completed; outputs are documented fixtures',
          evidenceRefs: [stored.mock?.evidence.manifestUri ?? ''],
        }) ?? stored;
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(runSummary(completed)));
        return;
      }

      const runMatch = /^\/api\/v0\/runs\/([^\/]+)$/.exec(pathname);
      if (runMatch && method === 'GET') {
        const runId = decodeURIComponent(runMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        let current = stored;
        if (current.mode === 'live' && orchestrator.enabled && current.liveRunId) {
          try {
            const upstream = await orchestrator.getRun(current.liveRunId);
            if (upstream && upstream.status >= 200 && upstream.status < 300) {
              current = applyLiveRunPayload(current, runStore, upstream.body);
            }
          } catch {
            // keep last-known state; UI shows updatedAt
          }
        }
        jsonResponse(res, 200, runSummary(current));
        return;
      }

      const genMatch = /^\/api\/v0\/runs\/([^\/]+)\/generated$/.exec(pathname);
      if (genMatch && method === 'GET') {
        const runId = decodeURIComponent(genMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        jsonResponse(res, 200, generatedView(stored));
        return;
      }

      const btMatch = /^\/api\/v0\/runs\/([^\/]+)\/build-test$/.exec(pathname);
      if (btMatch && method === 'GET') {
        const runId = decodeURIComponent(btMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        jsonResponse(res, 200, buildTestView(stored));
        return;
      }

      const evMatch = /^\/api\/v0\/runs\/([^\/]+)\/evidence$/.exec(pathname);
      if (evMatch && method === 'GET') {
        const runId = decodeURIComponent(evMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        jsonResponse(res, 200, evidenceView(stored));
        return;
      }

      if (pathname.startsWith('/api/')) {
        notFound(res);
        return;
      }

      if (method === 'GET' && serveStatic(res, config.staticRoot, pathname)) {
        return;
      }

      notFound(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
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
