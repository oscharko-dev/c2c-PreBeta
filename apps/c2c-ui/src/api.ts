import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  ModeResponse,
  RunSummary,
  SampleDetail,
  SampleSummary,
} from './types.js';

export class BffError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'BffError';
  }
}

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface BffApi {
  getMode(): Promise<ModeResponse>;
  listSamples(): Promise<SampleSummary[]>;
  getSample(programId: string): Promise<SampleDetail>;
  startRun(programId: string): Promise<RunSummary>;
  getRun(runId: string): Promise<RunSummary>;
  getGenerated(runId: string): Promise<GeneratedView>;
  getBuildTest(runId: string): Promise<BuildTestView>;
  getEvidence(runId: string): Promise<EvidenceView>;
}

export function createBffApi(options: { baseUrl?: string; fetchImpl?: FetchLike } = {}): BffApi {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : (async () => {
    throw new BffError('no fetch implementation available', 0);
  }) as FetchLike));

  async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    let bodyText: string | undefined;
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyText = JSON.stringify(init.body);
    }
    const response = await fetchImpl(url, { method: init?.method ?? 'GET', headers, body: bodyText });
    const raw = await response.text();
    let parsed: unknown = raw;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    if (!response.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
          ? (parsed as { error: string }).error
          : `request to ${path} failed with status ${response.status}`;
      throw new BffError(message, response.status);
    }
    return parsed as T;
  }

  return {
    getMode: () => request<ModeResponse>('/api/v0/mode'),
    listSamples: () => request<SampleSummary[]>('/api/v0/samples'),
    getSample: (programId) => request<SampleDetail>(`/api/v0/samples/${encodeURIComponent(programId)}`),
    startRun: (programId) => request<RunSummary>('/api/v0/runs', { method: 'POST', body: { programId } }),
    getRun: (runId) => request<RunSummary>(`/api/v0/runs/${encodeURIComponent(runId)}`),
    getGenerated: (runId) => request<GeneratedView>(`/api/v0/runs/${encodeURIComponent(runId)}/generated`),
    getBuildTest: (runId) => request<BuildTestView>(`/api/v0/runs/${encodeURIComponent(runId)}/build-test`),
    getEvidence: (runId) => request<EvidenceView>(`/api/v0/runs/${encodeURIComponent(runId)}/evidence`),
  };
}
