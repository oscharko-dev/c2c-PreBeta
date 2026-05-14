package com.c2c.w0.semanticir;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
                                        "id", "s-paragraph-1",
                                        "kind", "PARAGRAPH",
                                        "line", 7,
                                        "raw", "MAIN",
                                        "operands", Map.of("name", "MAIN")
                                ), Map.of(
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
        @SuppressWarnings("unchecked")
        Map<String, Object> symbols = (Map<String, Object>) ir.get("symbols");
        assertNotNull(symbols.get("MAIN"));
        @SuppressWarnings("unchecked")
        Map<String, Object> traceability = (Map<String, Object>) ir.get("traceability");
        assertNotNull(traceability.get("d-ws-total-1"));
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

    @Test
    void carriesValueOccursInheritanceAndStructuredOperands() {
        Map<String, Object> accountGroup = new LinkedHashMap<>();
        accountGroup.put("id", "d-account");
        accountGroup.put("name", "WS-ACCOUNT");
        accountGroup.put("level", 10);
        accountGroup.put("picture", null);
        accountGroup.put("byteSize", 0);
        accountGroup.put("occurs", 4);
        accountGroup.put("numeric", false);
        accountGroup.put("signed", false);
        accountGroup.put("scale", 0);
        accountGroup.put("line", 8);

        Map<String, Object> status = new LinkedHashMap<>();
        status.put("id", "d-status");
        status.put("name", "WS-STATUS");
        status.put("level", 15);
        status.put("picture", "X(1)");
        status.put("byteSize", 1);
        status.put("numeric", false);
        status.put("signed", false);
        status.put("scale", 0);
        status.put("value", "SPACE");
        status.put("line", 9);

        Map<String, Object> response = service.generate(Map.of(
                "parseOutput", Map.of(
                        "status", "ok",
                        "program", Map.of(
                                "programId", "BRNCH01",
                                "sourceHash", "b".repeat(64),
                                "sourceKind", "cobol",
                                "dataItems", List.of(accountGroup, status),
                                "statements", List.of(Map.of(
                                        "id", "s-perform-1",
                                        "kind", "PERFORM",
                                        "line", 25,
                                        "raw", "PERFORM VARYING WS-INDEX FROM 1 BY 1 UNTIL WS-INDEX > 4",
                                        "operands", Map.of(
                                                "tokens", List.of("PERFORM", "VARYING", "WS-INDEX", "FROM", "1", "BY", "1", "UNTIL", "WS-INDEX", ">", "4"),
                                                "mode", "varying-until",
                                                "varying", "WS-INDEX",
                                                "from", "1",
                                                "by", "1",
                                                "until", "WS-INDEX > 4"
                                        )
                                )),
                                "controlFlow", List.of()
                        ),
                        "diagnostics", List.of(),
                        "assumptions", List.of()
                )
        ));

        assertEquals("ok", response.get("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> ir = (Map<String, Object>) response.get("ir");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> layouts = (List<Map<String, Object>>) ir.get("fieldLayouts");
        Map<String, Object> statusLayout = layouts.stream()
                .filter(layout -> "WS-STATUS".equals(layout.get("name")))
                .findFirst()
                .orElseThrow();
        assertEquals(4, statusLayout.get("occurs"));
        assertEquals("WS-ACCOUNT", statusLayout.get("occursParent"));
        assertEquals("SPACE", statusLayout.get("value"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> statements = (List<Map<String, Object>>) ir.get("statements");
        @SuppressWarnings("unchecked")
        Map<String, Object> operands = (Map<String, Object>) statements.getFirst().get("operands");
        assertTrue(operands.containsKey("performModel"));
        assertTrue(operands.containsKey("conditionModel"));
    }
}
