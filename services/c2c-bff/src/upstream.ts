import * as http from 'node:http';
import * as https from 'node:https';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

export interface UpstreamResponse {
  status: number;
  body: unknown;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface HttpClient {
  request(targetUrl: string, options: HttpRequestOptions): Promise<UpstreamResponse>;
}

export function createNodeHttpClient(): HttpClient {
  return {
    request(targetUrl, options) {
      return new Promise<UpstreamResponse>((resolve, reject) => {
        let parsed: URL;
        try {
          parsed = new URL(targetUrl);
        } catch (err) {
          reject(err instanceof Error ? err : new Error('invalid url'));
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

        const req = transport.request(
          {
            method: options.method ?? 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
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
              resolve({ status: res.statusCode ?? 0, body });
            });
            res.on('error', reject);
          },
        );

        req.setTimeout(options.timeoutMs, () => {
          req.destroy(new Error(`upstream request timed out after ${options.timeoutMs}ms`));
        });
        req.on('error', reject);
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
  }): Promise<UpstreamResponse | undefined>;
  getRun(runId: string): Promise<UpstreamResponse | undefined>;
  getArtifacts(runId: string): Promise<UpstreamResponse | undefined>;
  getGenerated(runId: string): Promise<UpstreamResponse | undefined>;
  getGeneratedFiles(runId: string): Promise<UpstreamResponse | undefined>;
  getGeneratedFile(runId: string, filePath: string): Promise<UpstreamResponse | undefined>;
  getBuildTest(runId: string): Promise<UpstreamResponse | undefined>;
  getEvidence(runId: string): Promise<UpstreamResponse | undefined>;
  getEvents(runId: string): Promise<UpstreamResponse | undefined>;
  // Issue #96: step-level pipeline progress for UI-started runs.
  getProgress(runId: string): Promise<UpstreamResponse | undefined>;
  // Issue #96: experience-learning summary view sourced via orchestrator.
  getLearning(runId: string): Promise<UpstreamResponse | undefined>;
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
    async startTransformRun({ programId, sourceText, requester, sourceName, options }) {
      const sha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');
      const payload = {
        requester: requester ?? 'c2c-ui',
        inputRef: {
          kind: 'source',
          uri: `urn:c2c/ui-source/${sha256}`,
          sourceText,
          sha256,
          byteSize: Buffer.byteLength(sourceText, 'utf8'),
          mimeType: 'text/x-cobol',
        },
        evidenceRefs: [],
        modelPrompt: '',
        programId,
        ...(typeof sourceName === 'string' && sourceName.length > 0 ? { sourceName } : {}),
        ...(options === undefined ? {} : { options }),
      };
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
    async getGeneratedFile(runId: string, filePath: string) {
      const safeRun = encodeURIComponent(runId);
      const encodedPath = filePath
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      return http.request(`${baseUrl}/v0/runs/${safeRun}/generated/files/${encodedPath}`, {
        method: 'GET',
        timeoutMs,
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
