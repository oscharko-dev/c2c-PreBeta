package com.c2c.target.java.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * One-based OCCURS table for generated W0 Java code.
 * <p>
 * COBOL subscripts are one-based, so {@link #get(int)} intentionally rejects 0
 * instead of silently translating to Java's zero-based indexing.
 */
public final class CobolFieldArray {

    private final String name;
    private final String irNodeId;
    private final PictureSpec picture;
    private final List<CobolField> elements;

    public CobolFieldArray(String name, String irNodeId, PictureSpec picture, int occurs) {
        this.name = Objects.requireNonNull(name, "name");
        this.irNodeId = Objects.requireNonNull(irNodeId, "irNodeId");
        this.picture = Objects.requireNonNull(picture, "picture");
        if (occurs < 1) {
            throw new IllegalArgumentException("occurs must be >= 1, got: " + occurs);
        }
        List<CobolField> built = new ArrayList<>(occurs);
        for (int i = 1; i <= occurs; i++) {
            built.add(new CobolField(name + "(" + i + ")", irNodeId + "[" + i + "]", picture));
        }
        this.elements = Collections.unmodifiableList(built);
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

    public int length() {
        return elements.size();
    }

    public CobolField get(int oneBasedIndex) {
        if (oneBasedIndex < 1 || oneBasedIndex > elements.size()) {
            throw new IndexOutOfBoundsException(
                    "COBOL subscript for '" + name + "' out of bounds: " + oneBasedIndex
                            + " (valid 1.." + elements.size() + ")");
        }
        return elements.get(oneBasedIndex - 1);
    }

    public CobolField get(CobolDecimal oneBasedIndex) {
        Objects.requireNonNull(oneBasedIndex, "oneBasedIndex");
        return get(oneBasedIndex.value().intValueExact());
    }

    public CobolField get(CobolField oneBasedIndex) {
        Objects.requireNonNull(oneBasedIndex, "oneBasedIndex");
        return get(oneBasedIndex.intValueExact());
    }

    public void moveLiteralToAll(String literal) {
        for (CobolField element : elements) {
            element.moveLiteral(literal);
        }
    }

    public void setNumericValueToAll(CobolDecimal value) {
        for (CobolField element : elements) {
            element.setNumericValue(value);
        }
    }

    public List<CobolField> elements() {
        return elements;
    }
}
