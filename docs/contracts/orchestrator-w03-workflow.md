# Orchestrator W0.3 Workflow Contract

**Status:** v0 (Issues [#214](https://github.com/oscharko-dev/c2c-PreBeta/issues/214), [#215](https://github.com/oscharko-dev/c2c-PreBeta/issues/215), [#216](https://github.com/oscharko-dev/c2c-PreBeta/issues/216), [#217](https://github.com/oscharko-dev/c2c-PreBeta/issues/217), [#218](https://github.com/oscharko-dev/c2c-PreBeta/issues/218), [#222](https://github.com/oscharko-dev/c2c-PreBeta/issues/222))
**Owner:** orchestrator-service
**Consumers:** c2c-bff, c2c-studio UI, transformation/verification-repair agents,
evidence-service
**Supersedes:** [Orchestrator W0.2 Workflow Contract](orchestrator-w02-workflow.md)
(the W0.2 doc is retained for historical wording and remains the canonical
reference for W0.2-only consumers)

## Purpose

W0.3 hardens the W0.2 workflow into a fully **deterministic-first**,
**explicitly controlled**, and **evidence-complete** multi-agent product path.
It preserves every W0.2 invariant and adds four orthogonal hardening
mechanisms:

1. An explicit **assist-decision gate** owned by the Orchestrator that runs
   once per productive run, immediately after the deterministic baseline and
   before any productive agent step
   ([#214](https://github.com/oscharko-dev/c2c-PreBeta/issues/214)).
2. **Deterministic uncertainty reason codes** that source the gate decision
   from real Semantic IR / baseline markers rather than a generic AI flag
   ([#215](https://github.com/oscharko-dev/c2c-PreBeta/issues/215)).
3. Two new **bounded budgets** alongside the existing repair budget — the
   `assistBudget` (productive-assist activations) and the
   `modelInvocationBudget` (Model Gateway calls), each with explicit
   exhaustion semantics
   ([#216](https://github.com/oscharko-dev/c2c-PreBeta/issues/216)).
4. **Evidence Pack lineage** that records the assist decision and the
   end-of-run budget consumption so reviewers can audit "was AI required,
   why, and against which budgets?" from the pack alone
   ([#217](https://github.com/oscharko-dev/c2c-PreBeta/issues/217)).

The Orchestrator remains a deterministic workflow controller, not an LLM. It
is the only authoritative product workflow path for UI-started transformations.
The Harness records events and provides infrastructure (capability registry,
model gateway, event ledger, model invocation ledger, agent trajectory ledger,
experience learning substrate) but does not decide what step runs next.

This document is the canonical contract for the W0.3 run lifecycle and the run
state document exposed at:

```
GET /v0/runs/{runId}/workflow
```

The contract is also persisted to the run artifact store as
`w02-run-contract.json` (the filename is retained for backward compatibility
with W0.2 consumers and storage tooling — the artifact schema is `v0` and
absorbs every W0.3 field as a non-breaking extension).

## What changed in W0.3

| Surface | W0.2 baseline | W0.3 addition |
| --- | --- | --- |
| State machine | 12 states, terminal `final_classification` | Adds the short-lived `assist-decision` `activeStep`; no new top-level states. |
| Failure codes | 13 closed codes | Unchanged — assist/budget exhaustion never invents a new failure code; the originating build-test or oracle failure is preserved. |
| Productive-assist activation | Implicit from Model Gateway availability ([#213](https://github.com/oscharko-dev/c2c-PreBeta/issues/213)) | **Removed.** Activation requires an explicit `useTransformationAgent = true` request and an `assist_required` decision from the gate. |
| Run contract fields | `repairBudget` only | Adds `assistBudget`, `modelInvocationBudget`, `assistDecision`. |
| Harness events | `orchestrator.workflow.state.<state>` | Adds `orchestrator.workflow.assist_decision.<outcome>` (exactly one per gated run). |
| Evidence Pack | `artifacts.modelInvocations`, `artifacts.agentTrajectories` | Adds `artifacts.assistDecision` (mirror of the gate snapshot) and `artifacts.budgetSummary` (end-of-run consumption of all three budgets). |
| BFF API | `repairBudget` on workflow view | Adds `assistBudget`, `modelInvocationBudget`, `assistDecision` on the workflow view (`AssistDecisionSummary` schema). |
| Studio UI | Repair budget row | Adds the `AssistDecisionRow`, `AssistBudgetRow`, and `ModelInvocationBudgetRow` to the Agent Activity panel ([#218](https://github.com/oscharko-dev/c2c-PreBeta/issues/218)). |

Every W0.2 consumer remains forward-compatible: new fields are optional under
`v0` and additive. Closed sets are widened only with documented values, never
narrowed.

## States

The W0.3 workflow inherits the W0.2 state machine unchanged. The
[`run_contract.py`][run_contract] `_ALLOWED_TRANSITIONS` table is the source
of truth; any non-listed transition raises `IllegalTransitionError`. The state
table is repeated here for self-contained reading:

| #   | State                           | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `run_accepted`                  | Run created; BFF returned `201 Created`.                                                                                                                                                                                                                                                                                                                                             |
| 2   | `source_normalized`             | Source COBOL persisted to the run artifact store.                                                                                                                                                                                                                                                                                                                                    |
| 3   | `cobol_parse_attempted`         | Parser invoked through the Harness capability gateway.                                                                                                                                                                                                                                                                                                                               |
| 4a  | `semantic_ir_ready`             | Parser returned an IR the runner can consume.                                                                                                                                                                                                                                                                                                                                        |
| 4b  | `semantic_ir_blocked`           | Source is unsupported or IR generation failed.                                                                                                                                                                                                                                                                                                                                       |
| 5   | `baseline_generation_attempted` | Deterministic target-Java generator invoked.                                                                                                                                                                                                                                                                                                                                         |
| 6   | `transformation_agent_invoked`  | Transformation Agent invoked to produce or improve a Java candidate before deterministic verification. Reached only when the run was started with an explicit `useTransformationAgent = true` request **and** the assist-decision gate recorded `outcome = assist_required` ([#213](https://github.com/oscharko-dev/c2c-PreBeta/issues/213), [#214](https://github.com/oscharko-dev/c2c-PreBeta/issues/214)). |
| 7   | `java_candidate_persisted`      | Generated Java written to the artifact store.                                                                                                                                                                                                                                                                                                                                        |
| 8   | `build_test_running`            | Build-test runner invoked.                                                                                                                                                                                                                                                                                                                                                           |
| 9   | `verification_repair_invoked`   | Build-test failed; orchestrator entered the verification/repair loop.                                                                                                                                                                                                                                                                                                                |
| 10a | `final_java_selected`           | Build-test verified the candidate Java.                                                                                                                                                                                                                                                                                                                                              |
| 10b | `run_blocked`                   | Verification could not be completed within the repair budget.                                                                                                                                                                                                                                                                                                                        |
| 11a | `evidence_materialized`         | Evidence Pack fully assembled.                                                                                                                                                                                                                                                                                                                                                       |
| 11b | `evidence_incomplete`           | Evidence Pack assembled with missing artifacts.                                                                                                                                                                                                                                                                                                                                      |
| 12  | `final_classification`          | Terminal state — `finalClassification` carries the outcome.                                                                                                                                                                                                                                                                                                                          |

The Orchestrator emits a Harness event for every state change with
`eventType = "orchestrator.workflow.state.<state>"`. W0.3 additionally emits
exactly one `orchestrator.workflow.assist_decision.<outcome>` event per gated
run (see [Assist-decision gate](#assist-decision-gate)).

### Key invariants

- `run_accepted` may only transition to `source_normalized` or `run_blocked`.
- `final_java_selected` may only transition to `evidence_materialized` or
  `evidence_incomplete` — there is no path from `final_java_selected` back to
  `run_blocked`.
- `verification_repair_invoked` may advance to `java_candidate_persisted` when
  the Verification/Repair Agent proposes a repaired candidate, or to
  `run_blocked` when the agent refuses, escalates, returns no usable change,
  fails its contract, the repair budget is exhausted, or the
  `modelInvocationBudget` is exhausted before the next gateway call. The state
  machine also keeps the older `transformation_agent_invoked` re-entry valid
  for consumers that still model repair as a transformation sub-step.
- `final_classification` is terminal; no further transitions are allowed.

## Failure codes

A non-success run MUST carry exactly one failure code from the W0.2 closed set
(unchanged in W0.3). Budget exhaustion never invents a new code: the assist
gate hard-degrades to `assist_not_required` (see
[Assist budget](#assist-and-model-invocation-budgets) below) and the
deterministic baseline becomes the final candidate; the originating build-test
or oracle failure code is preserved when the repair loop exhausts the model
invocation budget.

| Code                        | When the Orchestrator surfaces it                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported_cobol`         | Parseable but outside the W0/W0.2/W0.3 supported subset.                                                                                                                                                                                                                                                |
| `parse_failed`              | Parser capability returned a non-success outcome.                                                                                                                                                                                                                                                       |
| `semantic_ir_failed`        | IR generation capability failed.                                                                                                                                                                                                                                                                        |
| `model_gateway_unavailable` | Model gateway endpoint unreachable or returned 5xx after retries.                                                                                                                                                                                                                                       |
| `model_policy_denied`       | Model invocation rejected by policy (`policyDecision != "policy allow"`).                                                                                                                                                                                                                               |
| `agent_timeout`             | A productive agent exceeded its allotted time.                                                                                                                                                                                                                                                          |
| `agent_contract_invalid`    | A productive agent returned a payload that fails the W0.2 agent I/O contract — missing model-invocation or Java-candidate reference, malformed JSON, oversized output, unapproved artifact reference, invalid role/status, or other schema violation. See [Agent I/O Contracts](agent-io-contracts.md). |
| `java_generation_failed`    | Generator capability returned a non-success outcome.                                                                                                                                                                                                                                                    |
| `java_compile_failed`       | Build-test reported `compile_failed` (or unstructured failure).                                                                                                                                                                                                                                         |
| `java_runtime_failed`       | Build-test reported a runtime failure of the generated Java.                                                                                                                                                                                                                                            |
| `oracle_mismatch`           | Generated Java compiled and ran but produced output that does not match the COBOL oracle / Golden Master.                                                                                                                                                                                               |
| `evidence_incomplete`       | Evidence Pack assembled with missing required artifacts.                                                                                                                                                                                                                                                |
| `cancelled`                 | Run cancelled by user, policy, or hard repair-loop limit.                                                                                                                                                                                                                                               |

## Final classifications

| Classification | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `success`      | Generated Java compiled, ran, and matched the oracle; evidence materialised.      |
| `blocked`      | Workflow gate failed (verification, deterministic check). Carries a failure code. |
| `failed`       | An unexpected exception interrupted the workflow. Carries a failure code.         |
| `cancelled`    | Caller, policy, or hard limit cancelled the run. Carries `cancelled`.             |
| `incomplete`   | Evidence Pack could not be fully materialised. Carries `evidence_incomplete`.     |

Any non-`success` classification MUST carry a `failureCode`; the contract
refuses to finalise otherwise. **Deterministic build/test/oracle verification
remains the only path to `success` regardless of any assist decision the gate
recorded.**

## Removal of implicit assist activation

In W0.2 the BFF set `useTransformationAgent = true` on every
`POST /api/v0/transform` whenever a Model Gateway URL was configured. That
implicit activation made productive AI participation availability-driven
instead of decision-driven and is removed in W0.3
([#213](https://github.com/oscharko-dev/c2c-PreBeta/issues/213)).

`C2C_MODEL_GATEWAY_URL` is now treated as **infrastructure-only**
configuration. The Orchestrator only invokes the productive Transformation
Agent when:

1. the caller explicitly opted in via `useTransformationAgent = true` on the
   run-start payload, **and**
2. the assist-decision gate recorded `outcome = assist_required` for the run.

When either condition is false the run completes on the deterministic baseline
candidate.

## Assist-decision gate

The Orchestrator owns an explicit assist-decision gate that runs once per
productive run, immediately after the deterministic baseline and before any
productive agent step. The gate records an outcome and reason code on the run
contract, persists the updated contract to the artifact store, and emits a
Harness event so consumers do not have to infer AI activation from
`agentAttemptCount > 0` or Model Gateway state.

### Contract shape

The contract carries one additional field:

```json
"assistDecision": {
  "outcome": "assist_required",
  "reasonCode": "translation_unsupported_repairable",
  "decidedAt": "2026-05-17T12:00:00Z",
  "selectedAgentRole": "transformation_agent",
  "affectedArtifactRefs": [
    { "uri": "...", "sha256": "...", "kind": "generated-project-manifest" }
  ],
  "repairBudgetSnapshot":         { "limit": 2, "used": 0, "remaining": 2 },
  "assistBudgetSnapshot":         { "limit": 1, "used": 1, "remaining": 0 },
  "modelInvocationBudgetSnapshot":{ "limit": 6, "used": 0, "remaining": 6 },
  "rationale": "deterministic generator reported unsupported features: PERFORM VARYING with composite step"
}
```

`assistDecision` is `null` for runs that never reach the gate (for example
`parse_failed` or `semantic_ir_failed` before the deterministic baseline).

### Closed sets

| Field               | Values                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`           | `assist_required`, `assist_not_required`                                                                                                                                                                                   |
| `reasonCode`        | `semantic_ir_bounded_ambiguity`, `translation_unsupported_repairable`, `baseline_open_assumptions`, `deterministic_candidate_low_confidence`, `caller_explicit_opt_in`, `caller_did_not_opt_in`, `assist_budget_exhausted` |
| `selectedAgentRole` | `transformation_agent`, or omitted/`null` when `outcome = assist_not_required`                                                                                                                                             |

Consumers MUST drop any value outside these closed sets rather than rendering
it. The BFF enforces this on `GET /api/v0/runs/{runId}/workflow`; the Studio
`apiClient` rejects unknown values at validation time.

### Deterministic uncertainty reason codes

When the caller opted into productive assist (`useTransformationAgent = true`),
the gate scans the Semantic IR and the deterministic baseline for uncertainty
markers and records the **highest-priority** match as the `reasonCode`. When
no marker is detected the gate falls back to `caller_explicit_opt_in`. When
the caller did not opt in the gate always records `caller_did_not_opt_in` and
surfaces any detected markers on the decision `rationale` only — the
deterministic baseline remains the final candidate.

| Priority | Reason code                              | Detected when                                                                                                                                                        |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `semantic_ir_bounded_ambiguity`          | `ir.ambiguityMarkers` is a non-empty list — the Semantic IR has a bounded-ambiguity marker.                                                                          |
| 2        | `translation_unsupported_repairable`     | `generatedProject.unsupportedFeatures` is a non-empty list — the deterministic generator could not lower one or more constructs but the run is otherwise repairable. |
| 3        | `baseline_open_assumptions`              | `generatedProject.openAssumptions` is a non-empty list — the deterministic baseline emitted explicit assumptions.                                                    |
| 4        | `deterministic_candidate_low_confidence` | `generatedProject.lowConfidenceMarkers` is a non-empty list — the baseline annotated regions of its candidate as low-confidence.                                     |
| 5        | `caller_explicit_opt_in`                 | Caller opted in but no marker fired (fallback).                                                                                                                      |
| 6        | `caller_did_not_opt_in`                  | Caller did not opt in (deterministic-only baseline path).                                                                                                            |
| 7        | `assist_budget_exhausted`                | Caller opted in and a marker would have fired, but the `assistBudget` was already exhausted at gate time. The gate hard-degrades to `assist_not_required`.           |

The Orchestrator never invents an uncertainty marker on behalf of an upstream
capability: every recorded reason code is backed by a real payload value. The
`AssistDecision` dataclass rejects an empty or unknown reason code at
construction time, and the productive agent is invoked only after the gate
records an `assist_required` decision.

When the caller opted in and multiple markers fire, the rationale names every
detected marker so the Evidence Pack reviewer can see the full set without a
contract-shape change.

### Active step

While the gate evaluates, the contract reports
`activeStep = "assist-decision"`. The step is short-lived: the workflow
records the decision, advances to either `transformation_agent_invoked` (when
`outcome = assist_required`) or directly to `java_candidate_persisted` (when
`outcome = assist_not_required`), and resets `activeStep` accordingly.

### Harness event

For every run that records a decision, the Orchestrator emits exactly one
Harness event:

```
eventType = "orchestrator.workflow.assist_decision.<outcome>"
```

The event `payload.output` carries the full decision dictionary (the same
shape as the `assistDecision` contract field). The Verification/Repair Agent
loop remains governed by the bounded repair budget and is **not** part of this
gate.

## Repair, assist, and model invocation budgets

W0.3 keeps the W0.2 repair budget unchanged and adds two further per-run
budgets so every productive AI activity has a named, bounded, contract-level
cap that is operationally clear and auditable per run.

| Budget                        | Field                   | Range     | Default | Env var                                    | Issue |
| ----------------------------- | ----------------------- | --------- | ------- | ------------------------------------------ | ----- |
| Repair iterations             | `repairBudget`          | `[1, 3]`  | `2`     | `ORCHESTRATOR_REPAIR_BUDGET_MAX`           | W0.2  |
| Productive-assist activations | `assistBudget`          | `[1, 3]`  | `1`     | `ORCHESTRATOR_ASSIST_BUDGET_MAX`           | [#216](https://github.com/oscharko-dev/c2c-PreBeta/issues/216) |
| Model Gateway invocations     | `modelInvocationBudget` | `[1, 20]` | `6`     | `ORCHESTRATOR_MODEL_INVOCATION_BUDGET_MAX` | [#216](https://github.com/oscharko-dev/c2c-PreBeta/issues/216) |

All three share the `{ limit, used, remaining }` shape and are clamped at
config-load time so a mis-set environment value cannot escape the W0.3 caps.

```json
"repairBudget":          { "limit": 2, "used": 0, "remaining": 2 },
"assistBudget":          { "limit": 1, "used": 0, "remaining": 1 },
"modelInvocationBudget": { "limit": 6, "used": 0, "remaining": 6 }
```

### Consumption rules

- **`repairBudget`** is consumed once per repair iteration after a failed
  build-test. The loop terminates when build-test passes or the budget is
  exhausted; in the latter case the run finalises as `blocked` with the
  originating failure code.
- **`assistBudget`** is consumed once by the assist-decision gate when it
  decides `outcome = assist_required`. When the budget is exhausted at gate
  time the gate **hard-degrades** to `assist_not_required` with the dedicated
  closed-set reason code `assist_budget_exhausted`; the deterministic baseline
  becomes the final candidate without a hidden continuation.
- **`modelInvocationBudget`** is consumed *before* every productive call
  routed through the Model Gateway — the productive Transformation Agent call
  and each repair-iteration call. Exhaustion blocks the next call before it
  reaches the gateway; the run finalises as `blocked`, the repair loop records
  a `refuse` trajectory entry tagged `model_invocation_budget_exhausted`, and
  the originating build-test failure code is preserved on `failureCode`.

### Deterministic-only invariant

Neither `assistBudget` nor `modelInvocationBudget` is consumed on the
deterministic-only success path. A run that does not opt into productive
assist completes with both budgets at `used = 0` and
`finalClassification = success`. **Deterministic build/test/oracle
verification remains the only path to `success` regardless of any budget
state.**

### Snapshot at gate time

The `assistDecision` payload captures the live budget state at gate time on
`repairBudgetSnapshot`, `assistBudgetSnapshot`, and
`modelInvocationBudgetSnapshot`. Consumers can audit the budgets the
orchestrator observed without correlating the live counters with the gate's
`decidedAt` timestamp.

## Endpoint envelope and run contract shape

`GET /v0/runs/{runId}/workflow` returns a workflow-contract envelope. The
actual `W02RunContract` (the schema name retained from W0.2) is nested under
`contract`; `contractRef` points at the persisted `w02-run-contract.json`
artifact when one is available.

```jsonc
{
  "runId": "run-1",
  "workflowId": "w0-migration-v0",
  "programId": "CASE01",
  "runStatus": "completed",
  "status": "complete",
  "missingArtifacts": [],
  "source": "live",
  "contract": {
    // W02RunContract shape shown below
  },
  "contractRef": { "uri": "…", "sha256": "…", "byteSize": 2048 },
}
```

The persisted contract artifact and the envelope's `contract` field have this
shape under W0.3:

```jsonc
{
  "schemaVersion": "v0",
  "runId": "run-1",
  "workflowId": "w0-migration-v0",
  "requester": "bff",
  "sourceRef": { "uri": "urn:source/main.cob", "sha256": "…", "byteSize": 24 },

  "currentState": "final_classification",
  "stateHistory": [
    { "state": "run_accepted",                  "at": "2026-05-17T12:00:00Z" },
    { "state": "source_normalized",             "at": "2026-05-17T12:00:00Z" },
    { "state": "cobol_parse_attempted",         "at": "2026-05-17T12:00:01Z" },
    // …
  ],

  "activeStep": null,
  "agentAttemptCount": 0,
  "repairBudget":          { "limit": 2, "used": 0, "remaining": 2 },
  "assistBudget":          { "limit": 1, "used": 0, "remaining": 1 },
  "modelInvocationBudget": { "limit": 6, "used": 0, "remaining": 6 },
  "repairAttempts": [],

  "assistDecision": {
    "outcome": "assist_not_required",
    "reasonCode": "caller_did_not_opt_in",
    "decidedAt": "2026-05-17T12:00:02Z",
    "selectedAgentRole": null,
    "affectedArtifactRefs": [],
    "repairBudgetSnapshot":          { "limit": 2, "used": 0, "remaining": 2 },
    "assistBudgetSnapshot":          { "limit": 1, "used": 0, "remaining": 1 },
    "modelInvocationBudgetSnapshot": { "limit": 6, "used": 0, "remaining": 6 }
  },

  "generatedJavaRef":   { "uri": "…", "sha256": "…", "byteSize": 1024, "kind": "generated-project-manifest" },
  "buildTestResultRef": { "uri": "…", "sha256": "…", "byteSize": 512 },
  "evidencePackRef":    { "uri": "…", "sha256": "…", "byteSize": 4096 },

  "finalClassification": "success",
  "failureCode": null,
  "failureMessage": null,

  "createdAt": "2026-05-17T12:00:00Z",
  "updatedAt": "2026-05-17T12:00:42Z"
}
```

The BFF-side surface is documented separately in the
[c2c-bff W0.2/W0.3 API contract](../c2c-bff/w0.2-api-contract.md). The BFF
strips internal `uri` fields, enforces the closed sets, and validates the
`outcome ↔ selectedAgentRole` invariant before publishing the snapshot to
the Studio.

## Evidence Pack completeness

For productive W0.3 runs, the orchestrator submits the Evidence Pack with
dedicated references for source intake and parsing, not only the final Java
result. Successful packs must carry `artifacts.sourceCobol`,
`artifacts.sourceMetadata` for the persisted `source-ref.json`,
`artifacts.parseOutput` for `parse-output.json`, `artifacts.semanticIr`, all
generated Java candidates, `finalJavaArtifact`, `runtimeVersion`, build/test
results, oracle comparison, model invocation ledgers, agent trajectory refs,
Harness events, and the W0.3 assist-decision and budget-summary lineage. If
any required reference is absent, evidence-service returns
`completenessStatus = evidence_incomplete` and the workflow final
classification must not be promoted to `success`.

For a blocked run the same contract carries `finalClassification = "blocked"`,
a non-null `failureCode`, and a non-null `failureMessage`. The state history
shows the full repair-loop trail. Blocked Evidence Packs must not publish an
authoritative final Java artifact: `artifacts.generatedJava` and
`artifacts.finalJavaArtifact` are omitted, and any retained
`generatedJavaArtifacts[]` entries remain unselected audit history only.

### Assist-decision and budget lineage

The W0.3 Evidence Pack carries two additional fields so reviewers can audit
"was AI required, why, and against which budgets?" from the pack alone — no
need to correlate with the live run contract or the Harness event ledger.

- **`artifacts.assistDecision`** mirrors the
  [assist-decision gate](#assist-decision-gate) snapshot the orchestrator
  records on the run contract: `outcome`, `reasonCode`, `decidedAt`,
  optional `selectedAgentRole`, optional `rationale`, and the three gate-time
  budget snapshots
  (`assistBudgetSnapshot`, `repairBudgetSnapshot`,
  `modelInvocationBudgetSnapshot`). The closed set of outcomes, reason codes,
  and agent roles is identical to the BFF `AssistDecisionSummary` — drift is
  a contract bug. The field is **required for non-blocked runs**. Blocked
  runs that terminated before the gate fired (for example `parse_failed`)
  legitimately omit it; evidence-service relaxes the requirement for blocked
  packs only.

- **`artifacts.budgetSummary`** records the end-of-run consumption of the
  three bounded run budgets, each as a `{ limit, used, remaining }` snapshot:
  - `budgetSummary.repair`
  - `budgetSummary.assist`
  - `budgetSummary.modelInvocation`

  This field is **required for every run**, including blocked ones. The
  budgets always exist on the run contract; their final values must always
  reach the pack so the bounded-budget posture is visible to reviewers.

### Referential integrity

evidence-service enforces:

- Budgets are monotonic during a run: a pack whose
  `budgetSummary.{repair,assist,modelInvocation}.used` is **lower** than the
  matching gate-time snapshot on `assistDecision` is rejected.
- When `assistDecision.outcome = assist_required` and `selectedAgentRole =
  transformation_agent`, the pack MUST reference at least one
  `modelInvocations` entry with `agentRole = transformation` — otherwise the
  audit trail does not back up the gate's claim.
- `assist_budget_exhausted` always degrades to
  `outcome = assist_not_required`; a pack that records the opposite
  combination is rejected.

These rules are deterministic-first: presence and shape do not by themselves
imply AI success. A pack with `assistDecision.outcome = assist_required` and a
`finalJavaArtifact` set still requires deterministic build/test verification
to pass before the orchestrator promotes the run to `success`. A failed
deterministic gate still forces classification away from `success` regardless
of any assist decision recorded.

## Agent-team extension rule

Later waves may add a larger module-level agent team, including an LLM-based
Team Lead, Planner Agent, Supervisor Agent, or bounded sub-orchestrator. Such
a component is not the global Orchestrator. It is a capability invoked inside
one Orchestrator-approved state transition and must return a candidate
artifact, repair decision, plan, or blocked result to this run contract.

The extension rule is:

1. the global Orchestrator still owns state transitions, retry budgets,
   cancellation, policy boundaries, and final classification;
2. the agent team may call models only through the Model Gateway capability
   exposed via the Harness, and every model call consumes the
   `modelInvocationBudget`;
3. the agent team may not mark a transformation successful;
4. any candidate produced by the team must pass the deterministic build/test,
   oracle, and evidence gates before `finalClassification = "success"`.

## Harness boundary

- **Capability discovery, Tool Registry, MCP, Model Gateway, policy hooks** —
  consumed by the Orchestrator through the existing
  [`HarnessGateway`][harness] client.
- **Event Ledger** — every state change is posted as an
  `orchestrator.workflow.state.<state>` event; every gate firing is posted as
  an `orchestrator.workflow.assist_decision.<outcome>` event. The Harness
  writes the event to its ledger.
- **Model Invocation Ledger** — recorded by the existing
  `model-invocation-ledger.json` artifact (unchanged in W0.3). Each entry
  records the productive invocation that consumed one `modelInvocationBudget`
  unit.
- **Agent Trajectory Ledger** — fetched via
  `HarnessGateway.get_trajectory_ledger()` and embedded into the Evidence Pack
  (unchanged in W0.3).

The Orchestrator never delegates workflow decisions to the Harness. The
Harness records what happened and exposes Experience Learning signals; the
Orchestrator decides what happens next.

## Stability promise

The shape under `currentState`, `stateHistory[].state`, `failureCode`,
`finalClassification`, the closed sets of `assistDecision.outcome`,
`assistDecision.reasonCode`, `assistDecision.selectedAgentRole`, and the
`{ limit, used, remaining }` shape of all three budgets is `v0` and considered
stable. Adding new state values, failure codes, outcome values, reason codes,
or agent roles requires a `v1` bump and an updated OpenAPI schema. Adding new
optional top-level fields is permitted under `v0`.

## See also

- [Orchestrator W0.2 Workflow Contract](orchestrator-w02-workflow.md) — the
  historical W0.2 contract; W0.2 wording is preserved there for consumers
  that have not yet migrated to the W0.3 fields.
- [c2c-bff W0.2/W0.3 API contract](../c2c-bff/w0.2-api-contract.md) — the
  BFF surface that wraps this run contract for the Studio.
- [Agent I/O Contracts](agent-io-contracts.md) — the request/response
  envelopes the productive agents speak.
- [Transformation Agent contract](transformation-agent.md) — the W0.2
  transformation-agent adapter, unchanged in W0.3.
- [ADR 0003: W0.3 Deterministic-First Multi-Agent Hardening](../adr/0003-w0-3-deterministic-first-multi-agent-hardening.md) — the
  architectural decision that drives this contract.
- [W0.3 Reference Runbook](../showcase/w0-3-reference-runbook.md) — the
  procedural recipe for verifying this contract end-to-end.

[run_contract]: ../../services/orchestrator-service/src/orchestrator_service/run_contract.py
[harness]: ../../services/orchestrator-service/src/orchestrator_service/harness.py
