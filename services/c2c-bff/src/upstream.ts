import * as http from 'node:http';
import * as https from 'node:https';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

export interface UpstreamResponse {
  status: number;
  body: unknown;
  // Issue #172 follow-up: ``true`` when the streaming reader stopped because
  // the response exceeded the per-request byte cap. The body is still the
  // partial JSON / text the BFF was able to read, but callers must treat the
  // response as untrustworthy and return 413 to the browser.
  truncated?: boolean;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  // Issue #172 follow-up: hard cap on the upstream response body. When set,
  // the client aborts the request as soon as cumulative bytes received
  // exceed the cap, and the resolved response carries ``truncated: true``.
  // A declared ``content-length`` larger than the cap is rejected before
  // any body bytes are consumed.
  maxResponseBytes?: number;
}

// Distinguishable error type so callers can map an oversize upstream to the
// 413/``artifact_too_large`` BFF response without parsing message strings.
export class UpstreamResponseTooLargeError extends Error {
  readonly limit: number;
  readonly declaredByteSize?: number;
  constructor(limit: number, declaredByteSize?: number) {
    super(
      declaredByteSize !== undefined
        ? `upstream response too large: declared ${declaredByteSize} bytes exceeds limit ${limit}`
        : `upstream response too large: exceeded limit ${limit} bytes`,
    );
    this.name = 'UpstreamResponseTooLargeError';
    this.limit = limit;
    this.declaredByteSize = declaredByteSize;
  }
}

export interface HttpClient {
  request(targetUrl: string, options: HttpRequestOptions): Promise<UpstreamResponse>;
}

export function createNodeHttpClient(): HttpClient {
  return {
    request(targetUrl, options) {
      return new Promise<UpstreamResponse>((resolve, reject) => {
        // Issue #172 follow-up: the streaming cap can resolve the promise
        // mid-flight (when the upstream over-runs the byte limit). Guarding
        // with ``settled`` prevents the subsequent ``req.on('error')`` from
        // turning the resolved response into a spurious unhandled rejection.
        let settled = false;
        const safeResolve = (response: UpstreamResponse) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        const safeReject = (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        let parsed: URL;
        try {
          parsed = new URL(targetUrl);
        } catch (err) {
          safeReject(err instanceof Error ? err : new Error('invalid url'));
          return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const bodyBytes = options.body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(options.body), 'utf-8');

        const headers: Record<string, string> = {
          accept: 'application/json',
          ...(options.headers ?? {}),
        };
        if (bodyBytes) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(bodyBytes.length);
        }

        const maxResponseBytes = options.maxResponseBytes;

        const req = transport.request(
          {
            method: options.method ?? 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            headers,
          },
          (res) => {
            // Issue #172 follow-up: early reject on a declared
            // ``content-length`` that already exceeds the cap. Refusing
            // before reading any body bytes is the cheapest defence
            // against an upstream that tries to ship a multi-GB payload.
            if (maxResponseBytes !== undefined) {
              const rawLen = res.headers['content-length'];
              if (typeof rawLen === 'string') {
                const declared = Number(rawLen);
                if (Number.isFinite(declared) && declared > maxResponseBytes) {
                  res.resume();
                  req.destroy();
                  safeReject(new UpstreamResponseTooLargeError(maxResponseBytes, declared));
                  return;
                }
              }
            }
            const chunks: Buffer[] = [];
            let received = 0;
            let truncated = false;
            res.on('data', (chunk: Buffer) => {
              if (truncated) return;
              received += chunk.length;
              if (maxResponseBytes !== undefined && received > maxResponseBytes) {
                truncated = true;
                req.destroy();
                safeResolve({ status: res.statusCode ?? 0, body: null, truncated: true });
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              if (truncated) return;
              const raw = Buffer.concat(chunks).toString('utf-8');
              let body: unknown;
              if (raw.length > 0) {
                try {
                  body = JSON.parse(raw);
                } catch {
                  body = raw;
                }
              } else {
                body = null;
              }
              safeResolve({ status: res.statusCode ?? 0, body });
            });
            res.on('error', (err) => {
              if (truncated) return;
              safeReject(err);
            });
          },
        );

        req.setTimeout(options.timeoutMs, () => {
          req.destroy(new Error(`upstream request timed out after ${options.timeoutMs}ms`));
        });
        req.on('error', safeReject);
        if (bodyBytes) req.write(bodyBytes);
        req.end();
      });
    },
  };
}

export interface OrchestratorClient {
  enabled: boolean;
  startRun(input: { programId: string; cobolSourcePath: string; requester?: string }): Promise<UpstreamResponse | undefined>;
  startTransformRun(input: {
    programId: string;
    sourceText: string;
    requester?: string;
    sourceName?: string;
    options?: unknown;
    targetLanguage?: string;
    expectedOutput?: string;
    oracleInput?: string;
  }): Promise<UpstreamResponse | undefined>;
  getRun(runId: string): Promise<UpstreamResponse | undefined>;
  getArtifacts(runId: string): Promise<UpstreamResponse | undefined>;
  getGenerated(runId: string): Promise<UpstreamResponse | undefined>;
  getGeneratedFiles(runId: string): Promise<UpstreamResponse | undefined>;
  getGeneratedFile(runId: string, filePath: string, maxResponseBytes?: number): Promise<UpstreamResponse | undefined>;
  getBuildTest(runId: string): Promise<UpstreamResponse | undefined>;
  getEvidence(runId: string): Promise<UpstreamResponse | undefined>;
  getEvents(runId: string): Promise<UpstreamResponse | undefined>;
  // Issue #96: step-level pipeline progress for UI-started runs.
  getProgress(runId: string): Promise<UpstreamResponse | undefined>;
  // Issue #96: experience-learning summary view sourced via orchestrator.
  getLearning(runId: string): Promise<UpstreamResponse | undefined>;
  // Issue #172: W0.2 run contract (state machine, repair budget, failure code).
  getWorkflow(runId: string): Promise<UpstreamResponse | undefined>;
}

export interface EvidenceClient {
  enabled: boolean;
  getPack(packId: string): Promise<UpstreamResponse | undefined>;
}

// Issue #96: optional direct client for the experience-learning-service.
// When configured (`C2C_EXPERIENCE_LEARNING_URL`), the BFF can fetch the
// run summary straight from EL instead of going through the orchestrator's
// cached copy.
export interface ExperienceLearningClient {
  enabled: boolean;
  baseUrl: string;
  getRunSummary(runId: string): Promise<UpstreamResponse | undefined>;
}

export function createOrchestratorClient(baseUrl: string, http: HttpClient, timeoutMs: number): OrchestratorClient {
  if (!baseUrl) {
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
    };
  }
  const getRunScopedArtifact = async (runId: string, segment: string): Promise<UpstreamResponse | undefined> => {
    const safe = encodeURIComponent(runId);
    return http.request(`${baseUrl}/v0/runs/${safe}/${segment}`, {
      method: 'GET',
      timeoutMs,
    });
  };
  return {
    enabled: true,
    async startRun({ programId, cobolSourcePath, requester }) {
      const payload = {
        requester: requester ?? 'c2c-bff',
        inputRef: {
          uri: `urn:c2c-bff/sample/${programId}`,
        },
        evidenceRefs: [],
        modelPrompt: '',
        programId,
        cobolSourcePath,
      };
      return http.request(`${baseUrl}/v0/runs`, {
        method: 'POST',
        body: payload,
        timeoutMs,
      });
    },
    async startTransformRun({
      programId,
      sourceText,
      requester,
      sourceName,
      options,
      targetLanguage,
      expectedOutput,
      oracleInput,
    }) {
      const sha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');
      const inputRef: Record<string, unknown> = {
        kind: 'source',
        uri: `urn:c2c/ui-source/${sha256}`,
        sourceText,
        sha256,
        byteSize: Buffer.byteLength(sourceText, 'utf8'),
        mimeType: 'text/x-cobol',
      };
      if (typeof expectedOutput === 'string' && expectedOutput.length > 0) {
        inputRef.expectedOutput = expectedOutput;
      }
      if (typeof oracleInput === 'string' && oracleInput.length > 0) {
        inputRef.oracleInput = oracleInput;
      }
      const payload: Record<string, unknown> = {
        requester: requester ?? 'c2c-ui',
        inputRef,
        evidenceRefs: [],
        modelPrompt: '',
        programId,
        targetLanguage: targetLanguage ?? 'java',
      };
      if (typeof sourceName === 'string' && sourceName.length > 0) {
        payload.sourceName = sourceName;
      }
      if (options !== undefined) {
        payload.options = options;
      }
      return http.request(`${baseUrl}/v0/runs`, {
        method: 'POST',
        body: payload,
        timeoutMs,
      });
    },
    async getRun(runId: string) {
      const safe = encodeURIComponent(runId);
      return http.request(`${baseUrl}/v0/runs/${safe}`, {
        method: 'GET',
        timeoutMs,
      });
    },
    async getArtifacts(runId: string) {
      return getRunScopedArtifact(runId, 'artifacts');
    },
    async getGenerated(runId: string) {
      return getRunScopedArtifact(runId, 'generated');
    },
    async getGeneratedFiles(runId: string) {
      const safe = encodeURIComponent(runId);
      return http.request(`${baseUrl}/v0/runs/${safe}/generated/files`, {
        method: 'GET',
        timeoutMs,
      });
    },
    async getGeneratedFile(runId: string, filePath: string, maxResponseBytes?: number) {
      const safeRun = encodeURIComponent(runId);
      const encodedPath = filePath
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      // Issue #172 follow-up: the artifact-content path is the only response
      // that can carry arbitrarily large user-controlled bytes (a generated
      // Java file). The streaming cap stops a malicious orchestrator from
      // pinning the BFF process before the per-file 413 check runs.
      // The cap is the per-file limit plus a small JSON-envelope budget so a
      // valid file exactly at the limit still round-trips.
      const responseCap = maxResponseBytes === undefined ? undefined : maxResponseBytes + 4096;
      return http.request(`${baseUrl}/v0/runs/${safeRun}/generated/files/${encodedPath}`, {
        method: 'GET',
        timeoutMs,
        maxResponseBytes: responseCap,
      });
    },
    async getBuildTest(runId: string) {
      return getRunScopedArtifact(runId, 'build-test');
    },
    async getEvidence(runId: string) {
      return getRunScopedArtifact(runId, 'evidence');
    },
    async getEvents(runId: string) {
      return getRunScopedArtifact(runId, 'events');
    },
    async getProgress(runId: string) {
      return getRunScopedArtifact(runId, 'progress');
    },
    async getLearning(runId: string) {
      return getRunScopedArtifact(runId, 'learning');
    },
    async getWorkflow(runId: string) {
      return getRunScopedArtifact(runId, 'workflow');
    },
  };
}

export function createExperienceLearningClient(
  baseUrl: string,
  http: HttpClient,
  timeoutMs: number,
): ExperienceLearningClient {
  if (!baseUrl) {
    return {
      enabled: false,
      baseUrl: '',
      async getRunSummary() {
        return undefined;
      },
    };
  }
  const normalized = baseUrl.replace(/\/+$/, '');
  return {
    enabled: true,
    baseUrl: normalized,
    async getRunSummary(runId: string) {
      const safe = encodeURIComponent(runId);
      return http.request(`${normalized}/v0/runs/${safe}/summary`, {
        method: 'GET',
        timeoutMs,
      });
    },
  };
}

export function createEvidenceClient(baseUrl: string, http: HttpClient, timeoutMs: number): EvidenceClient {
  if (!baseUrl) {
    return {
      enabled: false,
      async getPack() {
        return undefined;
      },
    };
  }
  return {
    enabled: true,
    async getPack(packId: string) {
      const safe = encodeURIComponent(packId);
      return http.request(`${baseUrl}/v0/packs/${safe}`, {
        method: 'GET',
        timeoutMs,
      });
    },
  };
}

export interface ModelGatewayClient {
  enabled: boolean;
  getHealth(): Promise<UpstreamResponse | undefined>;
  getModels(): Promise<UpstreamResponse | undefined>;
}

export interface HarnessClient {
  enabled: boolean;
  getReady(): Promise<UpstreamResponse | undefined>;
}

export function createModelGatewayClient(baseUrl: string, http: HttpClient, timeoutMs: number): ModelGatewayClient {
  if (!baseUrl) {
    return {
      enabled: false,
      async getHealth() { return undefined; },
      async getModels() { return undefined; },
    };
  }
  const normalized = baseUrl.replace(/\/+$/, '');
  return {
    enabled: true,
    async getHealth() {
      return http.request(`${normalized}/v0/health`, { method: 'GET', timeoutMs });
    },
    async getModels() {
      return http.request(`${normalized}/v0/models`, { method: 'GET', timeoutMs });
    },
  };
}

export function createHarnessClient(baseUrl: string, http: HttpClient, timeoutMs: number): HarnessClient {
  if (!baseUrl) {
    return {
      enabled: false,
      async getReady() { return undefined; },
    };
  }
  const normalized = baseUrl.replace(/\/+$/, '');
  return {
    enabled: true,
    async getReady() {
      return http.request(`${normalized}/v0/ready`, { method: 'GET', timeoutMs });
    },
  };
}
