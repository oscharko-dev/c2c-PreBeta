#!/usr/bin/env bash
# W0 end-to-end demo orchestrator.
#
# Drives the full COBOL-to-Java W0 walking skeleton through the real W0
# capability services (parser, semantic-ir, target-java-generation,
# build-test-runner, agentic-harness-core, evidence-service,
# experience-learning-service) over HTTP, captures every artifact under
# var/w0-demo/, builds a real Evidence Pack manifest per program, ingests
# harness events into experience-learning, and emits a scorecard.
#
# Issue: #16 (W0-14)
# Runbook: docs/showcase/w0-demo-runbook.md
# Release gate: docs/release/w0-release-gate.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VAR_DIR="${W0_DEMO_VAR_DIR:-$ROOT_DIR/var/w0-demo}"
LOG_DIR="$VAR_DIR/logs"
PID_DIR="$VAR_DIR/pids"
ARTIFACTS_DIR="$VAR_DIR/artifacts"
EXPORTS_DIR="$VAR_DIR/exports"
EVENT_DIR="$VAR_DIR/events"

# Service ports — picked outside the W0 service defaults so the demo can run
# alongside any service a developer is hand-running.
HARNESS_PORT="${W0_DEMO_HARNESS_PORT:-8190}"
EVIDENCE_PORT="${W0_DEMO_EVIDENCE_PORT:-8191}"
EXPERIENCE_PORT="${W0_DEMO_EXPERIENCE_PORT:-8192}"
PARSER_PORT="${W0_DEMO_PARSER_PORT:-8181}"
IR_PORT="${W0_DEMO_IR_PORT:-8182}"
GENERATOR_PORT="${W0_DEMO_GENERATOR_PORT:-8183}"
BTR_PORT="${W0_DEMO_BTR_PORT:-8184}"

HARNESS_URL="http://127.0.0.1:${HARNESS_PORT}"
EVIDENCE_URL="http://127.0.0.1:${EVIDENCE_PORT}"
EXPERIENCE_URL="http://127.0.0.1:${EXPERIENCE_PORT}"
PARSER_URL="http://127.0.0.1:${PARSER_PORT}"
IR_URL="http://127.0.0.1:${IR_PORT}"
GENERATOR_URL="http://127.0.0.1:${GENERATOR_PORT}"
BTR_URL="http://127.0.0.1:${BTR_PORT}"
HARNESS_TOKEN="${W0_DEMO_HARNESS_TOKEN:-w0-demo-local-control-plane-token}"
HARNESS_AUTH_HEADERS=(
  -H "Authorization: Bearer ${HARNESS_TOKEN}"
  -H "X-Harness-Actor: w0-demo"
  -H "X-Harness-Role: orchestrator"
)

START_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_TAG="${W0_DEMO_RUN_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"

# All three documented W0 corpus programs unless the caller asks for a subset.
DEFAULT_PROGRAMS=(
  "BRNCH01:corpus/synthetic/programs/branch-account-guard.cbl"
  "CTRLDEC01:corpus/synthetic/programs/ctrl-decimal-payroll.cbl"
  "BATCH01:corpus/synthetic/programs/decimal-batch-aggregator.cbl"
)
if [[ -n "${W0_DEMO_PROGRAMS:-}" ]]; then
  # shellcheck disable=SC2206
  IFS=',' read -ra PROGRAMS <<<"${W0_DEMO_PROGRAMS}"
else
  PROGRAMS=("${DEFAULT_PROGRAMS[@]}")
fi

rm -rf "$LOG_DIR" "$PID_DIR" "$ARTIFACTS_DIR" "$EXPORTS_DIR" "$EVENT_DIR" "$VAR_DIR/bin"
mkdir -p "$VAR_DIR" "$LOG_DIR" "$PID_DIR" "$ARTIFACTS_DIR" "$EXPORTS_DIR" "$EVENT_DIR"

log()  { printf '[w0-demo] %s\n' "$*" >&2; }
fail() { printf '[w0-demo][error] %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"
}

require curl
require jq
require go
require java
require mvn
require shasum

cleanup() {
  local exit_code=$?
  log "shutting down background services"
  if compgen -G "$PID_DIR/*.pid" >/dev/null; then
    for pid_file in "$PID_DIR"/*.pid; do
      [[ -f "$pid_file" ]] || continue
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    done
  fi
  # Give servers a moment to release the listening sockets.
  sleep 0.2 || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# Build phase
# ----------------------------------------------------------------------------

build_java() {
  log "building c2c-target-java-runtime"
  (cd libs/c2c-target-java-runtime && mvn -B -ntp -DskipTests install >"$LOG_DIR/mvn-runtime.log" 2>&1) \
    || fail "c2c-target-java-runtime install failed (see $LOG_DIR/mvn-runtime.log)"

  for svc in cobol-parser-service semantic-ir-service target-java-generation-service build-test-runner-service; do
    log "packaging services/$svc (skipping tests; CI gates them)"
    (cd "services/$svc" && mvn -B -ntp -DskipTests package >"$LOG_DIR/mvn-${svc}.log" 2>&1) \
      || fail "services/$svc package failed (see $LOG_DIR/mvn-${svc}.log)"
  done
}

# Resolve the shaded jar path for a given service. Each W0 Java service uses
# the maven-shade-plugin, which produces a fat jar named after the artifactId
# under target/.
shaded_jar() {
  local svc="$1"
  local jar
  jar="$(ls "services/$svc/target/${svc}-"*.jar 2>/dev/null | grep -v 'original-' | head -n1 || true)"
  [[ -n "$jar" && -f "$jar" ]] || fail "could not locate shaded jar for $svc"
  printf '%s' "$jar"
}

# ----------------------------------------------------------------------------
# Process management
# ----------------------------------------------------------------------------

# Start a background process. Args: name, log-file, command...
start_bg() {
  local name="$1"; shift
  local log="$1"; shift
  log "starting $name (log: $log)"
  ( "$@" >"$log" 2>&1 ) &
  local pid=$!
  echo "$pid" >"$PID_DIR/${name}.pid"
}

wait_http() {
  local label="$1" url="$2"
  local attempts=80
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      log "ready: $label ($url)"
      return 0
    fi
    sleep 0.25
  done
  log "service log tail for $label:"
  tail -n 60 "$LOG_DIR/${label}.log" >&2 || true
  fail "service did not become ready: $label ($url)"
}

# ----------------------------------------------------------------------------
# Service launchers
# ----------------------------------------------------------------------------

GO_BIN_DIR="$VAR_DIR/bin"
mkdir -p "$GO_BIN_DIR"

# Each Go capability service has its own go.mod. We pre-build a binary so the
# launched process IS the listening process — `go run` would fork a child
# binary that the cleanup trap can't reliably reach via the parent PID.
build_go_binary() {
  local label="$1" dir="$2"
  local out="$GO_BIN_DIR/$label"
  log "building Go binary: $label"
  ( cd "$dir" && go build -o "$out" . ) \
    || fail "go build failed for $label"
  printf '%s' "$out"
}

start_go_service() {
  local label="$1" binary="$2" logfile="$3"; shift 3
  log "starting $label (log: $logfile)"
  ( env "$@" "$binary" >"$logfile" 2>&1 ) &
  local pid=$!
  echo "$pid" >"$PID_DIR/${label}.pid"
}

start_harness() {
  local bin
  bin="$(build_go_binary harness services/agentic-harness-core)"
  start_go_service harness "$bin" "$LOG_DIR/harness.log" \
    "HARNESS_PORT=$HARNESS_PORT" \
    "HARNESS_EVENT_LOG_PATH=$EVENT_DIR/harness-events.jsonl" \
    "HARNESS_CONTROL_PLANE_TOKEN=$HARNESS_TOKEN"
  wait_http harness "$HARNESS_URL/v0/health"
}

start_evidence() {
  local bin
  bin="$(build_go_binary evidence services/evidence-service)"
  start_go_service evidence "$bin" "$LOG_DIR/evidence.log" \
    "EVIDENCE_PORT=$EVIDENCE_PORT" \
    "EVIDENCE_EVENT_LOG_PATH=$EVENT_DIR/evidence-events.jsonl" \
    "EVIDENCE_EXPORT_DIR=$EXPORTS_DIR"
  wait_http evidence "$EVIDENCE_URL/v0/health"
}

start_experience() {
  local bin
  bin="$(build_go_binary experience services/experience-learning-service)"
  start_go_service experience "$bin" "$LOG_DIR/experience.log" \
    "EXPERIENCE_LEARNING_LISTEN_ADDR=:$EXPERIENCE_PORT" \
    "EXPERIENCE_LEARNING_HARNESS_EVENTS_PATH=$EVENT_DIR/experience-harness-events.jsonl" \
    "EXPERIENCE_LEARNING_TRAJECTORY_LEDGER_PATH=$EVENT_DIR/agent-trajectory-ledger.jsonl" \
    "EXPERIENCE_LEARNING_EVENTS_PATH=$EVENT_DIR/experience-events.jsonl" \
    "EXPERIENCE_LEARNING_ARTIFACT_REGISTRY_PATH=$EVENT_DIR/learning-artifact-registry.json" \
    "EXPERIENCE_LEARNING_AUTO_ANALYZE=true"
  wait_http experience "$EXPERIENCE_URL/v0/health"
}

start_parser() {
  COBOL_PARSER_LISTEN_ADDR="$PARSER_PORT" \
  HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
  HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    start_bg parser "$LOG_DIR/parser.log" \
      java -jar "$(shaded_jar cobol-parser-service)"
  wait_http parser "$PARSER_URL/health"
}

start_ir() {
  SEMANTIC_IR_LISTEN_ADDR="$IR_PORT" \
  HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
  HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    start_bg semantic-ir "$LOG_DIR/semantic-ir.log" \
      java -jar "$(shaded_jar semantic-ir-service)"
  wait_http semantic-ir "$IR_URL/health"
}

start_generator() {
  TARGET_JAVA_GENERATION_LISTEN_ADDR="$GENERATOR_PORT" \
  HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
  HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    start_bg target-java-generation "$LOG_DIR/target-java-generation.log" \
      java -jar "$(shaded_jar target-java-generation-service)"
  wait_http target-java-generation "$GENERATOR_URL/health"
}

start_btr() {
  BUILD_TEST_RUNNER_LISTEN_ADDR="$BTR_PORT" \
  HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
  HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
  EXPERIENCE_EVENT_ENDPOINT="$EXPERIENCE_URL" \
    start_bg build-test-runner "$LOG_DIR/build-test-runner.log" \
      java -jar "$(shaded_jar build-test-runner-service)"
  wait_http build-test-runner "$BTR_URL/health"
}

register_capability() {
  local id="$1" name="$2" owner="$3" endpoint="$4" dataClass="$5"
  local body="$VAR_DIR/capability-${id//[^a-zA-Z0-9]/-}.json"
  jq -n \
    --arg id "$id" \
    --arg name "$name" \
    --arg owner "$owner" \
    --arg endpoint "$endpoint" \
    --arg dataClass "$dataClass" \
    '{capability:{
       id:$id,
       name:$name,
       owner:$owner,
       endpoint:$endpoint,
       dataClass:$dataClass,
       policyProfile:"harness-control-plane",
       version:"v0.1.0"
     }}' >"$body"

  curl -fsS -X POST -H "Content-Type: application/json" "${HARNESS_AUTH_HEADERS[@]}" \
    --data-binary "@$body" "$HARNESS_URL/v0/capabilities" \
    >"$VAR_DIR/capability-${id//[^a-zA-Z0-9]/-}-registered.json" \
    || fail "capability registration failed: $id"
}

register_w0_capabilities() {
  log "registering W0 capabilities in harness"
  register_capability "cobol.parse" "COBOL Parser" "cobol-parser-service" "$PARSER_URL/v0/parse" "parser"
  register_capability "cobol.ir" "Semantic IR Generator" "semantic-ir-service" "$IR_URL/v0/ir" "parser"
  register_capability "target.java.generate" "Target Java Generator" "target-java-generation-service" "$GENERATOR_URL/v0/generate" "generator"
  register_capability "build-test.run" "Build/Test Runner" "build-test-runner-service" "$BTR_URL/v0/run-verification" "build-test"
  register_capability "evidence.writer" "Evidence Pack Writer" "evidence-service" "$EVIDENCE_URL/v0/packs" "evidence"
}

capability_endpoint() {
  local id="$1"
  local endpoint
  endpoint="$(curl -fsS "$HARNESS_URL/v0/capabilities/$id" | jq -r '.endpoint')"
  [[ -n "$endpoint" && "$endpoint" != "null" ]] || fail "capability endpoint missing: $id"
  printf '%s' "$endpoint"
}

post_controlled_harness_event() {
  local runId="$1" eventType="$2" status="$3" stateTransition="$4"
  local emptySha="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  jq -n \
    --arg eventType "$eventType" \
    --arg runId "$runId" \
    --arg status "$status" \
    --arg stateTransition "$stateTransition" \
    --arg emptySha "$emptySha" \
    '{schemaVersion:"v0",
      eventType:$eventType,
      service:"w0-demo",
      runId:$runId,
      actor:"w0-demo",
      capability:"evidence.writer",
      dataClass:"evidence",
      redactionProfile:"harness-control-plane",
      policyDecision:"policy allow",
      status:$status,
      stateTransition:$stateTransition,
      inputRef:{uri:"urn:c2c/w0-demo/controlled/input", sha256:$emptySha, byteSize:0},
      outputRef:{uri:"urn:c2c/w0-demo/controlled/output", sha256:$emptySha, byteSize:0},
      payload:{controlled:true, accepted:($status == "accepted")}}' \
  | curl -fsS -X POST -H "Content-Type: application/json" "${HARNESS_AUTH_HEADERS[@]}" \
      --data-binary @- "$HARNESS_URL/v0/events" >/dev/null \
      || fail "controlled harness event failed: $eventType"
}

# ----------------------------------------------------------------------------
# Workflow per program
# ----------------------------------------------------------------------------

# Compute SHA-256 of a file.
file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Compute the byte size (portable: macOS stat / GNU stat).
file_size() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

# Build a JSON DataReference for a captured artifact file.
data_ref_json() {
  local file="$1" uri="$2" mime="${3:-application/json}" kind="${4:-evidence-input}"
  jq -n \
    --arg uri "$uri" \
    --arg sha "$(file_sha256 "$file")" \
    --argjson size "$(file_size "$file")" \
    --arg mime "$mime" \
    --arg kind "$kind" \
    '{uri:$uri, sha256:$sha, byteSize:$size, mimeType:$mime, kind:$kind}'
}

# Result accumulators (parallel arrays indexed by program).
RESULTS_JSON="$VAR_DIR/results.json"
echo '[]' >"$RESULTS_JSON"

run_program() {
  local programId="$1" cobolPath="$2"
  local workflowId="w0-migration-v0"
  local outDir="$ARTIFACTS_DIR/$programId"
  local parseEndpoint irEndpoint generatorEndpoint btrEndpoint evidenceEndpoint
  mkdir -p "$outDir"

  log "================= $programId ($cobolPath) ================="
  [[ -f "$cobolPath" ]] || fail "$programId: source not found at $cobolPath"
  parseEndpoint="$(capability_endpoint "cobol.parse")"
  irEndpoint="$(capability_endpoint "cobol.ir")"
  generatorEndpoint="$(capability_endpoint "target.java.generate")"
  btrEndpoint="$(capability_endpoint "build-test.run")"
  evidenceEndpoint="$(capability_endpoint "evidence.writer")"

  # ---- Step 0: register the run with the harness so subsequent capability
  # event posts (parser/IR/generator/BTR -> POST /v0/events) are accepted.
  # The harness assigns the runId — capture it and use it from here on.
  local runRegistration="$outDir/00-run-create-response.json"
  curl -fsS -X POST -H "Content-Type: application/json" "${HARNESS_AUTH_HEADERS[@]}" \
    --data "$(jq -n --arg w "$workflowId" --arg p "$programId" \
                '{workflowId:$w, requester:"w0-demo", evidenceRefs:[("urn:c2c/cobol/" + $p)]}')" \
    "$HARNESS_URL/v0/runs" >"$runRegistration" \
    || fail "$programId: harness run create failed"
  local runId
  runId="$(jq -r '.runId' "$runRegistration")"
  [[ -n "$runId" && "$runId" != "null" ]] || fail "$programId: harness did not return a runId"
  log "$programId: harness assigned runId=$runId"

  # ---- Step 1: parse ------------------------------------------------------
  local parseRequest="$outDir/01-parse-request.json"
  local parseResponse="$outDir/02-parse-response.json"
  jq -n \
    --arg runId "$runId" \
    --arg workflowId "$workflowId" \
    --rawfile source "$cobolPath" \
    '{runId:$runId, workflowId:$workflowId, source:$source}' \
    >"$parseRequest"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$parseRequest" "$parseEndpoint" \
    >"$parseResponse" \
    || fail "$programId: parser HTTP call failed"
  local parseStatus
  parseStatus="$(jq -r '.status' "$parseResponse")"
  [[ "$parseStatus" == "ok" ]] || fail "$programId: parser returned status=$parseStatus"

  # ---- Step 2: semantic IR ------------------------------------------------
  local irRequest="$outDir/03-ir-request.json"
  local irResponse="$outDir/04-ir-response.json"
  jq -n \
    --arg runId "$runId" \
    --arg workflowId "$workflowId" \
    --slurpfile parse "$parseResponse" \
    '{runId:$runId, workflowId:$workflowId, parseOutput:$parse[0]}' \
    >"$irRequest"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$irRequest" "$irEndpoint" \
    >"$irResponse" \
    || fail "$programId: semantic-ir HTTP call failed"
  local irStatus
  irStatus="$(jq -r '.status' "$irResponse")"
  [[ "$irStatus" == "ok" ]] || fail "$programId: semantic-ir returned status=$irStatus"

  # ---- Step 3: target-java generation -------------------------------------
  local genRequest="$outDir/05-generate-request.json"
  local genResponse="$outDir/06-generate-response.json"
  jq -n \
    --arg runId "$runId" \
    --slurpfile ir "$irResponse" \
    '{runId:$runId, ir:($ir[0].ir)}' \
    >"$genRequest"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$genRequest" "$generatorEndpoint" \
    >"$genResponse" \
    || fail "$programId: target-java-generation HTTP call failed"
  local genStatus
  genStatus="$(jq -r '.status' "$genResponse")"
  [[ "$genStatus" == "ok" ]] || fail "$programId: target-java-generation returned status=$genStatus"

  # ---- Step 4: build/test --------------------------------------------------
  local btrRequest="$outDir/07-build-test-request.json"
  local btrResponse="$outDir/08-build-test-response.json"
  jq -n \
    --arg runId "$runId" \
    --arg workflowId "$workflowId" \
    --arg programId "$programId" \
    --slurpfile gen "$genResponse" \
    '{runId:$runId, workflowId:$workflowId, programId:$programId, generationResponse:$gen[0]}' \
    >"$btrRequest"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$btrRequest" "$btrEndpoint" \
    >"$btrResponse" \
    || fail "$programId: build-test-runner HTTP call failed"
  local btrStatus btrClassification compileOk ran
  btrStatus="$(jq -r '.status' "$btrResponse")"
  btrClassification="$(jq -r '.classification' "$btrResponse")"
  compileOk="$(jq -r '.build.compileOk // false' "$btrResponse")"
  ran="$(jq -r '.execution.ran // false' "$btrResponse")"

  # ---- Step 5: build the Evidence Pack -----------------------------------
  local sourceRef irRef genRef btrRef harnessRef modelRef trajRef
  sourceRef="$(data_ref_json "$cobolPath" "urn:c2c/cobol/$programId" "text/x-cobol" "evidence-input")"
  irRef="$(data_ref_json "$irResponse" "urn:c2c/semantic-ir/$programId/$runId")"
  genRef="$(data_ref_json "$genResponse" "urn:c2c/generated-java/$programId/$runId")"
  btrRef="$(data_ref_json "$btrResponse" "urn:c2c/build-test/$programId/$runId")"

  # Snapshot of the current harness ledger so the manifest references it
  # by content hash, not as a moving target.
  local harnessSnapshot="$outDir/09-harness-events.json"
  curl -fsS "$HARNESS_URL/v0/events" >"$harnessSnapshot" \
    || fail "$programId: failed to fetch harness events"
  harnessRef="$(data_ref_json "$harnessSnapshot" "urn:c2c/harness-events/$runId")"

  # W0 model gateway is not exercised end-to-end; we record an explicit
  # observation-only ledger entry so the manifest's modelInvocations field
  # is honest about what happened (no model call, recorded by orchestrator).
  local modelLedger="$outDir/10-model-invocations.json"
  jq -n \
    --arg runId "$runId" \
    '[{invocationId:("inv-" + $runId + "-noop"),
       modelId:"none",
       provider:"observation-only",
       promptTemplateVersion:"none",
       status:"skipped"}]' \
    >"$modelLedger"
  modelRef="$(data_ref_json "$modelLedger" "urn:c2c/model-invocations/$runId")"

  # Trajectory ledger for this run from the harness source of truth.
  local trajectoryLedger="$outDir/11-trajectory-ledger.json"
  curl -fsS "$HARNESS_URL/v0/runs/$runId/ledger" >"$trajectoryLedger" \
    || fail "$programId: failed to fetch harness trajectory ledger"
  trajRef="$(data_ref_json "$trajectoryLedger" "urn:c2c/trajectory-ledger/$runId")"

  local createBody="$outDir/12-evidence-create.json"
  jq -n \
    --arg runId "$runId" \
    --arg workflowId "$workflowId" \
    --arg summary "W0 demo run for $programId" \
    --argjson sourceCobol "[$sourceRef]" \
    --argjson semanticIr "$irRef" \
    --argjson generatedJava "$genRef" \
    --argjson buildTestResults "[$btrRef]" \
    --argjson harnessEvents "$harnessRef" \
    --argjson trajectoryLedger "$trajRef" \
    --argjson modelInvocations "$(jq -n --argjson r "$modelRef" --arg runId "$runId" \
        '[{invocationId:("inv-" + $runId + "-noop"),
           modelId:"none",
           provider:"observation-only",
           status:"skipped",
           ledgerRef:$r}]')" \
    '{runId:$runId,
      workflowId:$workflowId,
      summary:$summary,
      createdBy:"w0-demo",
      artifacts:{
        sourceCobol:$sourceCobol,
        semanticIr:$semanticIr,
        generatedJava:$generatedJava,
        buildTestResults:$buildTestResults,
        harnessEvents:$harnessEvents,
        trajectoryLedger:$trajectoryLedger,
        modelInvocations:$modelInvocations,
        runtimeVersion:{id:"c2c-target-java-runtime:v0"}
      },
      openAssumptions:[
        {id:"synthetic-golden-master", description:"W0 generated Java matches the synthetic Golden Master fixtures; true cobcrun-produced fixtures remain a Wave 1 follow-up."}
      ]}' \
    >"$createBody"

  local evidenceCreated="$outDir/13-evidence-created.json"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$createBody" "$evidenceEndpoint" \
    >"$evidenceCreated" \
    || fail "$programId: evidence pack create failed"
  local packId
  packId="$(jq -r '.packId' "$evidenceCreated")"
  [[ "$packId" == epk-* ]] || fail "$programId: unexpected packId=$packId"

  # Re-validate explicitly so the validation result is captured next to the
  # manifest, regardless of how the Go service reports it on create.
  local evidenceValidated="$outDir/14-evidence-validated.json"
  curl -fsS -X POST -H "Content-Type: application/json" \
    "$EVIDENCE_URL/v0/packs/$packId/validate" \
    >"$evidenceValidated" \
    || fail "$programId: evidence validate failed"
  local validationOk packStatus
  validationOk="$(jq -r '.validation.ok // .ok // false' "$evidenceValidated")"
  packStatus="$(jq -r '.status // "unknown"' "$evidenceValidated")"

  # Export the manifest for diffability/inclusion in the showcase artifact set.
  local exportBody
  exportBody="$(jq -n --arg dest "$packId" '{format:"directory", destination:$dest}')"
  local evidenceExported="$outDir/15-evidence-exported.json"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data "$exportBody" "$EVIDENCE_URL/v0/packs/$packId/export" \
    >"$evidenceExported" \
    || fail "$programId: evidence export failed"

  # Persist the canonical manifest copy for this program.
  local finalManifest="$outDir/16-evidence-manifest.json"
  curl -fsS "$EVIDENCE_URL/v0/packs/$packId" >"$finalManifest" \
    || fail "$programId: evidence pack fetch failed"
  packStatus="$(jq -r '.status // "unknown"' "$finalManifest")"

  # ---- Step 6: close out the harness run -----------------------------------
  curl -fsS -X PATCH -H "Content-Type: application/json" "${HARNESS_AUTH_HEADERS[@]}" \
    --data "$(jq -n --arg pack "$packId" \
        '{status:"completed",
          updatedBy:"w0-demo",
          message:"W0 demo workflow completed",
          policyDecision:"policy allow",
          evidenceRefs:[("urn:c2c/evidence/" + $pack)]}')" \
    "$HARNESS_URL/v0/runs/$runId" \
    >"$outDir/17-run-completed.json" \
    || fail "$programId: harness run completion failed"

  # ---- Append metrics row -------------------------------------------------
  local goldenMatch goldenClassification
  goldenMatch="$(jq -r '.comparison.matched // false' "$btrResponse")"
  goldenClassification="$(jq -r '.goldenMaster.classification // "unknown"' "$btrResponse")"
  jq --arg programId "$programId" \
     --arg runId "$runId" \
     --arg packId "$packId" \
     --arg btrStatus "$btrStatus" \
     --arg btrClassification "$btrClassification" \
     --arg packStatus "$packStatus" \
     --argjson compileOk "$compileOk" \
     --argjson ran "$ran" \
     --argjson goldenMatch "$goldenMatch" \
     --arg goldenClassification "$goldenClassification" \
     --argjson validationOk "$validationOk" \
     '. += [{programId:$programId,
             runId:$runId,
             packId:$packId,
             buildTestStatus:$btrStatus,
             buildTestClassification:$btrClassification,
             compileOk:$compileOk,
             ran:$ran,
             goldenMasterMatched:$goldenMatch,
             goldenMasterClassification:$goldenClassification,
             evidencePackStatus:$packStatus,
             evidencePackValidationOk:$validationOk}]' \
     "$RESULTS_JSON" >"$RESULTS_JSON.tmp" && mv "$RESULTS_JSON.tmp" "$RESULTS_JSON"

  log "$programId: status=$btrStatus classification=$btrClassification compileOk=$compileOk ran=$ran packStatus=$packStatus validationOk=$validationOk"
}

# ----------------------------------------------------------------------------
# Experience-learning ingest + scorecard
# ----------------------------------------------------------------------------

run_controlled_repeat_scenario() {
  # AC: "Experience Events are produced for at least success, failure, retry,
  # or repeated-action scenarios using controlled test cases."
  #
  # Drive BRNCH01 through the parser/IR/generator/BTR pipeline twice within
  # one harness run so the analyzer sees duplicate (actor, capability,
  # inputHash, outputHash) tuples and emits a `repeat_action` pattern.
  local programId="BRNCH01"
  local cobolPath="corpus/synthetic/programs/branch-account-guard.cbl"
  local workflowId="w0-migration-v0"
  local outDir="$ARTIFACTS_DIR/_controlled-repeat-${programId}"
  local parseEndpoint irEndpoint generatorEndpoint btrEndpoint
  mkdir -p "$outDir"
  log "================= controlled repeat scenario ($programId x2) ================="

  local runRegistration="$outDir/00-run-create-response.json"
  curl -fsS -X POST -H "Content-Type: application/json" "${HARNESS_AUTH_HEADERS[@]}" \
    --data "$(jq -n --arg w "$workflowId" \
                '{workflowId:$w, requester:"w0-demo-controlled", evidenceRefs:[]}')" \
    "$HARNESS_URL/v0/runs" >"$runRegistration" \
    || fail "controlled scenario: harness run create failed"
  local runId
  runId="$(jq -r '.runId' "$runRegistration")"
  log "controlled-scenario harness runId=$runId"
  parseEndpoint="$(capability_endpoint "cobol.parse")"
  irEndpoint="$(capability_endpoint "cobol.ir")"
  generatorEndpoint="$(capability_endpoint "target.java.generate")"
  btrEndpoint="$(capability_endpoint "build-test.run")"

  local parseRequest="$outDir/parse-request.json"
  jq -n --arg runId "$runId" --arg workflowId "$workflowId" \
        --rawfile source "$cobolPath" \
        '{runId:$runId, workflowId:$workflowId, source:$source}' \
    >"$parseRequest"

  for iteration in 1 2; do
    local parseResp="$outDir/iter-${iteration}-parse.json"
    curl -fsS -X POST -H "Content-Type: application/json" \
      --data-binary "@$parseRequest" "$parseEndpoint" >"$parseResp" \
      || fail "controlled scenario: parser call $iteration failed"

    local irReq="$outDir/iter-${iteration}-ir-req.json"
    local irResp="$outDir/iter-${iteration}-ir.json"
    jq -n --arg runId "$runId" --arg workflowId "$workflowId" \
          --slurpfile parse "$parseResp" \
          '{runId:$runId, workflowId:$workflowId, parseOutput:$parse[0]}' \
      >"$irReq"
    curl -fsS -X POST -H "Content-Type: application/json" \
      --data-binary "@$irReq" "$irEndpoint" >"$irResp" \
      || fail "controlled scenario: IR call $iteration failed"

    local genReq="$outDir/iter-${iteration}-gen-req.json"
    local genResp="$outDir/iter-${iteration}-gen.json"
    jq -n --arg runId "$runId" --slurpfile ir "$irResp" \
          '{runId:$runId, ir:($ir[0].ir)}' >"$genReq"
    curl -fsS -X POST -H "Content-Type: application/json" \
      --data-binary "@$genReq" "$generatorEndpoint" >"$genResp" \
      || fail "controlled scenario: generator call $iteration failed"

    local btrReq="$outDir/iter-${iteration}-btr-req.json"
    local btrResp="$outDir/iter-${iteration}-btr.json"
    jq -n --arg runId "$runId" --arg workflowId "$workflowId" \
          --arg programId "$programId" --slurpfile gen "$genResp" \
          '{runId:$runId, workflowId:$workflowId, programId:$programId, generationResponse:$gen[0]}' \
      >"$btrReq"
    curl -fsS -X POST -H "Content-Type: application/json" \
      --data-binary "@$btrReq" "$btrEndpoint" >"$btrResp" \
      || fail "controlled scenario: BTR call $iteration failed"
  done

  post_controlled_harness_event "$runId" "controlled.retry.failed" "failed" "controlled.retry.failed"
  post_controlled_harness_event "$runId" "controlled.retry.completed" "completed" "controlled.retry.completed"
  post_controlled_harness_event "$runId" "controlled.artifact.accepted" "accepted" "controlled.artifact.accepted"

  echo "$runId" >"$outDir/runId.txt"
}

ingest_experience() {
  log "ingesting harness events into experience-learning-service"
  local snapshot="$EVENT_DIR/all-harness-events.json"
  curl -fsS "$HARNESS_URL/v0/events" >"$snapshot" \
    || fail "failed to snapshot harness events"

  local ingestStatus
  ingestStatus="$(curl -sS -o "$EVENT_DIR/experience-harness-ingest-response.json" \
    -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    --data-binary "@$snapshot" "$EXPERIENCE_URL/v0/harness-events" || echo "000")"
  if [[ "$ingestStatus" != "200" && "$ingestStatus" != "201" ]]; then
    log "harness-event ingest failed (HTTP $ingestStatus); response body:"
    cat "$EVENT_DIR/experience-harness-ingest-response.json" >&2 || true
    fail "experience-learning harness-event ingest failed"
  fi

  log "ingesting per-run trajectory ledgers into experience-learning-service"
  local ledgerBundle="$EVENT_DIR/trajectory-ledgers.json"
  jq -s '.' "$ARTIFACTS_DIR"/*/11-trajectory-ledger.json >"$ledgerBundle"
  curl -fsS -X POST -H "Content-Type: application/json" \
    --data-binary "@$ledgerBundle" "$EXPERIENCE_URL/v0/trajectory-ledgers" \
    >"$EVENT_DIR/experience-ledger-ingest-response.json" \
    || {
        log "trajectory-ledgers ingest failed; response:"
        cat "$EVENT_DIR/experience-ledger-ingest-response.json" >&2 || true
        fail "experience-learning trajectory-ledgers ingest failed"
       }

  curl -fsS "$EXPERIENCE_URL/v0/events" >"$EVENT_DIR/experience-events-snapshot.json" \
    || fail "failed to fetch experience events"
  curl -fsS "$EXPERIENCE_URL/v0/runs" >"$EVENT_DIR/experience-runs-snapshot.json" \
    || fail "failed to fetch experience runs"
}

write_scorecard() {
  local scorecard="$VAR_DIR/scorecard.md"
  local total compileOkCount ranCount matchCount goldenMatchCount validationOkCount
  total="$(jq 'length' "$RESULTS_JSON")"
  compileOkCount="$(jq '[.[] | select(.compileOk == true)] | length' "$RESULTS_JSON")"
  ranCount="$(jq '[.[] | select(.ran == true)] | length' "$RESULTS_JSON")"
  matchCount="$(jq '[.[] | select(.buildTestClassification == "match")] | length' "$RESULTS_JSON")"
  goldenMatchCount="$(jq '[.[] | select(.goldenMasterMatched == true)] | length' "$RESULTS_JSON")"
  validationOkCount="$(jq '[.[] | select(.evidencePackValidationOk == true)] | length' "$RESULTS_JSON")"

  local harnessTotal experienceTotal patternFingerprints
  harnessTotal="$(jq 'length' "$EVENT_DIR/all-harness-events.json" 2>/dev/null || echo 0)"
  experienceTotal="$(jq 'length' "$EVENT_DIR/experience-events-snapshot.json" 2>/dev/null || echo 0)"
  patternFingerprints="$(jq '[.[].patternFingerprint] | unique | length' \
      "$EVENT_DIR/experience-events-snapshot.json" 2>/dev/null || echo 0)"

  local finishedAt
  finishedAt="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  {
    echo "# W0 Demo Scorecard"
    echo
    echo "_Generated by \`scripts/w0-demo.sh\`. Issue [#16](https://github.com/oscharko-dev/c2c-PreBeta/issues/16)._"
    echo
    echo "- Run tag: \`$RUN_TAG\`"
    echo "- Started:  $START_AT"
    echo "- Finished: $finishedAt"
    echo
    echo "## Programs"
    echo
    echo "| Program | Compile | Ran | Build/Test | Golden Master | Pack |"
    echo "|---------|---------|-----|------------|---------------|------|"
    jq -r '.[] | "| \(.programId) | \(.compileOk) | \(.ran) | \(.buildTestStatus) / \(.buildTestClassification) | matched=\(.goldenMasterMatched) (\(.goldenMasterClassification)) | \(.evidencePackStatus) (validation.ok=\(.evidencePackValidationOk)) |"' "$RESULTS_JSON"
    echo
    echo "## Aggregate metrics"
    echo
    echo "- Programs exercised: $total"
    echo "- Generated Java compiled cleanly: $compileOkCount / $total"
    echo "- Generated Java executed: $ranCount / $total"
    echo "- Golden Master byte-equal matches: $goldenMatchCount / $total"
    echo "- Build/test classification == \"match\": $matchCount / $total"
    echo "- Evidence Packs validating with no missing required artifacts: $validationOkCount / $total"
    echo "- Harness Event Envelope ledger entries captured: $harnessTotal"
    echo "- Experience Events emitted: $experienceTotal (unique patternFingerprints: $patternFingerprints)"
    echo
    echo "## Known limitations (W0)"
    echo
    echo "- The W0 Java generator now translates the selected W0 PERFORM/EVALUATE/IF/ADD/COMPUTE/OCCURS subset"
    echo "  and the acceptance bar is \`classification == match\` for every program."
    echo "- W0 fixtures are synthetic. True \`cobcrun\` golden masters are a Wave 1 follow-up."
    echo "- Model-gateway-service is not exercised end-to-end in W0; the manifest"
    echo "  records an explicit \`status: \"skipped\"\` model invocation entry for honesty."
    echo "- The Evidence Pack manifest references content by sha256 only; no raw"
    echo "  generated source, model prompt, or secret is embedded in the bundle."
    echo
    echo "## Artifacts"
    echo
    echo "- Per-program request/response captures: \`var/w0-demo/artifacts/<programId>/\`"
    echo "- Per-program Evidence Pack manifest:    \`var/w0-demo/artifacts/<programId>/16-evidence-manifest.json\`"
    echo "- Per-program exported pack directory:   \`var/w0-demo/exports/<packId>/\`"
    echo "- Harness Event ledger (raw):            \`var/w0-demo/events/harness-events.jsonl\`"
    echo "- Experience Event ledger (raw):         \`var/w0-demo/events/experience-events.jsonl\`"
    echo "- Trajectory ledger per program:         \`var/w0-demo/artifacts/<programId>/11-trajectory-ledger.json\`"
  } >"$scorecard"

  log "scorecard written to $scorecard"
  cat "$scorecard"
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

main() {
  log "W0 demo starting (run tag: $RUN_TAG, var dir: $VAR_DIR)"
  build_java

  start_harness
  start_evidence
  start_experience
  start_parser
  start_ir
  start_generator
  start_btr
  register_w0_capabilities

  for spec in "${PROGRAMS[@]}"; do
    local programId="${spec%%:*}"
    local cobolPath="${spec#*:}"
    run_program "$programId" "$cobolPath"
  done

  run_controlled_repeat_scenario
  ingest_experience
  write_scorecard

  log "W0 demo complete."
}

main "$@"
