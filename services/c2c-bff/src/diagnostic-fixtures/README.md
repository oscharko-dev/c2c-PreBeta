# Diagnostic Fixtures

This directory is a quarantined, developer-only fixture subtree for `c2c-bff`.

Ownership:

- Owner: `c2c-bff`
- Runtime use: `run-store.ts` may materialize these fixtures only when
  `C2C_ENABLE_DIAGNOSTIC_FIXTURES=true`

Guardrails:

- These fixtures must never be presented as product results.
- Keep imports limited to diagnostic-fixture code paths.
- Shared corpus or golden-master changes must preserve the labelled
  `diagnostic-fixture` behavior and product-mode fail-closed semantics.

The repository-wide ownership map lives in
[`docs/governance/fixture-ownership.md`](../../../../docs/governance/fixture-ownership.md).
