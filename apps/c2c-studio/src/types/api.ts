export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string; details?: ApiErrorDetails };

export type ApiErrorKind = 'config' | 'http' | 'network' | 'parse' | 'contract';

export interface ApiErrorDetails {
  kind: ApiErrorKind;
  body?: unknown;
  cause?: unknown;
}

export interface HealthResponse {
  status: 'ok';
  [key: string]: unknown;
}

export type UpstreamMode = 'live' | 'mock';

export interface ModeResponse {
  orchestrator: UpstreamMode;
  evidence: UpstreamMode;
  [key: string]: unknown;
}
