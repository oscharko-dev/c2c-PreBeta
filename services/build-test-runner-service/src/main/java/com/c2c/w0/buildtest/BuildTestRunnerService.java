package com.c2c.w0.buildtest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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
    public static final String SOURCE_REFERENCE_CAPABILITY = "build-test.source-reference";
    public static final String SERVICE_NAME = "build-test-runner-service";

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

        if (generatedProject.isEmpty()) {
            applyClassification(response, ResultClassifier.classification(
                    ResultClassifier.STATUS_SKIPPED, ResultClassifier.CLASS_SKIPPED,
                    "No generatedProject payload supplied; nothing to verify."));
            response.put("diagnostics", diagnostics);
            response.put("build", emptyBuild());
            response.put("execution", emptyExecution());
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            response.put("outputRef", reference(response));
            return response;
        }

        Map<String, String> files = stringMap(generatedProject.get("files"));
        String entryClass = string(generatedProject.get("entryClass"), null);
        String entryFilePath = string(generatedProject.get("entryFilePath"), null);

        GeneratedProjectMaterializer.MaterializedProject materialised;
        try {
            materialised = GeneratedProjectMaterializer.materialise(files);
        } catch (IllegalArgumentException e) {
            applyClassification(response, ResultClassifier.compileFailure());
            diagnostics.add(diagnostic("error", "materialise-failed", e.getMessage()));
            response.put("build", failedBuild(diagnostics));
            response.put("execution", emptyExecution());
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            response.put("diagnostics", diagnostics);
            response.put("outputRef", reference(response));
            return response;
        } catch (IOException e) {
            applyClassification(response, ResultClassifier.compileFailure());
            diagnostics.add(diagnostic("error", "materialise-io",
                    "Failed to write generated project to a temp directory: " + e.getMessage()));
            response.put("build", failedBuild(diagnostics));
            response.put("execution", emptyExecution());
            response.put("tests", emptyTests());
            response.put("goldenMaster", Map.of());
            response.put("comparison", Map.of());
            response.put("diagnostics", diagnostics);
            response.put("outputRef", reference(response));
            return response;
        }

        try (materialised) {
            Path classOut = materialised.root().resolve("target/classes");

            // -- Compile -----------------------------------------------------
            JavaInMemoryCompiler.CompileResult compile =
                    JavaInMemoryCompiler.compile(materialised.javaSources(), classOut);
            Map<String, Object> buildSection = new LinkedHashMap<>();
            buildSection.put("compileOk", compile.ok());
            buildSection.put("sourceCount", compile.sourceCount());
            buildSection.put("fileCount", files.size());
            buildSection.put("diagnostics", compile.diagnostics());
            buildSection.put("classOutputDir", "target/classes");
            response.put("build", buildSection);
            diagnostics.addAll(compile.diagnostics());

            if (!compile.ok()) {
                applyClassification(response, ResultClassifier.compileFailure());
                response.put("execution", emptyExecution());
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
                response.put("outputRef", reference(response));
                return response;
            }

            // -- Execute -----------------------------------------------------
            GeneratedProgramRunner.RunResult run;
            if (skipExecution) {
                run = null;
                response.put("execution", Map.of(
                        "ran", false,
                        "skipped", true,
                        "reason", "options.skipExecution=true"));
            } else {
                run = GeneratedProgramRunner.run(classOut, entryClass, timeoutMs);
                response.put("execution", run.toMap());
                if (!run.ran()) {
                    applyClassification(response, ResultClassifier.runFailure(run.errorClass()));
                    diagnostics.add(diagnostic("error", "run-not-started",
                            run.errorMessage() == null ? "execution did not start" : run.errorMessage()));
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
                    response.put("outputRef", reference(response));
                    return response;
                }
                if (!run.ok()) {
                    applyClassification(response, ResultClassifier.runFailure(run.errorClass()));
                    diagnostics.add(diagnostic("error", "run-failed",
                            run.errorMessage() == null ? "generated program failed" : run.errorMessage()));
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
            } else if (run.ok()) {
                Map<String, Object> comparison = compareToGoldenMaster(run.stdout(), golden.get().expected());
                response.put("comparison", comparison);
                if (Boolean.TRUE.equals(comparison.get("matched"))) {
                    applyClassification(response, ResultClassifier.match());
                } else {
                    boolean known = golden.get().knownDivergenceAtW0();
                    applyClassification(response, ResultClassifier.divergence(known,
                            known
                                    ? "Generated stdout diverges from Golden Master; classified as a documented W0 generator coverage gap."
                                    : "Generated program output differs from Golden Master."));
                }
            }

            response.put("diagnostics", diagnostics);
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
            response.put("outputRef", reference(response));
            return response;
        }

        // Explicit user-supplied expected output is the paste-mode oracle.
        // Otherwise, the COBOL runtime must have produced the oracle stdout.
        String javaStdout = run == null ? "" : run.stdout();
        String expectedStdout = usingUserExpectedOutput ? expectedOutput : oracle.stdout();
        Map<String, Object> comparison = compareOutputs(
                javaStdout,
                expectedStdout,
                usingUserExpectedOutput ? "oracle.user-provided" : "oracle.cobol-runtime",
                usingUserExpectedOutput ? "user-provided-expected-output" : "cobol-oracle-stdout");
        response.put("comparison", comparison);
        if (Boolean.TRUE.equals(comparison.get("matched"))) {
            applyClassification(response, ResultClassifier.match());
        } else {
            applyClassification(response, ResultClassifier.divergence(false,
                    usingUserExpectedOutput
                            ? "Generated Java stdout diverges from user-supplied expected output."
                            : "Generated Java stdout diverges from COBOL oracle stdout."));
        }
        response.put("diagnostics", diagnostics);
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
            String javaStdout,
            String expectedStdout,
            String source,
            String expectedKind) {
        String left = normalise(javaStdout);
        String right = normalise(expectedStdout);
        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("matched", left.equals(right));
        comparison.put("normalisation", "trim+crlf-to-lf");
        comparison.put("source", source);
        comparison.put("actualSha256", HashUtil.sha256(javaStdout == null ? "" : javaStdout));
        comparison.put("expectedSha256", HashUtil.sha256(expectedStdout == null ? "" : expectedStdout));
        comparison.put("actualLength", javaStdout == null ? 0 : javaStdout.length());
        comparison.put("expectedLength", expectedStdout == null ? 0 : expectedStdout.length());
        comparison.put("actualRef", outputReference("java-stdout", javaStdout));
        comparison.put("expectedRef", outputReference(expectedKind, expectedStdout));
        if (!left.equals(right)) {
            comparison.put("diff", briefDiff(left, right));
        }
        return comparison;
    }

    private static Map<String, Object> compareToGoldenMaster(String actual, String expected) {
        String left = normalise(actual);
        String right = normalise(expected);
        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("matched", left.equals(right));
        comparison.put("normalisation", "trim+crlf-to-lf");
        comparison.put("actualSha256", HashUtil.sha256(actual == null ? "" : actual));
        comparison.put("expectedSha256", HashUtil.sha256(expected == null ? "" : expected));
        comparison.put("actualLength", actual == null ? 0 : actual.length());
        comparison.put("expectedLength", expected == null ? 0 : expected.length());
        comparison.put("actualRef", outputReference("java-stdout", actual));
        comparison.put("expectedRef", outputReference("golden-master-output", expected));
        if (!left.equals(right)) {
            comparison.put("diff", briefDiff(left, right));
        }
        return comparison;
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
        if (value == null) {
            return "";
        }
        return value.replace("\r\n", "\n").trim();
    }

    private static String briefDiff(String actual, String expected) {
        if (actual.isEmpty()) {
            return "actual is empty; expected " + expected.length() + " characters";
        }
        if (expected.isEmpty()) {
            return "expected is empty; actual " + actual.length() + " characters";
        }
        int common = 0;
        int max = Math.min(actual.length(), expected.length());
        while (common < max && actual.charAt(common) == expected.charAt(common)) {
            common++;
        }
        return "first divergence at character " + common
                + "; actualLength=" + actual.length()
                + " expectedLength=" + expected.length();
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
        String body = HashUtil.canonicalJson(response);
        String hash = HashUtil.sha256(body);
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("uri", "urn:" + SERVICE_NAME + "/build-test-result/" + hash);
        ref.put("sha256", hash);
        ref.put("byteSize", HashUtil.byteLength(body));
        ref.put("mimeType", "application/json");
        ref.put("kind", "build-test-result");
        return ref;
    }

    private static Map<String, Object> failedBuild(List<Map<String, Object>> diagnostics) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("compileOk", false);
        map.put("sourceCount", 0);
        map.put("fileCount", 0);
        map.put("diagnostics", diagnostics);
        return map;
    }

    private static Map<String, Object> emptyBuild() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("compileOk", false);
        map.put("sourceCount", 0);
        map.put("fileCount", 0);
        map.put("diagnostics", List.of());
        return map;
    }

    private static Map<String, Object> emptyExecution() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ran", false);
        map.put("ok", false);
        map.put("exitCode", -1);
        map.put("stdout", "");
        map.put("stderr", "");
        map.put("durationMs", 0);
        map.put("stdoutSha256", HashUtil.sha256(""));
        return map;
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

    private static Map<String, Object> newEnvelope(Map<String, Object> request, String programId) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", SCHEMA_VERSION);
        response.put("capability", CAPABILITY);
        response.put("service", SERVICE_NAME);
        response.put("runId", string(request.get("runId"), "run-unknown"));
        response.put("workflowId", string(request.get("workflowId"), "w0-migration-v0"));
        response.put("sourceRef", mapOrEmpty(request.get("sourceRef")));
        response.put("programId", programId);
        return response;
    }

    private static void applyClassification(Map<String, Object> response, Map<String, Object> result) {
        response.put("status", result.get("status"));
        response.put("classification", result.get("classification"));
        response.put("summary", result.get("summary"));
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
        Map<String, Object> diag = new LinkedHashMap<>();
        diag.put("severity", severity);
        diag.put("code", code);
        diag.put("message", message);
        return diag;
    }
}
