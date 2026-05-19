// Studio-IDE-14 (#256): client wrapper around `POST /api/v0/format/java`.
// The Java editor invokes this on Cmd/Ctrl+Shift+F (and opt-in
// format-on-save). The wrapper is deliberately narrow:
//
//   * One typed success shape (`FormatJavaSuccess`) and one typed failure
//     shape (`FormatJavaFailure`) the editor maps directly onto a toast.
//   * AbortSignal support so the editor can cancel the call when the user
//     starts typing again or unmounts the pane mid-flight.
//   * A latency budget enforced via `AbortController` — when the network
//     stalls beyond `timeoutMs`, the wrapper turns it into a
//     `format_unavailable` failure rather than hanging the action.
//
// The wrapper does NOT touch Monaco. Buffer replacement is the caller's
// responsibility (see GeneratedJavaEditorPane.tsx) so the format remains
// a single atomic edit / single undo step.

import { resolveApiBaseUrl } from "@/lib/apiClient";
import {
  bucketFileLineCount,
  bucketFormatLatency,
  emit as emitTelemetry,
} from "@/lib/editor/editorTelemetry";

export type FormatJavaErrorCode =
  | "format_unavailable"
  | "format_parse_error"
  | "format_input_too_large"
  | "format_input_invalid"
  | "format_upstream_error";

export interface FormatJavaSuccess {
  ok: true;
  formattedContent: string;
}

export interface FormatJavaFailure {
  ok: false;
  code: FormatJavaErrorCode;
  message: string;
  // 1-indexed source position when the upstream pinpoints the parse error.
  line?: number;
  column?: number;
  // HTTP status the BFF returned, when known. Helpful for debugging in the
  // dev console but the editor branches on `code`, not the status.
  status?: number;
}

export type FormatJavaResult = FormatJavaSuccess | FormatJavaFailure;

export interface FormatJavaRequestPayload {
  content: string;
  filePath?: string;
}

export interface FormatJavaClientOptions {
  signal?: AbortSignal;
  // Per Studio-IDE-14 AC the editor must return within 1.5 s for 1000-line
  // files. The default applied here gives the user the same budget; the
  // caller can lower it for stricter UX scenarios.
  timeoutMs?: number;
  // Test seam — defaults to `globalThis.fetch`.
  fetchImpl?: typeof fetch;
  // Studio-IDE-11 (#251): how the format was triggered. Drives the
  // closed-enum `format.invoked.trigger` field. Defaults to
  // `"shortcut"` when the caller does not pass anything.
  telemetryTrigger?: "shortcut" | "on_save";
}

const DEFAULT_TIMEOUT_MS = 1500;

function buildFailure(
  code: FormatJavaErrorCode,
  message: string,
  extra: { status?: number; line?: number; column?: number } = {},
): FormatJavaFailure {
  return {
    ok: false,
    code,
    message,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.line !== undefined ? { line: extra.line } : {}),
    ...(extra.column !== undefined ? { column: extra.column } : {}),
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// Format `content` via the BFF. Idempotent on already-formatted source per
// the Studio-IDE-14 AC; the caller is free to short-circuit when the
// returned `formattedContent` is byte-identical to the input.
export async function formatJava(
  payload: FormatJavaRequestPayload,
  options: FormatJavaClientOptions = {},
): Promise<FormatJavaResult> {
  const trigger = options.telemetryTrigger ?? "shortcut";
  // Studio-IDE-11 (#251): emit format.invoked with the file-line-count
  // bucket derived from the payload. The exact content never leaves
  // the function — only the bucket label.
  const lineCount = payload.content.split(/\r?\n/).length;
  emitTelemetry({
    eventType: "format.invoked",
    payload: {
      trigger,
      fileLineCountBucket: bucketFileLineCount(lineCount),
    },
  });
  const startedAt = Date.now();
  const emitResult = (
    outcome: "success" | "unavailable" | "timeout" | "noop",
  ) => {
    emitTelemetry({
      eventType: "format.result",
      payload: {
        outcome,
        latencyBucket: bucketFormatLatency(Date.now() - startedAt),
      },
    });
  };

  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    emitResult("unavailable");
    return buildFailure("format_unavailable", baseUrlResult.message);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    emitResult("unavailable");
    return buildFailure(
      "format_unavailable",
      "Formatter unavailable: fetch is not available in this environment",
    );
  }
  const controller = new AbortController();
  const externalSignal = options.signal;
  let externalAbortHandler: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", externalAbortHandler);
    }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeoutFired = false;
  const timeoutHandle = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  let rawBody: string;
  try {
    response = await fetchImpl(`${baseUrlResult.data}/api/v0/format/java`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    rawBody = await response.text();
  } catch (err) {
    if (timeoutFired) {
      emitResult("timeout");
      return buildFailure(
        "format_unavailable",
        `Formatter unavailable: request exceeded ${timeoutMs} ms`,
      );
    }
    if (isAbortError(err)) {
      emitResult("unavailable");
      return buildFailure("format_unavailable", "Formatter request cancelled");
    }
    emitResult("unavailable");
    return buildFailure(
      "format_unavailable",
      err instanceof Error
        ? `Formatter unavailable: ${err.message}`
        : "Formatter unavailable",
    );
  } finally {
    clearTimeout(timeoutHandle);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener("abort", externalAbortHandler);
    }
  }
  let parsed: unknown = null;
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      emitResult("unavailable");
      return buildFailure(
        "format_upstream_error",
        "Formatter returned malformed JSON",
        { status: response.status },
      );
    }
  }
  if (response.ok) {
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).formattedContent === "string"
    ) {
      const formattedContent =
        (parsed as Record<string, string>).formattedContent ?? "";
      emitResult(formattedContent === payload.content ? "noop" : "success");
      return {
        ok: true,
        formattedContent,
      };
    }
    emitResult("unavailable");
    return buildFailure(
      "format_upstream_error",
      "Formatter returned an unexpected payload",
      { status: response.status },
    );
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const codeRaw = record.code;
  const code: FormatJavaErrorCode =
    codeRaw === "format_unavailable" ||
    codeRaw === "format_parse_error" ||
    codeRaw === "format_input_too_large" ||
    codeRaw === "format_input_invalid" ||
    codeRaw === "format_upstream_error"
      ? codeRaw
      : "format_upstream_error";
  const messageRaw = typeof record.error === "string" ? record.error : "";
  const lineRaw =
    typeof record.line === "number" &&
    Number.isInteger(record.line) &&
    record.line > 0
      ? record.line
      : undefined;
  const columnRaw =
    typeof record.column === "number" &&
    Number.isInteger(record.column) &&
    record.column > 0
      ? record.column
      : undefined;
  emitResult("unavailable");
  return buildFailure(
    code,
    messageRaw.length > 0
      ? messageRaw
      : `Formatter failed (HTTP ${response.status})`,
    {
      status: response.status,
      ...(lineRaw !== undefined ? { line: lineRaw } : {}),
      ...(columnRaw !== undefined ? { column: columnRaw } : {}),
    },
  );
}
