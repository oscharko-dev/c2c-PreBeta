package com.c2c.w0.buildtest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Orchestrates the verification pipeline:
 * <ol>
 *   <li>Unwrap {@code generationResponse} → {@code generatedProject}.</li>
 *   <li>Materialise the project to a temp directory and compile in-memory.</li>
 *   <li>Run the entry class with stdout/stderr capture and a wall-clock
 *       timeout.</li>
 *   <li>Resolve the Golden Master fixture and compare against captured
 *       stdout, classifying the outcome.</li>
 *   <li>Build a hash-stamped {@code BuildTestResult} envelope.</li>
 * </ol>
 * <p>
 * Every step appends structured diagnostics to the response so the same
 * record can serve both human review and Evidence Pack v0 ingestion. Callers
 * should not depend on the absolute order of diagnostics other than: build
 * diagnostics precede execution diagnostics, which precede comparison
 * diagnostics.
 */
public final class BuildTestRunnerService {

    public static final String SCHEMA_VERSION = "v0";
    public static final String CAPABILITY = "build-test.run";
    public static final String SOURCE_REFERENCE_CAPABILITY = "source-reference.execute";
    public static final String SERVICE_NAME = "build-test-runner-service";
    private static final List<String> GENERATED_JAVA_FORBIDDEN_TOKENS = List.of(
            "Runtime.getRuntime",
            "ProcessBuilder",
            "System.exit",
            "System.getenv",
            "System.setProperty",
            "System.setOut",
            "System.setErr",
            "java.nio.file.",
            "java.io.",
            "java.net.",
            "javax.script.",
            "java.lang.reflect.",
            "ClassLoader",
            "sun.misc.Unsafe",
            "jdk.internal."
    );

    private final Path repoRoot;

    public BuildTestRunnerService() {
        this(detectRepoRoot());
    }

    public BuildTestRunnerService(Path repoRoot) {
        this.repoRoot = repoRoot;
    }

    public Map<String, Object> runVerification(Map<String, Object> request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        String programId = string(request.get("programId"), null);
        if (programId == null) {
            throw new IllegalArgumentException("request.programId is required");
        }

        Map<String, Object> generatedProject = extractGeneratedProject(request);
        Map<String, Object> options = mapOrEmpty(request.get("options"));
        boolean skipExecution = booleanFlag(options.get("skipExecution"), false);
        boolean compareOutput = booleanFlag(options.get("compareOutput"), true);
        long timeoutMs = clampTimeout(longValue(options.get("timeoutMs"), 5000L));
        Map<String, Object> oracleSpec = mapOrEmpty(request.get("oracle"));
        boolean oracleEnabled = isCobolRuntimeOracle(oracleSpec);
        long oracleTimeoutMs = clampTimeout(longValue(oracleSpec.get("timeoutMs"), timeoutMs));

        Map<String, Object> response = newEnvelope(request, programId);
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        Map<String, Object> sourceArtifactRef = sourceArtifactRef(request);
        Map<String, Object> generatedArtifactRef = generatedArtifactRef(request, generatedProject);
        Map<String, Object> executionInputRef = controlledInputRef(sourceArtifactRef, generatedArtifactRef, oracleSpec);
        response.put("generatedArtifactRef", generatedArtifactRef);
        if (!sourceArtifactRef.isEmpty()) {
            response.put("sourceArtifactRef", sourceArtifactRef);
        }
        if (!executionInputRef.isEmpty()) {
            response.put("inputArtifactRef", executionInputRef);
        }

        if (generatedProject.isEmpty()) {
            applyClassification(response, ResultClassifier.classification(
                    ResultClassifier.STATUS_SKIPPED, ResultClassifier.CLASS_SKIPPED,
                    "No generatedProject payload supplied; nothing to verify."));
            response.put("diagnostics", diagnostics);
            Map<String, Object> build = emptyBuild(response, generatedArtifactRef);
            Map<String, Object> execution = emptyExecution(response, generatedArtifactRef, executionInputRef, sourceArtifactRef);
            response.put("build", build);
            response.put("buildResult", canonicalBuildResult(build));
            response.put("execution", execution);
            response.put("executionResult", canonicalExecutionResult(execution));
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        Map<String, String> files = stringMap(generatedProject.get("files"));
        String entryClass = string(generatedProject.get("entryClass"), null);
        String entryFilePath = string(generatedProject.get("entryFilePath"), null);

        List<Map<String, Object>> safetyDiagnostics = generatedJavaSafetyDiagnostics(files);
        if (!safetyDiagnostics.isEmpty()) {
            applyClassification(response, ResultClassifier.compileFailure());
            diagnostics.addAll(safetyDiagnostics);
            Map<String, Object> build = failedBuild(response, generatedArtifactRef, diagnostics,
                    "Generated Java contains APIs that are not allowed in the build/test sandbox.");
            Map<String, Object> execution = emptyExecution(response, generatedArtifactRef, executionInputRef, sourceArtifactRef);
            response.put("build", build);
            response.put("buildResult", canonicalBuildResult(build));
            response.put("execution", execution);
            response.put("executionResult", canonicalExecutionResult(execution));
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "generated-java-policy-denied"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        GeneratedProjectMaterializer.MaterializedProject materialised;
        try {
            materialised = GeneratedProjectMaterializer.materialise(files);
        } catch (IllegalArgumentException e) {
            applyClassification(response, ResultClassifier.compileFailure());
            Map<String, Object> buildDiagnostic = diagnostic(
                    "error",
                    "materialise-failed",
                    entryFilePath == null ? "generated-project" : entryFilePath,
                    1L,
                    1L,
                    e.getMessage());
            diagnostics.add(buildDiagnostic);
            Map<String, Object> build = failedBuild(response, generatedArtifactRef, diagnostics,
                    "Generated project could not be materialised safely.");
            Map<String, Object> execution = emptyExecution(response, generatedArtifactRef, executionInputRef, sourceArtifactRef);
            response.put("build", build);
            response.put("buildResult", canonicalBuildResult(build));
            response.put("execution", execution);
            response.put("executionResult", canonicalExecutionResult(execution));
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        } catch (IOException e) {
            applyClassification(response, ResultClassifier.compileFailure());
            Map<String, Object> buildDiagnostic = diagnostic("error", "materialise-io",
                    entryFilePath == null ? "generated-project" : entryFilePath,
                    1L,
                    1L,
                    "Failed to write generated project to a temp directory: " + e.getMessage());
            diagnostics.add(buildDiagnostic);
            Map<String, Object> build = failedBuild(response, generatedArtifactRef, diagnostics,
                    "Generated project could not be written to the controlled work directory.");
            Map<String, Object> execution = emptyExecution(response, generatedArtifactRef, executionInputRef, sourceArtifactRef);
            response.put("build", build);
            response.put("buildResult", canonicalBuildResult(build));
            response.put("execution", execution);
            response.put("executionResult", canonicalExecutionResult(execution));
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        try (materialised) {
            Path classOut = materialised.root().resolve("target/classes");
            Instant buildStarted = Instant.now();

            // -- Compile -----------------------------------------------------
            JavaInMemoryCompiler.CompileResult compile =
                    JavaInMemoryCompiler.compile(materialised, classOut);
            Map<String, Object> buildSection = buildSection(
                    response,
                    generatedArtifactRef,
                    compile,
                    files.size(),
                    buildStarted,
                    Instant.now(),
                    classOut);
            response.put("build", buildSection);
            response.put("buildResult", canonicalBuildResult(buildSection));
            diagnostics.addAll(compile.diagnostics());

            if (!compile.ok()) {
                applyClassification(response, ResultClassifier.compileFailure());
                Map<String, Object> execution = emptyExecution(response, generatedArtifactRef, executionInputRef, sourceArtifactRef);
                response.put("execution", execution);
                response.put("executionResult", canonicalExecutionResult(execution));
                response.put("tests", emptyTests());
                if (oracleEnabled) {
                    response.put("oracle", oracleSkippedMap(oracleSpec,
                            "java-compile-failed; oracle not executed"));
                    response.put("goldenMaster", Map.of(
                            "resolved", false,
                            "source", "oracle.cobol-runtime",
                            "note", "Java compile failed before the oracle could be executed."));
                } else {
                    attachGoldenMaster(response, programId, request);
                }
                response.put("comparison", Map.of(
                        "matched", false,
                        "skipped", true,
                        "reason", "compile-failed"));
                response.put("diagnostics", diagnostics);
                attachComparisonResult(response);
                response.put("outputRef", reference(response));
                return response;
            }

            // -- Execute -----------------------------------------------------
            GeneratedProgramRunner.RunResult run;
            if (skipExecution) {
                run = null;
                Map<String, Object> execution = skippedExecutionSection(
                        response,
                        generatedArtifactRef,
                        executionInputRef,
                        sourceArtifactRef,
                        entryClass,
                        "options.skipExecution=true");
                response.put("execution", execution);
                response.put("executionResult", canonicalExecutionResult(execution));
            } else {
                Instant executionStarted = Instant.now();
                run = GeneratedProgramRunner.run(classOut, entryClass, timeoutMs);
                Map<String, Object> executionSection = executionSection(
                        response,
                        generatedArtifactRef,
                        executionInputRef,
                        sourceArtifactRef,
                        entryClass,
                        run,
                        executionStarted,
                        Instant.now());
                response.put("execution", executionSection);
                response.put("executionResult", canonicalExecutionResult(executionSection));
                diagnostics.addAll(executionDiagnostics(executionSection));
                if (!run.ran()) {
                    applyClassification(response, ResultClassifier.runFailure(run.errorClass()));
                    response.put("tests", emptyTests());
                    if (oracleEnabled) {
                        response.put("oracle", oracleSkippedMap(oracleSpec,
                                "java-run-not-started; oracle not executed"));
                        response.put("goldenMaster", Map.of(
                                "resolved", false,
                                "source", "oracle.cobol-runtime",
                                "note", "Java run did not start before the oracle could be executed."));
                    } else {
                        attachGoldenMaster(response, programId, request);
                    }
                    response.put("comparison", Map.of(
                            "matched", false,
                            "skipped", true,
                            "reason", "run-not-started"));
                    response.put("diagnostics", diagnostics);
                    attachComparisonResult(response);
                    response.put("outputRef", reference(response));
                    return response;
                }
                if (!run.ok()) {
                    applyClassification(response, ResultClassifier.runFailure(run.errorClass()));
                }
            }

            // -- Tests (W0 generator does not yet emit JUnit tests) ----------
            response.put("tests", emptyTests());

            // -- Oracle comparison (Issue #92) -------------------------------
            if (oracleEnabled) {
                return finaliseOracle(response, diagnostics, oracleSpec, run,
                        skipExecution, compareOutput, oracleTimeoutMs);
            }

            // -- Compare against Golden Master -------------------------------
            Optional<GoldenMaster.Resolved> golden = GoldenMaster.resolve(
                    programId, mapOrEmpty(request.get("goldenMaster")), repoRoot);

            if (golden.isPresent()) {
                Map<String, Object> goldenMap = golden.get().toMap();
                response.put("goldenMaster", goldenMap);
                if (!skipExecution && compareOutput && golden.get().isTrueFixture()) {
                    CobolRuntimeExecutor.Reproduction reproduction =
                            CobolRuntimeExecutor.reproduce(golden.get(), repoRoot, timeoutMs);
                    goldenMap.put("cobolRuntime", reproduction.toMap());
                    if (!reproduction.ok()) {
                        diagnostics.add(diagnostic("error", "true-golden-master-reproduction-failed",
                                trueGoldenMasterFailureSummary(reproduction)));
                        applyClassification(response, trueGoldenMasterClassification(reproduction));
                        response.put("comparison", Map.of(
                                "matched", false,
                                "skipped", false,
                                "reason", "true-golden-master-reproduction-failed"));
                        response.put("diagnostics", diagnostics);
                        attachComparisonResult(response);
                        response.put("outputRef", reference(response));
                        return response;
                    }
                }
            } else {
                response.put("goldenMaster", Map.of(
                        "resolved", false,
                        "programId", programId,
                        "registryPath", GoldenMaster.REGISTRY_RELATIVE_PATH));
            }

            if (skipExecution) {
                applyClassification(response, ResultClassifier.skipped("skipExecution=true"));
                response.put("comparison", Map.of(
                        "matched", false,
                        "skipped", true,
                        "reason", "options.skipExecution=true"));
            } else if (!compareOutput) {
                applyClassification(response, ResultClassifier.classification(
                        ResultClassifier.STATUS_OK, ResultClassifier.CLASS_SKIPPED,
                        "compareOutput=false; not comparing against Golden Master."));
                response.put("comparison", Map.of(
                        "matched", false,
                        "skipped", true,
                        "reason", "options.compareOutput=false"));
            } else if (golden.isEmpty()) {
                applyClassification(response, ResultClassifier.missingGoldenMaster(programId));
                response.put("comparison", Map.of(
                        "matched", false,
                        "skipped", true,
                        "reason", "missing-golden-master"));
            } else if (run != null && run.ran()) {
                Map<String, Object> comparison = compareToGoldenMaster(
                        string(response.get("runId"), "run-unknown"),
                        string(response.get("workflowId"), null),
                        run.stdout(),
                        run.stderr(),
                        run.ran() ? run.exitCode() : null,
                        golden.get().expected(),
                        "",
                        null);
                response.put("comparison", comparison);
                response.put("comparisonResult", comparison.get("comparisonResult"));
                response.put("comparisonResultRef", comparison.get("comparisonResultRef"));
                if (Boolean.TRUE.equals(comparison.get("matched"))) {
                    if (run.ok()) {
                        applyClassification(response, ResultClassifier.match());
                    }
                } else {
                    boolean known = golden.get().knownDivergenceAtW0();
                    if (run.ok()) {
                        applyClassification(response, ResultClassifier.divergence(known,
                                known
                                        ? "Generated stdout diverges from Golden Master; classified as a documented W0 generator coverage gap."
                                        : "Generated program output differs from Golden Master."));
                    }
                }
            }

            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }
    }

    public Map<String, Object> runSourceReferenceExecution(Map<String, Object> request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        return new SourceReferenceExecutionService(repoRoot).execute(request);
    }

    public Map<String, Object> runParityExecution(Map<String, Object> request) {
        return runSourceReferenceExecution(request);
    }

    private static boolean isCobolRuntimeOracle(Map<String, Object> oracleSpec) {
        if (oracleSpec == null || oracleSpec.isEmpty()) {
            return false;
        }
        return "cobol-runtime".equals(string(oracleSpec.get("mode"), null));
    }

    private Map<String, Object> finaliseOracle(Map<String, Object> response,
                                               List<Map<String, Object>> diagnostics,
                                               Map<String, Object> oracleSpec,
                                               GeneratedProgramRunner.RunResult run,
                                               boolean skipExecution,
                                               boolean compareOutput,
                                               long oracleTimeoutMs) {
        // The oracle owns the goldenMaster slot for this run; the request must
        // not silently fall through to the registry expectation when the
        // caller explicitly asked for a UI-supplied COBOL oracle.
        response.put("goldenMaster", Map.of(
                "resolved", false,
                "source", "oracle.cobol-runtime",
                "note", "Oracle supplied by request.oracle; registry Golden Master not consulted."));

        if (skipExecution) {
            applyClassification(response, ResultClassifier.skipped("skipExecution=true"));
            response.put("oracle", oracleSkippedMap(oracleSpec, "options.skipExecution=true"));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "options.skipExecution=true"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }
        if (run != null && !run.ok()) {
            // Java ran but exited unsuccessfully; the run-failure classification
            // was already applied. Do not execute the COBOL oracle — a partial
            // Java stdout must never be compared against a full COBOL stdout
            // because that could either fabricate a false match or mask the
            // real run failure as an oracle divergence.
            response.put("oracle", oracleSkippedMap(oracleSpec,
                    "java-run-failed; oracle not executed"));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "run-failed"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }
        if (!compareOutput) {
            applyClassification(response, ResultClassifier.classification(
                    ResultClassifier.STATUS_OK, ResultClassifier.CLASS_SKIPPED,
                    "compareOutput=false; oracle execution skipped."));
            response.put("oracle", oracleSkippedMap(oracleSpec, "options.compareOutput=false"));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "options.compareOutput=false"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        String programId = string(response.get("programId"), null);
        String sourceText = string(oracleSpec.get("sourceText"), null);
        String expectedOutput = exactStringOrNull(oracleSpec.get("expectedOutput"));
        String oracleInput = exactStringOrNull(oracleSpec.get("oracleInput"));
        Map<String, Object> oracleSourceRef = mapOrEmpty(oracleSpec.get("sourceRef"));
        boolean usingUserExpectedOutput = expectedOutput != null;

        CobolRuntimeExecutor.OracleRun oracle = null;
        Map<String, Object> oracleMap;
        if (usingUserExpectedOutput) {
            oracleMap = userProvidedOracleMap();
        } else {
            oracle = CobolRuntimeExecutor.executeSource(programId, sourceText, oracleInput, oracleTimeoutMs);
            oracleMap = oracle.toMap();
        }

        if (!oracleSourceRef.isEmpty()) {
            oracleMap.put("sourceRef", oracleSourceRef);
        }
        if (expectedOutput != null) {
            oracleMap.put("expectedOutputSha256", HashUtil.sha256(expectedOutput));
            oracleMap.put("expectedOutputBytes", HashUtil.byteLength(expectedOutput));
        }
        if (oracleInput != null) {
            oracleMap.put("oracleInputSha256", HashUtil.sha256(oracleInput));
            oracleMap.put("oracleInputBytes", HashUtil.byteLength(oracleInput));
        }
        response.put("oracle", oracleMap);

        if (!usingUserExpectedOutput && !oracle.attempted()) {
            diagnostics.add(diagnostic("error", "oracle-invalid-request",
                    oracle.reason() == null ? "oracle request is invalid" : oracle.reason()));
            applyClassification(response, ResultClassifier.oracleInvalid(oracle.reason()));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "oracle-invalid-request"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        if (!usingUserExpectedOutput && !oracle.available()) {
            diagnostics.add(diagnostic("error", "oracle-unavailable",
                    "GnuCOBOL (cobc/cobcrun) is not available; cannot prove equivalence"
                            + " for UI-provided COBOL source."));
            applyClassification(response, ResultClassifier.oracleUnavailable(null));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", true,
                    "reason", "oracle-unavailable"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        if (!usingUserExpectedOutput && !oracle.compileOk()) {
            diagnostics.add(diagnostic("error", "oracle-cobol-compile-failed",
                    "cobc failed to compile the UI-provided COBOL source: " + oracle.reason()));
            applyClassification(response, ResultClassifier.oracleCompileError(
                    "cobc failed: exit=" + oracle.compileExitCode()));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", false,
                    "reason", "oracle-cobol-compile-failed"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        if (!usingUserExpectedOutput && !oracle.runOk()) {
            diagnostics.add(diagnostic("error", "oracle-cobol-run-failed",
                    "cobcrun did not complete cleanly: " + oracle.reason()));
            applyClassification(response, ResultClassifier.oracleRunError(
                    "cobcrun exit=" + oracle.exitCode() + (oracle.reason().isBlank()
                            ? "" : (": " + oracle.reason()))));
            response.put("comparison", Map.of(
                    "matched", false,
                    "skipped", false,
                    "reason", "oracle-cobol-run-failed"));
            response.put("diagnostics", diagnostics);
            attachComparisonResult(response);
            response.put("outputRef", reference(response));
            return response;
        }

        // Explicit user-supplied expected output is the paste-mode oracle.
        // Otherwise, the COBOL runtime must have produced the oracle stdout.
        String expectedStdout = usingUserExpectedOutput ? expectedOutput : oracle.stdout();
        Map<String, Object> comparison = compareOutputs(
                string(response.get("runId"), "run-unknown"),
                string(response.get("workflowId"), null),
                expectedStdout,
                "",
                usingUserExpectedOutput ? null : oracle.exitCode(),
                run == null ? "" : run.stdout(),
                run == null ? "" : run.stderr(),
                run == null ? null : run.exitCode(),
                usingUserExpectedOutput ? "oracle.user-provided" : "oracle.cobol-runtime",
                usingUserExpectedOutput
                        ? "user-provided-expected-output"
                        : "cobol-oracle-stdout",
                usingUserExpectedOutput
                        ? "user-provided-expected-stderr"
                        : "cobol-oracle-stderr",
                "java-stdout",
                "java-stderr");
        response.put("comparison", comparison);
        response.put("comparisonResult", comparison.get("comparisonResult"));
        response.put("comparisonResultRef", comparison.get("comparisonResultRef"));
        if (Boolean.TRUE.equals(comparison.get("matched"))) {
            applyClassification(response, ResultClassifier.match());
        } else {
            applyClassification(response, ResultClassifier.divergence(false,
                    usingUserExpectedOutput
                            ? "Generated Java stdout diverges from user-supplied expected output."
                            : "Generated Java stdout diverges from COBOL oracle stdout."));
        }
        response.put("diagnostics", diagnostics);
        attachComparisonResult(response);
        response.put("outputRef", reference(response));
        return response;
    }

    private static Map<String, Object> oracleSkippedMap(Map<String, Object> oracleSpec, String reason) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("mode", "cobol-runtime");
        map.put("attempted", false);
        map.put("available", false);
        map.put("compileOk", false);
        map.put("ran", false);
        map.put("runOk", false);
        map.put("reason", reason);
        Map<String, Object> oracleSourceRef = mapOrEmpty(oracleSpec.get("sourceRef"));
        if (!oracleSourceRef.isEmpty()) {
            map.put("sourceRef", oracleSourceRef);
        }
        return map;
    }

    private static Map<String, Object> userProvidedOracleMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("mode", "user-provided");
        map.put("attempted", false);
        map.put("available", true);
        map.put("compileOk", false);
        map.put("ran", false);
        map.put("runOk", false);
        map.put("reason", "explicit expectedOutput supplied; COBOL runtime not required");
        return map;
    }

    private static Map<String, Object> compareOutputs(
            String runId,
            String workflowId,
            String sourceStdout,
            String sourceStderr,
            Integer sourceExitCode,
            String javaStdout,
            String javaStderr,
            Integer javaExitCode,
            String sourceSurfaceLabel,
            String sourceStdoutKind,
            String sourceStderrKind,
            String javaStdoutKind,
            String javaStderrKind) {
        Map<String, Object> sourceStdoutRef = outputReference(sourceStdoutKind, sourceStdout);
        Map<String, Object> sourceStderrRef = outputReference(sourceStderrKind, sourceStderr);
        Map<String, Object> javaStdoutRef = outputReference(javaStdoutKind, javaStdout);
        Map<String, Object> javaStderrRef = outputReference(javaStderrKind, javaStderr);
        Map<String, Object> sourceNormalizedRef =
                outputReference(sourceStdoutKind + "-normalized", DeterministicComparisonPolicy.normalize(sourceStdout));
        Map<String, Object> sourceNormalizedStderrRef =
                outputReference(sourceStderrKind + "-normalized", DeterministicComparisonPolicy.normalize(sourceStderr));
        Map<String, Object> javaNormalizedRef =
                outputReference(javaStdoutKind + "-normalized", DeterministicComparisonPolicy.normalize(javaStdout));
        Map<String, Object> javaNormalizedStderrRef =
                outputReference(javaStderrKind + "-normalized", DeterministicComparisonPolicy.normalize(javaStderr));
        Map<String, Object> comparisonResult = ParityComparison.compare(
                runId,
                workflowId,
                new ParityComparison.ExecutionFact(
                        "passed",
                        sourceExitCode,
                        sourceStdout,
                        sourceStderr,
                        sourceStdoutRef,
                        sourceStderrRef,
                        sourceNormalizedRef,
                        sourceNormalizedStderrRef,
                        sourceSurfaceLabel),
                new ParityComparison.ExecutionFact(
                        javaExitCode != null && javaExitCode.intValue() == 0 ? "passed"
                                : (javaExitCode != null && javaExitCode.intValue() == 124 ? "timed_out" : "failed"),
                        javaExitCode,
                        javaStdout,
                        javaStderr,
                        javaStdoutRef,
                        javaStderrRef,
                        javaNormalizedRef,
                        javaNormalizedStderrRef,
                        "generated-java"));
        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("matched", Boolean.TRUE.equals(comparisonResult.get("matched")));
        comparison.put("normalisation", DeterministicComparisonPolicy.VERSION);
        comparison.put("source", sourceSurfaceLabel);
        comparison.put("actualSha256", HashUtil.sha256(javaStdout == null ? "" : javaStdout));
        comparison.put("expectedSha256", HashUtil.sha256(sourceStdout == null ? "" : sourceStdout));
        comparison.put("actualLength", javaStdout == null ? 0 : javaStdout.length());
        comparison.put("expectedLength", sourceStdout == null ? 0 : sourceStdout.length());
        comparison.put("actualRef", javaStdoutRef);
        comparison.put("expectedRef", sourceStdoutRef);
        comparison.put("actualStderrRef", javaStderrRef);
        comparison.put("expectedStderrRef", sourceStderrRef);
        comparison.put("actualNormalizedRef", javaNormalizedRef);
        comparison.put("expectedNormalizedRef", sourceNormalizedRef);
        comparison.put("actualNormalizedStderrRef", javaNormalizedStderrRef);
        comparison.put("expectedNormalizedStderrRef", sourceNormalizedStderrRef);
        comparison.put("sourceStdoutRef", sourceStdoutRef);
        comparison.put("sourceStderrRef", sourceStderrRef);
        comparison.put("javaStdoutRef", javaStdoutRef);
        comparison.put("javaStderrRef", javaStderrRef);
        comparison.put("sourceNormalizedOutputRef", sourceNormalizedRef);
        comparison.put("sourceNormalizedStderrRef", sourceNormalizedStderrRef);
        comparison.put("javaNormalizedOutputRef", javaNormalizedRef);
        comparison.put("javaNormalizedStderrRef", javaNormalizedStderrRef);
        comparison.put("comparisonPolicyVersion", DeterministicComparisonPolicy.VERSION);
        comparison.put("comparisonPolicyRef", DeterministicComparisonPolicy.toRef());
        comparison.put("comparisonResult", comparisonResult);
        comparison.put("comparisonResultRef", comparisonResult.get("outputRef"));
        comparison.put("diff", comparisonResult.get("diffSummary"));
        comparison.put("diffRef", comparisonResult.get("diffRef"));
        comparison.put("normalizedDiffRef", comparisonResult.get("diffRef"));
        comparison.put("mismatchClassification", comparisonResult.get("mismatchClassification"));
        comparison.put("status", comparisonResult.get("status"));
        comparison.put("sourceExitCode", sourceExitCode);
        comparison.put("javaExitCode", javaExitCode);
        comparison.put("sourceOutputRef", sourceStdoutRef);
        comparison.put("javaOutputRef", javaStdoutRef);
        comparison.put("sourceStderrOutputRef", sourceStderrRef);
        comparison.put("javaStderrOutputRef", javaStderrRef);
        return comparison;
    }

    private static Map<String, Object> compareToGoldenMaster(
            String runId,
            String workflowId,
            String actual,
            String actualStderr,
            Integer actualExitCode,
            String expected,
            String expectedStderr,
            Integer expectedExitCode) {
        return compareOutputs(
                runId,
                workflowId,
                expected,
                expectedStderr,
                expectedExitCode,
                actual,
                actualStderr,
                actualExitCode,
                "golden-master",
                "golden-master-output",
                "golden-master-stderr",
                "java-stdout",
                "java-stderr");
    }

    static Map<String, Object> outputReference(String kind, String content) {
        String safeContent = content == null ? "" : content;
        String hash = HashUtil.sha256(safeContent);
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("uri", "urn:" + SERVICE_NAME + "/output/" + kind + "/" + hash);
        ref.put("sha256", hash);
        ref.put("byteSize", HashUtil.byteLength(safeContent));
        ref.put("mimeType", "text/plain");
        ref.put("kind", kind);
        return ref;
    }

    private static String normalise(String value) {
        return DeterministicComparisonPolicy.normalize(value);
    }

    private static String trueGoldenMasterFailureSummary(CobolRuntimeExecutor.Reproduction reproduction) {
        if (!reproduction.available()) {
            return "GnuCOBOL cobc/cobcrun are not available for true Golden Master reproduction.";
        }
        if (!reproduction.compileOk()) {
            return "cobc failed while compiling the true Golden Master source: " + reproduction.reason();
        }
        if (!reproduction.ran()) {
            return "cobcrun did not execute the true Golden Master module: " + reproduction.reason();
        }
        if (!reproduction.matched()) {
            return "cobcrun stdout differs from the checked-in true Golden Master expected output.";
        }
        return "true Golden Master reproduction failed.";
    }

    private static Map<String, Object> trueGoldenMasterClassification(
            CobolRuntimeExecutor.Reproduction reproduction) {
        String summary = trueGoldenMasterFailureSummary(reproduction);
        if (reproduction.available() && reproduction.compileOk()
                && reproduction.ran() && reproduction.exitCode() == 0
                && !reproduction.matched()) {
            return ResultClassifier.trueGoldenMasterMismatch(summary);
        }
        return ResultClassifier.trueGoldenMasterReproductionError(summary);
    }

    private void attachGoldenMaster(Map<String, Object> response, String programId,
                                    Map<String, Object> request) {
        Optional<GoldenMaster.Resolved> golden = GoldenMaster.resolve(
                programId, mapOrEmpty(request.get("goldenMaster")), repoRoot);
        response.put("goldenMaster", golden.isPresent()
                ? golden.get().toMap()
                : Map.of("resolved", false,
                        "programId", programId,
                        "registryPath", GoldenMaster.REGISTRY_RELATIVE_PATH));
    }

    static Map<String, Object> reference(Map<String, Object> response) {
        return reference("build-test-result", "build-test-result", response);
    }

    static Map<String, Object> reference(String kind, String uriSegment, Map<String, Object> response) {
        String body = HashUtil.canonicalJson(response);
        String hash = HashUtil.sha256(body);
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("uri", "urn:" + SERVICE_NAME + "/" + uriSegment + "/" + hash);
        ref.put("sha256", hash);
        ref.put("byteSize", HashUtil.byteLength(body));
        ref.put("mimeType", "application/json");
        ref.put("kind", kind);
        return ref;
    }

    private static Map<String, Object> buildSection(
            Map<String, Object> response,
            Map<String, Object> generatedArtifactRef,
            JavaInMemoryCompiler.CompileResult compile,
            int fileCount,
            Instant started,
            Instant completed,
            Path classOutputDir) {
        String buildLog = renderBuildLog(compile.diagnostics(), compile.ok(), compile.sourceCount(), fileCount);
        Map<String, Object> logRef = outputReference("generated-java-build-log", buildLog);
        Map<String, Object> buildOutputRef = classDirectoryReference(classOutputDir);
        List<Map<String, Object>> schemaDiagnostics = diagnosticsWithRawLogRef(compile.diagnostics(), logRef);
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("schemaVersion", SCHEMA_VERSION);
        map.put("buildId", "generated-java-build-" + UUID.randomUUID());
        map.put("runId", string(response.get("runId"), "run-unknown"));
        map.put("workflowId", string(response.get("workflowId"), null));
        map.put("buildMode", "generated-java");
        map.put("command", "javac(in-process)");
        map.put("toolchain", runtimeToolchain());
        map.put("status", compile.ok() ? "passed" : "failed");
        map.put("inputArtifactRef", generatedArtifactRef);
        map.put("buildOutputRef", buildOutputRef);
        map.put("logRef", logRef);
        map.put("evidenceRefs", evidenceRefs(generatedArtifactRef, buildOutputRef, logRef));
        map.put("diagnostics", schemaDiagnostics);
        map.put("startedAt", started.toString());
        map.put("completedAt", completed.toString());
        map.put("createdAt", completed.toString());
        map.put("summary", compile.ok()
                ? "Generated Java compiled successfully in the controlled build runner."
                : "Generated Java compilation failed in the controlled build runner.");
        map.put("outputRef", reference("parity-build-result", "parity-build-result", map));
        // Compatibility fields kept while downstream consumers move to the
        // shared build schema.
        map.put("compileOk", compile.ok());
        map.put("sourceCount", compile.sourceCount());
        map.put("fileCount", fileCount);
        map.put("classOutputDir", "target/classes");
        return map;
    }

    private static Map<String, Object> failedBuild(
            Map<String, Object> response,
            Map<String, Object> generatedArtifactRef,
            List<Map<String, Object>> diagnostics,
            String summary) {
        Instant now = Instant.now();
        Map<String, Object> map = new LinkedHashMap<>();
        Map<String, Object> logRef = outputReference("generated-java-build-log", renderBuildLog(diagnostics, false, 0, 0));
        map.put("schemaVersion", SCHEMA_VERSION);
        map.put("buildId", "generated-java-build-" + UUID.randomUUID());
        map.put("runId", string(response.get("runId"), "run-unknown"));
        map.put("workflowId", string(response.get("workflowId"), null));
        map.put("buildMode", "generated-java");
        map.put("command", "javac(in-process)");
        map.put("toolchain", runtimeToolchain());
        map.put("status", "failed");
        map.put("inputArtifactRef", generatedArtifactRef);
        Map<String, Object> buildOutputRef = outputReference("generated-java-build-output", "");
        map.put("buildOutputRef", buildOutputRef);
        map.put("logRef", logRef);
        map.put("evidenceRefs", evidenceRefs(generatedArtifactRef, buildOutputRef, logRef));
        map.put("diagnostics", diagnosticsWithRawLogRef(diagnostics, logRef));
        map.put("startedAt", now.toString());
        map.put("completedAt", now.toString());
        map.put("createdAt", now.toString());
        map.put("summary", summary);
        map.put("outputRef", reference("parity-build-result", "parity-build-result", map));
        map.put("compileOk", false);
        map.put("sourceCount", 0);
        map.put("fileCount", 0);
        return map;
    }

    private static Map<String, Object> emptyBuild(Map<String, Object> response, Map<String, Object> generatedArtifactRef) {
        return failedBuild(response, generatedArtifactRef, List.of(),
                "No generated project payload supplied; build did not run.");
    }

    private static Map<String, Object> executionSection(
            Map<String, Object> response,
            Map<String, Object> generatedArtifactRef,
            Map<String, Object> inputArtifactRef,
            Map<String, Object> sourceArtifactRef,
            String entryClass,
            GeneratedProgramRunner.RunResult run,
            Instant started,
            Instant completed) {
        String stdout = run.stdout() == null ? "" : run.stdout();
        String stderr = run.stderr() == null ? "" : run.stderr();
        Map<String, Object> stdoutRef = outputReference("generated-java-stdout", stdout);
        Map<String, Object> stderrRef = outputReference("generated-java-stderr", stderr);
        Map<String, Object> normalizedOutputRef =
                outputReference("generated-java-normalized-output", normalise(stdout));
        String executionLog = renderExecutionLog(entryClass, run, stdout, stderr);
        Map<String, Object> logRef = outputReference("generated-java-execution-log", executionLog);
        List<Map<String, Object>> executionDiagnostics = new ArrayList<>();
        if (!run.ok() || !run.ran()) {
            executionDiagnostics.add(runtimeDiagnostic(entryClass, run, stderrRef));
        }
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("schemaVersion", SCHEMA_VERSION);
        map.put("executionId", "generated-java-execution-" + UUID.randomUUID());
        map.put("runId", string(response.get("runId"), "run-unknown"));
        map.put("workflowId", string(response.get("workflowId"), null));
        map.put("executionSurface", "generated-java");
        map.put("command", entryClass == null ? "java <missing-entry-class>" : ("java " + entryClass));
        map.put("status", run.ok() ? "passed" : (isTimeout(run.errorClass()) ? "timed_out" : "failed"));
        map.put("exitCode", run.ran() ? run.exitCode() : null);
        map.put("timedOut", isTimeout(run.errorClass()));
        map.put("stdoutRef", stdoutRef);
        map.put("stderrRef", stderrRef);
        map.put("normalizedOutputRef", normalizedOutputRef);
        map.put("logRef", logRef);
        if (!sourceArtifactRef.isEmpty()) {
            map.put("sourceArtifactRef", sourceArtifactRef);
        }
        if (!inputArtifactRef.isEmpty()) {
            map.put("inputArtifactRef", inputArtifactRef);
        }
        if (!generatedArtifactRef.isEmpty()) {
            map.put("generatedArtifactRef", generatedArtifactRef);
        }
        map.put("diagnostics", executionDiagnostics);
        map.put("startedAt", started.toString());
        map.put("completedAt", completed.toString());
        map.put("createdAt", completed.toString());
        map.put("summary", run.ok()
                ? "Generated Java executed successfully in the controlled runner."
                : safeRuntimeSummary(run));
        map.put("evidenceRefs", evidenceRefs(sourceArtifactRef, inputArtifactRef, generatedArtifactRef,
                stdoutRef, stderrRef, normalizedOutputRef, logRef));
        map.put("outputRef", normalizedOutputRef);
        // Compatibility fields kept while downstream consumers move to the
        // shared execution schema.
        map.put("ran", run.ran());
        map.put("ok", run.ok());
        map.put("stdout", stdout);
        map.put("stderr", stderr);
        map.put("durationMs", run.durationMs());
        map.put("stdoutSha256", HashUtil.sha256(stdout));
        if (run.errorClass() != null) {
            map.put("errorClass", run.errorClass());
        }
        if (run.errorMessage() != null) {
            map.put("errorMessage", run.errorMessage());
        }
        return map;
    }

    private static Map<String, Object> skippedExecutionSection(
            Map<String, Object> response,
            Map<String, Object> generatedArtifactRef,
            Map<String, Object> inputArtifactRef,
            Map<String, Object> sourceArtifactRef,
            String entryClass,
            String reason) {
        Instant now = Instant.now();
        Map<String, Object> map = new LinkedHashMap<>();
        Map<String, Object> stdoutRef = outputReference("generated-java-stdout", "");
        Map<String, Object> stderrRef = outputReference("generated-java-stderr", "");
        map.put("schemaVersion", SCHEMA_VERSION);
        map.put("executionId", "generated-java-execution-" + UUID.randomUUID());
        map.put("runId", string(response.get("runId"), "run-unknown"));
        map.put("workflowId", string(response.get("workflowId"), null));
        map.put("executionSurface", "generated-java");
        map.put("command", entryClass == null ? "java <missing-entry-class>" : ("java " + entryClass));
        map.put("status", "skipped");
        map.put("exitCode", null);
        map.put("timedOut", false);
        map.put("stdoutRef", stdoutRef);
        map.put("stderrRef", stderrRef);
        Map<String, Object> normalizedOutputRef = outputReference("generated-java-normalized-output", "");
        Map<String, Object> logRef = outputReference("generated-java-execution-log", reason);
        map.put("normalizedOutputRef", normalizedOutputRef);
        map.put("logRef", logRef);
        if (!sourceArtifactRef.isEmpty()) {
            map.put("sourceArtifactRef", sourceArtifactRef);
        }
        if (!inputArtifactRef.isEmpty()) {
            map.put("inputArtifactRef", inputArtifactRef);
        }
        if (!generatedArtifactRef.isEmpty()) {
            map.put("generatedArtifactRef", generatedArtifactRef);
        }
        map.put("diagnostics", List.of());
        map.put("startedAt", now.toString());
        map.put("completedAt", now.toString());
        map.put("createdAt", now.toString());
        map.put("summary", "Generated Java execution was skipped: " + reason + ".");
        map.put("evidenceRefs", evidenceRefs(sourceArtifactRef, inputArtifactRef, generatedArtifactRef,
                stdoutRef, stderrRef, normalizedOutputRef, logRef));
        map.put("outputRef", normalizedOutputRef);
        map.put("ran", false);
        map.put("ok", false);
        map.put("stdout", "");
        map.put("stderr", "");
        map.put("durationMs", 0);
        map.put("stdoutSha256", HashUtil.sha256(""));
        map.put("skipped", true);
        map.put("reason", reason);
        return map;
    }

    private static Map<String, Object> emptyExecution(
            Map<String, Object> response,
            Map<String, Object> generatedArtifactRef,
            Map<String, Object> inputArtifactRef,
            Map<String, Object> sourceArtifactRef) {
        return skippedExecutionSection(
                response,
                generatedArtifactRef,
                inputArtifactRef,
                sourceArtifactRef,
                null,
                "build did not produce an executable generated Java candidate");
    }

    private static Map<String, Object> emptyTests() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ran", false);
        map.put("totalTests", 0);
        map.put("passed", 0);
        map.put("failed", 0);
        map.put("skipped", 0);
        map.put("note",
                "W0 generator does not emit JUnit tests yet; the runner only "
                        + "exercises compile + main() execution against a Golden Master.");
        return map;
    }

    private static List<Map<String, Object>> executionDiagnostics(Map<String, Object> executionSection) {
        Object value = executionSection.get("diagnostics");
        if (value instanceof List<?> list) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> typed = (Map<String, Object>) map;
                    out.add(new LinkedHashMap<>(typed));
                }
            }
            return out;
        }
        return List.of();
    }

    private static Map<String, Object> newEnvelope(Map<String, Object> request, String programId) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", SCHEMA_VERSION);
        response.put("capability", CAPABILITY);
        response.put("service", SERVICE_NAME);
        response.put("runId", string(request.get("runId"), "run-unknown"));
        response.put("workflowId", string(request.get("workflowId"), "w0-migration-v0"));
        response.put("sourceRef", sourceArtifactRef(request));
        response.put("programId", programId);
        return response;
    }

    private static void applyClassification(Map<String, Object> response, Map<String, Object> result) {
        response.put("status", result.get("status"));
        response.put("classification", result.get("classification"));
        response.put("summary", result.get("summary"));
    }

    private static Map<String, Object> generatedArtifactRef(
            Map<String, Object> request,
            Map<String, Object> generatedProject) {
        Map<String, Object> explicit = mapOrEmpty(request.get("generatedArtifactRef"));
        if (!explicit.isEmpty()) {
            return explicit;
        }
        Object envelope = request.get("generationResponse");
        if (envelope instanceof Map<?, ?> outer) {
            Map<String, Object> outputRef = mapOrEmpty(((Map<String, Object>) outer).get("outputRef"));
            if (!outputRef.isEmpty()) {
                return outputRef;
            }
        }
        return reference("generated-java-project", "generated-java-project", generatedProject);
    }

    private static Map<String, Object> sourceArtifactRef(Map<String, Object> request) {
        Map<String, Object> sourceRef = mapOrEmpty(request.get("sourceRef"));
        if (!sourceRef.isEmpty()) {
            return sourceRef;
        }
        Object envelope = request.get("generationResponse");
        if (envelope instanceof Map<?, ?> outer) {
            Map<String, Object> generatedSourceRef = mapOrEmpty(((Map<String, Object>) outer).get("sourceRef"));
            if (!generatedSourceRef.isEmpty()) {
                return generatedSourceRef;
            }
        }
        return new LinkedHashMap<>();
    }

    private static Map<String, Object> controlledInputRef(
            Map<String, Object> sourceArtifactRef,
            Map<String, Object> generatedArtifactRef,
            Map<String, Object> oracleSpec) {
        Map<String, Object> oracleSourceRef = mapOrEmpty(oracleSpec.get("sourceRef"));
        if (!oracleSourceRef.isEmpty()) {
            return oracleSourceRef;
        }
        if (!sourceArtifactRef.isEmpty()) {
            return sourceArtifactRef;
        }
        return generatedArtifactRef;
    }

    private static Map<String, Object> canonicalBuildResult(Map<String, Object> build) {
        return selectKeys(build,
                "schemaVersion",
                "buildId",
                "runId",
                "workflowId",
                "buildMode",
                "command",
                "toolchain",
                "status",
                "inputArtifactRef",
                "buildOutputRef",
                "logRef",
                "startedAt",
                "completedAt",
                "createdAt",
                "diagnostics",
                "summary",
                "evidenceRefs");
    }

    private static Map<String, Object> canonicalExecutionResult(Map<String, Object> execution) {
        return selectKeys(execution,
                "schemaVersion",
                "executionId",
                "runId",
                "workflowId",
                "executionSurface",
                "command",
                "status",
                "exitCode",
                "timedOut",
                "stdoutRef",
                "stderrRef",
                "normalizedOutputRef",
                "outputRef",
                "logRef",
                "sourceArtifactRef",
                "inputArtifactRef",
                "generatedArtifactRef",
                "referenceArtifactRef",
                "startedAt",
                "completedAt",
                "createdAt",
                "diagnostics",
                "summary",
                "evidenceRefs");
    }

    private static Map<String, Object> selectKeys(Map<String, Object> source, String... keys) {
        Map<String, Object> selected = new LinkedHashMap<>();
        for (String key : keys) {
            if (source.containsKey(key)) {
                selected.put(key, source.get(key));
            }
        }
        return selected;
    }

    private static Map<String, Object> classDirectoryReference(Path classOutputDir) {
        if (classOutputDir == null || !Files.isDirectory(classOutputDir)) {
            return outputReference("generated-java-build-output", "");
        }
        try (var stream = Files.walk(classOutputDir)) {
            StringBuilder manifest = new StringBuilder();
            stream.filter(Files::isRegularFile)
                    .sorted()
                    .forEach(path -> {
                        try {
                            manifest.append(classOutputDir.relativize(path).toString().replace('\\', '/'))
                                    .append(':')
                                    .append(HashUtil.sha256(Base64.getEncoder().encodeToString(Files.readAllBytes(path))))
                                    .append('\n');
                        } catch (IOException e) {
                            manifest.append(path.getFileName()).append(":io-error\n");
                        }
                    });
            return outputReference("generated-java-build-output", manifest.toString());
        } catch (IOException e) {
            return outputReference("generated-java-build-output", "io-error:" + e.getMessage());
        }
    }

    private static String runtimeToolchain() {
        return System.getProperty("java.vm.name", "JVM")
                + " "
                + System.getProperty("java.version", "unknown");
    }

    private static List<Map<String, Object>> diagnosticsWithRawLogRef(
            List<Map<String, Object>> diagnostics,
            Map<String, Object> logRef) {
        List<Map<String, Object>> out = new ArrayList<>(diagnostics.size());
        for (Map<String, Object> diagnostic : diagnostics) {
            Map<String, Object> copy = new LinkedHashMap<>(diagnostic);
            if (!copy.containsKey("rawLogRef")) {
                copy.put("rawLogRef", logRef);
            }
            out.add(copy);
        }
        return out;
    }

    @SafeVarargs
    static List<Map<String, Object>> evidenceRefs(Map<String, Object>... refs) {
        List<Map<String, Object>> out = new ArrayList<>(refs.length);
        for (Map<String, Object> ref : refs) {
            if (ref != null && !ref.isEmpty()) {
                out.add(new LinkedHashMap<>(ref));
            }
        }
        return out;
    }

    private static void attachComparisonResult(Map<String, Object> response) {
        if (response.get("comparisonResult") instanceof Map<?, ?>) {
            return;
        }
        Map<String, Object> comparison = mapOrEmpty(response.get("comparison"));
        Map<String, Object> execution = mapOrEmpty(response.get("execution"));
        ParityComparison.ExecutionFact target = executionFactFromExecution(execution);
        String runId = string(response.get("runId"), "run-unknown");
        String workflowId = string(response.get("workflowId"), null);
        String reason = string(comparison.get("reason"), null);
        Map<String, Object> comparisonResult;
        if ("compile-failed".equals(reason) || "run-failed".equals(reason)
                || "run-not-started".equals(reason)
                || "oracle-cobol-compile-failed".equals(reason)
                || "oracle-cobol-run-failed".equals(reason)) {
            comparisonResult = ParityComparison.runtimeFailure(
                    runId,
                    workflowId,
                    null,
                    target,
                    reason == null ? "Generated Java execution did not complete successfully." : reason);
        } else if ("missing-golden-master".equals(reason) || "oracle-unavailable".equals(reason)
                || "oracle-invalid-request".equals(reason) || "options.compareOutput=false".equals(reason)
                || "options.skipExecution=true".equals(reason)) {
            comparisonResult = ParityComparison.unsupported(
                    runId,
                    workflowId,
                    null,
                    target,
                    reason == null ? "Comparison input is unavailable or explicitly disabled." : reason);
        } else {
            return;
        }
        response.put("comparisonResult", comparisonResult);
        response.put("comparisonResultRef", comparisonResult.get("outputRef"));
    }

    private static ParityComparison.ExecutionFact executionFactFromExecution(Map<String, Object> execution) {
        if (execution.isEmpty()) {
            return null;
        }
        Integer exitCode = execution.get("exitCode") instanceof Number number ? number.intValue() : null;
        return new ParityComparison.ExecutionFact(
                string(execution.get("status"), "skipped"),
                exitCode,
                string(execution.get("stdout"), ""),
                string(execution.get("stderr"), ""),
                mapOrEmpty(execution.get("stdoutRef")),
                mapOrEmpty(execution.get("stderrRef")),
                mapOrEmpty(execution.get("normalizedOutputRef")),
                outputReference("generated-java-stderr-normalized",
                        DeterministicComparisonPolicy.normalize(string(execution.get("stderr"), ""))),
                "generated-java");
    }

    private static String renderBuildLog(
            List<Map<String, Object>> diagnostics,
            boolean ok,
            int sourceCount,
            int fileCount) {
        StringBuilder builder = new StringBuilder();
        builder.append("compileOk=").append(ok)
                .append(" sourceCount=").append(sourceCount)
                .append(" fileCount=").append(fileCount)
                .append('\n');
        for (Map<String, Object> diagnostic : diagnostics) {
            String filePath = DiagnosticBounds.boundedFilePath(
                    String.valueOf(diagnostic.getOrDefault("filePath", "generated-project")));
            String message = DiagnosticBounds.boundedMessage(
                    String.valueOf(diagnostic.getOrDefault("message", "")));
            builder.append(String.valueOf(diagnostic.getOrDefault("severity", "info"))).append(' ')
                    .append(filePath).append(':')
                    .append(String.valueOf(diagnostic.getOrDefault("line", 1))).append(':')
                    .append(String.valueOf(diagnostic.getOrDefault("column", 1))).append(' ')
                    .append(message)
                    .append('\n');
        }
        return builder.toString();
    }

    private static String renderExecutionLog(
            String entryClass,
            GeneratedProgramRunner.RunResult run,
            String stdout,
            String stderr) {
        return "entryClass=" + (entryClass == null ? "<missing>" : entryClass)
                + " ran=" + run.ran()
                + " ok=" + run.ok()
                + " exitCode=" + run.exitCode()
                + " errorClass=" + (run.errorClass() == null ? "" : run.errorClass())
                + "\nstdout:\n" + stdout
                + "\nstderr:\n" + stderr;
    }

    private static Map<String, Object> runtimeDiagnostic(
            String entryClass,
            GeneratedProgramRunner.RunResult run,
            Map<String, Object> stderrRef) {
        String message = run.errorMessage() == null
                ? "Generated Java execution failed."
                : safeDiagnosticMessage(run.errorMessage());
        Map<String, Object> diagnostic = diagnostic(
                "error",
                run.ran() ? "generated-java-runtime-failed" : "generated-java-run-not-started",
                runtimeFilePath(entryClass),
                1L,
                1L,
                message);
        diagnostic.put("rawLogRef", stderrRef);
        return diagnostic;
    }

    private static String runtimeFilePath(String entryClass) {
        if (entryClass == null || entryClass.isBlank()) {
            return "generated-project";
        }
        return "src/main/java/" + entryClass.replace('.', '/') + ".java";
    }

    private static String safeRuntimeSummary(GeneratedProgramRunner.RunResult run) {
        if (isTimeout(run.errorClass())) {
            return "Generated Java execution exceeded the configured wall-clock budget.";
        }
        if (!run.ran()) {
            return "Generated Java execution could not start in the controlled runner.";
        }
        return "Generated Java execution failed in the controlled runner: "
                + safeDiagnosticMessage(run.errorMessage());
    }

    private static String safeDiagnosticMessage(String message) {
        if (message == null || message.isBlank()) {
            return "No diagnostic detail was available.";
        }
        return message.replaceAll("(/[\\w./-]+)+", "<path>");
    }

    private static boolean isTimeout(String value) {
        return value != null && value.toLowerCase().contains("timeout");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> extractGeneratedProject(Map<String, Object> request) {
        Object direct = request.get("generatedProject");
        if (direct instanceof Map<?, ?> map) {
            return new LinkedHashMap<>((Map<String, Object>) map);
        }
        Object envelope = request.get("generationResponse");
        if (envelope instanceof Map<?, ?> outer) {
            Object inner = ((Map<String, Object>) outer).get("generatedProject");
            if (inner instanceof Map<?, ?> map) {
                return new LinkedHashMap<>((Map<String, Object>) map);
            }
        }
        return new LinkedHashMap<>();
    }

    private static List<Map<String, Object>> generatedJavaSafetyDiagnostics(Map<String, String> files) {
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        for (Map.Entry<String, String> entry : files.entrySet()) {
            String path = entry.getKey();
            if (path == null || !path.endsWith(".java")) {
                continue;
            }
            String content = entry.getValue() == null ? "" : entry.getValue();
            for (String token : GENERATED_JAVA_FORBIDDEN_TOKENS) {
                int offset = content.indexOf(token);
                if (offset >= 0) {
                    diagnostics.add(diagnostic(
                            "error",
                            "generated-java-policy-denied",
                            path,
                            lineNumber(content, offset),
                            1L,
                            "Generated Java uses forbidden API token: " + token));
                }
            }
        }
        return diagnostics;
    }

    private static long lineNumber(String content, int offset) {
        long line = 1L;
        int limit = Math.max(0, Math.min(offset, content.length()));
        for (int i = 0; i < limit; i++) {
            if (content.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }

    static Path detectRepoRoot() {
        Path current = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 8; i++) {
            if (current == null) {
                break;
            }
            if (Files.isRegularFile(current.resolve(GoldenMaster.REGISTRY_RELATIVE_PATH))
                    || Files.isDirectory(current.resolve("services/build-test-runner-service"))) {
                return current;
            }
            current = current.getParent();
        }
        return Paths.get("").toAbsolutePath();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrEmpty(Object value) {
        if (value instanceof Map<?, ?> map) {
            return new LinkedHashMap<>((Map<String, Object>) map);
        }
        return new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> stringMap(Object value) {
        Map<String, String> out = new LinkedHashMap<>();
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getKey() == null) {
                    continue;
                }
                out.put(entry.getKey().toString(), entry.getValue() == null ? "" : entry.getValue().toString());
            }
        }
        return out;
    }

    private static String string(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = value.toString().trim();
        return text.isBlank() ? fallback : text;
    }

    private static String exactStringOrNull(Object value) {
        if (!(value instanceof String text) || text.isEmpty()) {
            return null;
        }
        return text;
    }

    private static long longValue(Object value, long fallback) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        if (value instanceof String s && !s.isBlank()) {
            try {
                return Long.parseLong(s.trim());
            } catch (NumberFormatException e) {
                return fallback;
            }
        }
        return fallback;
    }

    private static boolean booleanFlag(Object value, boolean fallback) {
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return Boolean.parseBoolean(s.trim());
        }
        return fallback;
    }

    private static long clampTimeout(long requested) {
        if (requested < 100L) {
            return 100L;
        }
        if (requested > 30_000L) {
            return 30_000L;
        }
        return requested;
    }

    private static Map<String, Object> diagnostic(String severity, String code, String message) {
        return diagnostic(severity, code, "generated-project", 1L, 1L, message);
    }

    private static Map<String, Object> diagnostic(
            String severity,
            String code,
            String filePath,
            long line,
            long column,
            String message) {
        Map<String, Object> diag = new LinkedHashMap<>();
        diag.put("severity", severity);
        diag.put("code", code);
        diag.put("filePath", DiagnosticBounds.boundedFilePath(filePath));
        diag.put("line", line);
        diag.put("column", column);
        diag.put("message", DiagnosticBounds.boundedMessage(message));
        return diag;
    }
}
