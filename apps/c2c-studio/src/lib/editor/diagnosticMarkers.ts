"use client";

// Studio-IDE-5 (#244): Map BFF-shaped Diagnostic records onto Monaco
// IMarkerData. The rules below are the contract the Studio enforces and
// are exercised by `diagnosticMarkers.test.ts`. Behaviour intentionally
// follows ADR 0006 Decision 4 (null-field fallbacks):
//
//   * `line` absent          → no in-editor marker; entry still flows
//                               into the Problems panel.
//   * `filePath` absent      → no in-editor marker either; entry is
//                               "run-level" per ADR 0006 Decision 4
//                               and stays in the Problems panel only.
//   * `column` absent        → marker spans the whole `line`.
//   * `endLine`/`endColumn`  → defaults to point marker at start.
//   * Unknown severity       → render at MarkerSeverity.Info per ADR
//                               0006 Decision 3.
//
// The function is intentionally pure — no Monaco DOM operations live
// here. The caller is responsible for `monaco.editor.setModelMarkers`.

import type * as MonacoNs from "monaco-editor";

import type { Diagnostic } from "@/types/api";

export type Monaco = typeof MonacoNs;

// Defaults sized so a single program's worth of diagnostics never
// silently degrades. The cap is configurable through the second
// argument to `diagnosticsToMarkers` because acceptance criteria
// require a deterministic "first 2000 only" rendering policy.
export const DEFAULT_MARKER_LIMIT = 2000;

export type DiagnosticOwner =
  | "c2c-cobol"
  | "c2c-ir"
  | "c2c-generated-java"
  | "c2c-build"
  | "c2c-test"
  | "c2c-unknown";

// Map the typed `sourceKind` onto the per-owner namespace Monaco uses
// to scope its marker collections so multiple owners do not clobber
// each other (acceptance criterion: clearing parser markers must leave
// build markers in place).
export function sourceKindToOwner(
  sourceKind: Diagnostic["sourceKind"],
): DiagnosticOwner {
  switch (sourceKind) {
    case "cobol":
      return "c2c-cobol";
    case "ir":
      return "c2c-ir";
    case "generated_java":
      return "c2c-generated-java";
    case "build":
      return "c2c-build";
    case "test":
      return "c2c-test";
    default:
      return "c2c-unknown";
  }
}

export interface DiagnosticsToMarkersOptions {
  monaco: Monaco;
  // The Monaco text model the marker will attach to; used only to
  // resolve the column fallback ("whole line") to an actual line
  // length. Callers pass `null` when no editor is mounted yet, in
  // which case the fallback degrades to `endColumn === column + 1`
  // (a single character marker).
  model: MonacoNs.editor.ITextModel | null;
  // Maximum number of markers to emit; the remainder is dropped from
  // the editor surface but is still discoverable in the Problems panel
  // (where this limit does not apply).
  limit?: number;
}

export interface MarkerConversionResult {
  markers: MonacoNs.editor.IMarkerData[];
  // Number of diagnostics that were dropped because they did not carry
  // a line; the Problems panel still renders them under the file-level
  // fallback bucket.
  fileLevelCount: number;
  // Number of diagnostics in excess of `limit` that were truncated.
  truncatedCount: number;
}

function severityToMonaco(
  monaco: Monaco,
  severity: Diagnostic["severity"],
): MonacoNs.MarkerSeverity {
  switch (severity) {
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warning":
      return monaco.MarkerSeverity.Warning;
    case "hint":
      return monaco.MarkerSeverity.Hint;
    case "info":
      return monaco.MarkerSeverity.Info;
    default:
      // Unknown severity falls back to Info per ADR 0006 Decision 3.
      return monaco.MarkerSeverity.Info;
  }
}

function clampToModel(
  model: MonacoNs.editor.ITextModel | null,
  line: number,
): { line: number; lineLength: number | null } {
  if (!model) return { line, lineLength: null };
  const totalLines = model.getLineCount();
  const safeLine = Math.min(Math.max(line, 1), totalLines);
  const lineLength = model.getLineLength(safeLine);
  return { line: safeLine, lineLength };
}

function diagnosticToMarker(
  diagnostic: Diagnostic,
  options: DiagnosticsToMarkersOptions,
): MonacoNs.editor.IMarkerData | null {
  // ADR 0006 Decision 4: diagnostics without `line` never render in
  // the editor (Problems panel only). Diagnostics without `filePath`
  // are "run-level" — the same contract applies, and the marker
  // builder must drop them so they never get tagged onto whichever
  // model the caller routed them to.
  if (diagnostic.line === undefined) return null;
  if (diagnostic.filePath === undefined) return null;
  const { monaco, model } = options;
  const { line, lineLength } = clampToModel(model, diagnostic.line);

  const startColumn = diagnostic.column ?? 1;
  let endLine = diagnostic.endLine ?? line;
  // Validate `endLine` against the model so a stale upstream
  // never produces a marker that Monaco rejects.
  if (model && endLine > model.getLineCount()) {
    endLine = model.getLineCount();
  }
  if (endLine < line) {
    endLine = line;
  }

  let endColumn: number;
  if (diagnostic.endColumn !== undefined) {
    endColumn = diagnostic.endColumn;
  } else if (diagnostic.column === undefined) {
    // Whole-line marker fallback.
    endColumn = lineLength !== null ? lineLength + 1 : startColumn + 1;
  } else {
    // Point marker at (line, column). Monaco requires endColumn >
    // startColumn for the marker to be visible, so add a 1-char span.
    endColumn = startColumn + 1;
  }
  // Studio-IDE-5 (#244 review): for *single-line* markers Monaco needs
  // endColumn > startColumn. For *multi-line* markers the end position
  // is on a later line, so an endColumn lower than startColumn is
  // valid (e.g. start at L10:40, end at L11:5). Only clamp when the
  // marker stays on one line; clamping multi-line ranges shifts the
  // highlight onto the wrong text.
  if (endLine === line && endColumn <= startColumn) {
    // Add a 1-char span, but cap at the line's actual length + 1 so
    // the marker never extends past the end of the line.
    const ceiling = lineLength !== null ? lineLength + 1 : startColumn + 1;
    endColumn = Math.min(startColumn + 1, ceiling);
  }

  const code = diagnostic.code.length > 0 ? diagnostic.code : undefined;

  return {
    severity: severityToMonaco(monaco, diagnostic.severity),
    message: diagnostic.message,
    startLineNumber: line,
    startColumn,
    endLineNumber: endLine,
    endColumn,
    source: diagnostic.sourceKind ?? "c2c",
    code,
  };
}

// Build markers for a single Monaco model from a list of diagnostics.
// Callers typically pre-filter to the diagnostics that belong to the
// owner they care about. Returns the constructed markers plus
// aggregation counters that the Problems panel surfaces.
export function diagnosticsToMarkers(
  diagnostics: Diagnostic[],
  options: DiagnosticsToMarkersOptions,
): MarkerConversionResult {
  const limit = options.limit ?? DEFAULT_MARKER_LIMIT;
  const markers: MonacoNs.editor.IMarkerData[] = [];
  let fileLevelCount = 0;
  let truncatedCount = 0;

  for (const diagnostic of diagnostics) {
    const marker = diagnosticToMarker(diagnostic, options);
    if (marker === null) {
      fileLevelCount += 1;
      continue;
    }
    if (markers.length >= limit) {
      truncatedCount += 1;
      continue;
    }
    markers.push(marker);
  }

  return { markers, fileLevelCount, truncatedCount };
}

// Partition diagnostics into per-owner buckets so callers can apply
// `monaco.editor.setModelMarkers(model, owner, markers)` once per
// owner — guaranteeing the per-sourceKind isolation acceptance
// criterion (clearing parser markers leaves build markers in place).
export function partitionByOwner(
  diagnostics: Diagnostic[],
): Record<DiagnosticOwner, Diagnostic[]> {
  const buckets: Record<DiagnosticOwner, Diagnostic[]> = {
    "c2c-cobol": [],
    "c2c-ir": [],
    "c2c-generated-java": [],
    "c2c-build": [],
    "c2c-test": [],
    "c2c-unknown": [],
  };
  for (const diagnostic of diagnostics) {
    const owner = sourceKindToOwner(diagnostic.sourceKind);
    buckets[owner].push(diagnostic);
  }
  return buckets;
}

export const DIAGNOSTIC_OWNERS: readonly DiagnosticOwner[] = [
  "c2c-cobol",
  "c2c-ir",
  "c2c-generated-java",
  "c2c-build",
  "c2c-test",
  "c2c-unknown",
] as const;
