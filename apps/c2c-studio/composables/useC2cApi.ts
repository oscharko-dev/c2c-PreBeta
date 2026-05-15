import type { ApiHealthResponse, ApiModeResponse, ApiResult } from '~/types/api';
import { useRuntimeConfig } from '#app';
import { useFetch } from '#imports';

export const useC2cApi = () => {
  const config = useRuntimeConfig();
  const baseUrl = config.public.c2cBffBaseUrl;

  const getHealth = async (): Promise<ApiResult<ApiHealthResponse>> => {
    try {
      const { data, error, status } = await useFetch<ApiHealthResponse>('/api/v0/health', {
        baseURL: baseUrl as string
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
    } catch (e: any) {
      return {
        success: false,
        error: e.message || 'Network error'
      };
    }
  };

  const getMode = async (): Promise<ApiResult<ApiModeResponse>> => {
    try {
      const { data, error, status } = await useFetch<ApiModeResponse>('/api/v0/mode', {
        baseURL: baseUrl as string
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
    } catch (e: any) {
      return {
        success: false,
        error: e.message || 'Network error'
      };
    }
  };

  return {
    getHealth,
    getMode
  };
};
