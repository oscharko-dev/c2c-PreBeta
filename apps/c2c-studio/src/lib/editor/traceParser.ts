// Studio-IDE-6 (#248): fetch and parse the BFF traceability envelope for a
// run. The parser produces two ready-to-query Maps and a list of inline IR
// anchors mined out of the generated Java source. Lineage navigation and
// trust-pillar painting both feed off this surface.
//
// Caching: per runId, dedupes concurrent fetches via a `Map<runId,
// Promise<ParsedTrace>>`. Failures evict the cache entry so a retry can
// succeed. We do NOT persist to localStorage / IndexedDB — IDE-3 owns
// Studio persistence and this data is BFF-derived (always re-fetchable).
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

function buildParsedTrace(envelope: TraceabilityEnvelope): ParsedTrace {
  const irSymbolMap = new Map<string, IrSymbolAnchor>();
  for (const [key, value] of Object.entries(envelope.irSymbolMap)) {
    irSymbolMap.set(key, value);
  }
  const javaRegionClassification = new Map<
    string,
    readonly JavaRegionClassification[]
  >();
  // The wire field is nullable (BFF stub for diagnostic-fixture runs or the
  // orchestrator-upstream-error fallback per ADR-0006 §4). Treat ``null`` as
  // "no classification" → empty map, which the trust-pillar effect renders
  // as "no decorations / Lineage: 0%".
  if (envelope.javaRegionClassification) {
    for (const [key, regions] of Object.entries(
      envelope.javaRegionClassification,
    )) {
      javaRegionClassification.set(key, [...regions]);
    }
  }
  return {
    runId: envelope.runId,
    programId: envelope.programId,
    trace: envelope.trace,
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
  const pending = doFetch(runId, fetchImpl).catch((err) => {
    // Evict on failure so the next call can retry.
    traceCache.delete(runId);
    throw err;
  });
  traceCache.set(runId, pending);
  return pending;
}
