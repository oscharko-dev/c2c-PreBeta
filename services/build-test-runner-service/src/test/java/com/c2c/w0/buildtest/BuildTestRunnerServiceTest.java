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
        Map<String, Object> generatedArtifactRef = Map.of(
                "uri", "urn:test/generated-ok",
                "sha256", "a".repeat(64),
                "byteSize", 123,
                "kind", "generated-java-project");
        Map<String, Object> sourceRef = Map.of(
                "uri", "urn:test/source-ok",
                "sha256", "b".repeat(64),
                "byteSize", 321,
                "kind", "source-cobol");
        Map<String, Object> request = Map.of(
                "runId", "run-ok",
                "programId", "OK",
                "generatedProject", generatedProject,
                "generatedArtifactRef", generatedArtifactRef,
                "sourceRef", sourceRef,
                "goldenMaster", Map.of("expected", "PASS\n", "classification", "synthetic"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("ok", response.get("status"));
        assertEquals("match", response.get("classification"));
        assertEquals(generatedArtifactRef, response.get("generatedArtifactRef"));
        assertEquals(sourceRef, response.get("inputArtifactRef"));
        Map<?, ?> build = (Map<?, ?>) response.get("build");
        Map<?, ?> buildResult = (Map<?, ?>) response.get("buildResult");
        assertEquals("v0", build.get("schemaVersion"));
        assertEquals("generated-java", build.get("buildMode"));
        assertEquals("passed", build.get("status"));
        assertEquals(generatedArtifactRef, build.get("inputArtifactRef"));
        assertNotNull(build.get("buildOutputRef"));
        assertNotNull(build.get("logRef"));
        assertFalse(((List<?>) build.get("evidenceRefs")).isEmpty());
        assertEquals("generated-java", buildResult.get("buildMode"));
        assertEquals(false, buildResult.containsKey("compileOk"));
        assertEquals(false, buildResult.containsKey("classOutputDir"));
        Map<?, ?> execution = (Map<?, ?>) response.get("execution");
        Map<?, ?> executionResult = (Map<?, ?>) response.get("executionResult");
        assertEquals("v0", execution.get("schemaVersion"));
        assertEquals("generated-java", execution.get("executionSurface"));
        assertEquals("passed", execution.get("status"));
        assertEquals(sourceRef, execution.get("inputArtifactRef"));
        assertEquals(generatedArtifactRef, execution.get("generatedArtifactRef"));
        assertNotNull(execution.get("stdoutRef"));
        assertNotNull(execution.get("stderrRef"));
        assertNotNull(execution.get("normalizedOutputRef"));
        assertNotNull(execution.get("logRef"));
        assertFalse(((List<?>) execution.get("evidenceRefs")).isEmpty());
        assertEquals("generated-java", executionResult.get("executionSurface"));
        assertEquals(false, executionResult.containsKey("stdout"));
        assertEquals(false, executionResult.containsKey("ok"));
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
        assertEquals("failed", build.get("status"));
        assertFalse(((List<?>) build.get("diagnostics")).isEmpty());
        Map<?, ?> diagnostic = (Map<?, ?>) ((List<?>) build.get("diagnostics")).get(0);
        assertEquals("error", diagnostic.get("severity"));
        assertNotNull(diagnostic.get("filePath"));
        assertNotNull(diagnostic.get("line"));
        assertNotNull(diagnostic.get("column"));
        assertNotNull(diagnostic.get("message"));
        assertNotNull(diagnostic.get("rawLogRef"));
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
        Map<?, ?> execution = (Map<?, ?>) response.get("execution");
        assertEquals("failed", execution.get("status"));
        Map<?, ?> diagnostic = (Map<?, ?>) ((List<?>) execution.get("diagnostics")).get(0);
        assertNotNull(diagnostic.get("rawLogRef"));
        assertNotNull(execution.get("summary"));
        assertFalse(String.valueOf(execution.get("summary")).contains("\n"));
    }

    @Test
    void multiFileProjectCompilesAndRuns() {
        Map<String, Object> generatedProject = Map.of(
                "entryClass", "sample.MultiMain",
                "entryFilePath", "src/main/java/sample/MultiMain.java",
                "files", Map.of(
                        "src/main/java/sample/MultiMain.java",
                        "package sample; public class MultiMain { "
                                + "public static void main(String[] a) { System.out.print(Helper.value()); } }",
                        "src/main/java/sample/Helper.java",
                        "package sample; final class Helper { static String value() { return \"MULTI\"; } }"));
        Map<String, Object> request = Map.of(
                "runId", "run-multi",
                "programId", "MULTI",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of("expected", "MULTI", "classification", "synthetic"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("ok", response.get("status"));
        assertEquals("match", response.get("classification"));
        Map<?, ?> build = (Map<?, ?>) response.get("build");
        assertEquals(2, build.get("fileCount"));
        assertEquals(2, build.get("sourceCount"));
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
    void registryDivergenceIsUnknownForTrueFixtureWithoutKnownGap() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.SilentCtrlDec",
                "package sample; public class SilentCtrlDec { "
                        + "public static void main(String[] a) { } }");
        Map<String, Object> request = Map.of(
                "runId", "run-ctrldec",
                "programId", "CTRLDEC01",
                "generatedProject", generatedProject);
        Map<String, Object> response = service.runVerification(request);
        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-unknown", response.get("classification"));
        Map<?, ?> golden = (Map<?, ?>) response.get("goldenMaster");
        assertEquals("true", golden.get("classification"));
        assertTrue(((String) golden.get("source"))
                .endsWith("ctrl-decimal-payroll-output.txt"));
    }

    @Test
    void trueGoldenMasterMissingSourceIsReproductionError() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.TrueFixture",
                "package sample; public class TrueFixture { "
                        + "public static void main(String[] a) { System.out.print(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-true-missing-source",
                "programId", "TRUEFAIL",
                "generatedProject", generatedProject,
                "goldenMaster", Map.of(
                        "expected", "PASS",
                        "classification", "true",
                        "cobolSource", "corpus/synthetic/programs/does-not-exist.cbl"));
        Map<String, Object> response = service.runVerification(request);
        assertEquals("golden-master-reproduction-failed", response.get("status"));
        assertEquals("true-golden-master-reproduction-error", response.get("classification"));
        Map<?, ?> golden = (Map<?, ?>) response.get("goldenMaster");
        assertEquals("true", golden.get("classification"));
        Map<?, ?> cobolRuntime = (Map<?, ?>) golden.get("cobolRuntime");
        assertNotNull(cobolRuntime);
        assertEquals(true, cobolRuntime.get("attempted"));
        assertEquals(false, cobolRuntime.get("ok"));
    }

    @Test
    void trueGoldenMasterUnavailableToolchainIsReproductionError() {
        String previousCobc = System.getProperty("c2c.cobc.path");
        String previousCobcrun = System.getProperty("c2c.cobcrun.path");
        System.setProperty("c2c.cobc.path", "__missing_cobc_for_test__");
        System.setProperty("c2c.cobcrun.path", "__missing_cobcrun_for_test__");
        try {
            Map<String, Object> generatedProject = trivialProject(
                    "sample.TrueFixtureUnavailable",
                    "package sample; public class TrueFixtureUnavailable { "
                            + "public static void main(String[] a) { System.out.print(\"PASS\"); } }");
            Map<String, Object> request = Map.of(
                    "runId", "run-true-unavailable",
                    "programId", "TRUEUNAVAILABLE",
                    "generatedProject", generatedProject,
                    "goldenMaster", Map.of(
                            "expected", "PASS",
                            "classification", "true",
                            "cobolSource", "corpus/synthetic/programs/branch-account-guard.cbl"));
            Map<String, Object> response = service.runVerification(request);
            assertEquals("golden-master-reproduction-failed", response.get("status"));
            assertEquals("true-golden-master-reproduction-error", response.get("classification"));
            Map<?, ?> golden = (Map<?, ?>) response.get("goldenMaster");
            Map<?, ?> cobolRuntime = (Map<?, ?>) golden.get("cobolRuntime");
            assertEquals(false, cobolRuntime.get("available"));
            assertEquals(false, cobolRuntime.get("ok"));
        } finally {
            restoreProperty("c2c.cobc.path", previousCobc);
            restoreProperty("c2c.cobcrun.path", previousCobcrun);
        }
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

    private static void restoreProperty(String key, String previous) {
        if (previous == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, previous);
        }
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
