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

## First Supported Trust Slice

[ADR 0009](../adr/0009-developer-trust-parity-and-repair-contract.md) defines
the first supported Developer Trust workflow as a controlled trust case over
this subset. The first supported slice is:

- one repository-owned COBOL source file from the curated corpus;
- one repository-owned, versioned trust-case input fixture;
- one fixture-backed reference output or equivalent controlled reference
  artifact for the same input;
- one generated Java candidate built and executed through the controlled
  product pipeline.

Studio and downstream APIs must label the source/reference side honestly as
`Reference mode: curated fixture`. This first slice does not claim live
execution of arbitrary customer COBOL.

## Out of Scope

- copybooks;
- DB2;
- CICS;
- JCL;
- VSAM;
- file I/O beyond explicit blocked fixtures;
- multi-program call chains;
- broad paragraph semantics.

The first trust workflow also excludes:

- arbitrary customer-supplied runtime environments;
- live mainframe execution presented as the default reference path;
- unsupported runtime dependencies hidden behind fixture-backed results;
- automatic parity claims for generated Java that was not built, executed, and
  compared deterministically.

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
