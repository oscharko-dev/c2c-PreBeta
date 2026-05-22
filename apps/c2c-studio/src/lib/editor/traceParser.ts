// Studio-IDE-6 (#248): fetch and parse the BFF traceability envelope for a
// run. The parser produces two ready-to-query Maps and a list of inline IR
// anchors mined out of the generated Java source. Lineage navigation and
// trust-pillar painting both feed off this surface.
//
// Caching: per runId, dedupes concurrent fetches via a `Map<runId,
// Promise<ParsedTrace>>`. Failures and incomplete successful envelopes evict
// the cache entry so a retry can succeed after the run advances. We do NOT
// persist to localStorage / IndexedDB — IDE-3 owns Studio persistence and
// this data is BFF-derived (always re-fetchable).
//
// 404 handling: returns a typed `TraceabilityNotFoundError` so the caller
// can render "Lineage unavailable" rather than crashing the editor.

import { resolveApiBaseUrl } from "@/lib/apiClient";
import type {
  IrSymbolAnchor,
  JavaRegionClassification,
  TraceabilityEnvelope,
} from "@/types/api";

export class TraceabilityNotFoundError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`Traceability not found for runId=${runId}`);
    this.name = "TraceabilityNotFoundError";
    this.runId = runId;
  }
}

export interface ParsedTrace {
  runId: string;
  programId: string;
  trace: Record<string, unknown> | null;
  irSymbolMap: ReadonlyMap<string, IrSymbolAnchor>;
  javaRegionClassification: ReadonlyMap<
    string,
    readonly JavaRegionClassification[]
  >;
}

export interface InlineIrAnchor {
  /** 1-based line in the generated Java file. */
  javaLine: number;
  /** IR statement / field id. */
  irNodeId: string;
  /** 1-based COBOL source line. */
  cobolLine: number;
}

// Inline-comment regex per the slice contract. Matches both:
//   `// move [s-move-x line 15]`
//   `// paragraph PARA-A [s-paragraph-y line 22]`
// The optional `(?:\s+\S+)?` token between the operator and the bracket is
// what permits the `paragraph <label>` shape without overfitting it.
const INLINE_IR_REGEX =
  /^\s*\/\/\s+\w+(?:\s+\S+)?\s+\[([a-z][a-z0-9-]*)\s+line\s+(\d+)\]/;

const traceCache = new Map<string, Promise<ParsedTrace>>();

const JAVA_ORIGIN_CLASSES = new Set<string>([
  "deterministic",
  "agent_proposed",
  "repair_attempted",
  "manual_modified",
  "manual_edit",
]);

const JAVA_VERIFICATION_OUTCOMES = new Set<string>([
  "oracle_passed",
  "oracle_failed",
  "no_oracle",
]);

const JAVA_MAPPING_CLASSES = new Set<string>([
  "direct",
  "aggregated",
  "synthesized",
  "agent_originated",
]);

export function clearTraceCache(): void {
  traceCache.clear();
}

export function clearTraceCacheFor(runId: string): void {
  traceCache.delete(runId);
}

export function parseInlineIrAnchors(javaSource: string): InlineIrAnchor[] {
  if (javaSource.length === 0) {
    return [];
  }
  const anchors: InlineIrAnchor[] = [];
  const lines = javaSource.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = INLINE_IR_REGEX.exec(lines[i]);
    if (!match) continue;
    const irNodeId = match[1];
    const cobolLine = Number.parseInt(match[2], 10);
    if (!Number.isFinite(cobolLine)) continue;
    anchors.push({ javaLine: i + 1, irNodeId, cobolLine });
  }
  return anchors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isJavaRegionClassification(
  value: unknown,
): value is JavaRegionClassification {
  if (!isRecord(value)) return false;
  const lineRange = value.lineRange;
  return (
    typeof value.schemaVersion === "string" &&
    isRecord(lineRange) &&
    isPositiveInteger(lineRange.startLine) &&
    isPositiveInteger(lineRange.endLine) &&
    lineRange.endLine >= lineRange.startLine &&
    typeof value.originClass === "string" &&
    JAVA_ORIGIN_CLASSES.has(value.originClass) &&
    typeof value.verificationOutcome === "string" &&
    JAVA_VERIFICATION_OUTCOMES.has(value.verificationOutcome) &&
    typeof value.mappingClass === "string" &&
    JAVA_MAPPING_CLASSES.has(value.mappingClass)
  );
}

function buildParsedTrace(envelope: TraceabilityEnvelope): ParsedTrace {
  const irSymbolMap = new Map<string, IrSymbolAnchor>();
  const irSymbolMapRaw = isRecord(envelope.irSymbolMap)
    ? envelope.irSymbolMap
    : {};
  for (const [key, value] of Object.entries(irSymbolMapRaw)) {
    if (isRecord(value)) {
      const cobolFile = value.cobolFile;
      const cobolLine = value.cobolLine;
      if (typeof cobolFile === "string" && isPositiveInteger(cobolLine)) {
        irSymbolMap.set(key, { cobolFile, cobolLine });
      }
    }
  }
  const javaRegionClassification = new Map<
    string,
    readonly JavaRegionClassification[]
  >();
  // The wire field is nullable (BFF stub for diagnostic-fixture runs or the
  // orchestrator-upstream-error fallback per ADR-0006 §4). Treat ``null`` as
  // "no classification" → empty map, which the trust-pillar effect renders
  // as "no decorations / Lineage: 0%".
  if (isRecord(envelope.javaRegionClassification)) {
    for (const [key, regions] of Object.entries(
      envelope.javaRegionClassification,
    )) {
      const validRegions = Array.isArray(regions)
        ? regions.filter(isJavaRegionClassification)
        : [];
      if (validRegions.length > 0) {
        javaRegionClassification.set(key, validRegions);
      }
    }
  }
  return {
    runId: envelope.runId,
    programId: typeof envelope.programId === "string" ? envelope.programId : "",
    trace: isRecord(envelope.trace) ? envelope.trace : null,
    irSymbolMap,
    javaRegionClassification,
  };
}

async function doFetch(
  runId: string,
  fetcher: typeof fetch,
): Promise<ParsedTrace> {
  const baseUrlResult = resolveApiBaseUrl();
  const base = baseUrlResult.ok ? baseUrlResult.data : "";
  const url = `${base}/api/v0/runs/${encodeURIComponent(runId)}/traceability`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    throw new TraceabilityNotFoundError(runId);
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch traceability for runId=${runId}: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as TraceabilityEnvelope;
  return buildParsedTrace(body);
}

function hasRecordKeys(
  value: Record<string, unknown> | null | undefined,
): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

function isCompleteTraceability(trace: ParsedTrace): boolean {
  return (
    hasRecordKeys(trace.trace) ||
    trace.irSymbolMap.size > 0 ||
    trace.javaRegionClassification.size > 0
  );
}

export async function fetchTraceability(
  runId: string,
  fetcher?: typeof fetch,
): Promise<ParsedTrace> {
  const cached = traceCache.get(runId);
  if (cached) {
    return cached;
  }
  const fetchImpl = fetcher ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "fetchTraceability: fetch is not available in this environment",
    );
  }
  const pending = doFetch(runId, fetchImpl).then(
    (parsed) => {
      if (!isCompleteTraceability(parsed)) {
        traceCache.delete(runId);
      }
      return parsed;
    },
    (err) => {
      // Evict on failure so the next call can retry.
      traceCache.delete(runId);
      throw err;
    },
  );
  traceCache.set(runId, pending);
  return pending;
}
