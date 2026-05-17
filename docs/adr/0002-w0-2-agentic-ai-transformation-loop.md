# ADR 0002: W0.2 Agentic AI Transformation Loop

**Date:** 2026-05-16
**Status:** Accepted

## Context

W0 and W0.1 delivered a deterministic COBOL-to-Java path and the Studio/BFF
surface. c2c still needed the first productive AI participation without
weakening deterministic proof.

## Decision

W0.2 introduced an Orchestrator-owned agent workflow:

- Studio talks to the BFF.
- BFF starts an Orchestrator run.
- The Orchestrator invokes deterministic services and bounded agents.
- Agents call models only through the Model Gateway.
- The Harness records registry, policy, events, ledgers, and Experience
  Learning signals.
- Build/test/oracle/evidence still decide success.

Initial productive roles:

- Transformation Agent: proposes or improves Java candidates.
- Verification/Repair Agent: proposes bounded repairs after verification
  failures.

## Non-Goals

W0.2 did not claim broad COBOL coverage, customer production readiness,
autonomous workflow optimization, multiple production agent teams, multiple
production orchestrators, or target languages beyond Java.

## Consequences

- Deterministic and AI-assisted work remain one Orchestrator-owned product
  path.
- Harness is infrastructure and learning substrate, not workflow controller.
- Model Gateway became mandatory for productive model calls.
- Agent trajectory and model invocation records became part of evidence.
- W0/W0.1 no-model gates remain valid.

## Current Follow-Up

W0.3 keeps this decision and hardens activation semantics: productive AI now
requires an explicit Orchestrator assist decision.
