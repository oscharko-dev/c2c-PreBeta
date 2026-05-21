package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CobolRuntimeExecutorTest {

    private static final String SENTINEL = "\n[c2c: output truncated at 1048576 bytes]\n";

    @Test
    void readAll_truncatesAtMaxOutputBytesAndAppendsSentinel() {
        int size = 2 * CobolRuntimeExecutor.MAX_OUTPUT_BYTES;
        byte[] input = new byte[size];
        Arrays.fill(input, (byte) 'A');

        String result = CobolRuntimeExecutor.readAll(new ByteArrayInputStream(input));

        assertTrue(result.startsWith("A".repeat(CobolRuntimeExecutor.MAX_OUTPUT_BYTES)),
                "result must begin with exactly MAX_OUTPUT_BYTES 'A' characters");
        assertTrue(result.endsWith(SENTINEL),
                "result must end with the truncation sentinel");
        assertEquals(CobolRuntimeExecutor.MAX_OUTPUT_BYTES + SENTINEL.length(), result.length(),
                "total length must be MAX_OUTPUT_BYTES plus sentinel length");
    }
}
