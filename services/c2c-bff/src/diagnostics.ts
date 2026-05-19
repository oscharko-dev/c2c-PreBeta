// Typed diagnostic normalization for the BFF.
//
// Studio-IDE-5 (#244): the BFF must preserve every positional field
// upstream services produce — line, column, endLine, endColumn, filePath,
// sourceKind, originStep, artifactRef — and emit a typed Diagnostic
// shape that the Studio Problems panel and Monaco markers can consume.
//
// The shape mirrors `services/c2c-bff/openapi.yaml#Diagnostic` and is
// governed by ADR 0006 (Studio-BFF Contract Versioning). The optional
// `schemaVersion` field is always emitted as "v0" until a breaking
// change is required, per ADR 0006 Decision 1.

import { sanitizeUpstreamMessage } from "./error-codes";

export const DIAGNOSTIC_SCHEMA_VERSION = "v0" as const;

// Studio-IDE-5 (#244 review): javac emits absolute filenames via
// `JavaFileObject.getName()` (e.g. "/var/lib/orchestrator/run-X/
// src/main/java/c2c/Foo.java"). The Studio expects relative paths
// inside the generated project (e.g. "src/main/java/c2c/Foo.java")
// so its file-segment matching does not pick the wrong file and the
// content endpoint can resolve. We strip everything before the
// canonical `src/main/java` (or `src/main/resources`) segment when
// the input is absolute. If no project-relative anchor can be recovered from
// an absolute path or URL, omit filePath rather than collapsing to a basename:
// duplicate generated class names would make basename-only navigation
// ambiguous.
function anchoredProjectPath(forward: string): string | undefined {
  const match = forward.match(
    /(?:^|\/)(src\/(?:main|test)\/(?:java|resources)\/.*)$/,
  );
  return match?.[1];
}

function isSafeRelativePath(forward: string): boolean {
  if (forward.length === 0 || forward.includes("\0")) return false;
  if (forward.startsWith("/") || /^[A-Za-z]:\//.test(forward)) return false;
  for (const segment of forward.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function normalizeFilePath(raw: string): string | undefined {
  const trimmed = raw.trim().split(/[?#]/, 1)[0] ?? "";
  if (trimmed.length === 0) return undefined;
  const forward = trimmed.replace(/\\/g, "/");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(forward)) {
    try {
      const parsed = new URL(forward);
      return anchoredProjectPath(parsed.pathname);
    } catch {
      return undefined;
    }
  }
  // Only re-anchor when the path looks absolute (POSIX or Windows).
  const isAbsolute = forward.startsWith("/") || /^[A-Za-z]:\//.test(forward);
  if (!isAbsolute) {
    return isSafeRelativePath(forward) ? forward : undefined;
  }
  // Anchor at the first `src/main/<x>` segment if present; this
  // covers the standard Maven/Gradle layout the generator emits.
  return anchoredProjectPath(forward);
}


export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type DiagnosticSourceKind =
  | "cobol"
  | "ir"
  | "generated_java"
  | "build"
  | "test";

const KNOWN_SEVERITIES: ReadonlySet<DiagnosticSeverity> = new Set([
  "error",
  "warning",
  "info",
  "hint",
]);

const KNOWN_SOURCE_KINDS: ReadonlySet<DiagnosticSourceKind> = new Set([
  "cobol",
  "ir",
  "generated_java",
  "build",
  "test",
]);

// Upstream services use slightly different severity vocabularies. We map
// common synonyms to the closed enum so downstream consumers can rely on
// a single set of labels. Unknown synonyms fall through to "info" per
// ADR 0006 Decision 3.
const SEVERITY_SYNONYMS: Record<string, DiagnosticSeverity> = {
  error: "error",
  err: "error",
  fatal: "error",
  severe: "error",
  warning: "warning",
  warn: "warning",
  mandatory_warning: "warning",
  "mandatory-warning": "warning",
  info: "info",
  information: "info",
  notice: "info",
  hint: "hint",
  note: "hint",
  suggestion: "hint",
};

function normalizeSeverity(raw: unknown): DiagnosticSeverity {
  if (typeof raw !== "string") return "info";
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return "info";
  if (KNOWN_SEVERITIES.has(lowered as DiagnosticSeverity)) {
    return lowered as DiagnosticSeverity;
  }
  return SEVERITY_SYNONYMS[lowered] ?? "info";
}

function normalizeSourceKind(raw: unknown): DiagnosticSourceKind | undefined {
  if (typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return undefined;
  if (KNOWN_SOURCE_KINDS.has(lowered as DiagnosticSourceKind)) {
    return lowered as DiagnosticSourceKind;
  }
  // Tolerate hyphenated and underscored variants (e.g. "generated-java").
  const collapsed = lowered.replace(/[-\s]+/g, "_");
  if (KNOWN_SOURCE_KINDS.has(collapsed as DiagnosticSourceKind)) {
    return collapsed as DiagnosticSourceKind;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

// Studio-IDE-5 (#244 review): the JSON Schema for `byteSize` allows
// 0 (empty artifact). Marker positions still require strict-positive,
// but byteSize is a content-length field. A separate helper keeps the
// two validation rules independent.
function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

// OutputRef shape matches `services/c2c-bff/src/server.ts` internal one;
// kept local to avoid a circular import and because the diagnostics
// module deliberately owns its own normalization surface.
export interface DiagnosticOutputRef {
  sha256: string;
  byteSize?: number;
  kind?: string;
  path?: string;
  name?: string;
  mimeType?: string;
  createdBy?: string;
  createdAt?: string;
}

function normalizeArtifactRef(raw: unknown): DiagnosticOutputRef | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return undefined;
  const ref: DiagnosticOutputRef = { sha256 };
  const byteSize = asNonNegativeInteger(record.byteSize);
  if (byteSize !== undefined) ref.byteSize = byteSize;
  for (const key of [
    "kind",
    "path",
    "name",
    "mimeType",
    "createdBy",
    "createdAt",
  ] as const) {
    const value = asString(record[key]);
    if (value.length > 0) ref[key] = value;
  }
  return ref;
}

export interface Diagnostic {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  filePath?: string;
  sourceKind?: DiagnosticSourceKind;
  originStep?: string;
  artifactRef?: DiagnosticOutputRef;
}

// Validate that the (endLine, endColumn) range is non-decreasing relative
// to (line, column). When the upstream payload contradicts itself we drop
// the offending end-coordinate rather than synthesize one; the Studio
// fallback (per ADR 0006 Decision 4) renders a point marker at the start.
function reconcileRange(diagnostic: Diagnostic): void {
  if (diagnostic.endLine !== undefined && diagnostic.line !== undefined) {
    if (diagnostic.endLine < diagnostic.line) {
      delete diagnostic.endLine;
      delete diagnostic.endColumn;
      return;
    }
  }
  if (
    diagnostic.endLine === diagnostic.line &&
    diagnostic.endColumn !== undefined &&
    diagnostic.column !== undefined &&
    diagnostic.endColumn < diagnostic.column
  ) {
    delete diagnostic.endColumn;
  }
  // If only endColumn is provided without endLine, treat as same-line.
  if (
    diagnostic.endLine === undefined &&
    diagnostic.endColumn !== undefined &&
    diagnostic.line === undefined
  ) {
    delete diagnostic.endColumn;
  }
}

function normalizeOne(raw: unknown): Diagnostic | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const message = asString(record.message);
  // Without a message the entry conveys nothing the Studio can render,
  // so drop it rather than emit a "" marker.
  if (message.length === 0) return undefined;
  const safeMessage = sanitizeUpstreamMessage(
    message,
    "Diagnostic unavailable",
  );

  // Upstream services historically use either `severity` or `level`.
  const severityRaw =
    asString(record.severity).length > 0 ? record.severity : record.level;
  const severity = normalizeSeverity(severityRaw);

  const diagnostic: Diagnostic = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    severity,
    code: asString(record.code),
    message: safeMessage,
  };

  for (const key of ["line", "column", "endLine", "endColumn"] as const) {
    const value = asPositiveInteger(record[key]);
    if (value !== undefined) diagnostic[key] = value;
  }

  // `source` is the legacy path field used by the Java build-test runner.
  const rawFilePath =
    asString(record.filePath).length > 0
      ? asString(record.filePath)
      : asString(record.source);
  if (rawFilePath.length > 0) {
    const normalizedPath = normalizeFilePath(rawFilePath);
    if (normalizedPath !== undefined) diagnostic.filePath = normalizedPath;
  }

  const sourceKind = normalizeSourceKind(record.sourceKind);
  if (sourceKind !== undefined) diagnostic.sourceKind = sourceKind;

  const originStep = asString(record.originStep);
  if (originStep.length > 0) diagnostic.originStep = originStep;

  const artifactRef = normalizeArtifactRef(record.artifactRef);
  if (artifactRef !== undefined) diagnostic.artifactRef = artifactRef;

  reconcileRange(diagnostic);

  return diagnostic;
}

export interface NormalizeDiagnosticsOptions {
  // Studio-IDE-5 (#244): Diagnostics emitted by build-test and
  // generator endpoints historically arrive without `sourceKind`. The
  // BFF endpoint knows the context (`build` vs `generated_java`), so
  // callers can pass that here to backfill any untagged record. This
  // is a default — explicit upstream `sourceKind` always wins.
  defaultSourceKind?: DiagnosticSourceKind;
}

// Public entry point. Returns an array of typed Diagnostic records,
// preserving every field the upstream payload contained that survives
// the type guard. The function is total (no exceptions) so it is safe
// to call inline within server handlers.
export function normalizeDiagnostics(
  raw: unknown,
  options: NormalizeDiagnosticsOptions = {},
): Diagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: Diagnostic[] = [];
  for (const entry of raw) {
    const normalized = normalizeOne(entry);
    if (!normalized) continue;
    if (normalized.sourceKind === undefined && options.defaultSourceKind) {
      // Studio-IDE-5 (#244 review): apply the endpoint default only
      // when the diagnostic actually attaches to a file. A fileless
      // generator diagnostic typically references COBOL `sourceLine`;
      // labelling it `generated_java` would mis-route it onto the
      // Java pane and highlight an unrelated line.
      if (normalized.filePath !== undefined) {
        normalized.sourceKind = options.defaultSourceKind;
      }
    }
    out.push(normalized);
  }
  return out;
}
