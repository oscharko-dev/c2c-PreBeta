# Orchestrator W0.3 Workflow Contract

**Owner:** `services/orchestrator-service`
**Code source of truth:** `services/orchestrator-service/src/orchestrator_service/run_contract.py`
**Consumers:** BFF, Studio, Evidence service, agents

This document records stable consumer semantics only. Code, schemas, OpenAPI,
and tests remain the executable truth.

## Invariants

- Every product run goes through the Orchestrator.
- Deterministic baseline steps run before productive transformation assist.
- Productive AI requires an Orchestrator assist decision.
- Model Gateway is the only model boundary.
- Harness records infrastructure signals; it does not choose workflow steps.
- `success` requires deterministic verification and complete evidence.

## State Machine

The run contract exposes `currentState` and `stateHistory` with these states:

1. `run_accepted`
2. `source_normalized`
3. `cobol_parse_attempted`
4. `semantic_ir_ready` or `semantic_ir_blocked`
5. `baseline_generation_attempted`
6. `transformation_agent_invoked` when productive assist or repair invokes it
7. `java_candidate_persisted`
8. `build_test_running`
9. `verification_repair_invoked`, `final_java_selected`, or `run_blocked`
10. `evidence_materialized` or `evidence_incomplete`
11. `final_classification`

`assist-decision` is an `activeStep` and contract payload, not a top-level
workflow state.

## Assist Decision

Runs that reach the W0.3 assist gate record one `assistDecision`. The current
shape is:

```json
{
  "outcome": "assist_not_required",
  "reasonCode": "caller_did_not_opt_in",
  "decidedAt": "2026-05-17T12:00:00Z",
  "selectedAgentRole": null,
  "affectedArtifactRefs": [],
  "repairBudgetSnapshot": { "limit": 2, "used": 0, "remaining": 2 },
  "assistBudgetSnapshot": { "limit": 1, "used": 0, "remaining": 1 },
  "modelInvocationBudgetSnapshot": { "limit": 6, "used": 0, "remaining": 6 },
  "rationale": "deterministic baseline selected"
}
```

Allowed outcomes:

- `assist_required`
- `assist_not_required`

Allowed reason codes:

- `semantic_ir_bounded_ambiguity`
- `translation_unsupported_repairable`
- `baseline_open_assumptions`
- `deterministic_candidate_low_confidence`
- `caller_explicit_opt_in`
- `caller_did_not_opt_in`
- `assist_budget_exhausted`

Allowed selected agent role:

- `transformation_agent`

`assist_required` must carry `selectedAgentRole=transformation_agent`.
`assist_not_required` must carry `selectedAgentRole=null`.

## Budgets

The contract exposes:

- `repairBudget`
- `assistBudget`
- `modelInvocationBudget`

Each budget has:

```json
{ "limit": 2, "used": 0, "remaining": 2 }
```

Current defaults and bounds:

- repair: default `2`, allowed `1..3`;
- assist: default `1`, allowed `1..3`;
- model invocation: default `6`, allowed `1..20`.

Budget exhaustion stops the relevant loop. It must not silently continue or
promote a run to success.

## Final Classifications

- `success`: generated Java compiled, ran, matched the oracle where defined,
  hashes are consistent, and evidence is complete.
- `blocked`: a known workflow gate stopped the run.
- `failed`: unexpected workflow or service failure.
- `cancelled`: caller, policy, or hard limit cancelled the run.
- `incomplete`: evidence or required artifacts are missing.

Any non-`success` classification carries a failure code.

## Evidence Requirements

Successful W0.3 evidence includes references for:

- source COBOL;
- Semantic IR;
- generated Java candidate history;
- selected final Java;
- build/test result;
- oracle comparison where defined;
- assist decision when the gate fired;
- budget summary;
- model invocation ledgers or policy-skipped entries;
- trajectory and Harness event references.

Evidence incompleteness blocks verified success.

## API Surface

The Orchestrator exposes `GET /v0/runs/{runId}/workflow`. The BFF exposes the
consumer view at `GET /api/v0/runs/{runId}/workflow`.

W0.3 fields are additive over the W0.2 contract:

- `assistDecision`
- `assistBudget`
- `modelInvocationBudget`

Consumers must tolerate `assistDecision=null` before the gate fires and missing
W0.3 fields for older persisted runs.
