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
}
