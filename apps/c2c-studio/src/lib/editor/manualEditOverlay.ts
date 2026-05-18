// Studio-IDE-13 (#255): compute a JavaOriginOverlay that marks the regions
// of the current editor buffer that have diverged from the Generator Baseline.
//
// This module is a pure function — no side effects, no I/O, no React. It is
// called by the IDE-13 governance flow whenever the editor buffer changes and
// the result is fed to useOriginOverlayApi().setOverlay().
//
// Algorithm: Myers O(ND) line diff. Correct on any 1000 × 1000 input within
// the in-browser budget.

import type { JavaOriginOverlay, JavaOriginRegion } from "@/types/api";

export interface ComputeManualEditOverlayInput {
  baselineContent: string;
  currentContent: string;
  runId: string;
  javaFile: string;
  generatorBaselineRunId: string;
}

// --------------------------------------------------------------------------
// Internal diff types
// --------------------------------------------------------------------------

type DiffOp =
  | { kind: "equal"; baseIdx: number; curIdx: number }
  | { kind: "insert"; curIdx: number }
  | { kind: "delete"; baseIdx: number };

// --------------------------------------------------------------------------
// LCS-based line diff (Myers' algorithm)
// --------------------------------------------------------------------------

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split("\n");
  // Strip spurious trailing empty string introduced by a trailing newline.
  if (parts[parts.length - 1] === "" && content.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

// Returns a sequence of DiffOp covering every line of both arrays.
function myersDiff(base: readonly string[], cur: readonly string[]): DiffOp[] {
  const n = base.length;
  const m = cur.length;

  if (n === 0 && m === 0) return [];

  const max = n + m;
  // v[k + max] = furthest-reaching x on diagonal k.
  const v = new Int32Array(2 * max + 2);
  // trace[d] = snapshot of v after d edit steps — needed for back-tracking.
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d += 1) {
    const prev = d === 0 ? new Int32Array(2 * max + 2) : trace[d - 1]!;
    const curr = prev.slice();
    trace.push(curr);

    for (let k = -d; k <= d; k += 2) {
      const ki = k + max;
      let x: number;
      if (k === -d || (k !== d && prev[ki - 1]! < prev[ki + 1]!)) {
        x = prev[ki + 1]!; // move down (insert from cur)
      } else {
        x = prev[ki - 1]! + 1; // move right (delete from base)
      }
      let y = x - k;
      while (x < n && y < m && base[x] === cur[y]) {
        x += 1;
        y += 1;
      }
      curr[ki] = x;
      v[ki] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Back-track through trace to reconstruct the edit sequence.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const prev = d === 0 ? new Int32Array(2 * max + 2) : trace[d - 1]!;
    const k = x - y;
    const ki = k + max;

    let prevK: number;
    if (k === -d || (k !== d && prev[ki - 1]! < prev[ki + 1]!)) {
      prevK = k + 1; // came from insert
    } else {
      prevK = k - 1; // came from delete
    }

    const prevX = prev[prevK + max]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: "equal", baseIdx: x, curIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ kind: "insert", curIdx: y });
      } else {
        x -= 1;
        ops.push({ kind: "delete", baseIdx: x });
      }
    }
  }

  ops.reverse();
  return ops;
}

// --------------------------------------------------------------------------
// Region classification
// --------------------------------------------------------------------------

// Walk ops and emit JavaOriginRegion entries for contiguous changed blocks.
// Line numbers in the output are 1-based, in current-buffer coordinate space.
function opsToRegions(ops: DiffOp[]): JavaOriginRegion[] {
  const regions: JavaOriginRegion[] = [];

  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind === "equal") {
      i += 1;
      continue;
    }

    // Collect a contiguous run of non-equal ops.
    let hasInsert = false;
    let hasDelete = false;
    const runStart = i;

    while (i < ops.length && ops[i]!.kind !== "equal") {
      if (ops[i]!.kind === "insert") {
        hasInsert = true;
      } else if (ops[i]!.kind === "delete") {
        hasDelete = true;
      }
      i += 1;
    }

    // Collect the insert ops in this run to compute current-buffer line range.
    const insertOps = ops
      .slice(runStart, i)
      .filter(
        (o): o is { kind: "insert"; curIdx: number } => o.kind === "insert",
      );

    if (insertOps.length === 0) {
      // Pure deletion — no current-buffer lines to mark; skip.
      continue;
    }

    const originClass =
      hasDelete && hasInsert ? "manual_modified" : "manual_edit";
    const startLine = insertOps[0]!.curIdx + 1;
    const endLine = insertOps[insertOps.length - 1]!.curIdx + 1;

    regions.push({ lineRange: { startLine, endLine }, originClass });
  }

  return regions;
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function computeManualEditOverlay(
  input: ComputeManualEditOverlayInput,
): JavaOriginOverlay | null {
  const { baselineContent, currentContent, runId, javaFile } = input;

  if (baselineContent === currentContent) {
    return null;
  }

  const baseLines = splitLines(baselineContent);
  const curLines = splitLines(currentContent);

  // Empty current buffer — degenerate state, no regions to classify.
  if (curLines.length === 0) {
    return null;
  }

  // Empty baseline — every current line is a net-new manual_edit.
  if (baseLines.length === 0) {
    return {
      schemaVersion: "v0",
      runId,
      javaFile,
      regions: [
        {
          lineRange: { startLine: 1, endLine: curLines.length },
          originClass: "manual_edit",
        },
      ],
    };
  }

  const ops = myersDiff(baseLines, curLines);
  const regions = opsToRegions(ops);

  return { schemaVersion: "v0", runId, javaFile, regions };
}
