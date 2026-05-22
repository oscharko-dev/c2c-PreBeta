package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CobolRuntimeExecutorTest {

    @Test
    void readAll_truncatesAtMaxOutputBytesAndAppendsSentinel() {
        int size = 2 * CobolRuntimeExecutor.MAX_OUTPUT_BYTES;
        byte[] input = new byte[size];
        Arrays.fill(input, (byte) 'A');

        String result = CobolRuntimeExecutor.readAll(new ByteArrayInputStream(input));

        assertTrue(result.startsWith("A".repeat(CobolRuntimeExecutor.MAX_OUTPUT_BYTES)),
                "result must begin with exactly MAX_OUTPUT_BYTES 'A' characters");
        assertTrue(result.endsWith(CobolRuntimeExecutor.OUTPUT_TRUNCATED_SENTINEL),
                "result must end with the truncation sentinel");
        assertEquals(
                CobolRuntimeExecutor.MAX_OUTPUT_BYTES
                        + CobolRuntimeExecutor.OUTPUT_TRUNCATED_SENTINEL.length(),
                result.length(),
                "total length must be MAX_OUTPUT_BYTES plus sentinel length");
    }

    @Test
    void ioErrorReasonIsSanitizedInsteadOfEchoingTempPaths() {
        CobolRuntimeExecutor.OracleRun run = CobolRuntimeExecutor.OracleRun.ioError(
                "HELLOW02",
                "/var/folders/ab/c2c-cobol-oracle-12345/HELLOW02.cbl: permission denied",
                "cobc 3.1.2",
                "cobcrun 3.1.2");

        assertEquals("I/O error while preparing or running the oracle", run.reason());
    }
}
