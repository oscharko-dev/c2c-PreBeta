package com.c2c.w0.buildtest;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Compiles generated Java sources using the JVM-bundled {@code javax.tools}
 * API. The runner deliberately avoids spawning {@code javac} or {@code mvn}
 * subprocesses so that "unsafe arbitrary command execution" is structurally
 * impossible in the build path.
 */
final class JavaInMemoryCompiler {

    private JavaInMemoryCompiler() {
    }

    static CompileResult compile(List<Path> sources, Path classOutputDir) {
        if (sources == null || sources.isEmpty()) {
            return CompileResult.empty(classOutputDir);
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            Map<String, Object> diag = new LinkedHashMap<>();
            diag.put("severity", "error");
            diag.put("code", "compiler-unavailable");
            diag.put("filePath", "generated-project");
            diag.put("line", 1L);
            diag.put("column", 1L);
            diag.put("message",
                    "JavaCompiler is unavailable: build-test-runner-service must run on a JDK image, not a JRE.");
            return new CompileResult(false, classOutputDir, List.of(diag), 0);
        }
        try {
            Files.createDirectories(classOutputDir);
        } catch (IOException e) {
            return new CompileResult(false, classOutputDir,
                    List.of(diagnostic("error", "class-output-create-failed", "generated-project", 1L, 1L,
                            "Failed to create class output directory: " + e.getMessage())),
                    sources.size());
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null)) {
            fileManager.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classOutputDir.toFile()));
            String classpath = System.getProperty("java.class.path");
            List<String> options = new ArrayList<>();
            if (classpath != null && !classpath.isBlank()) {
                options.add("-classpath");
                options.add(classpath);
            }
            options.add("-Xlint:none");
            Iterable<? extends JavaFileObject> compilationUnits =
                    fileManager.getJavaFileObjectsFromFiles(sources.stream().map(Path::toFile).toList());
            JavaCompiler.CompilationTask task = compiler.getTask(
                    null, fileManager, diagnostics, options, null, compilationUnits);
            boolean ok = Boolean.TRUE.equals(task.call());
            return new CompileResult(ok, classOutputDir,
                    convertDiagnostics(diagnostics.getDiagnostics()), sources.size());
        } catch (IOException e) {
            return new CompileResult(false, classOutputDir,
                    List.of(diagnostic("error", "compiler-io", "generated-project", 1L, 1L,
                            "Compiler I/O failure: " + e.getMessage())),
                    sources.size());
        }
    }

    static CompileResult compile(GeneratedProjectMaterializer.MaterializedProject project, Path classOutputDir) {
        if (project == null || project.javaSources().isEmpty()) {
            return CompileResult.empty(classOutputDir);
        }
        List<Path> sources = project.javaSources();
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            Map<String, Object> diag = new LinkedHashMap<>();
            diag.put("severity", "error");
            diag.put("code", "compiler-unavailable");
            diag.put("filePath", "generated-project");
            diag.put("line", 1L);
            diag.put("column", 1L);
            diag.put("message",
                    "JavaCompiler is unavailable: build-test-runner-service must run on a JDK image, not a JRE.");
            return new CompileResult(false, classOutputDir, List.of(diag), 0);
        }
        try {
            Files.createDirectories(classOutputDir);
        } catch (IOException e) {
            return new CompileResult(false, classOutputDir,
                    List.of(diagnostic("error", "class-output-create-failed", "generated-project", 1L, 1L,
                            "Failed to create class output directory: " + e.getMessage())),
                    sources.size());
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null)) {
            fileManager.setLocation(StandardLocation.CLASS_OUTPUT, List.of(classOutputDir.toFile()));
            // Honour the parent process classpath so the generated code can
            // resolve com.c2c.target.java.runtime.* — the runtime is already
            // a declared Maven dependency of this service.
            String classpath = System.getProperty("java.class.path");
            List<String> options = new ArrayList<>();
            if (classpath != null && !classpath.isBlank()) {
                options.add("-classpath");
                options.add(classpath);
            }
            options.add("-Xlint:none");
            Iterable<? extends JavaFileObject> compilationUnits =
                    fileManager.getJavaFileObjectsFromFiles(sources.stream().map(Path::toFile).toList());
            JavaCompiler.CompilationTask task = compiler.getTask(
                    null, fileManager, diagnostics, options, null, compilationUnits);
            boolean ok = Boolean.TRUE.equals(task.call());
            return new CompileResult(ok, classOutputDir,
                    convertDiagnostics(project, diagnostics.getDiagnostics()), sources.size());
        } catch (IOException e) {
            return new CompileResult(false, classOutputDir,
                    List.of(diagnostic("error", "compiler-io", "generated-project", 1L, 1L,
                            "Compiler I/O failure: " + e.getMessage())),
                    sources.size());
        }
    }

    private static List<Map<String, Object>> convertDiagnostics(
            GeneratedProjectMaterializer.MaterializedProject project,
            List<Diagnostic<? extends JavaFileObject>> raw) {
        List<Map<String, Object>> out = new ArrayList<>(raw.size());
        for (Diagnostic<? extends JavaFileObject> d : raw) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("severity", normaliseSeverity(d.getKind().toString()));
            entry.put("code", "javac-" + d.getCode());
            JavaFileObject source = d.getSource();
            String filePath = relativePathFor(project, source == null ? null : Path.of(source.toUri()));
            if (filePath != null && !filePath.isBlank()) {
                entry.put("filePath", filePath);
            }
            if (d.getLineNumber() > 0) {
                entry.put("line", d.getLineNumber());
            }
            if (d.getColumnNumber() > 0) {
                entry.put("column", d.getColumnNumber());
            }
            entry.put("message", d.getMessage(Locale.ROOT));
            out.add(entry);
        }
        return out;
    }

    private static List<Map<String, Object>> convertDiagnostics(
            List<Diagnostic<? extends JavaFileObject>> raw) {
        List<Map<String, Object>> out = new ArrayList<>(raw.size());
        for (Diagnostic<? extends JavaFileObject> d : raw) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("severity", normaliseSeverity(d.getKind().toString()));
            entry.put("code", "javac-" + d.getCode());
            JavaFileObject source = d.getSource();
            if (source != null) {
                entry.put("filePath", source.getName());
            }
            if (d.getLineNumber() > 0) {
                entry.put("line", d.getLineNumber());
            }
            if (d.getColumnNumber() > 0) {
                entry.put("column", d.getColumnNumber());
            }
            entry.put("message", d.getMessage(Locale.ROOT));
            out.add(entry);
        }
        return out;
    }

    private static String relativePathFor(GeneratedProjectMaterializer.MaterializedProject project, Path path) {
        if (path == null) {
            return "generated-project";
        }
        for (Map.Entry<String, Path> entry : project.files().entrySet()) {
            if (entry.getValue().equals(path)) {
                return entry.getKey();
            }
        }
        Path root = project.root();
        if (path.startsWith(root)) {
            return root.relativize(path).toString().replace('\\', '/');
        }
        return path.getFileName() == null ? "generated-project" : path.getFileName().toString();
    }

    private static String normaliseSeverity(String raw) {
        String value = raw == null ? "" : raw.toLowerCase(Locale.ROOT);
        return switch (value) {
            case "mandatory_warning", "warning", "note" -> "warning";
            case "error", "other" -> "error";
            default -> "info";
        };
    }

    private static Map<String, Object> diagnostic(
            String severity,
            String code,
            String filePath,
            long line,
            long column,
            String message) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("severity", severity);
        d.put("code", code);
        d.put("filePath", filePath);
        d.put("line", line);
        d.put("column", column);
        d.put("message", message);
        return d;
    }

    record CompileResult(boolean ok, Path classOutputDir,
                         List<Map<String, Object>> diagnostics, int sourceCount) {
        static CompileResult empty(Path dir) {
            return new CompileResult(false, dir, List.of(
                    Map.of("severity", "error",
                            "code", "no-sources",
                            "message", "Generated project contained no .java sources to compile.")),
                    0);
        }
    }
}
