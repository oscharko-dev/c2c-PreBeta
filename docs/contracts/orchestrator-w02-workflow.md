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

| # | State | Meaning |
|---|-------|---------|
| 1 | `run_accepted` | Run created; BFF returned `201 Created`. |
| 2 | `source_normalized` | Source COBOL persisted to the run artifact store. |
| 3 | `cobol_parse_attempted` | Parser invoked through the Harness capability gateway. |
| 4a | `semantic_ir_ready` | Parser returned an IR the runner can consume. |
| 4b | `semantic_ir_blocked` | Source is unsupported or IR generation failed. |
| 5 | `baseline_generation_attempted` | Deterministic target-Java generator invoked. |
| 6 | `transformation_agent_invoked` | Transformation Agent invoked to produce or improve a Java candidate before deterministic verification. Reached only when the run was started with an explicit `useTransformationAgent = true` request; as of W0.3 (#213) the BFF no longer sets this flag implicitly from Model Gateway availability, and the explicit assist-decision gate that authorizes opt-in is owned by #214. |
| 7 | `java_candidate_persisted` | Generated Java written to the artifact store. |
| 8 | `build_test_running` | Build-test runner invoked. |
| 9 | `verification_repair_invoked` | Build-test failed; orchestrator entered the verification/repair loop. |
| 10a | `final_java_selected` | Build-test verified the candidate Java. |
| 10b | `run_blocked` | Verification could not be completed within the repair budget. |
| 11a | `evidence_materialized` | Evidence Pack fully assembled. |
| 11b | `evidence_incomplete` | Evidence Pack assembled with missing artifacts. |
| 12 | `final_classification` | Terminal state — `finalClassification` carries the outcome. |

The Orchestrator emits a Harness event for every state change with
`eventType = "orchestrator.workflow.state.<state>"`.

### Allowed transitions

The state machine is a directed graph. The full table lives in
[`run_contract.py`][run_contract] (`_ALLOWED_TRANSITIONS`). Key invariants:

* `run_accepted` may only transition to `source_normalized` or `run_blocked`.
* `final_java_selected` may only transition to `evidence_materialized` or
  `evidence_incomplete` — there is no path from `final_java_selected` back
  to `run_blocked`.
* `verification_repair_invoked` may advance to `java_candidate_persisted`
  when the Verification/Repair Agent proposes a repaired candidate, or to
  `run_blocked` when the agent refuses, escalates, returns no usable change,
  fails its contract, or the repair budget is exhausted. The state machine
  also keeps the older `transformation_agent_invoked` re-entry valid for
  compatibility with consumers that still model repair as a transformation
  sub-step.
* `final_classification` is terminal; no further transitions are allowed.

## Failure codes

A non-success run MUST carry exactly one failure code from this closed set:

| Code | When the Orchestrator surfaces it |
|------|-----------------------------------|
| `unsupported_cobol` | Parseable but outside the W0/W0.2 supported subset. |
| `parse_failed` | Parser capability returned a non-success outcome. |
| `semantic_ir_failed` | IR generation capability failed. |
| `model_gateway_unavailable` | Model gateway endpoint unreachable or returned 5xx after retries. |
| `model_policy_denied` | Model invocation rejected by policy (`policyDecision != "policy allow"`). |
| `agent_timeout` | A productive agent exceeded its allotted time. |
| `agent_contract_invalid` | A productive agent returned a payload that fails the W0.2 agent I/O contract — missing model-invocation or Java-candidate reference, malformed JSON, oversized output, unapproved artifact reference, invalid role/status, or other schema violation. See [Agent I/O Contracts](agent-io-contracts.md). |
| `java_generation_failed` | Generator capability returned a non-success outcome. |
| `java_compile_failed` | Build-test reported `compile_failed` (or unstructured failure). |
| `java_runtime_failed` | Build-test reported a runtime failure of the generated Java. |
| `oracle_mismatch` | Generated Java compiled and ran but produced output that does not match the COBOL oracle / Golden Master. |
| `evidence_incomplete` | Evidence Pack assembled with missing required artifacts. |
| `cancelled` | Run cancelled by user, policy, or hard repair-loop limit. |

## Final classifications

| Classification | Meaning |
|---------------|---------|
| `success` | Generated Java compiled, ran, and matched the oracle; evidence materialised. |
| `blocked` | Workflow gate failed (verification, deterministic check). Carries a failure code. |
| `failed` | An unexpected exception interrupted the workflow. Carries a failure code. |
| `cancelled` | Caller, policy, or hard limit cancelled the run. Carries `cancelled`. |
| `incomplete` | Evidence Pack could not be fully materialised. Carries `evidence_incomplete`. |

Any non-`success` classification **must** carry a `failureCode`; the
contract refuses to finalise otherwise.

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
  "contractRef": { "uri": "…", "sha256": "…", "byteSize": 2048 }
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
    { "state": "run_accepted",       "at": "2026-05-16T14:30:00Z", "message": "run accepted" },
    { "state": "source_normalized",  "at": "2026-05-16T14:30:00Z", "message": "source persisted to artifact store" },
    { "state": "cobol_parse_attempted", "at": "2026-05-16T14:30:01Z", "message": "cobol parser returned ok" }
    // …
  ],

  "activeStep": null,
  "agentAttemptCount": 0,
  "repairBudget": { "limit": 2, "used": 0, "remaining": 2 },
  "repairAttempts": [],

  "generatedJavaRef":   { "uri": "…", "sha256": "…", "byteSize": 1024, "kind": "generated-project-manifest" },
  "buildTestResultRef": { "uri": "…", "sha256": "…", "byteSize":  512 },
  "evidencePackRef":    { "uri": "…", "sha256": "…", "byteSize": 4096 },

  "finalClassification": "success",
  "failureCode":         null,
  "failureMessage":      null,

  "createdAt": "2026-05-16T14:30:00Z",
  "updatedAt": "2026-05-16T14:30:42Z"
}
```

## Evidence Pack Completeness

For productive W0.2 runs, the orchestrator submits the Evidence Pack with
dedicated references for source intake and parsing, not only the final Java
result. Successful packs must carry `artifacts.sourceMetadata` for the
persisted `source-ref.json`, `artifacts.parseOutput` for `parse-output.json`,
`artifacts.semanticIr`, all generated Java candidates, `finalJavaArtifact`,
`runtimeVersion`, build/test results, oracle comparison, model invocation
ledgers, agent trajectory refs, and Harness events. If any required reference
is absent, evidence-service returns `completenessStatus=evidence_incomplete`
and the workflow final classification must not be promoted to `success`.
The orchestrator does not fabricate `sourceMetadata` or `parseOutput` from
in-memory payloads when the persisted artifact metadata is missing.

For a blocked run the same contract carries
`finalClassification = "blocked"`, a non-null `failureCode`, and a non-null
`failureMessage`. The state history shows the full repair-loop trail.
Blocked Evidence Packs must not publish an authoritative final Java artifact:
`artifacts.generatedJava` and `artifacts.finalJavaArtifact` are omitted, and
any retained `generatedJavaArtifacts[]` entries remain unselected audit
history only.

## Harness boundary

* **Capability discovery, Tool Registry, MCP, Model Gateway, policy hooks**
  — consumed by the Orchestrator through the existing
  [`HarnessGateway`][harness] client.
* **Event Ledger** — every state change is posted as an
  `orchestrator.workflow.state.<state>` event. The Harness writes the event
  to its ledger.
* **Model Invocation Ledger** — recorded by the existing
  `model-invocation-ledger.json` artifact (unchanged in this issue).
* **Agent Trajectory Ledger** — fetched via
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
