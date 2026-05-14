package com.c2c.target.java.runtime;

import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parsed COBOL {@code PIC} clause covering the W0 subset:
 * {@code 9(n)}, {@code S9(n)}, {@code 9(n)V9(s)}, {@code S9(n)V9(s)},
 * {@code X(n)}, {@code A(n)}.
 * <p>
 * Anything outside that subset (edited pictures, {@code COMP-3} usage,
 * {@code BLANK WHEN ZERO}) is rejected so the W0 generator never silently
 * produces wrong runtime semantics.
 */
public final class PictureSpec {

    /** Numeric, character, or alphabetic. */
    public enum Category { NUMERIC, ALPHANUMERIC, ALPHABETIC }

    // Numeric: optional S, integer part as 9(n) or literal 9s, optional V then
    // scale part again as 9(n) or literal 9s.
    private static final Pattern NUMERIC = Pattern.compile(
            "^(S?)(?:9\\((\\d+)\\)|(9+))(?:V(?:9\\((\\d+)\\)|(9+)))?$");
    private static final Pattern ALNUM = Pattern.compile("^(?:X\\((\\d+)\\)|(X+))$");
    private static final Pattern ALPHA = Pattern.compile("^(?:A\\((\\d+)\\)|(A+))$");

    private final String raw;
    private final Category category;
    private final int integerDigits;
    private final int scale;
    private final int byteSize;
    private final boolean signed;

    private PictureSpec(String raw, Category category, int integerDigits,
                        int scale, int byteSize, boolean signed) {
        this.raw = raw;
        this.category = category;
        this.integerDigits = integerDigits;
        this.scale = scale;
        this.byteSize = byteSize;
        this.signed = signed;
    }

    public static PictureSpec parse(String picture) {
        Objects.requireNonNull(picture, "picture");
        String normalized = picture.trim().toUpperCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException("PIC clause is empty");
        }

        Matcher numericMatch = NUMERIC.matcher(normalized);
        if (numericMatch.matches()) {
            boolean signed = !numericMatch.group(1).isEmpty();
            int intDigits = numericMatch.group(2) != null
                    ? Integer.parseInt(numericMatch.group(2))
                    : numericMatch.group(3).length();
            int scale;
            if (numericMatch.group(4) != null) {
                scale = Integer.parseInt(numericMatch.group(4));
            } else if (numericMatch.group(5) != null) {
                scale = numericMatch.group(5).length();
            } else {
                scale = 0;
            }
            // Display numeric: one byte per digit; sign overpunched into the last digit.
            int bytes = intDigits + scale;
            return new PictureSpec(picture, Category.NUMERIC, intDigits, scale, bytes, signed);
        }

        Matcher alnumMatch = ALNUM.matcher(normalized);
        if (alnumMatch.matches()) {
            int len = alnumMatch.group(1) != null
                    ? Integer.parseInt(alnumMatch.group(1))
                    : alnumMatch.group(2).length();
            return new PictureSpec(picture, Category.ALPHANUMERIC, 0, 0, len, false);
        }

        Matcher alphaMatch = ALPHA.matcher(normalized);
        if (alphaMatch.matches()) {
            int len = alphaMatch.group(1) != null
                    ? Integer.parseInt(alphaMatch.group(1))
                    : alphaMatch.group(2).length();
            return new PictureSpec(picture, Category.ALPHABETIC, 0, 0, len, false);
        }

        throw new IllegalArgumentException(
                "Unsupported PIC clause for W0 runtime: " + picture
                        + " (W0 supports 9(n), S9(n), 9(n)V9(s), S9(n)V9(s), X(n), A(n))");
    }

    public String raw() {
        return raw;
    }

    public Category category() {
        return category;
    }

    public int integerDigits() {
        return integerDigits;
    }

    public int scale() {
        return scale;
    }

    public int byteSize() {
        return byteSize;
    }

    public boolean signed() {
        return signed;
    }

    public boolean numeric() {
        return category == Category.NUMERIC;
    }
}
