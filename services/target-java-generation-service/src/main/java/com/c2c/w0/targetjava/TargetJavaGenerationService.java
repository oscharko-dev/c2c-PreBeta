package com.c2c.w0.targetjava;

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

/**
 * Orchestrates Semantic IR v0 → Java project generation behind the W0 service
 * envelope used by the rest of the harness: validate, generate, attach a
 * stable {@code outputRef}, and return a structured response.
 */
public final class TargetJavaGenerationService {

    public static final String SCHEMA_VERSION = "v0";
    public static final String CAPABILITY = "target.java.generate";
    public static final String SERVICE_NAME = "target-java-generation-service";

    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    public Map<String, Object> generate(Map<String, Object> request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }

        Map<String, Object> ir = extractIr(request);
        if (ir.isEmpty()) {
            throw new IllegalArgumentException("ir document is required (provide 'ir' or 'irOutput.ir')");
        }

        List<Map<String, Object>> diagnostics = new ArrayList<>(IrValidator.validate(ir));
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", SCHEMA_VERSION);
        response.put("capability", CAPABILITY);
        response.put("runId", string(request.get("runId"),
                string(((Map<?, ?>) request.getOrDefault("irOutput", Map.of())).get("runId"), "run-unknown")));
        response.put("workflowId", string(request.get("workflowId"),
                string(((Map<?, ?>) request.getOrDefault("irOutput", Map.of())).get("workflowId"), "w0-migration-v0")));
        response.put("sourceRef", asMap(request.get("sourceRef"),
                asMap(((Map<?, ?>) request.getOrDefault("irOutput", Map.of())).get("sourceRef"), Map.of())));

        Map<String, Object> generated = new LinkedHashMap<>();
        Map<String, Object> traceability = new LinkedHashMap<>();
        List<String> assumptions = stringList(ir.get("assumptions"));

        if (IrValidator.hasErrors(diagnostics)) {
            response.put("status", "failed");
            response.put("diagnostics", diagnostics);
            response.put("assumptions", assumptions);
            response.put("generatedProject", generated);
            response.put("traceability", traceability);
            response.put("outputRef", reference(SERVICE_NAME, "target-java-project", generated));
            return response;
        }

        JavaProjectGenerator.GenerationResult result = JavaProjectGenerator.generate(ir);
        diagnostics.addAll(result.diagnostics());

        Map<String, Object> filesPayload = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : result.files().entrySet()) {
            filesPayload.put(entry.getKey(), entry.getValue());
        }
        generated.put("entryClass", result.entryClass());
        generated.put("entryFilePath", result.entryFilePath());
        generated.put("fileCount", result.files().size());
        generated.put("files", filesPayload);

        response.put("status", "ok");
        response.put("diagnostics", diagnostics);
        response.put("assumptions", assumptions);
        response.put("generatedProject", generated);
        response.put("traceability", result.traceability());
        response.put("outputRef", reference(SERVICE_NAME, "target-java-project", filesPayload));
        return response;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> extractIr(Map<String, Object> request) {
        if (request.get("ir") instanceof Map<?, ?> ir) {
            return new LinkedHashMap<>((Map<String, Object>) ir);
        }
        if (request.containsKey("irOutput")) {
            Object irOutput = request.get("irOutput");
            if (!(irOutput instanceof Map<?, ?> outer)) {
                throw new IllegalArgumentException("irOutput must be an object");
            }
            Object inner = ((Map<String, Object>) outer).get("ir");
            if (inner instanceof Map<?, ?> map) {
                return new LinkedHashMap<>((Map<String, Object>) map);
            }
            throw new IllegalArgumentException(
                    "irOutput.ir is required when irOutput is provided");
        }
        if (request.containsKey("schemaVersion") && request.containsKey("programId")
                && request.containsKey("statements")) {
            // Caller passed the IR document directly.
            return new LinkedHashMap<>(request);
        }
        return new LinkedHashMap<>();
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
                out.append(String.format(Locale.ROOT, "%02x", b));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value, Map<String, Object> fallback) {
        if (value instanceof Map<?, ?> map) {
            return new LinkedHashMap<>((Map<String, Object>) map);
        }
        return new LinkedHashMap<>(fallback);
    }

    private static List<String> stringList(Object value) {
        List<String> out = new ArrayList<>();
        if (value instanceof List<?> list) {
            for (Object entry : list) {
                if (entry != null) {
                    out.add(entry.toString());
                }
            }
        }
        return out;
    }

    private static String string(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = value.toString().trim();
        return text.isBlank() ? fallback : text;
    }
}
