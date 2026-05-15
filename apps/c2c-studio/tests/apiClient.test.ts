import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, resolveApiBaseUrl } from '../src/lib/apiClient';

describe('resolveApiBaseUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to same-origin relative calls', () => {
    expect(resolveApiBaseUrl()).toEqual({ ok: true, data: '' });
  });

  it('accepts a localhost split-server override', () => {
    expect(resolveApiBaseUrl('http://localhost:18089')).toEqual({
      ok: true,
      data: 'http://localhost:18089',
    });
  });

  it('rejects non-local overrides', () => {
    const result = resolveApiBaseUrl('https://api.example.com');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'config' },
    });
  });

  it('rejects non-root paths, query strings, and hashes in the override URL', () => {
    const result = resolveApiBaseUrl('http://localhost:18089/api?x=1#frag');
    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'config' },
    });
  });

  it('rejects non-http schemes', () => {
    const result = resolveApiBaseUrl('ftp://localhost:18089');
    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'config' },
    });
  });
});

describe('apiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.unstubAllEnvs();
  });

  it('fetches health successfully with default same-origin relative path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ status: 'ok' }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith('/api/v0/health', undefined);
    expect(result).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('uses NEXT_PUBLIC_C2C_BFF_BASE_URL when configured for local split-server development', async () => {
    vi.stubEnv('NEXT_PUBLIC_C2C_BFF_BASE_URL', 'http://localhost:18089');
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ status: 'ok' }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith('http://localhost:18089/api/v0/health', undefined);
    expect(result).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('fetches mode successfully and preserves explicit reachability fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ orchestrator: 'live', evidence: 'mock', service: 'c2c-bff' }),
    } as Response);

    const result = await apiClient.getMode();

    expect(result).toEqual({
      ok: true,
      data: { orchestrator: 'live', evidence: 'mock', service: 'c2c-bff' },
    });
  });

  it('rejects malformed transform payloads that miss required links', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: 'run-1',
          orchestratorRunId: 'orch-1',
          programId: 'P1',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:01Z',
        }),
    } as Response);

    const result = await apiClient.transform({
      sourceText: '      IDENTIFICATION DIVISION.',
      programId: 'P1',
      sourceName: 'sample.cbl',
    });

    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'contract' },
    });
  });

  it('rejects malformed run payloads with invalid status values', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: 'run-1',
          programId: 'P1',
          status: 'running',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:01Z',
        }),
    } as Response);

    const result = await apiClient.getRun('run-1');

    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'contract' },
    });
  });

  it('rejects malformed artifacts payloads with invalid artifact metadata', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: 'run-1',
          programId: 'P1',
          mode: 'live',
          productMode: 'live',
          artifacts: [
            {
              uri: 'file:///run/source.cbl',
              sha256: 'a'.repeat(64),
              byteSize: -1,
              mimeType: 'text/plain',
              kind: 'source',
              createdBy: 'orchestrator',
              createdAt: '2026-05-15T10:00:00Z',
              runId: 'run-1',
              workflowId: 'w0',
              path: 'source.cbl',
              name: 'source.cbl',
            },
          ],
        }),
    } as Response);

    const result = await apiClient.getRunArtifacts('run-1');

    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'contract' },
    });
  });

  it('accepts evidence payloads that report invalid validation state', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: 'run-1',
          programId: 'P1',
          mode: 'live',
          productMode: 'live',
          status: 'invalid',
          generatedArtifactRef: { uri: 'file:///runs/run-1/generated.json', sha256: 'a'.repeat(64) },
        }),
    } as Response);

    const result = await apiClient.getEvidence('run-1');

    expect(result).toEqual({
      ok: true,
      data: {
        runId: 'run-1',
        programId: 'P1',
        mode: 'live',
        productMode: 'live',
        status: 'invalid',
        generatedArtifactRef: { uri: 'file:///runs/run-1/generated.json', sha256: 'a'.repeat(64) },
      },
    });
  });

  it('fails on invalid runtime configuration instead of falling back to an internal service URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_C2C_BFF_BASE_URL', 'https://internal.example.net');

    const result = await apiClient.getHealth();

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'config' },
    });
  });

  it('handles HTTP failures without converting them into success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'orchestrator unavailable' }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toEqual({
      ok: false,
      status: 503,
      message: 'orchestrator unavailable',
      details: { kind: 'http', body: { error: 'orchestrator unavailable' } },
    });
  });

  it('handles network failures without converting them into success', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network failure'));

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      message: 'Network failure',
      details: { kind: 'network' },
    });
  });

  it('reports malformed JSON as a contract failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => '{not-json',
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      message: 'Contract error: API returned malformed JSON.',
      details: { kind: 'parse' },
    });
  });

  it('reports unexpected payload shapes as contract failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ state: 'ok' }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      details: { kind: 'contract', body: { state: 'ok' } },
    });
  });
});
