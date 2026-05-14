package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ConditionStatusTest {

    @Test
    void isNumericTrueForNumericField() {
        CobolField f = new CobolField("WS-N", "ir-1", PictureSpec.parse("9(3)"));
        assertTrue(ConditionStatus.isNumeric(f));
    }

    @Test
    void isNumericTrueForAlphanumericContainingDigits() {
        CobolField f = new CobolField("WS-S", "ir-2", PictureSpec.parse("X(5)"));
        f.moveLiteral("123");
        assertTrue(ConditionStatus.isNumeric(f));
    }

    @Test
    void isNumericFalseForBlankAlphanumeric() {
        CobolField f = new CobolField("WS-S", "ir-3", PictureSpec.parse("X(5)"));
        // freshly initialized to spaces
        assertFalse(ConditionStatus.isNumeric(f));
    }

    @Test
    void isAlphabeticTrueForLettersAndSpaces() {
        CobolField f = new CobolField("WS-S", "ir-4", PictureSpec.parse("X(10)"));
        f.moveLiteral("HELLO");
        assertTrue(ConditionStatus.isAlphabetic(f));
    }

    @Test
    void isAlphabeticFalseForDigits() {
        CobolField f = new CobolField("WS-S", "ir-5", PictureSpec.parse("X(10)"));
        f.moveLiteral("ABC123");
        assertFalse(ConditionStatus.isAlphabetic(f));
    }

    @Test
    void isZeroTrueForFreshNumericField() {
        CobolField f = new CobolField("WS-N", "ir-6", PictureSpec.parse("9(3)V99"));
        assertTrue(ConditionStatus.isZero(f));
    }

    @Test
    void positiveAndNegativeRequireNumeric() {
        CobolField str = new CobolField("WS-S", "ir-7", PictureSpec.parse("X(3)"));
        assertThrows(IllegalArgumentException.class, () -> ConditionStatus.isPositive(str));
        assertThrows(IllegalArgumentException.class, () -> ConditionStatus.isNegative(str));
    }

    @Test
    void positiveDetectedOnPositiveValue() {
        CobolField f = new CobolField("WS-N", "ir-8", PictureSpec.parse("S9(3)V9"));
        f.setNumericValue(CobolDecimal.of("0.1", 1, true));
        assertTrue(ConditionStatus.isPositive(f));
        assertFalse(ConditionStatus.isNegative(f));
        assertFalse(ConditionStatus.isZero(f));
    }

    @Test
    void relationalsFollowDecimalCompare() {
        CobolDecimal a = CobolDecimal.of("1.50", 2, true);
        CobolDecimal b = CobolDecimal.of("1.5", 1, true);
        assertTrue(ConditionStatus.equalTo(a, b));
        assertFalse(ConditionStatus.notEqual(a, b));
        assertTrue(ConditionStatus.lessOrEqual(a, b));
        assertTrue(ConditionStatus.greaterOrEqual(a, b));
        assertFalse(ConditionStatus.lessThan(a, b));
        assertFalse(ConditionStatus.greaterThan(a, b));

        CobolDecimal c = CobolDecimal.of("2", 0, true);
        assertTrue(ConditionStatus.lessThan(a, c));
        assertTrue(ConditionStatus.greaterThan(c, a));
    }
}
