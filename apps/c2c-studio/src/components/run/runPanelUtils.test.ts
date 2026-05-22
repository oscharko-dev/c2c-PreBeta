import { describe, it, expect } from "vitest";

import type { BuildTestView, RunWorkflowView } from "@/types/api";
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

  describe("cancelled workflow finalClassification", () => {
    // Minimal valid RunWorkflowView fixture for a cancelled run.
    // No repair attempts, no active agent — the workflow was cancelled before
    // any agentic stage could complete.
    function makeCancelledWorkflow(
      overrides: Partial<RunWorkflowView> = {},
    ): RunWorkflowView {
      return {
        runId: "run-cancelled",
        programId: "PROG-1",
        mode: "live",
        productMode: "live",
        source: "live",
        state: "cancelled",
        activeStep: null,
        activeAgent: null,
        trustCase: null,
        agentAttemptCount: 0,
        repairBudget: null,
        assistBudget: null,
        modelInvocationBudget: null,
        repairAttempts: [],
        assistDecision: null,
        trustSummary: null,
        finalClassification: "cancelled",
        failureCode: null,
        failureMessage: null,
        generatedJavaRef: null,
        buildTestResultRef: null,
        evidencePackRef: null,
        ...overrides,
      };
    }

    it("converts every pending stage to neutral with the cancellation detail and recovery action", () => {
      // Arrange: a cancelled workflow with no build/test or evidence data.
      // The verification-repair stage is special: the repair-stage logic at
      // lines ~1225-1251 sets it to "neutral" directly (via the inner
      // finalClassification === "cancelled" branch) BEFORE the cancellation
      // pass runs, so it ends up with a repair-specific detail rather than
      // the cancellation pass detail. Every other stage stays "pending" until
      // the cancellation pass converts it.
      const stages = buildTimelineStages(
        makeRunState({
          workflow: makeCancelledWorkflow(),
        }),
      );

      // No stage should remain "pending" after the cancellation pass.
      const pendingAfterCancel = stages.filter(
        (stage) => stage.status === "pending",
      );
      expect(pendingAfterCancel).toHaveLength(0);

      // The stages converted by the cancellation pass (i.e., NOT
      // verification-repair) must carry the exact cancellation strings.
      // verification-repair is set to neutral by the inner repair-stage
      // branch and is excluded here because it is no longer "pending" when
      // the cancellation pass iterates.
      const cancelPassStages = stages.filter(
        (stage) =>
          stage.status === "neutral" && stage.id !== "verification-repair",
      );
      expect(cancelPassStages.length).toBeGreaterThan(0);

      for (const stage of cancelPassStages) {
        expect(stage.detail).toBe(
          "The run was cancelled before this stage completed.",
        );
        expect(stage.actionLabel).toBe("Rerun the parity workflow");
      }
    });

    it("sets the cancelled cancellation detail on every stage that had not already resolved", () => {
      // Pin the exact strings so a mutation of either literal in the
      // implementation is caught by this test.
      const stages = buildTimelineStages(
        makeRunState({ workflow: makeCancelledWorkflow() }),
      );

      const transform = stages.find((stage) => stage.id === "transform");
      expect(transform?.status).toBe("neutral");
      expect(transform?.detail).toBe(
        "The run was cancelled before this stage completed.",
      );
      expect(transform?.actionLabel).toBe("Rerun the parity workflow");

      const parity = stages.find((stage) => stage.id === "parity-comparison");
      expect(parity?.status).toBe("neutral");
      expect(parity?.detail).toBe(
        "The run was cancelled before this stage completed.",
      );
      expect(parity?.actionLabel).toBe("Rerun the parity workflow");
    });

    it("resolves the verification-repair stage to neutral when cancelled with no repair attempts", () => {
      // This path is governed by the inner cancelled branch at lines ~1235-1237:
      // repairAttemptCount === 0 AND finalClassification === "cancelled" AND
      // activeAgent is not "verification_repair_agent".
      const stages = buildTimelineStages(
        makeRunState({
          workflow: makeCancelledWorkflow({
            repairAttempts: [],
            activeAgent: null,
          }),
        }),
      );

      const repair = stages.find((stage) => stage.id === "verification-repair");
      expect(repair).toBeDefined();
      expect(repair?.status).toBe("neutral");
    });

    it("does NOT convert pending stages to neutral when finalClassification is not cancelled (mutation control)", () => {
      // Control assertion: the exact same run state with finalClassification
      // set to a non-cancelled value must leave pending stages as "pending".
      // This test fails if the "cancelled" literal on line ~1273 is mutated
      // to any other value (e.g. "failed", null, or removed entirely).
      const stages = buildTimelineStages(
        makeRunState({
          workflow: makeCancelledWorkflow({
            finalClassification: "failed",
          }),
        }),
      );

      // With finalClassification !== "cancelled" and no build/test data to
      // resolve them, the stages must remain pending.
      const pendingStages = stages.filter(
        (stage) => stage.status === "pending",
      );
      expect(pendingStages.length).toBeGreaterThan(0);

      // Crucially, none should carry the cancellation strings.
      for (const stage of stages) {
        expect(stage.detail).not.toBe(
          "The run was cancelled before this stage completed.",
        );
        expect(stage.actionLabel).not.toBe("Rerun the parity workflow");
      }
    });

    it("does NOT convert pending stages to neutral when workflow is null (mutation control)", () => {
      // Control: no workflow at all — no cancellation pass should run.
      const stages = buildTimelineStages(makeRunState({ workflow: null }));

      const neutralWithCancelDetail = stages.filter(
        (stage) =>
          stage.status === "neutral" &&
          stage.detail === "The run was cancelled before this stage completed.",
      );
      expect(neutralWithCancelDetail).toHaveLength(0);
    });
  });
});
