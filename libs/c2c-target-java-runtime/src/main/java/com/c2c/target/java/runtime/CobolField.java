package com.c2c.target.java.runtime;

import java.math.BigDecimal;
import java.util.Locale;
import java.util.Objects;

/**
 * A working-storage field with a frozen PIC clause and current value.
 * <p>
 * Generated code holds one {@code CobolField} per data item declared in the
 * IR. Assignment goes through {@link #moveFrom(CobolField)} or
 * {@link #moveLiteral(String)}, which enforce truncation/padding rules
 * compatible with {@code MOVE}.
 */
public final class CobolField {

    private final String name;
    private final String irNodeId;
    private final PictureSpec picture;
    private CobolDecimal numericValue;
    private String displayValue;

    public CobolField(String name, String irNodeId, PictureSpec picture) {
        this.name = Objects.requireNonNull(name, "name");
        this.irNodeId = Objects.requireNonNull(irNodeId, "irNodeId");
        this.picture = Objects.requireNonNull(picture, "picture");
        if (picture.numeric()) {
            this.numericValue = CobolDecimal.of(0L, picture.scale(), picture.signed());
        } else {
            this.displayValue = " ".repeat(picture.byteSize());
        }
    }

    public String name() {
        return name;
    }

    public String irNodeId() {
        return irNodeId;
    }

    public PictureSpec picture() {
        return picture;
    }

    public boolean numeric() {
        return picture.numeric();
    }

    public CobolDecimal numericValue() {
        if (!picture.numeric()) {
            throw new IllegalStateException(
                    "Field '" + name + "' is not numeric (PIC " + picture.raw() + ")");
        }
        return numericValue;
    }

    public String displayValue() {
        if (picture.numeric()) {
            return formatNumericForDisplay();
        }
        return displayValue;
    }

    public void setNumericValue(CobolDecimal value) {
        Objects.requireNonNull(value, "value");
        if (!picture.numeric()) {
            throw new IllegalStateException(
                    "Field '" + name + "' is not numeric (PIC " + picture.raw() + ")");
        }
        CobolDecimal rescaled = value.rescale(picture.scale());
        if (!picture.signed() && rescaled.value().signum() < 0) {
            throw new IllegalStateException(
                    "Field '" + name + "' is unsigned but received negative value: " + value);
        }
        if (overflowsIntegerDigits(rescaled)) {
            throw new IllegalStateException(
                    "Field '" + name + "' overflows PIC " + picture.raw() + ": " + value);
        }
        this.numericValue = rescaled;
    }

    /** Move a numeric literal into this field using the field's declared scale. */
    public void moveNumericLiteral(String literal) {
        Objects.requireNonNull(literal, "literal");
        if (!picture.numeric()) {
            throw new IllegalStateException(
                    "Cannot move numeric literal into non-numeric field '" + name + "'");
        }
        String normalized = literal.trim();
        boolean signedLiteral = normalized.startsWith("-");
        if (normalized.startsWith("+")) {
            normalized = normalized.substring(1);
        }
        int literalScale = 0;
        int dot = normalized.indexOf('.');
        if (dot >= 0) {
            literalScale = normalized.length() - dot - 1;
        }
        setNumericValue(CobolDecimal.of(normalized, literalScale, signedLiteral || picture.signed()));
    }

    public int intValueExact() {
        return numericValue().value().intValueExact();
    }

    /** Move from another field, applying COBOL conversion when categories match. */
    public void moveFrom(CobolField source) {
        Objects.requireNonNull(source, "source");
        if (picture.numeric() && source.picture.numeric()) {
            setNumericValue(source.numericValue);
            return;
        }
        if (!picture.numeric() && !source.picture.numeric()) {
            moveLiteral(source.displayValue);
            return;
        }
        throw new IllegalStateException(
                "MOVE between incompatible categories: '" + source.name + "' (" + source.picture.category()
                        + ") into '" + name + "' (" + picture.category() + ")");
    }

    /** Move a string literal into an alphanumeric/alphabetic field. */
    public void moveLiteral(String literal) {
        Objects.requireNonNull(literal, "literal");
        if (picture.numeric()) {
            throw new IllegalStateException(
                    "Cannot move string literal into numeric field '" + name + "'");
        }
        int width = picture.byteSize();
        if (literal.length() >= width) {
            this.displayValue = literal.substring(0, width);
        } else {
            // COBOL alphanumeric MOVE pads on the right with spaces.
            this.displayValue = literal + " ".repeat(width - literal.length());
        }
    }

    private boolean overflowsIntegerDigits(CobolDecimal candidate) {
        // Compare integer part against 10^integerDigits: scale was already
        // applied by rescale(), so toBigInteger() truncates the fraction
        // and leaves only the integer-side magnitude to bounds-check.
        java.math.BigInteger integerPart = candidate.value().abs().toBigInteger();
        java.math.BigInteger limit = java.math.BigInteger.TEN.pow(picture.integerDigits());
        return integerPart.compareTo(limit) >= 0;
    }

    private String formatNumericForDisplay() {
        BigDecimal abs = numericValue.value().abs();
        String unscaled = abs.movePointRight(picture.scale()).toBigInteger().toString();
        int width = picture.integerDigits() + picture.scale();
        String padded;
        if (unscaled.length() >= width) {
            padded = unscaled.substring(unscaled.length() - width);
        } else {
            padded = "0".repeat(width - unscaled.length()) + unscaled;
        }
        StringBuilder out = new StringBuilder();
        if (picture.signed()) {
            out.append(numericValue.value().signum() < 0 ? '-' : '+');
        }
        if (picture.scale() > 0) {
            int dot = padded.length() - picture.scale();
            out.append(padded, 0, dot).append('.').append(padded.substring(dot));
        } else {
            out.append(padded);
        }
        return out.toString().toUpperCase(Locale.ROOT);
    }
}
