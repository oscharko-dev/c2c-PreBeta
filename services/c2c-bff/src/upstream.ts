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
}

export interface EvidenceClient {
  enabled: boolean;
  getPack(packId: string): Promise<UpstreamResponse | undefined>;
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
    };
  }
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
