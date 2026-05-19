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
- Editor-assist invocations are a parallel-governed model channel. They go
  through the Model Gateway boundary, write to the same ledger pipeline, and
  are not part of any run's success determination or evidence pack.

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

Manual-edit provenance does not gate classification. A run whose final
Java buffer contains hand-edited regions classifies exactly as today
once deterministic build/test/oracle have run; the regional provenance
is recorded for audit, not for proof. See
[ADR 0007 — Studio Java Manual-Edit Provenance & Verification Model](../adr/0007-studio-java-manual-edit-provenance.md).

## Manual-Edit Provenance

[ADR 0007](../adr/0007-studio-java-manual-edit-provenance.md) extends
the run summary with two additive fields the orchestrator stamps when
the run finalises:

- `manualEditsCarriedOver: boolean` — true iff the verified Java
  contained at least one `manual_modified` or `manual_edit` region.
- `manualDriftRegionCount: integer` — number of regions whose
  `originClass` is `manual_modified` or `manual_edit`. Zero when
  `manualEditsCarriedOver` is false.

Both fields are optional on the wire. Consumers reading older
persisted runs that pre-date ADR 0007 MUST treat absence as `false`
and `0` respectively (per
[ADR 0006 §4](../adr/0006-studio-bff-contract-versioning.md)).

### Assist-Interaction Rule for Manual Regions

A region whose `originClass` is `manual_modified` or `manual_edit`
downgrades any subsequent assist activity that targets it:

- The Verification/Repair Agent MUST NOT propose changes to the
  region unless the assist decision for the run carries
  `reasonCode = caller_explicit_opt_in`. Every other reason code in
  the closed set above is a soft no-op for the region; the
  orchestrator records a `no_change` repair attempt scoped to the
  region.
- The closed set of `assistDecision.reasonCode` values is unchanged.
  ADR 0007 reuses `caller_explicit_opt_in`; no new reason code is
  introduced.
- Editor-assist (`POST /api/v0/editor/explain`) is unaffected — it
  is a parallel-governed channel and produces no `assistDecision`.

The five-class origin taxonomy, the per-region metadata schema, and
the lineage semantics that go with manual regions live in ADR 0007;
this contract document records only the run-summary shape and the
agent-interaction rule that consumers of the workflow contract need.

## Parallel-Governed Channels

Some Studio actions invoke the Model Gateway outside of a run. They are
non-productive: their output never enters a run's success determination,
never produces a Java candidate, and never participates in deterministic
verification. They are governed by their own budgets and write their own
ledger entries.

### Editor-Assist Channel

Architecture decided in
[ADR 0004 — Studio Editor-Assist-Channel](../adr/0004-studio-editor-assist-channel.md).
The action `C2C: Explain this region` (Studio-IDE-10) submits a selected
COBOL or Java region to the Model Gateway via the BFF.

`editorAssistBudget` shape:

```json
{ "limit": 3, "used": 0, "remaining": 3 }
```

- Default: `3`.
- Allowed range: `[1..10]`.
- Scope: per BFF-derived `(tenantId, userId, authSessionId)`.
  `tenantId` and `userId` come from the active `c2c.sid` session
  cookie. The request still carries a client-issued Studio editor
  `sessionId` for UI correlation and ledger readability, but budget
  enforcement is keyed to the server-issued session identifier. The BFF
  additionally enforces a per-`(tenantId, day)` ceiling to prevent abuse
  via session-ID minting.

`editorAssistBudget` is independent of `repairBudget`, `assistBudget`, and
`modelInvocationBudget`. It does not appear in the run-contract payload
returned by `GET /v0/runs/{runId}/workflow`.

Editor-assist calls write a ledger entry of `kind=editor_assist` and use a
dedicated `editorAssistRef` field; they do not reuse `modelInvocationRef`.
Each entry carries the post-consume `budgetSnapshot`, the
`redactedFields[]` produced by the union of Studio-side and Model Gateway
redactors, the `requestRegion` (`sourceKind`, line range, and the SHA-256
`byteHash` of the bytes actually sent to the model — i.e. post-Studio
redaction per [ADR 0005](../adr/0005-studio-local-persistence-security-boundary.md)
§4), and an optional informational `runIdRef` when a run happens to be
open at the time of the call.
`requestRegion.filePath` is workspace-relative only; absolute paths, drive
prefixes, and parent-directory traversal are rejected so local workstation
paths do not reach the Model Gateway or ledger.

The BFF default deployment appends these entries to an on-disk JSONL ledger at
`var/c2c-local/trajectory-ledger/editor-assist.jsonl` (overridable by
`C2C_EDITOR_ASSIST_LEDGER_PATH`, constrained inside `C2C_REPO_ROOT`). Test
deployments may inject an equivalent sink, but the route must not silently
discard accepted editor-assist entries.

The Orchestrator exposes no editor-assist surface; the state machine is
unchanged. An editor-assist call does not produce an `assistDecision` and
does not advance any run state.

#### Error-Code Closed Set and HTTP Status Mapping

The BFF returns one of the following error codes for failed editor-assist
calls. The set is closed: consumers MUST treat any other value as a
forward-compatibility violation. Upstream error text is never echoed into
`message`; the BFF emits a fixed user-facing string for each code.

| `errorCode`           | HTTP status | When                                                                                                                                     |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_region`      | 400         | Malformed payload, region out of bounds, `redactedBytes` empty or above the BFF size cap, or `byteHash` recompute mismatch.              |
| `policy_denied`       | 403         | Model Gateway returned 403 (policy guardrail rejected the region or context), the editor-assist session cookie is unavailable, or optional request identity does not match the active session. |
| `budget_exhausted`    | 429         | Per-session `editorAssistBudget` exhausted, or per-`(tenantId, day)` ceiling reached.                                                    |
| `gateway_unavailable` | 503         | Model Gateway disabled (`modelGateway.enabled === false`), 5xx from the gateway, transport failure, 2xx without a usable explanation, or editor-assist ledger sink unavailable. |
| `timeout`             | 504         | Model Gateway returned 504, or the BFF-side timeout elapsed before a response arrived.                                                   |

Error response body shape:

```json
{
  "schemaVersion": "v0",
  "errorCode": "budget_exhausted",
  "message": "Editor-assist budget exhausted for this session. Try again later or request more from your administrator.",
  "budgetSnapshot": { "limit": 3, "used": 3, "remaining": 0 }
}
```

`budgetSnapshot` is `null` for errors raised before the per-session budget
was consulted (e.g. `invalid_region`, or `gateway_unavailable` from the
disabled-gateway fast-path); it is the post-decision snapshot otherwise.

#### Trust model and known gaps

The editor-assist channel requires the same `c2c.sid` session cookie used by
`POST /api/v0/session/bootstrap`. The BFF derives `tenantId` and `userId` from
that server-side session record; optional legacy body/query copies are
validated only as echoes and must match the active session. A caller cannot
mint new tenant identities through the editor-assist body or budget query.

Remaining reduced-trust items are outside this channel: fixture session sign-in
is still a dev-mode bootstrap surface and MUST be disabled behind a real IdP
integration (`C2C_ENABLE_FIXTURE_SESSIONS=false`), and connection-level
rate-limiting for editor-assist calls remains a follow-up.

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

Editor-assist ledger entries (`kind=editor_assist`) are not included in a
run's evidence pack, even when issued during the run's lifetime. They live
in the trajectory ledger as a parallel-governed channel and are accessed
through editor-assist audit queries, not run evidence.

## API Surface

The Orchestrator exposes `GET /v0/runs/{runId}/workflow`. The BFF exposes the
consumer view at `GET /api/v0/runs/{runId}/workflow`.

W0.3 fields are additive over the W0.2 contract:

- `assistDecision`
- `assistBudget`
- `modelInvocationBudget`
- `manualEditsCarriedOver` (ADR 0007; defaults to `false` when absent)
- `manualDriftRegionCount` (ADR 0007; defaults to `0` when absent)

Consumers must tolerate `assistDecision=null` before the gate fires and missing
W0.3 fields for older persisted runs.

## Contract Versioning

The Studio-BFF DTO contract follows the policy in
[ADR 0006 — Studio-BFF Contract Versioning](../adr/0006-studio-bff-contract-versioning.md).
The rules consumers depend on:

- **Explicit `schemaVersion`** on the evolving DTOs (`Diagnostic`,
  `GeneratedTraceability`, `RunSummary`, `JavaOriginOverlay`). Optional on the
  wire; absence means `"v0"`.
- **Additive-only at minor wave boundaries.** New optional fields may be added
  without a `schemaVersion` bump. Removal of an existing field requires a
  deprecation period of at least one minor wave (e.g. deprecate in W0.3,
  remove in W1.1).
- **Forward compatibility.** Studio MUST NOT crash on unknown DTO fields or
  unknown enum values from a future BFF. Unknown fields are preserved through
  opaque pass-through where they may be needed in trace artifacts.
- **Null-field fallback rules** are enumerated per field in ADR 0006
  Decision 4. The principal cases:
  - `Diagnostic.line` absent → marker placed at file level, no source jump.
  - `Diagnostic.column` absent → marker spans the whole line.
  - `Diagnostic.artifactRef` absent → no "jump to artifact" affordance.
  - `GeneratedTraceability` absent → lineage UI shows "Lineage unavailable".
  - `RunSummary.javaRegionClassification` absent → no trust-pillar decoration;
    Studio does not infer regions.
- **Evidence-Pack replay** (W1 forward-look): the Studio that lands W0.3 work
  must already today handle `v0` fixtures without crashes. The Studio test
  suite pins this with a `v0` fixture regression.

The BFF additionally exposes the editor-assist channel (per
[ADR 0004](../adr/0004-studio-editor-assist-channel.md)):

- `POST /api/v0/editor/explain` — submit a region for explanation. The BFF
  derives `tenantId` and `userId` from the active `c2c.sid` session cookie.
- `GET /api/v0/editor/budget` — return the current `editorAssistBudget`
  for the active session-derived budget scope.

The Orchestrator has no editor-assist surface.
