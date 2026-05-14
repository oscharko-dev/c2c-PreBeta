package com.c2c.target.java.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Records open semantic assumptions that the generator chose to surface at
 * runtime instead of resolving statically. The contract requires that every
 * generated runtime simplification be recorded here at construction so audits
 * can reconcile generated Java behavior against the IR's
 * {@code assumptions[]} array.
 * <p>
 * The registry is append-only. Generated code never clears it; the host
 * application reads and reports it (for example, alongside golden-master
 * comparison output).
 */
public final class AssumptionRegistry {

    /** Severity scale matched to the IR assumption levels. */
    public enum Severity { INFO, WARN, BLOCKER }

    public record Assumption(String irAssumptionId, String irNodeId,
                             Severity severity, String description) {
        public Assumption {
            Objects.requireNonNull(irAssumptionId, "irAssumptionId");
            Objects.requireNonNull(irNodeId, "irNodeId");
            Objects.requireNonNull(severity, "severity");
            Objects.requireNonNull(description, "description");
            if (irAssumptionId.isBlank()) {
                throw new IllegalArgumentException("irAssumptionId must not be blank");
            }
        }
    }

    private final List<Assumption> entries = new ArrayList<>();

    public synchronized void record(Assumption assumption) {
        Objects.requireNonNull(assumption, "assumption");
        entries.add(assumption);
    }

    public synchronized void record(String irAssumptionId, String irNodeId,
                                    Severity severity, String description) {
        record(new Assumption(irAssumptionId, irNodeId, severity, description));
    }

    public synchronized List<Assumption> snapshot() {
        return Collections.unmodifiableList(new ArrayList<>(entries));
    }

    public synchronized boolean hasBlockers() {
        for (Assumption a : entries) {
            if (a.severity() == Severity.BLOCKER) {
                return true;
            }
        }
        return false;
    }

    public synchronized int size() {
        return entries.size();
    }
}
