package com.c2c.w0.targetjava;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServiceAppHttpTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        TargetJavaGenerationService service = new TargetJavaGenerationService();
        // Reuse the real handler from ServiceApp so the test covers the
        // production code path, not a parallel implementation.
        server.createContext("/v0/generate", exchange ->
                ServiceApp.handleGenerate(exchange, service, null));
        server.start();
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void rejectsNonJsonContentTypeWith415() throws Exception {
        assertEquals(415, post("/v0/generate", "{\"ir\":{}}", "text/plain"));
    }

    @Test
    void rejectsMalformedJsonWith400() throws Exception {
        assertEquals(400, post("/v0/generate", "{not json", "application/json"));
    }

    @Test
    void rejectsOversizeBodyWith413() throws Exception {
        StringBuilder buf = new StringBuilder(ServiceApp.MAX_REQUEST_BYTES + 1024);
        buf.append("{\"junk\":\"");
        while (buf.length() < ServiceApp.MAX_REQUEST_BYTES + 100) {
            buf.append('x');
        }
        buf.append("\"}");
        assertEquals(413, post("/v0/generate", buf.toString(), "application/json"));
    }

    @Test
    void irOutputWithoutInnerIrReturns400() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", "run-x");
        body.put("irOutput", Map.of("runId", "run-x"));
        assertEquals(400, post("/v0/generate", JSON.writeValueAsString(body), "application/json"));
    }

    @Test
    void rejectsMethodOtherThanPost() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) URI.create(
                "http://127.0.0.1:" + port + "/v0/generate").toURL().openConnection();
        conn.setRequestMethod("GET");
        assertEquals(405, conn.getResponseCode());
        conn.disconnect();
    }

    @Test
    void happyPathReturns200WithGeneratedProject() throws Exception {
        Map<String, Object> body = Map.of("runId", "run-http", "ir", smallIr("HTTPDEMO"));
        assertEquals(200, post("/v0/generate", JSON.writeValueAsString(body), "application/json"));
    }

    @Test
    void concurrentGenerateCallsProduceIdenticalOutputRefs() throws Exception {
        TargetJavaGenerationService service = new TargetJavaGenerationService();
        Map<String, Object> ir = smallIr("CONC01");

        int parallelism = 8;
        var executor = java.util.concurrent.Executors.newFixedThreadPool(parallelism);
        try {
            var futures = new java.util.ArrayList<java.util.concurrent.Future<String>>();
            for (int i = 0; i < parallelism; i++) {
                futures.add(executor.submit(() -> {
                    Map<String, Object> response = service.generate(
                            Map.of("runId", "r", "ir", deepCopy(ir)));
                    return ((Map<?, ?>) response.get("outputRef")).get("sha256").toString();
                }));
            }
            String first = futures.get(0).get();
            assertTrue(first.length() == 64, "sha256 must be 64 hex chars");
            for (var future : futures) {
                assertEquals(first, future.get(),
                        "outputRef sha256 must be identical across concurrent invocations");
            }
        } finally {
            executor.shutdownNow();
        }
    }

    private int post(String path, String body, String contentType) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + path)
                .toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", contentType);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = conn.getResponseCode();
        try (var stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
            if (stream != null) {
                stream.readAllBytes();
            }
        }
        conn.disconnect();
        return status;
    }

    private static Map<String, Object> smallIr(String programId) {
        Map<String, Object> ir = new LinkedHashMap<>();
        ir.put("schemaVersion", "v0");
        ir.put("irId", "ir-" + programId.toLowerCase());
        ir.put("programId", programId);
        ir.put("sourceHash", "abc");
        ir.put("sourceKind", "cobol");
        ir.put("fieldLayouts", List.of());
        ir.put("statements", List.of(Map.of(
                "id", "s-stop", "operation", "stop", "sourceLine", 1,
                "operands", Map.of(), "raw", "STOP RUN")));
        ir.put("controlFlow", List.of());
        ir.put("assumptions", List.of());
        ir.put("traceability", Map.of());
        return ir;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deepCopy(Map<String, Object> map) {
        try {
            return JSON.readValue(JSON.writeValueAsString(map), Map.class);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
