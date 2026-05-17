# W0.2 Acceptance Fixtures & Oracle Contract

This document defines the W0.2 acceptance test surface for the c2c agentic
COBOL → Java transformation loop, owned by Issue #174.

It is the single source of truth for two questions:

1. **What does W0.2 prove?** A small but real user-pasteable COBOL program
   flows through the agentic workflow end-to-end, the generated Java
   compiles, runs, and matches an oracle output — not a hardcoded shortcut.
2. **What is *not* accepted at W0.2?** Source containing constructs outside
   the supported subset is blocked honestly with a construct-level
   diagnostic, not silently transformed into misleading Java.

## Supported W0.2 COBOL subset

W0.2 accepts the verbs and structural constructs the parser at
[services/cobol-parser-service](../../services/cobol-parser-service/src/main/java/com/c2c/w0/parser/CobolParser.java)
recognises. The closed set is mirrored in
[schemas/acceptance-fixture-v0.json](../../schemas/acceptance-fixture-v0.json)
as `$defs.cobolConstructName`.

| Group              | Constructs                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| Division/section   | `IDENTIFICATION DIVISION`, `DATA DIVISION` + `WORKING-STORAGE SECTION`, `PROCEDURE DIVISION` |
| Data declarations  | Numeric `PIC 9..` / `PIC S9..V9..`, alphanumeric `PIC X(..)`, `OCCURS n TIMES`, scalar `VALUE` literals |
| Procedure verbs    | `MOVE`, `DISPLAY`, `IF`/`ELSE`/`END-IF`, `EVALUATE`/`WHEN`/`END-EVALUATE`, `PERFORM UNTIL`/`END-PERFORM`, `PERFORM VARYING ... FROM ... BY ... UNTIL`/`END-PERFORM`, `COMPUTE`, `ADD`, `SUBTRACT`, `MULTIPLY`, `DIVIDE`, paragraph labels |
| Termination        | `STOP RUN`                                                                 |
| Calls              | `CALL` is accepted only as a documented no-op shim                         |

Anything outside that closed set is rejected by the parser with one of
these diagnostic codes:

| Diagnostic code                 | Trigger                                              |
| ------------------------------- | ---------------------------------------------------- |
| `unsupported-feature`           | `EXEC`, `FILE SECTION`, `SELECT`, `FD`, `READ`, `WRITE`, `OPEN`, `CLOSE`, `SORT`, `MERGE` |
| `unsupported-data-declaration`  | Malformed DATA-DIVISION entry that does not match `^\d{2}\s+NAME ...` |
| `unsupported-statement`         | Unrecognised PROCEDURE-DIVISION statement            |
| `unterminated-block`            | `IF` / `EVALUATE` / `PERFORM` opened without matching `END-*` |
| `unmatched-block-end`           | `END-*` with no matching opener                      |
| `mismatched-block-end`          | `END-*` does not match the most recent open block    |

The orchestrator turns any error-severity diagnostic into a
`finalClassification=blocked` run with `failureCode=unsupported_cobol`
(see [docs/contracts/orchestrator-w02-workflow.md](../contracts/orchestrator-w02-workflow.md)).

## Acceptance fixture / oracle contract

The acceptance contract is declared in
[schemas/acceptance-fixture-v0.json](../../schemas/acceptance-fixture-v0.json)
and instantiated for the shipping set in
[fixtures/acceptance/index.json](../../fixtures/acceptance/index.json).

Each entry carries the fields Issue #174 requires:

| Field                            | Purpose                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                  | Top-level registry schema version. Currently `v0`.                                                                  |
| `fixtureId`                      | Stable, uppercase identifier, independent of the COBOL `PROGRAM-ID`.                                                 |
| `title` / `description`          | Human-readable review labels. `title` is required; `description` is optional.                                        |
| `sourceCobolArtifactRef`         | Content-addressed reference (`uri`, `path`, `sha256`, `byteSize`) to the COBOL source.                               |
| `expectedOutputArtifactRef`      | Content-addressed reference to oracle output. Required when `oracleGenerationMode == 'static-fixture'`; omitted for blocked fixtures and allowed for `cobol-runtime` audit parity. |
| `oracleGenerationMode`           | `cobol-runtime` \| `static-fixture` \| `user-provided`. Empty for blocked fixtures.                                 |
| `supportedSubset[]`              | W0.2 constructs the fixture is expected to exercise (closed enum, see above).                                        |
| `unsupportedConstructs[]`        | Constructs the parser MUST detect, each pinned to a diagnostic code and optional `line` / `message`.                |
| `targetLanguage`                 | Fixed at `"java"` for W0.2.                                                                                          |
| `expectedFinalClassification`    | `success` \| `blocked` — must equal the run-contract value the orchestrator reaches.                                |
| `expectedFailureCode`            | One of the W0.2 run-contract failure codes. Required when classification is `blocked`.                              |
| `modes`                          | `file-backed` and/or `paste-mode`. Shipping fixtures declare both.                                                   |
| `rationale`                      | Why this fixture is in the acceptance set.                                                                           |

Success fixtures must declare `oracleGenerationMode` and must not declare
`expectedFailureCode`. Blocked fixtures must declare a non-empty
`unsupportedConstructs[]` list and the expected blocked failure code.

The loader at [services/c2c-bff/src/acceptance-fixtures.ts](../../services/c2c-bff/src/acceptance-fixtures.ts)
re-validates every artifact reference at boot, recomputing the SHA-256 of the
on-disk file and comparing against `sha256` / `byteSize`. Drift between the
registry and the corpus surfaces at startup, not at run time.

## Submission modes

Both modes go through the same orchestrator workflow. They differ only in
how the source enters the BFF.

### File-backed mode

A test harness loads
[fixtures/acceptance/index.json](../../fixtures/acceptance/index.json), looks
up a fixture by `fixtureId`, reads the COBOL source from the declared
`sourceCobolArtifactRef.path`, and POSTs it to
`POST /api/v0/transform` as `sourceText`. When the fixture declares an
`expectedOutputArtifactRef` and `oracleGenerationMode != 'cobol-runtime'`,
the harness reads the oracle bytes from the declared path and includes
them as `expectedOutput`.

### Paste mode

The user pastes COBOL source into Studio. The Studio submits via
`POST /api/v0/transform` with optional `expectedOutput` and `oracleInput`
fields. Empty strings are omitted before the BFF forwards the request, so
blank oracle controls preserve the deterministic `cobol-runtime` path.
When no `expectedOutput` is provided and the orchestrator has a working
GnuCOBOL toolchain, the oracle is derived from the source via the existing
`cobol-runtime` path (Issue #94). When no oracle is available, the
build/test runner reports the limitation in the evidence pack instead of
silently passing.

The orchestrator handles both modes identically: it parses, lifts to
Semantic IR, invokes the Transformation Agent, builds, executes, and
compares against the oracle. A run that cannot satisfy every stage is
either `blocked` (parser refused the input) or `failed` (a later stage
diverged) with the matching run-contract failure code.

## Shipping fixtures

| fixtureId            | classification | failureCode           | rationale                                                                                                    |
| -------------------- | -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `HELLOW02`           | `success`      | —                     | Canonical positive acceptance: `WORKING-STORAGE` numerics, `PERFORM VARYING`, `DISPLAY`, and `ADD` into an accumulator. Oracle output produced by `cobc -x -free hello-w02.cbl && ./hello-w02`. |
| `FILEIO-UNSUPPORTED` | `blocked`      | `unsupported_cobol`   | Negative acceptance: declares `FILE SECTION`, `FD`, `OPEN`, `READ`, `CLOSE`. Parser must emit five `unsupported-feature` diagnostics. The run must never produce Java. |

The positive fixture is the smallest program in the acceptance set that
still exercises every load-bearing W0.2 capability: it touches
working-storage, a bounded loop, numeric arithmetic, and DISPLAY in one
piece. The negative fixture is the smallest program that proves the
orchestrator does not silently swallow unsupported constructs.

## When a paste-mode submission is outside the W0.2 subset

If a user pastes COBOL containing any construct the parser flags as
unsupported, the run terminates at `STATE_RUN_BLOCKED` with
`failureCode=unsupported_cobol`. The diagnostics are bundled into the
evidence pack so the user can see *which* construct blocked the run, on
which line. This is required acceptance behaviour: the system must not
ship misleading Java for unsupported input.

If the parser accepts the source but a later stage cannot complete
(e.g. semantic-IR lowering, Java generation, compile, runtime, or oracle
match) the run terminates with the corresponding non-blocked failure code
(`parse_failed`, `semantic_ir_failed`, `java_generation_failed`,
`java_compile_failed`, `java_runtime_failed`, `oracle_mismatch`). Those
failure codes are explicitly not the responsibility of this fixture
contract; they are covered by Issues #170 and #171.

## Adding a new acceptance fixture

1. Add the COBOL source under `corpus/synthetic/programs/`.
2. If the fixture is a `success` fixture and an oracle output is bundled,
   add the expected output under `corpus/synthetic/fixtures/`.
3. Compute the source and (where relevant) expected-output sha256/byteSize:
   ```sh
   wc -c corpus/synthetic/programs/<name>.cbl
   shasum -a 256 corpus/synthetic/programs/<name>.cbl
   ```
4. Append the entry to `fixtures/acceptance/index.json`, conforming to
   `schemas/acceptance-fixture-v0.json`.
5. Run the BFF tests (`npm test` in `services/c2c-bff/`) and orchestrator
   tests (`pytest tests/test_acceptance_fixture_contract.py` in
   `services/orchestrator-service/`) — both gate on the on-disk hash.
6. For a `blocked` fixture, also extend
   [CobolParserTest](../../services/cobol-parser-service/src/test/java/com/c2c/w0/parser/CobolParserTest.java)
   with an assertion that the parser actually emits the declared
   diagnostic code for the declared construct.
