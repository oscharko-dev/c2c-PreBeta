import { ApiResult, HealthResponse, ModeResponse } from '../types/api';

function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || '';
  }
  return process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || '';
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<ApiResult<T>> {
  try {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: `HTTP error ${response.status}`,
      };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export const apiClient = {
  getHealth: () => fetchApi<HealthResponse>('/api/v0/health'),
  getMode: () => fetchApi<ModeResponse>('/api/v0/mode'),
};