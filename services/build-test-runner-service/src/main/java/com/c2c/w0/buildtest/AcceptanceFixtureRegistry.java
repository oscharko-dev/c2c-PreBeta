package com.c2c.w0.buildtest;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class AcceptanceFixtureRegistry {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String REGISTRY_RELATIVE_PATH = "fixtures/acceptance/index.json";

    private final Path repoRoot;

    AcceptanceFixtureRegistry(Path repoRoot) {
        this.repoRoot = repoRoot;
    }

    Optional<AcceptanceFixture> resolve(String fixtureId) {
        if (fixtureId == null || fixtureId.isBlank()) {
            return Optional.empty();
        }
        Path indexPath = repoRoot.resolve(REGISTRY_RELATIVE_PATH).normalize();
        if (!Files.isRegularFile(indexPath)) {
            return Optional.empty();
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = JSON.readValue(indexPath.toFile(), Map.class);
            Object fixturesValue = parsed.get("fixtures");
            if (!(fixturesValue instanceof List<?> fixtures)) {
                return Optional.empty();
            }
            for (Object entry : fixtures) {
                if (!(entry instanceof Map<?, ?> rawEntry)) {
                    continue;
                }
                AcceptanceFixture fixture = AcceptanceFixture.from(rawEntry);
                if (fixture != null && fixture.fixtureId().equals(fixtureId)) {
                    return Optional.of(fixture);
                }
            }
            return Optional.empty();
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    record AcceptanceFixture(
            String fixtureId,
            String title,
            ArtifactReference sourceCobolArtifactRef,
            ArtifactReference expectedOutputArtifactRef,
            String oracleGenerationMode,
            String expectedFinalClassification,
            List<Map<String, Object>> unsupportedConstructs
    ) {

        @SuppressWarnings("unchecked")
        static AcceptanceFixture from(Map<?, ?> rawEntry) {
            Object fixtureId = rawEntry.get("fixtureId");
            Object title = rawEntry.get("title");
            Object sourceRef = rawEntry.get("sourceCobolArtifactRef");
            if (!(fixtureId instanceof String fixtureIdText)
                    || !(title instanceof String titleText)
                    || !(sourceRef instanceof Map<?, ?> sourceRefMap)) {
                return null;
            }
            ArtifactReference sourceArtifactRef = ArtifactReference.from(sourceRefMap);
            if (sourceArtifactRef == null) {
                return null;
            }
            ArtifactReference expectedOutputArtifactRef = null;
            Object expectedRef = rawEntry.get("expectedOutputArtifactRef");
            if (expectedRef instanceof Map<?, ?> expectedRefMap) {
                expectedOutputArtifactRef = ArtifactReference.from(expectedRefMap);
            }
            String oracleGenerationMode = rawEntry.get("oracleGenerationMode") instanceof String mode
                    ? mode
                    : null;
            String expectedFinalClassification = rawEntry.get("expectedFinalClassification") instanceof String cls
                    ? cls
                    : null;
            List<Map<String, Object>> unsupportedConstructs = new java.util.ArrayList<>();
            if (rawEntry.get("unsupportedConstructs") instanceof List<?> items) {
                for (Object item : items) {
                    if (item instanceof Map<?, ?> mapItem) {
                        unsupportedConstructs.add(new LinkedHashMap<>((Map<String, Object>) mapItem));
                    }
                }
            }
            return new AcceptanceFixture(
                    fixtureIdText,
                    titleText,
                    sourceArtifactRef,
                    expectedOutputArtifactRef,
                    oracleGenerationMode,
                    expectedFinalClassification,
                    unsupportedConstructs);
        }
    }

    record ArtifactReference(
            String uri,
            String path,
            String sha256,
            int byteSize,
            String mimeType,
            String kind
    ) {

        static ArtifactReference from(Map<?, ?> raw) {
            Object uri = raw.get("uri");
            Object path = raw.get("path");
            Object sha256 = raw.get("sha256");
            Object byteSize = raw.get("byteSize");
            if (!(uri instanceof String uriText)
                    || !(path instanceof String pathText)
                    || !(sha256 instanceof String shaText)
                    || !(byteSize instanceof Number sizeNumber)) {
                return null;
            }
            String mimeType = raw.get("mimeType") instanceof String mime ? mime : null;
            String kind = raw.get("kind") instanceof String kindText ? kindText : null;
            return new ArtifactReference(
                    uriText,
                    pathText,
                    shaText,
                    sizeNumber.intValue(),
                    mimeType,
                    kind);
        }

        Path resolve(Path repoRoot) {
            if (path.startsWith("/") || path.contains("\\") || path.contains("..")) {
                throw new IllegalArgumentException("unsafe fixture path: " + path);
            }
            Path normalizedRoot = repoRoot.toAbsolutePath().normalize();
            Path resolved = normalizedRoot.resolve(path).normalize();
            if (!resolved.startsWith(normalizedRoot)) {
                throw new IllegalArgumentException("fixture path escapes repository root: " + path);
            }
            if (Files.exists(resolved)) {
                try {
                    Path realRoot = normalizedRoot.toRealPath();
                    Path realResolved = resolved.toRealPath();
                    if (!realResolved.startsWith(realRoot)) {
                        throw new IllegalArgumentException("fixture path escapes repository root via symlink: " + path);
                    }
                } catch (IOException e) {
                    throw new IllegalArgumentException("fixture path could not be resolved safely: " + path, e);
                }
            }
            return resolved;
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("uri", uri);
            map.put("sha256", sha256);
            map.put("byteSize", byteSize);
            if (mimeType != null && !mimeType.isBlank()) {
                map.put("mimeType", mimeType);
            }
            if (kind != null && !kind.isBlank()) {
                map.put("kind", kind);
            }
            return map;
        }
    }
}
