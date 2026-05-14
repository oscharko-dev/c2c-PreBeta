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
import { findPlaceholderInFiles } from './placeholder-markers';

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

function productModeOf(stored: StoredRun): 'live' | 'unavailable' {
  return stored.mode === 'live' ? 'live' : 'unavailable';
}

function runSummary(stored: StoredRun): Record<string, unknown> {
  return {
    runId: stored.runId,
    programId: stored.programId,
    status: stored.status,
    mode: stored.mode,
    productMode: productModeOf(stored),
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
    supportedInProductMode: true,
    w0Subset: [],
    oracleMode: null,
    knownLimitations: [],
    cobolSource: sourceText,
    cobolSourcePath: `transforms/${programId}.cbl`,
    expectedOutput: '',
    expectedOutputPath: '',
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

function diagnosticFixtureGeneratedView(stored: StoredRun): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'diagnostic-fixture',
    productMode: 'unavailable',
    ...stored.fixture.generated,
  };
}

function diagnosticFixtureBuildTestView(stored: StoredRun): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'diagnostic-fixture',
    productMode: 'unavailable',
    expectedOutput: stored.sample.expectedOutput,
    ...stored.fixture.buildTest,
  };
}

function diagnosticFixtureEvidenceView(stored: StoredRun): Record<string, unknown> {
  if (!stored.fixture) return {};
  return {
    runId: stored.runId,
    programId: stored.programId,
    mode: 'diagnostic-fixture',
    productMode: 'unavailable',
    ...stored.fixture.evidence,
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
    productMode: productModeOf(stored),
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface OutputRef {
  uri: string;
  sha256: string;
  byteSize?: number;
}

function normalizeOutputRef(raw: unknown): OutputRef | null {
  const record = asRecord(raw);
  if (!record) return null;
  const uri = asString(record.uri);
  if (uri.length === 0) return null;
  const ref: OutputRef = {
    uri,
    sha256: asString(record.sha256),
  };
  const byteSize = asNumber(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  return ref;
}

interface Diagnostic {
  level: string;
  code: string;
  message: string;
}

function normalizeDiagnostics(raw: unknown): Diagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: Diagnostic[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    out.push({
      level: asString(record.level),
      code: asString(record.code),
      message: asString(record.message),
    });
  }
  return out;
}

type GeneratedStatus = 'generated' | 'unsupported' | 'skipped' | 'incomplete';

function classifyGeneratedStatus(missing: string[], runStatus: string | undefined): GeneratedStatus {
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
    return {
      ...incompleteEnvelope(stored, ['generation-response'], 'Live run id is unavailable; orchestrator has not yet accepted this run.'),
      entryClass: '',
      entryFilePath: '',
      files: {},
      outputRef: null,
      diagnostics: [],
      unsupportedFeatures: [],
      openAssumptions: [],
    };
  }
  try {
    const upstream = await orchestrator.getGenerated(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(stored, ['generation-response'], 'Orchestrator did not return generated-Java artifacts for this run.'),
        entryClass: '',
        entryFilePath: '',
        files: {},
        outputRef: null,
        diagnostics: [],
        unsupportedFeatures: [],
        openAssumptions: [],
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const runStatus = asString(envelope.runStatus);
    const filesRaw = asRecord(envelope.files) ?? {};
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(filesRaw)) {
      if (typeof value === 'string') files[key] = value;
    }
    let status: GeneratedStatus = classifyGeneratedStatus(missing, runStatus);
    const generationResponse = asRecord(envelope.generationResponse);
    const outputRef = normalizeOutputRef(envelope.generationResponseRef);
    const diagnostics = normalizeDiagnostics(generationResponse?.diagnostics);
    const entryFilePath = asString(envelope.entryFilePath);
    let missingArtifacts = missing;
    let placeholderViolation: { path: string; marker: string } | null = null;
    if (status === 'generated') {
      const hit = findPlaceholderInFiles(files);
      if (hit) {
        // Safeguard (Issue #85): never let placeholder Java reach the UI as a
        // successful product run. Downgrade to incomplete and mark the offence.
        status = 'incomplete';
        placeholderViolation = { path: hit.path, marker: hit.marker };
        missingArtifacts = [...missingArtifacts, 'real-generated-java'];
      }
    }
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: 'live',
      productMode: status === 'generated' && !placeholderViolation ? 'live' : 'unavailable',
      status,
      entryClass: asString(envelope.entryClass),
      entryFilePath,
      files,
      fileCount: asNumber(envelope.fileCount) ?? Object.keys(files).length,
      unsupportedFeatures: Array.isArray(envelope.unsupportedFeatures) ? envelope.unsupportedFeatures : [],
      openAssumptions: Array.isArray(envelope.openAssumptions) ? envelope.openAssumptions : [],
      missingArtifacts,
      orchestratorRunId: liveRunId,
      outputRef,
      generationResponseRef: envelope.generationResponseRef ?? null,
      diagnostics,
      ...(placeholderViolation ? { placeholderViolation } : {}),
      ...(placeholderViolation
        ? { note: `Placeholder marker "${placeholderViolation.marker}" detected in ${placeholderViolation.path}; refusing to serve as product output.` }
        : {}),
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(stored, ['generation-response'], err instanceof Error ? err.message : 'orchestrator request failed'),
      entryClass: '',
      entryFilePath: '',
      files: {},
      outputRef: null,
      diagnostics: [],
      unsupportedFeatures: [],
      openAssumptions: [],
    };
  }
}

function deriveCompileStatus(data: Record<string, unknown> | undefined, status: string): 'ok' | 'failed' | 'skipped' | 'unknown' {
  const build = asRecord(data?.build);
  if (build && typeof build.compileOk === 'boolean') {
    return build.compileOk ? 'ok' : 'failed';
  }
  if (status === 'compile-failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  return 'unknown';
}

function deriveExecutionStatus(data: Record<string, unknown> | undefined, status: string): 'ok' | 'failed' | 'skipped' | 'not-run' | 'unknown' {
  const execution = asRecord(data?.execution);
  if (execution) {
    if (execution.ran === false) {
      return status === 'skipped' ? 'skipped' : 'not-run';
    }
    if (typeof execution.ok === 'boolean') return execution.ok ? 'ok' : 'failed';
  }
  if (status === 'run-failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'compile-failed') return 'not-run';
  return 'unknown';
}

function deriveActualOutput(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  if (typeof data.actualOutput === 'string') return data.actualOutput;
  const execution = asRecord(data.execution);
  if (execution && typeof execution.stdout === 'string') return execution.stdout;
  return '';
}

function deriveExpectedOutput(data: Record<string, unknown> | undefined, fallback: string): string {
  if (!data) return fallback;
  if (typeof data.expectedOutput === 'string') return data.expectedOutput;
  const golden = asRecord(data.goldenMaster);
  if (golden && typeof golden.expected === 'string') return golden.expected;
  const comparison = asRecord(data.comparison);
  if (comparison && typeof comparison.expected === 'string') return comparison.expected;
  return fallback;
}

async function liveBuildTestView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(stored, ['build-test-result'], 'Live run id is unavailable; orchestrator has not yet accepted this run.'),
      classification: 'skipped-no-execution',
      compileStatus: 'unknown',
      executionStatus: 'unknown',
      expectedOutput: stored.sample.expectedOutput,
      actualOutput: '',
      outputRef: null,
      diagnostics: [],
    };
  }
  try {
    const upstream = await orchestrator.getBuildTest(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(stored, ['build-test-result'], 'Orchestrator did not return a build/test result for this run.'),
        classification: 'skipped-no-execution',
        compileStatus: 'unknown',
        executionStatus: 'unknown',
        expectedOutput: stored.sample.expectedOutput,
        actualOutput: '',
        outputRef: null,
        diagnostics: [],
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const missing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const runStatus = asString(envelope.runStatus);
    const { status, classification } = classifyBuildTestStatus(missing, runStatus, data);
    const outputRef = normalizeOutputRef(data?.outputRef);
    const diagnostics = normalizeDiagnostics(data?.diagnostics);
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: 'live',
      productMode: status === 'ok' ? 'live' : 'unavailable',
      status,
      classification,
      compileStatus: deriveCompileStatus(data, status),
      executionStatus: deriveExecutionStatus(data, status),
      expectedOutput: deriveExpectedOutput(data, stored.sample.expectedOutput),
      actualOutput: deriveActualOutput(data),
      outputRef,
      diagnostics,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      artifactRef: envelope.artifactRef ?? null,
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(stored, ['build-test-result'], err instanceof Error ? err.message : 'orchestrator request failed'),
      classification: 'skipped-no-execution',
      compileStatus: 'unknown',
      executionStatus: 'unknown',
      expectedOutput: stored.sample.expectedOutput,
      actualOutput: '',
      outputRef: null,
      diagnostics: [],
    };
  }
}

function deriveValidationStatus(data: Record<string, unknown> | undefined): 'valid' | 'invalid' | 'incomplete' | 'unknown' {
  if (!data) return 'unknown';
  const validation = asRecord(data.validation);
  if (validation) {
    const validationStatus = asString(validation.status);
    if (validationStatus === 'valid') return 'valid';
    if (validationStatus === 'invalid') return 'invalid';
    if (validationStatus === 'incomplete') return 'incomplete';
    const missing = Array.isArray(validation.missingArtifacts) ? validation.missingArtifacts : [];
    if (missing.length > 0) return 'incomplete';
    return 'valid';
  }
  const manifestStatus = asString(data.status);
  if (manifestStatus === 'complete') return 'valid';
  if (manifestStatus === 'invalid') return 'invalid';
  if (manifestStatus === 'incomplete') return 'incomplete';
  return 'unknown';
}

function deriveExportRef(data: Record<string, unknown> | undefined): OutputRef | null {
  if (!data) return null;
  const exports = data.exports;
  if (!Array.isArray(exports) || exports.length === 0) return null;
  for (const entry of exports) {
    const record = asRecord(entry);
    if (!record) continue;
    const ref = normalizeOutputRef(record);
    if (ref) return ref;
  }
  return null;
}

function deriveMissingFromValidation(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const validation = asRecord(data.validation);
  if (!validation) return [];
  const raw = validation.missingArtifacts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

async function liveEvidenceView(stored: StoredRun, orchestrator: OrchestratorClient): Promise<Record<string, unknown>> {
  const liveRunId = liveArtifactRunId(stored);
  if (!liveRunId || !orchestrator.enabled) {
    return {
      ...incompleteEnvelope(stored, ['evidence-pack-manifest'], 'Live run id is unavailable; orchestrator has not yet accepted this run.'),
      packId: '',
      manifestUri: '',
      manifestHash: '',
      validationStatus: 'unknown',
      exportRef: null,
    };
  }
  try {
    const upstream = await orchestrator.getEvidence(liveRunId);
    if (!upstream || upstream.status < 200 || upstream.status >= 300) {
      return {
        ...incompleteEnvelope(stored, ['evidence-pack-manifest'], 'Orchestrator did not return an evidence pack manifest for this run.'),
        packId: '',
        manifestUri: '',
        manifestHash: '',
        validationStatus: 'unknown',
        exportRef: null,
      };
    }
    const envelope = asRecord(upstream.body) ?? {};
    const data = asRecord(envelope.data);
    const artifactRef = asRecord(envelope.artifactRef);
    const envelopeMissing = Array.isArray(envelope.missingArtifacts)
      ? (envelope.missingArtifacts as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    const validationMissing = deriveMissingFromValidation(data);
    const missing = Array.from(new Set([...envelopeMissing, ...validationMissing]));
    const packId = asString(data?.packId);
    const manifestUri = asString(artifactRef?.uri);
    const manifestHash = asString(artifactRef?.sha256);
    const exportRef = deriveExportRef(data);
    const validationStatus = deriveValidationStatus(data);
    const status: 'complete' | 'incomplete' | 'invalid' =
      missing.length === 0 && validationStatus === 'valid'
        ? 'complete'
        : validationStatus === 'invalid'
          ? 'invalid'
          : 'incomplete';
    return {
      runId: stored.runId,
      programId: stored.programId || asString(envelope.programId),
      mode: 'live',
      productMode: status === 'complete' ? 'live' : 'unavailable',
      status,
      packId,
      manifestUri,
      manifestHash,
      validationStatus,
      exportRef,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
      artifactRef: artifactRef ?? null,
    };
  } catch (err) {
    return {
      ...incompleteEnvelope(stored, ['evidence-pack-manifest'], err instanceof Error ? err.message : 'orchestrator request failed'),
      packId: '',
      manifestUri: '',
      manifestHash: '',
      validationStatus: 'unknown',
      exportRef: null,
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
      productMode: productModeOf(stored),
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
        productMode: productModeOf(stored),
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
      productMode: 'live',
      events,
      missingArtifacts: missing,
      orchestratorRunId: liveRunId,
    };
  } catch (err) {
    return {
      runId: stored.runId,
      programId: stored.programId,
      mode: stored.mode,
      productMode: productModeOf(stored),
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

        const referenceMatch = samples.get(programId);
        if (referenceMatch && !referenceMatch.supportedInProductMode) {
          jsonResponse(res, 400, {
            error: `reference program ${programId} is not supportedInProductMode; refusing to dispatch through /api/v0/transform`,
          });
          return;
        }

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

        if (!config.enableDiagnosticFixtures) {
          jsonResponse(res, 503, {
            error:
              'product mode not ready: orchestrator URL is required (set C2C_ORCHESTRATOR_URL). Developer-only diagnostic fixtures can be opted into with C2C_ENABLE_DIAGNOSTIC_FIXTURES=true; the resulting run is labelled diagnostic-fixture and is never a product result.',
          });
          return;
        }

        const stored = runStore.create(sample, 'diagnostic-fixture');
        const completed = runStore.update(stored.runId, {
          status: 'completed',
          message: 'diagnostic fixture run completed (C2C_ENABLE_DIAGNOSTIC_FIXTURES); not a product result',
          evidenceRefs: [stored.fixture?.evidence.manifestUri ?? ''],
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
        if (stored.mode === 'diagnostic-fixture' && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureGeneratedView(stored));
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
        if (stored.mode === 'diagnostic-fixture' && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureBuildTestView(stored));
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
        if (stored.mode === 'diagnostic-fixture' && stored.fixture) {
          jsonResponse(res, 200, diagnosticFixtureEvidenceView(stored));
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
        if (stored.mode === 'diagnostic-fixture') {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: stored.mode,
            productMode: 'unavailable',
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
        if (stored.mode === 'diagnostic-fixture') {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: 'diagnostic-fixture',
            productMode: 'unavailable',
            artifacts: [],
            note: 'Diagnostic-fixture runs do not persist on-disk artifacts; not a product result.',
          });
          return;
        }
        const liveRunId = liveArtifactRunId(stored);
        if (!liveRunId || !orchestrator.enabled) {
          jsonResponse(res, 200, {
            runId: stored.runId,
            programId: stored.programId,
            mode: 'live',
            productMode: 'unavailable',
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
              productMode: 'unavailable',
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
            productMode: 'live',
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
