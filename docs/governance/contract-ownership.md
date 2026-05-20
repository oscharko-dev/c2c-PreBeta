# Contract and Schema Ownership

Issue [#328](https://github.com/oscharko-dev/c2c-PreBeta/issues/328) defines
the ownership boundary for OpenAPI files, shared JSON schemas, and service-local
schema folders after the repository-topology migration work.

## Ownership Rules

1. `config/service-catalog.json` is the machine-readable ownership map for
   OpenAPI files and shared JSON schemas.
2. Every product OpenAPI file under `services/` must be declared by exactly one
   owning component through that component's `openapi` field.
3. Every shared schema under the repo-level `schemas/` directory must be
   declared by exactly one owning component through that component's `schemas`
   field.
4. Service-local schemas under `services/<component>/schemas/` stay local to
   that component until a separate issue explicitly promotes them to a shared
   contract.
5. Contract path moves, renames, or ownership changes must update the service
   catalog and any touched docs in the same PR. Do not silently replace or
   rename a contract version as part of housekeeping work.

These rules preserve the existing Studio/BFF compatibility policy in
[ADR 0006](../adr/0006-studio-bff-contract-versioning.md). This issue does not
change contract behavior or version semantics.

## OpenAPI Ownership

| OpenAPI file | Owning component | Owner area |
| --- | --- | --- |
| `services/c2c-bff/openapi.yaml` | `c2c-bff` | `bff` |
| `services/orchestrator-service/openapi.yaml` | `orchestrator-service` | `orchestration` |
| `services/target-java-generation-service/openapi.yaml` | `target-java-generation-service` | `target-java` |
| `services/build-test-runner-service/openapi.yaml` | `build-test-runner-service` | `verification` |
| `services/evidence-service/openapi.yaml` | `evidence-service` | `evidence` |

## Shared Schema Ownership

| Owning component | Shared schemas |
| --- | --- |
| `c2c-bff` | `schemas/acceptance-fixture-v0.json`, `schemas/diagnostic-v0.json`, `schemas/format-java-request-v0.json`, `schemas/format-java-response-v0.json`, `schemas/generated-traceability-v0.json`, `schemas/java-region-classification-v0.json`, `schemas/run-summary-v0.json` |
| `orchestrator-service` | `schemas/agent-invocation-request-v0.json`, `schemas/agent-invocation-response-v0.json`, `schemas/agent-repair-decision-v0.json`, `schemas/agent-repair-input-v0.json`, `schemas/parity-run-v0.json`, `schemas/parity-execution-result-v0.json`, `schemas/parity-build-result-v0.json`, `schemas/parity-comparison-result-v0.json`, `schemas/repair-diagnosis-v0.json`, `schemas/patch-proposal-v0.json` |
| `semantic-ir-service` | `schemas/semantic-ir-v0.json` |
| `build-test-runner-service` | `schemas/build-test-result-v0.json` |
| `evidence-service` | `schemas/evidence-pack-manifest-v0.json` |
| `agentic-harness-core` | `schemas/harness-event-envelope-v0.json` |
| `experience-learning-service` | `schemas/agent-trajectory-ledger-v0.json`, `schemas/editor-telemetry-event-v0.json`, `schemas/experience-event-v0.json`, `schemas/learning-artifact-registry-v0.json` |
| `model-gateway-service` | `schemas/model-gateway-capabilities-v0.json`, `schemas/model-invocation-ledger-v0.json`, `schemas/model-policy-skipped-v0.json` |

## Service-Local Schemas

The only current service-local schema folder is
`services/agentic-harness-core/schemas/`:

- `services/agentic-harness-core/schemas/capability-catalog.schema.json`
- `services/agentic-harness-core/schemas/mcp-server-registry.schema.json`
- `services/agentic-harness-core/schemas/tool-registry.schema.json`

These files remain local implementation schemas because they are not consumed
outside the harness service boundary today.
