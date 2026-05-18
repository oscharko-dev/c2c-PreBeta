# ADR 0006: Studio-BFF Contract Versioning Policy

**Date:** 2026-05-18
**Status:** Accepted

## Context

Epic [#239](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
extends multiple DTOs that flow from the BFF to the C2C Studio:

- `Diagnostic` gains positional fields (`line`, `column`, `endLine`,
  `endColumn`, `filePath`, `sourceKind`, `originStep`) plus a
  forward-looking `artifactRef` for marker→artifact attribution
  (Studio-IDE-5, [#244](https://github.com/oscharko-dev/c2c-PreBeta/issues/244);
  Studio-IDE-6, [#248](https://github.com/oscharko-dev/c2c-PreBeta/issues/248)).
- `GeneratedTraceability` is new — IR identifier and source hash for
  lineage tooltips and "jump to source" actions.
- The run summary envelope (`RunSummary`) gains the optional
  `javaRegionClassification` field used by Studio-IDE-13 to colour the
  generated-Java buffer by trust pillar.
- ADR 0004 already governs the Editor-Assist response shape; that
  channel falls under the same versioning policy.

The
[W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
already states: _"Consumers must tolerate `assistDecision=null` before
the gate fires and missing W0.3 fields for older persisted runs."_
That sentence is the principle this ADR generalises. The epic also
contemplates W1 Evidence-Pack replay, where older runs are reopened in
a newer Studio build. Without an explicit versioning policy the
implementor of Studio-IDE-5 or Studio-IDE-6 has no contract for how
to treat missing positional fields, no contract for unknown future
fields, and no story for replay against `v0` fixtures.

Verified current state:

- Envelope-level JSON Schemas under `schemas/` already carry
  `schemaVersion` (see e.g.
  [schemas/build-test-result-v0.json](../../schemas/build-test-result-v0.json),
  [schemas/evidence-pack-manifest-v0.json](../../schemas/evidence-pack-manifest-v0.json)).
  Sub-shapes (`Diagnostic`, `GeneratedTraceability`) do not.
- The BFF wire surface lives in
  [services/c2c-bff/openapi.yaml](../../services/c2c-bff/openapi.yaml);
  `Diagnostic`, `GeneratedTraceability`, and `RunSummary` are declared
  there without a `schemaVersion` field today.
- The Studio TS mirror lives in
  [apps/c2c-studio/src/types/api.ts](../../apps/c2c-studio/src/types/api.ts).
  Some downstream DTOs already version themselves explicitly (e.g.
  `JavaOriginOverlay.schemaVersion: "v0"`); `Diagnostic`,
  `GeneratedTraceability`, and `RunSummary` do not.

This ADR settles **five decisions** so Studio-IDE-5 (#244) and
Studio-IDE-6 (#248) can begin implementation without versioning
ambiguity. Implementation of the new fields themselves remains the
responsibility of the named child issues.

## Decision

### 1. Schema Version Field

Every evolving Studio-BFF DTO carries an explicit, optional
`schemaVersion` field with values drawn from the closed set
`"v0" | "v1" | ...`. The field is:

- **Optional** on the wire — absence means "v0", which preserves
  forward-compatibility with persisted runs that predate this ADR.
- **String, not integer** — matches the convention already used by
  every schema under `schemas/` and by `JavaOriginOverlay`.
- **Versioned per DTO, not per envelope** — `Diagnostic.schemaVersion`
  evolves independently of `RunSummary.schemaVersion`. Tying versions
  together would force a `RunSummary` bump every time a positional
  field is added to `Diagnostic`, which is the opposite of what the
  additive-only rule below is meant to achieve.

The DTOs in scope **as of this ADR** are:

- `Diagnostic` (default `v0`).
- `GeneratedTraceability` (default `v0`).
- `RunSummary` (default `v0`).

The `JavaOriginOverlay` DTO from Studio-ADR-4
([ADR 0004](0004-studio-editor-assist-channel.md) downstream) already
follows this pattern and is referenced as the canonical example.

**Why explicit, not field-presence detection.** Field-presence
detection works for additive changes but is silent on semantic
changes within an existing field. If a future `Diagnostic.severity`
gains a new enum value `info-rich`, a Studio that only branches on
field presence cannot distinguish a `v0` `severity: "info"` from a
`v1` `severity: "info-rich"`. An explicit version field lets the
Studio gate the interpretation, not just the rendering.

### 2. Backward Compatibility

The contract is **additive-only at minor wave boundaries**.

- **Adding optional fields** is always allowed and does not bump
  `schemaVersion`. Consumers tolerate their absence (see Decision 4).
- **Removing a field** requires a **deprecation period of at least
  one minor wave**. The field is annotated `deprecated: true` in
  OpenAPI for one wave (e.g. introduce deprecation in W0.3, remove in
  W1.1), and Studio code switches off it before the removal lands.
- **Tightening a field** (narrowing a type, changing enum values,
  making an optional field required) is **not additive** and requires
  a `schemaVersion` bump. The BFF emits both the old shape under the
  old version and the new shape under the new version for at least
  one wave, then drops the old shape.
- **Renaming a field** is a remove + add and follows the removal
  rules.

The orchestrator-side artifact schemas under `schemas/` are governed
by the same rule, with envelope-level `schemaVersion` already bumped
explicitly (today's value is `"v0"` everywhere).

**Why a one-wave deprecation window.** W0.3 → W1.1 is approximately
6–10 weeks in the current release cadence. Long enough to land Studio
changes without an emergency rebuild; short enough to avoid permanent
support of stale fields. The W0.3 workflow doc's existing line about
tolerating missing fields stands; this ADR extends it to deprecation
removal so consumers do not depend on a field that the BFF has
flagged for removal.

### 3. Forward Compatibility

The Studio MUST NOT crash on unknown DTO fields from a future BFF.

- TypeScript interfaces use `unknown` (not `any`) for forward-looking
  fields where Studio code does not yet handle them. The Studio
  fetcher boundary preserves unknown fields end-to-end rather than
  filtering them out, so they survive into trace artifacts the user
  may export.
- **Opaque pass-through is the default**: any field the Studio does
  not branch on is propagated through the data layer untouched. The
  Studio data layer never deep-clones via a structural type that
  would strip extras; it preserves the parsed JSON object reference.
  The runtime cost of this is one allocation per fetched envelope,
  which is acceptable for the affected endpoints (sub-second polling
  cadence, not per-keystroke).
- Unknown enum values (e.g. a `Diagnostic.severity` the Studio does
  not recognise) render at the **lowest known severity that does not
  block** — concretely, Studio falls back to `"info"` for unknown
  severities and surfaces the raw upstream value in the marker
  tooltip so a reviewer can still see what the BFF sent.
- Unknown `schemaVersion` values follow the same rule: Studio renders
  the DTO under the closest known prior version (today, `"v0"`) and
  emits a single telemetry warning. Studio does NOT refuse the
  response; refusing would make every Studio upgrade a hard
  cross-deploy synchronisation problem.

**Why preserve unknown fields rather than reject.** Studio is the
downstream of a service it does not deploy in lockstep with. A
hard-rejecting client turns every additive BFF change into an outage
window — the opposite of the additive-only goal. The hostile case
(BFF sends garbage) is handled at the BFF contract layer, not by
Studio.

### 4. Null-Field Fallback Rules

For each newly optional field on a Studio-rendered DTO, the
specific fallback is:

| Field                                 | Absent / `null` fallback                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Diagnostic.line`                     | Marker placed at file level in the Problems panel; no source jump; tooltip reads _"Location unavailable"_.    |
| `Diagnostic.column`                   | Marker spans the whole line `line` (or whole file if `line` is also absent).                                  |
| `Diagnostic.endLine` / `endColumn`    | Treat as point marker at `(line, column)`; do not extend selection.                                           |
| `Diagnostic.filePath`                 | Marker is "run-level"; rendered in the run-level Problems pane, not on any editor tab.                        |
| `Diagnostic.sourceKind`               | Treat as `"unknown"`; do not infer from filename; do not gate trust-pillar decoration on the value.           |
| `Diagnostic.originStep`               | Do not show the "originated in step N" pill; the diagnostic still renders.                                    |
| `Diagnostic.artifactRef`              | No "jump to artifact" action; the marker still renders and is selectable.                                     |
| `GeneratedTraceability` (whole DTO)   | Lineage UI shows _"Lineage unavailable"_; the lineage tooltip is suppressed; generated-Java pane still loads. |
| `GeneratedTraceability.programId`     | Use the run-level `programId`; never block lineage rendering on this single field.                            |
| `GeneratedTraceability.irId`          | Suppress the "open IR" affordance; the rest of the lineage view renders.                                      |
| `GeneratedTraceability.sourceHash`    | Suppress the "verify source hash" badge; do not invent a hash.                                                |
| `RunSummary.javaRegionClassification` | No trust-pillar decoration on the generated-Java buffer; do NOT infer regions from filename or content.       |
| `RunSummary.message`                  | Do not render the message banner; existing behaviour.                                                         |

**No inference is permitted.** A missing field is missing; the Studio
must not guess. Guessing produces silent contract drift that hides
real BFF regressions.

**Telemetry on fallback**. The Studio emits a structured telemetry
event `contract.fallback` with `{ dto, field, runId? }` for each
fallback path actually exercised in a session, capped at one event
per `(dto, field)` per session to bound volume. Operators see the
trend without the noise of one event per diagnostic.

### 5. Evidence-Pack Replay (W1 Forward-Look)

W1 introduces Evidence-Pack replay: the user reopens a frozen run in
a newer Studio and edits forward from there. The Studio that lands
W0.3 work MUST already today behave correctly on `v0` fixtures.

- Older runs in Evidence Pack may carry `Diagnostic.schemaVersion`
  absent or equal to `"v0"`, with `line`, `column`, `endLine`,
  `endColumn`, `filePath`, `sourceKind`, `originStep`, and
  `artifactRef` all absent. Studio must render the Problems panel
  without errors against these fixtures.
- Older runs may carry `GeneratedTraceability` absent entirely on the
  `GeneratedView`. The Lineage UI must render the _"Lineage
  unavailable"_ state.
- Older runs may carry no `javaRegionClassification`. The
  generated-Java buffer must render without trust-pillar decoration.
- The Studio test suite includes a `v0` fixture set that pins this
  behaviour; new fields added to the contract must not cause
  pre-existing `v0` fixtures to start failing. CI on every PR that
  touches the affected types runs the `v0` fixture regression.
- **Replay implementation itself is out of scope** (W1). The
  obligation today is: do not foreclose replay by writing Studio
  code that crashes on older shapes.

**Why version-pin today, not later.** Once W1 lands replay, retro-
fitting tolerance into a Studio that has been free to assume the
W0.3 shape will require auditing every code path that touches the
affected DTOs. The audit is cheap now (the relevant code paths are
the size of a Studio component); it is expensive after Studio-IDE-13
and adjacent feature work has multiplied the call sites.

## `editorPersistence` and Editor-Assist Channel — Out of Scope Here

ADR 0005 governs the local-persistence record shape
([§2 "Encryption at Rest"](0005-studio-local-persistence-security-boundary.md))
whose `schemaVersion` is the **storage record** version, not the wire
DTO version. ADR 0004 governs the Editor-Assist response shape and
ledger fields. Both DTOs are subject to the policy in this ADR (they
are evolving Studio-BFF DTOs); the specific decisions in 0004 and
0005 remain authoritative for their domain.

## Rationale

**Why "additive-only at minor wave boundaries" rather than strict
semver.** The project ships waves, not semver. Tying the contract
policy to the wave boundary aligns the contract with the artifact
that already controls release coordination. A strict semver policy
would require Studio and BFF to agree on what constitutes a major
change, which is a coordination cost we don't want to bear for the
W-series.

**Why an optional `schemaVersion` rather than a required one.** A
required `schemaVersion` would break every persisted W0.3 run on the
day this ADR lands — those records were never written with the
field. Optional + default-to-`"v0"` is the same contract observably
and ships safely.

**Why one-wave deprecation, not patch-level removals.** Studio and
BFF are deployed on the same wave cadence in CI but not necessarily
in production. A one-wave window guarantees at least one full release
during which the new and old shapes coexist, so an operator can roll
back either side independently without a coordinated downtime.

**Why null-fallback is enumerated, not generalised.** A generalised
rule like _"missing fields render gracefully"_ produces inconsistent
UI: one implementor reads "graceful" as "hide the row", another as
"show '?'". The enumerated table is the contract surface UI reviewers
can check against.

**Why no inference.** Inference hides BFF bugs. The user-visible cost
of "missing field shows missing-state" is small; the cost of "missing
field is silently guessed and the guess is wrong" is a debugging
session that lands on the wrong service.

## Consequences

### Becomes easier

- Studio-IDE-5 (#244) and Studio-IDE-6 (#248) start with a complete
  null-handling and version-handling specification — no per-PR
  invention of fallback rules.
- W1 Evidence-Pack replay is no longer a "redesign the contract"
  task; it inherits the version handling that already shipped.
- BFF can add fields without coordinating a Studio cut; Studio
  tolerates them via opaque pass-through.
- CSP, telemetry, and audit reviewers have a named field
  (`contract.fallback`) to monitor.

### Becomes harder

- Removing a field now costs a wave of deprecation. The cleanup
  itself is small; the deferred reward is the price of a stable
  contract.
- Studio carries `unknown` fields through its data layer. Tooling
  that prints DTOs verbatim (debug panels, copy-to-clipboard) must
  not assume the typed shape is exhaustive.
- The `v0` fixture regression on every PR adds a small CI cost in
  exchange for replay readiness.

### Operational notes

- **OpenAPI is the wire source of truth** for Studio-BFF DTOs. The
  TS types under `apps/c2c-studio/src/types/api.ts` mirror OpenAPI;
  any drift is a bug. The `schemaVersion` field appears in both.
- **`schemas/*.json` already carry envelope-level `schemaVersion`**;
  this ADR does not duplicate the policy onto them. The Diagnostic
  sub-shape now declares `schemaVersion` inside
  [schemas/build-test-result-v0.json](../../schemas/build-test-result-v0.json)
  via a `$defs/Diagnostic` definition so an orchestrator-side
  consumer reading the executable schema sees the same versioning
  surface.
- **Editor-Assist** (`/api/v0/editor/explain`) is covered: ADR 0004
  governs the field set; this ADR governs the version field.

### Named follow-ups

1. Studio-IDE-5 and Studio-IDE-6 wire the new `Diagnostic` positional
   fields and the `originStep` / `artifactRef` plumbing.
2. Studio-IDE-13 wires the trust-pillar decoration that reads
   `RunSummary.javaRegionClassification`.
3. W1 Evidence-Pack replay implementation.
4. Optional Studio `contract.fallback` dashboard.

## References

- Issue: [Studio-ADR-3 Studio-BFF Contract Versioning Policy (#241)](https://github.com/oscharko-dev/c2c-PreBeta/issues/241)
- Parent epic: [IDE-Grade Modernization Editing Experience (#239)](https://github.com/oscharko-dev/c2c-PreBeta/issues/239)
- Downstream slices (blocked on this ADR):
  - [Studio-IDE-5 (#244)](https://github.com/oscharko-dev/c2c-PreBeta/issues/244)
  - [Studio-IDE-6 (#248)](https://github.com/oscharko-dev/c2c-PreBeta/issues/248)
- Related ADRs:
  - [ADR 0003 — W0.3 Deterministic-First Multi-Agent Hardening](0003-w0-3-deterministic-first-multi-agent-hardening.md)
  - [ADR 0004 — Studio Editor-Assist-Channel](0004-studio-editor-assist-channel.md)
  - [ADR 0005 — Studio Local Persistence & Editor Security Boundary](0005-studio-local-persistence-security-boundary.md)
- [Orchestrator W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md)
