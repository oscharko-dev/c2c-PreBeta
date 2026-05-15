import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useC2cApi } from '../composables/useC2cApi';
import { registerEndpoint, clearEndpoints, mockNuxtImport } from '@nuxt/test-utils/runtime';

const { mockUseFetch } = vi.hoisted(() => ({
  mockUseFetch: vi.fn()
}));

mockNuxtImport('useFetch', () => mockUseFetch);

vi.mock('#app', () => ({
  useRuntimeConfig: () => ({
    public: {
      c2cBffBaseUrl: 'http://test-bff'
    }
  })
}));

describe('useC2cApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getHealth returns success state on ok response', async () => {
    mockUseFetch.mockResolvedValue({
      data: { value: { status: 'ok' } },
      error: { value: null },
      status: { value: 200 }
    });

    const { getHealth } = useC2cApi();
    const result = await getHealth();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
    }
  });

  it('getHealth returns error state on failed response', async () => {
    mockUseFetch.mockResolvedValue({
      data: { value: null },
      error: { value: { message: '503 Internal Server Error', statusCode: 503 } },
      status: { value: 503 }
    });

    const { getHealth } = useC2cApi();
    const result = await getHealth();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('503 Internal Server Error');
      expect(result.statusCode).toBe(503);
    }
  });

  it('getMode returns mode and upstream reachability', async () => {
    mockUseFetch.mockResolvedValue({
      data: { value: { mode: 'live', upstream_reachable: true } },
      error: { value: null },
      status: { value: 200 }
    });

    const { getMode } = useC2cApi();
    const result = await getMode();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('live');
      expect(result.data.upstream_reachable).toBe(true);
    }
  });
});
