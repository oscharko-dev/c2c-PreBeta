# W0 Release Gate

This document is the go / no-go checklist for closing Wave 0 and starting
Wave 1 planning. Every item must be evidenced by a real artifact the reviewer
can re-derive from the repository. Nothing on this gate may be marked done
purely on a verbal claim or a screenshot.

> Issue: [#16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16) ·
> Parent epic: [#1](https://github.com/oscharko-dev/c2c-PreBeta/issues/1) ·
> Companion: [W0 reference runbook](../showcase/w0-reference-runbook.md),
> [W0 scorecard](../showcase/w0-scorecard.md),
> [W0 follow-ups](../showcase/w0-followups.md).

## Decision

| Field | Value |
|-------|-------|
| Status | **GO for Wave 1 planning** as of the run tag below. |
| Recorded run tag | `20260514T104603Z` |
| Evidence sources | [w0-scorecard.md](../showcase/w0-scorecard.md), [reference-evidence-pack/](../showcase/reference-evidence-pack/), CI on `dev` |
| Sign-off | Issue [#16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16) closing comment links to this document. |

Wave 1 planning may proceed under the explicit constraints in
[§ "What is *not* ready"](#what-is-not-ready). Wave 1 is **not** authorised
to remove or weaken any of the W0 acceptance bars below.

## What is ready

### 1. Repeatable end-to-end walking skeleton

- [x] A fresh developer can run `./scripts/w0-reference-run.sh` from a clean checkout
      and reproduce the entire COBOL-to-Java workflow against the documented
      W0 corpus without standing up any external infrastructure. Wall-clock
      ~15 s after a warm Maven cache.
      _Evidence_: [`scripts/w0-reference-run.sh`](../../scripts/w0-reference-run.sh) and
      [w0-reference-runbook.md](../showcase/w0-reference-runbook.md).
- [x] The runbook documents every service, port, and environment variable.
      _Evidence_: [w0-reference-runbook.md](../showcase/w0-reference-runbook.md).

### 2. Real COBOL-to-Java transformation through every W0 service

- [x] Every program in the W0 corpus exits the chain with a compiled Java
      project, a runtime execution result, and a hash-referenced
      Build/Test Result conforming to
      [`schemas/build-test-result-v0.json`](../../schemas/build-test-result-v0.json).
      _Evidence_: [`docs/showcase/reference-evidence-pack/BRNCH01-build-test-result.json`](../showcase/reference-evidence-pack/BRNCH01-build-test-result.json).
- [x] Generated Java compiles cleanly for **3 / 3** W0 programs.
      _Evidence_: scorecard "Generated Java compiled cleanly" row.

### 3. Golden Master comparison is byte-equal for the W0 subset

- [x] All three W0 corpus programs end with
      `classification == match`. The runner cross-references
      [`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
      entries that now declare `knownDivergenceAtW0: false`.
      Any undocumented divergence (`divergence-unknown`) fails this gate.
      _Evidence_: scorecard "Per-program results" table.

### 4. Evidence Pack v0 fully validated end-to-end

- [x] Every run produces an Evidence Pack manifest that satisfies
      [`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json),
      with `status == complete` and `validation.ok == true`.
      _Evidence_: [`docs/showcase/reference-evidence-pack/BRNCH01-evidence-pack.json`](../showcase/reference-evidence-pack/BRNCH01-evidence-pack.json).
- [x] Each manifest references source COBOL, Semantic IR, generated Java,
      build/test result, Harness Events ledger, model invocations,
      and trajectory ledger by URI + sha256 — no raw secrets, prompts, or
      generated source embedded in the bundle.
      _Evidence_: manifest `artifacts.*` block.
- [x] Export round-trips deterministically to a directory under
      `EVIDENCE_EXPORT_DIR` and the export reference is added back to the
      manifest with its own sha256.
      _Evidence_: manifest `exports[0]`.

### 5. Harness Event Envelope coverage across the critical path

- [x] Every workflow step posts an envelope-conformant event to the harness
      `/v0/events` endpoint. The scorecard's "Harness Event Envelope ledger
      entries captured" metric is non-zero (45 across 4 reference-run executions).
      _Evidence_: scorecard "Aggregate metrics" table.
- [x] Each Evidence Pack manifest carries a `harnessEvents` ref whose
      sha256 matches the harness snapshot taken at that point in the run.
      _Evidence_: per-program manifests under [`reference-evidence-pack/`](../showcase/reference-evidence-pack/).

### 6. Experience Events on controlled scenarios

- [x] The reference run executes a controlled "BRNCH01 ×2" scenario and the
      experience-learning analyzer emits at least one event per
      `{success, failure, retry, repeated-action}` outcome class:
      `repeat_action`, `unchanged_output`, `test_failure`, `repeated_failure`
      patterns are all present in the captured run.
      _Evidence_: [`reference-evidence-pack/experience-events-summary.json`](../showcase/reference-evidence-pack/experience-events-summary.json).

### 7. Honest about model-gateway scope

- [x] No model-gateway call is made during W0. Every Evidence Pack manifest
      carries an explicit `modelInvocations[0].status = "skipped"` ledger
      entry pointing at an observation-only ledger so the bundle records
      that fact instead of hiding it.
      _Evidence_: manifest `artifacts.modelInvocations` block.

### 8. CI baseline green

- [x] `.github/workflows/ci.yml` covers shell syntax, Python compile,
      Java verify (runtime lib + four capability services), Go test, Node
      build/test on c2c-bff and c2c-ui. All gates pass on `dev` at the
      merge of #15 (the merge that this PR diverges from).
      _Evidence_: GitHub Actions on `dev`.

### 9. Governance hygiene

- [x] No source for this issue lives outside an issue/PR. Branch:
      `claude/issue-16-w0-reference-run-release-gate`. PR linked back to issue #16
      with `Resolves #16`.
- [x] No TODOs or temporary workarounds were merged. Any deferred work is
      filed as an explicit follow-up under
      [`docs/showcase/w0-followups.md`](../showcase/w0-followups.md):
      [#64](https://github.com/oscharko-dev/c2c-PreBeta/issues/64),
      [#65](https://github.com/oscharko-dev/c2c-PreBeta/issues/65),
      [#66](https://github.com/oscharko-dev/c2c-PreBeta/issues/66),
      [#67](https://github.com/oscharko-dev/c2c-PreBeta/issues/67),
      [#68](https://github.com/oscharko-dev/c2c-PreBeta/issues/68).
      The duplicate-step trajectory-ledger gap originally filed as
      [#63](https://github.com/oscharko-dev/c2c-PreBeta/issues/63) is fixed
      in the Epic #1 hardening branch.

## What is *not* ready (and what must not be claimed)

- **Production readiness.** W0 is a walking skeleton with synthetic corpus
  fixtures. No customer source has ever been ingested. Marketing must not
  claim "production-ready"; the README and the
  [release gate scope](#scope) constrain the narrative.
- **COBOL coverage beyond the selected W0 subset.** The generator now covers the
  checked-in W0 arithmetic/control-flow/OCCURS fixtures byte-for-byte, but it is
  still not a feature-complete COBOL translator.
- **Full true `cobcrun` coverage.** BRNCH01 is now a true Golden Master
  reproduced by GnuCOBOL `cobcrun`; CTRLDEC01 and BATCH01 remain documented
  synthetic fixtures until a later fixture-hardening pass promotes them.
- **Model gateway.** Zero model calls in W0. Wave 1 will exercise
  `model-gateway-service` end-to-end with a documented allowlist.
- **Harness-driven orchestration semantics.** The W0 reference run registers every
  W0 capability in the Harness catalog and resolves service endpoints from
  that catalog before invocation. The remaining Wave 1 gap is moving this
  bootstrap and live payload adaptation into `orchestrator-service.main`
  itself; the direct reference-run driver stays only as the deterministic release-gate
  harness.

## Scope

- **In scope for W0**: parse → IR → Java generation → compile + run → Evidence
  Pack v0 + Harness ledger + Experience Learning analysis for three
  documented synthetic COBOL programs.
- **Out of scope for W0**: Wave 1 feature implementation, customer pilot
  onboarding, claims of production readiness, complete true `cobcrun`
  coverage for every fixture, model-gateway exercise, multi-tenant
  authentication.

## Re-evidencing this gate

A reviewer can re-derive every "ready" item by running:

```bash
./scripts/bootstrap.sh
./scripts/w0-reference-run.sh
cat var/w0-reference-run/scorecard.md
```

and comparing the produced scorecard and per-program manifests against the
committed snapshots in [`docs/showcase/`](../showcase/).
