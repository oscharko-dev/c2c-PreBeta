package com.c2c.w0.buildtest;

import java.util.LinkedHashMap;
import java.util.Map;

final class DeterministicComparisonPolicy {

    static final String VERSION = "deterministic-output-v1";

    private DeterministicComparisonPolicy() {
    }

    static Map<String, Object> toMap() {
        Map<String, Object> policy = new LinkedHashMap<>();
        policy.put("schemaVersion", BuildTestRunnerService.SCHEMA_VERSION);
        policy.put("policyId", "parity-output-comparison");
        policy.put("policyVersion", VERSION);
        policy.put("lineEndings", "Normalize CRLF and CR to LF before comparison.");
        policy.put("trailingWhitespace",
                "Strip trailing spaces and tabs on each line and remove trailing empty lines.");
        policy.put("stdout", "Compare normalized stdout content deterministically.");
        policy.put("stderr", "Compare normalized stderr content deterministically.");
        policy.put("exitCode", "Require exact exit-code equality after execution succeeds on both sides.");
        policy.put("emptyOutput",
                "Treat null as empty string; whitespace-only trailing differences normalize to empty output.");
        return policy;
    }

    static Map<String, Object> toRef() {
        return BuildTestRunnerService.reference(
                "parity-comparison-policy",
                "parity-comparison-policy-" + VERSION,
                toMap());
    }

    static String normalize(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String lf = value.replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = lf.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            lines[i] = stripTrailingHorizontalWhitespace(lines[i]);
        }
        int end = lines.length;
        while (end > 0 && lines[end - 1].isEmpty()) {
            end--;
        }
        if (end == 0) {
            return "";
        }
        StringBuilder normalized = new StringBuilder();
        for (int i = 0; i < end; i++) {
            if (i > 0) {
                normalized.append('\n');
            }
            normalized.append(lines[i]);
        }
        return normalized.toString();
    }

    static String normalizeLineEndingsOnly(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        return value.replace("\r\n", "\n").replace('\r', '\n');
    }

    static String stripTrailingWhitespaceOnly(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String lf = normalizeLineEndingsOnly(value);
        String[] lines = lf.split("\n", -1);
        StringBuilder normalized = new StringBuilder();
        for (int i = 0; i < lines.length; i++) {
            if (i > 0) {
                normalized.append('\n');
            }
            normalized.append(stripTrailingHorizontalWhitespace(lines[i]));
        }
        return normalized.toString();
    }

    private static String stripTrailingHorizontalWhitespace(String value) {
        int end = value.length();
        while (end > 0) {
            char ch = value.charAt(end - 1);
            if (ch == ' ' || ch == '\t') {
                end--;
                continue;
            }
            break;
        }
        return value.substring(0, end);
    }
}
