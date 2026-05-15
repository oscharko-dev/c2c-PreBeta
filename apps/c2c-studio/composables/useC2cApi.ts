import type { ApiHealthResponse, ApiModeResponse, ApiResult } from '~/types/api';
import { useRuntimeConfig } from '#app';
import { useFetch } from '#imports';

export const useC2cApi = () => {
  const config = useRuntimeConfig();
  const baseUrl = String(config.public.c2cBffBaseUrl ?? '').trim();

  const missingBaseUrlResult = (): ApiResult<never> => ({
    success: false,
    error: 'NUXT_PUBLIC_C2C_BFF_BASE_URL is not set.',
  });

  const getHealth = async (): Promise<ApiResult<ApiHealthResponse>> => {
    if (!baseUrl) {
      return missingBaseUrlResult();
    }

    try {
      const { data, error, status } = await useFetch<ApiHealthResponse>('/api/v0/health', {
        baseURL: baseUrl
      });

      if (error.value) {
        return {
          success: false,
          error: error.value.message || 'Health check failed',
          statusCode: error.value.statusCode || 500
        };
      }

      return {
        success: true,
        data: data.value as ApiHealthResponse,
        statusCode: status.value as number || 200
      };
    } catch (error: unknown) {
      const cause = error as { message?: string; statusCode?: number };
      return {
        success: false,
        error: cause.message || 'Network error',
        statusCode: cause.statusCode
      };
    }
  };

  const getMode = async (): Promise<ApiResult<ApiModeResponse>> => {
    if (!baseUrl) {
      return missingBaseUrlResult();
    }

    try {
      const { data, error, status } = await useFetch<ApiModeResponse>('/api/v0/mode', {
        baseURL: baseUrl
      });

      if (error.value) {
        return {
          success: false,
          error: error.value.message || 'Mode check failed',
          statusCode: error.value.statusCode || 500
        };
      }

      return {
        success: true,
        data: data.value as ApiModeResponse,
        statusCode: status.value as number || 200
      };
    } catch (error: unknown) {
      const cause = error as { message?: string; statusCode?: number };
      return {
        success: false,
        error: cause.message || 'Network error',
        statusCode: cause.statusCode
      };
    }
  };

  return {
    getHealth,
    getMode
  };
};
