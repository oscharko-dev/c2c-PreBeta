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
        for (Map<String, Object> statement : mapList(program.get("statements"))) {
            if (!"PARAGRAPH".equals(text(statement.get("kind"), ""))) {
                continue;
            }
            Map<String, Object> operands = objectMap(statement.get("operands"));
            String name = text(operands.get("name"), "");
            if (name.isBlank()) {
                continue;
            }
            Map<String, Object> symbol = new LinkedHashMap<>();
            symbol.put("id", statement.get("id"));
            symbol.put("kind", "paragraph");
            symbol.put("line", statement.get("line"));
            symbols.put(name, symbol);
        }
        return symbols;
    }

    private static List<Map<String, Object>> fieldLayouts(Map<String, Object> program) {
        List<Map<String, Object>> layouts = new ArrayList<>();
        List<Map<String, Object>> activeOccursGroups = new ArrayList<>();
        for (Map<String, Object> item : mapList(program.get("dataItems"))) {
            int level = intValue(item.get("level"), 0);
            activeOccursGroups.removeIf(group -> intValue(group.get("level"), 0) >= level);

            Map<String, Object> layout = new LinkedHashMap<>();
            layout.put("id", item.get("id"));
            layout.put("name", item.get("name"));
            layout.put("level", level);
            layout.put("picture", item.get("picture"));
            layout.put("byteSize", item.get("byteSize"));
            Object ownOccurs = item.get("occurs");
            Object inheritedOccurs = activeOccursGroups.isEmpty()
                    ? null
                    : activeOccursGroups.get(activeOccursGroups.size() - 1).get("occurs");
            Object effectiveOccurs = ownOccurs == null ? inheritedOccurs : ownOccurs;
            layout.put("occurs", effectiveOccurs);
            if (ownOccurs == null && inheritedOccurs != null) {
                Map<String, Object> parent = activeOccursGroups.get(activeOccursGroups.size() - 1);
                layout.put("occursParent", parent.get("name"));
                layout.put("occursParentLevel", parent.get("level"));
            }
            layout.put("numeric", item.get("numeric"));
            layout.put("signed", item.get("signed"));
            layout.put("scale", item.get("scale"));
            layout.put("value", item.get("value"));
            layout.put("sourceLine", item.get("line"));
            layouts.add(layout);
            if (ownOccurs != null && item.get("picture") == null) {
                Map<String, Object> group = new LinkedHashMap<>();
                group.put("name", item.get("name"));
                group.put("level", level);
                group.put("occurs", ownOccurs);
                activeOccursGroups.add(group);
            }
        }
        return layouts;
    }

    private static List<Map<String, Object>> normalizeStatements(Map<String, Object> program) {
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (Map<String, Object> statement : mapList(program.get("statements"))) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", statement.get("id"));
            String operation = text(statement.get("kind"), "UNKNOWN").toLowerCase(Locale.ROOT);
            item.put("operation", operation);
            item.put("sourceLine", statement.get("line"));
            item.put("operands", enrichOperands(operation, objectMap(statement.get("operands"))));
            item.put("raw", statement.get("raw"));
            normalized.add(item);
        }
        return normalized;
    }

    private static Map<String, Object> enrichOperands(String operation, Map<String, Object> operands) {
        Map<String, Object> enriched = new LinkedHashMap<>(operands);
        switch (operation) {
            case "compute" -> {
                String expression = text(enriched.get("expression"), "");
                enriched.put("expressionTokens", tokenList(expression));
            }
            case "if" -> {
                String condition = text(enriched.get("condition"), "");
                enriched.put("conditionModel", conditionModel(condition));
            }
            case "perform" -> {
                enriched.put("performModel", performModel(enriched));
                String until = text(enriched.get("until"), "");
                if (!until.isBlank()) {
                    enriched.put("conditionModel", conditionModel(until));
                }
            }
            case "evaluate" -> {
                String selector = text(enriched.get("selector"), "");
                enriched.put("selectorTokens", tokenList(selector));
            }
            case "when" -> {
                String value = text(enriched.get("value"), "");
                enriched.put("valueTokens", tokenList(value));
            }
            case "add", "subtract", "multiply", "divide" -> enriched.put("arithmeticModel", arithmeticModel(operation, enriched));
            default -> {
                // No enrichment required for MOVE/DISPLAY/STOP/PARAGRAPH.
            }
        }
        return enriched;
    }

    private static Map<String, Object> conditionModel(String condition) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("raw", condition);
        model.put("tokens", tokenList(condition));
        for (String operator : List.of(">=", "<=", "<>", ">", "<", "=")) {
            int idx = indexOfOperator(condition, operator);
            if (idx >= 0) {
                model.put("left", condition.substring(0, idx).trim());
                model.put("operator", operator);
                model.put("right", condition.substring(idx + operator.length()).trim());
                return model;
            }
        }
        return model;
    }

    private static Map<String, Object> performModel(Map<String, Object> operands) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("mode", text(operands.get("mode"), ""));
        for (String key : List.of("varying", "from", "by", "until")) {
            if (operands.containsKey(key)) {
                model.put(key, operands.get(key));
            }
        }
        return model;
    }

    private static Map<String, Object> arithmeticModel(String operation, Map<String, Object> operands) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("operation", operation);
        for (String key : List.of("source", "sources", "target", "targets", "by", "dividend", "divisor")) {
            if (operands.containsKey(key)) {
                model.put(key, operands.get(key));
            }
        }
        return model;
    }

    private static int indexOfOperator(String condition, String operator) {
        boolean quoted = false;
        int depth = 0;
        for (int i = 0; i <= condition.length() - operator.length(); i++) {
            char ch = condition.charAt(i);
            if (ch == '"') {
                quoted = !quoted;
            } else if (!quoted && ch == '(') {
                depth++;
            } else if (!quoted && ch == ')' && depth > 0) {
                depth--;
            }
            if (!quoted && depth == 0 && condition.startsWith(operator, i)) {
                return i;
            }
        }
        return -1;
    }

    private static List<String> tokenList(String value) {
        List<String> rawTokens = new ArrayList<>();
        if (value == null || value.isBlank()) {
            return rawTokens;
        }
        int i = 0;
        while (i < value.length()) {
            while (i < value.length() && Character.isWhitespace(value.charAt(i))) {
                i++;
            }
            if (i >= value.length()) {
                break;
            }
            char ch = value.charAt(i);
            if (ch == '"') {
                int start = i++;
                while (i < value.length() && value.charAt(i) != '"') {
                    i++;
                }
                if (i < value.length()) {
                    i++;
                }
                rawTokens.add(value.substring(start, i));
                continue;
            }
            if (ch == '(') {
                int start = i++;
                int depth = 1;
                while (i < value.length() && depth > 0) {
                    char next = value.charAt(i++);
                    if (next == '(') {
                        depth++;
                    } else if (next == ')') {
                        depth--;
                    }
                }
                rawTokens.add(value.substring(start, i));
                continue;
            }
            int start = i;
            while (i < value.length() && !Character.isWhitespace(value.charAt(i)) && value.charAt(i) != '(') {
                i++;
            }
            rawTokens.add(value.substring(start, i));
        }

        List<String> combined = new ArrayList<>();
        for (int j = 0; j < rawTokens.size(); j++) {
            String token = rawTokens.get(j);
            if (j + 1 < rawTokens.size()
                    && token.matches("[A-Z][A-Z0-9-]*")
                    && rawTokens.get(j + 1).startsWith("(")
                    && rawTokens.get(j + 1).endsWith(")")) {
                combined.add(token + " " + rawTokens.get(++j));
            } else {
                combined.add(token);
            }
        }
        return combined;
    }

    private static Map<String, Object> traceability(Map<String, Object> program) {
        Map<String, Object> traceability = new LinkedHashMap<>();
        for (Map<String, Object> item : mapList(program.get("dataItems"))) {
            traceability.put(String.valueOf(item.get("id")), Map.of("line", item.get("line"), "raw", text(item.get("name"), "")));
        }
        for (Map<String, Object> statement : mapList(program.get("statements"))) {
            traceability.put(String.valueOf(statement.get("id")), Map.of("line", statement.get("line"), "raw", statement.get("raw")));
        }
        for (Map<String, Object> edge : mapList(program.get("controlFlow"))) {
            String id = text(edge.get("id"), "");
            if (!id.isBlank()) {
                traceability.put(id, Map.of("line", 0, "raw", "edge:" + text(edge.get("label"), "next")));
            }
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

    private static int intValue(Object value, int fallback) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        if (value == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String stable(String value) {
        return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-").replaceAll("-+", "-");
    }
}
