package com.c2c.w0.targetjava;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ServiceApp {

    private static final String SERVICE_NAME = TargetJavaGenerationService.SERVICE_NAME;
    private static final int DEFAULT_PORT = 8083;
    // 4 MB matches the operational ceiling we set elsewhere in W0 for capability
    // services; IR documents for the W0 corpus are kilobytes, so this gives
    // headroom while preventing memory exhaustion from a malicious caller.
    static final int MAX_REQUEST_BYTES = 4 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private ServiceApp() {
    }

    public static void main(String[] args) throws Exception {
        int port = readPort(System.getenv("TARGET_JAVA_GENERATION_LISTEN_ADDR"));
        String eventEndpoint = normalizeEndpoint(System.getenv("HARNESS_EVENT_ENDPOINT"));
        TargetJavaGenerationService service = new TargetJavaGenerationService();

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            sendJson(exchange, 200, Map.of("status", "ok", "service", SERVICE_NAME));
        });

        server.createContext("/v0/generate", exchange -> handleGenerate(exchange, service, eventEndpoint));

        server.start();
        System.out.printf("%s listening on %d%n", SERVICE_NAME, port);
        Thread.currentThread().join();
    }

    static void handleGenerate(HttpExchange exchange,
                               TargetJavaGenerationService service,
                               String eventEndpoint) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendText(exchange, 405, "method not allowed");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType != null && !contentType.toLowerCase().contains("application/json")) {
            sendJson(exchange, 415, Map.of("status", "failed",
                    "error", "content-type must be application/json"));
            return;
        }
        byte[] body;
        try {
            body = readBoundedBody(exchange);
        } catch (RequestTooLargeException e) {
            sendJson(exchange, 413, Map.of("status", "failed",
                    "error", "request body exceeds " + MAX_REQUEST_BYTES + " bytes"));
            return;
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> request = JSON.readValue(body, Map.class);
            Map<String, Object> response = service.generate(request);
            int status = "ok".equals(response.get("status")) ? 200 : 422;
            sendJson(exchange, status, response);
            emitEvent(eventEndpoint, response);
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, Map.of("status", "failed", "error", e.getMessage()));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            sendJson(exchange, 400, Map.of("status", "failed",
                    "error", "malformed JSON: " + (e.getOriginalMessage() == null ? "parse error" : e.getOriginalMessage())));
        } catch (Exception e) {
            sendJson(exchange, 500, Map.of("status", "failed",
                    "error", e.getMessage() == null ? "unknown" : e.getMessage()));
        }
    }

    static byte[] readBoundedBody(HttpExchange exchange) throws IOException {
        try (var input = exchange.getRequestBody();
             var out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buf)) != -1) {
                total += read;
                if (total > MAX_REQUEST_BYTES) {
                    throw new RequestTooLargeException();
                }
                out.write(buf, 0, read);
            }
            return out.toByteArray();
        }
    }

    static final class RequestTooLargeException extends IOException {
    }

    static void emitEvent(String endpoint, Map<String, Object> response) {
        if (endpoint == null) {
            return;
        }
        try {
            String status = String.valueOf(response.get("status"));
            String eventType = switch (status) {
                case "ok" -> "target.java.generate.completed";
                default -> "target.java.generate.failed";
            };
            // An "unsupported" sub-event is emitted in addition when the response
            // carries diagnostics that mark unsupported IR nodes.
            boolean hasUnsupported = false;
            if (response.get("diagnostics") instanceof List<?> diagnostics) {
                for (Object entry : diagnostics) {
                    if (entry instanceof Map<?, ?> m
                            && "unsupported-statement".equals(m.get("code"))) {
                        hasUnsupported = true;
                        break;
                    }
                }
            }
            postEvent(endpoint, buildEvent(response, eventType));
            if (hasUnsupported) {
                postEvent(endpoint, buildEvent(response, "target.java.generate.unsupported"));
            }
        } catch (Exception ignored) {
            // Harness eventing is best effort for capability services.
        }
    }

    static Map<String, Object> buildEvent(Map<String, Object> response, String eventType) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("schemaVersion", "v0");
        event.put("eventId", "evt-" + SERVICE_NAME + "-" + UUID.randomUUID());
        event.put("eventType", eventType);
        event.put("service", SERVICE_NAME);
        event.put("runId", response.get("runId"));
        event.put("stepId", 1);
        event.put("actor", SERVICE_NAME);
        event.put("capability", TargetJavaGenerationService.CAPABILITY);
        event.put("dataClass", "generator");
        event.put("redactionProfile", "harness-control-plane");
        event.put("policyDecision", "policy allow");
        event.put("status", response.get("status"));
        event.put("stateTransition", "service.step");
        event.put("inputRef", response.get("sourceRef"));
        event.put("outputRef", response.get("outputRef"));
        Map<String, Object> payload = new LinkedHashMap<>();
        if (response.get("traceability") instanceof Map<?, ?> trace) {
            payload.put("programId", trace.get("programId"));
            payload.put("irId", trace.get("irId"));
            payload.put("entryClass", ((Map<?, ?>) response.getOrDefault("generatedProject", Map.of())).get("entryClass"));
            payload.put("fileCount", ((Map<?, ?>) response.getOrDefault("generatedProject", Map.of())).get("fileCount"));
        }
        event.put("payload", payload);
        event.put("createdAt", Instant.now().toString());
        return event;
    }

    private static void postEvent(String endpoint, Map<String, Object> event) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(event)))
                .build();
        HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding());
    }

    private static int readPort(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEFAULT_PORT;
        }
        String candidate = raw.trim();
        if (candidate.startsWith(":")) {
            candidate = candidate.substring(1);
        }
        if (candidate.contains(":")) {
            candidate = candidate.substring(candidate.lastIndexOf(":") + 1);
        }
        try {
            return Integer.parseInt(candidate);
        } catch (NumberFormatException e) {
            return DEFAULT_PORT;
        }
    }

    private static String normalizeEndpoint(String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return null;
        }
        if (endpoint.endsWith("/v0/events")) {
            return endpoint;
        }
        return endpoint.endsWith("/") ? endpoint + "v0/events" : endpoint + "/v0/events";
    }

    private static void sendText(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(body);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
