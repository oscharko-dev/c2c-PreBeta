import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBytes) {
        tooLarge = true;
        reject(new Error('request body too large'));
        req.resume();
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
    productMode: stored.mode,
    message: stored.message,
    policyDecision: stored.policyDecision,
    evidenceRefs: stored.evidenceRefs,
    orchestratorRunId: stored.liveRunId ?? '',
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function runLinks(runId: string): Record<string, string> {
  return {
    self: `/api/v0/runs/${runId}`,
    generated: `/api/v0/runs/${runId}/generated`,
    buildTest: `/api/v0/runs/${runId}/build-test`,
    evidence: `/api/v0/runs/${runId}/evidence`,
    artifacts: `/api/v0/runs/${runId}/artifacts`,
  };
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

function createSourceTextSample(programId: string, sourceText: string, sourceName?: string): SampleDetail {
  return {
    programId,
    title: sourceName ? `Transform run from ${sourceName}` : `Transform run for ${programId}`,
    description: 'Synthetic sample created from source text',
    knownDivergenceAtW0: false,
    cobolSource: sourceText,
    cobolSourcePath: `transforms/${programId}.cbl`,
    expectedOutput: '',
  };
}

function extractProgramIdFromSourceText(sourceText: string): string {
  const match = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i.exec(sourceText);
  if (match?.[1]) {
    return match[1].toUpperCase();
  }
  const digest = createHash('sha256').update(sourceText, 'utf8').digest('hex').slice(0, 12).toUpperCase();
  return `SRC-${digest}`;
}

function resolveTransformProgramId(sourceText: string, requestedProgramId?: string): string {
  if (typeof requestedProgramId === 'string' && requestedProgramId.trim().length > 0) {
    return requestedProgramId.trim();
  }
  return extractProgramIdFromSourceText(sourceText);
}

function mockGeneratedView(stored: StoredRun): Record<string, unknown> {
  if (!stored.mock) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'mock',
    ...stored.mock.generated,
  };
}

function mockBuildTestView(stored: StoredRun): Record<string, unknown> {
  if (!stored.mock) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'mock',
    expectedOutput: stored.sample.expectedOutput,
    ...stored.mock.buildTest,
  };
}

function mockEvidenceView(stored: StoredRun): Record<string, unknown> {
  if (!stored.mock) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'mock',
    ...stored.mock.evidence,
  };
}

function liveArtifactRunId(stored: StoredRun): string | undefined {
  return stored.liveRunId && stored.liveRunId.length > 0 ? stored.liveRunId : undefined;
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
    status: 'incomplete',
    missingArtifacts: missing,
    note,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function classifyGeneratedStatus(missing: string[], runStatus: string | undefined): 'generated' | 'unsupported' | 'skipped' {
  if (missing.length === 0) return 'generated';
  if (runStatus === 'failed') return 'unsupported';
  return 'skipped';
}

function classifyBuildTestStatus(missing: string[], runStatus: string | undefined, data: Record<string, unknown> | undefined): {
  status: 'ok' | 'compile-failed' | 'run-failed' | 'output-divergence' | 'golden-master-reproduction-failed' | 'missing-golden-master' | 'skipped';
  classification: 'match' | 'divergence-known-w0-coverage-gap' | 'divergence-unknown' | 'true-golden-master-reproduction-error' | 'true-golden-master-mismatch' | 'compile-error' | 'run-error' | 'skipped-no-execution';
} {
  if (missing.length > 0) {
    return runStatus === 'failed'
      ? { status: 'run-failed', classification: 'run-error' }
      : { status: 'skipped', classification: 'skipped-no-execution' };
  }
  const upstreamStatus = typeof data?.status === 'string' ? data.status : '';
  const upstreamClassification = typeof data?.classification === 'string' ? data.classification : '';
  const allowedStatus = new Set([
    'ok',
    'compile-failed',
    'run-failed',
    'output-divergence',
    'golden-master-reproduction-failed',
    'missing-golden-master',
    'skipped',
  ]);
  const allowedClassification = new Set([
    'match',
    'divergence-known-w0-coverage-gap',
    'divergence-unknown',
    'true-golden-master-reproduction-error',
    'true-golden-master-mismatch',
    'compile-error',
    'run-error',
    'skipped-no-execution',
  ]);
  const status = allowedStatus.has(upstreamStatus) ? (upstreamStatus as 'ok') : 'ok';
  const classification = allowedClassification.has(upstreamClassification) ? (upstreamClassification as 'match') : 'match';
  return { status, classification };
}

async function liveGeneratedView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return incompleteEnvelope(stored, ['generation-response'], 'Live run id is unavailable; orchestrator has not yet accepted this run.');
  }
  try {
    const upstream = await orchestrator.getGenerated(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return incompleteEnvelope(stored, ['generation-response'], 'Orchestrator did not return generated-Java artifacts for this run.');
    }
    const envelope = asRecord(upstream.body) ?? {};
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const runStatus = typeof envelope.runStatus === 'string' ? envelope.runStatus : '';
    const filesRaw = asRecord(envelope.files) ?? {};
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(filesRaw)) {
      if (typeof value === 'string') files[key] = value;
    }
    const status = classifyGeneratedStatus(missing, runStatus);
    return {
      runId: stored.runId,
      programId: stored.programId || (typeof envelope.programId === 'string' ? envelope.programId : ''),
      mode: 'live',
      status,
      entryClass: typeof envelope.entryClass === 'string' ? envelope.entryClass : '',
      entryFilePath: typeof envelope.entryFilePath === 'string' ? envelope.entryFilePath : '',
      files,
      fileCount: typeof envelope.fileCount === 'number' ? envelope.fileCount : Object.keys(files).length,
      unsupportedFeatures: Array.isArray(envelope.unsupportedFeatures) ? envelope.unsupportedFeatures : [],
      openAssumptions: Array.isArray(envelope.openAssumptions) ? envelope.openAssumptions : [],
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      generationResponseRef: envelope.generationResponseRef ?? null,
    };
  } catch (err) {
    return incompleteEnvelope(stored, ['generation-response'], err instanceof Error ? err.message : 'orchestrator request failed');
  }
}

async function liveBuildTestView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(stored, ['build-test-result'], 'Live run id is unavailable; orchestrator has not yet accepted this run.'),
      classification: 'skipped-no-execution',
      expectedOutput: stored.sample.expectedOutput,
    };
  }
  try {
    const upstream = await orchestrator.getBuildTest(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(stored, ['build-test-result'], 'Orchestrator did not return a build/test result for this run.'),
        classification: 'skipped-no-execution',
        expectedOutput: stored.sample.expectedOutput,
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const runStatus = typeof envelope.runStatus === 'string' ? envelope.runStatus : '';
    const { status, classification } = classifyBuildTestStatus(missing, runStatus, data);
    return {
      runId: stored.runId,
      programId: stored.programId || (typeof envelope.programId === 'string' ? envelope.programId : ''),
      mode: 'live',
      status,
      classification,
      expectedOutput: stored.sample.expectedOutput,
      actualOutput: typeof data?.actualOutput === 'string' ? data.actualOutput : '',
      outputRef: typeof data?.outputRef === 'string'
        ? data.outputRef
        : (typeof (asRecord(data?.outputRef)?.uri) === 'string' ? String(asRecord(data?.outputRef)!.uri) : ''),
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      artifactRef: envelope.artifactRef ?? null,
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(stored, ['build-test-result'], err instanceof Error ? err.message : 'orchestrator request failed'),
      classification: 'skipped-no-execution',
      expectedOutput: stored.sample.expectedOutput,
    };
  }
}

async function liveEvidenceView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(stored, ['evidence-pack-manifest'], 'Live run id is unavailable; orchestrator has not yet accepted this run.'),
      packId: '',
      manifestUri: '',
    };
  }
  try {
    const upstream = await orchestrator.getEvidence(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(stored, ['evidence-pack-manifest'], 'Orchestrator did not return an evidence pack manifest for this run.'),
        packId: '',
        manifestUri: '',
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const artifactRef = asRecord(envelope.artifactRef);
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const packId = typeof data?.packId === 'string' ? data.packId : '';
    const manifestUri = typeof artifactRef?.uri === 'string' ? artifactRef.uri : '';
    return {
      runId: stored.runId,
      programId: stored.programId || (typeof envelope.programId === 'string' ? envelope.programId : ''),
      mode: 'live',
      status: missing.length === 0 ? 'complete' : 'incomplete',
      packId,
      manifestUri,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      artifactRef: artifactRef ?? null,
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(stored, ['evidence-pack-manifest'], err instanceof Error ? err.message : 'orchestrator request failed'),
      packId: '',
      manifestUri: '',
    };
  }
}

async function liveEventsView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      events: [],
      missingArtifacts: ['trajectory-ledger'],
      note: 'Live run id is unavailable; orchestrator has not yet accepted this run.',
    };
  }
  try {
    const upstream = await orchestrator.getEvents(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        runId: stored.runId,
        programId: stored.programId,
        mode: stored.mode,
        events: [],
        missingArtifacts: ['trajectory-ledger'],
        note: 'Orchestrator did not return a trajectory ledger for this run.',
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const events = Array.isArray(envelope.events) ? envelope.events : [];
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      runId: stored.runId,
      programId: stored.programId || (typeof envelope.programId === 'string' ? envelope.programId : ''),
      mode: 'live',
      events,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
    };
  } catch (err) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      events: [],
      missingArtifacts: ['trajectory-ledger'],
      note: err instanceof Error ? err.message : 'orchestrator request failed',
    };
  }
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

      if (pathname === '/api/v0/transform' && method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req, config.transformSourceMaxBytes);
        } catch (err) {
          if (err instanceof Error && /too large/i.test(err.message)) {
            jsonResponse(res, 413, { error: 'request body too large' });
            return;
          }
          badRequest(res, err instanceof Error ? err.message : 'invalid body');
          return;
        }
        if (!body || typeof body !== 'object') {
          badRequest(res, 'request body must be a JSON object');
          return;
        }
        const sourceTextRaw = (body as Record<string, unknown>).sourceText;
        const requestedProgramIdRaw = (body as Record<string, unknown>).programId;
        const sourceNameRaw = (body as Record<string, unknown>).sourceName;
        const optionsRaw = (body as Record<string, unknown>).options;
        if (typeof sourceTextRaw !== 'string' || sourceTextRaw.trim().length === 0) {
          badRequest(res, 'sourceText must be a non-empty string');
          return;
        }
        if (requestedProgramIdRaw !== undefined && (typeof requestedProgramIdRaw !== 'string' || requestedProgramIdRaw.trim().length === 0)) {
          badRequest(res, 'programId must be a non-empty string when provided');
          return;
        }
        if (sourceNameRaw !== undefined && (typeof sourceNameRaw !== 'string' || sourceNameRaw.trim().length === 0)) {
          badRequest(res, 'sourceName must be a non-empty string when provided');
          return;
        }
        if (optionsRaw !== undefined && (typeof optionsRaw !== 'object' || optionsRaw === null || Array.isArray(optionsRaw))) {
          badRequest(res, 'options must be an object when provided');
          return;
        }
        if (!orchestrator.enabled) {
          jsonResponse(res, 503, { error: 'orchestrator URL is required for /api/v0/transform' });
          return;
        }

        const sourceText = sourceTextRaw;
        const programId = resolveTransformProgramId(sourceText, typeof requestedProgramIdRaw === 'string' ? requestedProgramIdRaw : undefined);
        const sourceName = typeof sourceNameRaw === 'string' ? sourceNameRaw : undefined;

        try {
          const upstream = await orchestrator.startTransformRun({
            programId,
            sourceText,
            requester: 'c2c-ui',
            sourceName,
            options: optionsRaw,
          });
          if (upstream && upstream.status >= 200 && upstream.status < 300) {
            const liveRunId = extractLiveRunId(upstream.body);
            const stored = runStore.create(createSourceTextSample(programId, sourceText, sourceName), 'live', liveRunId, {
              status: 'starting',
              message: 'run accepted by orchestrator',
            });
            const synced = applyLiveRunPayload(stored, runStore, upstream.body);
            res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(transformResponse(synced)));
            return;
          }
          const status = upstream?.status ?? 502;
          jsonResponse(res, 502, {
            error: `orchestrator rejected transform request${status ? ` (${status})` : ''}`,
          });
          return;
        } catch (err) {
          jsonResponse(res, 502, {
            error: err instanceof Error ? err.message : 'orchestrator request failed',
          });
          return;
        }
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
            const status = upstream?.status ?? 502;
            jsonResponse(res, 502, {
              error: `orchestrator rejected run request${status ? ` (${status})` : ''}`,
            });
            return;
          } catch (err) {
            jsonResponse(res, 502, {
              error: err instanceof Error ? err.message : 'orchestrator request failed',
            });
            return;
          }
        }

        if (!config.diagnosticMode) {
          jsonResponse(res, 503, {
            error:
              'orchestrator URL is required for product runs; set C2C_ORCHESTRATOR_URL or enable C2C_DIAGNOSTIC_MODE=1 to use documented mock fixtures',
          });
          return;
        }

        const stored = runStore.create(sample, 'mock');
        const completed = runStore.update(stored.runId, {
          status: 'completed',
          message: 'mock run completed; outputs are documented fixtures (C2C_DIAGNOSTIC_MODE)',
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
        if (stored.mode === 'mock' && stored.mock) {
          jsonResponse(res, 200, mockGeneratedView(stored));
          return;
        }
        jsonResponse(res, 200, await liveGeneratedView(stored, orchestrator));
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
        if (stored.mode === 'mock' && stored.mock) {
          jsonResponse(res, 200, mockBuildTestView(stored));
          return;
        }
        jsonResponse(res, 200, await liveBuildTestView(stored, orchestrator));
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
        if (stored.mode === 'mock' && stored.mock) {
          jsonResponse(res, 200, mockEvidenceView(stored));
          return;
        }
        jsonResponse(res, 200, await liveEvidenceView(stored, orchestrator));
        return;
      }

      const eventsMatch = /^\/api\/v0\/runs\/([^\/]+)\/events$/.exec(pathname);
      if (eventsMatch && method === 'GET') {
        const runId = decodeURIComponent(eventsMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === 'mock') {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            events: [],
          });
          return;
        }
        jsonResponse(res, 200, await liveEventsView(stored, orchestrator));
        return;
      }

      const artifactsMatch = /^\/api\/v0\/runs\/([^\/]+)\/artifacts$/.exec(pathname);
      if (artifactsMatch && method === 'GET') {
        const runId = decodeURIComponent(artifactsMatch[1] ?? '');
        const stored = runStore.get(runId);
        if (!stored) {
          notFound(res, `unknown runId ${JSON.stringify(runId)}`);
          return;
        }
        if (stored.mode === 'mock') {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: 'mock',
            artifacts: [],
            note: 'Mock runs do not persist on-disk artifacts.',
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: 'live',
            artifacts: [],
            missingArtifacts: ['artifacts-index'],
            note: 'Live run id is unavailable; orchestrator has not yet accepted this run.',
          });
          return;
        }
        try {
          const upstream = await orchestrator.getArtifacts(liveRunId);
          if (!upstream || upstream.status < 200 || upstream.status >= 300) {
            jsonResponse(res, 200, {
              runId: stored.runId,
              programId: stored.programId,
              mode: 'live',
              artifacts: [],
              missingArtifacts: ['artifacts-index'],
              orchestratorRunId: liveRunId,
              note: 'Orchestrator did not return an artifacts index for this run.',
            });
            return;
          }
          const envelope = asRecord(upstream.body) ?? {};
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId || (typeof envelope.programId === 'string' ? envelope.programId : ''),
            mode: 'live',
            orchestratorRunId: liveRunId,
            artifacts: Array.isArray(envelope.artifacts) ? envelope.artifacts : [],
            summary: envelope.summary ?? null,
            createdAt: envelope.createdAt ?? null,
            updatedAt: envelope.updatedAt ?? null,
          });
          return;
        } catch (err) {
          jsonResponse(res, 502, {
            error: err instanceof Error ? err.message : 'orchestrator request failed',
          });
          return;
        }
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
