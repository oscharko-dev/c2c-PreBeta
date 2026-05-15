# c2c Fachkonzept

**Status**: Canonical working concept
**Last updated**: 2026-05-15
**Governing issue**: [#161](https://github.com/oscharko-dev/c2c-PreBeta/issues/161)

This document is the canonical product and architecture concept for c2c. It is
the first reference point for scope, wave planning, architecture decisions, and
acceptance gates. If the project changes architecture, development flow, model
policy, wave boundaries, or acceptance criteria, this document and
[`docs/governance/development-workflow.md`](../governance/development-workflow.md)
must be updated in the same issue or PR.

## Product Intent

c2c is an AI-first COBOL-to-Code modernization platform for regulated banks and
insurers. The first target is COBOL to Java; the architecture must remain open
for later target languages and, in later waves, broader code-to-code
transformations.

The long-term ambition is to become a European and global gold standard for
mainframe modernization through:

- open-source infrastructure;
- open-weight model policy;
- EU sovereignty and customer-internal model endpoints;
- a Harness-centered agent infrastructure;
- neuro-symbolic depth instead of direct prompt-only translation;
- reproducible equivalence evidence;
- hard compliance artifacts;
- clean license and model governance;
- realistic mainframe semantics over time.

The delivery principle is: **Think Big, Start Small.** Every wave must be small
enough to finish and prove, while still reinforcing the long-term enterprise
architecture.

## Architecture Principles

- **Microservice-based from the beginning.** Parser, Semantic IR, target Java
  generation, build/test, evidence, BFF, model gateway, Harness, Experience
  Learning, and Studio UI remain separate capability boundaries.
- **Harness is infrastructure, not the orchestrator.** The Harness provides the
  capability catalog, tool and registry surfaces, run state, events, policy
  hooks, and Experience Learning data substrate. Orchestrators and agents live
  inside or consume the Harness; they do not replace it.
- **BFF is the browser boundary.** The Studio calls only `/api/v0/*` on the
  c2c BFF. Browser code never calls parser, orchestrator, model gateway,
  evidence, Harness, or customer/internal service URLs directly.
- **Model Gateway is the only model boundary.** During development, all model
  calls go through Microsoft Foundry via the model-gateway-service. Customer
  deployments use the same gateway contract against customer-internal model
  endpoints. Direct model-provider calls from agents or services are forbidden.
- **Evidence-first release semantics.** A transformation may only be presented
  as successful when the generated Java artifact, build/test result,
  equivalence classification, and Evidence Pack agree.
- **Deterministic core remains the gatekeeper.** AI agents may generate,
  repair, and explain code, but the final success state is decided by
  deterministic compile/run/equivalence/evidence checks.
- **No success fallback.** Unsupported, unavailable, failed, incomplete, or
  verification-blocked states must be shown honestly in the UI and evidence.

## Implemented State

### W0: Deterministic Enterprise Kernel

W0 established the product-grade deterministic backbone. It is not the final
AI-first system, but it is the proof and safety layer that AI must pass through.

W0 provides:

- COBOL parser service for the documented W0 subset;
- Semantic IR service;
- Java target generation service;
- target Java runtime;
- build/test runner with Golden Master comparison;
- evidence-service and Evidence Pack v0;
- agentic-harness-core as control-plane infrastructure;
- experience-learning-service surfaces and ledgers;
- model-gateway-service infrastructure and model-policy-skipped evidence;
- orchestrator-service as the W0 service-chain driver;
- c2c-bff as the UI-facing API boundary;
- local product launcher and reproducible release gates.

W0 deliberately does **not** require model calls. The achieved W0 path works
with model gateway disabled and records that fact explicitly.

Canonical evidence:

- [W0 release gate](../release/w0-release-gate.md)
- [W0 corrective epic #86 closure evidence](../release/w0-corrective-epic-86.md)
- [W0 reference runbook](../showcase/w0-reference-runbook.md)
- [W0 COBOL subset definition](../corpus/w0-cobol-subset.md)

### W0.1: Next.js Transformation Studio

W0.1 turned the backend capability mesh into a usable product surface. The user
can open the browser Studio, load or paste supported COBOL, start a
transformation, and inspect generated Java, build/test, evidence, artifacts,
progress, Harness/Experience Learning signals, and model-governance status for
the active run.

W0.1 provides:

- Next.js App Router, React, TypeScript, and Tailwind Studio;
- IDE-style workbench based on the Claude design direction;
- source workspace and editable COBOL editor;
- BFF-only typed API client;
- generated Java editor bound to persisted run files;
- target Java artifact inspector;
- build/test, Evidence Pack, run artifact, progress, Harness, model
  governance, and Experience Learning panels;
- blocked, failed, unsupported, incomplete, unavailable, and
  verification-blocked states;
- browser acceptance and visual-regression gates.

W0.1 still uses the deterministic W0 transformation path as the success
mechanism. It is not yet a productive AI-agent transformation loop.

Canonical evidence:

- [W0.1 Studio epic #118 closure evidence](../release/w0-studio-epic-118.md)
- [c2c Studio browser acceptance test](../../apps/c2c-studio/tests/e2e/workflow.spec.ts)
- [local product launcher](../../scripts/start-c2c-local.sh)

## Next Wave: W0.2 Productive AI Transformation Loop

W0.2 is the next mandatory wave. Its purpose is to introduce the first
productive AI into the transformation path without weakening deterministic
proof.

The W0.2 target state:

```text
Studio UI
  -> c2c BFF
  -> orchestrator as Harness consumer
  -> Harness-executed agent workflow
  -> Model Gateway / Microsoft Foundry
  -> Transformation Agent
  -> deterministic build/test gate
  -> Verification/Repair Agent
  -> bounded repair loop
  -> Evidence Pack with model and agent trajectory records
  -> Studio displays final Java and agent activity
```

Required W0.2 capabilities:

- Harness-registered agent workflow for a small COBOL-to-Java transformation;
- model-gateway-service enabled through approved Foundry development
  configuration;
- at least one Transformation Agent that uses COBOL source, parser output,
  Semantic IR, and existing target Java runtime/generator contracts;
- at least one Verification/Repair Agent that consumes compile, runtime, and
  output-difference feedback and proposes targeted fixes;
- bounded repair loop with a hard iteration limit;
- no browser-visible model credentials or internal service URLs;
- model invocation ledger entries with completed model calls;
- agent trajectory ledger entries for each agent action;
- Evidence Pack references to generated Java, build/test, model invocation,
  repair attempts, and agent trajectory;
- UI progress states that show when agent work, model invocation, and repair
  iterations are happening;
- deterministic success gate: Java artifact exists, compiles, runs, and passes
  the configured equivalence check before the UI may show a verified state.

W0.2 explicitly does **not** need to deliver:

- full Experience Learning maturity;
- autonomous test generation at enterprise breadth;
- broad COBOL coverage;
- customer production readiness;
- multi-tenant authentication or customer onboarding;
- support for all paragraph, copybook, file I/O, DB2, CICS, JCL, or VSAM
  semantics.

W0.2 should be demonstrated on a small, bounded COBOL program. The preferred
next acceptance candidate is a Hello World style program that exposes the
current gaps:

- alphanumeric `VALUE` initialization;
- literal casing preservation;
- paragraph-style `PERFORM ... VARYING ... UNTIL`;
- clear unsupported/repair behavior when the deterministic parser/generator
  cannot complete the run alone.

## Wave Roadmap

| Wave | Status | Purpose | Success Gate |
|------|--------|---------|--------------|
| W0 | Done | Deterministic enterprise kernel and evidence backbone. | Service mesh produces compiled Java, build/test result, Harness/Experience Learning telemetry, and complete Evidence Pack for the W0 corpus without required model calls. |
| W0.1 | Done | Product Studio UI over the W0 kernel. | Browser workflow loads/pastes supported COBOL, starts a BFF/orchestrator run, displays artifact-backed Java, build/test, evidence, progress, artifacts, and honest blocked states. |
| W0.2 | Next | First productive AI-agent transformation loop. | At least one small COBOL program is transformed through a Harness-governed model-backed agent workflow with bounded repair and deterministic verification/evidence. |
| W0.3 | Planned | Custom COBOL coverage expansion. | More customer-like small COBOL snippets work or fail honestly, including selected paragraph, literal, and data initialization semantics. |
| W1 | Planned | Enterprise agentic hardening. | Broader agent roles, stronger mainframe semantics, model governance hardening, richer Experience Learning, and broader corpus evidence. |

## Development Rule

The Fachkonzept is not a presentation artifact. It is a living engineering
contract. Any issue that changes wave scope, product architecture, model
participation, agent workflow, evidence semantics, UI success states, or release
acceptance must update this document and the development workflow where
applicable.
