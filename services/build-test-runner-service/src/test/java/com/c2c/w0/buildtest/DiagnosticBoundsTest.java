package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Regression tests for the schema bounds enforced on {@code message} and
 * {@code filePath} by {@code parity-build-result-v0} / {@code
 * parity-execution-result-v0} (Issue #351 / PR #397). Producer-side
 * enforcement was missing for the generated-Java pipeline; Issue #353 closes
 * that gap.
 */
class DiagnosticBoundsTest {

    private static final Pattern SCHEMA_FILEPATH_PATTERN =
            Pattern.compile("^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$");

    @Test
    void messageBelowLimitPassesThrough() {
        String message = "javac complaint about a missing semicolon at line 17";
        assertEquals(message, DiagnosticBounds.boundedMessage(message));
    }

    @Test
    void oversizedMessageIsTruncatedWithSentinel() {
        String oversize = "x".repeat(DiagnosticBounds.MAX_MESSAGE_LENGTH + 500);
        String bounded = DiagnosticBounds.boundedMessage(oversize);
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_MESSAGE_LENGTH,
                () -> "expected <= " + DiagnosticBounds.MAX_MESSAGE_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(bounded.endsWith(DiagnosticBounds.MESSAGE_TRUNCATION_SENTINEL),
                () -> "expected truncation sentinel suffix, got: " + bounded);
    }

    @Test
    void nullMessageIsPreserved() {
        assertEquals(null, DiagnosticBounds.boundedMessage(null));
    }

    @Test
    void relativeFilePathPassesThrough() {
        String path = "src/main/java/sample/Hello.java";
        String bounded = DiagnosticBounds.boundedFilePath(path);
        assertEquals(path, bounded);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
    }

    @Test
    void absolutePathLosesLeadingSlash() {
        String absolute = "/private/var/folders/c2c-build-test-xxx/src/Main.java";
        String bounded = DiagnosticBounds.boundedFilePath(absolute);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
        assertNotEquals(absolute, bounded);
    }

    @Test
    void traversalSegmentIsStripped() {
        String traversal = "src/../../etc/passwd";
        String bounded = DiagnosticBounds.boundedFilePath(traversal);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
        assertTrue(!bounded.contains(".."),
                () -> "expected '..' to be removed, got: " + bounded);
    }

    @Test
    void backslashesAreNormalised() {
        String windowsStyle = "src\\main\\java\\Hello.java";
        String bounded = DiagnosticBounds.boundedFilePath(windowsStyle);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
        assertEquals("src/main/java/Hello.java", bounded);
    }

    @Test
    void unsafeCharactersAreReplaced() {
        String unsafe = "src/main/java/Bad Name?.java";
        String bounded = DiagnosticBounds.boundedFilePath(unsafe);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
    }

    @Test
    void oversizedFilePathIsTruncated() {
        String oversize = "src/main/java/" + "a".repeat(DiagnosticBounds.MAX_FILEPATH_LENGTH + 100) + ".java";
        String bounded = DiagnosticBounds.boundedFilePath(oversize);
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_FILEPATH_LENGTH,
                () -> "expected <= " + DiagnosticBounds.MAX_FILEPATH_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
    }

    @Test
    void longTrailingSegmentStartingWithDotsIsNotTruncatedToDoubleDot() {
        // Segment ".." is filtered, but "..foo" passes the filter. Truncating
        // mid-segment could leave just ".." and re-trigger the schema's
        // traversal rejection. Segment-based truncation must keep the result
        // schema-conformant.
        String head = "a".repeat(DiagnosticBounds.MAX_FILEPATH_LENGTH - 5);
        String trailing = "..foo" + "x".repeat(20);
        String input = head + "/" + trailing;
        String bounded = DiagnosticBounds.boundedFilePath(input);
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
        assertTrue(!bounded.endsWith(".."),
                () -> "expected no '..' tail after truncation, got: " + bounded);
    }

    @Test
    void veryLargeUntrustedInputDoesNotExplodeAllocation() {
        // Producer-side defence: per-character sanitization must not loop over
        // an unbounded input. A 256 KiB input is bounded to MAX_FILEPATH_LENGTH
        // characters in the result.
        String huge = "a".repeat(256 * 1024);
        String bounded = DiagnosticBounds.boundedFilePath(huge);
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_FILEPATH_LENGTH,
                () -> "expected <= " + DiagnosticBounds.MAX_FILEPATH_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(SCHEMA_FILEPATH_PATTERN.matcher(bounded).matches(),
                () -> "expected schema-conformant path, got: " + bounded);
    }

    @Test
    void singleOversizeSegmentFallsBackInsteadOfMidSegmentTruncation() {
        // A single segment longer than the cap cannot be appended in full and
        // must not be cut mid-string. Falls back to the safe placeholder.
        String oversizeSingleSegment = "a".repeat(DiagnosticBounds.MAX_FILEPATH_LENGTH + 50);
        String bounded = DiagnosticBounds.boundedFilePath(oversizeSingleSegment);
        assertEquals("generated-project", bounded);
    }

    @Test
    void blankFilePathFallsBackToGeneratedProject() {
        assertEquals("generated-project", DiagnosticBounds.boundedFilePath(""));
        assertEquals("generated-project", DiagnosticBounds.boundedFilePath(null));
        assertEquals("generated-project", DiagnosticBounds.boundedFilePath("   "));
    }

    @Test
    void onlyTraversalCollapsesToFallback() {
        assertEquals("generated-project", DiagnosticBounds.boundedFilePath("../.."));
        assertEquals("generated-project", DiagnosticBounds.boundedFilePath("/../"));
    }

    @Test
    void diffSummaryBelowLimitPassesThrough() {
        String summary = "Normalized stdout mismatch (content) at character 12; sourceLength=42 targetLength=43.";
        assertEquals(summary, DiagnosticBounds.boundedDiffSummary(summary));
    }

    @Test
    void oversizedDiffSummaryIsTruncatedWithSentinel() {
        String oversize = "x".repeat(DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH + 500);
        String bounded = DiagnosticBounds.boundedDiffSummary(oversize);
        assertTrue(bounded.length() <= DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH,
                () -> "expected <= " + DiagnosticBounds.MAX_DIFF_SUMMARY_LENGTH
                        + " chars, got " + bounded.length());
        assertTrue(bounded.endsWith(DiagnosticBounds.MESSAGE_TRUNCATION_SENTINEL),
                () -> "expected truncation sentinel suffix, got: " + bounded);
    }

    @Test
    void nullDiffSummaryIsPreserved() {
        assertEquals(null, DiagnosticBounds.boundedDiffSummary(null));
    }

    @Test
    void emptyDiffSummaryIsPreserved() {
        assertEquals("", DiagnosticBounds.boundedDiffSummary(""));
    }
}
