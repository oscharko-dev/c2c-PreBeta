# Orchestrator W0.4 Parity and Repair Workflow Contract

**Owner:** `services/orchestrator-service`
**Code source of truth:** downstream workflow code, schemas, and OpenAPI added by
the W0.4 child issues
**Consumers:** BFF, Studio, Evidence service, Build/Test Runner, agents

This document records stable consumer semantics for the Developer Trust parity
and repair workflow. Code, schemas, OpenAPI, and tests remain the executable
truth. Architectural decision context lives in
[ADR 0009](../adr/0009-developer-trust-parity-and-repair-contract.md).

## Invariants

- Every parity or repair run goes through the Orchestrator.
- The first supported trust case is a controlled workflow over the W0 COBOL
  subset.
- The source/reference side is labeled honestly and does not imply live
  arbitrary COBOL execution.
- Generated Java build, execution, normalization, and comparison remain
  deterministic authority for parity status.
- Productive model calls for diagnosis or repair go through the Model Gateway
  only.
- Repair proposals require explicit developer approval before application.
- Evidence captures the mode labels, approvals, outputs, hashes, diagnostics,
  comparisons, and provenance needed for audit.

## Canonical Workflow Objects

The first trust workflow is described in terms of these stable objects:

| Object | Meaning |
| --- | --- |
| Trust case | A curated parity run configuration that binds one supported COBOL source, one controlled input fixture, one reference artifact, and the policies that govern the run. |
| Parity run | One end-to-end execution of transformation, reference resolution, target build/run, comparison, and evidence capture for a trust case. |
| Repair run | A bounded follow-on workflow for a failed parity run that collects deterministic failure context, obtains an optional repair proposal through the Model Gateway, and re-enters deterministic verification after explicit approval. |
| Reference artifact | The controlled source/reference result used as the source-side authority for the first trust slice. |
| Generated Java candidate | The target-side Java output selected for deterministic build and execution. |
| Repair proposal | A reviewable patch candidate plus rationale, scope, and policy metadata. It is not proof and has no effect until approved. |

## Parity Workflow

The consumer-visible parity loop is:

1. Studio submits a curated trust case / parity run configuration through the
   BFF.
2. The Orchestrator validates the run scope and supported-source preconditions.
3. The Orchestrator transforms one supported COBOL source into a generated Java
   candidate.
4. The Orchestrator resolves the source/reference result for the same controlled
   input.
5. The Build/Test Runner builds and executes the generated Java candidate.
6. Deterministic normalization and comparison decide whether reference and
   target outputs match.
7. Evidence records the run configuration, artifacts, outputs, hashes,
   diagnostics, comparison, and provenance state.

## Repair Workflow

The repair loop begins only after deterministic failure detection:

1. The Orchestrator classifies the failure.
2. The Orchestrator prepares bounded repair context and policy metadata.
3. Any productive model call goes through the Model Gateway.
4. Studio renders the patch proposal in a developer-reviewable sandbox.
5. The developer approves or rejects the proposal explicitly.
6. Approval captures the exact patch payload hash that Studio rendered for
   review.
7. Only an approved patch whose payload matches the recorded approval hash may
   be applied.
8. Repair application is limited to the generated Java candidate and its
   reviewable patch artifact. It must not modify reference fixtures,
   comparison/normalization logic, evidence logic, or policy surfaces.
9. An applied patch re-enters deterministic build, execution, comparison, and
   evidence capture before the run can recover.

Model output can explain or propose, but it does not determine run success.

## Execution Modes and Canonical Studio Labels

Consumers must expose the first trust workflow with explicit mode labels:

| Surface | Canonical label | Contract meaning |
| --- | --- | --- |
| Source/reference output | `Reference mode: curated fixture` | The source-side result is a controlled fixture-backed reference, not live mainframe execution. |
| Generated target output | `Target mode: generated Java` | The target-side result is produced by generated Java built and executed by the product pipeline. |
| Comparison | `Comparison authority: deterministic` | Deterministic normalization, comparison, and evidence decide parity status. |
| Repair proposals | `Repair mode: developer-approved sandbox` | Repair suggestions are reviewed in a sandbox and require explicit approval before application. |

Future source/reference modes may extend this set, but consumers must not label
fixture-backed reference behavior as live COBOL execution.

## First Supported Trust Slice

The first trust workflow supports the W0 subset defined in
[docs/corpus/w0-cobol-subset.md](../corpus/w0-cobol-subset.md):

- one single-program COBOL source;
- one repository-owned, versioned trust-case input fixture;
- one repository-owned fixture-backed reference output or equivalent controlled
  reference artifact;
- one generated Java candidate built and executed through the Build/Test
  Runner.

Unsupported input must classify honestly as blocked, unsupported, failed, or
incomplete. It must not surface as a successful parity claim.

## Component Responsibilities

The trust workflow spans these stable responsibilities:

| Component | Responsibility |
| --- | --- |
| Studio | Presents run configuration, mode labels, diagnostics, diffs, stale-state cues, evidence state, and repair review surfaces. |
| BFF | Owns browser-facing APIs and session-safe request brokering only. |
| Orchestrator | Owns workflow sequencing, parity orchestration, repair decisions, and final classification. |
| Harness | Provides controlled execution, policy, and ledger infrastructure without deciding parity outcomes. |
| Build/Test Runner | Compiles and executes generated Java and returns build/runtime diagnostics. |
| Evidence service | Persists run evidence, artifact references, comparison material, approvals, and audit metadata. |
| Model Gateway | The only productive model boundary for diagnosis, repair proposals, and any other productive model participation. |

## Failure Taxonomy

The executable truth for failure codes lives in code, schemas, and tests. This
document defines the consumer-facing taxonomy that downstream APIs and Studio
surfaces must preserve:

| Failure family | Meaning | Typical owner |
| --- | --- | --- |
| Unsupported input | The COBOL shape, runtime dependency, or execution requirement is outside the supported trust slice. | Orchestrator classification with corpus/governance backing |
| Reference or fixture issue | The curated reference fixture, trust-case input, or reference artifact is missing, inconsistent, or invalid. | Orchestrator / evidence / fixture governance |
| Generation defect | The generated Java candidate cannot represent the supported source behavior within the contract. | Orchestrator + target Java generation workflow |
| Build failure | Generated or repaired Java fails deterministic build or test execution. | Build/Test Runner |
| Runtime failure | Generated or repaired Java builds but fails during controlled execution. | Build/Test Runner / Orchestrator |
| Parity mismatch | Reference and target outputs execute but do not compare equal after deterministic normalization. | Deterministic comparison owned by the Orchestrator workflow |
| Repair policy or budget block | A repair attempt is denied by policy, approval, or bounded budget rules. | Orchestrator + Model Gateway policy |
| Evidence incomplete | Required run evidence, hashes, approvals, or artifact references are missing. | Evidence service + Orchestrator finalization |

Failure classification may inform model-assisted diagnosis, but it still routes
through deterministic evidence and final classification.

## Evidence Requirements

The first trust workflow must preserve at least these evidence classes:

- trust-case identity and version;
- input fixture identity and version;
- reference artifact identity and provenance;
- generated Java candidate identity and provenance;
- build and runtime diagnostics;
- normalized comparison result and parity status;
- mode labels presented to the developer;
- repair proposal metadata, the approved patch payload hash, approval or
  rejection decision, and any applied patch provenance;
- final run classification and any evidence completeness warnings.

## Security and Sandboxing Assumptions

The trust workflow relies on these assumptions:

- productive model calls go through the Model Gateway only;
- repair proposals remain reviewable and are not applied automatically;
- generated Java build and execution stay inside controlled product execution
  substrates;
- generated or repaired Java executes in an isolated runner contract with no
  outbound network by default, no secret-bearing environment variables,
  least-privilege filesystem access, and no direct write path into evidence
  storage;
- repair approvals are bound to the exact patch payload hash that Studio
  reviewed; apply must reject a non-matching patch;
- repair scope is limited to the generated Java candidate and may not alter
  reference artifacts, comparison logic, evidence logic, or policy surfaces;
- policy, redaction, and approval metadata are preserved in the evidence path;
- mode labels, approvals, and deterministic outcomes remain auditable;
- manual Java edits follow
  [ADR 0007](../adr/0007-studio-java-manual-edit-provenance.md) and do not
  weaken deterministic authority.
