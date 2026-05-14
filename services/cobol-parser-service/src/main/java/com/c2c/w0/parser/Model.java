package com.c2c.w0.parser;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Model {
    public static final String SCHEMA_VERSION = "v0";

    private Model() {
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

    static String text(Object value) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return text.isBlank() ? null : text;
    }

    static int intValue(Object value, int fallback) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        try {
            return value == null ? fallback : Integer.parseInt(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static long longValue(Object value, long fallback) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        try {
            return value == null ? fallback : Long.parseLong(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static Reference referenceFrom(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return null;
        }
        String uri = text(map.get("uri"));
        if (uri == null) {
            return null;
        }
        return new Reference(
                uri,
                text(map.get("sha256")),
                longValue(map.get("byteSize"), longValue(map.get("byte_size"), 0)),
                text(map.get("mimeType")),
                text(map.get("kind"))
        );
    }

    static String stableToken(String value) {
        if (value == null || value.isBlank()) {
            return "x";
        }
        String token = value.toLowerCase()
                .replaceAll("[^a-z0-9-]", "-")
                .replaceAll("-+", "-")
                .replaceAll("^-|-$", "");
        if (token.isBlank()) {
            return "x";
        }
        return token.length() <= 32 ? token : token.substring(0, 32);
    }

    static final class Reference {
        public String uri;
        public String sha256;
        public long byteSize;
        public String mimeType;
        public String kind;

        Reference() {
        }

        Reference(String uri, String sha256, long byteSize, String mimeType, String kind) {
            this.uri = uri;
            this.sha256 = sha256;
            this.byteSize = Math.max(0, byteSize);
            this.mimeType = mimeType;
            this.kind = kind;
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("uri", uri);
            map.put("sha256", sha256);
            map.put("byteSize", byteSize);
            if (mimeType != null && !mimeType.isBlank()) {
                map.put("mimeType", mimeType);
            }
            if (kind != null && !kind.isBlank()) {
                map.put("kind", kind);
            }
            return map;
        }
    }

    static final class Diagnostic {
        public String severity;
        public int line;
        public String code;
        public String message;

        Diagnostic() {
        }

        Diagnostic(String severity, int line, String code, String message) {
            this.severity = severity;
            this.line = line;
            this.code = code;
            this.message = message;
        }
    }

    static final class Division {
        public String name;
        public int line;

        Division() {
        }

        Division(String name, int line) {
            this.name = name;
            this.line = line;
        }
    }

    static final class DataItem {
        public String id;
        public String name;
        public int level;
        public String picture;
        public String value;
        public Integer occurs;
        public String occursDependingOn;
        public boolean numeric;
        public boolean signed;
        public int scale;
        public int byteSize;
        public boolean group;
        public int line;
        public List<String> assumptions = new ArrayList<>();

        DataItem() {
        }
    }

    static final class Statement {
        public String id;
        public String kind;
        public int line;
        public String raw;
        public Map<String, Object> operands = new LinkedHashMap<>();
        public List<String> assumptions = new ArrayList<>();

        Statement() {
        }
    }

    static final class ControlEdge {
        public String id;
        public String from;
        public String to;
        public String label;

        ControlEdge() {
        }

        ControlEdge(String from, String to, String label) {
            this.id = "e-" + stableToken(from) + "-" + stableToken(to) + "-" + stableToken(label);
            this.from = from;
            this.to = to;
            this.label = label;
        }
    }

    static final class ParsedProgram {
        public String programId;
        public String sourceKind = "cobol";
        public String sourceHash;
        public List<Division> divisions = new ArrayList<>();
        public List<DataItem> dataItems = new ArrayList<>();
        public List<Statement> statements = new ArrayList<>();
        public List<ControlEdge> controlFlow = new ArrayList<>();
        public List<String> assumptions = new ArrayList<>();

        ParsedProgram() {
        }

        ParsedProgram(String programId, String sourceHash) {
            this.programId = programId;
            this.sourceHash = sourceHash;
        }
    }

    static final class ParseRequest {
        public String schemaVersion;
        public String runId;
        public String stepId;
        public String workflowId;
        public String capability;
        public String source;
        public String sourceHash;
        public Reference inputRef;

        static ParseRequest fromMap(Map<String, Object> payload) {
            ParseRequest request = new ParseRequest();
            request.schemaVersion = text(payload.get("schemaVersion"));
            request.runId = text(payload.get("runId"));
            request.stepId = text(payload.get("stepId"));
            request.workflowId = text(payload.get("workflowId"));
            request.capability = text(payload.get("capability"));
            request.source = firstText(payload.get("source"), payload.get("sourceText"), payload.get("code"));
            request.sourceHash = text(payload.get("sourceHash"));
            request.inputRef = referenceFrom(payload.get("inputRef"));
            if (request.capability == null) {
                request.capability = "cobol.parse";
            }
            return request;
        }

        private static String firstText(Object... values) {
            for (Object value : values) {
                String text = text(value);
                if (text != null) {
                    return text;
                }
            }
            return null;
        }
    }

    static final class ParseResult {
        public String schemaVersion = SCHEMA_VERSION;
        public String status;
        public String runId;
        public String stepId;
        public String workflowId;
        public String capability;
        public String message;
        public Reference sourceRef;
        public Reference outputRef;
        public ParsedProgram program;
        public List<Diagnostic> diagnostics = new ArrayList<>();
        public List<String> assumptions = new ArrayList<>();

        ParseResult() {
        }
    }
}
