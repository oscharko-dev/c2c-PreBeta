package com.c2c.w0.buildtest;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class ParityComparison {

    record ExecutionFact(
            String status,
            Integer exitCode,
            String stdout,
            String stderr,
            Map<String, Object> stdoutRef,
            Map<String, Object> stderrRef,
            Map<String, Object> normalizedStdoutRef,
            Map<String, Object> normalizedStderrRef,
            String surfaceLabel
    ) {
    }

    private ParityComparison() {
    }

    static Map<String, Object> compare(
            String runId,
            String workflowId,
            ExecutionFact source,
            ExecutionFact target) {
        Instant now = Instant.now();
        String sourceStdout = source.stdout() == null ? "" : source.stdout();
        String targetStdout = target.stdout() == null ? "" : target.stdout();
        String sourceStderr = source.stderr() == null ? "" : source.stderr();
        String targetStderr = target.stderr() == null ? "" : target.stderr();

        String normalizedSourceStdout = DeterministicComparisonPolicy.normalize(sourceStdout);
        String normalizedTargetStdout = DeterministicComparisonPolicy.normalize(targetStdout);
        String normalizedSourceStderr = DeterministicComparisonPolicy.normalize(sourceStderr);
        String normalizedTargetStderr = DeterministicComparisonPolicy.normalize(targetStderr);

        String status = "passed";
        String mismatch = "none";
        String diffSummary = "Reference/source and generated Java outputs matched under "
                + DeterministicComparisonPolicy.VERSION + ".";

        if (!isPassed(source.status()) || !isPassed(target.status())) {
            status = "failed";
            mismatch = "unknown";
            diffSummary = "Comparison could not prove parity because at least one execution surface did not finish successfully.";
        } else if (!sameExitCode(source.exitCode(), target.exitCode())) {
            status = "failed";
            mismatch = "policy";
            diffSummary = "Exit codes differ between the reference/source and generated Java executions.";
        } else if (!normalizedSourceStderr.equals(normalizedTargetStderr)) {
            status = "failed";
            mismatch = "content";
            diffSummary = "Normalized stderr differs between the reference/source and generated Java executions.";
        } else if (!normalizedSourceStdout.equals(normalizedTargetStdout)) {
            status = "failed";
            mismatch = classifyStdoutMismatch(sourceStdout, targetStdout);
            diffSummary = buildStdoutDiffSummary(normalizedSourceStdout, normalizedTargetStdout, mismatch);
        }

        Map<String, Object> diffPayload = new LinkedHashMap<>();
        diffPayload.put("schemaVersion", BuildTestRunnerService.SCHEMA_VERSION);
        diffPayload.put("comparisonPolicyVersion", DeterministicComparisonPolicy.VERSION);
        diffPayload.put("mismatchClassification", mismatch);
        diffPayload.put("sourceSurface", source.surfaceLabel());
        diffPayload.put("targetSurface", target.surfaceLabel());
        diffPayload.put("sourceExitCode", source.exitCode());
        diffPayload.put("targetExitCode", target.exitCode());
        diffPayload.put("sourceStdout", normalizedSourceStdout);
        diffPayload.put("targetStdout", normalizedTargetStdout);
        diffPayload.put("sourceStderr", normalizedSourceStderr);
        diffPayload.put("targetStderr", normalizedTargetStderr);
        Map<String, Object> diffRef = BuildTestRunnerService.reference(
                "parity-comparison-diff",
                "parity-comparison-diff",
                diffPayload);

        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("schemaVersion", BuildTestRunnerService.SCHEMA_VERSION);
        comparison.put("comparisonId", "parity-comparison-" + UUID.randomUUID());
        comparison.put("runId", runId);
        if (workflowId != null && !workflowId.isBlank()) {
            comparison.put("workflowId", workflowId);
        }
        comparison.put("status", status);
        comparison.put("matched", "passed".equals(status));
        comparison.put("comparisonPolicyVersion", DeterministicComparisonPolicy.VERSION);
        comparison.put("comparisonPolicyRef", DeterministicComparisonPolicy.toRef());
        comparison.put("sourceStdoutRef", source.stdoutRef());
        comparison.put("sourceStderrRef", source.stderrRef());
        comparison.put("targetStdoutRef", target.stdoutRef());
        comparison.put("targetStderrRef", target.stderrRef());
        comparison.put("sourceExitCode", source.exitCode());
        comparison.put("targetExitCode", target.exitCode());
        comparison.put("sourceNormalizedRef", source.normalizedStdoutRef());
        comparison.put("sourceNormalizedStderrRef", source.normalizedStderrRef());
        comparison.put("targetNormalizedRef", target.normalizedStdoutRef());
        comparison.put("targetNormalizedStderrRef", target.normalizedStderrRef());
        comparison.put("sourceOutputRef", source.stdoutRef());
        comparison.put("javaOutputRef", target.stdoutRef());
        comparison.put("sourceNormalizedOutputRef", source.normalizedStdoutRef());
        comparison.put("javaNormalizedOutputRef", target.normalizedStdoutRef());
        comparison.put("diffRef", diffRef);
        comparison.put("normalizedDiffRef", diffRef);
        comparison.put("diffSummary", diffSummary);
        comparison.put("mismatchClassification", mismatch);
        comparison.put("startedAt", now.toString());
        comparison.put("completedAt", now.toString());
        comparison.put("createdAt", now.toString());
        comparison.put("evidenceRefs", BuildTestRunnerService.evidenceRefs(
                source.stdoutRef(),
                source.stderrRef(),
                target.stdoutRef(),
                target.stderrRef(),
                source.normalizedStdoutRef(),
                source.normalizedStderrRef(),
                target.normalizedStdoutRef(),
                target.normalizedStderrRef(),
                diffRef,
                DeterministicComparisonPolicy.toRef()));
        comparison.put("outputRef", BuildTestRunnerService.reference(
                "parity-comparison-result",
                "parity-comparison-result",
                comparison));
        return comparison;
    }

    static Map<String, Object> unsupported(
            String runId,
            String workflowId,
            ExecutionFact source,
            ExecutionFact target,
            String reason) {
        return blockedOrFailed(runId, workflowId, source, target, "blocked", "unknown", reason);
    }

    static Map<String, Object> runtimeFailure(
            String runId,
            String workflowId,
            ExecutionFact source,
            ExecutionFact target,
            String reason) {
        return blockedOrFailed(runId, workflowId, source, target, "failed", "unknown", reason);
    }

    private static Map<String, Object> blockedOrFailed(
            String runId,
            String workflowId,
            ExecutionFact source,
            ExecutionFact target,
            String status,
            String mismatch,
            String reason) {
        Instant now = Instant.now();
        Map<String, Object> diffPayload = new LinkedHashMap<>();
        diffPayload.put("schemaVersion", BuildTestRunnerService.SCHEMA_VERSION);
        diffPayload.put("comparisonPolicyVersion", DeterministicComparisonPolicy.VERSION);
        diffPayload.put("mismatchClassification", mismatch);
        diffPayload.put("reason", reason);
        Map<String, Object> diffRef = BuildTestRunnerService.reference(
                "parity-comparison-diff",
                "parity-comparison-diff",
                diffPayload);

        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("schemaVersion", BuildTestRunnerService.SCHEMA_VERSION);
        comparison.put("comparisonId", "parity-comparison-" + UUID.randomUUID());
        comparison.put("runId", runId);
        if (workflowId != null && !workflowId.isBlank()) {
            comparison.put("workflowId", workflowId);
        }
        comparison.put("status", status);
        comparison.put("matched", false);
        comparison.put("comparisonPolicyVersion", DeterministicComparisonPolicy.VERSION);
        comparison.put("comparisonPolicyRef", DeterministicComparisonPolicy.toRef());
        if (source != null) {
            comparison.put("sourceStdoutRef", source.stdoutRef());
            comparison.put("sourceStderrRef", source.stderrRef());
            comparison.put("sourceExitCode", source.exitCode());
            comparison.put("sourceNormalizedRef", source.normalizedStdoutRef());
            comparison.put("sourceNormalizedStderrRef", source.normalizedStderrRef());
            comparison.put("sourceOutputRef", source.stdoutRef());
            comparison.put("sourceNormalizedOutputRef", source.normalizedStdoutRef());
        }
        if (target != null) {
            comparison.put("targetStdoutRef", target.stdoutRef());
            comparison.put("targetStderrRef", target.stderrRef());
            comparison.put("targetExitCode", target.exitCode());
            comparison.put("targetNormalizedRef", target.normalizedStdoutRef());
            comparison.put("targetNormalizedStderrRef", target.normalizedStderrRef());
            comparison.put("javaOutputRef", target.stdoutRef());
            comparison.put("javaNormalizedOutputRef", target.normalizedStdoutRef());
        }
        if (source != null) {
            comparison.put("sourceOutputRef", source.stdoutRef());
        }
        if (target != null) {
            comparison.put("javaOutputRef", target.stdoutRef());
        }
        comparison.put("diffRef", diffRef);
        comparison.put("normalizedDiffRef", diffRef);
        comparison.put("diffSummary", reason);
        comparison.put("mismatchClassification", mismatch);
        comparison.put("startedAt", now.toString());
        comparison.put("completedAt", now.toString());
        comparison.put("createdAt", now.toString());
        comparison.put("evidenceRefs", BuildTestRunnerService.evidenceRefs(
                source == null ? null : source.stdoutRef(),
                source == null ? null : source.stderrRef(),
                source == null ? null : source.normalizedStdoutRef(),
                source == null ? null : source.normalizedStderrRef(),
                target == null ? null : target.stdoutRef(),
                target == null ? null : target.stderrRef(),
                target == null ? null : target.normalizedStdoutRef(),
                target == null ? null : target.normalizedStderrRef(),
                diffRef,
                DeterministicComparisonPolicy.toRef()));
        comparison.put("outputRef", BuildTestRunnerService.reference(
                "parity-comparison-result",
                "parity-comparison-result",
                comparison));
        return comparison;
    }

    private static boolean isPassed(String status) {
        return "passed".equalsIgnoreCase(status);
    }

    private static boolean sameExitCode(Integer left, Integer right) {
        if (left == null) {
            return right != null && right.intValue() == 0;
        }
        if (right == null) {
            return false;
        }
        return left.intValue() == right.intValue();
    }

    private static String classifyStdoutMismatch(String sourceStdout, String targetStdout) {
        String lineOnlyLeft = DeterministicComparisonPolicy.normalizeLineEndingsOnly(sourceStdout);
        String lineOnlyRight = DeterministicComparisonPolicy.normalizeLineEndingsOnly(targetStdout);
        if (lineOnlyLeft.equals(lineOnlyRight)) {
            return "line_endings";
        }
        String whitespaceOnlyLeft = DeterministicComparisonPolicy.stripTrailingWhitespaceOnly(sourceStdout);
        String whitespaceOnlyRight = DeterministicComparisonPolicy.stripTrailingWhitespaceOnly(targetStdout);
        if (whitespaceOnlyLeft.equals(whitespaceOnlyRight)) {
            return "formatting";
        }
        return "content";
    }

    private static String buildStdoutDiffSummary(String source, String target, String mismatch) {
        int divergence = firstDivergenceIndex(source, target);
        return "Normalized stdout mismatch (" + mismatch + ") at character " + divergence
                + "; sourceLength=" + source.length()
                + " targetLength=" + target.length() + ".";
    }

    private static int firstDivergenceIndex(String left, String right) {
        int max = Math.min(left.length(), right.length());
        for (int i = 0; i < max; i++) {
            if (left.charAt(i) != right.charAt(i)) {
                return i;
            }
        }
        return max;
    }
}
