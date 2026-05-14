package com.c2c.w0.targetjava;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TargetJavaGenerationServiceTest {

    private final TargetJavaGenerationService service = new TargetJavaGenerationService();

    @Test
    void wrapsIrInResponseEnvelopeWithOutputRef() {
        Map<String, Object> ir = sampleIr();

        Map<String, Object> response = service.generate(Map.of(
                "runId", "run-1",
                "workflowId", "w0-migration-v0",
                "sourceRef", Map.of("uri", "urn:src", "sha256", "0".repeat(64), "byteSize", 10),
                "ir", ir));

        assertEquals("ok", response.get("status"));
        assertEquals("target.java.generate", response.get("capability"));
        assertEquals("run-1", response.get("runId"));
        assertEquals("v0", response.get("schemaVersion"));

        Map<?, ?> outputRef = (Map<?, ?>) response.get("outputRef");
        assertNotNull(outputRef);
        assertTrue(outputRef.get("uri").toString().startsWith("urn:target-java-generation-service/"));
        assertEquals("application/json", outputRef.get("mimeType"));

        Map<?, ?> generated = (Map<?, ?>) response.get("generatedProject");
        Map<?, ?> files = (Map<?, ?>) generated.get("files");
        assertTrue(files.containsKey("pom.xml"));
        assertEquals("c2c.generated.demo01.Demo01", generated.get("entryClass"));
    }

    @Test
    void readsIrFromNestedIrOutput() {
        Map<String, Object> ir = sampleIr();
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("runId", "run-2");
        request.put("irOutput", Map.of(
                "runId", "run-2",
                "workflowId", "w0-migration-v0",
                "sourceRef", Map.of("uri", "urn:src", "sha256", "1".repeat(64), "byteSize", 12),
                "ir", ir));

        Map<String, Object> response = service.generate(request);
        assertEquals("ok", response.get("status"));
    }

    @Test
    void rejectsMissingIr() {
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> service.generate(Map.of("runId", "run-x")));
        assertTrue(exception.getMessage().contains("ir"));
    }

    @Test
    void rejectsIrOutputWithoutInnerIr() {
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> service.generate(Map.of("runId", "run-x", "irOutput", Map.of("runId", "run-x"))));
        assertTrue(exception.getMessage().contains("irOutput.ir"),
                "expected explicit message about irOutput.ir, got: " + exception.getMessage());
    }

    @Test
    void rejectsRawTextPayloadWithoutIr() {
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> service.generate(Map.of("runId", "run-x", "rawText", "DISPLAY 'HELLO'.")));
        assertTrue(exception.getMessage().contains("ir document is required"));
    }

    @Test
    void failedStatusOnUnsupportedSchemaVersion() {
        Map<String, Object> ir = sampleIr();
        ir.put("schemaVersion", "v1");
        Map<String, Object> response = service.generate(Map.of("runId", "run-3", "ir", ir));
        assertEquals("failed", response.get("status"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> diagnostics = (List<Map<String, Object>>) response.get("diagnostics");
        assertTrue(diagnostics.stream().anyMatch(d -> "unsupported-schema-version".equals(d.get("code"))));
        @SuppressWarnings("unchecked")
        Map<String, Object> generated = (Map<String, Object>) response.get("generatedProject");
        assertFalse(generated.containsKey("files") && !((Map<?, ?>) generated.get("files")).isEmpty(),
                "no files should be emitted when validation fails");
    }

    @Test
    void blockerAssumptionForcesFailure() {
        Map<String, Object> ir = sampleIr();
        ir.put("assumptions", List.of("blocker: requires runtime IO not modelled in W0"));
        Map<String, Object> response = service.generate(Map.of("runId", "run-4", "ir", ir));
        assertEquals("failed", response.get("status"));
    }

    @Test
    void harnessEventCarriesGeneratorContext() {
        Map<String, Object> ir = sampleIr();
        Map<String, Object> response = service.generate(Map.of("runId", "run-evt", "ir", ir));

        Map<String, Object> event = ServiceApp.buildEvent(response, "target.java.generate.completed");
        assertEquals("target-java-generation-service", event.get("service"));
        assertEquals("target.java.generate", event.get("capability"));
        assertEquals("generator", event.get("dataClass"));
        assertEquals("v0", event.get("schemaVersion"));
        Map<?, ?> payload = (Map<?, ?>) event.get("payload");
        assertEquals("DEMO01", payload.get("programId"));
    }

    @Test
    void outputRefHashIsStableForSameIr() {
        Map<String, Object> ir = sampleIr();
        Map<String, Object> firstResponse = service.generate(Map.of("runId", "a", "ir", ir));
        Map<String, Object> secondResponse = service.generate(Map.of("runId", "b", "ir", ir));
        Map<?, ?> firstRef = (Map<?, ?>) firstResponse.get("outputRef");
        Map<?, ?> secondRef = (Map<?, ?>) secondResponse.get("outputRef");
        // outputRef hashes the generated project payload only; runId is not part of it.
        assertEquals(firstRef.get("sha256"), secondRef.get("sha256"));
    }

    private static Map<String, Object> sampleIr() {
        Map<String, Object> ir = new LinkedHashMap<>();
        ir.put("schemaVersion", "v0");
        ir.put("irId", "ir-demo01");
        ir.put("programId", "DEMO01");
        ir.put("sourceHash", "abcdef");
        ir.put("sourceKind", "cobol");
        ir.put("symbols", Map.of());

        Map<String, Object> wsTotal = new LinkedHashMap<>();
        wsTotal.put("id", "d-ws-total");
        wsTotal.put("name", "WS-TOTAL");
        wsTotal.put("level", 1);
        wsTotal.put("picture", "S9(5)V99");
        wsTotal.put("byteSize", 7);
        wsTotal.put("numeric", true);
        wsTotal.put("signed", true);
        wsTotal.put("scale", 2);
        wsTotal.put("sourceLine", 5);

        ir.put("fieldLayouts", List.of(wsTotal));
        ir.put("statements", List.of(
                Map.of("id", "s-paragraph-1", "operation", "paragraph", "sourceLine", 7,
                        "operands", Map.of("name", "MAIN"), "raw", "MAIN"),
                Map.of("id", "s-stop-1", "operation", "stop", "sourceLine", 9,
                        "operands", Map.of(), "raw", "STOP RUN")
        ));
        ir.put("controlFlow", List.of());
        ir.put("assumptions", List.of("W0 assumes display-compatible fixed-point decimal semantics."));
        ir.put("traceability", Map.of());
        return ir;
    }
}
