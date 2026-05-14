package com.c2c.w0.buildtest;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Resolves a Golden Master fixture for a given program id.
 * <p>
 * Lookup order:
 * <ol>
 *   <li>Inline {@code goldenMaster.expected} text on the request.</li>
 *   <li>Inline {@code goldenMaster.expectedRef.path} pointing inside the
 *       repository (resolved against the W0 repo root).</li>
 *   <li>Repository registry at {@code fixtures/golden-master/index.json}
 *       keyed by {@code programId}.</li>
 * </ol>
 * <p>
 * The W0 registry classifies each entry as either {@code true} (executed via
 * GnuCOBOL or another COBOL runtime) or {@code synthetic} (hand-curated
 * expected output). The runner records this classification verbatim in the
 * result so downstream evidence consumers can distinguish the two.
 */
final class GoldenMaster {

    private static final ObjectMapper JSON = new ObjectMapper();
    static final String REGISTRY_RELATIVE_PATH = "fixtures/golden-master/index.json";

    private GoldenMaster() {
    }

    static Optional<Resolved> resolve(String programId, Map<String, Object> hint, Path repoRoot) {
        if (hint != null) {
            Object inline = hint.get("expected");
            if (inline instanceof String s && !s.isBlank()) {
                String classification = string(hint.get("classification"), "synthetic");
                String source = string(hint.get("source"), "inline-request");
                boolean knownDivergence = booleanFlag(hint.get("knownDivergenceAtW0"), false);
                return Optional.of(new Resolved(s, classification, source, knownDivergence));
            }
            Object refObj = hint.get("expectedRef");
            if (refObj instanceof Map<?, ?> map) {
                Object pathObj = map.get("path");
                if (pathObj instanceof String pathStr && !pathStr.isBlank()) {
                    String classification = string(hint.get("classification"), "synthetic");
                    boolean knownDivergence = booleanFlag(hint.get("knownDivergenceAtW0"), false);
                    Path resolved = resolveSafePath(repoRoot, pathStr);
                    String content = readSafe(resolved);
                    if (content != null) {
                        return Optional.of(new Resolved(content, classification, pathStr, knownDivergence));
                    }
                }
            }
        }
        if (programId == null || programId.isBlank()) {
            return Optional.empty();
        }
        return loadFromRegistry(programId, repoRoot);
    }

    @SuppressWarnings("unchecked")
    private static Optional<Resolved> loadFromRegistry(String programId, Path repoRoot) {
        if (repoRoot == null) {
            return Optional.empty();
        }
        Path registryPath = repoRoot.resolve(REGISTRY_RELATIVE_PATH);
        if (!Files.exists(registryPath)) {
            return Optional.empty();
        }
        try {
            String body = Files.readString(registryPath, StandardCharsets.UTF_8);
            Map<String, Object> doc = JSON.readValue(body, Map.class);
            Object entriesObj = doc.get("entries");
            if (!(entriesObj instanceof List<?> entries)) {
                return Optional.empty();
            }
            for (Object entry : entries) {
                if (!(entry instanceof Map<?, ?> raw)) {
                    continue;
                }
                String entryProgramId = string(raw.get("programId"), "");
                if (!programId.equals(entryProgramId)) {
                    continue;
                }
                String relativePath = string(raw.get("expectedOutputPath"), "");
                if (relativePath.isEmpty()) {
                    continue;
                }
                String classification = string(raw.get("classification"), "synthetic");
                boolean knownDivergence = booleanFlag(raw.get("knownDivergenceAtW0"), false);
                Path target = resolveSafePath(repoRoot, relativePath);
                String content = readSafe(target);
                if (content != null) {
                    return Optional.of(new Resolved(content, classification, relativePath, knownDivergence));
                }
            }
        } catch (IOException e) {
            return Optional.empty();
        }
        return Optional.empty();
    }

    private static Path resolveSafePath(Path repoRoot, String relativePath) {
        Path candidate = Paths.get(relativePath);
        if (candidate.isAbsolute()) {
            throw new IllegalArgumentException("Golden Master path must be repo-relative: " + relativePath);
        }
        Path resolved = repoRoot.resolve(relativePath).normalize();
        if (!resolved.startsWith(repoRoot)) {
            throw new IllegalArgumentException("Golden Master path escapes repo root: " + relativePath);
        }
        return resolved;
    }

    private static String readSafe(Path path) {
        try {
            if (Files.isRegularFile(path)) {
                return Files.readString(path, StandardCharsets.UTF_8);
            }
        } catch (IOException ignored) {
            // fall through
        }
        return null;
    }

    private static String string(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = value.toString();
        return text.isBlank() ? fallback : text;
    }

    private static boolean booleanFlag(Object value, boolean fallback) {
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return Boolean.parseBoolean(s.trim());
        }
        return fallback;
    }

    record Resolved(String expected, String classification, String source, boolean knownDivergenceAtW0) {
        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("expected", expected);
            map.put("expectedSha256", HashUtil.sha256(expected == null ? "" : expected));
            map.put("classification", classification);
            map.put("source", source);
            map.put("knownDivergenceAtW0", knownDivergenceAtW0);
            return map;
        }
    }
}
