package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JavaInMemoryCompilerTest {

    private static final Pattern SCHEMA_FILEPATH_PATTERN =
            Pattern.compile("^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$");

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

    @Test
    void projectAwareDiagnosticFilePathSatisfiesSchemaPattern() throws Exception {
        try (var project = GeneratedProjectMaterializer.materialise(Map.of(
                "src/main/java/bad/Broken.java",
                "package bad; public class Broken { public static void main(String[] a) { not_valid_java; } }\n"
        ))) {
            Path out = project.root().resolve("target/classes");
            JavaInMemoryCompiler.CompileResult result =
                    JavaInMemoryCompiler.compile(project, out);
            assertFalse(result.ok());
            for (Map<String, Object> diagnostic : result.diagnostics()) {
                Object filePath = diagnostic.get("filePath");
                if (filePath == null) {
                    continue;
                }
                String value = filePath.toString();
                assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(value).matches(),
                        () -> "diagnostic filePath violates schema pattern: " + value);
                assertTrue(value.length() <= DiagnosticBounds.MAX_FILEPATH_LENGTH,
                        () -> "diagnostic filePath exceeds 500 chars: " + value.length());
            }
        }
    }

    @Test
    void legacyOverloadFilePathSatisfiesSchemaPattern() throws Exception {
        Path tempRoot = Files.createTempDirectory("c2c-jcompiler-legacy-");
        try {
            Path source = tempRoot.resolve("Broken.java");
            Files.writeString(source,
                    "public class Broken { public static void main(String[] a) { not_valid_java; } }\n");
            Path out = tempRoot.resolve("target/classes");
            JavaInMemoryCompiler.CompileResult result =
                    JavaInMemoryCompiler.compile(List.of(source), out);
            assertFalse(result.ok());
            boolean sawSourceLinkedDiagnostic = false;
            for (Map<String, Object> diagnostic : result.diagnostics()) {
                Object filePath = diagnostic.get("filePath");
                if (filePath == null) {
                    continue;
                }
                sawSourceLinkedDiagnostic = true;
                String value = filePath.toString();
                assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(value).matches(),
                        () -> "legacy diagnostic filePath violates schema pattern: " + value);
                assertTrue(value.length() <= DiagnosticBounds.MAX_FILEPATH_LENGTH);
            }
            assertTrue(sawSourceLinkedDiagnostic,
                    "expected at least one diagnostic linked to the source file");
        } finally {
            GeneratedProjectMaterializer.deleteRecursively(tempRoot);
        }
    }

    @Test
    void diagnosticMessageIsBoundedAt4000Chars() throws Exception {
        try (var project = GeneratedProjectMaterializer.materialise(Map.of(
                "src/main/java/bad/Broken.java",
                "package bad; public class Broken { public static void main(String[] a) { not_valid_java; } }\n"
        ))) {
            Path out = project.root().resolve("target/classes");
            JavaInMemoryCompiler.CompileResult result =
                    JavaInMemoryCompiler.compile(project, out);
            for (Map<String, Object> diagnostic : result.diagnostics()) {
                Object message = diagnostic.get("message");
                if (message == null) {
                    continue;
                }
                assertTrue(message.toString().length() <= DiagnosticBounds.MAX_MESSAGE_LENGTH,
                        () -> "diagnostic message exceeds " + DiagnosticBounds.MAX_MESSAGE_LENGTH + " chars");
            }
        }
    }
}
