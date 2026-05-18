// Studio-IDE-13 (#255): three-way line-level conflict detection.
//
// Pure function. Given a shared baseline, a manually-edited buffer, and the
// new generator output, identify every contiguous region where the three
// texts differ and classify it according to the IDE-13 merge taxonomy.
//
// Algorithm: diff baseline against each child independently (Myers line
// diff), align the two diff streams over baseline coordinate space, and emit
// regions per the classification rules in issue #255.
//
// Known algorithmic note: Myers' minimum edit-script ordering is not unique
// when a logical "replace N baseline lines with N child lines" operation is
// expressible as either ``N deletes followed by N inserts`` or ``N
// delete-insert pairs``. The alignment pass folds adjacent delete-then-
// insert into ``changed`` regions, but a ``delete delete insert insert``
// sequence promotes only the first delete to ``changed`` and parks the
// trailing insert as a pure insertion at the same anchor. The resulting
// classification is correct per ADR-0007 §2 (every drift line is accounted
// for as ``manual_modified`` / ``manual_edit``) but may emit two adjacent
// regions where a human would expect one. The merge dialog renders both
// regions with the same resolution and the Apply helper composes the
// merged buffer consistently — so the user impact is purely cosmetic. A
// future PR could collapse adjacent same-resolution regions for display.

export type ConflictRegionResolution = "manual" | "newGenerator" | "baseline";

export interface ConflictRegion {
  lineRange: { startLine: number; endLine: number };
  conflictKind:
    | "conflict"
    | "manual_only"
    | "new_generator_only"
    | "baseline_only"
    | "agreed";
  baselineContent: string;
  manualContent: string;
  newGeneratorContent: string;
  suggestedResolution: ConflictRegionResolution | null;
  needsUserPick: boolean;
}

export interface DetectConflictsInput {
  baseline: string;
  manual: string;
  newGenerator: string;
}

// --------------------------------------------------------------------------
// Internal diff (Myers line diff, mirrors manualEditOverlay.ts)
// --------------------------------------------------------------------------

interface DiffOp {
  kind: "equal" | "insert" | "delete";
  baseIdx: number; // valid when kind === "equal" | "delete"; -1 for "insert"
  childIdx: number; // valid when kind === "equal" | "insert"; -1 for "delete"
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split("\n");
  if (parts[parts.length - 1] === "" && content.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

function myersDiff(
  base: readonly string[],
  child: readonly string[],
): DiffOp[] {
  const n = base.length;
  const m = child.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d += 1) {
    const prev = d === 0 ? new Int32Array(2 * max + 2) : trace[d - 1]!;
    const curr = prev.slice();
    trace.push(curr);

    for (let k = -d; k <= d; k += 2) {
      const ki = k + max;
      let x: number;
      if (k === -d || (k !== d && prev[ki - 1]! < prev[ki + 1]!)) {
        x = prev[ki + 1]!;
      } else {
        x = prev[ki - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && base[x] === child[y]) {
        x += 1;
        y += 1;
      }
      curr[ki] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const prev = d === 0 ? new Int32Array(2 * max + 2) : trace[d - 1]!;
    const k = x - y;
    const ki = k + max;

    let prevK: number;
    if (k === -d || (k !== d && prev[ki - 1]! < prev[ki + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = prev[prevK + max]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: "equal", baseIdx: x, childIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ kind: "insert", baseIdx: -1, childIdx: y });
      } else {
        x -= 1;
        ops.push({ kind: "delete", baseIdx: x, childIdx: -1 });
      }
    }
  }

  ops.reverse();
  return ops;
}

// --------------------------------------------------------------------------
// Alignment over baseline coordinate space
// --------------------------------------------------------------------------

type LineStatus = "equal" | "changed" | "deleted";

interface Alignment {
  // Per-baseline-line status (length = baseLines.length).
  statusByBase: LineStatus[];
  // For each baseline line, the child's content for that slot. Equal to the
  // original baseline line when status is "equal"; equal to the replacement
  // line when status is "changed"; empty string when status is "deleted".
  childLineByBase: string[];
  // Pure inserts that have no baseline counterpart, keyed by the preceding
  // baseline index (-1 = head insert before the first baseline line).
  insertsByAnchor: Map<number, string[]>;
}

function buildAlignment(
  baseLines: readonly string[],
  ops: readonly DiffOp[],
  childLines: readonly string[],
): Alignment {
  const statusByBase: LineStatus[] = baseLines.map(() => "equal");
  const childLineByBase: string[] = [...baseLines];
  const insertsByAnchor = new Map<number, string[]>();

  let lastBaseIdx = -1;
  let pendingDeleteIdx: number | null = null;

  for (const op of ops) {
    if (op.kind === "equal") {
      lastBaseIdx = op.baseIdx;
      pendingDeleteIdx = null;
    } else if (op.kind === "delete") {
      statusByBase[op.baseIdx] = "deleted";
      childLineByBase[op.baseIdx] = "";
      lastBaseIdx = op.baseIdx;
      pendingDeleteIdx = op.baseIdx;
    } else {
      // insert
      const childLine = childLines[op.childIdx] ?? "";
      if (pendingDeleteIdx !== null) {
        // Adjacent insert after a delete: treat as a replacement (changed
        // status) so the region remains anchored to the original baseline
        // line and the child line is the replacement content.
        statusByBase[pendingDeleteIdx] = "changed";
        childLineByBase[pendingDeleteIdx] = childLine;
        pendingDeleteIdx = null;
      } else {
        // Pure insert — attach to the preceding baseline anchor (or -1 if
        // the insert is at the head before any baseline line).
        const anchor = lastBaseIdx;
        const bucket = insertsByAnchor.get(anchor) ?? [];
        bucket.push(childLine);
        insertsByAnchor.set(anchor, bucket);
      }
    }
  }

  return { statusByBase, childLineByBase, insertsByAnchor };
}

// --------------------------------------------------------------------------
// Region classification
// --------------------------------------------------------------------------

type LineKind =
  | "equal"
  | "conflict"
  | "manual_only"
  | "new_generator_only"
  | "agreed"
  | "baseline_only";

function classifyLine(
  mStatus: LineStatus,
  mLine: string,
  gStatus: LineStatus,
  gLine: string,
): LineKind {
  const mSameAsBase = mStatus === "equal";
  const gSameAsBase = gStatus === "equal";

  if (mSameAsBase && gSameAsBase) return "equal";

  const mContent = mStatus === "deleted" ? "" : mLine;
  const gContent = gStatus === "deleted" ? "" : gLine;
  const mgSame = mContent === gContent;

  if (mSameAsBase && !gSameAsBase) return "new_generator_only";
  if (!mSameAsBase && gSameAsBase) return "manual_only";
  if (mgSame) {
    // Both diverged identically — including the both-deleted case.
    return "agreed";
  }
  return "conflict";
}

function joinWithNewline(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.map((line) => `${line}\n`).join("");
}

function suggestionFor(kind: LineKind): {
  suggestedResolution: ConflictRegionResolution | null;
  needsUserPick: boolean;
} {
  switch (kind) {
    case "manual_only":
      return { suggestedResolution: "manual", needsUserPick: false };
    case "new_generator_only":
      return { suggestedResolution: "newGenerator", needsUserPick: false };
    case "agreed":
      return { suggestedResolution: "manual", needsUserPick: false };
    case "baseline_only":
      return { suggestedResolution: "baseline", needsUserPick: false };
    case "conflict":
      return { suggestedResolution: null, needsUserPick: true };
    case "equal":
      return { suggestedResolution: null, needsUserPick: false };
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function detectConflicts(input: DetectConflictsInput): ConflictRegion[] {
  const { baseline, manual, newGenerator } = input;

  // Fast-path: all three identical.
  if (baseline === manual && baseline === newGenerator) return [];

  const baseLines = splitLines(baseline);
  const manualLines = splitLines(manual);
  const genLines = splitLines(newGenerator);

  const manualOps = myersDiff(baseLines, manualLines);
  const genOps = myersDiff(baseLines, genLines);

  const manualAlign = buildAlignment(baseLines, manualOps, manualLines);
  const genAlign = buildAlignment(baseLines, genOps, genLines);

  const regions: ConflictRegion[] = [];

  interface RunAccum {
    kind: LineKind;
    startLine: number;
    endLine: number;
    baseLines: string[];
    mLines: string[];
    gLines: string[];
  }
  let run: RunAccum | null = null;

  function flushRun(r: RunAccum): void {
    if (r.kind === "equal") return;
    const { suggestedResolution, needsUserPick } = suggestionFor(r.kind);
    regions.push({
      lineRange: { startLine: r.startLine, endLine: r.endLine },
      conflictKind: r.kind,
      baselineContent: joinWithNewline(r.baseLines),
      manualContent: joinWithNewline(r.mLines),
      newGeneratorContent: joinWithNewline(r.gLines),
      suggestedResolution,
      needsUserPick,
    });
  }

  for (let i = 0; i < baseLines.length; i += 1) {
    const bLine = baseLines[i]!;
    const mSt = manualAlign.statusByBase[i] ?? "equal";
    const mLn = manualAlign.childLineByBase[i] ?? bLine;
    const gSt = genAlign.statusByBase[i] ?? "equal";
    const gLn = genAlign.childLineByBase[i] ?? bLine;

    const kind = classifyLine(mSt, mLn, gSt, gLn);
    const mContent = mSt === "deleted" ? "" : mLn;
    const gContent = gSt === "deleted" ? "" : gLn;

    if (run && run.kind === kind) {
      run.endLine = i + 1;
      run.baseLines.push(bLine);
      run.mLines.push(mContent);
      run.gLines.push(gContent);
    } else {
      if (run) flushRun(run);
      run = {
        kind,
        startLine: i + 1,
        endLine: i + 1,
        baseLines: [bLine],
        mLines: [mContent],
        gLines: [gContent],
      };
    }
  }
  if (run) flushRun(run);

  // Insert-only regions outside the baseline coordinate space. We use a
  // synthetic startLine of (baseLines.length + 1) for tail inserts and 1 for
  // head inserts; the consumer treats these as "no baseline anchor" cases.
  const tailAnchor = baseLines.length - 1;
  emitInsertRegion(
    regions,
    manualAlign.insertsByAnchor.get(-1) ?? [],
    genAlign.insertsByAnchor.get(-1) ?? [],
    1,
  );
  emitInsertRegion(
    regions,
    manualAlign.insertsByAnchor.get(tailAnchor) ?? [],
    genAlign.insertsByAnchor.get(tailAnchor) ?? [],
    baseLines.length + 1,
  );

  // Mid-buffer inserts at intermediate anchors. Each anchor in [0,
  // baseLines.length - 2] needs its own region if either side inserted there.
  for (let anchor = 0; anchor < baseLines.length - 1; anchor += 1) {
    const mIns = manualAlign.insertsByAnchor.get(anchor) ?? [];
    const gIns = genAlign.insertsByAnchor.get(anchor) ?? [];
    if (mIns.length === 0 && gIns.length === 0) continue;
    // Synthetic startLine: position immediately after the anchor baseline
    // line. In display coordinates this is `anchor + 2` (1-based, after).
    emitInsertRegion(regions, mIns, gIns, anchor + 2);
  }

  const sorted = regions.sort(
    (a, b) => a.lineRange.startLine - b.lineRange.startLine,
  );
  return coalesceAdjacentRegions(sorted);
}

// Studio-IDE-13 (#255) follow-up: Myers' edit-script ordering can split a
// logical multi-line replacement into two adjacent regions with the same
// conflictKind (e.g. ``delete delete insert insert`` → first
// delete→insert promotes to ``changed`` while the trailing insert lands
// as a pure insertion at the same anchor). Both regions carry the same
// resolution semantics; collapsing them produces a cleaner merge UI
// without changing the merged buffer. Adjacent ``conflict`` regions are
// NOT coalesced — they require independent user picks.
function coalesceAdjacentRegions(regions: ConflictRegion[]): ConflictRegion[] {
  if (regions.length <= 1) return regions;
  const result: ConflictRegion[] = [];
  let pending: ConflictRegion | null = null;
  for (const region of regions) {
    if (pending === null) {
      pending = region;
      continue;
    }
    // Adjacent = pending.endLine + 1 === region.startLine (line-contiguous
    // in the baseline coordinate space). ``conflict`` regions keep their
    // independent picks; everything else can merge when the kind matches.
    const adjacent =
      pending.lineRange.endLine + 1 === region.lineRange.startLine;
    const mergeable =
      adjacent &&
      pending.conflictKind === region.conflictKind &&
      pending.conflictKind !== "conflict" &&
      pending.suggestedResolution === region.suggestedResolution;
    if (mergeable) {
      pending = {
        lineRange: {
          startLine: pending.lineRange.startLine,
          endLine: region.lineRange.endLine,
        },
        conflictKind: pending.conflictKind,
        baselineContent: pending.baselineContent + region.baselineContent,
        manualContent: pending.manualContent + region.manualContent,
        newGeneratorContent:
          pending.newGeneratorContent + region.newGeneratorContent,
        suggestedResolution: pending.suggestedResolution,
        needsUserPick: pending.needsUserPick && region.needsUserPick,
      };
    } else {
      result.push(pending);
      pending = region;
    }
  }
  if (pending !== null) result.push(pending);
  return result;
}

// --------------------------------------------------------------------------
// Apply merge selections (region → chosen content) back into a single string
// --------------------------------------------------------------------------

export interface ApplyMergeSelectionsInput {
  baseline: string;
  regions: ConflictRegion[];
  // Selection per region. The caller keys this map by the same stable id it
  // gave the ThreeWayMergeDialog (see ``regionId`` below). Missing selections
  // for ``needsUserPick`` regions are an error — the dialog blocks Apply.
  selections: ReadonlyMap<string, ConflictRegionResolution>;
  // Stable id derivation. The merge dialog uses the same shape so the maps
  // line up. ``conflictKind`` is included so identical line ranges produced
  // by different paths (e.g. a deleted region and an inserted region at the
  // same anchor) cannot collide.
  regionId: (region: ConflictRegion) => string;
}

// Studio-IDE-13 (#255): thrown when ``applyMergeSelections`` encounters a
// conflict region with ``needsUserPick: true`` and no explicit selection
// (and no ``suggestedResolution`` fallback). The ThreeWayMergeDialog
// blocks Apply when this would happen, so the error is a defensive
// guard that surfaces a programmer mistake (caller bypassed the dialog
// or supplied an incomplete selections map) rather than silently
// dropping the user's work.
export class UnresolvedMergeConflictError extends Error {
  readonly regionId: string;
  readonly lineRange: { startLine: number; endLine: number };
  constructor(
    regionId: string,
    lineRange: { startLine: number; endLine: number },
  ) {
    super(
      `Unresolved merge conflict at lines ${lineRange.startLine}-${lineRange.endLine}; ` +
        `the caller did not supply a selection for region ${regionId}.`,
    );
    this.name = "UnresolvedMergeConflictError";
    this.regionId = regionId;
    this.lineRange = lineRange;
  }
}

function chosenContentFor(
  region: ConflictRegion,
  selections: ReadonlyMap<string, ConflictRegionResolution>,
  regionId: (r: ConflictRegion) => string,
): string {
  const explicit = selections.get(regionId(region));
  const choice = explicit ?? region.suggestedResolution;
  if (choice === "manual") return region.manualContent;
  if (choice === "newGenerator") return region.newGeneratorContent;
  if (choice === "baseline") return region.baselineContent;
  // Unresolved conflict — caller violated the dialog contract. Surface
  // the violation explicitly so the buffer is never silently corrupted.
  throw new UnresolvedMergeConflictError(regionId(region), region.lineRange);
}

export function applyMergeSelections(input: ApplyMergeSelectionsInput): string {
  const { baseline, regions, selections, regionId } = input;
  if (regions.length === 0) return baseline;

  const baseLines = splitLines(baseline);
  const result: string[] = [];
  let baseIdx = 0; // 0-based baseline pointer

  const sorted = [...regions].sort(
    (a, b) => a.lineRange.startLine - b.lineRange.startLine,
  );

  for (const region of sorted) {
    const isInsertOnly = region.baselineContent === "";
    if (!isInsertOnly) {
      // Advance baseline pointer to the start of the region (1-based start).
      const target = Math.max(0, region.lineRange.startLine - 1);
      while (baseIdx < target && baseIdx < baseLines.length) {
        result.push(baseLines[baseIdx]!);
        baseIdx += 1;
      }
    } else if (region.lineRange.startLine > baseLines.length) {
      // Tail insert: flush remaining baseline first so the inserted content
      // appears after all baseline lines.
      while (baseIdx < baseLines.length) {
        result.push(baseLines[baseIdx]!);
        baseIdx += 1;
      }
    }
    // Head inserts (startLine <= 1 with empty baselineContent) attach at the
    // current position without consuming baseline lines.

    const chosen = chosenContentFor(region, selections, regionId);
    const chosenLines = splitLines(chosen);
    result.push(...chosenLines);

    if (!isInsertOnly) {
      // Skip baseline lines this region replaced (endLine is inclusive,
      // 1-based; baseIdx is 0-based and points to the next line to emit).
      baseIdx = region.lineRange.endLine;
    }
  }

  // Flush any remaining baseline content.
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx]!);
    baseIdx += 1;
  }

  const merged = result.join("\n");
  return baseline.endsWith("\n") && !merged.endsWith("\n")
    ? `${merged}\n`
    : merged;
}

// --------------------------------------------------------------------------
// Region id derivation (stable across detect → apply round-trip)
// --------------------------------------------------------------------------

// Used by both the ThreeWayMergeDialog (to key selections) and applyMerge-
// Selections (to look them up). The kind is part of the key so two regions
// with the same line range but different classifications cannot collide.
export function defaultRegionId(region: ConflictRegion): string {
  const { startLine, endLine } = region.lineRange;
  return `${region.conflictKind}:${startLine}-${endLine}`;
}

function emitInsertRegion(
  regions: ConflictRegion[],
  mIns: string[],
  gIns: string[],
  startLine: number,
): void {
  if (mIns.length === 0 && gIns.length === 0) return;

  const mContent = joinWithNewline(mIns);
  const gContent = joinWithNewline(gIns);

  if (mContent === gContent) {
    if (mIns.length === 0) return;
    regions.push({
      lineRange: { startLine, endLine: startLine + mIns.length - 1 },
      conflictKind: "agreed",
      baselineContent: "",
      manualContent: mContent,
      newGeneratorContent: gContent,
      suggestedResolution: "manual",
      needsUserPick: false,
    });
    return;
  }

  if (mIns.length > 0 && gIns.length === 0) {
    regions.push({
      lineRange: { startLine, endLine: startLine + mIns.length - 1 },
      conflictKind: "manual_only",
      baselineContent: "",
      manualContent: mContent,
      newGeneratorContent: "",
      suggestedResolution: "manual",
      needsUserPick: false,
    });
    return;
  }

  if (gIns.length > 0 && mIns.length === 0) {
    regions.push({
      lineRange: { startLine, endLine: startLine + gIns.length - 1 },
      conflictKind: "new_generator_only",
      baselineContent: "",
      manualContent: "",
      newGeneratorContent: gContent,
      suggestedResolution: "newGenerator",
      needsUserPick: false,
    });
    return;
  }

  // Both inserted but the inserted content differs → conflict.
  const maxLen = Math.max(mIns.length, gIns.length);
  regions.push({
    lineRange: { startLine, endLine: startLine + maxLen - 1 },
    conflictKind: "conflict",
    baselineContent: "",
    manualContent: mContent,
    newGeneratorContent: gContent,
    suggestedResolution: null,
    needsUserPick: true,
  });
}
