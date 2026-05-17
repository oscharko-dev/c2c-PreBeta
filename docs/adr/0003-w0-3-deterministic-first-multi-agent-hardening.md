# ADR 0003: W0.3 Deterministic-First Multi-Agent Hardening

**Date**: 2026-05-17
**Status**: Accepted
**Issue**: [#211](https://github.com/oscharko-dev/c2c-PreBeta/issues/211)
**Related issues**: [#212](https://github.com/oscharko-dev/c2c-PreBeta/issues/212)

## Context

W0.2 established the first productive AI-assisted COBOL-to-Java workflow on the
Experience Learning Harness. That wave deliberately proved the minimum viable
agentic product path:

- Studio submits source through the BFF;
- the Orchestrator owns the workflow contract;
- deterministic parser, Semantic IR, generator, build/test, and evidence still
  decide success;
- productive Transformation and Verification/Repair Agents can participate
  through the Model Gateway;
- bounded repair and first Experience Learning signals exist end-to-end.

That foundation is correct, but the current W0.2 architecture still leaves too
much room for ambiguous activation semantics around productive AI. In
particular, the platform now needs a stronger product and architecture stance on
the following points:

- deterministic processing must remain the default and first path for every run;
- productive AI must not be activated merely because model infrastructure is
  available;
- the Orchestrator must publish an explicit decision for when AI assist is
  required and why;
- agent budgets, retry semantics, and acceptance criteria must be more visible
  and more strictly governed;
- the Studio and Evidence Pack must distinguish "AI participated" from
  "deterministic verification succeeded";
- wave planning must treat this hardening as the next architectural step, not
  as an incidental W0.2 patch.

W0.3 therefore needs to sharpen the system from "first productive agent loop
exists" to "productive multi-agent behavior is deterministic-first, explicitly
authorized, contract-driven, and evidence-complete."

## Decision

W0.3 is defined as the **deterministic-first multi-agent hardening wave** for
c2c.

The governing architectural rules are:

1. Every product transformation run executes the deterministic baseline first:
   source normalization, COBOL parsing, Semantic IR generation, deterministic
   Java baseline generation, and the first deterministic verification decision.
2. Productive AI participation is activated only through an explicit
   Orchestrator-owned **assist decision gate** that records:
   - whether assist is required;
   - the reason code;
   - the affected artifacts or uncertainty markers;
   - the selected agent role;
   - the remaining relevant budget.
3. Productive Transformation Agent calls are no longer availability-driven.
   Model infrastructure being reachable is not itself a reason to invoke a
   transformation agent.
4. Verification/Repair remains bounded and deterministic-gated. Every repaired
   candidate must re-enter deterministic build/test/oracle/evidence checks.
5. The Orchestrator continues to own all workflow control, retry budgets,
   cancellations, acceptance of candidates, and final classification.
6. The Harness continues to provide infrastructure, registries, policy,
   ledgers, events, and Experience Learning signals, but does not decide the
   next workflow step.
7. The Model Gateway remains the only permitted model boundary.
8. Studio, BFF, contracts, release gates, and Evidence Pack semantics must all
   reflect the stronger distinction between:
   - deterministic baseline work,
   - authorized AI assistance,
   - deterministic verification,
   - final product classification.

W0.3 does **not** introduce:

- an LLM global orchestrator;
- multiple production orchestrators;
- autonomous Experience Learning decisioning;
- unbounded agent teams;
- AI-defined success semantics;
- a replacement of deterministic verifier services.

## Rationale

- This keeps the core c2c promise credible for regulated workloads: AI is
  productively important, but deterministic proof remains authoritative.
- It corrects the main ambiguity that remains after W0.2: AI participation must
  be justified by workflow state, not by system availability.
- It turns multi-agent behavior into an auditable control system rather than a
  convenience path.
- It improves the product story for customers: AI is visible and valuable, but
  the system still fails honestly and proves successful runs deterministically.
- It creates a much better foundation for later waves, where broader COBOL
  coverage and larger agent teams would otherwise amplify ambiguity.

## Consequences

- W0.3 work must update the Fachkonzept, README wave summary, workflow
  governance, Orchestrator workflow contract, and any relevant release-gate or
  runbook documents.
- The BFF/product path must stop implicitly enabling productive transformation
  assist solely from model-gateway availability.
- The Orchestrator workflow contract must grow explicit assist-decision
  semantics and associated evidence references.
- Evidence Pack and Studio views must expose the cause and scope of AI
  participation more clearly. W0.3-6 (#217) lands this for the Evidence Pack
  by adding `artifacts.assistDecision` (mirror of the Orchestrator-owned
  decision: outcome, reason code, agent role, gate-time budget snapshots,
  optional rationale) and `artifacts.budgetSummary` (end-of-run consumption
  of the three bounded W0.3 budgets). Both are wired into the W0.2 required
  artifact set and into the W0.2 release-gate validator so reviewers can
  audit "was AI required, why, and against which budgets?" from the pack
  alone; the deterministic-first rule that evidence incompleteness blocks
  verified success is preserved unchanged.
- Coverage expansion remains important, but moves behind this architectural
  hardening in wave sequencing. W1 can then scale coverage and enterprise
  hardening on top of a cleaner control model.

## References

- [c2c Fachkonzept](../concept/c2c-fachkonzept.md)
- [ADR 0002: W0.2 Agentic AI Transformation Loop](0002-w0-2-agentic-ai-transformation-loop.md)
- [Orchestrator W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md) — canonical W0.3 run-contract reference (Issue [#222](https://github.com/oscharko-dev/c2c-PreBeta/issues/222)).
- [Orchestrator W0.2 Workflow Contract](../contracts/orchestrator-w02-workflow.md) — retained for historical W0.2 wording.
- [c2c-bff W0.2/W0.3 API contract](../c2c-bff/w0.2-api-contract.md) — BFF surface wrapping the W0.3 run contract.
- [W0.3 Reference Runbook](../showcase/w0-3-reference-runbook.md) — procedural verification of this ADR (Issue [#222](https://github.com/oscharko-dev/c2c-PreBeta/issues/222)).
- [W0.2 Epic #164 Closure Evidence](../release/w0-2-epic-164.md)
- [Development Workflow Governance](../governance/development-workflow.md)
