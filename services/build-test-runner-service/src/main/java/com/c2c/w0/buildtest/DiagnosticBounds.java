package com.c2c.w0.buildtest;

/**
 * Producer-side bounds for diagnostic and parity-comparison fields emitted
 * into Evidence under {@code parity-build-result-v0},
 * {@code parity-execution-result-v0}, and {@code parity-comparison-result-v0}.
 *
 * <p>The schemas (Issue #351, hardened by PR #397) reject {@code message} over
 * 4000 chars and {@code filePath} over 500 chars or carrying a leading slash
 * or {@code ..} segment. Without enforcement at the producer, a runaway
 * {@code javac} diagnostic message or an absolute-path {@link
 * javax.tools.JavaFileObject#getName()} (typically a temp directory URI)
 * would fail evidence-ledger validation at ingest. Issue #353 closes that
 * gap symmetric with the COBOL-side cap added by PR #398.
 *
 * <p>The 4000-char ceiling on {@code diffSummary} in
 * {@code parity-comparison-result-v0} (Issue #354) is enforced by the same
 * helper via {@link #boundedDiffSummary(String)}, so that a long
 * {@code reason} passed to {@link ParityComparison#runtimeFailure} or
 * {@link ParityComparison#unsupported} cannot fail schema validation at
 * ingest.
 */
final class DiagnosticBounds {

    static final int MAX_MESSAGE_LENGTH = 4000;
    static final int MAX_FILEPATH_LENGTH = 500;
    static final int MAX_DIFF_SUMMARY_LENGTH = 4000;
    static final String MESSAGE_TRUNCATION_SENTINEL = "…[truncated]";

    /**
     * Bound on the raw input fed into {@link #boundedFilePath(String)} so that
     * per-character sanitization cannot do unbounded work when an untrusted
     * producer (e.g. {@code JavaFileObject.getName()} on a deeply-nested temp
     * URI) hands in a multi-kilobyte path. Sized at {@code 2 ×
     * MAX_FILEPATH_LENGTH} so a path with up to 50% invalid characters still
     * has enough headroom to recover the schema-conformant prefix.
     */
    private static final int MAX_FILEPATH_RAW_INPUT = MAX_FILEPATH_LENGTH * 2;

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
     * Apply the {@code parity-comparison-result-v0.diffSummary} ceiling
     * (Issue #354) at the producer. Callers of
     * {@link ParityComparison#runtimeFailure} and
     * {@link ParityComparison#unsupported} pass a free-form {@code reason}
     * string, which lands directly in the schema-bounded {@code diffSummary}
     * field. Truncation reuses the {@link #MESSAGE_TRUNCATION_SENTINEL}
     * suffix used by {@link #boundedMessage(String)}.
     */
    static String boundedDiffSummary(String diffSummary) {
        if (diffSummary == null || diffSummary.isEmpty()) {
            return diffSummary;
        }
        if (diffSummary.length() <= MAX_DIFF_SUMMARY_LENGTH) {
            return diffSummary;
        }
        int keep = MAX_DIFF_SUMMARY_LENGTH - MESSAGE_TRUNCATION_SENTINEL.length();
        if (keep <= 0) {
            return diffSummary.substring(0, MAX_DIFF_SUMMARY_LENGTH);
        }
        return diffSummary.substring(0, keep) + MESSAGE_TRUNCATION_SENTINEL;
    }

    /**
     * Sanitize a candidate {@code filePath} so it satisfies the schema pattern
     * {@code ^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._/-]+$} and the 500-char
     * cap. Absolute paths, parent-traversal segments, and pattern-illegal
     * characters are stripped or replaced. Truncation is segment-based — a
     * segment is appended only if it fits in full — so that no truncation can
     * ever produce a synthetic {@code ".."} tail and re-trigger the
     * schema-forbidden traversal pattern. An unrecoverable result falls back
     * to {@code "generated-project"} so the schema's {@code minLength: 1} is
     * preserved.
     */
    static String boundedFilePath(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return "generated-project";
        }
        String clamped = filePath.length() > MAX_FILEPATH_RAW_INPUT
                ? filePath.substring(0, MAX_FILEPATH_RAW_INPUT)
                : filePath;
        String normalised = clamped.replace('\\', '/').trim();
        while (normalised.startsWith("/")) {
            normalised = normalised.substring(1);
        }
        StringBuilder sanitized = new StringBuilder(normalised.length());
        for (int i = 0; i < normalised.length(); i++) {
            char character = normalised.charAt(i);
            sanitized.append(isAllowedFilePathChar(character) ? character : '_');
        }
        String[] segments = sanitized.toString().split("/", -1);
        StringBuilder rebuilt = new StringBuilder();
        for (String segment : segments) {
            if (segment.isEmpty() || "..".equals(segment)) {
                continue;
            }
            int separator = rebuilt.length() > 0 ? 1 : 0;
            int projected = rebuilt.length() + separator + segment.length();
            if (projected > MAX_FILEPATH_LENGTH) {
                break;
            }
            if (separator == 1) {
                rebuilt.append('/');
            }
            rebuilt.append(segment);
        }
        if (rebuilt.length() == 0) {
            return "generated-project";
        }
        return rebuilt.toString();
    }

    private static boolean isAllowedFilePathChar(char character) {
        return (character >= 'A' && character <= 'Z')
                || (character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9')
                || character == '.'
                || character == '_'
                || character == '/'
                || character == '-';
    }
}
