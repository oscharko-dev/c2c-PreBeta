package com.c2c.w0.targetjava;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JavaProjectGeneratorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void classNameDerivedFromProgramId() {
        assertEquals("Brnch01", JavaProjectGenerator.toClassName("BRNCH01"));
        assertEquals("CtrlDec01", JavaProjectGenerator.toClassName("CTRL-DEC-01"));
        assertEquals("P1", JavaProjectGenerator.toClassName("1"));
        assertEquals("Program", JavaProjectGenerator.toClassName(""));
    }

    @Test
    void javaIdentifierSanitisesCobolNamesAndAvoidsKeywords() {
        assertEquals("wsTotal", JavaProjectGenerator.javaIdentifier("WS-TOTAL"));
        assertEquals("wsAmount", JavaProjectGenerator.javaIdentifier("WS-AMOUNT"));
        assertEquals("f1a", JavaProjectGenerator.javaIdentifier("1A"));
        assertEquals("class_", JavaProjectGenerator.javaIdentifier("CLASS"));
    }

    @Test
    void emitsProjectWithRuntimeDependencyAndTraceJson() throws Exception {
        Map<String, Object> ir = irWithFieldsAndStatements();

        JavaProjectGenerator.GenerationResult result = JavaProjectGenerator.generate(ir);

        assertNotNull(result.files().get("pom.xml"));
        assertTrue(result.files().get("pom.xml").contains("c2c-target-java-runtime"));
        assertTrue(result.files().get("pom.xml").contains("target-generator-contract-v0"));

        String entry = result.files().get(result.entryFilePath());
        assertNotNull(entry, "entry java file should be present at " + result.entryFilePath());
        assertTrue(entry.contains("public final class"));
        assertTrue(entry.contains("PROGRAM_ID = \"DEMO01\""));
        assertTrue(entry.contains("CobolField"));
        assertTrue(entry.contains("PictureSpec.parse"));

        String trace = result.files().get("src/main/resources/c2c-trace.json");
        assertNotNull(trace);
        Map<?, ?> traceJson = JSON.readValue(trace, Map.class);
        assertEquals("target-generator-contract-v0", traceJson.get("contractVersion"));
        assertEquals("semantic-ir-v0", traceJson.get("irVersion"));
        assertEquals("DEMO01", traceJson.get("programId"));
        assertNotNull(traceJson.get("files"));
    }

    @Test
    void unsupportedStatementsProduceExplicitDiagnostics() {
        Map<String, Object> ir = irWithFieldsAndStatements();
        // Append a control-flow statement that the W0 generator does not translate.
        List<Map<String, Object>> statements = mutableStatements(ir);
        statements.add(Map.of(
                "id", "s-if-99",
                "operation", "if",
                "sourceLine", 99,
                "operands", Map.of("condition", "WS-AMOUNT > 0"),
                "raw", "IF WS-AMOUNT > 0"));
        ir.put("statements", statements);

        JavaProjectGenerator.GenerationResult result = JavaProjectGenerator.generate(ir);
        assertTrue(result.diagnostics().stream().anyMatch(
                d -> "unsupported-statement".equals(d.get("code"))),
                "expected unsupported-statement diagnostic, got: " + result.diagnostics());

        // And the generated source records an assumption for that statement.
        String entry = result.files().get(result.entryFilePath());
        assertTrue(entry.contains("s-if-99"), "expected ir node id in generated assumption record");
        assertTrue(entry.contains("assumptionRegistry.record"));
    }

    @Test
    void generationIsDeterministic() {
        Map<String, Object> ir = irWithFieldsAndStatements();
        JavaProjectGenerator.GenerationResult first = JavaProjectGenerator.generate(ir);
        JavaProjectGenerator.GenerationResult second = JavaProjectGenerator.generate(deepCopy(ir));
        assertEquals(first.files().keySet(), second.files().keySet());
        for (String path : first.files().keySet()) {
            assertEquals(first.files().get(path), second.files().get(path),
                    "file content drifted between runs: " + path);
        }
    }

    @Test
    void groupItemsAndOccursAreSkippedWithDiagnostics() {
        Map<String, Object> ir = irWithFieldsAndStatements();
        List<Map<String, Object>> layouts = mutableLayouts(ir);
        Map<String, Object> group = new LinkedHashMap<>();
        group.put("id", "d-group");
        group.put("name", "WS-GROUP");
        group.put("level", 1);
        group.put("picture", null);
        group.put("byteSize", 0);
        group.put("numeric", false);
        group.put("signed", false);
        group.put("scale", 0);
        group.put("sourceLine", 7);
        layouts.add(group);

        Map<String, Object> occurs = new LinkedHashMap<>();
        occurs.put("id", "d-occurs");
        occurs.put("name", "WS-ARRAY");
        occurs.put("level", 5);
        occurs.put("picture", "9(3)");
        occurs.put("byteSize", 3);
        occurs.put("occurs", 4);
        occurs.put("numeric", true);
        occurs.put("signed", false);
        occurs.put("scale", 0);
        occurs.put("sourceLine", 8);
        layouts.add(occurs);

        ir.put("fieldLayouts", layouts);

        JavaProjectGenerator.GenerationResult result = JavaProjectGenerator.generate(ir);
        assertTrue(result.diagnostics().stream().anyMatch(
                d -> "skipped-group-item".equals(d.get("code"))));
        assertTrue(result.diagnostics().stream().anyMatch(
                d -> "skipped-occurs".equals(d.get("code"))));

        String entry = result.files().get(result.entryFilePath());
        assertFalse(entry.contains("WS-GROUP\""), "group item should not be materialised as a CobolField");
        assertFalse(entry.contains("WS-ARRAY\""), "occurs item should not be materialised");
    }

    private static Map<String, Object> irWithFieldsAndStatements() {
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

        ir.put("fieldLayouts", new java.util.ArrayList<>(List.of(wsTotal)));

        List<Map<String, Object>> statements = new java.util.ArrayList<>();
        statements.add(Map.of(
                "id", "s-paragraph-1",
                "operation", "paragraph",
                "sourceLine", 7,
                "operands", Map.of("name", "MAIN"),
                "raw", "MAIN"));
        statements.add(Map.of(
                "id", "s-display-1",
                "operation", "display",
                "sourceLine", 8,
                "operands", Map.of("items", List.of("\"TOTAL=\"", "WS-TOTAL")),
                "raw", "DISPLAY \"TOTAL=\" WS-TOTAL"));
        statements.add(Map.of(
                "id", "s-stop-1",
                "operation", "stop",
                "sourceLine", 9,
                "operands", Map.of(),
                "raw", "STOP RUN"));
        ir.put("statements", statements);

        ir.put("controlFlow", List.of());
        ir.put("assumptions", List.of("W0 assumes display-compatible fixed-point decimal semantics."));
        ir.put("traceability", Map.of());
        return ir;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> mutableStatements(Map<String, Object> ir) {
        return new java.util.ArrayList<>((List<Map<String, Object>>) ir.get("statements"));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> mutableLayouts(Map<String, Object> ir) {
        return new java.util.ArrayList<>((List<Map<String, Object>>) ir.get("fieldLayouts"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deepCopy(Map<String, Object> ir) {
        try {
            String text = JSON.writeValueAsString(ir);
            return JSON.readValue(text, Map.class);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
