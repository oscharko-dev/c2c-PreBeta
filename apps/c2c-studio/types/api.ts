export interface ApiHealthResponse {
  status: string;
  service?: string;
}

export interface ApiModeResponse {
  orchestrator: 'live' | 'mock';
  evidence: 'live' | 'mock';
}

export interface ApiSuccessResult<T> {
  success: true;
  data: T;
  statusCode: number;
}

export interface ApiErrorResult {
  success: false;
  error: string;
  statusCode?: number;
}

export type ApiResult<T> = ApiSuccessResult<T> | ApiErrorResult;
