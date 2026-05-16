# Agent I/O Contracts (W0.2)

**Status:** v0 (Issue [#167](https://github.com/oscharko-dev/c2c-PreBeta/issues/167))
**Owner:** orchestrator-service
**Consumers:** future Transformation Agent, future Verification/Repair Agent,
evidence-service, experience-learning-service, c2c-bff, c2c-studio UI

## Purpose

W0.2 introduces the first productive agent roles. Free-form text between the
Orchestrator and an agent is not acceptable: the Orchestrator must be able to
validate what an agent received, what it returned, which model was used
through the Model Gateway, which artifacts the agent produced, and how the
result contributes to evidence and Experience Learning.

This document defines the four contracts the Orchestrator trusts at the
agent boundary. Anything that does not conform must be rejected as
`agent_contract_invalid` (see the [Orchestrator W0.2 Workflow Contract](orchestrator-w02-workflow.md)).

## Contracts

All four schemas live under `/schemas/` at the repository root and follow the
W0/W0.2 conventions: JSON Schema draft 2020-12, `$id` rooted at
`https://oscharko.dev/c2c/schemas/`, `schemaVersion: "v0"` `const` field,
content-addressed `artifactReference` ($defs) for every payload reference.

| Contract | Schema file | Who emits | Who validates |
|----------|-------------|-----------|---------------|
| AgentInvocationRequest | `agent-invocation-request-v0.json` | Orchestrator | Agent (input check), Orchestrator (audit replay) |
| AgentInvocationResponse | `agent-invocation-response-v0.json` | Agent | Orchestrator (mandatory, before use) |
| AgentRepairInput | `agent-repair-input-v0.json` | Orchestrator | Verification/Repair Agent |
| AgentRepairDecision | `agent-repair-decision-v0.json` | Verification/Repair Agent | Orchestrator (mandatory, before use) |

The two `Agent*Decision`-shaped artifacts (`AgentInvocationResponse`,
`AgentRepairDecision`) are persisted to the run artifact store and referenced
from the Agent Trajectory Ledger and the Evidence Pack manifest.

### Common building blocks

Every contract uses the same `artifactReference` shape:

```jsonc
{
  "uri":      "urn:run-1/java-candidate-1",
  "sha256":   "<64 hex>",
  "byteSize": 1024,
  "mimeType": "application/json",   // optional
  "kind":     "generated-project-manifest" // optional
}
```

Three reference-style records are reused across contracts and exist as
`$defs` in `agent-invocation-request-v0.json`:

- `capabilityResolutionRecord` — which Harness-exposed capability the
  Orchestrator selected for this agent step (`capabilityId`,
  `capabilityVersion`, `providerService`, `resolvedAt`).
- `policyDecisionReference` — the policy decision that allowed (or denied)
  this step (`policyVersion`, `decision`, `ledgerRef`).
- `modelInvocationReference` — the governed model call from the Model
  Gateway (`invocationId`, `modelId`, `provider`, `ledgerRef`).

The single trajectory record embedded in an `AgentInvocationResponse`
(`$defs/agentTrajectoryRecord`) is shape-compatible with the steps array in
the existing [`agent-trajectory-ledger-v0.json`](../../schemas/agent-trajectory-ledger-v0.json):
the `dataClass` enum is identical so the ledger can absorb the embedded
record without re-mapping. A test guards this invariant
(`test_agent_contracts.py::test_response_trajectory_record_uses_existing_ledger_data_class_enum`).

## Roles

| `agentRole` enum value | Meaning |
|------------------------|---------|
| `transformation-agent` | Produces an initial Java candidate from COBOL source, Semantic IR, deterministic baseline output (when available), and W0 transformation rules. |
| `verification-repair-agent` | Inspects compile/runtime/oracle failures and produces either a corrected Java candidate, a precise refusal, or an escalation. |

Adding a new role is a `v1` bump and requires a new contract version. The
enum is closed in `v0`.

## Status values

`AgentInvocationResponse.status` is one of:

| Status | Meaning | Required fields |
|--------|---------|----------------|
| `success` | Agent produced a usable output. | `outputArtifactRefs` (non-empty); for `transformation-agent` also `javaCandidateRef`. |
| `blocked` | Agent could not safely continue. | `failureCode`, `failureMessage`. |
| `failed`  | Internal agent failure. | `failureCode`, `failureMessage`. |
| `timeout` | Agent exceeded its deadline. | `failureCode = "agent_timeout"`, `failureMessage`. |
| `policy_denied` | Model Gateway/policy denied the underlying call. | `failureCode = "model_policy_denied"`, `failureMessage`. |

A `verification-repair-agent` response always carries `repairDecisionRef`
regardless of status — the decision artifact is the agent's structured
explanation of what it did, even on failure.

## Repair decisions

A `verification-repair-agent` writes an `AgentRepairDecision` artifact and
references it from its `AgentInvocationResponse.repairDecisionRef`. The
decision is exactly one of three:

| `decision` | Required additional fields | Forbidden fields |
|------------|----------------------------|------------------|
| `propose_candidate` | `newJavaCandidateRef` | `refusalCode`, `escalationCode` |
| `refuse` | `refusalCode` | `newJavaCandidateRef`, `escalationCode` |
| `escalate` | `escalationCode` | `newJavaCandidateRef`, `refusalCode` |

The exclusivity is enforced by the schema's `allOf` / `if/then` / `not`
constraints and by the orchestrator-side validator. A decision that mixes
fields fails contract validation and blocks the run with
`agent_contract_invalid`.

## Validation

The Orchestrator validates every productive-agent response **before** it
acts on it. The validator
([`orchestrator_service/agent_contracts.py`][validator]) is stdlib-only and
enforces:

- JSON Schema constraints (`type`, `required`, `enum`, `const`, `pattern`,
  `minItems`, `minLength`, `maxLength`, `minimum`, `maximum`,
  `additionalProperties`, `$ref`, `if/then/else`, `not`/`anyOf`).
- RFC 3339 `date-time` strings.
- A hard payload-size cap of **256 KiB** (`MAX_PAYLOAD_BYTES`). Anything
  larger is rejected as oversized.
- A secret-leak guard that rejects payloads containing keys whose name
  resembles a credential (`apiKey`, `authorization`, `bearerToken`,
  `password`, `accessToken`, `refreshToken`, `providerCredentials`, …). This
  is a belt-and-braces safeguard layered on top of the schema's
  `additionalProperties: false` boundaries.

The validator refuses to load a schema that uses unsupported JSON Schema
features (`UnsupportedSchemaFeatureError`). This prevents a future schema
edit from silently widening the trust surface.

### Failure mapping

| Validation outcome | Run contract effect |
|--------------------|---------------------|
| Schema or guard rejects payload | Workflow raises `AgentContractInvalidStepError`. Run transitions to `run_blocked` with `failureCode = "agent_contract_invalid"`. |
| Missing `modelInvocationRef` | Same as above — covered by `required` field. |
| Missing `javaCandidateRef` on a successful transformation response | Same as above — covered by the success/`transformation-agent` conditional. |
| Oversized output | Same as above — covered by `MAX_PAYLOAD_BYTES`. |
| Unapproved artifact reference (bad `sha256` pattern, missing `uri`) | Same as above — covered by `artifactReference` constraints. |

## Trajectory and Evidence linkage

Every agent invocation produces:

1. One **trajectory record** in the Agent Trajectory Ledger
   (`agent-trajectory-ledger-v0.json`). The record references the model
   invocation, the capability used, the input/output artifacts, and the
   state transition. The single `trajectoryRecord` embedded in the
   `AgentInvocationResponse` is the agent's view of what it did and is
   merged into the run's ledger by the Harness.
2. One **model invocation ledger** entry
   (`model-invocation-ledger-v0.json`), recorded by the Model Gateway. The
   `AgentInvocationResponse.modelInvocationRef` points at the relevant
   ledger entry.
3. One **agent-output artifact** in the run artifact store, referenced
   from the Evidence Pack manifest.

Future Experience Learning passes consume the trajectory ledger and the
embedded `trajectoryRecord`s to detect:

- Repeated no-change repair attempts.
- Repeated invalid outputs from the same agent + capability + prompt
  template id.
- Repeated tool calls without new evidence.
- Model outputs that repeatedly fail compilation or behavioural checks.

## What the contracts deliberately do not carry

The schemas forbid (via `additionalProperties: false` or the secret-leak
guard) inline secrets, full API keys, raw prompt bodies, and provider
credentials. Agents reference everything by content hash; the actual
sensitive material — prompt body, provider key — never leaves the
Model Gateway boundary.

## Stability promise

`schemaVersion: "v0"` is stable for the shape and required fields described
here. Adding new **optional** top-level fields is permitted under `v0`;
adding new role values, status values, decision values, refusal codes, or
escalation codes requires a `v1` bump and a coordinated update to the
Orchestrator validator and the workflow contract doc.

[validator]: ../../services/orchestrator-service/src/orchestrator_service/agent_contracts.py
