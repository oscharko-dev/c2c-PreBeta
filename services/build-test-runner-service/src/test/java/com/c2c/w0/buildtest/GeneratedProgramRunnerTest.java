package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GeneratedProgramRunnerTest {

    @Test
    void capturesStdoutOfMain() throws Exception {
        Path classOut = compileSnippet("sample.HelloRun",
                "package sample; public class HelloRun {"
                        + " public static void main(String[] a) { System.out.print(\"hello-runner\"); } }");
        GeneratedProgramRunner.RunResult result =
                GeneratedProgramRunner.run(classOut, "sample.HelloRun", 5_000);
        assertTrue(result.ran());
        assertTrue(result.ok());
        assertEquals("hello-runner", result.stdout());
        assertEquals(0, result.exitCode());
    }

    @Test
    void timeoutEnforcedForLongLoops() throws Exception {
        Path classOut = compileSnippet("sample.SlowLoop",
                "package sample; public class SlowLoop {"
                        + " public static void main(String[] a) throws Exception {"
                        + "   while (!Thread.currentThread().isInterrupted()) { Thread.sleep(50); } } }");
        GeneratedProgramRunner.RunResult result =
                GeneratedProgramRunner.run(classOut, "sample.SlowLoop", 200);
        assertTrue(result.ran());
        assertFalse(result.ok());
        assertEquals("timeout", result.errorClass());
    }

    @Test
    void missingEntryClassIsSkipped() {
        GeneratedProgramRunner.RunResult result =
                GeneratedProgramRunner.run(Path.of("nonexistent"), null, 1_000);
        assertFalse(result.ran());
        assertEquals("missing-entry-class", result.errorClass());
    }

    @Test
    void runtimeExceptionIsReported() throws Exception {
        Path classOut = compileSnippet("sample.Boom",
                "package sample; public class Boom {"
                        + " public static void main(String[] a) { throw new RuntimeException(\"boom\"); } }");
        GeneratedProgramRunner.RunResult result =
                GeneratedProgramRunner.run(classOut, "sample.Boom", 5_000);
        assertTrue(result.ran());
        assertFalse(result.ok());
        assertTrue(result.errorMessage().contains("boom"));
    }

    private static Path compileSnippet(String fqn, String source) throws Exception {
        String relativePath = "src/main/java/" + fqn.replace('.', '/') + ".java";
        var project = GeneratedProjectMaterializer.materialise(Map.of(relativePath, source));
        // Intentionally do not close the project so the class output survives
        // the test execution. The temp directory is cleaned up by the OS on
        // exit; for unit tests this leak is acceptable.
        Path classOut = project.root().resolve("target/classes");
        JavaInMemoryCompiler.CompileResult compile =
                JavaInMemoryCompiler.compile(project.javaSources(), classOut);
        assertTrue(compile.ok(), () -> "compile failed: " + compile.diagnostics());
        return classOut;
    }
}
