# ADR 0008: Repository Topology and Service Taxonomy

**Date:** 2026-05-20
**Status:** Accepted

## Context

Issue [#322](https://github.com/oscharko-dev/c2c-PreBeta/issues/322) defines the repository-topology decision before any large service move begins. The current `services/` tree mixes two patterns:

- product services live directly under `services/*`;
- W0 baseline/reference services and the current Model Gateway live under language buckets such as `services/go/*`, `services/java/*`, `services/python/*`, and `services/typescript/*`.

That layout reflects repository history, not the architecture we want contributors to read. This ADR is documentation and governance only. It does not authorize service moves, runtime changes, or product behavior changes.

Epic [#321](https://github.com/oscharko-dev/c2c-PreBeta/issues/321) requires a durable rule that future services, scripts, workflows, docs, and gates can follow without guessing.

## Options Considered

### Option A - Service/domain-first

Place every product service directly under `services/<service-id>`, and treat language as implementation detail.

Pros:

- service ownership is obvious from the path;
- release gates, docs, and scripts can point to one service name;
- product navigation matches the architecture.

Cons:

- W0 baseline/reference implementations need a separate rule so they do not look like product services;
- the current language buckets would need a migration plan.

### Option B - Language-first

Keep `services/go/*`, `services/java/*`, `services/python/*`, and `services/typescript/*` as the primary grouping.

Pros:

- toolchain grouping is convenient for build and packaging tasks;
- existing W0 baselines already fit this shape.

Cons:

- the repo reads like implementation history instead of service ownership;
- product services become harder to discover;
- language buckets become permanent architecture, which is the wrong default for this codebase.

### Option C - Hybrid with explicit exceptions

Use service/domain-first placement for product services, and reserve an explicit reference namespace for W0 baseline/reference implementations.

Pros:

- the default path matches service ownership;
- reference implementations stay grouped without becoming the norm;
- the migration can be mechanical and auditable.

Cons:

- the repository needs one explicit exception rule and a path-compatibility policy.

## Decision

Adopt Option C.

### Topology rule

Product services belong directly under `services/<service-id>`. The language buckets under `services/go/*`, `services/java/*`, `services/python/*`, and `services/typescript/*` are **not permanent top-level groupings**. They are migration-era layout only and may remain only for temporary compatibility shims while child issues move references to the new namespace.

W0 baseline/reference services belong under `services/reference/<service-id>`, where the service ID carries the logical baseline name plus a language suffix when multiple implementations exist. The reference namespace is the only approved exception to the service/domain-first rule.

### Service taxonomy

The initial mechanical cutover for the moved services was completed in
Issue #324. The approved live paths are:

| Live path | Classification |
| --- | --- |
| `services/agentic-harness-core` | Harness / control-plane support |
| `services/build-test-runner-service` | Build and test runner |
| `services/c2c-bff` | BFF / API boundary |
| `services/cobol-parser-service` | COBOL parser |
| `services/evidence-service` | Evidence service |
| `services/experience-learning-service` | Telemetry and learning service |
| `services/model-gateway-service` | Model Gateway, the only productive model boundary |
| `services/orchestrator-service` | Orchestrator |
| `services/reference/w0-service-go` | W0 Go reference baseline |
| `services/reference/w0-service-java` | W0 Java reference baseline |
| `services/reference/w0-service-python` | W0 Python reference baseline |
| `services/reference/w0-service-typescript` | W0 TypeScript reference baseline |
| `services/semantic-ir-service` | Semantic IR service |
| `services/target-java-generation-service` | Target Java generator |

### New service placement rule

A new product service belongs directly under `services/<service-id>` when it owns a runtime boundary, a contract, a release gate, or user-visible behavior. If the service exists only as a baseline, fixture, or reference implementation, it belongs under `services/reference/<service-id>`, with language carried as a suffix only when multiple implementations of the same baseline exist. Do not create a new permanent language bucket for a product service unless a later ADR makes that exception explicit.

### Contract and schema placement rule

Service-owned HTTP contracts live with the owning product service at
`services/<service-id>/openapi.yaml` and must be declared by that service in
`config/service-catalog.json`. Shared, externally consumed, or cross-service
JSON schemas live under the repo-level `schemas/` directory and must also be
declared there by exactly one owning component. Service-local schemas under
`services/<service-id>/schemas/` remain private implementation detail until a
later issue explicitly promotes them to a shared contract. See
[`docs/governance/contract-ownership.md`](../governance/contract-ownership.md)
for the current ownership inventory.

### Naming rules

- **Service IDs:** lowercase kebab-case, stable, and domain-first, for example `model-gateway-service` or `target-java-generation-service`. New productive services should end in `-service`. Reference services use the logical baseline name plus a language suffix when needed, for example `w0-service-go`.
- **Folder names:** product services use `services/<service-id>`. Reference services use `services/reference/<service-id>`, for example `services/reference/w0-service-go`.
- **Package names:** follow the language-native convention and derive from the service ID, not the other way around. Java `artifactId` values and Maven module directories use the service ID; Java package roots may keep existing enterprise roots until a later normalization issue. Go module paths mirror the folder path. Python distribution names use the service ID and import packages use snake_case. TypeScript package names use the service slug.
- **Docker image names:** lowercase and kebab-case, derived from the service ID. Examples: `c2c/model-gateway-service` and `c2c/reference-w0-service-go`.
- **Artifact names:** use `<service-id>-v<semver>-<sha>-<timestamp>`. Existing migration-era build metadata may retain an additional language field only until the catalog and packaging work are updated.
- **Local process names:** use the service ID or the service ID without a trailing `-service` when operator readability is better, for example `model-gateway` or `build-test-runner`. Process names must stay stable across scripts, compose files, and local launchers.

### Compatibility policy for old paths

Old paths may exist only as temporary compatibility shims during migration. They may forward build, launch, or script references, but they must not introduce alternate product behavior. Pure layout migration PRs must not change product behavior.

Compatibility shims expire when:

- all repo references move to the target path;
- the service catalog and launch scripts no longer depend on the old path;
- stale-path guardrails are in place and passing.

No new implementation work may depend on an old path.

### Required follow-up areas for later child issues

Later child issues must update every repository area that encodes service paths:

- scripts;
- workflows;
- docs;
- OpenAPI references;
- release gates;
- SBOM and license generation;
- local stack launchers;
- tests.

### Explicit exceptions

1. **W0 reference namespace.** This is a permanent exception to the default product-service layout because W0 baselines need to stay comparable and clearly non-productive. Expiry criterion: the reference service is retired or replaced by a new canonical baseline and no gate, doc, or test depends on the old reference path.
2. **Existing service IDs that predate the rule, such as `c2c-bff` and `agentic-harness-core`.** These remain valid because renaming them is not required to fix the topology problem and would add unrelated churn. Expiry criterion: a later issue explicitly authorizes service-ID normalization and updates every repo reference mechanically.
3. **Temporary old-path shims.** These are allowed only while migration is in progress. Expiry criterion: the target path is fully adopted and stale-path guardrails confirm that the old path is unused.

### Model Gateway boundary

The Model Gateway remains the only productive model boundary. No other service may call productive model providers directly. Reference services may exist for comparison or fixture purposes, but they are not productive boundaries.

## Rationale

Service/domain-first placement makes the repository easier to navigate, keeps ownership visible, and scales better than permanent language buckets. The hybrid exception for W0 baselines is necessary because those services are not product surfaces; they are reference implementations used for comparison, regression, and baseline behavior.

Language-first grouping was rejected because it turns implementation history into architecture and makes future service discovery harder. A pure service/domain-first rule without any exception was also rejected because it gives no safe place for W0 baselines and would invite ad hoc naming later.

## Consequences

- Future product services have one obvious home under `services/<service-id>`.
- The existing language buckets are no longer treated as permanent architecture.
- Migration work can move one service at a time without changing product behavior.
- The repository needs a service catalog and stale-path guardrails to keep the layout honest after migration.
- Child issues must update scripts, workflows, docs, OpenAPI references, release gates, SBOM/license generation, local stack launchers, and tests together, or the repo will drift back into path duplication.

## References

- Issue: [#322 Housekeeping-1: Define repository topology and service taxonomy](https://github.com/oscharko-dev/c2c-PreBeta/issues/322)
- Epic: [#321 Epic: Repository Housekeeping and Service Layout Refactoring Sprint](https://github.com/oscharko-dev/c2c-PreBeta/issues/321)
