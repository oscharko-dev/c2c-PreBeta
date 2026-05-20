# ADR 0009: Developer Trust Parity and Repair Workflow Contract

**Date:** 2026-05-20
**Status:** Accepted

## Context

Epic [#349](https://github.com/oscharko-dev/c2c-PreBeta/issues/349) and
issue [#350](https://github.com/oscharko-dev/c2c-PreBeta/issues/350) define
the Developer Trust Moment: a modernization engineer uses C2C Studio to run a
controlled COBOL-to-Java parity workflow, inspect deterministic evidence, and
optionally review a bounded repair proposal when deterministic verification
fails.

The repository already defines the deterministic-first posture in the
[c2c Fachkonzept](../concept/c2c-fachkonzept.md), the W0.3 hardening contract
in [docs/contracts/orchestrator-w03-workflow.md](../contracts/orchestrator-w03-workflow.md),
the W0.4 trust workflow contract in
[docs/contracts/orchestrator-w04-parity-repair-workflow.md](../contracts/orchestrator-w04-parity-repair-workflow.md),
the editor-assist boundary in
[ADR 0004](0004-studio-editor-assist-channel.md), and manual-edit provenance in
[ADR 0007](0007-studio-java-manual-edit-provenance.md). What is still missing is
one durable contract that fixes the first trust-loop scope before downstream
schema, orchestration, BFF, and Studio issues begin implementation.

This issue is governance work, not a feature implementation. The contract must
define stable behavior and ownership without copying the GitHub issue body into
the repository.

## Decision

### 1. The first supported trust loop is a controlled parity workflow

The first supported Developer Trust workflow is intentionally narrow:

- one curated trust case at a time;
- one supported single-program COBOL source from the W0 subset;
- a versioned deterministic input fixture owned by the repository;
- a reference result resolved from a curated fixture-backed reference mode;
- generated Java built and executed in a controlled Build/Test Runner
  environment;
- deterministic comparison and evidence capture as the authority for success.

The first release does **not** claim live execution of arbitrary customer COBOL,
unbounded runtime substrates, or parity over unsupported mainframe features.

### 2. Studio must label execution modes explicitly

Studio must distinguish the authoritative execution surfaces with explicit
labels. The canonical labels are:

| Surface | Canonical Studio label | Meaning |
| --- | --- | --- |
| Source/reference output | `Reference mode: curated fixture` | The source-side result comes from a controlled, repository-owned reference fixture. It is not live mainframe execution. |
| Generated target output | `Target mode: generated Java` | The target-side result comes from generated Java built and executed through the controlled product pipeline. |
| Comparison authority | `Comparison authority: deterministic` | Success or failure is decided by deterministic normalization, comparison, and evidence rules rather than model judgment. |
| Repair proposal flow | `Repair mode: developer-approved sandbox` | A Coding Agent may propose a patch, but it is reviewed in a sandbox and applied only after explicit developer approval. |

Future source execution modes may be added, but the product must not present a
fixture-backed reference as live COBOL execution without a distinct label.

### 3. Workflow authority stays split by product boundary

Responsibility for the trust workflow is fixed as follows:

| Component | Authority |
| --- | --- |
| Studio | Presents run configuration, mode labels, diagnostics, diffs, evidence state, stale-state cues, and patch review surfaces. Studio is not the workflow authority. |
| BFF | Exposes UI-facing APIs, resolves session/tenant context, and brokers only browser-safe interactions. The BFF does not become a hidden orchestrator. |
| Orchestrator | Owns transformation, reference resolution, target execution sequencing, parity comparison orchestration, assist decisions, repair decisions, and final classification. |
| Harness | Provides controlled execution and policy infrastructure, eventing, and ledgers. It does not decide parity outcomes. |
| Build/Test Runner | Builds and executes generated Java, returns structured build/runtime diagnostics, and does not assert parity by itself. |
| Evidence service | Stores run evidence, artifact references, comparison outputs, approval records, and audit metadata. |
| Model Gateway | The only productive model boundary for diagnosis, repair proposals, or optional explanatory calls that the product treats as productive. |

### 4. Deterministic parity remains authoritative

The parity workflow must follow this sequence:

1. A developer selects a curated trust case / parity run configuration.
2. Studio submits the request through the BFF to the Orchestrator.
3. The Orchestrator transforms the supported COBOL slice into Java.
4. The Orchestrator resolves the reference result for the same controlled input.
5. The Orchestrator sends generated Java to the Build/Test Runner for build and
   execution.
6. Deterministic normalization and comparison decide whether the reference and
   target outputs match.
7. Evidence captures the configuration, inputs, outputs, hashes, diagnostics,
   comparison result, and lineage needed for audit.

Model output may explain or propose changes, but it does not decide parity,
proof, or run success.

### 5. Repair proposals are bounded and developer-approved

The repair workflow starts only after deterministic failure detection. The
contract for the first supported repair loop is:

1. Deterministic build, runtime, or parity failure is classified.
2. The Orchestrator prepares bounded repair context and policy metadata.
3. Any productive model call goes through the Model Gateway.
4. Studio shows the failure class, the proposed patch, and the patch context in
   a reviewable sandbox.
5. The developer explicitly approves or rejects the patch proposal.
6. Approval records the exact patch payload hash that was reviewed.
7. Only an approved patch whose payload matches the recorded approval hash may
   be applied.
8. Repair application is limited to the generated Java candidate and its
   reviewable patch artifact. It must not modify reference fixtures, comparison
   logic, evidence wiring, policy code, or other trust-governing surfaces.
9. Any applied patch re-enters deterministic build, execution, comparison, and
   evidence capture before the run can recover.

Automatic patch application is not allowed.

### 6. The first supported COBOL slice is the W0 subset with controlled inputs

The first supported trust case uses the W0 subset defined in
[docs/corpus/w0-cobol-subset.md](../corpus/w0-cobol-subset.md). The supported
input model is:

- one repository-owned COBOL source file;
- one repository-owned, versioned input fixture for the trust case;
- one repository-owned reference output fixture or equivalent controlled
  reference artifact;
- one generated Java candidate associated with the same run configuration.

Unsupported COBOL or runtime behaviors must be blocked explicitly and encoded
through the existing orchestrator classification model. They must surface as a
supported final classification such as `blocked`, `failed`, or `incomplete`,
with unsupported semantics carried by the failure family and failure code
rather than by inventing a new final-classification value. They must not be
converted into a successful parity claim.

### 7. IDE-grade behavior is a workflow requirement

The trust workflow must feel like a professional developer IDE for regulated
modernization work. The product requirement is interaction quality and state
credibility, not visual imitation of IntelliJ. The workflow therefore requires:

- explicit run configuration, reference mode, target mode, and evidence state;
- diagnostics linked to files, lines, run IDs, and artifact references;
- stale-result marking after COBOL edits, generated Java edits, or patch
  application;
- side-by-side or equivalent reviewable diffs for output and patch inspection;
- visible repair approvals and disposition history;
- fast, predictable reruns for curated trust cases;
- honest unsupported-state messaging when the workflow cannot prove parity.

### 8. Security and sandboxing assumptions are part of the contract

The first trust workflow assumes:

- all productive model calls go through the Model Gateway;
- model-bound context is previewable, policy-controlled, and redacted before
  invocation where required by existing ADRs;
- generated Java build and execution happen only in controlled product
  substrates;
- repair proposals are isolated to a sandboxed review/apply flow;
- repair approvals are bound to the exact patch payload hash that Studio
  reviewed; apply must reject a non-matching patch;
- repair scope is limited to the generated Java candidate and may not alter
  reference artifacts, comparison logic, evidence logic, or policy surfaces;
- runner isolation is minimum-guarded: no outbound network by default, no
  secret-bearing environment variables, least-privilege filesystem access, and
  no direct write path into evidence storage;
- evidence records capture approvals, patch provenance, and the mode labels used
  for the run;
- deterministic results remain the authority even when a model explanation or
  repair proposal is present.

## Rationale

This ADR keeps the scope narrow enough for enterprise-grade implementation:

- It protects the deterministic-first posture already established by the
  Fachkonzept and ADR 0003.
- It prevents downstream issues from inventing inconsistent source modes,
  approval semantics, or ownership boundaries.
- It gives Studio, BFF, Orchestrator, Evidence, and agent work a shared set of
  labels and responsibility boundaries before API and schema work begins.
- It explicitly documents that the first trust case is curated and
  fixture-backed, which avoids misrepresenting the product as arbitrary live
  COBOL execution.

The epic implementation order does not change. Issue #350 remains the first
delivery step because the downstream child issues depend on this contract.

## Consequences

- Downstream parity, repair, BFF, and Studio issues must use the canonical mode
  labels defined here unless a later ADR updates them.
- The W0.4 workflow contract must expose the parity and repair semantics that
  consumers rely on.
- The W0 COBOL subset document must define the first supported trust-case slice
  and unsupported cases precisely.
- PRs that affect these boundaries require explicit security review and
  deterministic verification evidence.

## References

- GitHub epic: https://github.com/oscharko-dev/c2c-PreBeta/issues/349
- GitHub issue: https://github.com/oscharko-dev/c2c-PreBeta/issues/350
- Product concept: ../concept/c2c-fachkonzept.md
- Workflow contracts:
  - ../contracts/orchestrator-w03-workflow.md
  - ../contracts/orchestrator-w04-parity-repair-workflow.md
- Supported COBOL slice: ../corpus/w0-cobol-subset.md
- ADR 0003: ./0003-w0-3-deterministic-first-multi-agent-hardening.md
- ADR 0004: ./0004-studio-editor-assist-channel.md
- ADR 0007: ./0007-studio-java-manual-edit-provenance.md
