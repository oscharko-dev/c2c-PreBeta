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
  - Paragraph navigation (`GO TO` only for synthetic reference-run compatibility, no deep branching)
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

## W0 Reference Run Candidate Criteria
A reference-run candidate must include at least:
- one control-flow construct (`IF`, `EVALUATE`, or `PERFORM UNTIL`), and
- at least one decimal or field-semantic operation (`PIC S9(.. )V..` arithmetic or scale-sensitive computation).

The first W0 candidate must not be a trivial arithmetic-only example.

## Reference-Program Support Contract (Issue #94)

Reference programs surfaced to the c2c-ui are registered in
[`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json).
Each entry carries an explicit support contract so the UI cannot present an
unsupported program as runnable:

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `programId` | always | Stable identifier (matches `PROGRAM-ID`). |
| `title` | always | Human-readable label rendered in the reference loader. |
| `cobolSource` | always | Repo-relative path to the COBOL source. |
| `expectedOutputPath` | always | Repo-relative path to the expected stdout. |
| `classification` | always | `true` (recompiled with GnuCOBOL) or `synthetic` (curated fixture). |
| `knownDivergenceAtW0` | always | Flag for documented W0 coverage gaps. |
| `supportedInProductMode` | always | If `true`, the UI may load and run this program through `POST /api/v0/transform`. If `false`, the UI must show it as unavailable and Start must be blocked. |
| `w0Subset` | when supported | Non-empty list of W0 verbs the program exercises. |
| `oracleMode` | when supported | Either `cobol-runtime` (recompile + `cobcrun` via build-test-runner) or `synthetic-fixture` (compare against the curated expected output). |
| `knownLimitations` | always | Free-form notes; required content if `supportedInProductMode` is `false`. |
| `rationale` | always | How the expected output was produced. |

### Behavioral contract

- The UI may list only `supportedInProductMode: true` programs as runnable. Unsupported entries appear under an `Unavailable` group and cannot be selected.
- Loading a runnable reference program inserts its COBOL source into the editable left pane. Pressing Start sends that source through `POST /api/v0/transform` exactly like pasted source — there is no shortcut path keyed by `programId`.
- The BFF refuses with `400` if a `POST /api/v0/transform` request resolves to a registered reference whose `supportedInProductMode` is `false`. This is a server-side safety net for the UI rule.
- Golden Master fixtures may be used as additional evidence by the build-test runner, but the product path prefers the executable COBOL oracle (`oracleMode: cobol-runtime`) where available.

The four shipped W0 reference programs (`BRNCH01`, `ARITH01`, `CTRLDEC01`, `BATCH01`) are all `supportedInProductMode: true`.
