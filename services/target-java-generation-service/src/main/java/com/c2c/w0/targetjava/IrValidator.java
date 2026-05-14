package com.c2c.w0.targetjava;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal Semantic IR v0 validator used before any code is emitted.
 * <p>
 * Per target-generator-contract-v0 the generator MUST refuse to run against an
 * IR whose schema version it does not support, MUST surface explicit
 * diagnostics referencing the offending node, and MUST refuse to emit code if
 * the IR carries a blocker assumption.
 */
final class IrValidator {

    static final String SUPPORTED_SCHEMA_VERSION = "v0";
    static final String BLOCKER_PREFIX = "blocker:";

    private IrValidator() {
    }

    static List<Map<String, Object>> validate(Map<String, Object> ir) {
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        if (ir == null || ir.isEmpty()) {
            diagnostics.add(diagnostic("error", 0, "missing-ir", "ir document is required"));
            return diagnostics;
        }

        String schemaVersion = string(ir.get("schemaVersion"));
        if (!SUPPORTED_SCHEMA_VERSION.equals(schemaVersion)) {
            diagnostics.add(diagnostic("error", 0, "unsupported-schema-version",
                    "ir.schemaVersion must be '" + SUPPORTED_SCHEMA_VERSION + "', got: " + schemaVersion));
        }

        requireField(ir, "irId", diagnostics);
        requireField(ir, "programId", diagnostics);
        requireField(ir, "sourceHash", diagnostics);
        requireField(ir, "sourceKind", diagnostics);

        if (!(ir.get("fieldLayouts") instanceof List<?>)) {
            diagnostics.add(diagnostic("error", 0, "missing-field-layouts", "ir.fieldLayouts must be a list"));
        }
        if (!(ir.get("statements") instanceof List<?>)) {
            diagnostics.add(diagnostic("error", 0, "missing-statements", "ir.statements must be a list"));
        }

        Object assumptions = ir.get("assumptions");
        if (assumptions instanceof List<?> list) {
            for (Object entry : list) {
                if (entry == null) {
                    continue;
                }
                String text = entry.toString();
                if (text.toLowerCase().startsWith(BLOCKER_PREFIX)) {
                    diagnostics.add(diagnostic("error", 0, "blocker-assumption",
                            "Refusing to emit code: blocker assumption present: " + text));
                }
            }
        }

        return diagnostics;
    }

    static boolean hasErrors(List<Map<String, Object>> diagnostics) {
        for (Map<String, Object> d : diagnostics) {
            if ("error".equals(d.get("severity"))) {
                return true;
            }
        }
        return false;
    }

    static Map<String, Object> diagnostic(String severity, int line, String code, String message) {
        Map<String, Object> diagnostic = new LinkedHashMap<>();
        diagnostic.put("severity", severity);
        diagnostic.put("line", line);
        diagnostic.put("code", code);
        diagnostic.put("message", message);
        return diagnostic;
    }

    private static void requireField(Map<String, Object> ir, String field, List<Map<String, Object>> diagnostics) {
        Object value = ir.get(field);
        if (value == null || value.toString().isBlank()) {
            diagnostics.add(diagnostic("error", 0, "missing-required-field",
                    "ir." + field + " is required"));
        }
    }

    private static String string(Object value) {
        return value == null ? "" : value.toString();
    }
}
