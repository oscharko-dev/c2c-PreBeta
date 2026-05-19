# ADR 0007: Studio Java Manual-Edit Provenance & Verification Model

**Date:** 2026-05-18
**Status:** Accepted

## Context

Epic [#239](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
makes generated Java fully editable inside the C2C Studio. Developers
may take ownership of a Generator-Run's Java output and continue to
edit it like in any IDE. This introduces a third class of artifact —
**human-edited Java** — that is neither pure deterministic generator
output nor a pure agent-proposed candidate.

The [c2c Fachkonzept](../concept/c2c-fachkonzept.md) is explicit:

> AI output is a candidate, never proof. `success` requires generated
> Java, build/test, oracle/equivalence, artifact hashes, and Evidence
> Pack to agree.

Manual edits change what `success` _refers to_. Without an explicit
contract, the W0.3 deterministic-first guarantee becomes ambiguous in
three ways:

1. **What counts as proof.** Does build/test/oracle still apply when a
   region of the verified Java was authored by a human?
2. **What lineage means.** Can the system still claim a Java region
   maps back to a specific COBOL statement after the region has been
   hand-rewritten?
3. **What the Repair Agent is allowed to touch.** Is a hand-edited
   region fair game for an agent suggestion, or is it user territory?

The epic Goal text combines two non-negotiables:

> the system honestly records the provenance of every region so audit,
> verification, and Explain remain auditable

and

> developers may take ownership of the Java output and edit it as in
> any IDE.

These two clauses together rule out the alternatives evaluated in
issue [#257](https://github.com/oscharko-dev/c2c-PreBeta/issues/257):

- **Option B** ("manual edits are proof; verification is optional")
  removes the deterministic gate the Fachkonzept owns. Rejected.
- **Option C** ("manual edits disable success classification entirely")
  removes the IDE ownership the epic owns. Rejected.

Only **Option A** — manual edits remain candidate, verification stays
mandatory, the Evidence Pack records provenance per region — is
consistent with both halves of the Goal. This ADR adopts Option A and
specifies the regional taxonomy, metadata, verification, assist, and
lineage rules that downstream issues
([Studio-IDE-13 #255](https://github.com/oscharko-dev/c2c-PreBeta/issues/255),
[Studio-IDE-6 #248](https://github.com/oscharko-dev/c2c-PreBeta/issues/248))
need before they can start.

Verified current state of the relevant contracts after ADR adoption:

- The W0.3 run contract (`services/orchestrator-service/src/orchestrator_service/run_contract.py`)
  already exposes assist-decision, budgets, repair attempts, and final
  classification. ADR 0007 extends that same additive run-summary
  surface with manual-edit provenance.
- The Evidence Pack manifest schema
  (`schemas/evidence-pack-manifest-v0.json`) already covers the
  deterministic baseline, agent-proposed candidates, and
  verification-repair candidates. ADR 0007 adds the manual-edit overlay
  reference and cross-field consistency rule.
- The [W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
  documents the assist-decision reason codes, the run-summary fields,
  and the consumer-visible evidence requirements.
- [ADR 0006 — Studio-BFF Contract Versioning](0006-studio-bff-contract-versioning.md)
  governs additive DTO evolution and the null-fallback rule for
  `RunSummary.javaRegionClassification`. ADR 0007 extends that v0
  surface with `manualEditsCarriedOver`, `manualDriftRegionCount`, and
  the `manualEditOverlay` evidence reference.

## Decision

The decision below is binding. It picks **Option A** and fixes the
five contract elements the downstream issues depend on.

### 1. Manual edits are candidate; verification is mandatory

Manual-edited Java goes through deterministic build/test/oracle
exactly like generator-produced Java. The final `success` /
`blocked` / `failed` / `cancelled` / `incomplete` classification is
determined exactly as today by
`run_contract.py:FINAL_CLASSIFICATIONS`. Manual edits never substitute
for verification.

A run that contains manual edits and passes deterministic verification
classifies as `success`. The Evidence Pack carries enough metadata for
an auditor to see which regions were manually authored.

### 2. Five-class provenance taxonomy

Each Java region carries exactly one `originClass`:

| Class              | Meaning                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `deterministic`    | Produced by the deterministic generator path. Unchanged since the Generator-Run.                  |
| `agent_proposed`   | Produced by the Transformation Agent during productive assist. Unchanged since the Generator-Run. |
| `repair_attempted` | Touched by the Verification/Repair Agent during a bounded repair iteration. Unchanged since.      |
| `manual_modified`  | Region was generator-produced (any of the three above) and then edited manually after the run.    |
| `manual_edit`      | Region did **not** exist in the Generator Baseline; it was added entirely by manual editing.      |

The set is closed. Any other string from a future BFF MUST be treated
as opaque by Studio (per
[ADR 0006 §3](0006-studio-bff-contract-versioning.md)).

**Granularity.** Provenance is tracked **per region**, where a region
is a contiguous line range sized to the smallest stable IR-node or
statement boundary. Not per file. File granularity would force the
whole file into `manual_modified` after a one-line tweak, destroying
the value of the taxonomy.

### 3. Per-region metadata schema

Manually-edited regions carry the following metadata on the
`manualEditOverlay` artifact in the Evidence Pack:

```json
{
  "schemaVersion": "v0",
  "regions": [
    {
      "lineRange": { "startLine": 42, "endLine": 47 },
      "originClass": "manual_modified",
      "generatorBaselineRunId": "run-2026-05-17-abc123",
      "generatorBaselineRegionHash": "9f86d0…",
      "lastModifiedAt": "2026-05-18T09:14:33Z",
      "lastModifiedBy": { "userId": "u_…", "tenantId": "t_…" },
      "manualEditCount": 3
    }
  ]
}
```

Required per entry:

- `lineRange: { startLine: number, endLine: number }`
- `originClass: "manual_modified" | "manual_edit"`
- `generatorBaselineRunId: string` — the run whose output the manual
  edits diverged from
- `lastModifiedAt: ISO8601`
- `lastModifiedBy: { userId, tenantId }`
- `manualEditCount: integer` — distinct save events on this region

Required for `manual_modified` only:

- `generatorBaselineRegionHash: string` — SHA-256 of the original
  region content. Lets auditors detect drift even after the baseline
  is no longer cached.

Omitted for `manual_edit` (there is no baseline content to hash).

### 4. Verification semantics

Build / test / oracle apply unchanged to the **final Java buffer**,
regardless of provenance distribution. There is no manual-edit
short-circuit, no manual-edit bypass, no per-region verification.

The run summary gains two additive fields the orchestrator stamps
when finalising the run:

- `manualEditsCarriedOver: boolean` — true iff the verified Java
  contained at least one `manual_modified` or `manual_edit` region.
  False when the Java buffer matches the Generator Baseline byte for
  byte.
- `manualDriftRegionCount: integer` — number of regions whose
  `originClass` is `manual_modified` or `manual_edit`. Zero when
  `manualEditsCarriedOver` is false.

Both fields are optional on the wire (per the additive-only rule in
[ADR 0006 §2](0006-studio-bff-contract-versioning.md)). A consumer
that sees them absent treats them as `false` / `0` respectively, which
matches the pre-ADR-0007 run shape.

### 5. Assist-interaction rule

A region with `originClass` `manual_modified` or `manual_edit` gates
subsequent Verification/Repair Agent activity that targets it: the
agent MUST NOT propose changes to the region without an explicit
caller opt-in recorded on the run-scoped `assistDecision.reasonCode`.

Concretely:

- Repair Agent activity over a manual region is gated on
  `assistDecision.reasonCode = caller_explicit_opt_in`. Any other
  reason code (including the four deterministic uncertainty markers)
  is a soft no-op for that region: the agent emits no candidate for
  the region and the orchestrator records a `no_change` repair
  attempt scoped to the region.
- The closed set of reason codes in
  `run_contract.py:ASSIST_REASON_CODES` is **unchanged**. This ADR
  reuses `caller_explicit_opt_in`; no new reason code is introduced.
- Studio surfaces this rule as an info banner in the Editor-Assist
  side panel when "Explain this region" (per
  [ADR 0004](0004-studio-editor-assist-channel.md)) is invoked on a
  manual region: _"This region is manually edited; agent suggestions
  for it require explicit opt-in."_

The orchestrator carries this rule through the existing
`assistDecision` shape; no new gate state is introduced.

### 6. Lineage semantics

Lineage from a Java region back to its COBOL origin is valid only for
regions that are `deterministic`, `agent_proposed`, or
`repair_attempted`. For the manual classes:

- `manual_modified` → lineage is marked **"stale due to manual edit"**.
  The `GeneratedTraceability` envelope for the region is rendered with
  the badge "stale" and the original IR identifier is preserved so an
  auditor can still locate the pre-edit anchor.
- `manual_edit` → lineage is marked **"unavailable"**. The
  `GeneratedTraceability` envelope for the region is omitted; Studio
  renders the lineage state per the
  [ADR 0006 §4](0006-studio-bff-contract-versioning.md) fallback
  ("Lineage unavailable").

The system MUST NOT synthesise a COBOL anchor for a manual region.
Fake mapping is the failure mode this rule prevents.

## Rationale

**Why Option A and not Option B.** The Fachkonzept names the
deterministic build/test/oracle gate as the single source of proof.
Option B removes that gate the moment a developer types. The promise
"AI output is a candidate, never proof" then applies to AI output but
not to human output, which is the inverse of any regulator's
expectation: the human-authored region is the part of the system
without test coverage by construction. Option B fails review.

**Why Option A and not Option C.** Option C ("manual edits disable
success entirely") is conservative but discourages the exact workflow
the epic exists to enable. Senior developers correcting a generated
boundary case would be rewarded with a permanent `manual_verified`
non-success state — a contract that nobody would adopt. The IDE
ownership clause in the Goal text makes Option C unviable.

**Why region granularity and not file granularity.** A file-level
provenance flag would collapse `manual_modified` and `manual_edit`
into the same bucket and would taint a 400-line file with one
hand-corrected boundary. The five-class taxonomy then loses its
discriminative power and the assist-interaction rule becomes too
coarse to apply. Region granularity is the smallest unit at which
the taxonomy is useful.

**Why per-region metadata and not a Java-buffer diff.** A diff
records the change but not the actor, the timestamp, or the baseline
the change diverged from. Audit reviewers and the Repair Agent both
need those four facts directly; reconstructing them from a diff is
either lossy or relies on metadata that has to exist anyway.

**Why no new reason code.** Adding `manual_region_blocked` or similar
would expand the closed reason-code enum on the gate. That enum is
load-bearing for every consumer that reads
`AssistDecisionSummary`; expanding it is a contract surface increase
that is not paid back, because the existing `caller_explicit_opt_in`
already encodes the "the user asked, do it anyway" semantics. The
assist-interaction rule is a region-level filter applied **after** the
gate has fired, not a new gate outcome.

**Why lineage marks "stale" rather than dropping it for
`manual_modified`.** The pre-edit IR anchor is still the right entry
point for an auditor who wants to compare the manual edit to the
generator output. Dropping lineage entirely would force the auditor
to guess at the original anchor. The "stale" badge tells the truth:
the mapping was correct at Generator-Run time and is no longer
guaranteed.

**Why the orchestrator owns `manualEditsCarriedOver` and
`manualDriftRegionCount`.** The orchestrator is the only component
that sees both the Java buffer that was verified and the
manual-edit overlay the Studio submitted. Computing the boolean and
the count anywhere else would either duplicate state (Studio also
computes) or lose state (evidence-service does not see Studio
overlays). The run contract is the obvious home.

## Consequences

### Becomes easier

- Studio-IDE-13 ([#255](https://github.com/oscharko-dev/c2c-PreBeta/issues/255))
  starts with a closed five-class taxonomy, a per-region metadata
  schema, and an explicit assist-interaction rule. No invention
  required.
- Studio-IDE-6 ([#248](https://github.com/oscharko-dev/c2c-PreBeta/issues/248))
  finalises its 5-class trust taxonomy by adopting the taxonomy in
  this ADR verbatim.
- Audit reviewers can answer "was this region machine-generated or
  hand-edited?" by reading one field per region in the Evidence
  Pack. No code inspection required.
- The Repair Agent has a single, mechanical rule to apply: do not
  propose to a `manual_modified` / `manual_edit` region unless the
  caller opted in explicitly.

### Becomes harder

- Studio MUST track per-region origin classes across edit sessions.
  The bookkeeping cost is paid once in the editor model, then read
  by every downstream feature.
- Evidence-service MUST persist the `manualEditOverlay` alongside
  the existing Java candidate history. The overlay is small (one row
  per drift region) but the schema and storage path must be wired.
- Lineage UI grows two new visible states ("stale" and
  "unavailable"). Studio test coverage must include both.
- Future ADRs that add a sixth origin class need to extend the
  taxonomy in `run_contract.py`, this ADR, the workflow contract
  doc, and the Evidence Pack manifest schema. The closed-set policy
  is the trade-off for the consumer-side simplicity.

### Operational notes

- The two run-summary fields are additive (per
  [ADR 0006 §2](0006-studio-bff-contract-versioning.md)). Older
  persisted runs that lack them are valid; consumers default to
  `false` / `0`.
- The `manualEditOverlay` artifact is referenced from
  `evidence-pack-manifest-v0.json` as an optional `dataReference`.
  A run with no manual edits omits the field entirely; a run with
  manual edits MUST include it for completeness.
- The Studio fallback `RunSummary.javaRegionClassification` absent
  case enumerated by
  [ADR 0006 §4](0006-studio-bff-contract-versioning.md) stands:
  Studio does not infer regions, does not paint trust-pillar
  decoration. The same rule applies to absent
  `manualEditsCarriedOver` and `manualDriftRegionCount`.
- Editor-assist (`POST /api/v0/editor/explain`, per
  [ADR 0004](0004-studio-editor-assist-channel.md)) is unchanged.
  Editor-assist does not produce or consume manual-edit overlay
  data; the rule in §5 above governs `assistDecision` invocations
  inside a run, not the parallel-governed editor-assist channel.

### Named follow-ups

1. Studio-IDE-13 ([#255](https://github.com/oscharko-dev/c2c-PreBeta/issues/255))
   implements `POST /api/v0/generate`, `POST /api/v0/compile-check`,
   `POST /api/v0/format/java`, the 3-Way Merge UI, and the per-region
   origin-class tracking in the editor model.
2. Studio-IDE-6 ([#248](https://github.com/oscharko-dev/c2c-PreBeta/issues/248))
   finalises the trust-pillar decoration to use the five-class
   taxonomy.
3. Evidence-service work to persist the `manualEditOverlay` artifact
   and include it in completeness validation.
4. Repair Agent enhancement: emit `no_change` repair attempts scoped
   to manual regions when the caller has not opted in.

## References

- Issue: [Studio-ADR-4 Java Manual Edit Provenance & Verification Model (#257)](https://github.com/oscharko-dev/c2c-PreBeta/issues/257)
- Parent epic: [IDE-Grade Modernization Editing Experience (#239)](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
- Downstream slices (blocked on this ADR):
  - [Studio-IDE-13 (#255)](https://github.com/oscharko-dev/c2c-PreBeta/issues/255)
  - [Studio-IDE-6 (#248)](https://github.com/oscharko-dev/c2c-PreBeta/issues/248)
- Related ADRs:
  - [ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](0003-w0-3-deterministic-first-multi-agent-hardening.md)
  - [ADR 0004 — Studio Editor-Assist-Channel](0004-studio-editor-assist-channel.md)
  - [ADR 0005 — Studio Local Persistence & Editor Security Boundary](0005-studio-local-persistence-security-boundary.md)
  - [ADR 0006 — Studio-BFF Contract Versioning](0006-studio-bff-contract-versioning.md)
- Contracts and schemas:
  - [Orchestrator W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
  - [Evidence Pack Manifest v0](../../schemas/evidence-pack-manifest-v0.json)
  - [Run contract source of truth](../../services/orchestrator-service/src/orchestrator_service/run_contract.py)
- [c2c Fachkonzept](../concept/c2c-fachkonzept.md)
