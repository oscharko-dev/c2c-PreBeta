# W0 Follow-Ups

Concrete items discovered while assembling the W0 end-to-end demo
([issue #16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16)) that are
**explicitly deferred** rather than fixed in this PR. Per the
[development workflow](../governance/development-workflow.md) governance rule,
scope expansion is not silently merged — every item below is filed as a
separate issue so it can be planned, owned, and verified independently.

Each entry includes the symptom seen during the W0 demo run, the contract /
service involved, and a proposed fix shape. Wave 1 owners may take any item
without waiting for the others.

## F-W0-01 · Harness `/v0/runs/{id}/ledger` requires unique `stepId`s · [#50](https://github.com/oscharko-dev/c2c-PreBeta/issues/50)

- **Symptom**: the demo's first run got `HTTP 404 — duplicate stepId` when
  calling `GET http://harness/v0/runs/<runId>/ledger` because every W0 Java
  capability service posts harness events with `stepId: 1` by default. The
  trajectory ledger schema rejects duplicates.
- **Service(s)**: `agentic-harness-core` (server-side ledger build),
  `cobol-parser-service`, `semantic-ir-service`,
  `target-java-generation-service`, `build-test-runner-service` (all emit
  `stepId: 1`).
- **Current workaround**: the demo builds a schema-conformant trajectory
  ledger client-side from the harness event stream, renumbering steps in
  arrival order.
- **Proposed fix**: either (a) make the harness's
  `emitEvent` re-assign `stepId` per run regardless of what the caller sent,
  or (b) extend the orchestrator-service to rewrite events as they pass
  through. (a) is preferred — it keeps capability services dumb.
- **Owner**: harness / platform.
- **Acceptance**: `curl /v0/runs/<id>/ledger` returns a valid
  `AgentTrajectoryLedgerV0` for any run that has ≥ one event.

## F-W0-02 · `experience-learning-service` `/v0/harness-events` status enum mismatch · [#51](https://github.com/oscharko-dev/c2c-PreBeta/issues/51)

- **Symptom**: harness events with `status` values produced by W0 services
  (`starting`, `output-divergence`) get `HTTP 400 — status: unsupported`
  from `experience-learning-service.allowedPatternStates`.
- **Service(s)**: `experience-learning-service` (`types.go`
  `allowedPatternStates`), all W0 services emitting harness events.
- **Current workaround**: the demo normalises statuses client-side via `jq`
  (`starting → started`, `output-divergence → failed`, etc.) before
  POSTing.
- **Proposed fix**: split the enum into a *harness-event status enum*
  (the union of statuses any capability service actually emits — `ok`,
  `output-divergence`, `compile-failed`, …) and an *experience-event
  status enum* (`observed`, `ignored`). Validate against the right one in
  each ingest path. Add status mapping inside the ingest handler so callers
  do not need to translate.
- **Owner**: experience-learning.
- **Acceptance**: a raw harness event posted to `/v0/harness-events`
  without normalisation is accepted whenever the harness itself accepted
  the same envelope.

## F-W0-03 · Capability registration for parser/generator/build-test is forbidden by default policy · [#52](https://github.com/oscharko-dev/c2c-PreBeta/issues/52)

- **Symptom**: `agentic-harness-core` policy rejects `register_capability`
  when `dataClass ∈ {parser, generator, build-test, ...}` for `actor == agent`.
  As a result the W0 demo cannot drive services through the harness's
  capability-invocation surface and instead calls each service over HTTP
  directly. The orchestrator-service exists but is unusable end-to-end on
  a fresh harness because it relies on those capability registrations.
- **Service(s)**: `agentic-harness-core` (`policy.go` `DefaultPolicyEngine`),
  `orchestrator-service`.
- **Proposed fix**: allow capability registration for the W0 core
  infrastructure when the caller role is `orchestrator` or the
  registration carries a documented W0 manifest signed by the platform team.
  Keep the current denial for `agent`-role registrations.
- **Owner**: harness / platform.
- **Acceptance**: `orchestrator-service.main` can register the parser, IR,
  generator, build/test, and evidence capabilities on a cold harness and
  then drive a run through `POST /v0/runs` without any manual capability
  insertion.

## F-W0-04 · True `cobcrun` Golden Masters · [#53](https://github.com/oscharko-dev/c2c-PreBeta/issues/53)

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

## F-W0-05 · Model gateway invocation in W0 demo · [#54](https://github.com/oscharko-dev/c2c-PreBeta/issues/54)

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

## F-W0-06 · Generator coverage beyond the W0 subset · [#55](https://github.com/oscharko-dev/c2c-PreBeta/issues/55)

- **Symptom**: every W0 program ends with `divergence-known-w0-coverage-gap`
  because the generator does not yet translate `PERFORM`, `EVALUATE`, `IF`,
  `ADD`, `COMPUTE`, or `DISPLAY` of computed values.
- **Service(s)**: `target-java-generation-service`.
- **Proposed fix**: Wave 1 sequence covering each construct, each with its
  own issue, ADR, fixture, and Golden Master byte-equal target. The W0
  smoke integration test will start asserting `classification == match`
  for fixtures whose construct has been implemented.
- **Owner**: generator.
- **Acceptance**: at least one W0 corpus program reports
  `classification: "match"` from the build-test runner.

## Filing on GitHub

Each item should land as a separate `type: task`, `wave: w1`, area-scoped
issue, linked from this document. The W0 release gate's
"What is *not* ready" section already enumerates the same gaps; please link
the gate document and this file from every Wave 1 follow-up issue so the
W0 → W1 trail stays auditable.
