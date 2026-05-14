package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PictureSpecTest {

    @Test
    void parsesSignedDecimal() {
        PictureSpec p = PictureSpec.parse("S9(5)V99");
        assertEquals(PictureSpec.Category.NUMERIC, p.category());
        assertTrue(p.signed());
        assertEquals(5, p.integerDigits());
        assertEquals(2, p.scale());
        assertEquals(7, p.byteSize());
        assertTrue(p.numeric());
    }

    @Test
    void parsesUnsignedInteger() {
        PictureSpec p = PictureSpec.parse("9(4)");
        assertFalse(p.signed());
        assertEquals(4, p.integerDigits());
        assertEquals(0, p.scale());
        assertEquals(4, p.byteSize());
    }

    @Test
    void parsesAlphanumeric() {
        PictureSpec p = PictureSpec.parse("X(10)");
        assertEquals(PictureSpec.Category.ALPHANUMERIC, p.category());
        assertEquals(10, p.byteSize());
        assertFalse(p.numeric());
    }

    @Test
    void parsesAlphabetic() {
        PictureSpec p = PictureSpec.parse("A(3)");
        assertEquals(PictureSpec.Category.ALPHABETIC, p.category());
        assertEquals(3, p.byteSize());
    }

    @Test
    void rejectsUnsupportedW0Picture() {
        // Edited picture clauses are intentionally out of scope; W0 must
        // refuse silent fallback so the generator can't emit wrong semantics.
        assertThrows(IllegalArgumentException.class, () -> PictureSpec.parse("ZZZ9.99"));
    }

    @Test
    void rejectsCompUsageEmbeddedInPicture() {
        assertThrows(IllegalArgumentException.class, () -> PictureSpec.parse("S9(5) COMP-3"));
    }

    @Test
    void rejectsEmptyPicture() {
        assertThrows(IllegalArgumentException.class, () -> PictureSpec.parse("   "));
    }

    @Test
    void parsingIsCaseInsensitive() {
        PictureSpec p = PictureSpec.parse("s9(3)v9");
        assertTrue(p.signed());
        assertEquals(3, p.integerDigits());
        assertEquals(1, p.scale());
    }
}
