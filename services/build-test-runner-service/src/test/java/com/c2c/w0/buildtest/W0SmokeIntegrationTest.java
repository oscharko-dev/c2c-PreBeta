package com.c2c.w0.buildtest;

import com.c2c.w0.targetjava.TargetJavaGenerationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * End-to-end W0 smoke verification: for each of the four W0 corpus IR
 * fixtures, run target-java-generation-service to obtain a Java project, hand
 * it to build-test-runner-service, and assert the build/run path completes
 * with a registered Golden Master comparison.
 * <p>
 * Generation is expected to succeed, compile cleanly, execute, and match the
 * Golden Master fixtures for the W0 arithmetic/control-flow subset. Fixtures
 * classified as {@code true} must also reproduce through GnuCOBOL.
 */
class W0SmokeIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long CI_SAFE_GNUCOBOL_TIMEOUT_MS = 15_000L;

    private final BuildTestRunnerService runner = new BuildTestRunnerService(repoRoot());
    private final TargetJavaGenerationService generator = new TargetJavaGenerationService();

    @Test
    void brnch01EndToEnd() throws Exception {
        runFixture("fixtures/semantic-ir/branch-account-guard.ir.json", "BRNCH01");
    }

    @Test
    void ctrldec01EndToEnd() throws Exception {
        runFixture("fixtures/semantic-ir/ctrl-decimal-payroll.ir.json", "CTRLDEC01");
    }

    @Test
    void arith01EndToEnd() throws Exception {
        runFixture("fixtures/semantic-ir/arithmetic-adjustment-ledger.ir.json", "ARITH01");
    }

    @Test
    void batch01EndToEnd() throws Exception {
        runFixture("fixtures/semantic-ir/decimal-batch-aggregator.ir.json", "BATCH01");
    }

    @Test
    void allFourProgramsProduceHashReferencedResults() throws Exception {
        for (String[] entry : new String[][]{
                {"fixtures/semantic-ir/branch-account-guard.ir.json", "BRNCH01"},
                {"fixtures/semantic-ir/arithmetic-adjustment-ledger.ir.json", "ARITH01"},
                {"fixtures/semantic-ir/ctrl-decimal-payroll.ir.json", "CTRLDEC01"},
                {"fixtures/semantic-ir/decimal-batch-aggregator.ir.json", "BATCH01"},
        }) {
            Map<String, Object> result = runFixture(entry[0], entry[1]);
            Map<?, ?> outputRef = (Map<?, ?>) result.get("outputRef");
            assertNotNull(outputRef, "outputRef must be present for " + entry[1]);
            String sha = (String) outputRef.get("sha256");
            assertTrue(sha != null && sha.matches("[0-9a-f]{64}"),
                    "outputRef.sha256 must be hex SHA-256 for " + entry[1]);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> runFixture(String relativePath, String programId) throws Exception {
        Path repo = repoRoot();
        Path fixture = repo.resolve(relativePath);
        assertTrue(Files.exists(fixture), "fixture not found: " + fixture);
        if ("true".equals(expectedGoldenClassification(programId))) {
            assumeTrue(CobolRuntimeExecutor.isAvailable(),
                    "GnuCOBOL cobc/cobcrun must be installed for true Golden Master verification");
        }

        Map<String, Object> ir = JSON.readValue(Files.readString(fixture), Map.class);
        Map<String, Object> generation = generator.generate(Map.of(
                "runId", "run-smoke-" + programId,
                "ir", ir));
        assertEquals("ok", generation.get("status"),
                "generation must succeed for " + programId + ": " + generation.get("diagnostics"));

        Map<String, Object> request = new LinkedHashMap<>();
        request.put("runId", "run-smoke-" + programId);
        request.put("workflowId", "w0-build-test-smoke");
        request.put("programId", programId);
        request.put("generationResponse", generation);
        request.put("options", Map.of("timeoutMs", CI_SAFE_GNUCOBOL_TIMEOUT_MS));
        Map<String, Object> result = runner.runVerification(request);

        // Build must succeed: the W0 generator emits compilable Java.
        Map<?, ?> build = (Map<?, ?>) result.get("build");
        assertEquals(true, build.get("compileOk"),
                "compile failed for " + programId + ": " + build.get("diagnostics"));

        Map<?, ?> golden = (Map<?, ?>) result.get("goldenMaster");
        assertNotNull(golden, "goldenMaster section must be present for " + programId);
        assertEquals(expectedGoldenClassification(programId), golden.get("classification"),
                "unexpected Golden Master classification for " + programId);
        assertEquals(false, golden.get("knownDivergenceAtW0"),
                "W0 entry should no longer declare a known generator divergence for " + programId);
        if ("true".equals(golden.get("classification"))) {
            Map<?, ?> cobolRuntime = (Map<?, ?>) golden.get("cobolRuntime");
            assertNotNull(cobolRuntime, "true Golden Master must include cobcrun verification for " + programId);
            assertEquals(true, cobolRuntime.get("available"),
                    "GnuCOBOL must be available for true Golden Master verification");
            assertEquals(true, cobolRuntime.get("compileOk"),
                    "cobc must compile the true Golden Master for " + programId + ": " + cobolRuntime);
            assertEquals(true, cobolRuntime.get("ran"),
                    "cobcrun must execute the true Golden Master for " + programId + ": " + cobolRuntime);
            assertEquals(true, cobolRuntime.get("matched"),
                    "cobcrun stdout must match the checked-in fixture for " + programId + ": " + cobolRuntime);
        }

        Object classification = result.get("classification");
        assertEquals("match", String.valueOf(classification),
                "unexpected classification for " + programId + ": "
                        + classification + " (status=" + result.get("status")
                        + ", summary=" + result.get("summary") + ")");

        Map<?, ?> execution = (Map<?, ?>) result.get("execution");
        assertEquals(true, execution.get("ran"),
                "generated program should execute for " + programId);
        assertNotNull(execution.get("stdoutSha256"));

        return result;
    }

    private static String expectedGoldenClassification(String programId) {
        return "BRNCH01".equals(programId) ? "true" : "synthetic";
    }

    private static Path repoRoot() {
        Path current = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 6; i++) {
            if (Files.exists(current.resolve("fixtures/golden-master/index.json"))
                    && Files.exists(current.resolve("libs/c2c-target-java-runtime"))) {
                return current;
            }
            Path parent = current.getParent();
            if (parent == null) {
                break;
            }
            current = parent;
        }
        throw new AssertionError("Could not locate repository root from " + Paths.get("").toAbsolutePath());
    }
}
