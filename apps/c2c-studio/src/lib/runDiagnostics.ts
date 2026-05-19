// Studio-IDE-5 (#244): Aggregate typed diagnostics from a transformation
// run state into the Problems panel feed. The Problems panel renders a
// sortable list — severity, file, line, message — and clicks route back
// through the marker navigation context.
//
// This selector is pure and side-effect-free; the Problems panel calls
// it on every render. The cost is O(n) over the diagnostic count plus
// one sort; with the 2000-marker cap from `diagnosticMarkers.ts` it is
// safe to call eagerly.

import type { Diagnostic } from "@/types/api";
import type { TransformationRunState } from "@/types/run";
import { DEFAULT_MARKER_LIMIT, sourceKindToOwner } from "@/lib/editor/diagnosticMarkers";

// "scope" describes the upstream step the diagnostic flowed from, used
// for the panel's secondary chip and for grouping when sorted by source.
export type DiagnosticScope = "generated" | "build-test";

export interface DiagnosticEntry {
  scope: DiagnosticScope;
  diagnostic: Diagnostic;
}

const SEVERITY_RANK: Record<Diagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
} as const;

export function severityRank(severity: Diagnostic["severity"]): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.info;
}

export type DiagnosticSortKey =
  | "severity"
  | "filePath"
  | "line"
  | "message"
  | "code"
  | "scope";

export interface DiagnosticSortOrder {
  key: DiagnosticSortKey;
  direction: "asc" | "desc";
}

export const DEFAULT_SORT: DiagnosticSortOrder = {
  key: "severity",
  direction: "asc",
};

// Collect diagnostics from every source on the run state. The order
// here defines the stable secondary order when the primary sort key
// produces ties.
export function collectDiagnostics(
  state: TransformationRunState,
): DiagnosticEntry[] {
  const out: DiagnosticEntry[] = [];
  for (const diagnostic of state.generated?.diagnostics ?? []) {
    out.push({ scope: "generated", diagnostic });
  }
  for (const diagnostic of state.buildTest?.diagnostics ?? []) {
    out.push({ scope: "build-test", diagnostic });
  }
  return out;
}

function compareStrings(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function compareNumbers(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

export function compareEntries(
  left: DiagnosticEntry,
  right: DiagnosticEntry,
  order: DiagnosticSortOrder,
): number {
  const direction = order.direction === "asc" ? 1 : -1;
  switch (order.key) {
    case "severity":
      return (
        (severityRank(left.diagnostic.severity) -
          severityRank(right.diagnostic.severity)) *
        direction
      );
    case "filePath":
      return (
        compareStrings(left.diagnostic.filePath, right.diagnostic.filePath) *
        direction
      );
    case "line":
      return (
        compareNumbers(left.diagnostic.line, right.diagnostic.line) * direction
      );
    case "message":
      return (
        compareStrings(left.diagnostic.message, right.diagnostic.message) *
        direction
      );
    case "code":
      return compareStrings(left.diagnostic.code, right.diagnostic.code) * direction;
    case "scope":
      return compareStrings(left.scope, right.scope) * direction;
  }
}

export function sortDiagnostics(
  entries: DiagnosticEntry[],
  order: DiagnosticSortOrder,
): DiagnosticEntry[] {
  // Decorate-sort-undecorate keeps the secondary order (insertion
  // order) stable for entries that tie on the primary key.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const primary = compareEntries(a.entry, b.entry, order);
      if (primary !== 0) return primary;
      return a.index - b.index;
    })
    .map((wrap) => wrap.entry);
}

export interface AggregateSummary {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  hintCount: number;
  total: number;
}

export function summarize(entries: DiagnosticEntry[]): AggregateSummary {
  const summary: AggregateSummary = {
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    hintCount: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    switch (entry.diagnostic.severity) {
      case "error":
        summary.errorCount += 1;
        break;
      case "warning":
        summary.warningCount += 1;
        break;
      case "info":
        summary.infoCount += 1;
        break;
      case "hint":
        summary.hintCount += 1;
        break;
    }
  }
  return summary;
}

type MarkerSurface = "cobol" | "generated-java";

function markerSurfaceFor(diagnostic: Diagnostic): MarkerSurface | null {
  switch (sourceKindToOwner(diagnostic.sourceKind)) {
    case "c2c-cobol":
    case "c2c-ir":
      return "cobol";
    case "c2c-generated-java":
    case "c2c-build":
    case "c2c-test":
      return "generated-java";
    default:
      return null;
  }
}

function normalizedFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

function pathSegments(filePath: string): string[] {
  return normalizedFilePath(filePath).split("/").filter(Boolean);
}

function pathSegmentsMatch(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const short = left.length < right.length ? left : right;
  const long = left.length < right.length ? right : left;
  for (let i = 0; i < short.length; i += 1) {
    if (short[short.length - 1 - i] !== long[long.length - 1 - i]) {
      return false;
    }
  }
  return true;
}

interface MarkerOverflowBucket {
  surface: MarkerSurface;
  filePathParts: string[];
  count: number;
}

// Count diagnostics that will be dropped from editor marker surfaces while
// still appearing in the Problems panel. The cap is shared by all marker
// owners attached to the same editor surface and file, matching the COBOL
// and generated-Java pane marker application order.
export function countEditorMarkerOverflow(
  entries: DiagnosticEntry[],
  limit = DEFAULT_MARKER_LIMIT,
): number {
  const buckets: MarkerOverflowBucket[] = [];

  for (const { diagnostic } of entries) {
    if (diagnostic.line === undefined || diagnostic.filePath === undefined) {
      continue;
    }
    const surface = markerSurfaceFor(diagnostic);
    if (surface === null) {
      continue;
    }
    const filePathParts = pathSegments(diagnostic.filePath);
    if (filePathParts.length === 0) {
      continue;
    }
    const bucket = buckets.find(
      (candidate) =>
        candidate.surface === surface &&
        pathSegmentsMatch(candidate.filePathParts, filePathParts),
    );
    if (bucket) {
      bucket.count += 1;
    } else {
      buckets.push({ surface, filePathParts, count: 1 });
    }
  }

  let overflow = 0;
  for (const bucket of buckets) {
    overflow += Math.max(0, bucket.count - limit);
  }
  return overflow;
}
