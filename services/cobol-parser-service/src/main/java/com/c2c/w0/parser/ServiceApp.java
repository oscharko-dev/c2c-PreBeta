package com.c2c.w0.parser;

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
    private static final String SERVICE_NAME = "cobol-parser-service";
    private static final int DEFAULT_PORT = 8081;
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private ServiceApp() {}

    public static void main(String[] args) throws Exception {
        int port = readPort(System.getenv("COBOL_PARSER_LISTEN_ADDR"));
        String eventEndpoint = System.getenv("HARNESS_EVENT_ENDPOINT");

        CobolParser parser = new CobolParser();
        HarnessEventPublisher publisher = new HarnessEventPublisher(eventEndpoint, System.getenv("HARNESS_EVENT_TOKEN"));

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            sendJson(exchange, 200, Map.of("status", "ok", "service", SERVICE_NAME));
        });

        server.createContext("/v0/parse", exchange -> {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            if (exchange.getRequestHeaders().getFirst("Content-Type") != null
                    && !exchange.getRequestHeaders().getFirst("Content-Type").contains("application/json")) {
                sendJson(exchange, 400, Map.of("status", "failed", "error", "content-type must be application/json"));
                return;
            }

            try {
                String payload = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                @SuppressWarnings("unchecked")
                Map<String, Object> request = JSON.readValue(payload, Map.class);
                Model.ParseRequest parseRequest = Model.ParseRequest.fromMap(request);
                Model.ParseResult result = parser.parse(parseRequest);

                Map<String, Object> responsePayload = new LinkedHashMap<>();
                responsePayload.put("schemaVersion", Model.SCHEMA_VERSION);
                responsePayload.put("status", result.status);
                responsePayload.put("runId", result.runId);
                responsePayload.put("stepId", result.stepId);
                responsePayload.put("capability", result.capability);
                responsePayload.put("workflowId", result.workflowId);
                responsePayload.put("sourceRef", result.sourceRef.toMap());
                result.program.sourceHash = Model.sha256(parseRequest.source);
                responsePayload.put("program", result.program);
                responsePayload.put("diagnostics", result.diagnostics);
                responsePayload.put("assumptions", result.assumptions);

                String responseText = JSON.writerWithDefaultPrettyPrinter().writeValueAsString(responsePayload);
                Model.Reference outputRef = computeRef(responseText, "parse-output");
                responsePayload.put("outputRef", outputRef.toMap());
                result.outputRef = outputRef;

                int statusCode = "ok".equals(result.status) ? 200 : 422;
                sendJson(exchange, statusCode, responsePayload);
                publisher.emitFromParseResult(result);
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

    private static Model.Reference computeRef(String body, String kind) {
        String hash = Model.sha256(body);
        return new Model.Reference("urn:" + SERVICE_NAME + "/" + kind + "/" + hash, hash, body.getBytes(StandardCharsets.UTF_8).length, "application/json", kind);
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

    private static final class HarnessEventPublisher {
        private final String eventEndpoint;
        private final String eventToken;
        private int sequence;

        HarnessEventPublisher(String eventEndpoint, String eventToken) {
            this.eventEndpoint = normalizeEndpoint(eventEndpoint);
            this.eventToken = normalizeToken(eventToken);
            this.sequence = 1;
        }

        private void emitFromParseResult(Model.ParseResult result) {
            if (eventEndpoint == null) {
                return;
            }
            try {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("schemaVersion", "v0");
                event.put("eventId", "evt-" + SERVICE_NAME + "-" + UUID.randomUUID());
                event.put("eventType", "ok".equals(result.status) ? "cobol.parse.completed" : "cobol.parse.failed");
                event.put("service", SERVICE_NAME);
                event.put("runId", result.runId);
                event.put("stepId", Math.max(1, nextSequence(result.stepId)));
                event.put("actor", SERVICE_NAME);
                event.put("capability", "cobol.parse");
                event.put("dataClass", "parser");
                event.put("redactionProfile", "harness-control-plane");
                event.put("policyDecision", "policy allow");
                event.put("status", "ok".equals(result.status) ? "ok" : "failed");
                event.put("stateTransition", "service.step");
                event.put("inputRef", result.sourceRef.toMap());
                event.put("outputRef", result.outputRef.toMap());
                event.put("createdAt", Instant.now().toString());

                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("programId", result.program.programId);
                payload.put("diagnostics", result.diagnostics);
                payload.put("assumptions", result.assumptions);
                event.put("payload", payload);

                String eventText = JSON.writeValueAsString(event);
                //noinspection HttpHeaders
                HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(eventEndpoint))
                        .header("Content-Type", "application/json")
                        .header("X-Harness-Actor", SERVICE_NAME)
                        .header("X-Harness-Role", "service");
                if (eventToken != null) {
                    builder.header("Authorization", "Bearer " + eventToken);
                }
                HttpRequest request = builder
                        .POST(HttpRequest.BodyPublishers.ofString(eventText))
                        .build();
                try (HttpClient client = HttpClient.newHttpClient()) {
                    client.send(request, HttpResponse.BodyHandlers.discarding());
                }
            } catch (Exception ignored) {
                // best effort eventing
            }
        }

        private int nextSequence(String requestedStep) {
            if (requestedStep != null && !requestedStep.isBlank()) {
                try {
                    int value = Integer.parseInt(requestedStep);
                    if (value > 0) {
                        return value;
                    }
                } catch (NumberFormatException ignored) {
                    // fall back to internal sequence.
                }
            }
            return sequence++;
        }

        private static String normalizeEndpoint(String endpoint) {
            if (endpoint == null || endpoint.isBlank()) {
                return null;
            }
            if (endpoint.endsWith("/v0/events")) {
                return endpoint;
            }
            if (!endpoint.endsWith("/")) {
                return endpoint + "/v0/events";
            }
            return endpoint + "v0/events";
        }

        private static String normalizeToken(String token) {
            if (token == null || token.isBlank()) {
                return null;
            }
            return token.trim();
        }
    }
}
