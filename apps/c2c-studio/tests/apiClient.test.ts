import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../src/lib/apiClient';

describe('apiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.unstubAllEnvs();
  });

  it('fetches health successfully with default same-origin relative path', async () => {
    const mockResponse = { status: 'ok' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith('/api/v0/health', undefined);
    expect(result).toEqual({ ok: true, data: mockResponse });
  });

  it('uses NEXT_PUBLIC_C2C_BFF_BASE_URL if set', async () => {
    vi.stubEnv('NEXT_PUBLIC_C2C_BFF_BASE_URL', 'http://localhost:8080');

    const mockResponse = { status: 'ok' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/api/v0/health', undefined);
    expect(result).toEqual({ ok: true, data: mockResponse });
  });

  it('handles HTTP errors gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toEqual({
      ok: false,
      status: 500,
      message: 'HTTP error 500',
    });
  });

  it('handles network errors gracefully', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network failure'));

    const result = await apiClient.getHealth();

    expect(result).toEqual({
      ok: false,
      message: 'Network failure',
    });
  });
});