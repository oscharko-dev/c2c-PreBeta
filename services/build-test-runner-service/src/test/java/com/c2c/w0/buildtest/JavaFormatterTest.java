package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JavaFormatterTest {

    private final JavaFormatter formatter = new JavaFormatter();

    @Test
    void formatNormalizesIndentationAndSpacing() {
        String input = "package com.example;public class A{int x=1;public int get(){return x;}}";
        JavaFormatter.FormatResult result = formatter.format(input);
        assertTrue(result.isOk(), "well-formed Java must format");
        String formatted = result.formattedContent();
        assertNotNull(formatted);
        // google-java-format expands the single-line class into multiple lines.
        assertTrue(formatted.contains("\n"), "formatted output must be multi-line");
        assertTrue(formatted.contains("public class A"), "class declaration preserved");
        assertTrue(formatted.contains("public int get()"), "method signature preserved");
    }

    @Test
    void formatIsIdempotent() {
        String input = "package com.example;\n\npublic class A {}\n";
        JavaFormatter.FormatResult first = formatter.format(input);
        assertTrue(first.isOk());
        JavaFormatter.FormatResult second = formatter.format(first.formattedContent());
        assertTrue(second.isOk());
        assertEquals(first.formattedContent(), second.formattedContent(),
                "formatting the formatted output must produce identical bytes");
    }

    @Test
    void formatRejectsSyntacticallyInvalidSource() {
        String input = "package com.example; public class A { public void m( { } }";
        JavaFormatter.FormatResult result = formatter.format(input);
        assertFalse(result.isOk(), "invalid source must report a format failure");
        assertNotNull(result.errorMessage(), "error message must be present");
    }

    @Test
    void formatTreatsNullContentAsBadRequest() {
        JavaFormatter.FormatResult result = formatter.format(null);
        assertFalse(result.isOk());
        assertEquals("content is required", result.errorMessage());
    }

    @Test
    void formatNormalisesEmptyFile() {
        JavaFormatter.FormatResult result = formatter.format("");
        assertTrue(result.isOk(), "empty input is valid Java");
        // google-java-format normalises files to end with a newline; we
        // accept either no content or a single newline.
        String formatted = result.formattedContent();
        assertTrue(formatted.isEmpty() || formatted.equals("\n"),
                "expected empty or single-newline output, got: " + formatted);
    }
}
