package com.c2c.w0.buildtest;

import java.util.regex.Pattern;

/**
 * Producer-side bounds for diagnostic fields emitted into Evidence under
 * {@code parity-build-result-v0} and {@code parity-execution-result-v0}.
 *
 * <p>The schemas (Issue #351, hardened by PR #397) reject {@code message} over
 * 4000 chars and {@code filePath} over 500 chars or carrying a leading slash
 * or {@code ..} segment. Without enforcement at the producer, a runaway
 * {@code javac} diagnostic message or an absolute-path {@link
 * javax.tools.JavaFileObject#getName()} (typically a temp directory URI)
 * would fail evidence-ledger validation at ingest. Issue #353 closes that
 * gap symmetric with the COBOL-side cap added by PR #398.
 */
final class DiagnosticBounds {

    static final int MAX_MESSAGE_LENGTH = 4000;
    static final int MAX_FILEPATH_LENGTH = 500;
    static final String MESSAGE_TRUNCATION_SENTINEL = "…[truncated]";
    private static final Pattern FILEPATH_ALLOWED = Pattern.compile("[A-Za-z0-9._/-]");

    private DiagnosticBounds() {
    }

    static String boundedMessage(String message) {
        if (message == null || message.isEmpty()) {
            return message;
        }
        if (message.length() <= MAX_MESSAGE_LENGTH) {
            return message;
        }
        int keep = MAX_MESSAGE_LENGTH - MESSAGE_TRUNCATION_SENTINEL.length();
        if (keep <= 0) {
            return message.substring(0, MAX_MESSAGE_LENGTH);
        }
        return message.substring(0, keep) + MESSAGE_TRUNCATION_SENTINEL;
    }

    /**
     * Sanitize a candidate {@code filePath} so it satisfies the schema pattern
     * {@code ^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._/-]+$} and the 500-char
     * cap. Absolute paths, parent-traversal segments, and pattern-illegal
     * characters are stripped or replaced; an unrecoverable result falls back
     * to {@code "generated-project"} so the schema's {@code minLength: 1} is
     * preserved.
     */
    static String boundedFilePath(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return "generated-project";
        }
        String normalised = filePath.replace('\\', '/').trim();
        while (normalised.startsWith("/")) {
            normalised = normalised.substring(1);
        }
        StringBuilder sanitized = new StringBuilder(normalised.length());
        for (int i = 0; i < normalised.length(); i++) {
            String character = normalised.substring(i, i + 1);
            sanitized.append(FILEPATH_ALLOWED.matcher(character).matches() ? character : "_");
        }
        String[] segments = sanitized.toString().split("/", -1);
        StringBuilder rebuilt = new StringBuilder();
        for (String segment : segments) {
            if (segment.isEmpty() || "..".equals(segment)) {
                continue;
            }
            if (rebuilt.length() > 0) {
                rebuilt.append('/');
            }
            rebuilt.append(segment);
        }
        if (rebuilt.length() == 0) {
            return "generated-project";
        }
        if (rebuilt.length() > MAX_FILEPATH_LENGTH) {
            rebuilt.setLength(MAX_FILEPATH_LENGTH);
        }
        return rebuilt.toString();
    }
}
