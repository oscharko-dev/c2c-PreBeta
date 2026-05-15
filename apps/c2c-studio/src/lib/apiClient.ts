import { ApiErrorDetails, ApiResult, HealthResponse, ModeResponse } from '../types/api';
import { Sample, SampleDetail, TransformRequest, TransformResponse } from '../types/reference-program';

const LOCAL_OVERRIDE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function createFailure<T>(message: string, details: ApiErrorDetails, status?: number): ApiResult<T> {
  return { ok: false, status, message, details } as ApiResult<T>;
}

export function resolveApiBaseUrl(envValue = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL): ApiResult<string> {
  if (!envValue) {
    return { ok: true, data: '' };
  }

  let parsed: URL;
  try {
    parsed = new URL(envValue);
  } catch (cause) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must be an absolute URL.',
      { kind: 'config', cause },
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must use http or https.',
      { kind: 'config', cause: parsed.protocol },
    );
  }

  if (!LOCAL_OVERRIDE_HOSTS.has(parsed.hostname)) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL is limited to local split-server development.',
      { kind: 'config', cause: parsed.hostname },
    );
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return createFailure(
      'Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must not include a path, query, or hash.',
      { kind: 'config', cause: envValue },
    );
  }

  return { ok: true, data: parsed.origin };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHealthResponse(payload: unknown): ApiResult<HealthResponse> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: health payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }

  if (payload.status !== 'ok') {
    return createFailure('Contract error: health payload must contain status="ok".', {
      kind: 'contract',
      body: payload,
    });
  }

  return { ok: true, data: payload as HealthResponse };
}

function parseModeResponse(payload: unknown): ApiResult<ModeResponse> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: mode payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }

  if (
    (payload.orchestrator !== 'live' && payload.orchestrator !== 'mock') ||
    (payload.evidence !== 'live' && payload.evidence !== 'mock')
  ) {
    return createFailure(
      'Contract error: mode payload must contain orchestrator/evidence fields with "live" or "mock".',
      { kind: 'contract', body: payload },
    );
  }

  return { ok: true, data: payload as ModeResponse };
}

async function fetchJson<T>(
  path: string,
  parser: (payload: unknown) => ApiResult<T>,
  options?: RequestInit,
): Promise<ApiResult<T>> {
  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    return baseUrlResult;
  }

  try {
    const response = await fetch(`${baseUrlResult.data}${path}`, options);
    const rawBody = await response.text();
    let payload: unknown = null;

    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch (cause) {
        return createFailure('Contract error: API returned malformed JSON.', {
          kind: 'parse',
          body: rawBody,
          cause,
        });
      }
    }

    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `HTTP error ${response.status}`;
      return createFailure(message, { kind: 'http', body: payload }, response.status);
    }

    return parser(payload);
  } catch (cause) {
    return createFailure(
      cause instanceof Error ? cause.message : 'Network error',
      { kind: 'network', cause },
    );
  }
}

function parseSamplesResponse(payload: unknown): ApiResult<Sample[]> {
  if (!Array.isArray(payload)) {
    return createFailure('Contract error: samples payload must be an array.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload as Sample[] };
}

function parseSampleDetailResponse(payload: unknown): ApiResult<SampleDetail> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: sample detail payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload as unknown as SampleDetail };
}

function parseTransformResponse(payload: unknown): ApiResult<TransformResponse> {
  if (!isRecord(payload)) {
    return createFailure('Contract error: transform payload must be a JSON object.', {
      kind: 'contract',
      body: payload,
    });
  }
  return { ok: true, data: payload as unknown as TransformResponse };
}

export const apiClient = {
  getHealth: () => fetchJson('/api/v0/health', parseHealthResponse),
  getMode: () => fetchJson('/api/v0/mode', parseModeResponse),
  getSamples: () => fetchJson('/api/v0/samples', parseSamplesResponse),
  getSampleDetail: (programId: string) => fetchJson(`/api/v0/samples/${encodeURIComponent(programId)}`, parseSampleDetailResponse),
  transform: (request: TransformRequest) => 
    fetchJson('/api/v0/transform', parseTransformResponse, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    }),
};
