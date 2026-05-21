import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOutputChangeExplanation,
  type OutputChangeRunArtifacts,
} from "./outputChangeExplanation";

function outputRef(sha: string) {
  return { sha256: sha };
}

function runArtifacts(
  overrides: Partial<OutputChangeRunArtifacts> = {},
): OutputChangeRunArtifacts {
  return {
    runId: "run-current",
    programId: "BRNCH01",
    status: "completed",
    executionMode: "parity",
    trustCaseId: "HELLO01-DEFAULT",
    trustCaseConfigurationDigest: "digest-v1",
    trustCaseEnvironmentProfileId: "env-v1",
    trustCaseComparisonPolicyVersion: "deterministic-output-v1",
    sourceReferenceFixtureId: "HELLOW02",
    sourceReferenceMode: "reference-fixture",
    trustSummary: {
      trustCase: {
        trustCaseId: "HELLO01-DEFAULT",
        configurationDigest: "digest-v1",
      },
      cobolResult: { normalizedOutputRef: outputRef("a".repeat(64)) },
      javaResult: { normalizedOutputRef: outputRef("b".repeat(64)) },
      comparisonResult: {
        diffRef: outputRef("c".repeat(64)),
        comparisonPolicyRef: outputRef("d".repeat(64)),
      },
      repair: {
        repairDecisionRef: outputRef("e".repeat(64)),
      },
    },
    generatedArtifactRef: outputRef("f".repeat(64)),
    sourceHash: "source-hash-v1",
    actualOutput: "RESULT=OLD\n",
    actualOutputRef: outputRef("1".repeat(64)),
    comparisonDiffRef: outputRef("2".repeat(64)),
    evidenceStatus: "complete",
    manualEditsCarriedOver: false,
    manualDriftRegionCount: 0,
    ...overrides,
  };
}

test("buildOutputChangeExplanation classifies a COBOL edit", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    sourceHash: "source-hash-v2",
    actualOutput: "RESULT=NEW\n",
    trustSummary: {
      ...previous.trustSummary,
      javaResult: { normalizedOutputRef: outputRef("3".repeat(64)) },
    },
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "available");
  assert.equal(result.primaryCategory, "cobol_edit");
  assert.equal(result.determination, "single_change");
});

test("buildOutputChangeExplanation classifies a manual Java edit", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    manualEditsCarriedOver: true,
    manualDriftRegionCount: 2,
    actualOutput: "RESULT=MANUAL\n",
    trustSummary: {
      ...previous.trustSummary,
      javaResult: { normalizedOutputRef: outputRef("4".repeat(64)) },
    },
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "available");
  assert.equal(result.primaryCategory, "manual_java_edit");
  assert.equal(result.determination, "single_change");
});

test("buildOutputChangeExplanation classifies a repair patch", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    actualOutput: "RESULT=REPAIRED\n",
    trustSummary: {
      ...previous.trustSummary,
      javaResult: { normalizedOutputRef: outputRef("5".repeat(64)) },
      repair: {
        repairDecisionRef: outputRef("6".repeat(64)),
      },
    },
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "available");
  assert.equal(result.primaryCategory, "repair_patch");
  assert.equal(result.determination, "single_change");
});

test("buildOutputChangeExplanation classifies a trust-case change", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    trustCaseId: "HELLO01-ALT",
    trustCaseConfigurationDigest: "digest-v2",
    actualOutput: "RESULT=TRUST\n",
    trustSummary: {
      ...previous.trustSummary,
      trustCase: {
        trustCaseId: "HELLO01-ALT",
        configurationDigest: "digest-v2",
      },
      javaResult: { normalizedOutputRef: outputRef("7".repeat(64)) },
    },
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "available");
  assert.equal(result.primaryCategory, "trust_case_change");
  assert.equal(result.determination, "single_change");
});

test("buildOutputChangeExplanation classifies a runtime configuration change", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    trustCaseEnvironmentProfileId: "env-v2",
    actualOutput: "RESULT=RUNTIME\n",
    trustSummary: {
      ...previous.trustSummary,
      javaResult: { normalizedOutputRef: outputRef("8".repeat(64)) },
    },
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "available");
  assert.equal(result.primaryCategory, "runtime_configuration_change");
  assert.equal(result.determination, "single_change");
});

test("buildOutputChangeExplanation refuses to speculate when evidence is incomplete", () => {
  const previous = runArtifacts({ runId: "run-previous" });
  const current = runArtifacts({
    evidenceStatus: "incomplete",
    actualOutput: "RESULT=UNKNOWN\n",
  });

  const result = buildOutputChangeExplanation(current, previous);

  assert.equal(result.status, "unavailable");
  assert.equal(result.unavailableReason, "evidence_incomplete");
  assert.equal(result.primaryCategory, null);
});

