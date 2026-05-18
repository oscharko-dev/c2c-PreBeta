// Studio-IDE-6 (#248): bidirectional lineage navigation between generated
// Java and COBOL source. Backed by the traceability envelope (irSymbolMap
// + javaRegionClassification) and the inline IR comments mined out of
// Java source by `traceParser.parseInlineIrAnchors`.
//
// Validity rules (ADR-0007 §6 / issue body):
//   deterministic | agent_proposed | repair_attempted → valid; resolve via
//     the NEAREST inline IR comment ≤ the requested javaLine, then look up
//     its IR symbol id in irSymbolMap.
//   manual_modified → { ok: false, reason: "stale_manual_edit" } — IDE-13
//     will recompute lineage when the manual-edit overlay lands; until
//     then the lineage cannot be trusted.
//   manual_edit    → { ok: false, reason: "manual_only" } — the region
//     never existed in the Generator Baseline.
//   No matching region OR no inline anchor in the region → "no_mapping".

import {
  fetchTraceability,
  parseInlineIrAnchors,
  type ParsedTrace,
} from "./traceParser";
import { emit as emitTelemetry } from "./editorTelemetry";
import type {
  EditorTelemetryMappingClass,
  LineageNavigatePayload,
} from "@/types/editor-telemetry";
import type { JavaRegionClassification } from "@/types/api";

export type LineageUnavailableReason =
  | "no_mapping"
  | "stale_manual_edit"
  | "manual_only";

export type LineageResolution<T> =
  | { ok: true; target: T }
  | { ok: false; reason: LineageUnavailableReason };

export interface CobolAnchor {
  cobolFile: string;
  cobolLine: number;
}

export interface JavaTarget {
  javaFile: string;
  javaStartLine: number;
  javaEndLine: number;
}

// Test seam + production wiring point. Production callers (the CobolEditorPane
// jump action) pass a provider that pulls Java source from the editor models;
// tests pass a synchronous in-memory provider.
export type JavaSourceProvider = (
  javaFile: string,
) => string | null | undefined;

function findEnclosingRegion(
  regions: readonly JavaRegionClassification[],
  javaLine: number,
): JavaRegionClassification | null {
  for (const region of regions) {
    if (
      javaLine >= region.lineRange.startLine &&
      javaLine <= region.lineRange.endLine
    ) {
      return region;
    }
  }
  return null;
}

function emitLineageNavigate(
  direction: "java_to_cobol" | "cobol_to_java",
  result:
    | { ok: true; mappingClass?: EditorTelemetryMappingClass }
    | { ok: false; reason: LineageUnavailableReason },
): void {
  const payload: LineageNavigatePayload = result.ok
    ? {
        direction,
        resolved: true,
        ...(result.mappingClass !== undefined
          ? { mappingClass: result.mappingClass }
          : {}),
      }
    : { direction, resolved: false, unresolvedReason: result.reason };
  emitTelemetry({ eventType: "lineage.navigate", payload });
}

export async function resolveJavaToCobol(
  runId: string,
  javaFile: string,
  javaLine: number,
  source: string,
  fetcher?: typeof fetch,
): Promise<LineageResolution<CobolAnchor>> {
  const parsed = await fetchTraceability(runId, fetcher);
  const regions = parsed.javaRegionClassification.get(javaFile) ?? [];
  const region = findEnclosingRegion(regions, javaLine);
  if (!region) {
    emitLineageNavigate("java_to_cobol", { ok: false, reason: "no_mapping" });
    return { ok: false, reason: "no_mapping" };
  }
  if (region.originClass === "manual_modified") {
    emitLineageNavigate("java_to_cobol", {
      ok: false,
      reason: "stale_manual_edit",
    });
    return { ok: false, reason: "stale_manual_edit" };
  }
  if (region.originClass === "manual_edit") {
    emitLineageNavigate("java_to_cobol", { ok: false, reason: "manual_only" });
    return { ok: false, reason: "manual_only" };
  }
  // deterministic | agent_proposed | repair_attempted — resolve via the
  // nearest preceding inline IR anchor that is inside the region.
  const anchors = parseInlineIrAnchors(source);
  let chosen = null as {
    javaLine: number;
    irNodeId: string;
    cobolLine: number;
  } | null;
  for (const anchor of anchors) {
    if (anchor.javaLine < region.lineRange.startLine) continue;
    if (anchor.javaLine > region.lineRange.endLine) continue;
    if (anchor.javaLine > javaLine) continue;
    if (!chosen || anchor.javaLine > chosen.javaLine) {
      chosen = anchor;
    }
  }
  if (!chosen) {
    emitLineageNavigate("java_to_cobol", { ok: false, reason: "no_mapping" });
    return { ok: false, reason: "no_mapping" };
  }
  const irAnchor = parsed.irSymbolMap.get(chosen.irNodeId);
  if (!irAnchor) {
    emitLineageNavigate("java_to_cobol", { ok: false, reason: "no_mapping" });
    return { ok: false, reason: "no_mapping" };
  }
  emitLineageNavigate("java_to_cobol", {
    ok: true,
    mappingClass: region.mappingClass,
  });
  return {
    ok: true,
    target: { cobolFile: irAnchor.cobolFile, cobolLine: irAnchor.cobolLine },
  };
}

function collectJavaTargets(
  parsed: ParsedTrace,
  cobolFile: string,
  cobolLine: number,
  sourceProvider: JavaSourceProvider,
): JavaTarget[] {
  const targets: JavaTarget[] = [];
  const seen = new Set<string>();
  // Iterate Java files in a stable order (sorted by key) so the caller's
  // "first match" UX is deterministic across runs.
  const fileKeys = [...parsed.javaRegionClassification.keys()].sort();
  for (const javaFile of fileKeys) {
    const regions = parsed.javaRegionClassification.get(javaFile) ?? [];
    if (regions.length === 0) continue;
    const source = sourceProvider(javaFile);
    if (typeof source !== "string") continue;
    const anchors = parseInlineIrAnchors(source);
    if (anchors.length === 0) continue;
    for (const anchor of anchors) {
      const irAnchor = parsed.irSymbolMap.get(anchor.irNodeId);
      if (!irAnchor) continue;
      if (irAnchor.cobolFile !== cobolFile) continue;
      if (irAnchor.cobolLine !== cobolLine) continue;
      const region = findEnclosingRegion(regions, anchor.javaLine);
      if (!region) continue;
      // Manual regions never advertise COBOL lineage in the reverse
      // direction either — they are excluded from the result set.
      if (
        region.originClass === "manual_modified" ||
        region.originClass === "manual_edit"
      ) {
        continue;
      }
      const dedupeKey = `${javaFile}::${region.lineRange.startLine}::${region.lineRange.endLine}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push({
        javaFile,
        javaStartLine: region.lineRange.startLine,
        javaEndLine: region.lineRange.endLine,
      });
    }
  }
  // Stable order: file name then start line.
  targets.sort((a, b) => {
    if (a.javaFile === b.javaFile) {
      return a.javaStartLine - b.javaStartLine;
    }
    return a.javaFile < b.javaFile ? -1 : 1;
  });
  return targets;
}

export async function resolveCobolToJava(
  runId: string,
  cobolFile: string,
  cobolLine: number,
  fetcher?: typeof fetch,
  sourceProvider?: JavaSourceProvider,
): Promise<LineageResolution<JavaTarget[]>> {
  const parsed = await fetchTraceability(runId, fetcher);
  // In production the editor pane supplies a real provider that reads from
  // Monaco models. Tests pass an in-memory provider. Absent a provider we
  // cannot mine inline anchors, so we surface a "no mapping" — never throw.
  const provider: JavaSourceProvider = sourceProvider ?? (() => null);
  const targets = collectJavaTargets(parsed, cobolFile, cobolLine, provider);
  if (targets.length === 0) {
    emitLineageNavigate("cobol_to_java", { ok: false, reason: "no_mapping" });
    return { ok: false, reason: "no_mapping" };
  }
  emitLineageNavigate("cobol_to_java", { ok: true });
  return { ok: true, target: targets };
}
