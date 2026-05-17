package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServiceAppTest {

    @Test
    void httpStatusIsAlwaysTwoHundredForStructuredOutcomes() {
        for (String status : new String[]{
                "ok",
                "compile-failed",
                "run-failed",
                "output-divergence",
                "golden-master-reproduction-failed",
        }) {
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("status", status);
            assertEquals(200, ServiceApp.httpStatus(response),
                    "status " + status + " must produce HTTP 200");
        }
    }

    @Test
    void httpStatusIs422ForMissingGoldenMaster() {
        assertEquals(422, ServiceApp.httpStatus(Map.of("status", "missing-golden-master")));
    }

    @Test
    void httpStatusIs422ForSkipped() {
        assertEquals(422, ServiceApp.httpStatus(Map.of("status", "skipped")));
    }

    @Test
    void listenAddressDefaultsToLoopbackAndHonorsConfiguredHost() {
        assertEquals("127.0.0.1", ServiceApp.readListenAddress(null).getHostString());
        assertEquals(8084, ServiceApp.readListenAddress(null).getPort());
        assertEquals("127.0.0.1", ServiceApp.readListenAddress(":18086").getHostString());
        assertEquals(18086, ServiceApp.readListenAddress(":18086").getPort());
        assertEquals("0.0.0.0", ServiceApp.readListenAddress("0.0.0.0:18086").getHostString());
        assertEquals(18086, ServiceApp.readListenAddress("0.0.0.0:18086").getPort());
    }

    @Test
    void harnessEventCarriesBuildTestDataClassAndCapability() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "ok");
        response.put("runId", "run-1");
        response.put("programId", "BRNCH01");
        response.put("classification", "match");
        response.put("summary", "ok");
        response.put("sourceRef", Map.of("uri", "urn:test/in"));
        response.put("outputRef", Map.of("uri", "urn:test/out"));
        response.put("execution", Map.of("stdoutSha256", "0".repeat(64)));
        response.put("comparison", Map.of("matched", true));
        Map<String, Object> event = ServiceApp.buildHarnessEvent(response);
        assertEquals("v0", event.get("schemaVersion"));
        assertEquals("build-test-runner-service", event.get("service"));
        assertEquals("build-test.run", event.get("capability"));
        assertEquals("build-test", event.get("dataClass"));
        assertEquals("ok", event.get("status"));
        assertEquals("generated->validated", event.get("stateTransition"));
        assertTrue(((String) event.get("eventType")).startsWith("build-test."));
    }

    @Test
    void experienceEventsEmittedForNonOkStatuses() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "output-divergence");
        response.put("runId", "run-1");
        response.put("programId", "BRNCH01");
        response.put("classification", "divergence-known-w0-coverage-gap");
        response.put("summary", "documented W0 gap");
        response.put("execution", Map.of("stdoutSha256", "0".repeat(64)));
        response.put("goldenMaster", Map.of(
                "classification", "synthetic",
                "expectedSha256", "1".repeat(64)));
        List<Map<String, Object>> events = ServiceApp.buildExperienceEvents(response);
        assertEquals(1, events.size());
        Map<String, Object> event = events.get(0);
        assertEquals("v0", event.get("schemaVersion"));
        assertEquals("build-test", event.get("dataClass"));
        assertEquals("observed", event.get("status"));
        assertEquals("divergence-known-w0-coverage-gap", event.get("buildTestOutcome"));
        assertTrue(((String) event.get("patternFingerprint")).matches("[0-9a-f]{64}"));
    }

    @Test
    void experienceEventsSuppressedOnSuccess() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "ok");
        assertTrue(ServiceApp.buildExperienceEvents(response).isEmpty());
        assertFalse(ServiceApp.buildHarnessEvent(response).isEmpty());
    }
}
