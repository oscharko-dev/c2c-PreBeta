package com.c2c.w0.buildtest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Writes a generated project's file map (relative path → content) into a
 * temporary working directory.
 * <p>
 * This is a deliberate safety boundary: every relative path is validated to
 * stay inside the working root and reject {@code ..} traversal or absolute
 * paths. Without this guard a malicious or malformed generator response could
 * cause the runner to clobber files outside its scratch area.
 */
final class GeneratedProjectMaterializer {

    private GeneratedProjectMaterializer() {
    }

    static MaterializedProject materialise(Map<String, String> files) throws IOException {
        if (files == null || files.isEmpty()) {
            throw new IllegalArgumentException("generatedProject.files is empty");
        }
        Path root = Files.createTempDirectory("c2c-build-test-");
        Path realRoot = root.toRealPath();
        TreeMap<String, Path> written = new TreeMap<>();
        List<Path> javaSources = new ArrayList<>();
        for (Map.Entry<String, String> entry : files.entrySet()) {
            String relative = entry.getKey();
            String content = entry.getValue() == null ? "" : entry.getValue();
            Path target = safeResolve(realRoot, relative);
            Files.createDirectories(target.getParent());
            Files.writeString(target, content, StandardCharsets.UTF_8);
            written.put(relative, target);
            if (relative.endsWith(".java")) {
                javaSources.add(target);
            }
        }
        return new MaterializedProject(realRoot, written, javaSources);
    }

    static void deleteRecursively(Path path) {
        if (path == null) {
            return;
        }
        try {
            if (!Files.exists(path)) {
                return;
            }
            try (var stream = Files.walk(path)) {
                stream.sorted(java.util.Comparator.reverseOrder())
                        .forEach(p -> {
                            try {
                                Files.deleteIfExists(p);
                            } catch (IOException ignored) {
                                // best effort
                            }
                        });
            }
        } catch (IOException ignored) {
            // best effort
        }
    }

    private static Path safeResolve(Path root, String relative) {
        if (relative == null || relative.isBlank()) {
            throw new IllegalArgumentException("generatedProject contained an empty path");
        }
        if (relative.startsWith("/") || relative.contains("\\")
                || relative.contains("..")) {
            throw new IllegalArgumentException("generatedProject path is unsafe: " + relative);
        }
        Path candidate = root.resolve(relative).normalize();
        if (!candidate.startsWith(root)) {
            throw new IllegalArgumentException("generatedProject path escapes working root: " + relative);
        }
        return candidate;
    }

    record MaterializedProject(Path root,
                               java.util.NavigableMap<String, Path> files,
                               List<Path> javaSources) implements AutoCloseable {
        @Override
        public void close() {
            deleteRecursively(root);
        }
    }
}
