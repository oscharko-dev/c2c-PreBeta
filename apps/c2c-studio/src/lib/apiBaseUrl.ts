// Standalone module owning the BFF base-URL resolution. Split out of
// `apiClient.ts` so callers that need only the URL (e.g.
// `editorTelemetry.ts`) can import it without dragging the full
// apiClient surface through vitest mocks. The apiClient re-exports
// `resolveApiBaseUrl` to keep the existing import path working.

import type { ApiErrorDetails, ApiResult } from "@/types/api";

const LOCAL_OVERRIDE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function createFailure<T>(
  message: string,
  details: ApiErrorDetails,
  status?: number,
): ApiResult<T> {
  return { ok: false, status, message, details } as ApiResult<T>;
}

export function resolveApiBaseUrl(
  envValue = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL,
): ApiResult<string> {
  if (!envValue) {
    return { ok: true, data: "" };
  }

  let parsed: URL;
  try {
    parsed = new URL(envValue);
  } catch (cause) {
    return createFailure(
      "Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must be an absolute URL.",
      { kind: "config", cause },
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return createFailure(
      "Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must use http or https.",
      { kind: "config", cause: parsed.protocol },
    );
  }

  if (!LOCAL_OVERRIDE_HOSTS.has(parsed.hostname)) {
    return createFailure(
      "Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL is limited to local split-server development.",
      { kind: "config", cause: parsed.hostname },
    );
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return createFailure(
      "Runtime configuration error: NEXT_PUBLIC_C2C_BFF_BASE_URL must not include a path, query, or hash.",
      { kind: "config", cause: envValue },
    );
  }

  return { ok: true, data: parsed.origin };
}
