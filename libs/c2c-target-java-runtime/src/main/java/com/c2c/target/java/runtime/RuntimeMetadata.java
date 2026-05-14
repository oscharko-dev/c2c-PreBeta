package com.c2c.target.java.runtime;

/**
 * Identity metadata for the W0 Java target runtime.
 * <p>
 * The constants are also written into the runtime jar manifest by the build so
 * generated projects can pin a specific runtime version and contract version
 * without inspecting source.
 */
public final class RuntimeMetadata {

    public static final String RUNTIME_NAME = "c2c-target-java-runtime";

    public static final String RUNTIME_VERSION = "0.1.0";

    public static final String CONTRACT_VERSION = "target-generator-contract-v0";

    public static final String IR_VERSION = "semantic-ir-v0";

    private RuntimeMetadata() {
    }
}
