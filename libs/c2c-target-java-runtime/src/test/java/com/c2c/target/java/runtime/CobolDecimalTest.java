package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.junit.jupiter.api.Assertions.*;

class CobolDecimalTest {

    @Test
    void rescalesAtConstructionWithHalfEven() {
        // 1.235 with scale 2 rounds to 1.24 (HALF_EVEN: tie to even, but 5 not on even boundary here).
        CobolDecimal d = CobolDecimal.of("1.235", 2, true);
        assertEquals(new BigDecimal("1.24"), d.value());
    }

    @Test
    void halfEvenTiesToEvenForBoundary() {
        // 1.225 -> scale 2: HALF_EVEN rounds to 1.22 (tie, even).
        CobolDecimal d = CobolDecimal.of("1.225", 2, true);
        assertEquals(new BigDecimal("1.22"), d.value());
    }

    @Test
    void unsignedRejectsNegative() {
        assertThrows(IllegalArgumentException.class,
                () -> CobolDecimal.of("-1.00", 2, false));
    }

    @Test
    void addWidensToMaxScale() {
        CobolDecimal a = CobolDecimal.of("1.5", 1, true);   // scale 1
        CobolDecimal b = CobolDecimal.of("2.250", 3, true); // scale 3
        CobolDecimal sum = a.add(b);
        assertEquals(3, sum.scale());
        assertEquals(new BigDecimal("3.750"), sum.value());
    }

    @Test
    void subtractFromUnsignedYieldsSignedResult() {
        CobolDecimal a = CobolDecimal.of("3", 0, false);
        CobolDecimal b = CobolDecimal.of("5", 0, false);
        CobolDecimal diff = a.subtract(b);
        assertTrue(diff.signed(), "subtract result must allow signed");
        assertEquals(new BigDecimal("-2"), diff.value());
    }

    @Test
    void multiplyKeepsMaxScale() {
        CobolDecimal a = CobolDecimal.of("1.50", 2, true);
        CobolDecimal b = CobolDecimal.of("2.0", 1, true);
        CobolDecimal product = a.multiply(b);
        assertEquals(2, product.scale());
        assertEquals(new BigDecimal("3.00"), product.value());
    }

    @Test
    void divideRoundsAtScaleHalfEven() {
        CobolDecimal a = CobolDecimal.of("1.00", 2, true);
        CobolDecimal b = CobolDecimal.of("3.00", 2, true);
        CobolDecimal q = a.divide(b);
        assertEquals(2, q.scale());
        // 0.333... -> HALF_EVEN at scale 2 -> 0.33
        assertEquals(new BigDecimal("0.33"), q.value());
    }

    @Test
    void divideByZeroFails() {
        CobolDecimal a = CobolDecimal.of("1.00", 2, true);
        CobolDecimal zero = CobolDecimal.zeroLike(a);
        assertThrows(ArithmeticException.class, () -> a.divide(zero));
    }

    @Test
    void rescaleTruncatesScaleWithRounding() {
        CobolDecimal a = CobolDecimal.of("1.235", 3, true);
        CobolDecimal narrowed = a.rescale(1);
        assertEquals(new BigDecimal("1.2"), narrowed.value());
    }

    @Test
    void compareAndEqualityIgnoreScale() {
        CobolDecimal a = CobolDecimal.of("1.0", 1, true);
        CobolDecimal b = CobolDecimal.of("1.000", 3, true);
        assertEquals(0, a.compareTo(b));
        // Equality also ignores trailing zeros so generated comparators behave
        // like COBOL's relational operators.
        assertEquals(a, b);
        assertEquals(a.hashCode(), b.hashCode());
    }

    @Test
    void zeroLikeMatchesPrototypeShape() {
        CobolDecimal proto = CobolDecimal.of("9.99", 2, true);
        CobolDecimal zero = CobolDecimal.zeroLike(proto);
        assertEquals(2, zero.scale());
        assertTrue(zero.signed());
        assertEquals(0, zero.value().signum());
    }

    @Test
    void rejectsNegativeScale() {
        assertThrows(IllegalArgumentException.class,
                () -> CobolDecimal.of("1", -1, true));
    }
}
