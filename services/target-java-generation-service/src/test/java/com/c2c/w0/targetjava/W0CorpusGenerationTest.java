package com.c2c.w0.targetjava;

import com.c2c.target.java.runtime.AssumptionRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class W0CorpusGenerationTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private final TargetJavaGenerationService service = new TargetJavaGenerationService();

    @Test
    void generatedJavaCompilesForBranchAccountGuard() throws Exception {
        runFixture("fixtures/semantic-ir/branch-account-guard.ir.json", "BRNCH01");
    }

    @Test
    void generatedJavaCompilesForCtrlDecimalPayroll() throws Exception {
        runFixture("fixtures/semantic-ir/ctrl-decimal-payroll.ir.json", "CTRLDEC01");
    }

    @Test
    void generatedProjectBuildsWithMavenLifecycle() throws Exception {
        Path repoRoot = findRepoRoot();
        Path fixture = repoRoot.resolve("fixtures/semantic-ir/branch-account-guard.ir.json");
        @SuppressWarnings("unchecked")
        Map<String, Object> ir = JSON.readValue(Files.readString(fixture), Map.class);

        Map<String, Object> response = service.generate(Map.of("runId", "run-corpus-lifecycle", "ir", ir));
        assertEquals("ok", response.get("status"));

        @SuppressWarnings("unchecked")
        Map<String, Object> generated = (Map<String, Object>) response.get("generatedProject");
        @SuppressWarnings("unchecked")
        Map<String, String> files = (Map<String, String>) generated.get("files");

        Path projectDir = Files.createTempDirectory("c2c-generated-project-");
        try {
            writeGeneratedProject(projectDir, files);
            runMavenPackage(projectDir);
        } finally {
            deleteRecursively(projectDir);
        }
    }

    @Test
    void runtimeImportIsPresentAndAssumptionRegistryUsable() throws Exception {
        Path repoRoot = findRepoRoot();
        Path fixture = repoRoot.resolve("fixtures/semantic-ir/branch-account-guard.ir.json");
        @SuppressWarnings("unchecked")
        Map<String, Object> ir = JSON.readValue(Files.readString(fixture), Map.class);

        Map<String, Object> response = service.generate(Map.of("runId", "run-corpus", "ir", ir));
        assertEquals("ok", response.get("status"));

        // Sanity-check that an AssumptionRegistry from the runtime is usable in this test
        // — this confirms the runtime is on the test classpath, which is what the
        // generated code will rely on.
        AssumptionRegistry registry = new AssumptionRegistry();
        registry.record("a-1", "n-1", AssumptionRegistry.Severity.INFO, "smoke");
        assertEquals(1, registry.size());
    }

    private void runFixture(String relativePath, String expectedProgramId) throws Exception {
        Path repoRoot = findRepoRoot();
        Path fixture = repoRoot.resolve(relativePath);
        assertTrue(Files.exists(fixture), "fixture not found: " + fixture);

        @SuppressWarnings("unchecked")
        Map<String, Object> ir = JSON.readValue(Files.readString(fixture), Map.class);

        Map<String, Object> response = service.generate(Map.of(
                "runId", "run-corpus-" + expectedProgramId,
                "ir", ir));

        assertEquals("ok", response.get("status"),
                "generation failed for " + expectedProgramId + ": " + response.get("diagnostics"));

        Map<?, ?> generated = (Map<?, ?>) response.get("generatedProject");
        @SuppressWarnings("unchecked")
        Map<String, String> files = (Map<String, String>) generated.get("files");
        String entryFilePath = generated.get("entryFilePath").toString();
        String javaSource = files.get(entryFilePath);
        assertNotNull(javaSource);

        // c2c-trace.json must be parseable and reference the IR.
        String trace = files.get("src/main/resources/c2c-trace.json");
        assertNotNull(trace);
        Map<?, ?> traceJson = JSON.readValue(trace, Map.class);
        assertEquals(expectedProgramId, traceJson.get("programId"));
        assertEquals(ir.get("irId"), traceJson.get("irId"));

        // Compile the generated Java in-memory against the test classpath
        // (which includes c2c-target-java-runtime as a Maven dependency).
        List<JavaFileObject> sources = new ArrayList<>();
        for (Map.Entry<String, String> entry : files.entrySet()) {
            if (entry.getKey().endsWith(".java")) {
                sources.add(new StringJavaFileObject(entry.getKey(), entry.getValue()));
            }
        }
        compileInMemory(sources);
    }

    private static void compileInMemory(List<JavaFileObject> sources) throws IOException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "JavaCompiler not available — run tests on a JDK, not a JRE");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        Path classOut = Files.createTempDirectory("c2c-generated-classes-");
        try (var fileManager = compiler.getStandardFileManager(diagnostics, null, null)) {
            fileManager.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classOut.toFile()));
            boolean ok = compiler.getTask(null, fileManager, diagnostics, null, null, sources).call();
            if (!ok) {
                StringBuilder errors = new StringBuilder();
                for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                    errors.append(d.toString()).append('\n');
                }
                throw new AssertionError("Generated Java failed to compile:\n" + errors);
            }
        } finally {
            deleteRecursively(classOut);
        }
    }

    private static void writeGeneratedProject(Path projectDir, Map<String, String> files) throws IOException {
        for (Map.Entry<String, String> entry : files.entrySet()) {
            Path filePath = projectDir.resolve(entry.getKey());
            Files.createDirectories(filePath.getParent());
            Files.writeString(filePath, entry.getValue());
        }
    }

    private static void runMavenPackage(Path projectDir) throws IOException, InterruptedException {
        ProcessBuilder pb = new ProcessBuilder("mvn", "-q", "-DskipTests", "package");
        pb.directory(projectDir.toFile());
        pb.redirectErrorStream(true);
        Process process = pb.start();
        String output = new String(process.getInputStream().readAllBytes());
        int exitCode = process.waitFor();
        assertEquals(0, exitCode, "Generated project maven package failed:\n" + output);
    }

    private static void deleteRecursively(Path path) {
        try {
            if (!Files.exists(path)) {
                return;
            }
            try (var stream = Files.walk(path)) {
                stream.sorted(java.util.Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(java.io.File::delete);
            }
        } catch (IOException ignored) {
            // best effort cleanup
        }
    }

    private static Path findRepoRoot() {
        Path current = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 6; i++) {
            if (Files.exists(current.resolve("fixtures/semantic-ir"))
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

    private static final class StringJavaFileObject extends SimpleJavaFileObject {
        private final String code;

        StringJavaFileObject(String relativePath, String code) {
            super(URI.create("string:///" + relativePath), Kind.SOURCE);
            this.code = code;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return code;
        }
    }

}
