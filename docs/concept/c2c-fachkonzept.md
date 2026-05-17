# c2c Fachkonzept

**Status**: Canonical working concept
**Last updated**: 2026-05-17
**Governing issue**: [#164](https://github.com/oscharko-dev/c2c-PreBeta/issues/164)
**Related issues**: [#165](https://github.com/oscharko-dev/c2c-PreBeta/issues/165)

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
- an Experience Learning Harness that provides agent infrastructure,
  governance, telemetry, pattern analysis, and reusable optimization signals;
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
- **Deterministic first, AI only where it adds value.** COBOL parsing,
  copybook/data modelling, Semantic IR, target-runtime semantics, Java project
  assembly, compile/run, oracle comparison, evidence assembly, policy checks,
  and release gates must be deterministic whenever they can be specified
  reliably. LLMs and agents are used for ambiguity handling, candidate
  improvement, repair, explanation, planning assistance, and later
  large-module decomposition — never as a replacement for deterministic
  semantics that we already understand.
- **One authoritative workflow path through the Orchestrator.** Deterministic
  steps and AI-assisted steps both run under Orchestrator control. Parser,
  Semantic IR, target generation, build/test, evidence, Model Gateway, and
  agents must not be invoked as browser-visible or product-success side paths.
  If deterministic services can complete a transformation, the Orchestrator
  still owns the run contract, state transitions, artifact persistence,
  Harness events, and final classification. This avoids two competing
  product paths and keeps Evidence Packs replayable.
- **The global Orchestrator is deterministic, not an LLM.** The global
  Orchestrator is the authoritative state machine for run sequencing,
  capability selection, retry/repair budgets, cancellation, policy decisions,
  and final release gates. It may consult Harness Experience Learning signals
  and may start AI agents, but it must not be replaced by an LLM that freely
  decides workflow order or success.
- **Harness is infrastructure, governance, and Experience Learning system, not
  the orchestrator.** The Harness provides the capability catalog, tool and
  registry surfaces, MCP access, run state, events, policy hooks, ledgers, and
  learning services. It observes agent, tool, model, artifact, and verification
  trajectories, detects patterns, and exposes optimization signals back to
  orchestrators and agents. It does not decide workflow order, assign agent
  work, or declare transformation success.
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
- **Bounded LLM-led agent teams are allowed only inside an Orchestrator-owned
  step.** Later waves may use an LLM-based Agent Team Lead, Planner Agent, or
  bounded sub-orchestrator for larger modules. That component may coordinate
  specialist agents inside the approved step, but it never becomes the global
  Orchestrator, never bypasses the Harness, and never bypasses deterministic
  gates.
- **No success fallback.** Unsupported, unavailable, failed, incomplete, or
  verification-blocked states must be shown honestly in the UI and evidence.

## Role Model

The following role model is normative for c2c and must be preserved in code,
documentation, and wave planning.

- **Harness**: shared infrastructure, governance layer, and Experience Learning
  system. It provides capability discovery, tool and MCP access, registries,
  run-state surfaces, events, ledgers, policy hooks, and learning services. It
  records and analyzes experience signals such as tool success rates, tool
  latency, model invocation outcomes, agent communication patterns, repair-loop
  depth, repeated failures, no-change repairs, database/RAG/graph lookup
  usefulness, and verification outcomes. It exposes those learnings as
  recommendations, priors, risk signals, and capability rankings to
  orchestrators and agents. The Harness does not decide workflow order or agent
  sequencing.
- **Orchestrator**: workflow control component. It starts runs, selects the
  workflow path, resolves and invokes deterministic capabilities, assigns work
  to agents, manages loop boundaries and stop conditions, and decides when
  deterministic verification must run. The global Orchestrator is a
  deterministic state machine, not an LLM. Every product transformation,
  including a transformation that can be solved fully deterministically, must
  pass through this Orchestrator so that run contracts, artifacts, Harness
  events, Experience Learning records, and Evidence Packs remain consistent.
- **Agents**: bounded execution and analysis roles inside a workflow. Agents
  transform, inspect, repair, explain, or verify artifacts. Agents use
  Harness-provided capabilities and may call models only through the Model
  Gateway.
- **Agent Team Lead / bounded sub-orchestrator**: optional later-wave
  LLM-assisted coordinator inside one Orchestrator-approved step. It can plan
  work for specialist agents on a large module, but its output is still just a
  candidate artifact or decision returned to the global Orchestrator. It cannot
  make final success claims, change global retry budgets, bypass Model Gateway,
  or bypass deterministic verification/evidence gates.
- **Model Gateway**: exclusive model-access boundary. It enforces provider
  routing, model policy, authentication, auditability, and provider abstraction
  for Microsoft Foundry in development and customer-internal endpoints in
  production.
- **BFF**: browser boundary. The Studio speaks only to the c2c BFF; it never
  calls orchestrator, Harness, model endpoints, or internal services directly.
- **Deterministic verifier services**: parser, Semantic IR, target generation,
  build/test, equivalence, and evidence services remain the authoritative proof
  path. Agent output may influence artifacts, but verified success is granted
  only by deterministic checks.

Multiple orchestrators and multiple agent teams may run on the same Harness.
That is a design goal, not an optional future interpretation. The Harness is
therefore a shared platform layer, not a hidden monolithic orchestrator.

### Deterministic-First Workflow Semantics

c2c must not treat deterministic transformation and AI-assisted
transformation as two separate products. They are two capability categories
inside the same Orchestrator-owned workflow.

The required product path is:

```text
Studio UI
  -> c2c BFF
  -> deterministic global Orchestrator
  -> Harness capability and policy infrastructure
  -> deterministic capabilities where semantics are known
  -> Model Gateway and agents only for approved AI-assisted steps
  -> deterministic compile/run/oracle/evidence gate
  -> final run classification
```

This means:

- if the W0/W0.2 deterministic parser, IR, and generator can produce a valid
  Java candidate, the Orchestrator still owns the flow and persists that
  candidate as part of the run;
- if an AI agent is invoked, the agent may improve or repair the candidate,
  but the final Java is accepted only after deterministic gates pass;
- if an LLM-based Agent Team Lead is introduced later, it is scoped to a
  bounded sub-task and returns artifacts or decisions to the global
  Orchestrator;
- no UI, BFF handler, release script, or service may claim a product-success
  transformation by calling deterministic services outside the Orchestrator and
  Evidence Pack path.

### Harness as Experience Learning System

The Harness is one of the core product differentiators. It is not only a shared
control plane and governance surface; it is the system that turns operational
experience into reusable product knowledge.

The Harness must capture experience across the complete agentic modernization
path:

- which capabilities and tools were available for a task;
- which tool, MCP, database, RAG, or graph calls were selected;
- whether those calls were successful, fast, slow, redundant, or unhelpful;
- which model and prompt template were used through the Model Gateway;
- which policy decisions were applied;
- how agents communicated and handed work to each other;
- how many repair-loop iterations were needed;
- which generated Java candidates failed compilation, runtime, or equivalence;
- which repair strategies improved the result;
- which workflows repeatedly ended in blocked states.

From those records, the Harness should derive experience signals over time:
recommended capabilities for a task type, risky tool/model combinations,
patterns of repeated non-progress, repair strategies that historically worked,
and confidence signals for orchestrator planning. In early waves those signals
may be read-only analytics and recommendations. In later waves they become a
learning layer that helps orchestrators and agents choose better next actions.

This learning role still does not make the Harness the Orchestrator. The
Orchestrator remains responsible for workflow control, sequencing, retry
decisions, loop boundaries, aborts, and final run classification. The Harness
learns from experience and makes that learning available; it does not secretly
run the workflow.

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

## W0.2: Productive AI Transformation Loop

W0.2 introduces the first productive AI participation into the transformation
path without weakening deterministic proof. It does not replace the
deterministic W0 backbone; it adds model-backed agents as bounded workflow
participants under the deterministic global Orchestrator.

The W0.2 target state:

```text
Studio UI
  -> c2c BFF
  -> deterministic global Orchestrator as Harness consumer
  -> deterministic parser / Semantic IR / baseline generator
  -> optional Orchestrator-approved agent step
  -> Model Gateway / Microsoft Foundry for all LLM calls
  -> Transformation Agent or later bounded Agent Team Lead
  -> deterministic build/test gate
  -> Verification/Repair Agent only when the gate fails
  -> bounded repair loop controlled by the Orchestrator
  -> Harness records events, model invocations, agent trajectories, and
     experience signals
  -> Evidence Pack with model, policy, repair, verification, and agent records
  -> Studio displays final Java and agent activity
```

Required W0.2 capabilities:

- orchestrator-steered agent workflow for a small COBOL-to-Java
  transformation using Harness-provided capabilities, tools, registries,
  ledgers, and policy hooks;
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
- first Experience Learning signals for repeated failures, repair-loop depth,
  no-change attempts, tool/capability usage, and verification outcomes;
- Evidence Pack references to generated Java, build/test, model invocation,
  repair attempts, and agent trajectory;
- UI progress states that show when agent work, model invocation, and repair
  iterations are happening;
- deterministic success gate: Java artifact exists, compiles, runs, and passes
  the configured equivalence check before the UI may show a verified state.
- explicit separation between the deterministic global Orchestrator and any
  LLM-assisted agent/team-lead role. The Orchestrator controls the workflow;
  agents produce or repair candidates inside bounded steps.

W0.2 explicitly does **not** need to deliver:

- full Experience Learning maturity. W0.2 must capture structured experience
  and expose first read-only signals, but it does not yet optimize workflows
  autonomously;
- autonomous test generation at enterprise breadth;
- broad COBOL coverage;
- customer production readiness;
- multi-tenant authentication or customer onboarding;
- support for all paragraph, copybook, file I/O, DB2, CICS, JCL, or VSAM
  semantics;
- multiple agent teams or multiple orchestrators in production. The platform
  architecture must keep that future open (see Role Model), but W0.2 ships
  exactly one Orchestrator and one agent team;
- additional target languages beyond Java. The COBOL-to-Java path remains the
  only target in W0.2.

### W0.2 Failure States

Product-mode runs must surface real failure states. The Studio, BFF,
Orchestrator, and Evidence Pack must never invent a successful output to hide
a problem. The following failure states are first-class and must be
representable end-to-end in the W0.2 implementation:

- **parse failure**: the deterministic COBOL parser cannot complete on the
  input;
- **unsupported COBOL**: input is parseable but uses constructs outside the
  documented W0/W0.2 subset;
- **model gateway unavailable**: model-gateway-service or the configured
  Foundry endpoint cannot serve a model call;
- **model policy denial**: a model invocation is rejected by Model Gateway
  policy (model, provider, prompt template, or content policy);
- **agent timeout**: an agent step exceeds its bounded execution budget;
- **compile failure**: generated Java does not compile under the target
  Java runtime;
- **runtime failure**: generated Java compiles but fails at runtime under the
  build/test runner;
- **oracle mismatch**: generated Java runs but the equivalence check against
  the Golden Master diverges;
- **incomplete evidence**: Evidence Pack v0 cannot be assembled because a
  required artifact, ledger record, or verification result is missing;
- **cancellation**: the Orchestrator aborts a run because of a user cancel,
  policy abort, or hard repair-loop limit.

Each failure state must be visible in the Studio, recorded in the run
artifacts and Evidence Pack, and distinguishable from a verified-success run.

### W0.2 API and Artifact Contracts

W0.2 does not introduce a breaking change to the existing BFF
`/api/v0/*` surface. It does, however, name the contracts that subsequent
implementation issues will design, version, and enforce:

- **Orchestrator run contract**: how the BFF starts a run, how run state is
  observed, how cancellation is requested, and how final classification is
  reported.
- **Agent input/output contract**: the schema each agent role must accept and
  produce, including references to source artifacts, prior agent outputs, and
  verification feedback.
- **Model Gateway invocation contract**: how the Orchestrator and agents call
  the Model Gateway, including prompt template id, model selection inputs,
  policy decision outputs, latency, and audit fields.
- **Harness event contract**: the canonical event envelope written to the
  Harness event ledger, including run id, agent id, capability id, model
  invocation id, policy decision id, and trajectory pointers.
- **Evidence Pack v0 extension**: additional sections in Evidence Pack v0
  that capture agent trajectories, model invocation summaries, repair-loop
  history, and Harness experience signals for the run.

These contracts must be designed so the Harness can later add capabilities
(for example RAG, graph, or domain database services) without changing the
Orchestrator/agent surface or rewriting existing runs.

### Future Harness Infrastructure Readiness

W0.2 must not implement full RAG, graph, or database-backed reasoning. It
must, however, keep the Harness boundary ready for those capabilities so that
future waves can introduce them without rewriting agents or orchestrators.

Concretely, W0.2 implementations must:

- expose agent capabilities through the Harness Capability and Tool registries
  rather than hard-coding tool selection inside an agent or a single workflow
  module;
- treat MCP, model, and future RAG/graph/database surfaces as Harness-provided
  capabilities behind stable contracts, not as private agent dependencies;
- keep run, event, and trajectory records expressive enough that later
  Experience Learning consumers can analyze them across multiple orchestrators
  and agent teams;
- avoid coupling Orchestrator logic to the internal shape of any single
  capability provider, so providers can be replaced or extended later.

This keeps the platform open for additional orchestrators, additional agent
teams, additional target languages, and additional Harness-backed capability
providers in later waves, without retroactively rewriting W0.2 work.

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
| W0.2 | Done | First productive AI-agent transformation loop. | At least one small COBOL program is transformed through an orchestrator-steered, model-backed agent workflow on the Experience Learning Harness, with bounded repair, first learning signals, and deterministic verification/evidence. |
| W0.3 | Planned | Deterministic-first multi-agent hardening. | Product runs execute deterministic baseline steps first, invoke productive AI only through an explicit Orchestrator assist-decision gate, surface stricter assist/repair budgets, and preserve deterministic verification/evidence as the only path to `success`. |
| W1 | Planned | Coverage and enterprise agentic expansion. | Broader customer-like COBOL coverage, stronger mainframe semantics, larger bounded agent-team patterns, richer Experience Learning, model-governance hardening, and broader corpus evidence. |

## Development Rule

The Fachkonzept is not a presentation artifact. It is a living engineering
contract. Any issue that changes wave scope, product architecture, model
participation, agent workflow, evidence semantics, UI success states, or release
acceptance must update this document and the development workflow where
applicable.
