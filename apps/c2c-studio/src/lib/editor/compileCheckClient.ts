// Studio-IDE-14 (#256): the Compile Check action invokes
// `POST /api/v0/compile-check` (owned by Studio-IDE-13) and the BFF
// returns Diagnostic[]-shaped build diagnostics. This module is the
// thin client; the editor pane renders the diagnostics under the
// `c2c-java-build` marker owner.
//
// The endpoint may not be deployed yet — Studio-IDE-13 wires it. When
// the BFF reports 404 / 5xx we surface a `compile_check_unavailable`
// failure so the editor renders a non-blocking toast and leaves the
// buffer intact.

import { resolveApiBaseUrl } from "@/lib/apiClient";
import type { Diagnostic } from "@/types/api";

export type CompileCheckErrorCode =
  | "compile_check_unavailable"
  | "compile_check_upstream_error";

export interface CompileCheckSuccess {
  ok: true;
  diagnostics: Diagnostic[];
}

export interface CompileCheckFailure {
  ok: false;
  code: CompileCheckErrorCode;
  message: string;
  status?: number;
}

export type CompileCheckResult = CompileCheckSuccess | CompileCheckFailure;

export interface CompileCheckRequestPayload {
  content: string;
  filePath?: string;
  runId?: string;
}

export interface CompileCheckClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// 6 s — covers the 5 s Compile Check AC plus the BFF roundtrip headroom.
const DEFAULT_TIMEOUT_MS = 6_000;

const KNOWN_SEVERITIES = new Set<Diagnostic["severity"]>([
  "error",
  "warning",
  "info",
  "hint",
]);

const KNOWN_SOURCE_KINDS = new Set<NonNullable<Diagnostic["sourceKind"]>>([
  "cobol",
  "ir",
  "generated_java",
  "build",
  "test",
]);

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// Defensive parse: any non-conforming entry is dropped silently rather
// than blocking the whole render. The BFF/c2c-bff normaliser already
// emits the canonical Diagnostic shape; this is a belt-and-braces guard.
function parseDiagnostic(value: unknown): Diagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const severity = record.severity;
  if (
    typeof severity !== "string" ||
    !KNOWN_SEVERITIES.has(severity as Diagnostic["severity"])
  ) {
    return null;
  }
  const message = record.message;
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  const codeRaw = record.code;
  const out: Diagnostic = {
    severity: severity as Diagnostic["severity"],
    code: typeof codeRaw === "string" ? codeRaw : "",
    message,
  };
  if (record.schemaVersion === "v0") out.schemaVersion = "v0";
  if (
    typeof record.line === "number" &&
    Number.isInteger(record.line) &&
    record.line > 0
  ) {
    out.line = record.line;
  }
  if (
    typeof record.column === "number" &&
    Number.isInteger(record.column) &&
    record.column > 0
  ) {
    out.column = record.column;
  }
  if (
    typeof record.endLine === "number" &&
    Number.isInteger(record.endLine) &&
    record.endLine > 0
  ) {
    out.endLine = record.endLine;
  }
  if (
    typeof record.endColumn === "number" &&
    Number.isInteger(record.endColumn) &&
    record.endColumn > 0
  ) {
    out.endColumn = record.endColumn;
  }
  if (typeof record.filePath === "string" && record.filePath.length > 0) {
    out.filePath = record.filePath;
  }
  if (
    typeof record.sourceKind === "string" &&
    KNOWN_SOURCE_KINDS.has(
      record.sourceKind as NonNullable<Diagnostic["sourceKind"]>,
    )
  ) {
    out.sourceKind = record.sourceKind as Diagnostic["sourceKind"];
  } else {
    // Compile Check responses default to `build` — that's the marker
    // owner the editor renders under.
    out.sourceKind = "build";
  }
  if (typeof record.originStep === "string" && record.originStep.length > 0) {
    out.originStep = record.originStep;
  }
  return out;
}

function parseDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: Diagnostic[] = [];
  for (const entry of value) {
    const parsed = parseDiagnostic(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function buildFailure(
  code: CompileCheckErrorCode,
  message: string,
  status?: number,
): CompileCheckFailure {
  return status !== undefined
    ? { ok: false, code, message, status }
    : { ok: false, code, message };
}

export async function compileCheck(
  payload: CompileCheckRequestPayload,
  options: CompileCheckClientOptions = {},
): Promise<CompileCheckResult> {
  const baseUrlResult = resolveApiBaseUrl();
  if (!baseUrlResult.ok) {
    return buildFailure("compile_check_unavailable", baseUrlResult.message);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return buildFailure(
      "compile_check_unavailable",
      "Compile Check unavailable: fetch is not available in this environment",
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
  try {
    response = await fetchImpl(`${baseUrlResult.data}/api/v0/compile-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (timeoutFired) {
      return buildFailure(
        "compile_check_unavailable",
        `Compile Check unavailable: request exceeded ${timeoutMs} ms`,
      );
    }
    if (isAbortError(err)) {
      return buildFailure(
        "compile_check_unavailable",
        "Compile Check request cancelled",
      );
    }
    return buildFailure(
      "compile_check_unavailable",
      err instanceof Error
        ? `Compile Check unavailable: ${err.message}`
        : "Compile Check unavailable",
    );
  } finally {
    clearTimeout(timeoutHandle);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener("abort", externalAbortHandler);
    }
  }
  const rawBody = await response.text();
  let parsed: unknown = null;
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return buildFailure(
        "compile_check_upstream_error",
        "Compile Check returned malformed JSON",
        response.status,
      );
    }
  }
  if (!response.ok) {
    // 404 = endpoint not yet wired (Studio-IDE-13 outstanding). Treat
    // every non-2xx as "unavailable" so the editor surfaces the same
    // non-blocking toast.
    const errorField =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).error
        : undefined;
    const message =
      typeof errorField === "string" && errorField.length > 0
        ? errorField
        : `Compile Check unavailable (HTTP ${response.status})`;
    return buildFailure("compile_check_unavailable", message, response.status);
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: true, diagnostics: [] };
  }
  const record = parsed as Record<string, unknown>;
  // Accept either `{ diagnostics: [...] }` (the natural shape) or a bare
  // array. Studio-IDE-13 has not landed yet so we hedge.
  const diagnosticsRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.diagnostics)
      ? record.diagnostics
      : [];
  return { ok: true, diagnostics: parseDiagnostics(diagnosticsRaw) };
}
