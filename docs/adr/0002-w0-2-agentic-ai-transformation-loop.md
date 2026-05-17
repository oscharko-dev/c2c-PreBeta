# ADR 0002: W0.2 Agentic AI Transformation Loop

**Date**: 2026-05-16
**Status**: Accepted
**Issue**: [#164](https://github.com/oscharko-dev/c2c-PreBeta/issues/164)
**Related issues**: [#165](https://github.com/oscharko-dev/c2c-PreBeta/issues/165)

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

W0.2 introduces a small orchestrator-steered agent workflow running on the
Experience Learning Harness. The controlling architecture is
**deterministic-first, one workflow path through the global Orchestrator**:

1. The Studio still calls only the c2c BFF.
2. The BFF starts a transformation run through the orchestrator.
3. The global Orchestrator acts as a Harness consumer and controls the
   workflow. It is a deterministic state machine, not an LLM.
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
13. Deterministic services do not form a side path. Parser, Semantic IR,
    target generation, build/test, evidence, and policy checks are invoked
    under Orchestrator control and recorded in the same run contract as
    AI-assisted steps.
14. LLM-based supervisors, planners, or Agent Team Leads are allowed only as
    bounded sub-orchestrators inside an Orchestrator-approved step. They may
    coordinate specialist agents for larger modules in later waves, but they
    never replace the global Orchestrator, never bypass the Harness or Model
    Gateway, and never make final success claims.

## Non-Goals

W0.2 does not deliver broad COBOL coverage, customer production readiness,
autonomous test-generation maturity, full Experience Learning feedback loops,
autonomous workflow optimization, or enterprise multi-agent optimization. W0.2
also does not deliver multiple production agent teams, multiple production
orchestrators, or an LLM-based global orchestrator, and does not add target
languages beyond Java. The platform architecture must keep later agent-team
and bounded sub-orchestrator patterns open, but the W0.2 release ships exactly
one deterministic global Orchestrator, one initial agent workflow, and the
COBOL-to-Java path. Those remain later-wave concerns. W0.2 must still create
the structured experience records and first read-only learning signals that
later waves will build on.

## Failure States

Product-mode W0.2 runs must surface real failure states instead of inventing
successful outputs. The implementation must represent and distinguish:

- parse failure;
- unsupported COBOL (parseable but outside the W0/W0.2 subset);
- model gateway unavailable;
- model policy denial;
- agent timeout;
- compile failure;
- runtime failure;
- oracle mismatch against the Golden Master;
- incomplete evidence;
- cancellation by user, policy, or hard repair-loop limit.

Each state must be visible in the Studio, recorded in run artifacts and
Evidence Pack, and distinguishable from a verified-success run.

## Named Contracts

W0.2 implementation issues will design and version the following contracts.
This ADR names them so that future ADRs and issues can reference a stable
vocabulary:

- **Orchestrator run contract**: BFF↔Orchestrator run lifecycle, observation,
  cancellation, and final classification.
- **Agent input/output contract**: per-role schema for agent inputs, prior
  outputs, and verification feedback.
- **Model Gateway invocation contract**: prompt template id, model selection
  inputs, policy decision outputs, latency, and audit fields.
- **Harness event contract**: canonical event envelope written to the Harness
  event ledger.
- **Evidence Pack v0 extension**: agent trajectory, model invocation summary,
  repair-loop history, and Harness experience signal sections.

These contracts must be designed so that future Harness capabilities (RAG,
graph, domain database, additional MCP surfaces) can be added without
rewriting agents or the Orchestrator.

## Consequences

- The deterministic W0 core remains the authoritative verifier.
- Deterministic transformation and AI-assisted transformation remain one
  Orchestrator-owned product path, not two competing runtime paths.
- The global Orchestrator is explicitly not an LLM. Any LLM-based planning or
  team-lead behavior is scoped to a bounded agent step and is subject to the
  same deterministic gates.
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
