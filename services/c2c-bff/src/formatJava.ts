// Studio-IDE-14 (#256): typed request/response shapes for the
// `POST /api/v0/format/java` BFF route. The BFF only validates the
// request shape and proxies to the build-test-runner-service formatter
// at `/v0/format-java`. Response normalisation tolerates the same
// upstream synonyms the diagnostics module already accepts.
//
// Governed by the schemas under `schemas/format-java-{request,response}-v0.json`.

export const FORMAT_JAVA_SCHEMA_VERSION = "v0" as const;

export interface FormatJavaRequest {
  content: string;
  filePath?: string;
}

export interface FormatJavaResponse {
  schemaVersion: typeof FORMAT_JAVA_SCHEMA_VERSION;
  formattedContent: string;
}

// Studio-IDE-14 (#256): the BFF surfaces a single failure shape to the
// browser so the editor can render a uniform "Formatter unavailable"
// toast (transient) versus a "Could not format" notice (parse error).
// `code` mirrors the W02 error-code enum used by other BFF failures so
// the Studio's notice surface can branch on it.
export type FormatJavaErrorCode =
  | "format_unavailable"
  | "format_parse_error"
  | "format_input_too_large"
  | "format_input_invalid"
  | "format_upstream_error";

export interface FormatJavaError {
  schemaVersion: typeof FORMAT_JAVA_SCHEMA_VERSION;
  status: "failed";
  code: FormatJavaErrorCode;
  error: string;
  // Optional positional hint for parse errors.
  line?: number;
  column?: number;
}

export interface FormatJavaRequestValidationOk {
  ok: true;
  value: FormatJavaRequest;
}

export interface FormatJavaRequestValidationError {
  ok: false;
  status: 400 | 413;
  body: FormatJavaError;
}

export type FormatJavaRequestValidation =
  | FormatJavaRequestValidationOk
  | FormatJavaRequestValidationError;

// Validate the inbound JSON. Returns either a typed request or a 4xx body
// for the caller to write directly. The size check is enforced both here
// and at the body-read stage so an oversized stream is rejected before it
// is parsed (cheaper) AND a small JSON body whose `content` field is huge
// is rejected after parse (the readJsonBody cap is on the wire bytes, not
// the decoded string).
export function validateFormatJavaRequest(
  raw: unknown,
  options: { maxContentBytes: number },
): FormatJavaRequestValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      body: {
        schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
        status: "failed",
        code: "format_input_invalid",
        error: "request body must be a JSON object",
      },
    };
  }
  const record = raw as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== "string") {
    return {
      ok: false,
      status: 400,
      body: {
        schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
        status: "failed",
        code: "format_input_invalid",
        error: "content must be a string",
      },
    };
  }
  // UTF-8 byte size is what the upstream actually transports.
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > options.maxContentBytes) {
    return {
      ok: false,
      status: 413,
      body: {
        schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
        status: "failed",
        code: "format_input_too_large",
        error: `content exceeds ${options.maxContentBytes} bytes`,
      },
    };
  }
  const filePathRaw = record.filePath;
  let filePath: string | undefined;
  if (filePathRaw !== undefined) {
    if (typeof filePathRaw !== "string" || filePathRaw.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
          status: "failed",
          code: "format_input_invalid",
          error: "filePath must be a non-empty string when provided",
        },
      };
    }
    filePath = filePathRaw;
  }
  return { ok: true, value: { content, ...(filePath ? { filePath } : {}) } };
}

// Normalise an upstream response from /v0/format-java into either the
// Studio-facing success body or a structured failure. The upstream is
// trusted but defensive parsing keeps a malformed payload from crashing
// the BFF — failures fall through to a generic format_upstream_error.
export function normaliseUpstreamResponse(args: {
  status: number;
  body: unknown;
}):
  | { kind: "ok"; body: FormatJavaResponse }
  | { kind: "error"; status: number; body: FormatJavaError } {
  const { status, body } = args;
  if (status >= 200 && status < 300) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const formatted = (body as Record<string, unknown>).formattedContent;
      if (typeof formatted === "string") {
        return {
          kind: "ok",
          body: {
            schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
            formattedContent: formatted,
          },
        };
      }
    }
    return {
      kind: "error",
      status: 502,
      body: {
        schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
        status: "failed",
        code: "format_upstream_error",
        error: "formatter returned an unexpected payload",
      },
    };
  }
  // The Java service returns 422 with line/column on parse errors.
  if (status === 422 && body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message =
      typeof record.error === "string" ? record.error : "could not format Java";
    const error: FormatJavaError = {
      schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
      status: "failed",
      code: "format_parse_error",
      error: message,
    };
    if (
      typeof record.line === "number" &&
      Number.isInteger(record.line) &&
      record.line > 0
    ) {
      error.line = record.line;
    }
    if (
      typeof record.column === "number" &&
      Number.isInteger(record.column) &&
      record.column > 0
    ) {
      error.column = record.column;
    }
    return { kind: "error", status: 422, body: error };
  }
  // Bad request from upstream — we already validated, so this is rare;
  // surface as upstream error so the Studio can show the generic toast.
  const errorField =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).error
      : undefined;
  const upstreamMessage =
    typeof errorField === "string" && errorField.length > 0
      ? errorField
      : `formatter returned status ${status}`;
  return {
    kind: "error",
    status: 502,
    body: {
      schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
      status: "failed",
      code: "format_upstream_error",
      error: upstreamMessage,
    },
  };
}

export function formatUnavailable(message: string): FormatJavaError {
  return {
    schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
    status: "failed",
    code: "format_unavailable",
    error: message,
  };
}

export function formatInputTooLarge(maxContentBytes: number): FormatJavaError {
  return {
    schemaVersion: FORMAT_JAVA_SCHEMA_VERSION,
    status: "failed",
    code: "format_input_too_large",
    error: `content exceeds ${maxContentBytes} bytes`,
  };
}
