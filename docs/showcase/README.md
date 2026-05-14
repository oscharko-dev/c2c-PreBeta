# W0 Showcase

Entry point for the c2c **Wave 0 walking skeleton** showcase. Everything
here is reproducible from a clean checkout via `scripts/w0-demo.sh`.

## Documents

| Document | Purpose |
|----------|---------|
| [w0-demo-runbook.md](w0-demo-runbook.md) | How to reproduce the end-to-end W0 demo, both via the script and by hand. |
| [w0-scorecard.md](w0-scorecard.md) | Captured metrics from a real demo run. The release gate refers to this. |
| [w0-followups.md](w0-followups.md) | Work intentionally deferred to Wave 1. Each item is filed as its own GitHub issue. |
| [../release/w0-release-gate.md](../release/w0-release-gate.md) | Go/no-go checklist with evidence pointers. |

## Sample artifacts (frozen for review)

[`sample-evidence-pack/`](sample-evidence-pack/) contains a frozen snapshot
of the artifacts that the most recent demo run produced. They are committed
so reviewers can read the manifest, trajectory ledger, build/test result,
and experience-event summary without standing up the services.

| File | Source |
|------|--------|
| `BRNCH01-evidence-pack.json` | `evidence-service` `GET /v0/packs/{packId}` for run `run-1` (BRNCH01). |
| `CTRLDEC01-evidence-pack.json` | Same, for CTRLDEC01 (`run-2`). |
| `BATCH01-evidence-pack.json` | Same, for BATCH01 (`run-3`). |
| `BRNCH01-trajectory-ledger.json` | Per-run agent trajectory ledger conforming to `schemas/agent-trajectory-ledger-v0.json`. |
| `BRNCH01-build-test-result.json` | `build-test-runner-service` result conforming to `schemas/build-test-result-v0.json`. |
| `experience-events-summary.json` | Aggregated experience events with `{pattern, occurrences, runId, …}` projection. |

## Constraints

The W0 showcase is intentionally narrow:

- Three synthetic COBOL programs, no customer source.
- No model-gateway calls. Each manifest records the absence with a
  `status: "skipped"` model-invocation entry rather than hiding it.
- Generated stdout diverges from Golden Master output by design at W0; the
  acceptance bar is `classification ∈ {match, divergence-known-w0-coverage-gap}`.
- Synthetic Golden Masters only. True `cobcrun` reproduction is a Wave 1
  task (see [w0-followups.md](w0-followups.md) F-W0-04).
