package com.c2c.w0.semanticir;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SemanticIrServiceTest {
    private final SemanticIrService service = new SemanticIrService();

    @Test
    void normalizesParserOutputIntoSemanticIr() {
        Map<String, Object> response = service.generate(Map.of(
                "runId", "run-1",
                "parseOutput", Map.of(
                        "status", "ok",
                        "runId", "run-1",
                        "workflowId", "w0-migration-v0",
                        "sourceRef", Map.of("uri", "urn:source", "sha256", "0".repeat(64), "byteSize", 10),
                        "program", Map.of(
                                "programId", "TEST01",
                                "sourceHash", "a".repeat(64),
                                "sourceKind", "cobol",
                                "dataItems", List.of(Map.of(
                                        "id", "d-ws-total-1",
                                        "name", "WS-TOTAL",
                                        "level", 1,
                                        "picture", "S9(5)V99",
                                        "byteSize", 7,
                                        "numeric", true,
                                        "signed", true,
                                        "scale", 2,
                                        "line", 4
                                )),
                                "statements", List.of(Map.of(
                                        "id", "s-display-1",
                                        "kind", "DISPLAY",
                                        "line", 8,
                                        "raw", "DISPLAY WS-TOTAL",
                                        "operands", Map.of("items", List.of("WS-TOTAL"))
                                )),
                                "controlFlow", List.of()
                        ),
                        "diagnostics", List.of(),
                        "assumptions", List.of("decimal assumption")
                )
        ));

        assertEquals("ok", response.get("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> ir = (Map<String, Object>) response.get("ir");
        assertEquals("TEST01", ir.get("programId"));
        assertFalse(((Map<?, ?>) ir.get("symbols")).isEmpty());
        assertFalse(((List<?>) ir.get("fieldLayouts")).isEmpty());
        assertFalse(((List<?>) ir.get("statements")).isEmpty());
    }

    @Test
    void rejectsFailedParserOutput() {
        Map<String, Object> response = service.generate(Map.of(
                "parseOutput", Map.of(
                        "status", "failed",
                        "program", Map.of("programId", "BAD", "sourceHash", "b".repeat(64)),
                        "diagnostics", List.of(),
                        "assumptions", List.of()
                )
        ));

        assertEquals("failed", response.get("status"));
        assertTrue(((List<?>) response.get("diagnostics")).stream().anyMatch(item -> item.toString().contains("parse-failed")));
    }
}
