# Orchestrator W0.2 Workflow Contract

**Status:** v0 (Issue [#166](https://github.com/oscharko-dev/c2c-PreBeta/issues/166))
**Owner:** orchestrator-service
**Consumers:** c2c-bff, c2c-studio UI, future transformation/verification agents,
evidence-service

## Purpose

The Orchestrator owns the W0.2 transformation workflow. The Harness records
events and provides infrastructure (capability registry, model gateway, event
ledger, model invocation ledger, agent trajectory ledger, experience learning
substrate) but does not decide what step runs next.

The Orchestrator is a deterministic workflow controller, not an LLM. It is the
only authoritative product workflow path for UI-started transformations:
deterministic parser, Semantic IR, target generation, build/test, evidence,
and AI-assisted agent steps are all invoked through this contract. Direct
deterministic success paths outside the Orchestrator are not product paths,
because they would bypass run state, Harness events, artifact lineage,
Experience Learning, and Evidence Pack completeness checks.

This document is the canonical contract for the run lifecycle and the run
state document exposed at:

```
GET /v0/runs/{runId}/workflow
```

The contract is also persisted to the run artifact store as
`w02-run-contract.json` so it remains available for runs that have left
runner memory.

## States

The W0.2 workflow defines a closed set of states. The state machine in
[`orchestrator_service/run_contract.py`][run_contract] enforces the allowed
transitions; any non-listed transition raises `IllegalTransitionError`.

| #   | State                           | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `run_accepted`                  | Run created; BFF returned `201 Created`.                                                                                                                                                                                                                                                                                                                                             |
| 2   | `source_normalized`             | Source COBOL persisted to the run artifact store.                                                                                                                                                                                                                                                                                                                                    |
| 3   | `cobol_parse_attempted`         | Parser invoked through the Harness capability gateway.                                                                                                                                                                                                                                                                                                                               |
| 4a  | `semantic_ir_ready`             | Parser returned an IR the runner can consume.                                                                                                                                                                                                                                                                                                                                        |
| 4b  | `semantic_ir_blocked`           | Source is unsupported or IR generation failed.                                                                                                                                                                                                                                                                                                                                       |
| 5   | `baseline_generation_attempted` | Deterministic target-Java generator invoked.                                                                                                                                                                                                                                                                                                                                         |
| 6   | `transformation_agent_invoked`  | Transformation Agent invoked to produce or improve a Java candidate before deterministic verification. Reached only when the run was started with an explicit `useTransformationAgent = true` request; as of W0.3 (#213) the BFF no longer sets this flag implicitly from Model Gateway availability, and the explicit assist-decision gate that authorizes opt-in is owned by #214. |
| 7   | `java_candidate_persisted`      | Generated Java written to the artifact store.                                                                                                                                                                                                                                                                                                                                        |
| 8   | `build_test_running`            | Build-test runner invoked.                                                                                                                                                                                                                                                                                                                                                           |
| 9   | `verification_repair_invoked`   | Build-test failed; orchestrator entered the verification/repair loop.                                                                                                                                                                                                                                                                                                                |
| 10a | `final_java_selected`           | Build-test verified the candidate Java.                                                                                                                                                                                                                                                                                                                                              |
| 10b | `run_blocked`                   | Verification could not be completed within the repair budget.                                                                                                                                                                                                                                                                                                                        |
| 11a | `evidence_materialized`         | Evidence Pack fully assembled.                                                                                                                                                                                                                                                                                                                                                       |
| 11b | `evidence_incomplete`           | Evidence Pack assembled with missing artifacts.                                                                                                                                                                                                                                                                                                                                      |
| 12  | `final_classification`          | Terminal state — `finalClassification` carries the outcome.                                                                                                                                                                                                                                                                                                                          |

The Orchestrator emits a Harness event for every state change with
`eventType = "orchestrator.workflow.state.<state>"`.

### Allowed transitions

The state machine is a directed graph. The full table lives in
[`run_contract.py`][run_contract] (`_ALLOWED_TRANSITIONS`). Key invariants:

- `run_accepted` may only transition to `source_normalized` or `run_blocked`.
- `final_java_selected` may only transition to `evidence_materialized` or
  `evidence_incomplete` — there is no path from `final_java_selected` back
  to `run_blocked`.
- `verification_repair_invoked` may advance to `java_candidate_persisted`
  when the Verification/Repair Agent proposes a repaired candidate, or to
  `run_blocked` when the agent refuses, escalates, returns no usable change,
  fails its contract, or the repair budget is exhausted. The state machine
  also keeps the older `transformation_agent_invoked` re-entry valid for
  compatibility with consumers that still model repair as a transformation
  sub-step.
- `final_classification` is terminal; no further transitions are allowed.

## Failure codes

A non-success run MUST carry exactly one failure code from this closed set:

| Code                        | When the Orchestrator surfaces it                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported_cobol`         | Parseable but outside the W0/W0.2 supported subset.                                                                                                                                                                                                                                                     |
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

Any non-`success` classification **must** carry a `failureCode`; the
contract refuses to finalise otherwise.

## Assist-decision gate (W0.3 / Issue #214)

The Orchestrator owns an explicit assist-decision gate that runs once per
productive run, immediately after the deterministic baseline and before any
productive agent step. The gate records an outcome and reason code on the run
contract, persists the updated contract to the artifact store, and emits a
Harness event so consumers do not have to infer AI activation from
`agentAttemptCount > 0` or Model Gateway state.

The W0.3-3 gate captured the _current_ caller-opt-in semantics in a stable,
recordable shape. Issue #215 (W0.3-4) extends the closed reason-code set
with deterministic uncertainty criteria sourced from the Semantic IR and
the deterministic baseline; the contract shape, outcomes, and event types
are unchanged.

### Contract shape

The contract carries one additional field:

```json
"assistDecision": {
  "outcome": "assist_required",
  "reasonCode": "caller_explicit_opt_in",
  "decidedAt": "2026-05-17T12:00:00Z",
  "selectedAgentRole": "transformation_agent",
  "affectedArtifactRefs": [
    { "uri": "...", "sha256": "...", "kind": "generated-project-manifest" }
  ],
  "repairBudgetSnapshot": { "limit": 2, "used": 0, "remaining": 2 },
  "assistBudgetSnapshot": { "limit": 1, "used": 1, "remaining": 0 },
  "modelInvocationBudgetSnapshot": { "limit": 6, "used": 0, "remaining": 6 },
  "rationale": "caller opted into productive Transformation Agent via useTransformationAgent=true"
}
```

`assistDecision` is `null` for runs that never reach the gate (e.g., parse
failed before the deterministic baseline).

### Closed sets

| Field               | Values                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`           | `assist_required`, `assist_not_required`                                                                                                                                                                                   |
| `reasonCode`        | `semantic_ir_bounded_ambiguity`, `translation_unsupported_repairable`, `baseline_open_assumptions`, `deterministic_candidate_low_confidence`, `caller_explicit_opt_in`, `caller_did_not_opt_in`, `assist_budget_exhausted` |
| `selectedAgentRole` | `transformation_agent`, or omitted when `outcome = assist_not_required`                                                                                                                                                    |

Consumers MUST drop any value outside these closed sets rather than rendering
it. The BFF enforces this on `GET /api/v0/runs/{runId}/workflow`.

### Deterministic uncertainty reason codes (W0.3-4 / Issue #215)

When the caller opted into productive assist (`useTransformationAgent = true`),
the gate scans the Semantic IR and the deterministic baseline for the
following uncertainty markers and records the highest-priority match (top to
bottom) as the `reasonCode`. When no marker is detected the gate falls back to
`caller_explicit_opt_in`. When the caller did not opt in the gate always
records `caller_did_not_opt_in` and surfaces any detected markers on the
decision `rationale` only — the deterministic baseline remains the final
candidate.

| Priority | Reason code                              | Detected when                                                                                                                                                        |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `semantic_ir_bounded_ambiguity`          | `ir.ambiguityMarkers` is a non-empty list — the Semantic IR has a bounded-ambiguity marker.                                                                          |
| 2        | `translation_unsupported_repairable`     | `generatedProject.unsupportedFeatures` is a non-empty list — the deterministic generator could not lower one or more constructs but the run is otherwise repairable. |
| 3        | `baseline_open_assumptions`              | `generatedProject.openAssumptions` is a non-empty list — the deterministic baseline emitted explicit assumptions.                                                    |
| 4        | `deterministic_candidate_low_confidence` | `generatedProject.lowConfidenceMarkers` is a non-empty list — the baseline annotated regions of its candidate as low-confidence.                                     |

The Orchestrator never invents an uncertainty marker on behalf of an
upstream capability: every recorded reason code is backed by a real payload
value. Productive transformation assist remains impossible without a reason
code — the `AssistDecision` dataclass rejects an empty or unknown reason
code at construction time, and the productive agent is invoked only after
the gate has recorded an `assist_required` decision.

### Active step

While the gate evaluates, the contract reports
`activeStep = "assist-decision"`. The step is short-lived: the workflow
records the decision, advances to either `transformation_agent_invoked`
(when `outcome = assist_required`) or directly to
`java_candidate_persisted` (when `outcome = assist_not_required`) and resets
`activeStep` accordingly.

### Harness event

For every run that records a decision, the Orchestrator emits exactly one
Harness event:

```
eventType = "orchestrator.workflow.assist_decision.<outcome>"
```

The event `payload.output` carries the full decision dictionary (the same
shape as the `assistDecision` contract field). The Verification/Repair Agent
loop remains governed by the bounded repair budget and is **not** part of this
gate; that loop is the subject of subsequent W0.3 issues.

## Repair budget

The W0.2 verification/repair loop is bounded by a configurable iteration
limit, clamped to the range `[1, 3]`. The default is `2`.

The limit is set by the environment variable
`ORCHESTRATOR_REPAIR_BUDGET_MAX` and surfaced on the contract as:

```json
"repairBudget": { "limit": 2, "used": 0, "remaining": 2 }
```

When build-test reports failure, the Orchestrator:

1. Advances the state machine to `verification_repair_invoked`.
2. Consumes one budget unit and increments `agentAttemptCount`.
3. Invokes the Verification/Repair Agent through the Model Gateway and records
   the attempt in `repairAttempts`, including the `modelInvocationRef`,
   `repairInputRef`, `repairDecisionRef`, and `buildTestResultRef` that
   triggered that repair when those governed artifacts exist. Gateway failures
   without a real invocation record are recorded without fabricated model
   lineage and remain evidence-incomplete.
4. If the agent proposes a repaired candidate, advances through
   `java_candidate_persisted` → `build_test_running` and reruns build/test on
   that candidate.
5. Repeats until build-test passes (→ `final_java_selected`) or the budget
   is exhausted (→ `run_blocked`).

The budget is never used on the success path — a passing first build-test
keeps `used = 0`.

## Assist and model invocation budgets (W0.3-5 / Issue #216)

Two additional per-run budgets sit alongside the repair budget so the
contract enforces operationally clear caps on every productive AI activity:

| Budget                        | Field                   | Range     | Default | Env var                                    |
| ----------------------------- | ----------------------- | --------- | ------- | ------------------------------------------ |
| Productive-assist activations | `assistBudget`          | `[1, 3]`  | `1`     | `ORCHESTRATOR_ASSIST_BUDGET_MAX`           |
| Model Gateway invocations     | `modelInvocationBudget` | `[1, 20]` | `6`     | `ORCHESTRATOR_MODEL_INVOCATION_BUDGET_MAX` |

Both follow the same `{ limit, used, remaining }` shape as the existing
repair budget and are clamped at config-load time so a mis-set environment
value cannot escape the W0.3 cap.

```json
"assistBudget":            { "limit": 1, "used": 0, "remaining": 1 },
"modelInvocationBudget":   { "limit": 6, "used": 0, "remaining": 6 }
```

### Consumption rules

- **`assistBudget`** is consumed once by the assist-decision gate when it
  decides `assist_required`. When the budget is exhausted at gate time the
  gate **hard-degrades** to `assist_not_required` with the dedicated
  closed-set reason code `assist_budget_exhausted`; the deterministic
  baseline becomes the final candidate without a hidden continuation.
- **`modelInvocationBudget`** is consumed _before_ every productive call
  routed through the Model Gateway — the productive Transformation Agent
  call and each repair-iteration call. Exhaustion blocks the next call
  before it reaches the gateway; the run finalises as `blocked`, the
  repair loop records a `refuse` trajectory entry tagged
  `model_invocation_budget_exhausted`, and the originating build-test
  failure code is preserved on `failureCode`.

### Deterministic-only invariant

Neither budget is consumed on the deterministic-only success path. A run
that does not opt into productive assist completes with both budgets at
`used = 0`. Deterministic build/test/oracle verification remains the only
path to `finalClassification = "success"` regardless of budget state.

### Assist-decision snapshot

The `assistDecision` payload (see [Assist-decision gate](#assist-decision-gate-w03--issue-214))
captures the live budget state at gate time on
`assistBudgetSnapshot` and `modelInvocationBudgetSnapshot` (alongside the
pre-existing `repairBudgetSnapshot`). Consumers can audit the budgets the
orchestrator observed without correlating the live counters with the
gate's `decidedAt` timestamp.

## Agent-team extension rule

Later waves may add a larger module-level agent team, including an LLM-based
Team Lead, Planner Agent, Supervisor Agent, or bounded sub-orchestrator. Such a
component is not the global Orchestrator. It is a capability invoked inside one
Orchestrator-approved state transition and must return a candidate artifact,
repair decision, plan, or blocked result to this run contract.

The extension rule is:

1. the global Orchestrator still owns state transitions, retry budgets,
   cancellation, policy boundaries, and final classification;
2. the agent team may call models only through the Model Gateway capability
   exposed via the Harness;
3. the agent team may not mark a transformation successful;
4. any candidate produced by the team must pass the deterministic build/test,
   oracle, and evidence gates before `finalClassification = "success"`.

## Endpoint envelope and run contract shape

`GET /v0/runs/{runId}/workflow` returns a workflow-contract envelope. The
actual `W02RunContract` is nested under `contract`; `contractRef` points at the
persisted `w02-run-contract.json` artifact when one is available.

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

The persisted `w02-run-contract.json` artifact and the envelope's `contract`
field have this shape:

```jsonc
{
  "schemaVersion": "v0",
  "runId": "run-1",
  "workflowId": "w0-migration-v0",
  "requester": "bff",
  "sourceRef": { "uri": "urn:source/main.cob", "sha256": "…", "byteSize": 24 },

  "currentState": "final_classification",
  "stateHistory": [
    {
      "state": "run_accepted",
      "at": "2026-05-16T14:30:00Z",
      "message": "run accepted",
    },
    {
      "state": "source_normalized",
      "at": "2026-05-16T14:30:00Z",
      "message": "source persisted to artifact store",
    },
    {
      "state": "cobol_parse_attempted",
      "at": "2026-05-16T14:30:01Z",
      "message": "cobol parser returned ok",
    },
    // …
  ],

  "activeStep": null,
  "agentAttemptCount": 0,
  "repairBudget": { "limit": 2, "used": 0, "remaining": 2 },
  "assistBudget": { "limit": 1, "used": 0, "remaining": 1 },
  "modelInvocationBudget": { "limit": 6, "used": 0, "remaining": 6 },
  "repairAttempts": [],

  "generatedJavaRef": {
    "uri": "…",
    "sha256": "…",
    "byteSize": 1024,
    "kind": "generated-project-manifest",
  },
  "buildTestResultRef": { "uri": "…", "sha256": "…", "byteSize": 512 },
  "evidencePackRef": { "uri": "…", "sha256": "…", "byteSize": 4096 },

  "finalClassification": "success",
  "failureCode": null,
  "failureMessage": null,

  "createdAt": "2026-05-16T14:30:00Z",
  "updatedAt": "2026-05-16T14:30:42Z",
}
```

## Evidence Pack Completeness

For productive W0.2 runs, the orchestrator submits the Evidence Pack with
dedicated references for source intake and parsing, not only the final Java
result. Successful packs must carry `artifacts.sourceCobol`,
`artifacts.sourceMetadata` for the persisted `source-ref.json`,
`artifacts.parseOutput` for `parse-output.json`, `artifacts.semanticIr`, all
generated Java candidates, `finalJavaArtifact`, `runtimeVersion`, build/test
results, oracle comparison, model invocation ledgers, agent trajectory refs,
Harness events, and — added by W0.3-6 (Issue #217) — the assist-decision and
budget-summary lineage. If any required reference is absent, evidence-service
returns `completenessStatus=evidence_incomplete` and the workflow final
classification must not be promoted to `success`. The orchestrator does not
fabricate `sourceMetadata` or `parseOutput` from in-memory payloads when the
persisted artifact metadata is missing.

For a blocked run the same contract carries
`finalClassification = "blocked"`, a non-null `failureCode`, and a non-null
`failureMessage`. The state history shows the full repair-loop trail.
Blocked Evidence Packs must not publish an authoritative final Java artifact:
`artifacts.generatedJava` and `artifacts.finalJavaArtifact` are omitted, and
any retained `generatedJavaArtifacts[]` entries remain unselected audit
history only.

### Assist-decision and budget lineage (W0.3-6 / Issue #217)

The W0.2 Evidence Pack carries two additional fields so reviewers can audit
"was AI required, why, and against which budgets?" from the pack alone — no
need to correlate with the live run contract or the Harness event ledger.

- **`artifacts.assistDecision`** mirrors the
  [Assist-decision gate](#assist-decision-gate-w03--issue-214) snapshot the
  orchestrator records on the run contract: `outcome`, `reasonCode`,
  `decidedAt`, optional `selectedAgentRole`, optional `rationale`, and the
  three gate-time budget snapshots
  (`assistBudgetSnapshot`, `repairBudgetSnapshot`,
  `modelInvocationBudgetSnapshot`). The closed set of outcomes, reason codes,
  and agent roles is identical to the BFF `AssistDecisionSummary` — drift is
  a contract bug. The field is **required for non-blocked W0.2 runs**.
  Blocked runs that terminated before the gate fired (e.g.,
  `parse_failed`) legitimately omit it; evidence-service relaxes the
  requirement for blocked packs only.

- **`artifacts.budgetSummary`** records the end-of-run consumption of the
  three bounded run budgets defined in W0.3-5 (Issue #216), each as a
  `{limit, used, remaining}` snapshot:
  - `budgetSummary.repair`
  - `budgetSummary.assist`
  - `budgetSummary.modelInvocation`

  This field is **required for every W0.2 run**, including blocked ones. The
  budgets always exist on the run contract; their final values must always
  reach the pack so the bounded-budget posture is visible to reviewers.

Budgets are monotonic during a run, so evidence-service refuses a pack whose
`budgetSummary.{repair,assist,modelInvocation}.used` is _lower_ than the
matching gate-time snapshot on `assistDecision`. Similarly, when
`assistDecision.outcome` is `assist_required` and `selectedAgentRole` is
`transformation_agent`, the pack must reference at least one
`modelInvocations` entry with `agentRole=transformation` — otherwise the
audit trail does not back up the gate's claim.

These fields are deterministic-first: their presence and shape do not by
themselves imply AI success. A pack with `assistDecision.outcome =
assist_required` and `finalJavaArtifact` set still requires deterministic
build/test verification to pass before the orchestrator promotes the run to
`success`. A failed deterministic gate still forces `classification` away
from `success` regardless of any assist-decision recorded.

## Harness boundary

- **Capability discovery, Tool Registry, MCP, Model Gateway, policy hooks**
  — consumed by the Orchestrator through the existing
  [`HarnessGateway`][harness] client.
- **Event Ledger** — every state change is posted as an
  `orchestrator.workflow.state.<state>` event. The Harness writes the event
  to its ledger.
- **Model Invocation Ledger** — recorded by the existing
  `model-invocation-ledger.json` artifact (unchanged in this issue).
- **Agent Trajectory Ledger** — fetched via
  `HarnessGateway.get_trajectory_ledger()` and embedded into the Evidence
  Pack (unchanged in this issue).

The Orchestrator never delegates workflow decisions to the Harness. The
Harness records what happened and exposes Experience Learning signals; the
Orchestrator decides what happens next.

## Stability promise

The shape under `currentState`, `stateHistory[].state`, `failureCode`, and
`finalClassification` is `v0` and considered stable. Adding new state values
or failure codes requires a `v1` bump and an updated OpenAPI schema. Adding
new optional top-level fields is permitted under `v0`.

[run_contract]: ../../services/orchestrator-service/src/orchestrator_service/run_contract.py
[harness]: ../../services/orchestrator-service/src/orchestrator_service/harness.py
