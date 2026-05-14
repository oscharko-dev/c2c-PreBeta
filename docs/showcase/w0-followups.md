# W0 Follow-Ups

Concrete items discovered while assembling the W0 end-to-end demo
([issue #16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16)) that are
**explicitly deferred** beyond the Epic #1 closure PR. Per the
[development workflow](../governance/development-workflow.md) governance rule,
scope expansion is not silently merged — every item below is filed as a
separate issue so it can be planned, owned, and verified independently.

Each entry includes the symptom seen during the W0 demo run, the contract /
service involved, and the fix shape or current resolution. Wave 1 owners may
take any open item without waiting for the others.

## F-W0-01 · `experience-learning-service` `/v0/harness-events` status enum mismatch · [#64](https://github.com/oscharko-dev/c2c-PreBeta/issues/64)

- **Symptom**: harness events with `status` values produced by W0 services
  (`starting`, `output-divergence`) got `HTTP 400 — status: unsupported`
  from the experience-learning harness-event validator.
- **Service(s)**: `experience-learning-service` (`types.go`
  harness-event status validation), all W0 services emitting harness events.
- **Resolution**: the service accepts raw Harness Event Envelope statuses
  and maps known statuses internally for analysis (`starting → started`,
  `output-divergence` / `compile-failed` / `run-failed → failed`). The W0 demo
  posts the raw harness ledger directly.
- **Fix shape**: keep the Harness Event Envelope status as raw producer data
  while keeping the *experience-event status enum* (`observed`, `ignored`)
  separate. Add status mapping inside the ingest/analysis path so callers do
  not need to translate.
- **Owner**: experience-learning.
- **Acceptance**: a raw harness event posted to `/v0/harness-events`
  without normalisation is accepted whenever the harness itself accepted
  the same envelope.

## F-W0-02 · Orchestrator capability auto-bootstrap and payload alignment · [#65](https://github.com/oscharko-dev/c2c-PreBeta/issues/65)

- **Symptom**: the W0 demo now registers parser, IR, generator, build/test,
  and evidence capabilities in the Harness catalog and resolves endpoints
  from that catalog before invocation. The remaining gap is that
  `orchestrator-service` still does not auto-bootstrap those registrations on
  a cold harness, and its current request payload shape is covered by mocks
  rather than the real W0 service HTTP contracts.
- **Service(s)**: `agentic-harness-core` (`policy.go` `DefaultPolicyEngine`),
  `orchestrator-service`.
- **Current guardrail**: `agent`-role registrations for core infrastructure
  remain denied. Authenticated `orchestrator` callers can register W0 core
  capabilities, and duplicate ids are rejected instead of overwritten.
- **Proposed fix**: teach `orchestrator-service.main` to bootstrap a
  documented W0 capability manifest from environment/config, then update its
  live payload adapters to match `cobol-parser-service`,
  `semantic-ir-service`, `target-java-generation-service`,
  `build-test-runner-service`, and `evidence-service`.
- **Owner**: harness / platform.
- **Acceptance**: `orchestrator-service.main` can register the parser, IR,
  generator, build/test, and evidence capabilities on a cold harness and
  then drive a run through `POST /v0/runs` without any manual capability
  insertion.

## F-W0-03 · True `cobcrun` Golden Masters · [#66](https://github.com/oscharko-dev/c2c-PreBeta/issues/66)

- **Symptom**: every fixture in
  [`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
  is `classification: "synthetic"`. The runner has a code path that detects
  `cobcrun` and re-executes the COBOL source, but the CI image does not
  carry `cobc`, so the synthetic path is always taken.
- **Service(s)**: `build-test-runner-service` (`GoldenMaster*`),
  `.github/workflows/`, repo CI image.
- **Proposed fix**: add GnuCOBOL (`cobc`) to the CI base image, set
  `classification: "true"` for at least one W0 fixture, and gate the W0 demo
  on byte-equal stdout (which will fail until the generator extends past the
  W0 subset).
- **Owner**: platform / verification.
- **Acceptance**: at least one fixture is `classification: "true"` with a
  reproducible `cobcrun` output committed under
  `corpus/synthetic/fixtures/`.

## F-W0-04 · Model gateway invocation in W0 demo · [#67](https://github.com/oscharko-dev/c2c-PreBeta/issues/67)

- **Symptom**: `modelInvocations` in every Evidence Pack manifest carries an
  observation-only `status: "skipped"` entry. No model call ever exercises
  the gateway end-to-end. The W0 release gate explicitly accepts this; W1
  acceptance requires real model traffic through the gateway with an
  allowlist.
- **Service(s)**: `model-gateway-service` (docs only at W0; service skeleton
  is a Wave 1 task).
- **Proposed fix**: stand up `services/model-gateway-service` (Java or Go)
  implementing the W0 gateway README contract, plumb it into
  `orchestrator-service`'s optional `model-guidance` step, and update the
  demo to record real model-invocation ledger entries.
- **Owner**: model gateway.
- **Acceptance**: a demo run produces ≥ 1 manifest where
  `modelInvocations[].status == "completed"` and `ledgerRef.sha256` matches a
  ledger entry on the gateway.

## F-W0-05 · Generator coverage beyond the checked-in W0 subset · [#68](https://github.com/oscharko-dev/c2c-PreBeta/issues/68)

- **Symptom**: the checked-in W0 programs now match their synthetic Golden
  Masters, but broader COBOL forms remain outside the implemented subset.
- **Service(s)**: `target-java-generation-service`.
- **Proposed fix**: Wave 1 sequence covering each construct, each with its
  own issue, ADR, fixture, and Golden Master byte-equal target.
- **Owner**: generator.
- **Acceptance**: new corpus programs beyond `BRNCH01`, `CTRLDEC01`, and
  `BATCH01` report `classification: "match"` from the build-test runner.

## Filing on GitHub

Each item is filed as a separate `type: task`, `wave: w1`, area-scoped
issue, linked from this document. The W0 release gate's
"What is *not* ready" section already enumerates the same gaps; please link
the gate document and this file from every Wave 1 follow-up issue so the
W0 → W1 trail stays auditable.
