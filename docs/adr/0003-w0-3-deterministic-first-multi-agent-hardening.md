# ADR 0003: W0.3 Deterministic-First Multi-Agent Hardening

**Date:** 2026-05-17
**Status:** Accepted

## Context

W0.2 proved the first productive AI loop. The remaining risk was ambiguity:
productive AI could look availability-driven instead of decision-driven.

## Decision

W0.3 makes productive AI participation explicit and bounded.

Rules:

- deterministic baseline runs first;
- model availability alone does not activate productive agents;
- the Orchestrator records an assist decision before transformation assist;
- assist and repair consume visible budgets;
- repaired or AI-generated candidates re-enter deterministic verification;
- Evidence and UI show why AI was used;
- `success` still requires deterministic verification and complete evidence.

## Rationale

Regulated customers need AI to be useful and auditable. The product must prove
that AI helped without letting AI define correctness.

## Consequences

- BFF stops enabling transformation assist from Model Gateway availability
  alone.
- Orchestrator workflow contract exposes `assistDecision`, `assistBudget`, and
  `modelInvocationBudget`.
- Evidence Pack lineage includes assist decisions and budget usage.
- Studio distinguishes deterministic-only and AI-assisted runs.

## References

- GitHub Epic: https://github.com/oscharko-dev/c2c-PreBeta/issues/211
- W0.3 contract: ../contracts/orchestrator-w03-workflow.md
