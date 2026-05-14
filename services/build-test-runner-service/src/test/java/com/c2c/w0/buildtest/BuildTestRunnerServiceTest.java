package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BuildTestRunnerServiceTest {

    private final BuildTestRunnerService service = new BuildTestRunnerService(repoRoot());

    @Test
    void okWhenStdoutMatchesInlineGoldenMaster() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.OkProgram",
                "package sample; public class OkProgram { "
                        + "public static void main(String[] a) { System.out.print(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-ok",
                "programId", "OK",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of("expected", "PASS\n", "classification", "synthetic"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("ok", response.get("status"));
        assertEquals("match", response.get("classification"));
        assertHashRefValid(response);
    }

    @Test
    void compileFailureProducesCompileFailedStatus() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.Broken",
                "package sample; public class Broken { public static void main(String[] a) { not_valid_java; } }");
        Map<String, Object> request = Map.of(
                "runId", "run-broken",
                "programId", "BROKEN",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of("expected", "x"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("compile-failed", response.get("status"));
        assertEquals("compile-error", response.get("classification"));
        Map<?, ?> build = (Map<?, ?>) response.get("build");
        assertEquals(false, build.get("compileOk"));
        assertFalse(((List<?>) build.get("diagnostics")).isEmpty());
    }

    @Test
    void runtimeExceptionProducesRunFailed() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.Boom2",
                "package sample; public class Boom2 { "
                        + "public static void main(String[] a) { throw new RuntimeException(\"boom\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-boom",
                "programId", "BOOM",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of("expected", "anything"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("run-failed", response.get("status"));
        assertEquals("run-error", response.get("classification"));
    }

    @Test
    void divergenceClassifiedAsKnownWhenFlagSet() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.SilentProgram",
                "package sample; public class SilentProgram { "
                        + "public static void main(String[] a) { /* no output */ } }");
        Map<String, Object> request = Map.of(
                "runId", "run-silent",
                "programId", "SILENT",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of(
                        "expected", "expected-line\n",
                        "classification", "synthetic",
                        "knownDivergenceAtW0", true));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-known-w0-coverage-gap", response.get("classification"));
    }

    @Test
    void divergenceClassifiedAsUnknownWhenFlagAbsentAndOutputNonEmpty() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.WrongOutput",
                "package sample; public class WrongOutput { "
                        + "public static void main(String[] a) { System.out.print(\"actually-wrong\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-wrong",
                "programId", "WRONG",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of(
                        "expected", "expected-different",
                        "classification", "synthetic"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-unknown", response.get("classification"));
    }

    @Test
    void missingGoldenMasterIsExplicitStatus() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.Lonely",
                "package sample; public class Lonely { "
                        + "public static void main(String[] a) { System.out.print(\"x\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-lonely",
                "programId", "PROGRAM-NOT-IN-REGISTRY",
                "generatedProject", generatedProject);
        Map<String, Object> response = service.runVerification(request);
        assertEquals("missing-golden-master", response.get("status"));
        assertEquals("missing-golden-master", response.get("classification"));
    }

    @Test
    void skipExecutionShortCircuitsRun() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.Skipped",
                "package sample; public class Skipped { "
                        + "public static void main(String[] a) { System.out.print(\"unused\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-skipped",
                "programId", "SKIPPED",
                "generatedProject", generatedProject,
                "options", Map.of("skipExecution", true),
                "goldenMaster", Map.of("expected", "x"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("skipped", response.get("status"));
        assertEquals("skipped-no-execution", response.get("classification"));
        Map<?, ?> execution = (Map<?, ?>) response.get("execution");
        assertEquals(true, execution.get("skipped"));
    }

    @Test
    void rejectsRequestsMissingProgramId() {
        assertThrows(IllegalArgumentException.class,
                () -> service.runVerification(Map.of("runId", "x")));
    }

    @Test
    void unwrapsGenerationResponseEnvelope() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.HelloEnv",
                "package sample; public class HelloEnv { "
                        + "public static void main(String[] a) { System.out.print(\"ENV\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-env",
                "programId", "ENV",
                "generationResponse", Map.of(
                        "status", "ok",
                        "generatedProject", generatedProject),
                "goldenMaster", Map.of("expected", "ENV"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("ok", response.get("status"));
        assertEquals("match", response.get("classification"));
    }

    @Test
    void resolvesBranchAccountGuardFromRegistryWithoutInlineHint() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.SilentBrnch",
                "package sample; public class SilentBrnch { "
                        + "public static void main(String[] a) { } }");
        Map<String, Object> request = Map.of(
                "runId", "run-brnch",
                "programId", "BRNCH01",
                "generatedProject", generatedProject);
        Map<String, Object> response = service.runVerification(request);
        // Empty actual vs non-empty COBOL expected output: divergence,
        // classified as known (registry sets knownDivergenceAtW0=true).
        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-known-w0-coverage-gap", response.get("classification"));
        Map<?, ?> golden = (Map<?, ?>) response.get("goldenMaster");
        assertEquals("synthetic", golden.get("classification"));
        assertTrue(((String) golden.get("source"))
                .endsWith("branch-account-guard-output.txt"));
    }

    private static void assertHashRefValid(Map<String, Object> response) {
        Map<?, ?> ref = (Map<?, ?>) response.get("outputRef");
        assertNotNull(ref);
        String sha = (String) ref.get("sha256");
        assertNotNull(sha);
        assertTrue(sha.matches("[0-9a-f]{64}"), "outputRef.sha256 must be a hex SHA-256");
    }

    private static Map<String, Object> trivialProject(String entryClass, String source) {
        String relativePath = "src/main/java/" + entryClass.replace('.', '/') + ".java";
        return Map.of(
                "entryClass", entryClass,
                "entryFilePath", relativePath,
                "files", Map.of(relativePath, source));
    }

    private static Path repoRoot() {
        Path current = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 6; i++) {
            if (Files.exists(current.resolve("fixtures/golden-master/index.json"))) {
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
