package com.c2c.target.java.runtime;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;

/**
 * Fixed-point decimal value with a frozen scale, modelling COBOL
 * {@code PIC S9(n)V9(s)} arithmetic in Java.
 * <p>
 * The W0 corpus stays inside fixed-point integer-or-scaled decimal numerics
 * (see docs/corpus/w0-cobol-subset.md). Floating point is intentionally not
 * used: silent binary rounding would break the golden master strategy.
 * <p>
 * Operations between two values widen to {@code max(scale)} like COBOL does,
 * and arithmetic is non-mutating so each statement in the IR maps cleanly to
 * one expression in generated code.
 */
public final class CobolDecimal implements Comparable<CobolDecimal> {

    private static final RoundingMode COBOL_ROUNDING = RoundingMode.HALF_EVEN;

    private final BigDecimal value;
    private final int scale;
    private final boolean signed;

    private CobolDecimal(BigDecimal value, int scale, boolean signed) {
        this.scale = scale;
        this.signed = signed;
        BigDecimal rescaled = value.setScale(scale, COBOL_ROUNDING);
        if (!signed && rescaled.signum() < 0) {
            throw new IllegalArgumentException(
                    "Unsigned CobolDecimal cannot hold negative value: " + rescaled.toPlainString());
        }
        this.value = rescaled;
    }

    /** Build from any {@link BigDecimal} input, freezing it at {@code scale}. */
    public static CobolDecimal of(BigDecimal raw, int scale, boolean signed) {
        Objects.requireNonNull(raw, "raw");
        if (scale < 0) {
            throw new IllegalArgumentException("scale must be >= 0, got: " + scale);
        }
        return new CobolDecimal(raw, scale, signed);
    }

    /** Convenience for literals expressed as plain decimal strings. */
    public static CobolDecimal of(String literal, int scale, boolean signed) {
        Objects.requireNonNull(literal, "literal");
        return of(new BigDecimal(literal), scale, signed);
    }

    /** Convenience for whole-number literals. */
    public static CobolDecimal of(long whole, int scale, boolean signed) {
        return of(BigDecimal.valueOf(whole), scale, signed);
    }

    /** Zero in the same shape as {@code prototype} ({@code scale}, {@code signed}). */
    public static CobolDecimal zeroLike(CobolDecimal prototype) {
        Objects.requireNonNull(prototype, "prototype");
        return new CobolDecimal(BigDecimal.ZERO, prototype.scale, prototype.signed);
    }

    public BigDecimal value() {
        return value;
    }

    public int scale() {
        return scale;
    }

    public boolean signed() {
        return signed;
    }

    public CobolDecimal add(CobolDecimal other) {
        Objects.requireNonNull(other, "other");
        int targetScale = Math.max(this.scale, other.scale);
        boolean targetSigned = this.signed || other.signed;
        return new CobolDecimal(value.add(other.value), targetScale, targetSigned);
    }

    public CobolDecimal subtract(CobolDecimal other) {
        Objects.requireNonNull(other, "other");
        int targetScale = Math.max(this.scale, other.scale);
        // Subtraction can yield a negative even from two unsigned operands,
        // so the result is always permitted to be signed.
        return new CobolDecimal(value.subtract(other.value), targetScale, true);
    }

    public CobolDecimal multiply(CobolDecimal other) {
        Objects.requireNonNull(other, "other");
        int targetScale = Math.max(this.scale, other.scale);
        boolean targetSigned = this.signed || other.signed;
        return new CobolDecimal(value.multiply(other.value), targetScale, targetSigned);
    }

    /**
     * Divide using COBOL-style fixed-point semantics: the result keeps the
     * widest of the input scales and rounds {@code HALF_EVEN}.
     *
     * @throws ArithmeticException if {@code other} is zero
     */
    public CobolDecimal divide(CobolDecimal other) {
        Objects.requireNonNull(other, "other");
        if (other.value.signum() == 0) {
            throw new ArithmeticException("CobolDecimal divide by zero");
        }
        int targetScale = Math.max(this.scale, other.scale);
        boolean targetSigned = this.signed || other.signed;
        BigDecimal divided = value.divide(other.value, targetScale, COBOL_ROUNDING);
        return new CobolDecimal(divided, targetScale, targetSigned);
    }

    /**
     * Truncate or rescale to a different scale. Mirrors COBOL {@code MOVE} into
     * a destination field with a different {@code V9(s)} clause.
     */
    public CobolDecimal rescale(int newScale) {
        if (newScale < 0) {
            throw new IllegalArgumentException("newScale must be >= 0, got: " + newScale);
        }
        return new CobolDecimal(value, newScale, signed);
    }

    @Override
    public int compareTo(CobolDecimal other) {
        Objects.requireNonNull(other, "other");
        return value.compareTo(other.value);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof CobolDecimal that)) {
            return false;
        }
        // Value-equal mirrors COBOL's relational equality across declared
        // scales (1.0 == 1.000); shape differences are exposed via scale()
        // and signed() for callers that need them.
        return value.compareTo(that.value) == 0;
    }

    @Override
    public int hashCode() {
        // Must agree with equals across scales, so strip trailing zeros.
        return value.stripTrailingZeros().hashCode();
    }

    @Override
    public String toString() {
        return value.toPlainString();
    }
}
