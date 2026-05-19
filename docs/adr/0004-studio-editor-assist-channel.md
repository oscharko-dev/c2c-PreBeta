# ADR 0004: Studio Editor-Assist-Channel Architecture

**Date:** 2026-05-18
**Status:** Accepted

## Context

Epic [#239](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
introduces an in-editor action **"C2C: Explain this region"** that
calls the Model Gateway with a user-selected COBOL or Java region.
Implementation is the responsibility of Studio-IDE-10 ([#249](https://github.com/oscharko-dev/c2c-PreBeta/issues/249));
the architecture is settled here so implementation can start without
remaining ambiguity.

[ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](0003-w0-3-deterministic-first-multi-agent-hardening.md)
and the [W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
require every Model Gateway call to:

- be triggered by an explicit Orchestrator decision OR be transparently
  bounded by a visible budget and visible ledger entry;
- land in the evidence ledger with a model-invocation reference;
- never bypass the Model Gateway boundary.

Three architectures were considered.

### Option A — New Orchestrator state `editor_assist_invoked`

Each Explain call becomes a small Orchestrator run. A new state lands
on the workflow state machine in `services/orchestrator-service/src/orchestrator_service/run_contract.py`.

- **Pros**: maximally consistent with "Orchestrator owns workflow";
  audit trail uniform with productive transformation runs.
- **Cons**: heavy; adds latency; pollutes the state machine with a
  non-transformative action; multi-Explain in one editing session
  creates many short runs; requires a `success` semantics for runs
  that produce no Java candidate, no oracle comparison, and no
  evidence pack.

### Option B — Dedicated out-of-band BFF path with own budget (chosen)

A new BFF endpoint `POST /api/v0/editor/explain` calls the Model
Gateway directly under a new dedicated `editorAssistBudget`. Each call
writes a ledger entry of `kind=editor_assist` into the same trajectory
ledger pipeline used by productive runs. The channel is **non-productive**:
its output never enters the success path, never produces a Java
candidate, and never participates in deterministic verification.

- **Pros**: lightweight; explicit budget; auditable; does not pollute
  the Orchestrator state machine; does not consume the
  `modelInvocationBudget` of an in-progress run; works when no run is
  active (the common case for greenfield Studio).
- **Cons**: introduces a parallel governed model-call path that must
  stay aligned with the productive path on prompt policy, redaction,
  and model selection; requires a new budget contract field, a new
  ledger kind, and an explicit "parallel-governed, not exempt"
  doctrine.

### Option C — Consume the current run's `modelInvocationBudget`

The Explain call consumes a unit from the existing per-run
`modelInvocationBudget` (default 6, range [1..20]).

- **Pros**: smallest contract change.
- **Cons**: editor actions steal budget from verification and repair;
  surprising interaction; hard to reason about post-mortem; couples
  editor sessions to a specific `runId`; **impossible** when no run is
  active (greenfield Studio open).

## Decision

C2C Studio uses **Option B**: a parallel-governed editor-assist channel
in the BFF with its own budget, its own ledger entry kind, and an
explicit non-productive contract.

### `editorAssistBudget`

Same shape as the existing W0.3 budgets:

```json
{ "limit": 3, "used": 0, "remaining": 3 }
```

- **Default**: `3`.
- **Allowed range**: `[1..10]`.
- **Scope**: per BFF-derived `(tenantId, userId, authSessionId)`.
  `tenantId` and `userId` come from the active `c2c.sid` session
  cookie, never from request body authority. The request still carries
  a client-issued Studio editor `sessionId` for UI correlation and
  ledger readability, but budget enforcement is keyed to the
  server-issued session identifier. The BFF additionally caps total
  editor-assist calls per `(tenantId, day)` to prevent abuse via
  session-ID minting.
- **Independence**: `editorAssistBudget` is **not** consumed by, and
  does not consume from, `repairBudget`, `assistBudget`, or
  `modelInvocationBudget`. It does not appear in the run-contract
  payload returned by `GET /v0/runs/{runId}/workflow`.

The default and range are intentionally tighter than
`modelInvocationBudget` (default 6, range [1..20]). Productive runs
are expensive and intentional; editor-assist is cheap and abuse-prone.

### `editor_assist` ledger entry

Editor-assist calls write a dedicated ledger entry of `kind=editor_assist`
into the trajectory ledger pipeline. The entry uses a new
`editorAssistRef` field and does **not** reuse `modelInvocationRef`.
Reusing `modelInvocationRef` would force consumers to learn a second
meaning for the same key — a boundary violation. Distinct keys keep
the audit query "find all model invocations triggered by editor
activity" trivial.

Sketch payload (mirrors the existing model-invocation ledger entry
where semantics line up):

```json
{
  "schemaVersion": "v0",
  "kind": "editor_assist",
  "ledgerEntryId": "eai-{tenantId}-{sessionId}-{seq}",
  "invocationId": "mi-{uuid}",
  "tenantId": "...",
  "userId": "...",
  "sessionId": "studio-session-...",
  "requestSource": "editor",
  "requestRegion": {
    "sourceKind": "cobol",
    "artifactRef": null,
    "startLine": 120,
    "endLine": 168,
    "byteHash": "sha256:..."
  },
  "redactedFields": ["customerName", "accountNumber"],
  "modelId": "...",
  "provider": "foundry-development",
  "policyId": "...",
  "policyDecision": "allowed",
  "promptTemplateId": "editor-explain-v1",
  "promptTemplateVersion": "1.0.0",
  "ledgerRef": "urn:c2c/editor-assist/{tenantId}/{sessionId}/{seq}",
  "budgetSnapshot": { "limit": 3, "used": 2, "remaining": 1 },
  "startedAt": "...",
  "endedAt": "...",
  "status": "success",
  "failureCode": null,
  "runIdRef": null
}
```

Field semantics:

- `kind` is the constant `"editor_assist"`.
- `requestSource` is the constant `"editor"`. The field exists to
  distinguish trajectory entries by trigger surface when filtering the
  ledger across kinds.
- `requestRegion.sourceKind` is `"cobol"` or `"java"`.
- `requestRegion.filePath` is workspace-relative only; absolute paths,
  drive prefixes, and parent-directory traversal are rejected before any
  Model Gateway call or ledger write.
- `requestRegion.byteHash` is a SHA-256 of the selected region bytes;
  it lets auditors confirm what content was sent to the model without
  storing the content itself in the ledger.
- `redactedFields[]` lists the field names the Model Gateway redactor
  stripped before transmission, mirroring the existing model-invocation
  ledger so the same redaction tooling applies.
- `ledgerEntryId` equals `editorAssistRef` so every editor-assist
  entry has one stable, user-visible correlation key. `ledgerRef`
  points at the durable ledger record written by the BFF or returned
  by the Model Gateway.
- `budgetSnapshot` records the post-consume snapshot of the
  `editorAssistBudget` so each entry is independently audit-readable.
- `runIdRef` is optional and informational. If a run happened to be
  open when the user clicked Explain, it is recorded for diagnostic
  value, but it does not imply any contract relationship — the
  evidence pack for that run does **not** include this entry.

### API surface

- `POST /api/v0/editor/explain` (BFF) — submit a region for
  explanation. Request body carries the client-issued editor
  `sessionId`, `requestRegion`, and the redaction profile. The BFF
  derives `tenantId` and `userId` from the active `c2c.sid` session
  cookie; optional legacy body copies must match that session. Response
  carries the natural-language explanation, the post-consume
  `budgetSnapshot`, the `redactedFields[]`, and the `ledgerRef` to the
  written entry.
- `GET /api/v0/editor/budget` (BFF) — return the current
  `editorAssistBudget` for the active session-derived budget scope.

The Orchestrator exposes **no** editor-assist surface. The Orchestrator
state machine is unchanged.

### W0.3 Workflow Contract update

The contract document gains a new invariant, a new
**Parallel-Governed Channels** section, an explicit exclusion in
**Evidence Requirements**, and the two new BFF endpoints under
**API Surface**. The Orchestrator state machine, the assist-decision
contract, and the existing per-run budgets are not changed.

## Rationale

**Why Option B over Option A.** The W0.3 invariants are anchored on a
_productive_ run: `success` requires deterministic verification, the
evidence pack is materialised, and an `assistDecision` is recorded
with a `reasonCode` from a closed enum. None of those concepts have a
meaningful value for an Explain action. Forcing Explain through a
real Orchestrator run would pollute `WORKFLOW_STATES` with a state
that can never reach `final_classification=success` (Explain produces
no Java candidate, no oracle match, no evidence pack), would require
a new `reasonCode` that does not match the gate semantics, and would
couple editor UX latency to orchestrator throughput. It buys uniform
audit at the cost of distorting the workflow contract.

**Why Option B over Option C.** `modelInvocationBudget` is per-run.
Editor-assist must work when no run is active (greenfield Studio open
is the common case). Even when a run is active, letting Explain
consume the run's productive budget changes the outcome of
`assist_budget_exhausted` decisions based on UI activity — a
correctness bug. W0.3's premise is that productive AI participation
is explicit and bounded; coupling productive headroom to editor
interaction violates "explicit".

**Why a distinct ledger kind and `editorAssistRef`.** `modelInvocationRef`
is part of the productive-agent response contract; it binds an
agent's output to its underlying model call so the evidence pack can
chain them. Editor-assist has no agent and no productive output.
Distinct keys keep both the consumer code paths and the audit queries
clean.

**Why per-session plus per-tenant-per-day.** Per-session alone is not
enough — a runaway client can mint fresh session IDs and defeat the
limit. The per-tenant-per-day ceiling is the real abuse boundary.
Per-user-per-day is a nice-to-have but not load-bearing.

**Why non-productive is load-bearing in the contract.** Explicitly
declaring that editor-assist output never enters the success path is
what justifies bypassing the assist-decision gate. The moment Explain
ever proposes a productive artifact (a Java replacement, an IR patch),
this architecture must be revisited; that proposal must route through
a real Orchestrator run.

## Consequences

### Becomes easier

- Studio can offer "Explain this region" without coupling to any
  active run, including the common greenfield case.
- Each editor-assist call carries a self-contained budget snapshot,
  redaction list, and ledger reference — auditable in isolation.
- Productive runs are insulated: heavy Explain usage in a session
  cannot starve the next transformation run's
  `modelInvocationBudget`.
- The audit query "find all model invocations triggered by editor
  activity" is a single `kind=editor_assist` filter.

### Becomes harder

- The BFF now owns a parallel governed model-call path that must
  stay aligned with the productive path on policy, redaction, and
  model selection. Divergence risk is mainly in **prompt templates**,
  since both paths share the Model Gateway boundary. This is an
  accepted cost.
- The evidence service must index editor-assist entries by
  `(tenantId, sessionId, createdAt)` rather than by `runId`. The
  trajectory ledger's natural per-run ordering is insufficient for
  editor-assist access patterns.

### Operational notes

- **Replay**: editor-assist explanations are not replayed
  deterministically. The ledger entry is durable so legal and
  compliance can answer _"did this user invoke a model on this region
  at this time?"_, but the natural-language output itself is not
  treated as a reproducible artifact.
- **PII**: the user picks the region, so a careless selection could
  send customer data to the model. Editor-assist relies on the **same
  Model Gateway redaction layer** as productive paths; the
  `redactedFields[]` audit list mirrors the productive ledger.
- **Concurrency**: when two Explain calls race in the same session,
  the second response's `remaining` count must reflect the first.
  The BFF serialises per-session budget consumption (or uses an
  atomic decrement) so `budgetSnapshot` values are linearisable.

### Required follow-up

- Implementation lands in Studio-IDE-10 ([#249](https://github.com/oscharko-dev/c2c-PreBeta/issues/249)).
- The [W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
  is updated in the same PR as this ADR.
- Studio surfaces the `budgetSnapshot` and `redactedFields[]` in the
  Explain side-panel per Epic [#239](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
  acceptance criteria.

### Reversibility

This architecture stands until editor-assist begins producing
**productive** artifacts (a Java replacement, an IR patch, a verified
candidate). At that point the non-productive framing collapses and
the action must route through a real Orchestrator run under the
existing assist-decision gate. A successor ADR captures that
transition if and when it happens.

## References

- Issue: [Studio-ADR-1 Editor-Assist-Channel Architecture (#242)](https://github.com/oscharko-dev/c2c-PreBeta/issues/242)
- Parent epic: [IDE-Grade Modernization Editing Experience (#239)](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
- Implementation slice (blocked on this ADR): [Studio-IDE-10 Editor-Assist-Channel (#249)](https://github.com/oscharko-dev/c2c-PreBeta/issues/249)
- [ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](0003-w0-3-deterministic-first-multi-agent-hardening.md)
- [W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
- Code source of truth for budgets:
  `services/orchestrator-service/src/orchestrator_service/run_contract.py`
- Existing model-invocation ledger pattern:
  `services/orchestrator-service/src/orchestrator_service/transformation_agent.py`
