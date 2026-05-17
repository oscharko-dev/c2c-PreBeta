/**
 * W0 Java target runtime.
 * <p>
 * This package defines the COBOL-compatible primitives that generated Java
 * programs depend on: {@link com.c2c.target.java.runtime.CobolDecimal} for
 * fixed-point arithmetic, {@link com.c2c.target.java.runtime.PictureSpec} and
 * {@link com.c2c.target.java.runtime.CobolField} for working-storage layout,
 * {@link com.c2c.target.java.runtime.ConditionStatus} for class- and
 * relational conditions, and
 * {@link com.c2c.target.java.runtime.AssumptionRegistry} for surfacing open
 * semantic assumptions tracked in the IR.
 * <p>
 * The runtime is consumed by code emitted through the
 * {@code target-generator-contract-v0}.
 */
package com.c2c.target.java.runtime;
