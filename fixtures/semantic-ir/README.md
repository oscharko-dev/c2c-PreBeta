# Semantic-IR Fixtures

This directory contains shared semantic-IR snapshots consumed by
`target-java-generation-service` tests and verification smoke coverage.

Ownership:

- Primary owner: `target-java-generation-service`
- Downstream consumers: verification smoke tests and other deterministic
  services that need pinned IR input

Guardrails:

- Keep fixtures stable unless a separate issue intentionally changes semantic-IR
  behavior.
- Do not treat these files as a general-purpose scratch area for test-only
  helpers; local helpers should remain next to the owning test suite.
- If a fixture path changes, update every affected generator/build-test
  reference in the same PR.

The repository-wide ownership map lives in
[`docs/governance/fixture-ownership.md`](../../docs/governance/fixture-ownership.md).
