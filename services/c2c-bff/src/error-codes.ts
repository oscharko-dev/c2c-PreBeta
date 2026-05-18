// Issue #172: W0.2 BFF error contract.
//
// The browser never sees orchestrator stack traces, provider keys, or raw
// service URLs. Upstream failures and orchestrator failure codes are mapped
// to a closed, documented set of user-safe codes that the Studio can render
// and the BFF can audit. Anything we don't recognise falls back to
// ``internal_error`` (a deliberate generalisation), and connectivity issues
// fall back to ``service_unavailable``.

export type W02UiErrorCode =
  | "unsupported_cobol"
  | "parse_failed"
  | "semantic_ir_failed"
  | "model_gateway_unavailable"
  | "model_policy_denied"
  | "agent_timeout"
  | "agent_contract_invalid"
  | "java_generation_failed"
  | "java_compile_failed"
  | "java_runtime_failed"
  | "oracle_mismatch"
  | "evidence_incomplete"
  | "cancelled"
  // Studio-IDE-13 (#255): sentinel applied when a /api/v0/generate run
  // finishes its generator pipeline by request. The classification is
  // ``incomplete`` because verification was not requested, not because
  // anything failed — UI consumers render this as "Java artifacts ready"
  // rather than an error.
  | "generate_only_complete"
  | "service_unavailable"
  | "internal_error";

export const W02_UI_ERROR_CODES: readonly W02UiErrorCode[] = [
  "unsupported_cobol",
  "parse_failed",
  "semantic_ir_failed",
  "model_gateway_unavailable",
  "model_policy_denied",
  "agent_timeout",
  "agent_contract_invalid",
  "java_generation_failed",
  "java_compile_failed",
  "java_runtime_failed",
  "oracle_mismatch",
  "evidence_incomplete",
  "cancelled",
  "generate_only_complete",
  "service_unavailable",
  "internal_error",
];

const UI_ERROR_CODE_SET: ReadonlySet<W02UiErrorCode> = new Set(
  W02_UI_ERROR_CODES,
);

// Orchestrator-side ``failureCode`` strings. Anything outside this map is
// classified as ``internal_error`` so the UI never sees an unknown code.
const ORCHESTRATOR_TO_UI: Record<string, W02UiErrorCode> = {
  unsupported_cobol: "unsupported_cobol",
  parse_failed: "parse_failed",
  semantic_ir_failed: "semantic_ir_failed",
  model_gateway_unavailable: "model_gateway_unavailable",
  model_policy_denied: "model_policy_denied",
  agent_timeout: "agent_timeout",
  agent_contract_invalid: "agent_contract_invalid",
  java_generation_failed: "java_generation_failed",
  java_compile_failed: "java_compile_failed",
  java_runtime_failed: "java_runtime_failed",
  oracle_mismatch: "oracle_mismatch",
  evidence_incomplete: "evidence_incomplete",
  cancelled: "cancelled",
  generate_only_complete: "generate_only_complete",
};

export function mapOrchestratorFailureCode(
  raw: unknown,
): W02UiErrorCode | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const mapped = ORCHESTRATOR_TO_UI[trimmed];
  if (mapped) return mapped;
  if (UI_ERROR_CODE_SET.has(trimmed as W02UiErrorCode)) {
    return trimmed as W02UiErrorCode;
  }
  return "internal_error";
}

// Default text shown to the user when the orchestrator only returns the
// canonical code (no upstream message). Kept terse so the UI can render it
// inline without truncation; the underlying reason is auditable on the BFF
// side via /api/v0/runs/{runId}/workflow.
const DEFAULT_MESSAGES: Record<W02UiErrorCode, string> = {
  unsupported_cobol:
    "COBOL source uses constructs outside the supported W0.2 subset.",
  parse_failed: "COBOL source could not be parsed.",
  semantic_ir_failed: "Semantic IR generation failed for this program.",
  model_gateway_unavailable:
    "The Model Gateway is unavailable. Try again shortly.",
  model_policy_denied: "The Model Gateway policy denied this request.",
  agent_timeout: "An agent step exceeded its bounded budget.",
  agent_contract_invalid: "An agent returned a contract-invalid response.",
  java_generation_failed: "Java generation failed for this run.",
  java_compile_failed: "Generated Java did not compile.",
  java_runtime_failed: "Generated Java failed at runtime.",
  oracle_mismatch: "Generated Java output did not match the expected oracle.",
  evidence_incomplete: "Evidence pack is incomplete; the run is not certified.",
  cancelled: "The run was cancelled before completion.",
  generate_only_complete:
    "Java artifacts ready. Verification was not requested for this generator-only run.",
  service_unavailable: "A required service is temporarily unavailable.",
  internal_error: "The run failed with an internal error.",
};

export function defaultMessageFor(code: W02UiErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

// Patterns we strip from any string that may leak from upstream into a
// user-facing response. Provider keys, internal service URLs, common stack
// trace markers, file system paths, and bearer tokens.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic / Foundry / OpenAI-style API keys
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /api[-_]?key[=:]\s*[^\s"']+/gi,
  // Generic JWT-shaped tokens
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  // URLs (http/https) — orchestrator/evidence/model-gateway base URLs and
  // anything else that would leak topology
  /https?:\/\/[^\s"']+/gi,
  // Absolute filesystem paths
  /\/(?:Users|home|var|opt|srv|tmp|etc)\/[^\s"':]+/g,
];

const STACK_TRACE_MARKERS =
  /(at\s+[A-Za-z0-9_.$]+\s*\([^)]*\)|^\s*File\s+".+",\s+line\s+\d+|Traceback\s+\(most\s+recent\s+call\s+last\):)/m;

export function sanitizeUpstreamMessage(
  raw: unknown,
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback;
  let value = raw;
  // Cut off stack traces entirely; the BFF caller never wants them.
  const stackMatch = STACK_TRACE_MARKERS.exec(value);
  if (stackMatch) {
    value = value.slice(0, stackMatch.index).trim();
  }
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "[redacted]");
  }
  // Collapse whitespace runs and trim length so the UI can render in line.
  value = value.replace(/\s+/g, " ").trim();
  if (value.length === 0) return fallback;
  if (value.length > 280) value = `${value.slice(0, 277)}...`;
  return value;
}

export interface MappedFailure {
  code: W02UiErrorCode;
  message: string;
}

export function mapFailure(
  rawFailureCode: unknown,
  rawFailureMessage: unknown,
  fallback?: { code?: W02UiErrorCode; message?: string },
): MappedFailure | null {
  const mappedCode = mapOrchestratorFailureCode(rawFailureCode);
  if (mappedCode === null && fallback?.code === undefined) {
    return null;
  }
  const code = mappedCode ?? fallback?.code ?? "internal_error";
  const fallbackMessage = fallback?.message ?? defaultMessageFor(code);
  const message = sanitizeUpstreamMessage(rawFailureMessage, fallbackMessage);
  return { code, message };
}

export function mapUpstreamUnavailable(detail?: string): MappedFailure {
  return {
    code: "service_unavailable",
    message: sanitizeUpstreamMessage(
      detail,
      defaultMessageFor("service_unavailable"),
    ),
  };
}
