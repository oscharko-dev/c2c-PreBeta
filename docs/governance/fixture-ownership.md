# Fixture and Golden-Master Ownership

Issue [#330](https://github.com/oscharko-dev/c2c-PreBeta/issues/330) defines
the ownership boundary for shared fixture directories, synthetic corpus assets,
golden-master registries, and developer-only diagnostic fixtures after the
repository-topology migration work.

## Ownership Rules

1. Keep shared fixtures in their current paths unless a separate issue proves
   that a move is required and updates every affected reference in the same PR.
2. `fixtures/acceptance/` is the acceptance-contract surface for W0.2 and is
   owned by the BFF and Orchestrator boundary.
3. `fixtures/golden-master/` is the reference-program registry consumed by the
   BFF sample registry and the build-test runner.
4. `fixtures/semantic-ir/` is the shared semantic-IR fixture set used by target
   Java generation and verification smoke coverage.
5. `corpus/synthetic/programs/` and `corpus/synthetic/fixtures/` are the shared
   synthetic COBOL source corpus and deterministic oracle/output store.
6. `services/c2c-bff/src/diagnostic-fixtures/` is a BFF-local,
   developer-only diagnostic-fixture subtree. It must remain quarantined from
   product-mode success paths.
7. Service-local test helpers that live next to a test suite stay owned by that
   suite until a separate issue explicitly promotes them into `fixtures/` or
   `corpus/`.
8. No customer, private, or externally sourced data may be added to shared
   fixtures or corpus paths.

These rules preserve existing deterministic-first behavior. This issue does not
change fixture semantics, oracle behavior, or release-gate expectations.

## Shared Fixture Map

| Path | Owner | Purpose |
| --- | --- | --- |
| `fixtures/acceptance/` | `c2c-bff` + `orchestrator-service` | Canonical W0.2 acceptance fixture registry. The BFF loads it from `fixtures/acceptance/index.json`; the Orchestrator tests and W0.2 release gate rely on the same contract and artifact hashes. |
| `fixtures/golden-master/` | `build-test-runner-service` + `c2c-bff` | Reference-program registry used to classify generated-Java output against expected oracle behavior and to surface runnable samples through the BFF. |
| `fixtures/semantic-ir/` | `target-java-generation-service` + verification tests | Shared semantic-IR snapshots used by generator tests and build/test smoke coverage. These fixtures pin the IR shape consumed by downstream deterministic services. |
| `corpus/synthetic/programs/` | semantics + target-Java + verification surfaces | Shared synthetic COBOL source corpus used by parser, semantic IR, generator, build/test, release-gate, and Studio/BFF workflow coverage. |
| `corpus/synthetic/fixtures/` | verification surfaces | Deterministic expected-output artifacts for the synthetic corpus and golden-master registry. |
| `corpus/synthetic/generator/` | `target-java-generation-service` | Generator requirements and conventions for synthetic corpus maintenance. |
| `corpus/public/` | corpus governance | Placeholder area for future legally approved public samples. It remains non-executable until a separate review authorizes real content. |
| `services/c2c-bff/src/diagnostic-fixtures/` | `c2c-bff` | Developer-only diagnostic-fixture material used only when `C2C_ENABLE_DIAGNOSTIC_FIXTURES=true`. These fixtures must never be presented as product results. |

## Service-Local Fixture Helpers

The repository also contains local helpers inside service and app test suites.
These stay local to the owning suite and are not shared fixture directories:

- `services/*/src/test/` and `services/*/tests/`
- `apps/c2c-studio/tests/`
- temporary fixture factories created inside test files

Keep these helpers near the tests that own them unless more than one component
needs the same artifact. Only then should a separate issue promote them into a
shared fixture or corpus path.

## Guardrails for Future Acceptance Fixtures

When adding or changing a W0.2 acceptance fixture:

1. Register it in `fixtures/acceptance/index.json`.
2. Keep it compatible with `schemas/acceptance-fixture-v0.json`.
3. Point artifact references at checked-in repository paths and keep the
   declared hash and byte-size fields correct.
4. Preserve the dual-surface contract: shipping acceptance fixtures must keep
   `file-backed` and `paste-mode` aligned unless a separate issue documents a
   justified exception.
5. Do not reformat, regenerate, or replace golden-master outputs as incidental
   housekeeping. Any intentional oracle change needs a separate verification
   reason and updated evidence.
6. Update release gates, service tests, Studio/BFF references, and docs in the
   same PR if a fixture path or registry reference changes.
7. Keep the corpus synthetic and project-owned. Do not introduce customer or
   externally sourced source code, outputs, or diagnostic payloads.
