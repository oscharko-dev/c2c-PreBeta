package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.junit.jupiter.api.Assertions.*;

class CobolFieldTest {

    @Test
    void numericFieldStartsAtZeroWithDeclaredScale() {
        CobolField f = new CobolField("WS-AMOUNT", "ir-1", PictureSpec.parse("S9(5)V99"));
        assertTrue(f.numeric());
        assertEquals(2, f.numericValue().scale());
        assertEquals(BigDecimal.ZERO.setScale(2), f.numericValue().value());
    }

    @Test
    void alphanumericFieldStartsBlankPaddedToWidth() {
        CobolField f = new CobolField("WS-NAME", "ir-2", PictureSpec.parse("X(5)"));
        assertEquals("     ", f.displayValue());
    }

    @Test
    void setNumericValueRescalesIntoFieldScale() {
        CobolField f = new CobolField("WS-AMOUNT", "ir-3", PictureSpec.parse("9(3)V9"));
        f.setNumericValue(CobolDecimal.of("1.49", 2, false));
        assertEquals(new BigDecimal("1.5"), f.numericValue().value());
    }

    @Test
    void unsignedFieldRejectsNegativeAssignment() {
        CobolField f = new CobolField("WS-COUNT", "ir-4", PictureSpec.parse("9(3)"));
        assertThrows(IllegalStateException.class,
                () -> f.setNumericValue(CobolDecimal.of("-1", 0, true)));
    }

    @Test
    void overflowsIntegerDigits() {
        CobolField f = new CobolField("WS-AMOUNT", "ir-5", PictureSpec.parse("9(2)V9"));
        // 2 integer digits -> max 99 (integer part)
        assertThrows(IllegalStateException.class,
                () -> f.setNumericValue(CobolDecimal.of("100.0", 1, false)));
    }

    @Test
    void moveLiteralTruncatesOnOverflow() {
        CobolField f = new CobolField("WS-NAME", "ir-6", PictureSpec.parse("X(3)"));
        f.moveLiteral("HELLO");
        assertEquals("HEL", f.displayValue());
    }

    @Test
    void moveLiteralPadsOnRightWithSpaces() {
        CobolField f = new CobolField("WS-NAME", "ir-7", PictureSpec.parse("X(5)"));
        f.moveLiteral("HI");
        assertEquals("HI   ", f.displayValue());
    }

    @Test
    void moveBetweenIncompatibleCategoriesFails() {
        CobolField num = new CobolField("WS-AMT", "ir-8", PictureSpec.parse("9(3)"));
        CobolField str = new CobolField("WS-NAME", "ir-9", PictureSpec.parse("X(3)"));
        assertThrows(IllegalStateException.class, () -> str.moveFrom(num));
    }

    @Test
    void numericMoveBetweenDifferentScalesRescales() {
        CobolField source = new CobolField("WS-A", "ir-10", PictureSpec.parse("9(3)V99"));
        source.setNumericValue(CobolDecimal.of("1.99", 2, false));
        CobolField target = new CobolField("WS-B", "ir-11", PictureSpec.parse("9(3)V9"));
        target.moveFrom(source);
        // 1.99 rescaled to scale 1 with HALF_EVEN -> 2.0
        assertEquals(new BigDecimal("2.0"), target.numericValue().value());
    }

    @Test
    void displayValueFormatsSignedDecimal() {
        CobolField f = new CobolField("WS-AMT", "ir-12", PictureSpec.parse("S9(3)V99"));
        f.setNumericValue(CobolDecimal.of("-12.30", 2, true));
        assertEquals("-012.30", f.displayValue());
    }

    @Test
    void positiveSignedDecimalDisplaysWithoutPlusSign() {
        CobolField f = new CobolField("WS-AMT", "ir-13", PictureSpec.parse("S9(3)V99"));
        f.moveNumericLiteral("12.30");
        assertEquals("012.30", f.displayValue());
    }

    @Test
    void moveNumericLiteralUsesDeclaredScale() {
        CobolField f = new CobolField("WS-AMT", "ir-14", PictureSpec.parse("S9(3)V9"));
        f.moveNumericLiteral("12.34");
        assertEquals("012.3", f.displayValue());
    }

    @Test
    void irNodeIdIsPreserved() {
        CobolField f = new CobolField("WS-AMT", "stmt-007", PictureSpec.parse("9(3)"));
        assertEquals("stmt-007", f.irNodeId());
    }
}
