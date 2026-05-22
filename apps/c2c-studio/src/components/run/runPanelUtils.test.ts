import { describe, it, expect } from "vitest";

import type { BuildTestView } from "@/types/api";
import type { TransformationRunState } from "@/types/run";

import {
  buildArtifactAlignment,
  buildOutputDiff,
  buildTimelineStages,
  describeBuildTestResult,
  describeClassification,
  getBuildTestArtifactRefs,
} from "./runPanelUtils";

function makeBuildTest(overrides: Partial<BuildTestView> = {}): BuildTestView {
  return {
    runId: "run-1",
    programId: "PROG-1",
    mode: "live",
    productMode: "live",
    status: "ok",
    classification: "match",
    generatedArtifactRef: null,
    ...overrides,
  };
}

function makeRunState(
  overrides: Partial<TransformationRunState> = {},
): TransformationRunState {
  return {
    phase: "completed",
    runId: "run-1",
    orchestratorRunId: null,
    programId: "PROG-1",
    error: null,
    artifactsError: null,
    summary: null,
    generated: null,
    generatedFiles: null,
    buildTest: null,
    evidence: null,
    events: null,
    progress: null,
    artifacts: null,
    experience: null,
    modelGatewayHealth: null,
    harnessReady: null,
    workflow: null,
    previousRun: null,
    ...overrides,
  };
}

describe("buildOutputDiff", () => {
  it("numbers the equal suffix per side when lengths differ", () => {
    // expected has 3 lines, actual has 4: the trailing "Z" sits on
    // expected line 3 but actual line 4.
    const diff = buildOutputDiff("A\nB\nZ", "A\nX\nY\nZ");
    const suffix = diff.find(
      (line) => line.kind === "equal" && line.content === "Z",
    );
    expect(suffix).toBeDefined();
    expect(suffix?.expectedLineNumber).toBe(3);
    expect(suffix?.actualLineNumber).toBe(4);
  });

  it("numbers equal lines identically when inputs are equal", () => {
    const diff = buildOutputDiff("A\nB", "A\nB");
    expect(diff).toEqual([
      {
        kind: "equal",
        content: "A",
        expectedLineNumber: 1,
        actualLineNumber: 1,
      },
      {
        kind: "equal",
        content: "B",
        expectedLineNumber: 2,
        actualLineNumber: 2,
      },
    ]);
  });

  it("emits no phantom line when one side is empty or undefined", () => {
    expect(buildOutputDiff("", "")).toEqual([]);
    expect(buildOutputDiff(undefined, undefined)).toEqual([]);

    const addedOnly = buildOutputDiff("", "X");
    expect(addedOnly).toEqual([
      { kind: "added", content: "X", actualLineNumber: 1 },
    ]);

    const removedOnly = buildOutputDiff("X", undefined);
    expect(removedOnly).toEqual([
      { kind: "removed", content: "X", expectedLineNumber: 1 },
    ]);
  });

  it("falls back to a positional diff above the matrix limit", () => {
    // 600 distinct lines per side -> 360_000 > DIFF_MATRIX_LIMIT (250_000).
    const expected = Array.from({ length: 600 }, (_, i) => `e${i}`).join("\n");
    const actual = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const diff = buildOutputDiff(expected, actual);

    expect(diff).toHaveLength(1200);
    expect(diff[0]).toEqual({
      kind: "removed",
      content: "e0",
      expectedLineNumber: 1,
    });
    expect(diff[1]).toEqual({
      kind: "added",
      content: "a0",
      actualLineNumber: 1,
    });
  });
});

describe("describeBuildTestResult", () => {
  const cases: Array<[BuildTestView["classification"], string]> = [
    ["match", "Pass"],
    ["divergence-known-w0-coverage-gap", "Known divergence"],
    ["divergence-unknown", "Mismatch detected"],
    [
      "true-golden-master-reproduction-error",
      "Golden-master reproduction failed",
    ],
    ["true-golden-master-mismatch", "Golden-master mismatch"],
    ["compile-error", "Blocked by compilation failure"],
    ["run-error", "Blocked by runtime failure"],
    ["skipped-no-execution", "Not executed"],
  ];

  it.each(cases)("maps %s to its label", (classification, label) => {
    const result = describeBuildTestResult(makeBuildTest({ classification }));
    expect(result.label).toBe(label);
  });

  it("returns the intentional-divergence presentation when flagged", () => {
    const result = describeBuildTestResult(
      makeBuildTest({ classification: "divergence-unknown" }),
      true,
    );
    expect(result.label).toBe("Intentionally diverged");
    expect(result.tone).toBe("warning");
  });

  it("returns the pending presentation when no build/test is available", () => {
    const result = describeBuildTestResult(null);
    expect(result.tone).toBe("pending");
  });
});

describe("describeClassification", () => {
  const cases: Array<[BuildTestView["classification"], string]> = [
    ["match", "Equivalent"],
    ["divergence-known-w0-coverage-gap", "Known W0 coverage gap"],
    ["divergence-unknown", "Unexpected output divergence"],
    [
      "true-golden-master-reproduction-error",
      "Golden-master reproduction error",
    ],
    ["true-golden-master-mismatch", "Golden-master mismatch"],
    ["compile-error", "Blocked by compilation failure"],
    ["run-error", "Blocked by runtime failure"],
    ["skipped-no-execution", "Blocked before equivalence could run"],
  ];

  it.each(cases)("maps %s to its description", (classification, text) => {
    expect(describeClassification(classification)).toBe(text);
  });

  it("falls back when no classification is provided", () => {
    expect(describeClassification(undefined)).toBe(
      "Waiting for equivalence results",
    );
  });
});

describe("getBuildTestArtifactRefs", () => {
  it("keeps the first occurrence and drops duplicate or missing refs", () => {
    const shared = { sha256: "a".repeat(64), byteSize: 1, kind: "shared" };
    const refs = getBuildTestArtifactRefs(
      makeBuildTest({
        expectedOutputRef: shared,
        actualOutputRef: shared,
        outputRef: null,
        generatedArtifactRef: {
          sha256: "b".repeat(64),
          byteSize: 2,
          kind: "generated",
        },
      }),
    );

    expect(refs.map((entry) => entry.label)).toEqual([
      "Expected output",
      "Generated artifact",
    ]);
  });

  it("returns an empty list when no build/test is available", () => {
    expect(getBuildTestArtifactRefs(null)).toEqual([]);
  });
});

describe("buildArtifactAlignment", () => {
  it("reports aligned when every artifact ref shares one sha", () => {
    const ref = { sha256: "c".repeat(64), byteSize: 3, kind: "artifact" };
    const alignment = buildArtifactAlignment(
      makeRunState({
        generated: { artifactRef: ref } as TransformationRunState["generated"],
        buildTest: makeBuildTest({ generatedArtifactRef: ref }),
        evidence: {
          generatedArtifactRef: ref,
        } as TransformationRunState["evidence"],
      }),
    );

    expect(alignment.aligned).toBe(true);
    expect(alignment.expectedSha).toBe(ref.sha256);
    expect(alignment.distinctShas).toEqual([ref.sha256]);
  });

  it("reports misalignment when shas differ", () => {
    const alignment = buildArtifactAlignment(
      makeRunState({
        generated: {
          artifactRef: { sha256: "d".repeat(64), byteSize: 1, kind: "a" },
        } as TransformationRunState["generated"],
        buildTest: makeBuildTest({
          generatedArtifactRef: {
            sha256: "e".repeat(64),
            byteSize: 1,
            kind: "a",
          },
        }),
      }),
    );

    expect(alignment.aligned).toBe(false);
    expect(alignment.expectedSha).toBeNull();
    expect(alignment.distinctShas).toHaveLength(2);
  });
});

describe("buildTimelineStages", () => {
  it("blocks the parity-comparison stage on a compile error with a blocked action label", () => {
    const stages = buildTimelineStages(
      makeRunState({
        buildTest: makeBuildTest({
          classification: "compile-error",
          status: "compile-failed",
          compileStatus: "failed",
        }),
      }),
    );

    const parity = stages.find((stage) => stage.id === "parity-comparison");
    expect(parity).toBeDefined();
    expect(parity?.status).toBe("blocked");
    expect(parity?.actionLabel).not.toBe("Inspect diff and normalized outputs");
    expect(parity?.actionLabel).toBe(
      "Resolve the upstream failure to unblock this stage",
    );
  });

  it("keeps the parity-comparison stage successful on a match", () => {
    const stages = buildTimelineStages(
      makeRunState({ buildTest: makeBuildTest({ classification: "match" }) }),
    );

    const parity = stages.find((stage) => stage.id === "parity-comparison");
    expect(parity?.status).toBe("success");
  });
});
