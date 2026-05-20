package com.c2c.w0.buildtest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

final class SourceReferenceExecutionService {

    static final String CAPABILITY = "source-reference.execute";
    static final String EXECUTION_SURFACE = "source-reference";
    static final String MODE_REFERENCE_FIXTURE = "reference-fixture";
    static final String MODE_NATIVE_COBOL = "native-cobol";
    private static final long DEFAULT_TIMEOUT_MS = 5000L;

    private final Path repoRoot;
    private final AcceptanceFixtureRegistry fixtureRegistry;

    SourceReferenceExecutionService(Path repoRoot) {
        this.repoRoot = repoRoot;
        this.fixtureRegistry = new AcceptanceFixtureRegistry(repoRoot);
    }

    Map<String, Object> execute(Map<String, Object> request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        String runId = text(request.get("runId"));
        if (runId == null) {
            throw new IllegalArgumentException("request.runId is required");
        }
        String fixtureId = text(request.get("fixtureId"));
        if (fixtureId == null) {
            throw new IllegalArgumentException("request.fixtureId is required");
        }
        String referenceMode = text(request.get("referenceMode"));
        if (!MODE_REFERENCE_FIXTURE.equals(referenceMode) && !MODE_NATIVE_COBOL.equals(referenceMode)) {
            throw new IllegalArgumentException("request.referenceMode must be reference-fixture or native-cobol");
        }
        long timeoutMs = clampTimeout(longValue(request.get("timeoutMs"), DEFAULT_TIMEOUT_MS));
        String executionId = Optional.ofNullable(text(request.get("executionId")))
                .orElse("source-ref-" + UUID.randomUUID());
        String workflowId = text(request.get("workflowId"));
        Instant started = Instant.now();

        Optional<AcceptanceFixtureRegistry.AcceptanceFixture> fixture = fixtureRegistry.resolve(fixtureId);
        if (fixture.isEmpty()) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    referenceMode,
                    fixtureId,
                    "missing-fixture",
                    "Acceptance fixture " + fixtureId + " was not found in fixtures/acceptance/index.json.",
                    started,
                    null,
                    null);
        }

        AcceptanceFixtureRegistry.AcceptanceFixture resolved = fixture.get();
        if ("blocked".equals(resolved.expectedFinalClassification())) {
            String message = resolved.unsupportedConstructs().isEmpty()
                    ? "Acceptance fixture " + fixtureId + " is intentionally outside the supported COBOL slice."
                    : unsupportedSummary(resolved);
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    referenceMode,
                    fixtureId,
                    "unsupported-program-shape",
                    message,
                    started,
                    resolved.sourceCobolArtifactRef().toMap(),
                    resolved.expectedOutputArtifactRef() == null ? null : resolved.expectedOutputArtifactRef().toMap());
        }

        if (MODE_REFERENCE_FIXTURE.equals(referenceMode)) {
            return executeReferenceFixture(executionId, runId, workflowId, resolved, started);
        }
        return executeNativeCobol(executionId, runId, workflowId, resolved, timeoutMs, started);
    }

    private Map<String, Object> executeReferenceFixture(
            String executionId,
            String runId,
            String workflowId,
            AcceptanceFixtureRegistry.AcceptanceFixture fixture,
            Instant started
    ) {
        AcceptanceFixtureRegistry.ArtifactReference expectedRef = fixture.expectedOutputArtifactRef();
        if (expectedRef == null) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_REFERENCE_FIXTURE,
                    fixture.fixtureId(),
                    "missing-reference-fixture",
                    "Acceptance fixture " + fixture.fixtureId()
                            + " does not declare an expectedOutputArtifactRef for reference-fixture mode.",
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    null);
        }
        Path expectedPath;
        try {
            expectedPath = expectedRef.resolve(repoRoot);
        } catch (IllegalArgumentException e) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_REFERENCE_FIXTURE,
                    fixture.fixtureId(),
                    "unsafe-reference-fixture",
                    e.getMessage(),
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    expectedRef.toMap());
        }
        if (!Files.isRegularFile(expectedPath)) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_REFERENCE_FIXTURE,
                    fixture.fixtureId(),
                    "missing-reference-fixture",
                    "Reference fixture " + expectedRef.path() + " is missing.",
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    expectedRef.toMap());
        }
        try {
            String output = Files.readString(expectedPath, StandardCharsets.UTF_8);
            if (!expectedRef.sha256().equalsIgnoreCase(HashUtil.sha256(output))
                    || expectedRef.byteSize() != HashUtil.byteLength(output)) {
                return failedResult(
                        executionId,
                        runId,
                        workflowId,
                        MODE_REFERENCE_FIXTURE,
                        fixture.fixtureId(),
                        "reference-fixture-integrity-mismatch",
                        "Reference fixture " + expectedRef.path()
                                + " does not match the registry sha256/byteSize declaration.",
                        started,
                        fixture.sourceCobolArtifactRef().toMap(),
                        expectedRef.toMap());
            }
            Instant completed = Instant.now();
            return successResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_REFERENCE_FIXTURE,
                    "fixture-read " + expectedRef.path(),
                    fixture.sourceCobolArtifactRef().toMap(),
                    expectedRef.toMap(),
                    output,
                    "",
                    0,
                    false,
                    started,
                    completed,
                    "Resolved repository-owned reference fixture for " + fixture.fixtureId() + ".");
        } catch (IOException e) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_REFERENCE_FIXTURE,
                    fixture.fixtureId(),
                    "reference-fixture-read-failed",
                    "Reference fixture " + expectedRef.path() + " could not be read: " + e.getMessage(),
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    expectedRef.toMap());
        }
    }

    private Map<String, Object> executeNativeCobol(
            String executionId,
            String runId,
            String workflowId,
            AcceptanceFixtureRegistry.AcceptanceFixture fixture,
            long timeoutMs,
            Instant started
    ) {
        if (!"cobol-runtime".equals(fixture.oracleGenerationMode())) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_NATIVE_COBOL,
                    fixture.fixtureId(),
                    "unsupported-reference-mode",
                    "Acceptance fixture " + fixture.fixtureId()
                            + " does not support native-cobol execution; oracleGenerationMode="
                            + fixture.oracleGenerationMode() + ".",
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    null);
        }
        Path sourcePath;
        try {
            sourcePath = fixture.sourceCobolArtifactRef().resolve(repoRoot);
        } catch (IllegalArgumentException e) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_NATIVE_COBOL,
                    fixture.fixtureId(),
                    "unsafe-source-cobol",
                    e.getMessage(),
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    null);
        }
        if (!Files.isRegularFile(sourcePath)) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_NATIVE_COBOL,
                    fixture.fixtureId(),
                    "missing-source-cobol",
                    "COBOL source fixture " + fixture.sourceCobolArtifactRef().path() + " is missing.",
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    null);
        }
        try {
            String sourceText = Files.readString(sourcePath, StandardCharsets.UTF_8);
            CobolRuntimeExecutor.OracleRun run = CobolRuntimeExecutor.executeSource("", sourceText, "", timeoutMs);
            Instant completed = Instant.now();
            Map<String, Object> runtimeRef = BuildTestRunnerService.outputReference("source-reference-output", run.stdout());
            if (!run.attempted()) {
                return failureFromOracle(
                        executionId, runId, workflowId, fixture, run, started, completed,
                        "native-cobol-invalid-request", run.reason(), null);
            }
            if (!run.available()) {
                return failureFromOracle(
                        executionId, runId, workflowId, fixture, run, started, completed,
                        "native-cobol-unavailable",
                        "GnuCOBOL cobc/cobcrun are not available for native-cobol mode.",
                        null);
            }
            if (!run.compileOk()) {
                boolean timedOut = isTimeout(run.reason());
                return failureFromOracle(
                        executionId, runId, workflowId, fixture, run, started, completed,
                        timedOut ? "native-cobol-timeout" : "native-cobol-compile-failed",
                        timedOut
                                ? "native-cobol compile timed out before the approved fixture could run."
                                : "cobc failed while compiling the approved COBOL fixture.",
                        runtimeRef);
            }
            if (!run.runOk()) {
                boolean timedOut = isTimeout(run.reason());
                return failureFromOracle(
                        executionId, runId, workflowId, fixture, run, started, completed,
                        timedOut ? "native-cobol-timeout" : "native-cobol-run-failed",
                        timedOut
                                ? "native-cobol execution timed out before producing a complete result."
                                : "cobcrun did not complete cleanly for the approved COBOL fixture.",
                        runtimeRef);
            }
            return successResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_NATIVE_COBOL,
                    "cobc -m " + fixture.sourceCobolArtifactRef().path() + " && cobcrun <program-id>",
                    fixture.sourceCobolArtifactRef().toMap(),
                    runtimeRef,
                    run.stdout(),
                    run.stderr(),
                    run.exitCode(),
                    false,
                    started,
                    completed,
                    "Executed approved COBOL fixture through GnuCOBOL native-cobol mode.");
        } catch (IOException e) {
            return failedResult(
                    executionId,
                    runId,
                    workflowId,
                    MODE_NATIVE_COBOL,
                    fixture.fixtureId(),
                    "native-cobol-source-read-failed",
                    "COBOL source fixture " + fixture.sourceCobolArtifactRef().path()
                            + " could not be read: " + e.getMessage(),
                    started,
                    fixture.sourceCobolArtifactRef().toMap(),
                    null);
        }
    }

    private Map<String, Object> failureFromOracle(
            String executionId,
            String runId,
            String workflowId,
            AcceptanceFixtureRegistry.AcceptanceFixture fixture,
            CobolRuntimeExecutor.OracleRun run,
            Instant started,
            Instant completed,
            String diagnosticCode,
            String diagnosticMessage,
            Map<String, Object> referenceArtifactRef
    ) {
        String stdout = run.stdout() == null ? "" : run.stdout();
        String stderr = run.stderr() == null ? "" : run.stderr();
        boolean timedOut = isTimeout(run.reason());
        return result(
                executionId,
                runId,
                workflowId,
                MODE_NATIVE_COBOL,
                "cobc -m " + fixture.sourceCobolArtifactRef().path() + " && cobcrun <program-id>",
                timedOut ? "timed_out" : "failed",
                timedOut ? null : run.exitCode(),
                timedOut,
                fixture.sourceCobolArtifactRef().toMap(),
                referenceArtifactRef,
                stdout,
                stderr,
                List.of(diagnostic("error", diagnosticCode, diagnosticMessage + suffix(run.reason()))),
                started,
                completed,
                diagnosticMessage);
    }

    private Map<String, Object> successResult(
            String executionId,
            String runId,
            String workflowId,
            String referenceMode,
            String command,
            Map<String, Object> sourceArtifactRef,
            Map<String, Object> referenceArtifactRef,
            String stdout,
            String stderr,
            Integer exitCode,
            boolean timedOut,
            Instant started,
            Instant completed,
            String summary
    ) {
        return result(
                executionId,
                runId,
                workflowId,
                referenceMode,
                command,
                "passed",
                exitCode,
                timedOut,
                sourceArtifactRef,
                referenceArtifactRef,
                stdout,
                stderr,
                List.of(),
                started,
                completed,
                summary);
    }

    private Map<String, Object> failedResult(
            String executionId,
            String runId,
            String workflowId,
            String referenceMode,
            String fixtureId,
            String diagnosticCode,
            String diagnosticMessage,
            Instant started,
            Map<String, Object> sourceArtifactRef,
            Map<String, Object> referenceArtifactRef
    ) {
        Map<String, Object> payload = result(
                executionId,
                runId,
                workflowId,
                referenceMode,
                "source-reference.execute fixture=" + fixtureId,
                "failed",
                null,
                false,
                sourceArtifactRef,
                referenceArtifactRef,
                "",
                "",
                List.of(diagnostic("error", diagnosticCode, diagnosticMessage)),
                started,
                Instant.now(),
                diagnosticMessage);
        if (!payload.containsKey("inputArtifactRef")) {
            payload.put("inputArtifactRef", fixtureRequestRef(fixtureId));
        }
        return payload;
    }

    private Map<String, Object> result(
            String executionId,
            String runId,
            String workflowId,
            String referenceMode,
            String command,
            String status,
            Integer exitCode,
            boolean timedOut,
            Map<String, Object> sourceArtifactRef,
            Map<String, Object> referenceArtifactRef,
            String stdout,
            String stderr,
            List<Map<String, Object>> diagnostics,
            Instant started,
            Instant completed,
            String summary
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schemaVersion", "v0");
        payload.put("executionId", executionId);
        payload.put("runId", runId);
        if (workflowId != null) {
            payload.put("workflowId", workflowId);
        }
        payload.put("executionSurface", EXECUTION_SURFACE);
        payload.put("referenceMode", referenceMode);
        payload.put("command", command);
        payload.put("status", status);
        payload.put("exitCode", exitCode);
        payload.put("timedOut", timedOut);
        payload.put("stdoutRef", BuildTestRunnerService.outputReference("source-reference-stdout", stdout));
        payload.put("stderrRef", BuildTestRunnerService.outputReference("source-reference-stderr", stderr));
        payload.put("normalizedOutputRef",
                BuildTestRunnerService.outputReference("source-reference-normalized-output", normalize(stdout)));
        if (sourceArtifactRef != null) {
            payload.put("sourceArtifactRef", sourceArtifactRef);
            payload.put("inputArtifactRef", sourceArtifactRef);
        }
        if (referenceArtifactRef != null) {
            payload.put("referenceArtifactRef", referenceArtifactRef);
        }
        payload.put("diagnostics", new ArrayList<>(diagnostics));
        payload.put("startedAt", started.toString());
        payload.put("completedAt", completed.toString());
        payload.put("createdAt", completed.toString());
        payload.put("summary", summary);
        payload.put("outputRef", BuildTestRunnerService.reference(
                "parity-execution-result",
                "parity-execution-result",
                payload));
        return payload;
    }

    private static Map<String, Object> fixtureRequestRef(String fixtureId) {
        return BuildTestRunnerService.outputReference(
                "source-reference-fixture-request",
                fixtureId == null ? "" : fixtureId);
    }

    private static Map<String, Object> diagnostic(String severity, String code, String message) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("severity", severity);
        payload.put("code", code);
        payload.put("message", message);
        return payload;
    }

    private static String unsupportedSummary(AcceptanceFixtureRegistry.AcceptanceFixture fixture) {
        return fixture.unsupportedConstructs().stream()
                .map(entry -> entry.get("construct") instanceof String construct && !construct.isBlank()
                        ? construct
                        : String.valueOf(entry.getOrDefault("code", "unsupported")))
                .reduce((left, right) -> left + ", " + right)
                .map(summary -> "Acceptance fixture " + fixture.fixtureId()
                        + " is outside the supported COBOL slice: " + summary + ".")
                .orElse("Acceptance fixture " + fixture.fixtureId()
                        + " is outside the supported COBOL slice.");
    }

    private static long clampTimeout(long timeoutMs) {
        return Math.max(100L, Math.min(timeoutMs, 30000L));
    }

    private static long longValue(Object raw, long fallback) {
        return raw instanceof Number number ? number.longValue() : fallback;
    }

    private static String text(Object raw) {
        return raw instanceof String text && !text.isBlank() ? text.trim() : null;
    }

    private static String normalize(String value) {
        return DeterministicComparisonPolicy.normalize(value);
    }

    private static boolean isTimeout(String reason) {
        return reason != null && reason.toLowerCase().contains("timeout");
    }

    private static String suffix(String reason) {
        if (reason == null || reason.isBlank()) {
            return "";
        }
        return " (" + reason + ")";
    }
}
