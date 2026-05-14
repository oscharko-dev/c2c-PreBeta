package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class RuntimeMetadataTest {

    @Test
    void exposesContractAndIrVersionsForGeneratedCode() {
        // Generated projects must be able to assert against these constants
        // at build time, so the values are part of the public contract.
        assertEquals("c2c-target-java-runtime", RuntimeMetadata.RUNTIME_NAME);
        assertEquals("0.1.0", RuntimeMetadata.RUNTIME_VERSION);
        assertEquals("target-generator-contract-v0", RuntimeMetadata.CONTRACT_VERSION);
        assertEquals("semantic-ir-v0", RuntimeMetadata.IR_VERSION);
    }
}
