# W0 COBOL Subset

The W0 subset is intentionally small. Parser, Semantic IR, generator tests, and
fixtures are the source of truth.

## Supported Shape

- single program;
- `IDENTIFICATION DIVISION`;
- `PROGRAM-ID`;
- limited `DATA DIVISION` working-storage declarations;
- limited `PROCEDURE DIVISION`;
- `DISPLAY`;
- simple `MOVE`;
- selected arithmetic covered by corpus fixtures;
- selected branch/control flow covered by corpus fixtures.

## Out of Scope

- copybooks;
- DB2;
- CICS;
- JCL;
- VSAM;
- file I/O beyond explicit blocked fixtures;
- multi-program call chains;
- broad paragraph semantics.

Unsupported input must be blocked honestly. It must not be converted into a
successful generated Java claim.

## Fixtures

Use these as executable references:

- `corpus/synthetic/programs/` for the shared synthetic COBOL source corpus
- `fixtures/semantic-ir/` for shared semantic-IR snapshots owned by target-Java
  generation and verification smoke coverage
- `fixtures/acceptance/` for the W0.2 acceptance-contract registry owned by the
  BFF and Orchestrator boundary
- `services/cobol-parser-service/src/test/`
- `services/target-java-generation-service/src/test/`

Shared fixture ownership and future-acceptance guardrails are documented in
[`docs/governance/fixture-ownership.md`](../governance/fixture-ownership.md).
