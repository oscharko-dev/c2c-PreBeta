package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GoldenMasterTest {

    @Test
    void inlineExpectedTextWins() {
        Map<String, Object> hint = Map.of(
                "expected", "INLINE-OUTPUT",
                "classification", "synthetic",
                "knownDivergenceAtW0", true);
        Optional<GoldenMaster.Resolved> resolved =
                GoldenMaster.resolve("ANY", hint, repoRoot());
        assertTrue(resolved.isPresent());
        assertEquals("INLINE-OUTPUT", resolved.get().expected());
        assertEquals("inline-request", resolved.get().source());
        assertTrue(resolved.get().knownDivergenceAtW0());
    }

    @Test
    void registryLookupFindsBranchAccountGuard() throws Exception {
        Path root = repoRoot();
        Path expected = root.resolve("corpus/synthetic/fixtures/branch-account-guard-output.txt");
        assertTrue(Files.exists(expected), "fixture must exist on disk: " + expected);
        Optional<GoldenMaster.Resolved> resolved =
                GoldenMaster.resolve("BRNCH01", Map.of(), root);
        assertTrue(resolved.isPresent());
        assertEquals(Files.readString(expected), resolved.get().expected());
        assertEquals("synthetic", resolved.get().classification());
        assertTrue(resolved.get().knownDivergenceAtW0(),
                "BRNCH01 W0 entry must declare knownDivergenceAtW0=true");
    }

    @Test
    void expectedRefPathResolvesInsideRepoRoot() throws Exception {
        Path root = repoRoot();
        String relativePath = "corpus/synthetic/fixtures/branch-account-guard-output.txt";
        Path expected = root.resolve(relativePath);
        Optional<GoldenMaster.Resolved> resolved = GoldenMaster.resolve(
                "BRNCH01",
                Map.of("expectedRef", Map.of("path", relativePath)),
                root);
        assertTrue(resolved.isPresent());
        assertEquals(Files.readString(expected), resolved.get().expected());
        assertEquals(relativePath, resolved.get().source());
    }

    @Test
    void expectedRefPathTraversalIsRejected() {
        Path root = repoRoot();
        assertThrows(IllegalArgumentException.class, () ->
                GoldenMaster.resolve("BRNCH01",
                        Map.of("expectedRef", Map.of("path", "../escape.txt")),
                        root));
    }

    @Test
    void expectedRefAbsolutePathIsRejected() {
        Path root = repoRoot();
        Path absolute = root.resolve("fixtures/golden-master/index.json").toAbsolutePath();
        assertThrows(IllegalArgumentException.class, () ->
                GoldenMaster.resolve("BRNCH01",
                        Map.of("expectedRef", Map.of("path", absolute.toString())),
                        root));
    }

    @Test
    void registryLookupCoversAllThreeW0Programs() {
        Path root = repoRoot();
        for (String programId : new String[]{"BRNCH01", "CTRLDEC01", "BATCH01"}) {
            Optional<GoldenMaster.Resolved> resolved =
                    GoldenMaster.resolve(programId, Map.of(), root);
            assertTrue(resolved.isPresent(), "missing Golden Master for " + programId);
            assertNotNull(resolved.get().expected());
            assertTrue(resolved.get().expected().length() > 0,
                    "expected output empty for " + programId);
        }
    }

    @Test
    void unknownProgramReturnsEmpty() {
        Optional<GoldenMaster.Resolved> resolved =
                GoldenMaster.resolve("DOES-NOT-EXIST-IN-REGISTRY", Map.of(), repoRoot());
        assertTrue(resolved.isEmpty());
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
