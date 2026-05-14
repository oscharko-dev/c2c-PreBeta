package com.c2c.w0.semanticir;

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
import java.util.Map;
import java.util.UUID;

public final class ServiceApp {
    private static final String SERVICE_NAME = "semantic-ir-service";
    private static final int DEFAULT_PORT = 8082;
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private ServiceApp() {
    }

    public static void main(String[] args) throws Exception {
        int port = readPort(System.getenv("SEMANTIC_IR_LISTEN_ADDR"));
        String eventEndpoint = normalizeEndpoint(System.getenv("HARNESS_EVENT_ENDPOINT"));
        String eventToken = normalizeToken(System.getenv("HARNESS_EVENT_TOKEN"));
        SemanticIrService service = new SemanticIrService();
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            sendJson(exchange, 200, Map.of("status", "ok", "service", SERVICE_NAME));
        });

        server.createContext("/v0/ir", exchange -> {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> request = JSON.readValue(exchange.getRequestBody(), Map.class);
                Map<String, Object> response = service.generate(request);
                response.put("outputRef", SemanticIrService.reference(SERVICE_NAME, "semantic-ir", response.get("ir")));
                int status = "ok".equals(response.get("status")) ? 200 : 422;
                sendJson(exchange, status, response);
                emitEvent(eventEndpoint, eventToken, response);
            } catch (IllegalArgumentException e) {
                sendJson(exchange, 400, Map.of("status", "failed", "error", e.getMessage()));
            } catch (Exception e) {
                sendJson(exchange, 500, Map.of("status", "failed", "error", e.getMessage() == null ? "unknown" : e.getMessage()));
            }
        });

        server.start();
        System.out.printf("%s listening on %d%n", SERVICE_NAME, port);
        Thread.currentThread().join();
    }

    private static void emitEvent(String endpoint, String eventToken, Map<String, Object> response) {
        if (endpoint == null) {
            return;
        }
        try {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("schemaVersion", "v0");
            event.put("eventId", "evt-" + SERVICE_NAME + "-" + UUID.randomUUID());
            event.put("eventType", "ok".equals(response.get("status")) ? "cobol.ir.completed" : "cobol.ir.failed");
            event.put("service", SERVICE_NAME);
            event.put("runId", response.get("runId"));
            event.put("stepId", 1);
            event.put("actor", SERVICE_NAME);
            event.put("capability", "cobol.ir");
            event.put("dataClass", "parser");
            event.put("redactionProfile", "harness-control-plane");
            event.put("policyDecision", "policy allow");
            event.put("status", response.get("status"));
            event.put("stateTransition", "service.step");
            event.put("inputRef", response.get("sourceRef"));
            event.put("outputRef", response.get("outputRef"));
            event.put("payload", Map.of("irId", ((Map<?, ?>) response.get("ir")).get("irId")));
            event.put("createdAt", Instant.now().toString());
            //noinspection HttpHeaders
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint))
                    .header("Content-Type", "application/json")
                    .header("X-Harness-Actor", SERVICE_NAME)
                    .header("X-Harness-Role", "service");
            if (eventToken != null) {
                builder.header("Authorization", "Bearer " + eventToken);
            }
            HttpRequest request = builder
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(event)))
                    .build();
            try (HttpClient client = HttpClient.newHttpClient()) {
                client.send(request, HttpResponse.BodyHandlers.discarding());
            }
        } catch (Exception ignored) {
            // Harness eventing is best effort for capability services.
        }
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

    private static String normalizeToken(String token) {
        if (token == null || token.isBlank()) {
            return null;
        }
        return token.trim();
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
