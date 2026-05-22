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
- Repair proposals require explicit developer approval before application, and
  the approval is bound to the authenticated identity of the run owner as well
  as to the exact patch payload hash that Studio rendered, the immutable
  generated-Java candidate identity, and the base-revision digest/ref that
  Studio rendered.
- Parity and repair trigger endpoints exposed through the BFF are reachable
  only through an authenticated session; the authenticated identity of that
  session becomes the run owner, and unauthenticated callers are rejected
  before Orchestrator dispatch.
- All run-scoped read, control, and export endpoints exposed through the BFF
  must authorize against the same authenticated tenant/run-owner context
  captured at trigger time and reject before any artifact resolution or
  download is attempted.
- Evidence captures the mode labels, approvals, approver identity, reviewed
  candidate/base-revision identity, outputs, hashes, diagnostics,
  comparisons, and provenance needed for audit.
- The Orchestrator projects deterministic comparison lineage from the Java
  runner output into additive contract surfaces rather than recomputing
  parity independently.

## Canonical Workflow Objects

The first trust workflow is described in terms of these stable objects:

| Object                   | Meaning                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust case               | An immutable, repository-owned catalog entry that binds one supported COBOL source, one controlled input fixture, one reference artifact, and the policies that govern the run.                                                    |
| Parity run               | One end-to-end execution of transformation, reference resolution, target build/run, comparison, and evidence capture for a trust case.                                                                                             |
| Repair run               | A bounded follow-on workflow for a failed parity run that collects deterministic failure context, obtains an optional repair proposal through the Model Gateway, and re-enters deterministic verification after explicit approval. |
| Reference artifact       | The controlled source/reference result used as the source-side authority for the first trust slice.                                                                                                                                |
| Generated Java candidate | The target-side Java output selected for deterministic build and execution.                                                                                                                                                        |
| Repair proposal          | A reviewable patch candidate plus rationale, scope, and policy metadata. It is not proof and has no effect until approved.                                                                                                         |

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
   target outputs match. The comparison policy must record at least the
   line-ending, trailing-whitespace, stdout, stderr, exit-code, and
   empty-output rules used for the decision.
7. Evidence records the run configuration, artifacts, outputs, hashes,
   diagnostics, comparison, and provenance state.

The primary interactive Studio entrypoint for parity is
`POST /api/v0/transform` through the BFF with a selected `trustCaseId`.
Studio sends the selected trust-case identifier with the normal transformation
request; it does not send runtime arguments, environment variables, fixture
paths, comparison rules, secrets, filesystem paths, or other runtime internals.
The BFF lists catalog summaries and stores only the selected session
preference. It may validate that the identifier exists for the submitted
program before dispatch, but it must not resolve execution semantics
independently.

The Orchestrator remains the workflow authority. It resolves `trustCaseId`
against the repository-owned catalog, derives the controlled source/reference
fixture, runtime profile, environment metadata, comparison policy, and evidence
identity from that catalog entry, and then drives transform, source/reference
execution, generated-Java build, generated-Java execution, comparison, evidence
capture, and completion as recorded progress phases for polling consumers.
`/api/v0/runs` remains a run resource, status, evidence, and Orchestrator
control/read path; it must not become a browser-authored runtime configuration
surface for the Studio parity launcher.

For Issue #354 consumers must treat the Java runner payload as the
authoritative comparison artifact lineage for projections. The Orchestrator
remains the workflow and parity authority; it may persist or relay additive
projection objects such as workflow-contract `parityComparison` and evidence
`artifacts.parityComparison`, but those surfaces only re-express the runner's
comparison policy/version, execution/comparison result refs, and diff refs.

## Repair Workflow

The repair loop begins only after deterministic failure detection:

1. The Orchestrator classifies the failure.
2. The Orchestrator prepares bounded repair context and policy metadata.
3. Any productive model call goes through the Model Gateway.
4. Studio renders the patch proposal in a developer-reviewable sandbox.
5. The developer approves or rejects the proposal explicitly.
6. Approval captures the exact patch payload hash that Studio rendered for
   review, the immutable generated-Java candidate identity and base-revision
   digest/ref that Studio rendered, and the authenticated identity of the
   approving developer; the approving identity must match the run owner.
7. Only an approved patch whose payload matches the recorded approval hash,
   whose reviewed candidate/base revision matches the recorded immutable
   candidate identity and base-revision digest/ref, and whose approving
   identity matches the run owner may be applied.
8. Repair application is limited to the generated Java candidate and its
   reviewable patch artifact. It must not modify reference fixtures,
   comparison/normalization logic, evidence logic, or policy surfaces.
9. An applied patch re-enters deterministic build, execution, comparison, and
   evidence capture before the run can recover.

Model output can explain or propose, but it does not determine run success.

## Intentional Divergence

When deterministic comparison reports a parity mismatch, the Orchestrator may
accept a governed intentional-divergence decision for that specific run. The
decision is run-scoped and must include:

- a reviewer identity and role;
- a structured rationale with summary, technical basis, and business impact;
- linked evidence artifact references;
- the affected output surfaces;
- invalidation triggers, including expiration when appropriate.

The decision only becomes effective when it matches the current parity
comparison result for that run. Active decisions project the trust summary to
`intentional_divergence`; ordinary mismatches remain `parity_failed` unless an
approved decision exists. Expired or stale decisions are historical records and
must not silently carry over to a new run.

## Execution Modes and Canonical Studio Labels

Consumers must expose the first trust workflow with explicit mode labels:

| Surface                 | Canonical label                           | Contract meaning                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/reference output | `Reference mode: curated fixture`         | The source-side result is a controlled fixture-backed reference, not live mainframe execution. Trust-3 additionally stamps the adapter result with an explicit source mode such as `reference-fixture` or `native-cobol`. |
| Generated target output | `Target mode: generated Java`             | The target-side result is produced by generated Java built and executed by the product pipeline.                                                                                                                          |
| Comparison              | `Comparison authority: deterministic`     | Deterministic normalization, comparison, and evidence decide parity status.                                                                                                                                               |
| Repair proposals        | `Repair mode: developer-approved sandbox` | Repair suggestions are reviewed in a sandbox and require explicit approval before application.                                                                                                                            |

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

Unsupported input must classify honestly through the existing orchestrator
final-classification set. In the first trust workflow, unsupported behavior is
expressed as a supported final classification such as `blocked`, `failed`, or
`incomplete`, with the unsupported condition carried by the failure family and
failure code rather than a new `unsupported` final-classification value. It
must not surface as a successful parity claim.

## Immutable Trust-Case Catalog

The repository-owned catalog is the only source of trust-case internals. Each
catalog entry must carry an explicit trust-case identifier, trust-case version,
catalog version or catalog hash, supported program shape, controlled input
identity, runtime argument profile, environment profile metadata, comparison
strategy, comparison policy version, and evidence identity. Runtime parameters
are allowlisted, typed, and checked in with the repository. Studio may display
summary fields and save the selected `trustCaseId` as a user, workspace, or
session preference, but it must not edit catalog entries or author arbitrary
runtime configuration.

Completed run evidence is immutable. Consumers must compare the current Studio
selection with the run's recorded trust-case identity, catalog version/hash, and
configuration digest before presenting rerun or evidence state. When the
current selection differs from the completed evidence, Studio must show that
the prior results were produced from another trust case or catalog version
rather than implying that they validate the current selection.

## Parity Evidence Export

Successful parity evidence may be exported as a run-scoped Java regression
scaffold through the Studio and BFF path. This export is a durability aid for a
developer who wants to promote a convincing trust run into repository-backed
regression coverage without manually reconstructing the evidence inputs.

The export contract is intentionally conservative:

- Only successful parity evidence is eligible for an unqualified export.
- Failed, incomplete, or intentionally diverged evidence must be blocked.
- Stale evidence and repair-verified/manual-edit-qualified evidence must remain
  explicitly labeled so the exported scaffold does not overstate its authority.
- Exported scaffold files must pass the same secret and credential checks that
  gate Evidence storage before they are made available for download; any value
  rejected by those checks must be excluded or replaced with a redacted
  content-addressed reference.
- Browser-facing diagnostics, diffs, patch previews, and artifact previews
  must apply the same secret, credential, and path redaction policy before
  rendering, and they should prefer content-addressed references when raw
  payloads are unnecessary.
- Generated scaffold paths must avoid overwriting developer-maintained tests
  unless the developer later promotes the scaffold deliberately.

Exported scaffolds are not executed automatically as part of the current run.
They remain review artifacts until a developer promotes them into the checked-in
Maven build graph. This preserves deterministic evidence semantics, prevents
run-scoped exports from mutating repository CI implicitly, and ensures human
review settles naming, ownership, and long-term maintenance before the scaffold
becomes a standing quality gate.

## Component Responsibilities

The trust workflow spans these stable responsibilities:

| Component         | Responsibility                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Studio            | Presents immutable trust-case selection, saved-preference controls, mode labels, diagnostics, diffs, stale-state cues, evidence state, and repair review surfaces. |
| BFF               | Owns browser-facing APIs, catalog summaries, saved trust-case preference, and session-safe request brokering only.                                                 |
| Orchestrator      | Owns workflow sequencing, parity orchestration, repair decisions, and final classification.                                                                        |
| Harness           | Provides controlled execution, policy, and ledger infrastructure without deciding parity outcomes.                                                                 |
| Build/Test Runner | Compiles and executes generated Java and returns build/runtime diagnostics.                                                                                        |
| Evidence service  | Persists run evidence, artifact references, comparison material, approvals, and audit metadata.                                                                    |
| Model Gateway     | The only productive model boundary for diagnosis, repair proposals, and any other productive model participation.                                                  |

## Failure Taxonomy

The executable truth for failure codes lives in code, schemas, and tests. This
document defines the consumer-facing taxonomy that downstream APIs and Studio
surfaces must preserve:

| Failure family                | Meaning                                                                                                      | Typical owner                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Unsupported input             | The COBOL shape, runtime dependency, or execution requirement is outside the supported trust slice.          | Orchestrator classification with corpus/governance backing  |
| Reference or fixture issue    | The curated reference fixture, trust-case input, or reference artifact is missing, inconsistent, or invalid. | Orchestrator / evidence / fixture governance                |
| Generation defect             | The generated Java candidate cannot represent the supported source behavior within the contract.             | Orchestrator + target Java generation workflow              |
| Build failure                 | Generated or repaired Java fails deterministic build or test execution.                                      | Build/Test Runner                                           |
| Runtime failure               | Generated or repaired Java builds but fails during controlled execution.                                     | Build/Test Runner / Orchestrator                            |
| Parity mismatch               | Reference and target outputs execute but do not compare equal after deterministic normalization.             | Deterministic comparison owned by the Orchestrator workflow |
| Repair policy or budget block | A repair attempt is denied by policy, approval, or bounded budget rules.                                     | Orchestrator + Model Gateway policy                         |
| Evidence incomplete           | Required run evidence, hashes, approvals, or artifact references are missing.                                | Evidence service + Orchestrator finalization                |

Failure classification may inform model-assisted diagnosis, but it still routes
through deterministic evidence and final classification.

## Evidence Requirements

The first trust workflow must preserve at least these evidence classes:

- selected and resolved trust-case identity, version, catalog version/hash, and
  configuration digest;
- runtime profile, comparison policy, and trust-case evidence artifact
  references resolved from the catalog;
- input fixture identity and version;
- reference artifact identity and provenance;
- generated Java candidate identity and provenance;
- build and runtime diagnostics;
- normalized comparison result and parity status;
- deterministic comparison policy/version plus projected execution,
  comparison, and diff references;
- mode labels presented to the developer;
- repair proposal metadata, the approved patch payload hash, the authenticated
  identity of the approving developer, the reviewed generated-Java candidate
  identity and base-revision digest/ref, approval or rejection decision, and
  any applied patch provenance;
- final run classification and any evidence completeness warnings.

## Evidence Storage Boundary

Evidence service stores durable proof, not working scratch space. For this
workflow, the following fields may be persisted in Evidence when they are
required for audit, replay, or deterministic verification:

| Contract area           | May be stored in Evidence                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run identity and status | trust-case identifiers and versions, run identifiers, workflow identifiers, mode labels, completeness status, final classification, and evidence-completeness warnings                                                                                                                                             |
| Deterministic artifacts | source COBOL references, input fixture references, reference artifact references, generated Java candidate references, build/test result references, runtime version references, harness event references, trajectory ledger references, and unsupported-feature references                                        |
| Comparison results      | normalized comparison outputs, parity status, oracle comparison references, workflow/evidence `parityComparison` projections, comparison policy version/reference, execution/comparison result refs, diff refs, matched/mismatched outcome, and the hashes or byte sizes needed to verify the referenced artifacts |
| Assist lineage          | `assistDecision` outcome, reason code, selected agent role, decision timestamp, budget snapshots, and affected artifact references                                                                                                                                                                                 |
| Repair lineage          | `repairAttempts` metadata, decision refs, model invocation refs, approved patch payload hash, reviewed generated-Java candidate identity, reviewed base-revision digest/ref, approving developer identity, approval or rejection decision, and applied patch provenance                                     |
| Manual-edit provenance  | `manualEditsCarriedOver`, `manualDriftRegionCount`, and the `manualEditOverlay` reference when manual edits are present                                                                                                                                                                                            |
| Governance context      | open assumptions that are safe to retain, validation summaries, and other non-secret audit metadata that can be represented as references or bounded text                                                                                                                                                          |

The following inputs must remain transient, upstream-only, or redacted before
they reach Evidence storage:

- raw model prompts, completions, and chain-of-thought style reasoning;
- review comments or patch text that includes credentials, secrets, or other
  sensitive source material;
- unbounded stdout/stderr, stack traces, and failure dumps when they contain
  secret-bearing content;
- inline copies of source code, generated code, or fixture payloads when a
  content-addressed reference is sufficient;
- any field value rejected by the evidence-service secret/credential checks.

When a value must be retained for audit but is too sensitive or too large to
store inline, Evidence should keep the content-addressed reference and hash
only, while the full payload remains in the originating system or a redacted
artifact store.

## Security and Sandboxing Requirements

The trust workflow imposes these requirements. The Harness is the enforcement
owner for runner isolation; the BFF and Orchestrator are the enforcement owners
for transport authentication, authorization, and approver identity binding;
Build/Test Runner contract conformance must be validated before a trust case is
promoted to a release-gated workflow.

- productive model calls go through the Model Gateway only;
- repair proposals remain reviewable and are not applied automatically;
- browser-facing diagnostics, diffs, patch previews, and artifact previews
  must apply the same secret, credential, and path redaction policy before
  rendering, and they should prefer content-addressed references when raw
  payloads are unnecessary;
- generated Java build and execution stay inside controlled product execution
  substrates;
- generated or repaired Java executes in an isolated runner contract enforced
  by the Harness with no outbound network access for the W0 trust slice unless
  a later ADR or contract explicitly changes that requirement, no
  secret-bearing environment variables, least-privilege filesystem access, and
  no direct write path into evidence storage;
- the isolated runner enforces a bounded resource envelope, which the Harness
  runner contract expresses as separately measured caps: a maximum wall-clock
  duration, a maximum resident set size (RSS) for the runner process, a
  maximum JVM heap size for the generated-Java process, and a bounded
  stdout/stderr capture; together these prevent a malformed or adversarial
  generated Java program from exhausting runner capacity or evidence storage,
  and the concrete cap values are versioned alongside the comparison policy;
- all run-scoped read, control, and export endpoints exposed through the BFF
  must authorize against the same authenticated tenant/run-owner context
  captured at trigger time and reject before any artifact resolution or
  download is attempted;
- repair approvals are bound to the exact patch payload hash that Studio
  reviewed, to the immutable generated-Java candidate identity and
  base-revision digest/ref that Studio reviewed, and to the authenticated
  identity of the approving developer; the approving identity must match the
  run owner, and apply must reject any patch hash mismatch, any candidate or
  base-revision drift, or any non-matching approving identity;
- repair scope is limited to the generated Java candidate and may not alter
  reference artifacts, comparison logic, evidence logic, or policy surfaces;
- policy, redaction, and approval metadata are preserved in the evidence path;
- mode labels, approvals, approver identity, and deterministic outcomes remain
  auditable;
- manual Java edits follow
  [ADR 0007](../adr/0007-studio-java-manual-edit-provenance.md) and do not
  weaken deterministic authority.
