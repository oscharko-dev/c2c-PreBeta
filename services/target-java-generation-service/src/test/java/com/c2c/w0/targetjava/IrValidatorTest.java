package com.c2c.w0.targetjava;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IrValidatorTest {

    @Test
    void acceptsMinimallyValidV0Document() {
        Map<String, Object> ir = baseIr();
        List<Map<String, Object>> diagnostics = IrValidator.validate(ir);
        assertFalse(IrValidator.hasErrors(diagnostics),
                "expected no errors on minimal valid IR, got: " + diagnostics);
    }

    @Test
    void rejectsMissingDocument() {
        List<Map<String, Object>> diagnostics = IrValidator.validate(null);
        assertTrue(IrValidator.hasErrors(diagnostics));
        assertEquals("missing-ir", diagnostics.get(0).get("code"));
    }

    @Test
    void rejectsUnsupportedSchemaVersion() {
        Map<String, Object> ir = baseIr();
        ir.put("schemaVersion", "v1");
        List<Map<String, Object>> diagnostics = IrValidator.validate(ir);
        assertTrue(IrValidator.hasErrors(diagnostics));
        assertTrue(diagnostics.stream().anyMatch(
                d -> "unsupported-schema-version".equals(d.get("code"))));
    }

    @Test
    void rejectsMissingRequiredFields() {
        Map<String, Object> ir = baseIr();
        ir.remove("programId");
        ir.remove("sourceHash");
        List<Map<String, Object>> diagnostics = IrValidator.validate(ir);
        assertTrue(IrValidator.hasErrors(diagnostics));
        long missingCount = diagnostics.stream()
                .filter(d -> "missing-required-field".equals(d.get("code"))).count();
        assertEquals(2, missingCount);
    }

    @Test
    void rejectsBlockerAssumption() {
        Map<String, Object> ir = baseIr();
        ir.put("assumptions", List.of("blocker: REDEFINES used in S2-only sample"));
        List<Map<String, Object>> diagnostics = IrValidator.validate(ir);
        assertTrue(IrValidator.hasErrors(diagnostics));
        assertTrue(diagnostics.stream().anyMatch(
                d -> "blocker-assumption".equals(d.get("code"))));
    }

    @Test
    void allowsNonBlockerAssumptions() {
        Map<String, Object> ir = baseIr();
        ir.put("assumptions", List.of(
                "W0 assumes display-compatible fixed-point decimal semantics.",
                "Some informational note"));
        List<Map<String, Object>> diagnostics = IrValidator.validate(ir);
        assertFalse(IrValidator.hasErrors(diagnostics));
    }

    private static Map<String, Object> baseIr() {
        Map<String, Object> ir = new LinkedHashMap<>();
        ir.put("schemaVersion", "v0");
        ir.put("irId", "ir-test-1");
        ir.put("programId", "TEST01");
        ir.put("sourceHash", "deadbeef");
        ir.put("sourceKind", "cobol");
        ir.put("fieldLayouts", List.of());
        ir.put("statements", List.of());
        ir.put("assumptions", List.of());
        ir.put("traceability", Map.of());
        return ir;
    }
}
