package com.c2c.target.java.runtime;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration tests that hand-translate selected W0 COBOL corpus programs
 * into runtime calls and assert against the corpus golden-master fixtures
 * in {@code corpus/synthetic/fixtures/}.
 * <p>
 * The translation here is the same shape that the future W0 Java generator
 * is expected to emit: one runtime field per data item, one runtime call
 * per arithmetic / control statement, no language tricks beyond what the
 * IR can describe. This grounds the runtime against actual W0 samples
 * (Issue #11 acceptance: "supports the selected W0 S0/S1 samples without
 * hardcoding sample-specific behavior").
 */
class W0CorpusIntegrationTest {

    /**
     * BATCH01 — corpus/synthetic/programs/decimal-batch-aggregator.cbl
     * <p>
     * Golden master: corpus/synthetic/fixtures/decimal-batch-aggregator-output.txt
     * <pre>
     * LINE=1TOTAL=36.25
     * LINE=2TOTAL=72.50
     * LINE=3TOTAL=108.75
     * LINE=4TOTAL=145.00
     * LINE=5TOTAL=181.25
     * LINE=6TOTAL=217.50
     * BATCH-TOTAL=761.25
     * </pre>
     * Exercises: PERFORM UNTIL loop, COMPUTE with mixed scales,
     * ADD into a wider accumulator, signed PIC S9(8)V99.
     */
    @Test
    void batch01ReproducesGoldenMaster() {
        // 01 WS-TOTAL-LINE.
        //    05 WS-ROW          PIC 99 VALUE 1.
        //    05 WS-ROW-LIMIT    PIC 99 VALUE 6.
        //    05 WS-ACCUMULATOR  PIC S9(8)V99 VALUE 0.
        //    05 WS-UNIT-COST    PIC S9(4)V99 VALUE 7.25.
        //    05 WS-UNITS        PIC 99 VALUE 5.
        //    05 WS-LINE-TOTAL   PIC S9(8)V99 VALUE 0.
        CobolField wsRow         = new CobolField("WS-ROW",         "ir-batch01-row",        PictureSpec.parse("99"));
        CobolField wsRowLimit    = new CobolField("WS-ROW-LIMIT",   "ir-batch01-row-limit",  PictureSpec.parse("99"));
        CobolField wsAccumulator = new CobolField("WS-ACCUMULATOR", "ir-batch01-accumulator", PictureSpec.parse("S9(8)V99"));
        CobolField wsUnitCost    = new CobolField("WS-UNIT-COST",   "ir-batch01-unit-cost",  PictureSpec.parse("S9(4)V99"));
        CobolField wsUnits       = new CobolField("WS-UNITS",       "ir-batch01-units",      PictureSpec.parse("99"));
        CobolField wsLineTotal   = new CobolField("WS-LINE-TOTAL",  "ir-batch01-line-total", PictureSpec.parse("S9(8)V99"));

        wsRow.setNumericValue(CobolDecimal.of(1L, 0, false));
        wsRowLimit.setNumericValue(CobolDecimal.of(6L, 0, false));
        wsUnitCost.setNumericValue(CobolDecimal.of("7.25", 2, true));
        wsUnits.setNumericValue(CobolDecimal.of(5L, 0, false));

        // PERFORM UNTIL WS-ROW > WS-ROW-LIMIT
        //   COMPUTE WS-LINE-TOTAL = WS-ROW * WS-UNITS * WS-UNIT-COST
        //   ADD WS-LINE-TOTAL TO WS-ACCUMULATOR
        //   ADD 1 TO WS-ROW
        // END-PERFORM
        BigDecimal[] expectedLineTotals = {
                new BigDecimal("36.25"),
                new BigDecimal("72.50"),
                new BigDecimal("108.75"),
                new BigDecimal("145.00"),
                new BigDecimal("181.25"),
                new BigDecimal("217.50"),
        };
        int safetyLimit = 100;
        int iteration = 0;
        while (!ConditionStatus.greaterThan(wsRow.numericValue(), wsRowLimit.numericValue())) {
            CobolDecimal lineTotal = wsRow.numericValue()
                    .multiply(wsUnits.numericValue())
                    .multiply(wsUnitCost.numericValue());
            wsLineTotal.setNumericValue(lineTotal);

            assertTrue(iteration < expectedLineTotals.length,
                    "PERFORM UNTIL did not terminate within expected iterations");
            assertEquals(expectedLineTotals[iteration], wsLineTotal.numericValue().value(),
                    "Line total at iteration " + (iteration + 1));

            wsAccumulator.setNumericValue(wsAccumulator.numericValue().add(wsLineTotal.numericValue()));
            wsRow.setNumericValue(wsRow.numericValue().add(CobolDecimal.of(1L, 0, false)));

            iteration++;
            if (iteration > safetyLimit) {
                fail("Loop runaway");
            }
        }

        assertEquals(6, iteration, "loop must iterate exactly 6 times");
        // BATCH-TOTAL=761.25 from golden master.
        assertEquals(new BigDecimal("761.25"), wsAccumulator.numericValue().value());
        // Accumulator must keep its declared scale across additions.
        assertEquals(2, wsAccumulator.numericValue().scale());
    }

    /**
     * BRNCH01 — corpus/synthetic/programs/branch-account-guard.cbl
     * <p>
     * Golden master: corpus/synthetic/fixtures/branch-account-guard-output.txt
     * <pre>
     * APPROVED-COUNT=2
     * REJECTED-COUNT=2
     * </pre>
     * Exercises: alphanumeric MOVE, EVALUATE / WHEN OTHER, IF with
     * relational comparison via the runtime ConditionStatus helpers,
     * unsigned counter increments.
     */
    @Test
    void brnch01ReproducesGoldenMaster() {
        // OCCURS 4 TIMES with WS-STATUS PIC X(1) and WS-AMOUNT PIC S9(5)V99.
        record Account(CobolField status, CobolField amount) {}
        List<Account> accounts = List.of(
                new Account(
                        new CobolField("WS-STATUS-1", "ir-brnch01-status-1", PictureSpec.parse("X(1)")),
                        new CobolField("WS-AMOUNT-1", "ir-brnch01-amount-1", PictureSpec.parse("S9(5)V99"))),
                new Account(
                        new CobolField("WS-STATUS-2", "ir-brnch01-status-2", PictureSpec.parse("X(1)")),
                        new CobolField("WS-AMOUNT-2", "ir-brnch01-amount-2", PictureSpec.parse("S9(5)V99"))),
                new Account(
                        new CobolField("WS-STATUS-3", "ir-brnch01-status-3", PictureSpec.parse("X(1)")),
                        new CobolField("WS-AMOUNT-3", "ir-brnch01-amount-3", PictureSpec.parse("S9(5)V99"))),
                new Account(
                        new CobolField("WS-STATUS-4", "ir-brnch01-status-4", PictureSpec.parse("X(1)")),
                        new CobolField("WS-AMOUNT-4", "ir-brnch01-amount-4", PictureSpec.parse("S9(5)V99")))
        );

        // MOVE "A"|"R" TO WS-STATUS(i) and 130.00|45.10|200.00|70.00 to WS-AMOUNT(i).
        accounts.get(0).status().moveLiteral("A");
        accounts.get(0).amount().setNumericValue(CobolDecimal.of("130.00", 2, true));
        accounts.get(1).status().moveLiteral("R");
        accounts.get(1).amount().setNumericValue(CobolDecimal.of("45.10", 2, true));
        accounts.get(2).status().moveLiteral("A");
        accounts.get(2).amount().setNumericValue(CobolDecimal.of("200.00", 2, true));
        accounts.get(3).status().moveLiteral("R");
        accounts.get(3).amount().setNumericValue(CobolDecimal.of("70.00", 2, true));

        CobolField wsApproved = new CobolField("WS-APPROVED", "ir-brnch01-approved", PictureSpec.parse("9"));
        CobolField wsRejected = new CobolField("WS-REJECTED", "ir-brnch01-rejected", PictureSpec.parse("9"));
        CobolDecimal one = CobolDecimal.of(1L, 0, false);

        // PERFORM VARYING WS-INDEX FROM 1 BY 1 UNTIL WS-INDEX > 4
        //   EVALUATE WS-STATUS (WS-INDEX) WHEN "A" ... WHEN OTHER ...
        for (Account account : accounts) {
            String statusText = account.status().displayValue();
            if ("A".equals(statusText)) {
                wsApproved.setNumericValue(wsApproved.numericValue().add(one));
            } else {
                // WHEN OTHER
                wsRejected.setNumericValue(wsRejected.numericValue().add(one));
            }
        }

        // IF WS-APPROVED >= WS-REJECTED ...
        boolean approvedWins = ConditionStatus.greaterOrEqual(
                wsApproved.numericValue(), wsRejected.numericValue());

        assertTrue(approvedWins, "approved >= rejected branch must be taken (2 == 2)");
        assertEquals(new BigDecimal("2"), wsApproved.numericValue().value());
        assertEquals(new BigDecimal("2"), wsRejected.numericValue().value());
    }

    /**
     * Sanity check that the assumption registry can record a runtime-emitted
     * simplification that a generator would attach to an IR assumption. This
     * mirrors the contract requirement that runtime simplifications must be
     * surfaced, not silently applied.
     */
    @Test
    void runtimeAssumptionRecordedDuringExecution() {
        AssumptionRegistry registry = new AssumptionRegistry();
        // BATCH01 uses HALF_EVEN rounding for COMPUTE. A generator MAY
        // emit this once per program rather than per statement.
        registry.record(
                "ASM-W0-ROUND-HALF-EVEN",
                "ir-batch01-row",
                AssumptionRegistry.Severity.INFO,
                "COMPUTE rounds with HALF_EVEN; matches W0 runtime default");
        assertEquals(1, registry.size());
        assertFalse(registry.hasBlockers());
    }
}
