package com.c2c.w0.buildtest;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Maps the raw compile/run/comparison signals onto a pair of stable enums
 * used in the {@code BuildTestResult} envelope and in the Harness/Experience
 * events.
 * <p>
 * The classifier intentionally distinguishes:
 * <ul>
 *   <li>{@code divergence-known-w0-coverage-gap} — output differs from the
 *       Golden Master because the W0 generator does not (yet) translate the
 *       constructs the program needs (e.g. PERFORM, EVALUATE, COMPUTE). The
 *       classification carries the documented coverage gap so downstream
 *       evidence consumers do not panic.</li>
 *   <li>{@code divergence-unknown} — generator claims to support the
 *       constructs in this IR but stdout still diverges. This is the signal
 *       that should fail loudly in CI of a future wave once the generator
 *       grows DISPLAY/MOVE coverage past the W0 baseline.</li>
 * </ul>
 */
final class ResultClassifier {

    static final String STATUS_OK = "ok";
    static final String STATUS_COMPILE_FAILED = "compile-failed";
    static final String STATUS_RUN_FAILED = "run-failed";
    static final String STATUS_OUTPUT_DIVERGENCE = "output-divergence";
    static final String STATUS_MISSING_GOLDEN_MASTER = "missing-golden-master";
    static final String STATUS_SKIPPED = "skipped";

    static final String CLASS_MATCH = "match";
    static final String CLASS_DIV_KNOWN = "divergence-known-w0-coverage-gap";
    static final String CLASS_DIV_UNKNOWN = "divergence-unknown";
    static final String CLASS_COMPILE_ERROR = "compile-error";
    static final String CLASS_RUN_ERROR = "run-error";
    static final String CLASS_SKIPPED = "skipped-no-execution";
    static final String CLASS_MISSING_GOLDEN_MASTER = "missing-golden-master";

    private ResultClassifier() {
    }

    static Map<String, Object> compileFailure() {
        return classification(STATUS_COMPILE_FAILED, CLASS_COMPILE_ERROR,
                "Generated Java did not compile; see build.diagnostics for javac errors.");
    }

    static Map<String, Object> runFailure(String errorClass) {
        return classification(STATUS_RUN_FAILED, CLASS_RUN_ERROR,
                "Generated program failed to run: " + (errorClass == null ? "unknown" : errorClass));
    }

    static Map<String, Object> skipped(String reason) {
        return classification(STATUS_SKIPPED, CLASS_SKIPPED,
                "Execution skipped: " + (reason == null ? "skipExecution=true" : reason));
    }

    static Map<String, Object> missingGoldenMaster(String programId) {
        return classification(STATUS_MISSING_GOLDEN_MASTER, CLASS_MISSING_GOLDEN_MASTER,
                "No Golden Master fixture available for programId=" + programId);
    }

    static Map<String, Object> match() {
        return classification(STATUS_OK, CLASS_MATCH, "Generated stdout matched Golden Master.");
    }

    static Map<String, Object> divergence(boolean knownCoverageGap, String summary) {
        String classifier = knownCoverageGap ? CLASS_DIV_KNOWN : CLASS_DIV_UNKNOWN;
        return classification(STATUS_OUTPUT_DIVERGENCE, classifier, summary);
    }

    /**
     * Heuristic for whether an output divergence is explainable by the known
     * W0 coverage gap. The W0 generator only emits {@code System.out.print}
     * for {@code DISPLAY} statements with literal/known operands — it does
     * not translate {@code PERFORM}, {@code EVALUATE}, {@code IF},
     * {@code COMPUTE}, {@code ADD}, etc. When the generated program prints
     * nothing while the COBOL Golden Master prints a non-empty line, that
     * is the documented W0 baseline divergence and gets classified as known.
     */
    static boolean looksLikeKnownCoverageGap(String actual, String expected) {
        if (actual == null) {
            actual = "";
        }
        if (expected == null) {
            expected = "";
        }
        String normalisedActual = actual.replace("\r\n", "\n").trim();
        String normalisedExpected = expected.replace("\r\n", "\n").trim();
        if (normalisedExpected.isEmpty()) {
            return false;
        }
        // Empty actual against non-empty expected: classic W0 coverage gap.
        return normalisedActual.isEmpty();
    }

    static Map<String, Object> classification(String status, String classifier, String summary) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("status", status);
        map.put("classification", classifier);
        map.put("summary", summary);
        return map;
    }
}
