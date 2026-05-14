# W0 End-to-End Demo Runbook

This runbook walks a developer through the c2c W0 walking skeleton from a
clean checkout to a validated Evidence Pack, captured Harness Event ledger,
and analyzed Experience Events. It is the script that produces the evidence
the [W0 release gate](../release/w0-release-gate.md) and the
[W0 scorecard](w0-scorecard.md) refer to.

> Issue: [#16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16) · Parent epic: [#1](https://github.com/oscharko-dev/c2c-PreBeta/issues/1).

## What you will see

The demo drives one COBOL program through every W0 service in turn:

```text
COBOL source
    │
    ▼  HTTP POST /v0/parse
cobol-parser-service              ──► harness POST /v0/events (authenticated)
    │
    ▼  HTTP POST /v0/ir
semantic-ir-service               ──► harness POST /v0/events (authenticated)
    │
    ▼  HTTP POST /v0/generate
target-java-generation-service    ──► harness POST /v0/events (authenticated)
    │
    ▼  HTTP POST /v0/run-verification
build-test-runner-service         ──► harness POST /v0/events (authenticated)
                                  ──► experience POST /v0/events (failures only)
    │
    ▼  HTTP POST /v0/packs (+ PATCH, /validate, /export)
evidence-service                  ──► local JSONL event log
    │
    ▼  HTTP POST /v0/harness-events  /  /v0/trajectory-ledgers
experience-learning-service       ──► auto-analyze → JSONL experience events
```

The W0 corpus is the three synthetic COBOL programs under
[`corpus/synthetic/programs/`](../../corpus/synthetic/programs/):
`BRNCH01`, `CTRLDEC01`, `BATCH01`. All three are
[`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
entries with `classification: "synthetic"` and `knownDivergenceAtW0: false`.

## Honest expectations for W0

This is a **walking skeleton**, not a feature-complete COBOL-to-Java translator.
The checked-in W0 subset now covers deterministic `PERFORM`, `EVALUATE`, `IF`,
`ADD`/`COMPUTE`, `DISPLAY`, and basic `OCCURS` table access for the synthetic
corpus. The acceptance bar is therefore:

- `compileOk == true` for every program (the generator emits compilable Java).
- `execution.ran == true` for every program (the generated entry class runs).
- `classification == match` for every program.
- Evidence Pack `status == complete` and `validation.ok == true` for every program.

Anything else (especially `divergence-unknown`, `compile-failed`,
`run-failed`, or `validation.ok == false`) is a release-gate fail.

Today's recorded outcome is in [w0-scorecard.md](w0-scorecard.md).

## Prerequisites

Run once per workstation. Versions matching the local-dev sweet spot in
[README.md](../../README.md):

| Tool | Minimum | Notes |
|------|---------|-------|
| Bash | 3.2+ | macOS default works. |
| `curl` | any modern | Used for HTTP service calls. |
| `jq` | 1.7+ | Used for JSON wiring. |
| `shasum` | any | macOS default; on Linux use `coreutils` `sha256sum` aliased to `shasum -a 256`. |
| Java | 21 | OpenJDK 21 (Temurin or Homebrew). |
| Maven | 3.9+ | Builds the four Java capability services. |
| Go | 1.22+ (tested with 1.26) | Builds the three Go services. |

The demo script verifies each binary is on `$PATH` before doing anything else.

## Reproducible run — single command

From a clean checkout:

```bash
./scripts/bootstrap.sh   # one-time repo health check
./scripts/w0-demo.sh     # the runbook in script form
```

`scripts/w0-demo.sh` is idempotent. It writes everything under `var/w0-demo/`
(git-ignored) and tears down every background process it starts via an `EXIT`
trap. On a warm Maven cache the full run takes ~15 s on a developer laptop.

### What the script does, in order

1. Pre-flight tool check (`java`, `mvn`, `go`, `curl`, `jq`, `shasum`).
2. `mvn -DskipTests install` on `libs/c2c-target-java-runtime`, then
   `mvn -DskipTests package` on the four Java capability services so each
   one is materialized as a shaded fat jar.
3. `go build` of `agentic-harness-core`, `evidence-service`, and
   `experience-learning-service` into `var/w0-demo/bin/` so the launched
   process IS the listening process (cleaner than `go run`'s child binary).
4. Start each service in the background. Ports (overridable via env var):

   | Service | Default port | Env var |
   |---------|--------------|---------|
   | `agentic-harness-core` | `8190` | `W0_DEMO_HARNESS_PORT` |
   | `evidence-service` | `8191` | `W0_DEMO_EVIDENCE_PORT` |
   | `experience-learning-service` | `8192` | `W0_DEMO_EXPERIENCE_PORT` |
   | `cobol-parser-service` | `8181` | `W0_DEMO_PARSER_PORT` |
   | `semantic-ir-service` | `8182` | `W0_DEMO_IR_PORT` |
   | `target-java-generation-service` | `8183` | `W0_DEMO_GENERATOR_PORT` |
   | `build-test-runner-service` | `8184` | `W0_DEMO_BTR_PORT` |

5. Health-check each service (`/v0/health` or `/health`) with up to 20 s of
   retries.
6. Register the W0 parser, IR, generator, build/test, and evidence
   capabilities in the Harness catalog with an authenticated
   `orchestrator` principal. Every subsequent service endpoint is resolved
   from that catalog before invocation.
7. For each of `BRNCH01`, `CTRLDEC01`, `BATCH01`:
   1. Register a run on the harness via `POST /v0/runs`. Capture the
      harness-assigned `runId` (e.g. `run-1`).
   2. POST the COBOL source to the parser. Save the response.
   3. POST the parser response to the IR service. Save the response.
   4. POST the IR to the generator. Save the response.
   5. POST the generation response to the build/test runner. Save the response.
   6. Build the Evidence Pack v0 by POSTing references (sha256 + URI) for the
      source, IR, generated Java, build/test result, harness ledger snapshot,
      and trajectory ledger to `evidence-service`.
   7. POST `/v0/packs/{packId}/validate` to confirm `validation.ok == true`.
   8. POST `/v0/packs/{packId}/export` so the bundle is written to disk
      deterministically.
   9. Re-fetch the manifest for archiving.
   10. PATCH the harness run to `status: completed`.
8. Run controlled Experience Learning scenarios: drive `BRNCH01` twice in a
   fresh harness run so the analyzer emits `repeat_action` and
   `unchanged_output`, then append explicit controlled `failed → completed`
   and `accepted` Harness events so `retry` and `accepted_pattern` are also
   evidenced.
9. Snapshot the harness `/v0/events` ledger and POST the raw harness event
   envelopes to `experience-learning-service` `/v0/harness-events`.
   Experience Learning maps harness statuses such as `starting` and
   `output-divergence` internally before analysis. Auto-analyze runs on ingest
   and produces experience events.
10. POST the per-program trajectory ledgers to `/v0/trajectory-ledgers`.
11. Compute and emit `var/w0-demo/scorecard.md`.

The script aborts immediately on any non-success HTTP status. Service logs
live in `var/w0-demo/logs/` and survive script exit so a developer can read
them after a failure.

## Manual walk-through (when you want to drive it by hand)

The same workflow run end-to-end via `curl` from a developer shell — useful
in demos or when a single step needs to be re-run after a fix.

```bash
# 1. Build everything (one-off; ~30 s warm)
mvn -B -ntp -DskipTests install -f libs/c2c-target-java-runtime/pom.xml
for svc in cobol-parser-service semantic-ir-service \
           target-java-generation-service build-test-runner-service; do
  mvn -B -ntp -DskipTests package -f "services/$svc/pom.xml"
done
for svc in agentic-harness-core evidence-service experience-learning-service; do
  (cd "services/$svc" && go build -o "/tmp/$svc" .)
done

export HARNESS_TOKEN="manual-local-control-plane-token"

# 2. Start the harness + capability services (each in its own terminal,
#    or all in one with & + jobs / tmux; pick the same ports the demo uses)
HARNESS_CONTROL_PLANE_TOKEN="$HARNESS_TOKEN" HARNESS_EVENT_LOG_PATH=/tmp/harness.jsonl HARNESS_PORT=8190 /tmp/agentic-harness-core &
EVIDENCE_PORT=8191 EVIDENCE_EXPORT_DIR=/tmp/evidence-exports /tmp/evidence-service &
EXPERIENCE_LEARNING_LISTEN_ADDR=:8192 /tmp/experience-learning-service &
HARNESS_EVENT_ENDPOINT=http://127.0.0.1:8190 HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" COBOL_PARSER_LISTEN_ADDR=8181 \
  java -jar services/cobol-parser-service/target/cobol-parser-service-*.jar &
HARNESS_EVENT_ENDPOINT=http://127.0.0.1:8190 HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" SEMANTIC_IR_LISTEN_ADDR=8182 \
  java -jar services/semantic-ir-service/target/semantic-ir-service-*.jar &
HARNESS_EVENT_ENDPOINT=http://127.0.0.1:8190 HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" TARGET_JAVA_GENERATION_LISTEN_ADDR=8183 \
  java -jar services/target-java-generation-service/target/target-java-generation-service-*.jar &
HARNESS_EVENT_ENDPOINT=http://127.0.0.1:8190 HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" BUILD_TEST_RUNNER_LISTEN_ADDR=8184 \
  java -jar services/build-test-runner-service/target/build-test-runner-service-*.jar &

AUTH=(-H "Authorization: Bearer $HARNESS_TOKEN" -H "X-Harness-Actor: manual-demo" -H "X-Harness-Role: orchestrator")
register_capability() {
  local id="$1" name="$2" owner="$3" endpoint="$4" dataClass="$5"
  jq -n --arg id "$id" --arg name "$name" --arg owner "$owner" --arg endpoint "$endpoint" --arg dataClass "$dataClass" \
    '{capability:{id:$id,name:$name,owner:$owner,endpoint:$endpoint,dataClass:$dataClass,policyProfile:"harness-control-plane",version:"v0.1.0"}}' \
  | curl -fsS -X POST -H 'Content-Type: application/json' "${AUTH[@]}" -d @- http://127.0.0.1:8190/v0/capabilities
}
register_capability cobol.parse "COBOL Parser" cobol-parser-service http://127.0.0.1:8181/v0/parse parser
register_capability cobol.ir "Semantic IR Generator" semantic-ir-service http://127.0.0.1:8182/v0/ir parser
register_capability target.java.generate "Target Java Generator" target-java-generation-service http://127.0.0.1:8183/v0/generate generator
register_capability build-test.run "Build/Test Runner" build-test-runner-service http://127.0.0.1:8184/v0/run-verification build-test

# 3. Drive a single program. Replace BRNCH01 / the .cbl path to try another.
RUN=$(curl -fsS -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d '{"workflowId":"w0-migration-v0","requester":"manual"}' \
  http://127.0.0.1:8190/v0/runs | jq -r .runId)

PARSE=$(jq -n --arg runId "$RUN" --rawfile src corpus/synthetic/programs/branch-account-guard.cbl \
        '{runId:$runId, workflowId:"w0-migration-v0", source:$src}' \
      | curl -fsS -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:8181/v0/parse)
IR=$(jq -n --argjson p "$PARSE" --arg runId "$RUN" \
        '{runId:$runId, workflowId:"w0-migration-v0", parseOutput:$p}' \
   | curl -fsS -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:8182/v0/ir)
GEN=$(jq -n --argjson ir "$IR" --arg runId "$RUN" \
        '{runId:$runId, ir:($ir.ir)}' \
   | curl -fsS -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:8183/v0/generate)
BTR=$(jq -n --argjson g "$GEN" --arg runId "$RUN" \
        '{runId:$runId, workflowId:"w0-migration-v0", programId:"BRNCH01", generationResponse:$g}' \
   | curl -fsS -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:8184/v0/run-verification)

echo "$BTR" | jq '{status, classification, compileOk:.build.compileOk, matched:.comparison.matched}'

# 4. Read the trajectory ledger from the Harness source of truth.
curl -fsS http://127.0.0.1:8190/v0/runs/$RUN/ledger | jq '.steps | length'
```

The end-to-end output should report `compileOk: true`, `matched: true`,
`classification: "match"`.

## Reading the captured artifacts

After `scripts/w0-demo.sh` completes (or after the manual walk), look here:

| Path | Purpose |
|------|---------|
| `var/w0-demo/scorecard.md` | This run's scorecard. |
| `var/w0-demo/artifacts/<programId>/16-evidence-manifest.json` | Canonical Evidence Pack manifest. Compare against `schemas/evidence-pack-manifest-v0.json`. |
| `var/w0-demo/exports/<packId>/manifest.json` | Deterministic export of the same manifest. The export's sha256 is referenced from the manifest's `exports[]`. |
| `var/w0-demo/artifacts/<programId>/11-trajectory-ledger.json` | Agent trajectory ledger for that run (`schemas/agent-trajectory-ledger-v0.json`). |
| `var/w0-demo/events/harness-events.jsonl` | Raw harness ledger across all runs. |
| `var/w0-demo/events/experience-events-snapshot.json` | Experience events emitted by analysis. |
| `var/w0-demo/logs/<service>.log` | Per-service stdout/stderr. |

A frozen copy of the same artifacts is committed under
[`sample-evidence-pack/`](sample-evidence-pack/) so reviewers can read the
manifest without re-running the demo.

## Cleanup

The script's `EXIT` trap kills every PID it recorded under
`var/w0-demo/pids/`. If a previous run was interrupted with `kill -9` or a
crash, leftover Go binaries may still be holding ports. Check with:

```bash
lsof -nP -i :8190 -i :8191 -i :8192 -i :8181 -i :8182 -i :8183 -i :8184
```

…and `kill` the stragglers before re-running.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `address already in use` on `:8190` (or any demo port) | Previous run left a Go binary alive. | `lsof -nP -i :<port>` → `kill <pid>`. |
| Maven test runs blow up the demo time | Tests were not skipped. | The demo uses `-DskipTests` on purpose — full tests run in CI. |
| `wait_http` times out | Java service hasn't finished starting / Maven warm cache cold. | Check `var/w0-demo/logs/<service>.log` for the actual error. |
| `experience-learning harness-event ingest failed (HTTP 400)` | A service emitted a malformed harness event or a status outside the Harness Event Envelope status contract. | Add the missing harness status to `experience-learning-service` validation and analysis mapping, then file a follow-up in [`w0-followups.md`](w0-followups.md) if the producer contract changed. |
| `classification: "divergence-unknown"` reported | A program is not in `fixtures/golden-master/index.json`, or generated output no longer matches an undeclared fixture. This is a **release-gate fail**. | Register an intentionally divergent fixture with a rationale only if the divergence is expected; otherwise treat it as a generator bug. |
