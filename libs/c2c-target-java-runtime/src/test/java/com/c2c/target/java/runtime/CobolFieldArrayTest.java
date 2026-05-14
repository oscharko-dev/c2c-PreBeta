package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class CobolFieldArrayTest {

    @Test
    void usesCobolOneBasedIndexing() {
        CobolFieldArray array = new CobolFieldArray("WS-ITEM", "ir-array", PictureSpec.parse("9(2)"), 2);
        array.get(1).moveNumericLiteral("7");
        array.get(2).moveNumericLiteral("8");

        assertEquals("07", array.get(1).displayValue());
        assertEquals("08", array.get(CobolDecimal.of(2L, 0, false)).displayValue());
        assertThrows(IndexOutOfBoundsException.class, () -> array.get(0));
        assertThrows(IndexOutOfBoundsException.class, () -> array.get(3));
    }

    @Test
    void initializesAllOccurrences() {
        CobolFieldArray array = new CobolFieldArray("WS-CODE", "ir-code", PictureSpec.parse("X(2)"), 3);
        array.moveLiteralToAll("A");

        assertEquals("A ", array.get(1).displayValue());
        assertEquals("A ", array.get(2).displayValue());
        assertEquals("A ", array.get(3).displayValue());
    }
}
