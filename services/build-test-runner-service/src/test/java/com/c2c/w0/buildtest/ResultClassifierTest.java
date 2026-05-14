package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ResultClassifierTest {

    @Test
    void compileFailureIsCompileError() {
        var result = ResultClassifier.compileFailure();
        assertEquals(ResultClassifier.STATUS_COMPILE_FAILED, result.get("status"));
        assertEquals(ResultClassifier.CLASS_COMPILE_ERROR, result.get("classification"));
    }

    @Test
    void matchClassification() {
        assertEquals(ResultClassifier.CLASS_MATCH,
                ResultClassifier.match().get("classification"));
    }

    @Test
    void divergenceClassificationDistinguishesKnownVsUnknown() {
        assertEquals(ResultClassifier.CLASS_DIV_KNOWN,
                ResultClassifier.divergence(true, "x").get("classification"));
        assertEquals(ResultClassifier.CLASS_DIV_UNKNOWN,
                ResultClassifier.divergence(false, "x").get("classification"));
    }

    @Test
    void trueGoldenMasterFailuresUseDedicatedClasses() {
        assertEquals(ResultClassifier.CLASS_TRUE_GM_REPRODUCTION_ERROR,
                ResultClassifier.trueGoldenMasterReproductionError("x").get("classification"));
        assertEquals(ResultClassifier.STATUS_GOLDEN_MASTER_REPRODUCTION_FAILED,
                ResultClassifier.trueGoldenMasterReproductionError("x").get("status"));
        assertEquals(ResultClassifier.CLASS_TRUE_GM_MISMATCH,
                ResultClassifier.trueGoldenMasterMismatch("x").get("classification"));
    }
}
