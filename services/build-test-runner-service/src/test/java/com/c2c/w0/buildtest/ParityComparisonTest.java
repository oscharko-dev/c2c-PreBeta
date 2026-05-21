package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ParityComparisonTest {

    @Test
    void equivalentOutputIgnoresLineEndingsAndTrailingWhitespace() {
        Map<String, Object> result = ParityComparison.compare(
                "run-equal",
                "wf-equal",
                fact("passed", 0, "PASS \r\n", "", "reference"),
                fact("passed", 0, "PASS\n\n", "", "generated-java"));

        assertEquals("passed", result.get("status"));
        assertEquals(true, result.get("matched"));
        assertEquals("none", result.get("mismatchClassification"));
        assertNotNull(result.get("sourceOutputRef"));
        assertNotNull(result.get("javaOutputRef"));
        assertNotNull(result.get("diffRef"));
        assertNotNull(result.get("normalizedDiffRef"));
        assertEquals(DeterministicComparisonPolicy.VERSION, result.get("comparisonPolicyVersion"));
    }

    @Test
    void mismatchedExitCodeIsClassifiedDeterministically() {
        Map<String, Object> result = ParityComparison.compare(
                "run-exit",
                "wf-exit",
                fact("passed", 0, "PASS\n", "", "reference"),
                fact("passed", 12, "PASS\n", "", "generated-java"));

        assertEquals("failed", result.get("status"));
        assertEquals("policy", result.get("mismatchClassification"));
    }

    @Test
    void runtimeFailureProducesRuntimeFailureClassification() {
        Map<String, Object> result = ParityComparison.compare(
                "run-runtime",
                "wf-runtime",
                fact("passed", 0, "PASS\n", "", "reference"),
                fact("failed", 1, "", "boom", "generated-java"));

        assertEquals("failed", result.get("status"));
        assertEquals("unknown", result.get("mismatchClassification"));
    }

    @Test
    void unsupportedComparisonInputProducesBlockedResult() {
        Map<String, Object> result = ParityComparison.unsupported(
                "run-unsupported",
                "wf-unsupported",
                null,
                fact("skipped", null, "", "", "generated-java"),
                "missing-golden-master");

        assertEquals("blocked", result.get("status"));
        assertEquals("unknown", result.get("mismatchClassification"));
    }

    @Test
    void runtimeFailureReasonIsBoundedAtSchemaCeiling() {
        String oversizeReason = "x".repeat(DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH + 500);
        Map<String, Object> result = ParityComparison.runtimeFailure(
                "run-oversize",
                "wf-oversize",
                fact("passed", 0, "", "", "reference"),
                fact("failed", 1, "", "boom", "generated-java"),
                oversizeReason);

        Object diffSummary = result.get("diffSummary");
        assertTrue(diffSummary instanceof String,
                () -> "expected diffSummary to be a String, got: " + diffSummary);
        String bounded = (String) diffSummary;
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH,
                () -> "expected diffSummary <= " + DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(bounded.endsWith(DiagnosticBounds.MESSAGE_TRUNCATION_SENTINEL),
                () -> "expected truncation sentinel suffix, got tail: "
                        + bounded.substring(Math.max(0, bounded.length() - 20)));
    }

    @Test
    void unsupportedReasonIsBoundedAtSchemaCeiling() {
        String oversizeReason = "y".repeat(DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH + 100);
        Map<String, Object> result = ParityComparison.unsupported(
                "run-oversize-unsupported",
                "wf-oversize-unsupported",
                null,
                fact("skipped", null, "", "", "generated-java"),
                oversizeReason);

        String bounded = (String) result.get("diffSummary");
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH,
                () -> "expected diffSummary <= " + DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(bounded.endsWith(DiagnosticBounds.MESSAGE_TRUNCATION_SENTINEL),
                () -> "expected truncation sentinel suffix");
    }

    private static ParityComparison.ExecutionFact fact(
            String status,
            Integer exitCode,
            String stdout,
            String stderr,
            String surfaceLabel) {
        return new ParityComparison.ExecutionFact(
                status,
                exitCode,
                stdout,
                stderr,
                BuildTestRunnerService.outputReference(surfaceLabel + "-stdout", stdout),
                BuildTestRunnerService.outputReference(surfaceLabel + "-stderr", stderr),
                BuildTestRunnerService.outputReference(surfaceLabel + "-normalized", DeterministicComparisonPolicy.normalize(stdout)),
                BuildTestRunnerService.outputReference(surfaceLabel + "-stderr-normalized", DeterministicComparisonPolicy.normalize(stderr)),
                surfaceLabel);
    }
}
