package com.c2c.target.java.runtime;

import java.math.BigDecimal;
import java.util.Objects;

/**
 * COBOL class-condition and relational helpers, expressed so that generated
 * Java code from one {@code IF} or {@code EVALUATE} IR node maps to exactly one
 * boolean expression here.
 * <p>
 * Scope (W0): NUMERIC, ALPHABETIC, ZERO/POSITIVE/NEGATIVE class conditions and
 * the six relational operators. Custom 88-level condition names are emitted by
 * the generator as direct equality checks and are not modelled here.
 */
public final class ConditionStatus {

    private ConditionStatus() {
    }

    public static boolean isNumeric(CobolField field) {
        Objects.requireNonNull(field, "field");
        if (field.numeric()) {
            return true;
        }
        String text = field.displayValue().trim();
        if (text.isEmpty()) {
            return false;
        }
        try {
            new BigDecimal(text);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public static boolean isAlphabetic(CobolField field) {
        Objects.requireNonNull(field, "field");
        String text = field.numeric() ? field.numericValue().toString() : field.displayValue();
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch != ' ' && !Character.isLetter(ch)) {
                return false;
            }
        }
        return !text.isBlank();
    }

    public static boolean isZero(CobolField field) {
        Objects.requireNonNull(field, "field");
        if (field.numeric()) {
            return field.numericValue().value().signum() == 0;
        }
        for (int i = 0; i < field.displayValue().length(); i++) {
            if (field.displayValue().charAt(i) != '0') {
                return false;
            }
        }
        return !field.displayValue().isEmpty();
    }

    public static boolean isPositive(CobolField field) {
        Objects.requireNonNull(field, "field");
        if (!field.numeric()) {
            throw new IllegalArgumentException(
                    "POSITIVE only valid on numeric fields, got: " + field.name());
        }
        return field.numericValue().value().signum() > 0;
    }

    public static boolean isNegative(CobolField field) {
        Objects.requireNonNull(field, "field");
        if (!field.numeric()) {
            throw new IllegalArgumentException(
                    "NEGATIVE only valid on numeric fields, got: " + field.name());
        }
        return field.numericValue().value().signum() < 0;
    }

    public static boolean equalTo(CobolDecimal left, CobolDecimal right) {
        Objects.requireNonNull(left, "left");
        Objects.requireNonNull(right, "right");
        return left.compareTo(right) == 0;
    }

    public static boolean lessThan(CobolDecimal left, CobolDecimal right) {
        Objects.requireNonNull(left, "left");
        Objects.requireNonNull(right, "right");
        return left.compareTo(right) < 0;
    }

    public static boolean greaterThan(CobolDecimal left, CobolDecimal right) {
        Objects.requireNonNull(left, "left");
        Objects.requireNonNull(right, "right");
        return left.compareTo(right) > 0;
    }

    public static boolean lessOrEqual(CobolDecimal left, CobolDecimal right) {
        return !greaterThan(left, right);
    }

    public static boolean greaterOrEqual(CobolDecimal left, CobolDecimal right) {
        return !lessThan(left, right);
    }

    public static boolean notEqual(CobolDecimal left, CobolDecimal right) {
        return !equalTo(left, right);
    }
}
