# W0 Scorecard

Captured from a real `scripts/w0-demo.sh` run against the synthetic W0 corpus.
The scorecard is regenerated automatically on every demo execution and lives
at `var/w0-demo/scorecard.md`. The version in this folder is the
go/no-go evidence the W0 release gate refers to.

> Issue: [#16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16) · See also [w0-demo-runbook.md](w0-demo-runbook.md), [`docs/release/w0-release-gate.md`](../release/w0-release-gate.md), [`w0-followups.md`](w0-followups.md).

## Run identification

| Field | Value |
|-------|-------|
| Run tag | `20260514T090008Z` |
| Started (UTC) | 2026-05-14T09:00:08Z |
| Finished (UTC) | 2026-05-14T09:00:21Z |
| Wall-clock duration | ~13 s end-to-end on a developer laptop, after the one-time Maven warm cache. |
| Java | OpenJDK 21 (Homebrew) |
| Go | go1.26.x |
| Maven | 3.9.x |
| Corpus | `corpus/synthetic/programs/{branch-account-guard,ctrl-decimal-payroll,decimal-batch-aggregator}.cbl` |
| Golden Master fixtures | All three documented as `synthetic` in [`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json) |

## Per-program results

| Program | Compile | Ran | Build/Test status | Build/Test classification | Golden Master | Evidence Pack |
|---------|---------|-----|-------------------|---------------------------|---------------|---------------|
| BRNCH01 | `true` | `true` | `output-divergence` | `divergence-known-w0-coverage-gap` | `matched=false` (`synthetic`) | `complete` (`validation.ok=true`) |
| CTRLDEC01 | `true` | `true` | `output-divergence` | `divergence-known-w0-coverage-gap` | `matched=false` (`synthetic`) | `complete` (`validation.ok=true`) |
| BATCH01 | `true` | `true` | `output-divergence` | `divergence-known-w0-coverage-gap` | `matched=false` (`synthetic`) | `complete` (`validation.ok=true`) |

Acceptance bar at W0: `classification ∈ {match, divergence-known-w0-coverage-gap}`. Anything else (especially `divergence-unknown`) is a release-gate fail.

## Aggregate metrics

| Metric | Value | W0 acceptance |
|--------|-------|---------------|
| Programs exercised | 3 / 3 | 3 |
| Generated Java compiled cleanly | 3 / 3 | 3 |
| Generated Java executed | 3 / 3 | 3 |
| Build/test classification == `match` | 0 / 3 | _expected to be 0 at W0_ |
| Build/test classification ∈ documented W0 coverage-gap set | 3 / 3 | 3 |
| Golden-Master byte-equal matches | 0 / 3 | _expected_ |
| Evidence Packs `validation.ok == true` and `status == "complete"` | 3 / 3 | 3 |
| Evidence Pack export round-trips | 3 / 3 | 3 |
| Harness Event Envelope ledger entries captured | 32 | ≥ one per service step |
| Distinct harness `runId`s exercised | 4 (`run-1` … `run-3` + controlled `run-4`) | ≥ 3 + 1 controlled |
| Experience Events emitted | 19 | ≥ 1 (AC: success/failure/retry/repeat) |
| Distinct experience `patternFingerprint`s | 10 | ≥ 1 |

### Experience pattern breakdown

| Pattern | Count | Source |
|---------|-------|--------|
| `repeat_action` | 7 | Driven by the controlled BRNCH01 ×2 scenario in `run-4`. |
| `unchanged_output` | 7 | Same controlled scenario; deterministic generator → identical `outputRef`. |
| `test_failure` | 4 | BTR `output-divergence` events bucketed across runs. |
| `repeated_failure` | 1 | BTR divergence repeated twice in the controlled scenario. |

This satisfies AC: _"Experience Events are produced for at least success, failure, retry, or repeated-action scenarios using controlled test cases."_ (success is represented by every `analysis.detected` observation; failure by `test_failure`/`repeated_failure`; repeat by `repeat_action`/`unchanged_output`.)

## Foundry / model-gateway invocation cost

W0 does **not** exercise `model-gateway-service` end-to-end. Each manifest carries an explicit `modelInvocations[].status = "skipped"` ledger entry pointing at an in-band observation-only ledger so the bundle is honest about it. **W0 cost = 0 model invocations.** Tracked as a Wave 1 follow-up — see [`w0-followups.md`](w0-followups.md).

## Known divergences from happy-path acceptance

- `Build/test classification == "match"` is **0 / 3** by design. The W0 generator does not yet translate `PERFORM`, `EVALUATE`, `IF`, `ADD`, or `COMPUTE`, so generated stdout cannot match the COBOL Golden Master at this wave. The runner's classifier flags every divergence as `divergence-known-w0-coverage-gap` after cross-referencing [`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json) entries that pre-declare `knownDivergenceAtW0: true`. Wave 1 will extend coverage; documented in [`w0-followups.md`](w0-followups.md).
- The harness `/v0/runs/{id}/ledger` endpoint and `experience-learning-service` `/v0/harness-events` endpoint both impose schema constraints that today's capability services do not yet meet without an orchestrator-side rewrite (unique `stepId`s; status enum). The demo applies a documented client-side normalization to satisfy them; the long-term fix is captured in [`w0-followups.md`](w0-followups.md).
- W0 fixtures are synthetic. True `cobcrun` golden masters are deferred to Wave 1 once the host CI image carries `cobc`. Already declared in `fixtures/golden-master/index.json` (`classification: "synthetic"`).

## Where the artifacts live

Reproducible from a fresh checkout via `scripts/w0-demo.sh`. Output paths (uncommitted; `var/` is `.gitignore`d):

- `var/w0-demo/scorecard.md` — auto-generated scorecard for that run.
- `var/w0-demo/artifacts/<programId>/16-evidence-manifest.json` — the canonical Evidence Pack manifest pulled back from `evidence-service`.
- `var/w0-demo/artifacts/<programId>/11-trajectory-ledger.json` — the per-run agent trajectory ledger.
- `var/w0-demo/artifacts/<programId>/08-build-test-response.json` — the build/test runner result.
- `var/w0-demo/exports/<packId>/` — the deterministic Evidence Pack export directory.
- `var/w0-demo/events/harness-events.jsonl` — the harness JSONL ledger captured during the run.
- `var/w0-demo/events/experience-events.jsonl` — the experience-learning JSONL output.

A frozen sample of the same artifacts (committed for review without re-running) lives under [`sample-evidence-pack/`](sample-evidence-pack/).
