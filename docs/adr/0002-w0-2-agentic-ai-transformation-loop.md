# ADR 0002: W0.2 Agentic AI Transformation Loop

**Date**: 2026-05-15
**Status**: Proposed
**Issue**: [#164](https://github.com/oscharko-dev/c2c-PreBeta/issues/164)

## Context

W0 and W0.1 intentionally delivered a deterministic COBOL-to-Java path first:
parser, Semantic IR, target Java generation, compile/run, equivalence check,
Evidence Pack, Harness events, Experience Learning surfaces, BFF, and Next.js
Studio.

That foundation is necessary but not sufficient for the c2c product intent.
c2c is positioned as AI-first. The next wave must therefore introduce the first
productive AI participation in the transformation path, while preserving the
deterministic success gate.

The Harness is a central differentiator for this architecture. It is not only
the infrastructure and governance layer for agents; it is the Experience
Learning system that records operational experience, detects useful and harmful
patterns, and exposes learning signals back to orchestrators and agents. This
must be designed without turning the Harness into the workflow controller.

## Decision

W0.2 will introduce a small orchestrator-steered agent workflow running on the
Experience Learning Harness:

1. The Studio still calls only the c2c BFF.
2. The BFF starts a transformation run through the orchestrator.
3. The orchestrator acts as a Harness consumer and controls the workflow.
4. Agents use Harness-provided tools, registries, ledgers, policy hooks, and
   experience signals.
5. Agents call models only through model-gateway-service.
6. Development model access is via approved Microsoft Foundry configuration.
7. The initial workflow has two productive agent roles:
   - Transformation Agent: creates or improves Java from COBOL, parser output,
     Semantic IR, and target-runtime contracts.
   - Verification/Repair Agent: consumes compile/runtime/equivalence feedback
     and proposes bounded repairs.
8. Multiple orchestrators and agent teams must be able to run on the same
   Harness without turning the Harness itself into the workflow controller.
9. The Harness records events, model invocations, policy decisions, tool usage,
   agent trajectories, repair attempts, and verification outcomes as experience
   data.
10. The Harness exposes first read-only Experience Learning signals in W0.2,
   such as repeated failure patterns, no-change repairs, repair-loop depth,
   tool/capability usage, and model outcome summaries.
11. The repair loop has a hard iteration limit.
12. A run can be marked verified only after deterministic build/test/evidence
   gates pass.

## Non-Goals

W0.2 does not deliver broad COBOL coverage, customer production readiness,
autonomous test-generation maturity, full Experience Learning feedback loops,
autonomous workflow optimization, or enterprise multi-agent optimization. Those
remain later-wave concerns. W0.2 must still create the structured experience
records and first read-only learning signals that later waves will build on.

## Consequences

- The deterministic W0 core remains the authoritative verifier.
- The first completed model invocations must appear in model invocation ledgers.
- Agent trajectory records become part of the Evidence Pack for W0.2 runs.
- Experience Learning records become part of the Harness value proposition:
  they capture tool outcomes, model outcomes, repair behavior, repeated
  non-progress, and verification results for later optimization.
- The Orchestrator may consume Harness learning signals, but still owns workflow
  control, repair-loop decisions, aborts, and final run classification.
- UI progress must distinguish deterministic steps, model-guided agent work,
  and repair attempts.
- No browser-visible model credentials or internal service URLs are allowed.
- The model gateway and Foundry configuration become critical path for W0.2,
  but W0/W0.1 no-model gates remain valid and must continue to pass.

## References

- [c2c Fachkonzept](../concept/c2c-fachkonzept.md)
- [development workflow](../governance/development-workflow.md)
- [model gateway service](../model-gateway-service/README.md)
- [W0 release gate](../release/w0-release-gate.md)
- [W0.1 Studio closure evidence](../release/w0-studio-epic-118.md)
