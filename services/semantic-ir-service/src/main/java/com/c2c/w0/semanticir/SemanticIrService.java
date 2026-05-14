package com.c2c.w0.semanticir;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class SemanticIrService {
    static final String SCHEMA_VERSION = "v0";
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    public Map<String, Object> generate(Map<String, Object> request) {
        Map<String, Object> parseOutput = objectMap(request.get("parseOutput"));
        if (parseOutput.isEmpty() && request.containsKey("program")) {
            parseOutput = request;
        }
        if (parseOutput.isEmpty()) {
            throw new IllegalArgumentException("parseOutput is required");
        }

        List<Map<String, Object>> diagnostics = mutableDiagnostics(parseOutput.get("diagnostics"));
        List<String> assumptions = strings(parseOutput.get("assumptions"));
        Map<String, Object> program = objectMap(parseOutput.get("program"));
        if (program.isEmpty()) {
            diagnostics.add(diagnostic("error", 0, "missing-program", "parseOutput.program is required"));
        }
        if (!"ok".equals(String.valueOf(parseOutput.getOrDefault("status", "failed")))) {
            diagnostics.add(diagnostic("error", 0, "parse-failed", "parseOutput status must be ok before Semantic IR generation"));
        }

        Map<String, Object> ir = buildIr(program, assumptions);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", SCHEMA_VERSION);
        response.put("status", hasErrors(diagnostics) ? "failed" : "ok");
        response.put("runId", text(request.get("runId"), text(parseOutput.get("runId"), "run-unknown")));
        response.put("workflowId", text(request.get("workflowId"), text(parseOutput.get("workflowId"), "w0-migration-v0")));
        response.put("capability", "cobol.ir");
        response.put("sourceRef", objectMap(parseOutput.get("sourceRef")));
        response.put("ir", ir);
        response.put("diagnostics", diagnostics);
        response.put("assumptions", assumptions);
        return response;
    }

    private static Map<String, Object> buildIr(Map<String, Object> program, List<String> assumptions) {
        Map<String, Object> ir = new LinkedHashMap<>();
        String programId = text(program.get("programId"), "UNKNOWN");
        String sourceHash = text(program.get("sourceHash"), "unknown");
        ir.put("schemaVersion", SCHEMA_VERSION);
        ir.put("irId", "ir-" + stable(programId) + "-" + stable(sourceHash));
        ir.put("programId", programId);
        ir.put("sourceHash", sourceHash);
        ir.put("sourceKind", text(program.get("sourceKind"), "cobol"));
        ir.put("symbols", symbols(program));
        ir.put("fieldLayouts", fieldLayouts(program));
        ir.put("statements", normalizeStatements(program));
        ir.put("controlFlow", list(program.get("controlFlow")));
        ir.put("assumptions", assumptions);
        ir.put("traceability", traceability(program));
        return ir;
    }

    private static Map<String, Object> symbols(Map<String, Object> program) {
        Map<String, Object> symbols = new LinkedHashMap<>();
        for (Map<String, Object> item : mapList(program.get("dataItems"))) {
            String name = text(item.get("name"), "");
            if (!name.isBlank()) {
                Map<String, Object> symbol = new LinkedHashMap<>();
                symbol.put("id", item.get("id"));
                symbol.put("kind", "data-item");
                symbol.put("level", item.get("level"));
                symbol.put("line", item.get("line"));
                symbol.put("numeric", item.get("numeric"));
                symbol.put("scale", item.get("scale"));
                symbols.put(name, symbol);
            }
        }
        return symbols;
    }

    private static List<Map<String, Object>> fieldLayouts(Map<String, Object> program) {
        List<Map<String, Object>> layouts = new ArrayList<>();
        for (Map<String, Object> item : mapList(program.get("dataItems"))) {
            Map<String, Object> layout = new LinkedHashMap<>();
            layout.put("id", item.get("id"));
            layout.put("name", item.get("name"));
            layout.put("level", item.get("level"));
            layout.put("picture", item.get("picture"));
            layout.put("byteSize", item.get("byteSize"));
            layout.put("occurs", item.get("occurs"));
            layout.put("numeric", item.get("numeric"));
            layout.put("signed", item.get("signed"));
            layout.put("scale", item.get("scale"));
            layout.put("sourceLine", item.get("line"));
            layouts.add(layout);
        }
        return layouts;
    }

    private static List<Map<String, Object>> normalizeStatements(Map<String, Object> program) {
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (Map<String, Object> statement : mapList(program.get("statements"))) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", statement.get("id"));
            item.put("operation", text(statement.get("kind"), "UNKNOWN").toLowerCase(Locale.ROOT));
            item.put("sourceLine", statement.get("line"));
            item.put("operands", objectMap(statement.get("operands")));
            item.put("raw", statement.get("raw"));
            normalized.add(item);
        }
        return normalized;
    }

    private static Map<String, Object> traceability(Map<String, Object> program) {
        Map<String, Object> traceability = new LinkedHashMap<>();
        for (Map<String, Object> statement : mapList(program.get("statements"))) {
            traceability.put(String.valueOf(statement.get("id")), Map.of("line", statement.get("line"), "raw", statement.get("raw")));
        }
        return traceability;
    }

    static Map<String, Object> reference(String serviceName, String kind, Object payload) {
        String body = canonical(payload);
        String hash = sha256(body);
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("uri", "urn:" + serviceName + "/" + kind + "/" + hash);
        ref.put("sha256", hash);
        ref.put("byteSize", body.getBytes(StandardCharsets.UTF_8).length);
        ref.put("mimeType", "application/json");
        ref.put("kind", kind);
        return ref;
    }

    static String canonical(Object payload) {
        try {
            return JSON.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("payload cannot be serialized", e);
        }
    }

    static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                out.append(String.format("%02x", b));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> objectMap(Object value) {
        return value instanceof Map<?, ?> map ? new LinkedHashMap<>((Map<String, Object>) map) : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object value) {
        return value instanceof List<?> values ? new ArrayList<>((List<Object>) values) : new ArrayList<>();
    }

    private static List<Map<String, Object>> mapList(Object value) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list(value)) {
            result.add(objectMap(item));
        }
        return result;
    }

    private static List<String> strings(Object value) {
        List<String> result = new ArrayList<>();
        for (Object item : list(value)) {
            if (item != null) {
                result.add(String.valueOf(item));
            }
        }
        return result;
    }

    private static List<Map<String, Object>> mutableDiagnostics(Object value) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list(value)) {
            result.add(objectMap(item));
        }
        return result;
    }

    private static Map<String, Object> diagnostic(String severity, int line, String code, String message) {
        Map<String, Object> diagnostic = new LinkedHashMap<>();
        diagnostic.put("severity", severity);
        diagnostic.put("line", line);
        diagnostic.put("code", code);
        diagnostic.put("message", message);
        return diagnostic;
    }

    private static boolean hasErrors(List<Map<String, Object>> diagnostics) {
        return diagnostics.stream().anyMatch(diagnostic -> "error".equals(diagnostic.get("severity")));
    }

    private static String text(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = String.valueOf(value).trim();
        return text.isBlank() ? fallback : text;
    }

    private static String stable(String value) {
        return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-").replaceAll("-+", "-");
    }
}
