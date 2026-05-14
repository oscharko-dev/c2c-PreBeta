package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class AssumptionRegistryTest {

    @Test
    void recordsAssumptionsInOrderAndExposesSnapshot() {
        AssumptionRegistry registry = new AssumptionRegistry();
        registry.record("ASM-001", "stmt-1", AssumptionRegistry.Severity.INFO, "rounding mode HALF_EVEN");
        registry.record("ASM-002", "stmt-2", AssumptionRegistry.Severity.WARN, "ambiguous PIC truncation");
        List<AssumptionRegistry.Assumption> snapshot = registry.snapshot();
        assertEquals(2, snapshot.size());
        assertEquals("ASM-001", snapshot.get(0).irAssumptionId());
        assertEquals("ASM-002", snapshot.get(1).irAssumptionId());
    }

    @Test
    void snapshotIsImmutable() {
        AssumptionRegistry registry = new AssumptionRegistry();
        registry.record("ASM-1", "n", AssumptionRegistry.Severity.INFO, "x");
        List<AssumptionRegistry.Assumption> snapshot = registry.snapshot();
        assertThrows(UnsupportedOperationException.class,
                () -> snapshot.add(new AssumptionRegistry.Assumption(
                        "X", "n", AssumptionRegistry.Severity.INFO, "y")));
    }

    @Test
    void hasBlockersReflectsSeverity() {
        AssumptionRegistry registry = new AssumptionRegistry();
        registry.record("A", "n", AssumptionRegistry.Severity.INFO, "ok");
        assertFalse(registry.hasBlockers());
        registry.record("B", "n", AssumptionRegistry.Severity.BLOCKER, "blocked");
        assertTrue(registry.hasBlockers());
    }

    @Test
    void rejectsBlankAssumptionId() {
        assertThrows(IllegalArgumentException.class,
                () -> new AssumptionRegistry.Assumption(" ", "n", AssumptionRegistry.Severity.INFO, "x"));
    }

    @Test
    void rejectsNullFields() {
        assertThrows(NullPointerException.class,
                () -> new AssumptionRegistry.Assumption(null, "n", AssumptionRegistry.Severity.INFO, "x"));
        assertThrows(NullPointerException.class,
                () -> new AssumptionRegistry.Assumption("A", null, AssumptionRegistry.Severity.INFO, "x"));
        assertThrows(NullPointerException.class,
                () -> new AssumptionRegistry.Assumption("A", "n", null, "x"));
        assertThrows(NullPointerException.class,
                () -> new AssumptionRegistry.Assumption("A", "n", AssumptionRegistry.Severity.INFO, null));
    }
}
