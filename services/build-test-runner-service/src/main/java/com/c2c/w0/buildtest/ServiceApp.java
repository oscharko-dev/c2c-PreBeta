package com.c2c.w0.buildtest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.Serial;
import java.net.InetAddress;
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
@SuppressWarnings("UastIncorrectHttpHeaderInspection")
public final class ServiceApp {

    private static final String SERVICE_NAME = BuildTestRunnerService.SERVICE_NAME;
    private static final int DEFAULT_PORT = 8084;
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    private static final int MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
    private static final int BODY_READ_BUFFER_BYTES = 8192;
    // Custom Harness control-plane headers. Hoisted to constants so static
    // analysis (Qodana / IntelliJ "Unknown HTTP header") does not flag them
    // as typos at the call sites.
    private static final String HARNESS_ACTOR_HEADER = "X-Harness-Actor";
    private static final String HARNESS_ROLE_HEADER = "X-Harness-Role";

    private ServiceApp() {
    }

    public static void main(String[] args) throws Exception {
        InetSocketAddress listenAddress = readListenAddress(System.getenv("BUILD_TEST_RUNNER_LISTEN_ADDR"));
        String harnessEndpoint = normaliseEndpoint(System.getenv("HARNESS_EVENT_ENDPOINT"));
        String harnessEventToken = normaliseToken(System.getenv("HARNESS_EVENT_TOKEN"));
        String configuredControlToken = normaliseToken(System.getenv("BUILD_TEST_RUNNER_CONTROL_TOKEN"));
        String controlToken = configuredControlToken;
        String experienceEndpoint = normaliseEndpoint(System.getenv("EXPERIENCE_EVENT_ENDPOINT"));
        BuildTestRunnerService service = new BuildTestRunnerService();

        HttpServer server = HttpServer.create(listenAddress, 0);

        server.createContext("/health", exchange -> {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendText(exchange, 405, "method not allowed");
                return;
            }
            sendJson(exchange, 200, Map.of("status", "ok", "service", SERVICE_NAME));
        });

        server.createContext("/v0/run-verification",
                exchange -> handleRunVerification(exchange, service, harnessEndpoint, harnessEventToken, experienceEndpoint, controlToken));

        // Studio-IDE-14 (#256): deterministic Java formatter (google-java-format
        // in-process). Stateless per-request handler; no events emitted since
        // formatting is a UI affordance, not a verification outcome.
        JavaFormatter formatter = new JavaFormatter();
        server.createContext("/v0/format-java",
                exchange -> handleFormatJava(exchange, formatter, controlToken));

        server.start();
        System.out.printf("%s listening on %s:%d%n",
                SERVICE_NAME, listenAddress.getHostString(), listenAddress.getPort());
        Thread.currentThread().join();
    }

    private static void handleRunVerification(HttpExchange exchange,
                                              BuildTestRunnerService service,
                                              String harnessEndpoint,
                                              String harnessEventToken,
                                              String experienceEndpoint,
                                              String controlToken) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendText(exchange, 405, "method not allowed");
            return;
        }
        if (!isAuthorized(exchange, controlToken)) {
            sendJson(exchange, 401, Map.of("status", "failed", "error", "unauthorized"));
            return;
        }
        try {
            Map<String, Object> request = readJsonRequest(exchange, MAX_REQUEST_BODY_BYTES);
            Map<String, Object> response = service.runVerification(request);
            int status = httpStatus(response);
            sendJson(exchange, status, response);
            emitEvents(harnessEndpoint, harnessEventToken, experienceEndpoint, response);
        } catch (RequestBodyTooLargeException e) {
            sendJson(exchange, 413, requestTooLargeBody());
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, Map.of("status", "failed", "error", e.getMessage()));
        } catch (Exception e) {
            sendJson(exchange, 500, Map.of("status", "failed",
                    "error", e.getMessage() == null ? "unknown" : e.getMessage()));
        }
    }

    private static void handleFormatJava(HttpExchange exchange,
                                         JavaFormatter formatter,
                                         String controlToken) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendText(exchange, 405, "method not allowed");
            return;
        }
        if (!isAuthorized(exchange, controlToken)) {
            sendJson(exchange, 401, Map.of("status", "failed", "error", "unauthorized"));
            return;
        }
        Map<String, Object> request;
        try {
            request = readJsonRequest(exchange, MAX_REQUEST_BODY_BYTES);
        } catch (RequestBodyTooLargeException e) {
            sendJson(exchange, 413, requestTooLargeBody());
            return;
        } catch (Exception e) {
            sendJson(exchange, 400, Map.of(
                    "schemaVersion", "v0",
                    "status", "failed",
                    "error", "invalid json"));
            return;
        }
        Object contentValue = request == null ? null : request.get("content");
        if (!(contentValue instanceof String)) {
            sendJson(exchange, 400, Map.of(
                    "schemaVersion", "v0",
                    "status", "failed",
                    "error", "content must be a string"));
            return;
        }
        String content = (String) contentValue;
        JavaFormatter.FormatResult result = formatter.format(content);
        if (result.isOk()) {
            sendJson(exchange, 200, Map.of(
                    "schemaVersion", "v0",
                    "formattedContent", result.formattedContent()));
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schemaVersion", "v0");
        body.put("status", "failed");
        body.put("error", result.errorMessage() == null ? "format failed" : result.errorMessage());
        if (result.errorLine() != null) {
            body.put("line", result.errorLine());
        }
        if (result.errorColumn() != null) {
            body.put("column", result.errorColumn());
        }
        sendJson(exchange, 422, body);
    }

    static Map<String, Object> readJsonRequest(HttpExchange exchange, int maxBodyBytes) throws IOException {
        String rawLength = exchange.getRequestHeaders().getFirst("Content-Length");
        byte[] body = readBoundedRequestBody(
                exchange.getRequestBody(),
                parseContentLength(rawLength),
                maxBodyBytes);
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = JSON.readValue(body, Map.class);
        return parsed;
    }

    static byte[] readBoundedRequestBody(InputStream input, long declaredLength, int maxBodyBytes) throws IOException {
        if (maxBodyBytes <= 0) {
            throw new IllegalArgumentException("maxBodyBytes must be positive");
        }
        if (declaredLength > maxBodyBytes) {
            throw new RequestBodyTooLargeException();
        }
        int initialSize = Math.min(maxBodyBytes, BODY_READ_BUFFER_BYTES);
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream(initialSize)) {
            byte[] buffer = new byte[BODY_READ_BUFFER_BYTES];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > maxBodyBytes) {
                    throw new RequestBodyTooLargeException();
                }
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    static long parseContentLength(String rawLength) {
        if (rawLength == null || rawLength.isBlank()) {
            return -1L;
        }
        try {
            long parsed = Long.parseLong(rawLength.trim());
            return parsed < 0 ? -1L : parsed;
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    private static Map<String, Object> requestTooLargeBody() {
        return Map.of(
                "schemaVersion", "v0",
                "status", "failed",
                "error", "request body too large");
    }

    static boolean isAuthorized(HttpExchange exchange, String controlToken) {
        if (controlToken == null) {
            InetAddress remote = exchange.getRemoteAddress().getAddress();
            return remote != null && remote.isLoopbackAddress();
        }
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        return ("Bearer " + controlToken).equals(header);
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
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .header(HARNESS_ACTOR_HEADER, SERVICE_NAME)
                .header(HARNESS_ROLE_HEADER, "service");
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

    static InetSocketAddress readListenAddress(String raw) {
        if (raw == null || raw.isBlank()) {
            return new InetSocketAddress("127.0.0.1", DEFAULT_PORT);
        }
        String candidate = raw.trim();
        String host = "127.0.0.1";
        if (candidate.startsWith(":")) {
            candidate = candidate.substring(1);
        } else if (candidate.contains(":")) {
            host = candidate.substring(0, candidate.lastIndexOf(":")).trim();
            candidate = candidate.substring(candidate.lastIndexOf(":") + 1);
            if (host.isBlank()) {
                host = "127.0.0.1";
            }
        }
        int port;
        try {
            port = Integer.parseInt(candidate);
        } catch (NumberFormatException e) {
            port = DEFAULT_PORT;
        }
        return new InetSocketAddress(host, port);
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

    private static final class RequestBodyTooLargeException extends IOException {
        @Serial
        private static final long serialVersionUID = 1L;

        RequestBodyTooLargeException() {
            super("request body too large");
        }
    }
}
