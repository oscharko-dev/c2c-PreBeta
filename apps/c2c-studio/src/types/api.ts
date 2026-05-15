export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string; details?: unknown };

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

export interface ModeResponse {
  [key: string]: unknown;
}