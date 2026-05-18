import { describe, expect, it } from "vitest";

import {
  applyMergeSelections,
  defaultRegionId,
  detectConflicts,
  UnresolvedMergeConflictError,
  type ConflictRegion,
  type ConflictRegionResolution,
} from "./conflictDetection";

describe("detectConflicts", () => {
  it("returns [] when all three texts are identical", () => {
    const result = detectConflicts({
      baseline: "a\nb\nc\n",
      manual: "a\nb\nc\n",
      newGenerator: "a\nb\nc\n",
    });
    expect(result).toEqual([]);
  });

  it("classifies as manual_only when only manual diverged", () => {
    const baseline = "x\ny\nz\n";
    const result = detectConflicts({
      baseline,
      manual: "x\nY-CHANGED\nz\n",
      newGenerator: baseline,
    });
    expect(result).toHaveLength(1);
    const region = result[0]!;
    expect(region.conflictKind).toBe("manual_only");
    expect(region.suggestedResolution).toBe("manual");
    expect(region.needsUserPick).toBe(false);
    expect(region.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(region.manualContent).toBe("Y-CHANGED\n");
    expect(region.newGeneratorContent).toBe("y\n");
  });

  it("classifies as new_generator_only when only the generator diverged", () => {
    const baseline = "x\ny\nz\n";
    const result = detectConflicts({
      baseline,
      manual: baseline,
      newGenerator: "x\nY-NEW\nz\n",
    });
    expect(result).toHaveLength(1);
    const region = result[0]!;
    expect(region.conflictKind).toBe("new_generator_only");
    expect(region.suggestedResolution).toBe("newGenerator");
    expect(region.needsUserPick).toBe(false);
  });

  it("classifies as agreed when manual and new generator diverged identically", () => {
    const baseline = "x\ny\nz\n";
    const change = "x\nAGREED\nz\n";
    const result = detectConflicts({
      baseline,
      manual: change,
      newGenerator: change,
    });
    expect(result).toHaveLength(1);
    const region = result[0]!;
    expect(region.conflictKind).toBe("agreed");
    expect(region.suggestedResolution).toBe("manual");
    expect(region.needsUserPick).toBe(false);
  });

  it("classifies as conflict when both diverged differently", () => {
    const baseline = "x\ny\nz\n";
    const result = detectConflicts({
      baseline,
      manual: "x\nMANUAL\nz\n",
      newGenerator: "x\nGENERATOR\nz\n",
    });
    expect(result).toHaveLength(1);
    const region = result[0]!;
    expect(region.conflictKind).toBe("conflict");
    expect(region.suggestedResolution).toBeNull();
    expect(region.needsUserPick).toBe(true);
    expect(region.manualContent).toBe("MANUAL\n");
    expect(region.newGeneratorContent).toBe("GENERATOR\n");
  });

  it("emits one region per distinct contiguous classification", () => {
    const baseline = "a\nb\nc\nd\ne\n";
    const manual = "a\nB-MAN\nc\nD-MAN\ne\n";
    const newGenerator = "a\nB-GEN\nc\nD-MAN\ne\n";
    const result = detectConflicts({ baseline, manual, newGenerator });
    // Line 2 is conflict (both diverged differently); line 4 is agreed.
    expect(result).toHaveLength(2);
    const sortedKinds = result.map((r) => r.conflictKind);
    expect(sortedKinds).toEqual(["conflict", "agreed"]);
    expect(result[0]!.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(result[1]!.lineRange).toEqual({ startLine: 4, endLine: 4 });
  });

  it("preserves regions sorted by startLine", () => {
    const baseline = "a\nb\nc\nd\ne\nf\n";
    const manual = "a\nB-MAN\nc\nd\nE-MAN\nf\n";
    const newGenerator = baseline;
    const result = detectConflicts({ baseline, manual, newGenerator });
    const starts = result.map((r) => r.lineRange.startLine);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("handles a pure insertion at the tail of the buffer", () => {
    const baseline = "a\nb\n";
    const manual = "a\nb\nappended-by-manual\n";
    const newGenerator = baseline;
    const result = detectConflicts({ baseline, manual, newGenerator });
    expect(result).toHaveLength(1);
    expect(result[0]!.conflictKind).toBe("manual_only");
    expect(result[0]!.suggestedResolution).toBe("manual");
    expect(result[0]!.manualContent).toBe("appended-by-manual\n");
  });

  it("classifies a multi-line manual replacement as manual_only", () => {
    // A multi-line replacement may emit either one or two adjacent regions
    // depending on how Myers diff orders its insert/delete ops. The key
    // invariant: every emitted region is manual_only with a manual
    // suggested resolution, and together they cover lines 2 onwards.
    const baseline = "a\nb\nc\nd\n";
    const manual = "a\nB-MAN\nC-MAN\nd\n";
    const newGenerator = baseline;
    const result = detectConflicts({ baseline, manual, newGenerator });
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const region of result) {
      expect(region.conflictKind).toBe("manual_only");
      expect(region.suggestedResolution).toBe("manual");
      expect(region.needsUserPick).toBe(false);
    }
    // The combined manual content of all regions contains the replacement
    // lines the user typed.
    const combined = result.map((r) => r.manualContent).join("");
    expect(combined).toContain("B-MAN");
    expect(combined).toContain("C-MAN");
  });

  it("does not emit a region for pure equal regions even when other regions exist", () => {
    const baseline = "a\nb\nc\n";
    const manual = "a\nb\nC-MAN\n";
    const newGenerator = baseline;
    const result = detectConflicts({ baseline, manual, newGenerator });
    expect(result).toHaveLength(1);
    expect(result[0]!.lineRange).toEqual({ startLine: 3, endLine: 3 });
  });
});

describe("applyMergeSelections", () => {
  function regionOf(
    conflictKind: ConflictRegion["conflictKind"],
    startLine: number,
    endLine: number,
    baselineContent: string,
    manualContent: string,
    newGeneratorContent: string,
    suggestedResolution: ConflictRegionResolution | null,
  ): ConflictRegion {
    return {
      lineRange: { startLine, endLine },
      conflictKind,
      baselineContent,
      manualContent,
      newGeneratorContent,
      suggestedResolution,
      needsUserPick: conflictKind === "conflict",
    };
  }

  it("returns the baseline unchanged when there are no regions", () => {
    const baseline = "a\nb\nc\n";
    const result = applyMergeSelections({
      baseline,
      regions: [],
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe(baseline);
  });

  it("applies the manual content for a manual_only region", () => {
    const baseline = "a\nb\nc\n";
    const regions = [
      regionOf("manual_only", 2, 2, "b\n", "B-MAN\n", "b\n", "manual"),
    ];
    const result = applyMergeSelections({
      baseline,
      regions,
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nB-MAN\nc\n");
  });

  it("applies the newGenerator content for a new_generator_only region", () => {
    const baseline = "a\nb\nc\n";
    const regions = [
      regionOf(
        "new_generator_only",
        2,
        2,
        "b\n",
        "b\n",
        "B-GEN\n",
        "newGenerator",
      ),
    ];
    const result = applyMergeSelections({
      baseline,
      regions,
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nB-GEN\nc\n");
  });

  it("honours an explicit user selection over the suggested resolution", () => {
    const baseline = "a\nb\nc\n";
    const conflict = regionOf(
      "conflict",
      2,
      2,
      "b\n",
      "MANUAL\n",
      "GENERATOR\n",
      null,
    );
    const result = applyMergeSelections({
      baseline,
      regions: [conflict],
      selections: new Map([
        [defaultRegionId(conflict), "newGenerator" as const],
      ]),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nGENERATOR\nc\n");
  });

  it("treats a tail insert region as an append after all baseline lines", () => {
    const baseline = "a\nb\n";
    const tailInsert = regionOf(
      "manual_only",
      3,
      3,
      "",
      "appended\n",
      "",
      "manual",
    );
    const result = applyMergeSelections({
      baseline,
      regions: [tailInsert],
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nb\nappended\n");
  });

  it("composes manual + agreed regions consistently", () => {
    const baseline = "a\nb\nc\nd\ne\n";
    const r1 = regionOf("manual_only", 2, 2, "b\n", "B-MAN\n", "b\n", "manual");
    const r2 = regionOf("agreed", 4, 4, "d\n", "D-NEW\n", "D-NEW\n", "manual");
    const result = applyMergeSelections({
      baseline,
      regions: [r1, r2],
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nB-MAN\nc\nD-NEW\ne\n");
  });

  it("throws UnresolvedMergeConflictError when the caller bypasses the dialog", () => {
    const baseline = "a\nb\nc\n";
    const conflict = regionOf(
      "conflict",
      2,
      2,
      "b\n",
      "MANUAL\n",
      "GENERATOR\n",
      null,
    );
    // No selection supplied AND no suggestedResolution — the dialog
    // contract says Apply is blocked in this case. Calling the helper
    // anyway is a programmer error; we surface it explicitly so the
    // buffer is never silently corrupted.
    expect(() =>
      applyMergeSelections({
        baseline,
        regions: [conflict],
        selections: new Map(),
        regionId: defaultRegionId,
      }),
    ).toThrowError(UnresolvedMergeConflictError);
  });

  it("uses suggestedResolution when no explicit selection is supplied", () => {
    const baseline = "a\nb\nc\n";
    // A conflict-shaped region with a suggested resolution acts like an
    // auto-resolved choice; the dialog can pre-fill the radio with
    // suggestedResolution and Apply works without an explicit selection.
    const suggested = regionOf(
      "manual_only",
      2,
      2,
      "b\n",
      "B-MAN\n",
      "b\n",
      "manual",
    );
    const result = applyMergeSelections({
      baseline,
      regions: [suggested],
      selections: new Map(),
      regionId: defaultRegionId,
    });
    expect(result).toBe("a\nB-MAN\nc\n");
  });
});

describe("defaultRegionId", () => {
  it("includes conflict kind and line range", () => {
    const region: ConflictRegion = {
      lineRange: { startLine: 5, endLine: 7 },
      conflictKind: "conflict",
      baselineContent: "",
      manualContent: "",
      newGeneratorContent: "",
      suggestedResolution: null,
      needsUserPick: true,
    };
    expect(defaultRegionId(region)).toBe("conflict:5-7");
  });
});
