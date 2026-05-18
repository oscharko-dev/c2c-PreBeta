import { describe, expect, it } from "vitest";

import { computeManualEditOverlay } from "./manualEditOverlay";

const RUN_ID = "run-2026-05-18";
const BASE_RUN_ID = "run-2026-05-17";
const JAVA_FILE = "src/main/java/com/example/App.java";

function makeInput(baselineContent: string, currentContent: string) {
  return {
    baselineContent,
    currentContent,
    runId: RUN_ID,
    javaFile: JAVA_FILE,
    generatorBaselineRunId: BASE_RUN_ID,
  };
}

describe("computeManualEditOverlay", () => {
  it("returns null when buffer is byte-identical to baseline", () => {
    const result = computeManualEditOverlay(
      makeInput("line a\nline b\nline c\n", "line a\nline b\nline c\n"),
    );
    expect(result).toBeNull();
  });

  it("returns null when current buffer is empty (degenerate state)", () => {
    const result = computeManualEditOverlay(makeInput("line a\nline b\n", ""));
    expect(result).toBeNull();
  });

  it("marks the full current buffer as manual_edit when baseline is empty", () => {
    const result = computeManualEditOverlay(makeInput("", "first\nsecond\n"));
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe("v0");
    expect(result!.runId).toBe(RUN_ID);
    expect(result!.javaFile).toBe(JAVA_FILE);
    expect(result!.regions).toHaveLength(1);
    expect(result!.regions[0]).toEqual({
      lineRange: { startLine: 1, endLine: 2 },
      originClass: "manual_edit",
    });
  });

  it("marks a single-line modification as manual_modified", () => {
    const baseline = "line 1\nline 2\nline 3\n";
    const current = "line 1\nLINE TWO\nline 3\n";
    const result = computeManualEditOverlay(makeInput(baseline, current));
    expect(result).not.toBeNull();
    expect(result!.regions).toHaveLength(1);
    expect(result!.regions[0]?.originClass).toBe("manual_modified");
    expect(result!.regions[0]?.lineRange).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it("marks a contiguous insertion as manual_edit", () => {
    const baseline = "alpha\nbeta\n";
    const current = "alpha\nnew1\nnew2\nbeta\n";
    const result = computeManualEditOverlay(makeInput(baseline, current));
    expect(result).not.toBeNull();
    expect(result!.regions).toHaveLength(1);
    expect(result!.regions[0]?.originClass).toBe("manual_edit");
    expect(result!.regions[0]?.lineRange).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it("produces no region for a pure deletion", () => {
    const baseline = "a\nb\nc\n";
    const current = "a\nc\n";
    const result = computeManualEditOverlay(makeInput(baseline, current));
    // Pure deletions don't produce a manual region per ADR-0007 §2.
    // Surrounding context is unchanged so the regions list is empty.
    expect(result).not.toBeNull();
    expect(result!.regions).toEqual([]);
  });

  it("emits two distinct regions for a mixed modification + insertion", () => {
    const baseline = "a\nb\nc\nd\ne\n";
    const current = "a\nB-mod\nc\nNEW1\nNEW2\nd\ne\n";
    const result = computeManualEditOverlay(makeInput(baseline, current));
    expect(result).not.toBeNull();
    expect(result!.regions).toHaveLength(2);
    expect(result!.regions[0]?.originClass).toBe("manual_modified");
    expect(result!.regions[0]?.lineRange).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(result!.regions[1]?.originClass).toBe("manual_edit");
    expect(result!.regions[1]?.lineRange).toEqual({
      startLine: 4,
      endLine: 5,
    });
  });

  it("sorts regions ascending by startLine", () => {
    const baseline = "a\nb\nc\nd\ne\nf\n";
    const current = "a\nB-mod\nc\nd\nNEW\ne\nf\n";
    const result = computeManualEditOverlay(makeInput(baseline, current));
    expect(result).not.toBeNull();
    const startLines = result!.regions.map((r) => r.lineRange.startLine);
    expect(startLines).toEqual([...startLines].sort((a, b) => a - b));
  });

  it("preserves runId, javaFile, schemaVersion fields on the overlay", () => {
    const result = computeManualEditOverlay(makeInput("a\nb\n", "a\nB\n"));
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe("v0");
    expect(result!.runId).toBe(RUN_ID);
    expect(result!.javaFile).toBe(JAVA_FILE);
  });
});
