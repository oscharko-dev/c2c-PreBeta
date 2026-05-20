package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SourceReferenceExecutionServiceTest {

    private final SourceReferenceExecutionService service =
            new SourceReferenceExecutionService(BuildTestRunnerService.detectRepoRoot());

    @Test
    void referenceFixtureModeReturnsDeterministicExecutionResult() {
        Map<String, Object> response = service.execute(Map.of(
                "runId", "trust-3-fixture-success",
                "fixtureId", "HELLOW02",
                "referenceMode", "reference-fixture"));

        assertEquals("v0", response.get("schemaVersion"));
        assertEquals("source-reference", response.get("executionSurface"));
        assertEquals("reference-fixture", response.get("referenceMode"));
        assertEquals("passed", response.get("status"));
        assertEquals(0, response.get("exitCode"));
        assertEquals(false, response.get("timedOut"));
        assertNotNull(response.get("sourceArtifactRef"));
        assertNotNull(response.get("referenceArtifactRef"));
        assertTrue(((Map<?, ?>) response.get("stdoutRef")).containsKey("sha256"));
        assertTrue(((Map<?, ?>) response.get("normalizedOutputRef")).containsKey("sha256"));
    }

    @Test
    void missingFixtureProducesActionableDiagnostic() {
        Map<String, Object> response = service.execute(Map.of(
                "runId", "trust-3-missing-fixture",
                "fixtureId", "DOES-NOT-EXIST",
                "referenceMode", "reference-fixture"));

        assertEquals("failed", response.get("status"));
        assertEquals(false, response.get("timedOut"));
        @SuppressWarnings("unchecked")
        Map<String, Object> diagnostic = ((java.util.List<Map<String, Object>>) response.get("diagnostics")).get(0);
        assertEquals("missing-fixture", diagnostic.get("code"));
        assertTrue(((String) diagnostic.get("message")).contains("DOES-NOT-EXIST"));
    }

    @Test
    void blockedAcceptanceFixtureIsRejectedAsUnsupportedProgramShape() {
        Map<String, Object> response = service.execute(Map.of(
                "runId", "trust-3-unsupported-shape",
                "fixtureId", "FILEIO-UNSUPPORTED",
                "referenceMode", "native-cobol"));

        assertEquals("failed", response.get("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> diagnostic = ((java.util.List<Map<String, Object>>) response.get("diagnostics")).get(0);
        assertEquals("unsupported-program-shape", diagnostic.get("code"));
        assertTrue(((String) diagnostic.get("message")).contains("supported COBOL slice"));
    }

    @Test
    void nativeCobolModeReportsUnavailableRuntimeDeterministically() {
        String previousCobc = System.getProperty("c2c.cobc.path");
        String previousCobcrun = System.getProperty("c2c.cobcrun.path");
        System.setProperty("c2c.cobc.path", "__missing_cobc_for_trust3_test__");
        System.setProperty("c2c.cobcrun.path", "__missing_cobcrun_for_trust3_test__");
        try {
            Map<String, Object> response = service.execute(Map.of(
                    "runId", "trust-3-native-unavailable",
                    "fixtureId", "HELLOW02",
                    "referenceMode", "native-cobol"));

            assertEquals("failed", response.get("status"));
            assertEquals("native-cobol", response.get("referenceMode"));
            assertFalse((Boolean) response.get("timedOut"));
            @SuppressWarnings("unchecked")
            Map<String, Object> diagnostic = ((java.util.List<Map<String, Object>>) response.get("diagnostics")).get(0);
            assertEquals("native-cobol-unavailable", diagnostic.get("code"));
        } finally {
            restoreProperty("c2c.cobc.path", previousCobc);
            restoreProperty("c2c.cobcrun.path", previousCobcrun);
        }
    }

    private static void restoreProperty(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }
}
