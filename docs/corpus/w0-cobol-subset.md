# W0 COBOL Subset Definition

## Goal
The W0 corpus is intentionally narrow and deterministic so that we can validate the end-to-end migration skeleton without adding runtime, SQL, or JCL complexity too early.

## Scope Boundaries

### In Scope for W0
- Standalone COBOL programs with one `PROGRAM-ID` and simple local scope.
- Input/output through working-storage and terminal-style `DISPLAY` output.
- Data definitions using numeric and display fields, including signed / packed numeric usage.
- Core instructions and statements:
  - `MOVE`
  - `ADD`, `SUBTRACT`, `MULTIPLY`, `DIVIDE`, `COMPUTE`
  - `IF`, `ELSE`, `EVALUATE`
  - `PERFORM` / `PERFORM UNTIL`
  - `CALL` only in a documented no-op shim pattern (single stub call allowed)
  - Paragraph navigation (`GO TO` only for synthetic demo compatibility, no deep branching)
- Minimal decimal handling in fixed-point `PIC S9(n)V99` and integer-like numeric fields.
- Straightforward control flow (single-level nesting) and non-concurrent execution.
- Reproducible expected output (deterministic golden master).

### Explicitly Out of Scope for W0
- CICS command blocks and transaction routing.
- VSAM/JES/JCL runtime orchestration.
- DB2 / SQL / file-level locking.
- `SORT`/`MERGE`, indexed/sequential file I/O, and advanced file section semantics.
- Exception-heavy runtime extensions and terminal-specific classes.
- Dynamic storage (`ALLOCATE/RELEASE`) and low-level system hooks.
- Multi-program linkages and copybook-heavy dependency graphs.
- Character / binary encoding edge cases beyond default EBCDIC-like and ASCII mapping assumptions.

## Program Archetypes Accepted in W0
1. **Control-flow arithmetic programs**
   - IF / EVALUATE + arithmetic branches.
2. **Batch style accumulators**
   - PERFORM loops and counters with deterministic totals.
3. **Validation programs**
   - Data shape validation with bounded branches and computed outputs.

## Golden Master Strategy (W0)
- For each selected program, define one canonical input fixture and one canonical output snapshot.
- Execute fixtures in a fixed environment and compare rendered logs/output lines exactly.
- Require deterministic ordering and stable formatting.
- Snapshot artifacts live adjacent to sample inputs in `corpus/synthetic/fixtures`.

## W0 Demo Candidate Criteria
A demo candidate must include at least:
- one control-flow construct (`IF`, `EVALUATE`, or `PERFORM UNTIL`), and
- at least one decimal or field-semantic operation (`PIC S9(.. )V..` arithmetic or scale-sensitive computation).

The first W0 candidate must not be a trivial arithmetic-only example.
