package com.c2c.w0.buildtest;

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
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Lightweight HTTP front for the build-test runner. Mirrors the W0 envelope
 * used by sibling capability services (parser, semantic-ir, target-java
 * generation): {@code /health} probe, single capability endpoint, and best
 * effort fan-out of Harness/Experience events to the configured event sink.
 */
public final class ServiceApp {

    private static final String SERVICE_NAME = BuildTestRunnerService.SERVICE_NAME;
    private static final int DEFAULT_PORT = 8084;
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private ServiceApp() {
    }

    public static void main(String[] args) throws Exception {
        int port = readPort(System.getenv("BUILD_TEST_RUNNER_LISTEN_ADDR"));
        String harnessEndpoint = normaliseEndpoint(System.getenv("HARNESS_EVENT_ENDPOINT"));
        String harnessEventToken = normaliseToken(System.getenv("HARNESS_EVENT_TOKEN"));
        String experienceEndpoint = normaliseEndpoint(System.getenv("EXPERIENCE_EVENT_ENDPOINT"));
        BuildTestRunnerService service = new BuildTestRunnerService();

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            sendJson(exchange, 200, Map.of("status", "ok", "service", SERVICE_NAME));
        });

        server.createContext("/v0/run-verification",
                exchange -> handleRunVerification(exchange, service, harnessEndpoint, harnessEventToken, experienceEndpoint));

        server.start();
        System.out.printf("%s listening on %d%n", SERVICE_NAME, port);
        Thread.currentThread().join();
    }

    private static void handleRunVerification(HttpExchange exchange,
                                              BuildTestRunnerService service,
                                              String harnessEndpoint,
                                              String harnessEventToken,
                                              String experienceEndpoint) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendText(exchange, 405, "method not allowed");
            return;
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> request = JSON.readValue(exchange.getRequestBody(), Map.class);
            Map<String, Object> response = service.runVerification(request);
            int status = httpStatus(response);
            sendJson(exchange, status, response);
            emitEvents(harnessEndpoint, harnessEventToken, experienceEndpoint, response);
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, Map.of("status", "failed", "error", e.getMessage()));
        } catch (Exception e) {
            sendJson(exchange, 500, Map.of("status", "failed",
                    "error", e.getMessage() == null ? "unknown" : e.getMessage()));
        }
    }

    static int httpStatus(Map<String, Object> response) {
        Object status = response.get("status");
        if ("ok".equals(status)) {
            return 200;
        }
        if (ResultClassifier.STATUS_MISSING_GOLDEN_MASTER.equals(status)
                || ResultClassifier.STATUS_SKIPPED.equals(status)) {
            return 422;
        }
        // compile-failed / run-failed / output-divergence /
        // golden-master-reproduction-failed are still 200 from an HTTP
        // standpoint: the runner successfully produced a structured result,
        // even though the verification outcome is negative. CI gates and
        // Harness consumers must read the status field for the verdict.
        return 200;
    }

    static void emitEvents(String harnessEndpoint, String harnessEventToken, String experienceEndpoint,
                           Map<String, Object> response) {
        try {
            postIfPresent(harnessEndpoint, harnessEventToken, buildHarnessEvent(response));
            for (Map<String, Object> experience : buildExperienceEvents(response)) {
                postIfPresent(experienceEndpoint, null, experience);
            }
        } catch (Exception ignored) {
            // Event emission is best-effort for capability services.
        }
    }

    static Map<String, Object> buildHarnessEvent(Map<String, Object> response) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("schemaVersion", "v0");
        event.put("eventId", "evt-" + SERVICE_NAME + "-" + UUID.randomUUID());
        event.put("eventType", harnessEventType(response));
        event.put("service", SERVICE_NAME);
        event.put("runId", response.get("runId"));
        event.put("stepId", 1);
        event.put("actor", SERVICE_NAME);
        event.put("capability", BuildTestRunnerService.CAPABILITY);
        event.put("dataClass", "build-test");
        event.put("redactionProfile", "agent-managed");
        event.put("policyDecision", "policy allow");
        event.put("status", String.valueOf(response.get("status")));
        event.put("stateTransition", harnessStateTransition(response));
        event.put("inputRef", response.get("sourceRef"));
        event.put("outputRef", response.get("outputRef"));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("programId", response.get("programId"));
        payload.put("classification", response.get("classification"));
        payload.put("summary", response.get("summary"));
        if (response.get("comparison") instanceof Map<?, ?> comparison) {
            payload.put("matched", comparison.get("matched"));
        }
        if (response.get("execution") instanceof Map<?, ?> execution) {
            payload.put("stdoutSha256", execution.get("stdoutSha256"));
        }
        event.put("payload", payload);
        event.put("createdAt", Instant.now().toString());
        return event;
    }

    static List<Map<String, Object>> buildExperienceEvents(Map<String, Object> response) {
        Object status = response.get("status");
        if ("ok".equals(status)) {
            return List.of();
        }
        Map<String, Object> event = new LinkedHashMap<>();
        Instant now = Instant.now();
        event.put("schemaVersion", "v0");
        event.put("eventId", "exp-" + SERVICE_NAME + "-" + UUID.randomUUID());
        event.put("eventType", "build-test." + status);
        event.put("service", SERVICE_NAME);
        event.put("runId", response.get("runId"));
        event.put("actor", SERVICE_NAME);
        event.put("capability", BuildTestRunnerService.CAPABILITY);
        event.put("dataClass", "build-test");
        event.put("redactionProfile", "agent-managed");
        event.put("policyDecision", "policy allow");
        event.put("status", "observed");
        event.put("stateTransition", "build-test->" + status);
        event.put("buildTestOutcome", String.valueOf(response.get("classification")));
        event.put("pattern", patternFor(response));
        event.put("patternFingerprint", HashUtil.sha256(patternFor(response)));
        event.put("occurrences", 1);
        event.put("confidence", 0.9);
        event.put("observationOnly", true);
        event.put("policyVersion", "build-test-runner-v0");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("programId", response.get("programId"));
        payload.put("summary", response.get("summary"));
        if (response.get("execution") instanceof Map<?, ?> execution) {
            payload.put("stdoutSha256", execution.get("stdoutSha256"));
        }
        if (response.get("goldenMaster") instanceof Map<?, ?> golden) {
            payload.put("goldenMasterClassification", golden.get("classification"));
            payload.put("expectedSha256", golden.get("expectedSha256"));
        }
        event.put("payload", payload);
        event.put("createdAt", now.toString());
        event.put("observedAt", now.toString());
        return List.of(event);
    }

    private static String harnessEventType(Map<String, Object> response) {
        Object status = response.get("status");
        return "build-test." + (status == null ? "executed" : status);
    }

    private static String harnessStateTransition(Map<String, Object> response) {
        Object status = response.get("status");
        if ("ok".equals(status)) {
            return "generated->validated";
        }
        return "generated->" + (status == null ? "unknown" : status);
    }

    private static String patternFor(Map<String, Object> response) {
        Object programId = response.getOrDefault("programId", "unknown");
        Object classification = response.getOrDefault("classification", "unknown");
        return "build-test:" + classification + ":" + programId;
    }

    private static void postIfPresent(String endpoint, String eventToken, Map<String, Object> event) throws Exception {
        if (endpoint == null) {
            return;
        }
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

    private static String normaliseEndpoint(String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return null;
        }
        if (endpoint.toLowerCase(Locale.ROOT).endsWith("/v0/events")) {
            return endpoint;
        }
        return endpoint.endsWith("/") ? endpoint + "v0/events" : endpoint + "/v0/events";
    }

    private static String normaliseToken(String token) {
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
