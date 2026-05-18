// Studio-IDE-12 (#250) — unit test for the perf-harness fixture
// generator. Keeps the synthetic program inside the W0 COBOL subset
// and guarantees deterministic line counts so the perf harness can
// reason about Monaco's mount budgets.

import { describe, expect, it } from "vitest";

import { buildSyntheticCobol, countLines } from "./e2e/helpers/syntheticCobol";

describe("Studio-IDE-12 (#250) syntheticCobol", () => {
  it("produces a 5000-line program inside ±1 of the request", () => {
    const program = buildSyntheticCobol({ targetLines: 5_000 });
    const lines = countLines(program);
    expect(lines).toBeGreaterThanOrEqual(4_999);
    expect(lines).toBeLessThanOrEqual(5_001);
  });

  it("produces a 10000-line program inside ±1 of the request", () => {
    const program = buildSyntheticCobol({ targetLines: 10_000 });
    const lines = countLines(program);
    expect(lines).toBeGreaterThanOrEqual(9_999);
    expect(lines).toBeLessThanOrEqual(10_001);
  });

  it("declares an IDENTIFICATION DIVISION + PROGRAM-ID", () => {
    const program = buildSyntheticCobol({
      targetLines: 200,
      programId: "PERF01",
    });
    expect(program).toContain("IDENTIFICATION DIVISION.");
    expect(program).toContain("PROGRAM-ID. PERF01.");
  });

  it("rejects a target line count below 100", () => {
    expect(() => buildSyntheticCobol({ targetLines: 50 })).toThrow(
      /targetLines must be an integer >= 100/,
    );
  });

  it("rejects a non-alphanumeric programId", () => {
    expect(() =>
      buildSyntheticCobol({ targetLines: 200, programId: "BAD ID" }),
    ).toThrow(/alphanumeric/);
  });
});
