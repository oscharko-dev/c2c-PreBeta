package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.io.IOException;
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
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Issue #92 — executable COBOL oracle for UI-provided source.
 *
 * <p>Verifies that requests containing {@code oracle.mode = "cobol-runtime"}
 * cause the build-test runner to compile and execute the supplied COBOL with
 * GnuCOBOL and to compare its stdout against generated Java stdout, while the
 * existing registry Golden Master path is preserved when no oracle is
 * supplied.
 */
class CobolOracleTest {

    // Free-format COBOL (no fixed-column leading whitespace) so cobc handles
    // it the same way across GnuCOBOL 3.1.x and 3.2.x — see Issue #92 CI
    // failure on cobc 3.1.2 which rejected the fixed-format header at
    // column 7. The runtime detects free vs fixed and passes
    // -fsource-format= accordingly.
    private static final String COBOL_PRINT_PASS = String.join("\n",
            "IDENTIFICATION DIVISION.",
            "PROGRAM-ID. PASSPRG.",
            "PROCEDURE DIVISION.",
            "    DISPLAY \"PASS\".",
            "    STOP RUN.",
            "");

    private static final String COBOL_PRINT_HELLO = String.join("\n",
            "IDENTIFICATION DIVISION.",
            "PROGRAM-ID. HELLOPRG.",
            "PROCEDURE DIVISION.",
            "    DISPLAY \"HELLO\".",
            "    STOP RUN.",
            "");

    private static final String COBOL_ACCEPT_INPUT = String.join("\n",
            "IDENTIFICATION DIVISION.",
            "PROGRAM-ID. INPRG.",
            "DATA DIVISION.",
            "WORKING-STORAGE SECTION.",
            "01 WS-IN PIC X(16).",
            "PROCEDURE DIVISION.",
            "    ACCEPT WS-IN.",
            "    DISPLAY WS-IN.",
            "    STOP RUN.",
            "");

    private static final String COBOL_BROKEN = String.join("\n",
            "IDENTIFICATION DIVISION.",
            "PROGRAM-ID. BROKENPR.",
            "PROCEDURE DIVISION.",
            "    MOVE \"x\" TO UNDECLARED-VARIABLE-XYZ.",
            "    STOP RUN.",
            "");

    private static final String COBOL_FIXED_FORMAT_PASS = String.join("\n",
            "       IDENTIFICATION DIVISION.",
            "       PROGRAM-ID. FIXEDPRG.",
            "       PROCEDURE DIVISION.",
            "           DISPLAY \"PASS\".",
            "           STOP RUN.",
            "");

    private static final Path REPO_ROOT = repoRoot();

    private final BuildTestRunnerService service = new BuildTestRunnerService(REPO_ROOT);

    @Test
    void oracleMatchesWhenJavaStdoutEqualsCobolStdout() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for oracle equivalence");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleMatch",
                "package sample; public class OracleMatch { "
                        + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-match",
                "programId", "PASSPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_PRINT_PASS,
                        "sourceRef", Map.of(
                                "uri", "urn:test/oracle-match",
                                "sha256", "0000000000000000000000000000000000000000000000000000000000000000",
                                "byteSize", COBOL_PRINT_PASS.length()),
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("ok", response.get("status"),
                () -> "expected ok status; response=" + response);
        assertEquals("match", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertNotNull(oracle);
        assertEquals("cobol-runtime", oracle.get("mode"));
        assertEquals(true, oracle.get("attempted"));
        assertEquals(true, oracle.get("available"));
        assertEquals(true, oracle.get("compileOk"));
        assertEquals(true, oracle.get("ran"));
        assertEquals(true, oracle.get("runOk"));
        assertEquals("PASSPRG", oracle.get("moduleName"));
        assertTrue(((String) oracle.get("stdoutSha256")).matches("[0-9a-f]{64}"));
        Map<?, ?> sourceRef = (Map<?, ?>) oracle.get("sourceRef");
        assertEquals("urn:test/oracle-match", sourceRef.get("uri"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(true, comparison.get("matched"));
        assertEquals("oracle.cobol-runtime", comparison.get("source"));
        assertEquals("java-stdout", ((Map<?, ?>) comparison.get("actualRef")).get("kind"));
        assertEquals("cobol-oracle-stdout", ((Map<?, ?>) comparison.get("expectedRef")).get("kind"));
        Map<?, ?> goldenMaster = (Map<?, ?>) response.get("goldenMaster");
        assertEquals(false, goldenMaster.get("resolved"),
                "registry Golden Master must not be consulted when an oracle is supplied");
    }

    @Test
    void helloW02AcceptanceFixtureOracleMatchesCheckedInExpectedOutput() throws Exception {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for HELLOW02 oracle acceptance");
        String source = readRepoFixture("corpus/synthetic/programs/hello-w02.cbl");
        String expected = readRepoFixture("corpus/synthetic/fixtures/hello-w02-output.txt");
        Map<String, Object> generatedProject = trivialProject(
                "sample.HelloW02Acceptance",
                "package sample; public class HelloW02Acceptance { "
                        + "public static void main(String[] a) { System.out.print("
                        + javaStringLiteral(expected) + "); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-hello-w02-oracle",
                "programId", "HELLOW02",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", source,
                        "sourceRef", Map.of(
                                "uri", "fixture://corpus/synthetic/programs/hello-w02.cbl",
                                "sha256", "061074d14470643e3a8333a742ff0f5d4ea6285048d3b88e31f6ae0170ba231e",
                                "byteSize", source.length()),
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("ok", response.get("status"),
                () -> "HELLOW02 fixture oracle must match; response=" + response);
        assertEquals("match", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertEquals(expected, oracle.get("stdout"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(true, comparison.get("matched"));
        assertEquals(((Map<?, ?>) comparison.get("actualRef")).get("sha256"), comparison.get("actualSha256"));
        assertEquals(((Map<?, ?>) comparison.get("expectedRef")).get("sha256"), comparison.get("expectedSha256"));
    }

    @Test
    void oracleDivergenceWhenJavaStdoutDiffersFromCobolStdout() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for oracle equivalence");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleDiverge",
                "package sample; public class OracleDiverge { "
                        + "public static void main(String[] a) { System.out.println(\"DIFFERENT\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-diverge",
                "programId", "HELLOPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_PRINT_HELLO,
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-unknown", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertEquals(true, oracle.get("runOk"));
        assertTrue(((String) oracle.get("stdout")).startsWith("HELLO"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(false, comparison.get("matched"));
        assertEquals("oracle.cobol-runtime", comparison.get("source"));
        assertNotNull(comparison.get("diff"));
    }

    @Test
    void userProvidedExpectedOutputOverridesCobolStdoutForPasteModeOracle() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.UserExpectedMismatch",
                "package sample; public class UserExpectedMismatch { "
                        + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-user-expected-mismatch",
                "programId", "PASSPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_PRINT_PASS,
                        "expectedOutput", "FAIL\n",
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("output-divergence", response.get("status"));
        assertEquals("divergence-unknown", response.get("classification"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(false, comparison.get("matched"));
        assertEquals("oracle.user-provided", comparison.get("source"));
        assertEquals("user-provided-expected-output", ((Map<?, ?>) comparison.get("expectedRef")).get("kind"));
        assertEquals("java-stdout", ((Map<?, ?>) comparison.get("actualRef")).get("kind"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertEquals("user-provided", oracle.get("mode"));
        assertEquals(false, oracle.get("attempted"),
                "explicit expectedOutput must not require executing the COBOL runtime");
    }

    @Test
    void oracleInputIsPassedToCobolRuntime() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for oracle stdin verification");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleInputMatch",
                "package sample; public class OracleInputMatch { "
                        + "public static void main(String[] a) { System.out.println(\"ECHO\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-input-match",
                "programId", "INPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_ACCEPT_INPUT,
                        "oracleInput", "ECHO\n",
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("ok", response.get("status"),
                () -> "expected oracle stdin path to match; response=" + response);
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertTrue(((String) oracle.get("stdout")).startsWith("ECHO"));
        assertTrue(((String) oracle.get("oracleInputSha256")).matches("[0-9a-f]{64}"));
    }

    @Test
    void oracleUnavailableWhenToolchainMissing() {
        String previousCobc = System.getProperty("c2c.cobc.path");
        String previousCobcrun = System.getProperty("c2c.cobcrun.path");
        System.setProperty("c2c.cobc.path", "__missing_cobc_for_test__");
        System.setProperty("c2c.cobcrun.path", "__missing_cobcrun_for_test__");
        try {
            Map<String, Object> generatedProject = trivialProject(
                    "sample.OracleUnavail",
                    "package sample; public class OracleUnavail { "
                            + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
            Map<String, Object> request = Map.of(
                    "runId", "run-oracle-unavail",
                    "programId", "PASSPRG",
                    "generatedProject", generatedProject,
                    "oracle", Map.of(
                            "mode", "cobol-runtime",
                            "sourceText", COBOL_PRINT_PASS));

            Map<String, Object> response = service.runVerification(request);

            assertEquals("oracle-unavailable", response.get("status"));
            assertEquals("oracle-unavailable", response.get("classification"));
            Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
            assertEquals(true, oracle.get("attempted"));
            assertEquals(false, oracle.get("available"));
            assertEquals(false, oracle.get("runOk"));
            Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
            assertEquals(false, comparison.get("matched"));
            assertEquals("oracle-unavailable", comparison.get("reason"));
            List<?> diagnostics = (List<?>) response.get("diagnostics");
            assertTrue(diagnostics.stream()
                    .map(d -> ((Map<?, ?>) d).get("code"))
                    .anyMatch("oracle-unavailable"::equals));
        } finally {
            restoreProperty("c2c.cobc.path", previousCobc);
            restoreProperty("c2c.cobcrun.path", previousCobcrun);
        }
    }

    @Test
    void userProvidedExpectedOutputDoesNotRequireCobolRuntime() {
        String previousCobc = System.getProperty("c2c.cobc.path");
        String previousCobcrun = System.getProperty("c2c.cobcrun.path");
        System.setProperty("c2c.cobc.path", "__missing_cobc_for_test__");
        System.setProperty("c2c.cobcrun.path", "__missing_cobcrun_for_test__");
        try {
            Map<String, Object> generatedProject = trivialProject(
                    "sample.UserExpectedNoRuntime",
                    "package sample; public class UserExpectedNoRuntime { "
                            + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
            Map<String, Object> request = Map.of(
                    "runId", "run-user-expected-no-runtime",
                    "programId", "PASSPRG",
                    "generatedProject", generatedProject,
                    "oracle", Map.of(
                            "mode", "cobol-runtime",
                            "sourceText", COBOL_PRINT_PASS,
                            "expectedOutput", "PASS\n"));

            Map<String, Object> response = service.runVerification(request);

            assertEquals("ok", response.get("status"),
                    () -> "explicit expectedOutput should not require GnuCOBOL; response=" + response);
            assertEquals("match", response.get("classification"));
            Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
            assertEquals("user-provided", oracle.get("mode"));
            assertEquals(false, oracle.get("attempted"));
            Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
            assertEquals(true, comparison.get("matched"));
            assertEquals("oracle.user-provided", comparison.get("source"));
        } finally {
            restoreProperty("c2c.cobc.path", previousCobc);
            restoreProperty("c2c.cobcrun.path", previousCobcrun);
        }
    }

    @Test
    void oracleCobolCompileFailureIsExplicit() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for oracle compile-failure verification");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleBadCobol",
                "package sample; public class OracleBadCobol { "
                        + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-bad-cobol",
                "programId", "BROKENPR",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_BROKEN,
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("oracle-cobol-compile-failed", response.get("status"));
        assertEquals("oracle-cobol-compile-error", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertEquals(true, oracle.get("attempted"));
        assertEquals(true, oracle.get("available"));
        assertEquals(false, oracle.get("compileOk"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(false, comparison.get("matched"));
    }

    @Test
    void oracleJavaCompileFailureIsExplicit() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleBadJava",
                "package sample; public class OracleBadJava { "
                        + "public static void main(String[] a) { this_is_not_java; } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-bad-java",
                "programId", "PASSPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_PRINT_PASS,
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("compile-failed", response.get("status"));
        assertEquals("compile-error", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertNotNull(oracle);
        assertEquals(false, oracle.get("attempted"));
        assertFalse(((String) oracle.get("reason")).isBlank());
        Map<?, ?> goldenMaster = (Map<?, ?>) response.get("goldenMaster");
        assertEquals(false, goldenMaster.get("resolved"),
                "oracle requests must not silently fall back to the Golden Master registry");
    }

    @Test
    void oracleJavaRuntimeFailureNeverFabricatesMatch() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleBoom",
                "package sample; public class OracleBoom { "
                        + "public static void main(String[] a) { "
                        + "System.out.print(\"PASS\"); "
                        + "throw new RuntimeException(\"boom\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-boom",
                "programId", "PASSPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_PRINT_PASS,
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("run-failed", response.get("status"));
        assertEquals("run-error", response.get("classification"));
        Map<?, ?> comparison = (Map<?, ?>) response.get("comparison");
        assertEquals(false, comparison.get("matched"),
                "a Java runtime exception must never produce a match against the oracle");
    }

    @Test
    void oracleRejectsEmptySourceText() {
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleEmpty",
                "package sample; public class OracleEmpty { "
                        + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-empty",
                "programId", "PASSPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", "",
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("oracle-invalid", response.get("status"));
        assertEquals("oracle-invalid-request", response.get("classification"));
        Map<?, ?> oracle = (Map<?, ?>) response.get("oracle");
        assertEquals(false, oracle.get("attempted"));
    }

    @Test
    void oracleAlsoAcceptsFixedFormatSource() {
        assumeTrue(CobolRuntimeExecutor.isAvailable(),
                "GnuCOBOL cobc/cobcrun must be installed for fixed-format oracle");
        Map<String, Object> generatedProject = trivialProject(
                "sample.OracleFixed",
                "package sample; public class OracleFixed { "
                        + "public static void main(String[] a) { System.out.println(\"PASS\"); } }");
        Map<String, Object> request = Map.of(
                "runId", "run-oracle-fixed",
                "programId", "FIXEDPRG",
                "generatedProject", generatedProject,
                "oracle", Map.of(
                        "mode", "cobol-runtime",
                        "sourceText", COBOL_FIXED_FORMAT_PASS,
                        "timeoutMs", 5000));

        Map<String, Object> response = service.runVerification(request);

        assertEquals("ok", response.get("status"),
                () -> "fixed-format oracle should still match; response=" + response);
        assertEquals("match", response.get("classification"));
    }

    @Test
    void formatHeuristicIdentifiesFreeAndFixedSources() {
        assertTrue(CobolRuntimeExecutor.looksLikeFixedFormatCobol(COBOL_FIXED_FORMAT_PASS),
                "7-leading-space header must be detected as fixed format");
        assertFalse(CobolRuntimeExecutor.looksLikeFixedFormatCobol(COBOL_PRINT_PASS),
                "column-1 header must be detected as free format");
        assertFalse(CobolRuntimeExecutor.looksLikeFixedFormatCobol(""),
                "empty source is not fixed format");
        assertFalse(CobolRuntimeExecutor.looksLikeFixedFormatCobol(null),
                "null source is not fixed format");
    }

    @Test
    void absentOraclePreservesRegistryGoldenMaster() {
        // Sanity: when oracle is omitted, the runner must still consult the
        // registry Golden Master. Reuse the corpus BRNCH01 fixture; the Java
        // stdout is intentionally wrong so the existing classifier returns
        // divergence-unknown (or known if the fixture is flagged).
        Map<String, Object> generatedProject = trivialProject(
                "sample.NoOracle",
                "package sample; public class NoOracle { "
                        + "public static void main(String[] a) { /* no output */ } }");
        Map<String, Object> request = Map.of(
                "runId", "run-no-oracle",
                "programId", "BRNCH01",
                "generatedProject", generatedProject);

        Map<String, Object> response = service.runVerification(request);

        assertFalse(response.containsKey("oracle"),
                "oracle block must not appear when the request does not request one");
        Map<?, ?> goldenMaster = (Map<?, ?>) response.get("goldenMaster");
        assertEquals("BRNCH01", goldenMaster.get("programId"));
    }

    @Test
    void goldenMasterExpectedRefRejectsSymlinkEscape() throws Exception {
        Path root = Files.createTempDirectory("c2c-golden-master-root-");
        Path external = Files.createTempFile("c2c-golden-master-external-", ".txt");
        try {
            Files.writeString(external, "SECRET\n");
            Path link = root.resolve("fixtures/link.txt");
            Files.createDirectories(link.getParent());
            Files.createSymbolicLink(link, external);

            Map<String, Object> hint = Map.of(
                    "expectedRef", Map.of("path", "fixtures/link.txt"));

            assertThrows(IllegalArgumentException.class,
                    () -> GoldenMaster.resolve("ESCAPE", hint, root));
        } finally {
            Files.deleteIfExists(root.resolve("fixtures/link.txt"));
            Files.deleteIfExists(root.resolve("fixtures"));
            Files.deleteIfExists(root);
            Files.deleteIfExists(external);
        }
    }

    private static Map<String, Object> trivialProject(String entryClass, String source) {
        String relativePath = "src/main/java/" + entryClass.replace('.', '/') + ".java";
        return Map.of(
                "entryClass", entryClass,
                "entryFilePath", relativePath,
                "files", Map.of(relativePath, source));
    }

    private static String readRepoFixture(String relativePath) throws IOException {
        return Files.readString(REPO_ROOT.resolve(relativePath));
    }

    private static String javaStringLiteral(String value) {
        return "\"" + value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                + "\"";
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
