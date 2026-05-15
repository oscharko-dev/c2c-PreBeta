export interface ApiHealthResponse {
  status: string;
}

export interface ApiModeResponse {
  mode: string;
  upstream_reachable: boolean;
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
