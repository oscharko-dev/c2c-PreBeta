package com.c2c.w0.buildtest;

import com.google.googlejavaformat.java.Formatter;
import com.google.googlejavaformat.java.FormatterException;

/**
 * Studio-IDE-14 (#256): deterministic Java formatter exposed by the
 * build-test-runner-service through {@code POST /v0/format-java}.
 *
 * <p>The implementation delegates to {@code google-java-format}. The formatter
 * is constructed fresh per call: Formatter holds no mutable state and the
 * construction cost is negligible compared with a per-request HTTP round-trip,
 * so pooling is deferred to W1 per the slice contract.
 */
public final class JavaFormatter {

    public static final class FormatResult {
        private final String formattedContent;
        private final String errorMessage;
        private final Integer errorLine;
        private final Integer errorColumn;

        private FormatResult(String formattedContent,
                             String errorMessage,
                             Integer errorLine,
                             Integer errorColumn) {
            this.formattedContent = formattedContent;
            this.errorMessage = errorMessage;
            this.errorLine = errorLine;
            this.errorColumn = errorColumn;
        }

        public static FormatResult ok(String content) {
            return new FormatResult(content, null, null, null);
        }

        public static FormatResult failed(String message, Integer line, Integer column) {
            return new FormatResult(null, message, line, column);
        }

        public boolean isOk() {
            return formattedContent != null;
        }

        public String formattedContent() {
            return formattedContent;
        }

        public String errorMessage() {
            return errorMessage;
        }

        public Integer errorLine() {
            return errorLine;
        }

        public Integer errorColumn() {
            return errorColumn;
        }
    }

    private final Formatter formatter;

    public JavaFormatter() {
        this.formatter = new Formatter();
    }

    /**
     * Format the supplied Java source. Returns either the formatted content
     * (idempotent on already-formatted input) or a structured error with a
     * 1-indexed line/column when google-java-format pinpoints the offending
     * token.
     */
    public FormatResult format(String content) {
        if (content == null) {
            return FormatResult.failed("content is required", null, null);
        }
        try {
            String formatted = formatter.formatSource(content);
            return FormatResult.ok(formatted);
        } catch (FormatterException e) {
            return FormatResult.failed(
                    e.getMessage() == null ? "format failed" : e.getMessage(),
                    extractLine(e),
                    extractColumn(e));
        }
    }

    private static Integer extractLine(FormatterException e) {
        if (e.diagnostics() == null || e.diagnostics().isEmpty()) {
            return null;
        }
        int line = e.diagnostics().get(0).line();
        return line > 0 ? line : null;
    }

    private static Integer extractColumn(FormatterException e) {
        if (e.diagnostics() == null || e.diagnostics().isEmpty()) {
            return null;
        }
        int column = e.diagnostics().get(0).column();
        return column > 0 ? column : null;
    }
}
