# ADR 0002: W0.2 Agentic AI Transformation Loop

**Date**: 2026-05-15
**Status**: Proposed
**Issue**: [#161](https://github.com/oscharko-dev/c2c-PreBeta/issues/161)

## Context

W0 and W0.1 intentionally delivered a deterministic COBOL-to-Java path first:
parser, Semantic IR, target Java generation, compile/run, equivalence check,
Evidence Pack, Harness events, Experience Learning surfaces, BFF, and Next.js
Studio.

That foundation is necessary but not sufficient for the c2c product intent.
c2c is positioned as AI-first. The next wave must therefore introduce the first
productive AI participation in the transformation path, while preserving the
deterministic success gate.

## Decision

W0.2 will introduce a small Harness-governed agent workflow:

1. The Studio still calls only the c2c BFF.
2. The BFF starts a transformation run through the orchestrator.
3. The orchestrator acts as a Harness consumer and runs an agentic workflow.
4. Agents call models only through model-gateway-service.
5. Development model access is via approved Microsoft Foundry configuration.
6. The initial workflow has two productive agent roles:
   - Transformation Agent: creates or improves Java from COBOL, parser output,
     Semantic IR, and target-runtime contracts.
   - Verification/Repair Agent: consumes compile/runtime/equivalence feedback
     and proposes bounded repairs.
7. The repair loop has a hard iteration limit.
8. A run can be marked verified only after deterministic build/test/evidence
   gates pass.

## Non-Goals

W0.2 does not deliver broad COBOL coverage, customer production readiness,
autonomous test-generation maturity, full Experience Learning feedback loops,
or enterprise multi-agent optimization. Those remain later-wave concerns.

## Consequences

- The deterministic W0 core remains the authoritative verifier.
- The first completed model invocations must appear in model invocation ledgers.
- Agent trajectory records become part of the Evidence Pack for W0.2 runs.
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
