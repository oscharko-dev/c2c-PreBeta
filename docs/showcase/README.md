# W0 Showcase

Entry point for the c2c **Wave 0 walking skeleton** showcase. Everything
here is reproducible from a clean checkout via `scripts/w0-reference-run.sh`.

## Documents

| Document | Purpose |
|----------|---------|
| [w0-reference-runbook.md](w0-reference-runbook.md) | How to reproduce the end-to-end W0 reference run, both via the script and by hand. |
| [w0-scorecard.md](w0-scorecard.md) | Captured metrics from a real reference run. The release gate refers to this. |
| [w0-followups.md](w0-followups.md) | Work intentionally deferred to Wave 1. Each item is filed as its own GitHub issue. |
| [../release/w0-release-gate.md](../release/w0-release-gate.md) | Go/no-go checklist with evidence pointers. |
| [../release/w0-corrective-epic-86.md](../release/w0-corrective-epic-86.md) | Closure evidence for the product-path corrective epic. |

## Reference artifacts (frozen for review)

[`reference-evidence-pack/`](reference-evidence-pack/) contains a frozen snapshot
of the artifacts that the most recent reference run produced. They are committed
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
- The reference run can exercise `model-gateway-service` for a bounded Foundry
  development invocation; disabled or over-limit runs still record explicit
  `status: "skipped"` model-invocation entries rather than hiding them.
- Generated stdout matches the checked-in Golden Master fixtures for the
  selected W0 subset; the acceptance bar is `classification == match`.
- BRNCH01 is reproduced through GnuCOBOL `cobcrun`; CTRLDEC01 and BATCH01
  remain clearly labelled synthetic Golden Master fixtures.
