package com.c2c.w0.buildtest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServiceAppTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void httpStatusIsAlwaysTwoHundredForStructuredOutcomes() {
        for (String status : new String[]{
                "ok",
                "compile-failed",
                "run-failed",
                "output-divergence",
                "golden-master-reproduction-failed",
        }) {
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("status", status);
            assertEquals(200, ServiceApp.httpStatus(response),
                    "status " + status + " must produce HTTP 200");
        }
    }

    @Test
    void httpStatusIs422ForMissingGoldenMaster() {
        assertEquals(422, ServiceApp.httpStatus(Map.of("status", "missing-golden-master")));
    }

    @Test
    void httpStatusIs422ForSkipped() {
        assertEquals(422, ServiceApp.httpStatus(Map.of("status", "skipped")));
    }

    @Test
    void listenAddressDefaultsToLoopbackAndHonorsConfiguredHost() {
        assertEquals("127.0.0.1", ServiceApp.readListenAddress(null).getHostString());
        assertEquals(8084, ServiceApp.readListenAddress(null).getPort());
        assertEquals("127.0.0.1", ServiceApp.readListenAddress(":18086").getHostString());
        assertEquals(18086, ServiceApp.readListenAddress(":18086").getPort());
        assertEquals("0.0.0.0", ServiceApp.readListenAddress("0.0.0.0:18086").getHostString());
        assertEquals(18086, ServiceApp.readListenAddress("0.0.0.0:18086").getPort());
    }

    @Test
    void harnessEventCarriesBuildTestDataClassAndCapability() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "ok");
        response.put("runId", "run-1");
        response.put("programId", "BRNCH01");
        response.put("classification", "match");
        response.put("summary", "ok");
        response.put("sourceRef", Map.of("uri", "urn:test/in"));
        response.put("outputRef", Map.of("uri", "urn:test/out"));
        response.put("execution", Map.of("stdoutSha256", "0".repeat(64)));
        response.put("comparison", Map.of("matched", true));
        Map<String, Object> event = ServiceApp.buildHarnessEvent(response);
        assertEquals("v0", event.get("schemaVersion"));
        assertEquals("build-test-runner-service", event.get("service"));
        assertEquals("build-test.run", event.get("capability"));
        assertEquals("build-test", event.get("dataClass"));
        assertEquals("ok", event.get("status"));
        assertEquals("generated->validated", event.get("stateTransition"));
        assertTrue(((String) event.get("eventType")).startsWith("build-test."));
    }

    @Test
    void experienceEventsEmittedForNonOkStatuses() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "output-divergence");
        response.put("runId", "run-1");
        response.put("programId", "BRNCH01");
        response.put("classification", "divergence-known-w0-coverage-gap");
        response.put("summary", "documented W0 gap");
        response.put("execution", Map.of("stdoutSha256", "0".repeat(64)));
        response.put("goldenMaster", Map.of(
                "classification", "synthetic",
                "expectedSha256", "1".repeat(64)));
        List<Map<String, Object>> events = ServiceApp.buildExperienceEvents(response);
        assertEquals(1, events.size());
        Map<String, Object> event = events.get(0);
        assertEquals("v0", event.get("schemaVersion"));
        assertEquals("build-test", event.get("dataClass"));
        assertEquals("observed", event.get("status"));
        assertEquals("divergence-known-w0-coverage-gap", event.get("buildTestOutcome"));
        assertTrue(((String) event.get("patternFingerprint")).matches("[0-9a-f]{64}"));
    }

    @Test
    void experienceEventsSuppressedOnSuccess() {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "ok");
        assertTrue(ServiceApp.buildExperienceEvents(response).isEmpty());
        assertFalse(ServiceApp.buildHarnessEvent(response).isEmpty());
    }

    @Test
    void boundedRequestBodyAcceptsContentAtTheLimit() throws Exception {
        byte[] body = "abcd".getBytes(StandardCharsets.UTF_8);

        assertEquals("abcd", new String(ServiceApp.readBoundedRequestBody(
                new ByteArrayInputStream(body),
                body.length,
                body.length), StandardCharsets.UTF_8));
    }

    @Test
    void boundedRequestBodyRejectsDeclaredContentLengthAboveLimit() {
        IOException thrown = assertThrows(IOException.class, () -> ServiceApp.readBoundedRequestBody(
                new ByteArrayInputStream(new byte[0]),
                5,
                4));

        assertEquals("request body too large", thrown.getMessage());
    }

    @Test
    void boundedRequestBodyRejectsStreamThatExceedsLimitWithoutContentLength() {
        IOException thrown = assertThrows(IOException.class, () -> ServiceApp.readBoundedRequestBody(
                new ByteArrayInputStream("abcde".getBytes(StandardCharsets.UTF_8)),
                -1,
                4));

        assertEquals("request body too large", thrown.getMessage());
    }

    @Test
    void formatJavaRouteReturnsFormattedContent() throws Exception {
        HttpServer server = startFormatJavaServer();
        try {
            HttpResponse<String> response = postJson(server, Map.of(
                    "content", "class X{void m(){System.out.println(\"hi\");}}"));

            assertEquals(200, response.statusCode());
            Map<String, Object> body = readJsonObject(response.body());
            assertEquals("v0", body.get("schemaVersion"));
            assertTrue(((String) body.get("formattedContent")).contains("class X {"));
            assertFalse(body.containsKey("status"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void formatJavaRouteReturnsBadRequestForInvalidJson() throws Exception {
        HttpServer server = startFormatJavaServer();
        try {
            HttpResponse<String> response = postRawJson(server, "{\"content\":");

            assertEquals(400, response.statusCode());
            Map<String, Object> body = readJsonObject(response.body());
            assertEquals("v0", body.get("schemaVersion"));
            assertEquals("failed", body.get("status"));
            assertEquals("invalid json", body.get("error"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void formatJavaRouteReturnsUnprocessableEntityForInvalidJava() throws Exception {
        HttpServer server = startFormatJavaServer();
        try {
            HttpResponse<String> response = postJson(server, Map.of(
                    "content", "class X { void m( { }"));

            assertEquals(422, response.statusCode());
            Map<String, Object> body = readJsonObject(response.body());
            assertEquals("v0", body.get("schemaVersion"));
            assertEquals("failed", body.get("status"));
            assertTrue(((String) body.get("error")).length() > 0);
        } finally {
            server.stop(0);
        }
    }

    private static HttpServer startFormatJavaServer() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v0/format-java",
                exchange -> ServiceApp.handleFormatJava(exchange, new JavaFormatter(), null));
        server.start();
        return server;
    }

    private static HttpResponse<String> postJson(HttpServer server, Map<String, Object> body) throws Exception {
        return postRawJson(server, JSON.writeValueAsString(body));
    }

    private static HttpResponse<String> postRawJson(HttpServer server, String body) throws Exception {
        URI uri = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v0/format-java");
        HttpRequest request = HttpRequest.newBuilder(uri)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readJsonObject(String raw) throws IOException {
        return JSON.readValue(raw, Map.class);
    }
}
