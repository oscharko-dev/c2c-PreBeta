package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JavaInMemoryCompilerTest {

    @Test
    void compilesValidSource() throws Exception {
        try (var project = GeneratedProjectMaterializer.materialise(Map.of(
                "src/main/java/sample/Hello.java",
                "package sample; public class Hello { public static void main(String[] a) { System.out.println(\"hi\"); } }\n"
        ))) {
            Path out = project.root().resolve("target/classes");
            JavaInMemoryCompiler.CompileResult result =
                    JavaInMemoryCompiler.compile(project.javaSources(), out);
            assertTrue(result.ok(), () -> "expected compile to succeed: " + result.diagnostics());
            assertTrue(Files.exists(out.resolve("sample/Hello.class")));
        }
    }

    @Test
    void surfacesJavacDiagnosticsOnFailure() throws Exception {
        try (var project = GeneratedProjectMaterializer.materialise(Map.of(
                "src/main/java/bad/Broken.java",
                "package bad; public class Broken { public static void main(String[] a) { not_valid_java; } }\n"
        ))) {
            Path out = project.root().resolve("target/classes");
            JavaInMemoryCompiler.CompileResult result =
                    JavaInMemoryCompiler.compile(project.javaSources(), out);
            assertFalse(result.ok());
            assertFalse(result.diagnostics().isEmpty());
            assertTrue(result.diagnostics().stream()
                    .anyMatch(d -> "error".equals(d.get("severity"))));
        }
    }

    @Test
    void emptySourceListReportsNoSources() {
        JavaInMemoryCompiler.CompileResult result =
                JavaInMemoryCompiler.compile(List.of(), Path.of("ignored"));
        assertFalse(result.ok());
        assertTrue(result.diagnostics().stream()
                .anyMatch(d -> "no-sources".equals(d.get("code"))));
    }
}
