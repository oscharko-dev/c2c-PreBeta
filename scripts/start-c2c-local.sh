#!/usr/bin/env bash
# Product-mode local stack launcher for c2c.
#
# Builds the required artifacts, starts the local capability mesh, and serves
# the c2c UI through c2c-bff. The launcher keeps the stack alive until the
# process is interrupted or stopped via scripts/stop-c2c-local.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${C2C_LOCAL_ENV_FILE:-$ROOT_DIR/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

CI_MODE=false
if [[ "${1:-}" == "--ci" ]]; then
  CI_MODE=true
  shift
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: ./scripts/start-c2c-local.sh [--ci]

Launch the product-mode local stack from the repository root.
Use --ci to make automated smoke tests wait on var/c2c-local/ready.
USAGE
  exit 0
fi

if [[ $# -gt 0 ]]; then
  printf '[c2c-local][error] unknown argument: %s\n' "$1" >&2
  exit 1
fi

VAR_DIR="${C2C_LOCAL_VAR_DIR:-$ROOT_DIR/var/c2c-local}"
LOG_DIR="$VAR_DIR/logs"
PID_DIR="$VAR_DIR/pids"
BIN_DIR="$VAR_DIR/bin"
READY_MARKER="${C2C_LOCAL_READY_MARKER:-$VAR_DIR/ready}"

HARNESS_PORT="${C2C_LOCAL_HARNESS_PORT:-18080}"
EVIDENCE_PORT="${C2C_LOCAL_EVIDENCE_PORT:-18081}"
EXPERIENCE_PORT="${C2C_LOCAL_EXPERIENCE_PORT:-18082}"
PARSER_PORT="${C2C_LOCAL_PARSER_PORT:-18083}"
SEMANTIC_IR_PORT="${C2C_LOCAL_SEMANTIC_IR_PORT:-18084}"
TARGET_JAVA_GENERATION_PORT="${C2C_LOCAL_TARGET_JAVA_GENERATION_PORT:-18085}"
BUILD_TEST_RUNNER_PORT="${C2C_LOCAL_BUILD_TEST_RUNNER_PORT:-18086}"
MODEL_GATEWAY_PORT="${C2C_LOCAL_MODEL_GATEWAY_PORT:-18087}"
ORCHESTRATOR_PORT="${C2C_LOCAL_ORCHESTRATOR_PORT:-18088}"
BFF_PORT="${C2C_LOCAL_BFF_PORT:-18089}"

HARNESS_TOKEN="${C2C_LOCAL_HARNESS_TOKEN:-c2c-local-control-plane-token}"
MODEL_GATEWAY_ENABLED="${C2C_LOCAL_MODEL_GATEWAY_ENABLED:-false}"

HARNESS_URL="http://127.0.0.1:${HARNESS_PORT}"
EVIDENCE_URL="http://127.0.0.1:${EVIDENCE_PORT}"
EXPERIENCE_URL="http://127.0.0.1:${EXPERIENCE_PORT}"
PARSER_URL="http://127.0.0.1:${PARSER_PORT}"
SEMANTIC_IR_URL="http://127.0.0.1:${SEMANTIC_IR_PORT}"
TARGET_JAVA_GENERATION_URL="http://127.0.0.1:${TARGET_JAVA_GENERATION_PORT}"
BUILD_TEST_RUNNER_URL="http://127.0.0.1:${BUILD_TEST_RUNNER_PORT}"
MODEL_GATEWAY_URL="http://127.0.0.1:${MODEL_GATEWAY_PORT}"
ORCHESTRATOR_URL="http://127.0.0.1:${ORCHESTRATOR_PORT}"
BFF_URL="http://127.0.0.1:${BFF_PORT}"

log() { printf '[c2c-local] %s\n' "$*" >&2; }
fail() { printf '[c2c-local][error] %s\n' "$*" >&2; exit 1; }

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"
}

require curl
require jq
require go
require java
require mvn
require node
require npm
require python3

launcher_pid_file="$PID_DIR/launcher.pid"

pid_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

canonicalize_path() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.normpath(os.path.realpath(sys.argv[1])))
PY
}

assert_safe_var_dir() {
  local resolved_var_dir
  resolved_var_dir="$(canonicalize_path "$VAR_DIR")"
  local resolved_root
  resolved_root="$(canonicalize_path "$ROOT_DIR")"
  if [[ "$resolved_var_dir" != "$resolved_root"/* ]]; then
    fail "C2C_LOCAL_VAR_DIR must stay under $ROOT_DIR (got $VAR_DIR)"
  fi
  if [[ "$resolved_var_dir" == "$resolved_root" ]]; then
    fail "C2C_LOCAL_VAR_DIR must not be the repository root"
  fi
}

prepare_var_dir() {
  assert_safe_var_dir

  if [[ -f "$launcher_pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$launcher_pid_file" 2>/dev/null || true)"
    if pid_is_running "$existing_pid"; then
      fail "c2c local stack is already running (launcher pid $existing_pid)"
    fi
  fi

  mkdir -p "$VAR_DIR"
  rm -rf \
    "$LOG_DIR" \
    "$PID_DIR" \
    "$BIN_DIR" \
    "$READY_MARKER" \
    "$VAR_DIR/runs" \
    "$VAR_DIR/evidence-exports" \
    "$VAR_DIR/harness-events.jsonl" \
    "$VAR_DIR/evidence-events.jsonl" \
    "$VAR_DIR/experience-harness-events.jsonl" \
    "$VAR_DIR/agent-trajectory-ledger.jsonl" \
    "$VAR_DIR/experience-events.jsonl" \
    "$VAR_DIR/learning-artifact-registry.json" \
    "$VAR_DIR/model-invocation-ledger-v0.jsonl" \
    "$VAR_DIR/model-gateway-events-v0.jsonl"
  mkdir -p "$LOG_DIR" "$PID_DIR" "$BIN_DIR"
  printf '%s\n' "$$" >"$launcher_pid_file"
}

prepare_var_dir

cleanup() {
  local exit_code=$?
  if [[ -f "$launcher_pid_file" ]]; then
    rm -f "$launcher_pid_file"
  fi
  log "stopping c2c local services"
  if [[ -d "$PID_DIR" ]]; then
    for pid_file in "$PID_DIR"/*.pid; do
      [[ -f "$pid_file" ]] || continue
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done
    local attempts=50
    while (( attempts > 0 )); do
      local still_running=false
      for pid_file in "$PID_DIR"/*.pid; do
        [[ -f "$pid_file" ]] || continue
        local pid
        pid="$(cat "$pid_file" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
          still_running=true
          break
        fi
      done
      if ! $still_running; then
        break
      fi
      sleep 0.2
      attempts=$((attempts - 1))
    done
    for pid_file in "$PID_DIR"/*.pid; do
      [[ -f "$pid_file" ]] || continue
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    done
  fi
  rm -f "$READY_MARKER"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

wait_http() {
  local label="$1" url="$2"
  local attempts=120
  while (( attempts > 0 )); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      log "ready: $label ($url)"
      return 0
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  log "service log tail for $label:"
  tail -n 60 "$LOG_DIR/${label}.log" >&2 || true
  fail "service did not become ready: $label ($url)"
}

start_bg() {
  local name="$1" logfile="$2"
  shift 2
  local -a env_pairs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    env_pairs+=("$1")
    shift
  done
  [[ $# -gt 0 && "$1" == "--" ]] || fail "start_bg usage error for $name"
  shift
  local -a cmd=("$@")
  log "starting $name (log: $logfile)"
  (
    local pair
    for pair in "${env_pairs[@]}"; do
      export "$pair"
    done
    exec "${cmd[@]}"
  ) >"$logfile" 2>&1 &
  echo $! >"$PID_DIR/${name}.pid"
}

build_go_binary() {
  local name="$1" dir="$2"
  local out="$BIN_DIR/$name"
  log "building Go binary: $name"
  (
    cd "$dir"
    go build -o "$out" .
  ) >"$LOG_DIR/go-${name}.log" 2>&1 || fail "go build failed for $name (see $LOG_DIR/go-${name}.log)"
  printf '%s' "$out"
}

shaded_jar() {
  local svc="$1"
  local jar
  jar="$(find "$ROOT_DIR/services/$svc/target" -maxdepth 1 -type f -name "${svc}-*.jar" ! -name 'original-*' -print0 \
    | xargs -0 ls -1t 2>/dev/null \
    | head -n1 || true)"
  [[ -n "$jar" && -f "$jar" ]] || fail "could not locate shaded jar for $svc"
  printf '%s' "$jar"
}

build_java_runtime() {
  log "building c2c-target-java-runtime"
  (
    cd "$ROOT_DIR/libs/c2c-target-java-runtime"
    mvn -B -ntp -DskipTests install
  ) >"$LOG_DIR/mvn-runtime.log" 2>&1 || fail "c2c-target-java-runtime install failed (see $LOG_DIR/mvn-runtime.log)"
}

build_java_services() {
  for svc in cobol-parser-service semantic-ir-service target-java-generation-service build-test-runner-service; do
    log "packaging services/$svc"
    local goal="package"
    # target-java-generation-service is required as a test dependency for
    # build-test-runner-service, so install it into the local Maven repo.
    if [[ "$svc" == "target-java-generation-service" ]]; then
      goal="install"
    fi
    (
      cd "$ROOT_DIR/services/$svc"
      mvn -B -ntp -DskipTests "$goal"
    ) >"$LOG_DIR/mvn-${svc}.log" 2>&1 || fail "services/$svc package failed (see $LOG_DIR/mvn-${svc}.log)"
  done
}

build_ui_bundle() {
  log "building apps/c2c-ui"
  (
    cd "$ROOT_DIR/apps/c2c-ui"
    npm ci --no-fund --no-audit
    npm run build
  ) >"$LOG_DIR/c2c-ui.log" 2>&1 || fail "apps/c2c-ui build failed (see $LOG_DIR/c2c-ui.log)"
  [[ -f "$ROOT_DIR/apps/c2c-ui/dist/index.html" ]] || fail "c2c-ui dist/index.html was not built"
}

build_bff() {
  log "building services/c2c-bff"
  (
    cd "$ROOT_DIR/services/c2c-bff"
    npm ci --no-fund --no-audit
    npm run build
  ) >"$LOG_DIR/c2c-bff.log" 2>&1 || fail "services/c2c-bff build failed (see $LOG_DIR/c2c-bff.log)"
  [[ -f "$ROOT_DIR/services/c2c-bff/dist/index.js" ]] || fail "c2c-bff dist/index.js was not built"
}

build_orchestrator_capabilities_json() {
  if is_truthy "$MODEL_GATEWAY_ENABLED"; then
    jq -nc \
      --arg parser_endpoint "$PARSER_URL/v0/parse" \
      --arg ir_endpoint "$SEMANTIC_IR_URL/v0/ir" \
      --arg generator_endpoint "$TARGET_JAVA_GENERATION_URL/v0/generate" \
      --arg build_test_endpoint "$BUILD_TEST_RUNNER_URL/v0/run-verification" \
      --arg evidence_endpoint "$EVIDENCE_URL/v0/packs" \
      --arg model_gateway_endpoint "$MODEL_GATEWAY_URL/v0/invoke" \
      '[
        {
          id: "cobol.parse",
          name: "COBOL Parser",
          owner: "cobol-parser-service",
          endpoint: $parser_endpoint,
          dataClass: "parser",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "cobol.ir",
          name: "Semantic IR Generator",
          owner: "semantic-ir-service",
          endpoint: $ir_endpoint,
          dataClass: "parser",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "target.java.generate",
          name: "Target Java Generator",
          owner: "target-java-generation-service",
          endpoint: $generator_endpoint,
          dataClass: "generator",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "build-test.run",
          name: "Build/Test Runner",
          owner: "build-test-runner-service",
          endpoint: $build_test_endpoint,
          dataClass: "build-test",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "evidence.writer",
          name: "Evidence Pack Writer",
          owner: "evidence-service",
          endpoint: $evidence_endpoint,
          dataClass: "evidence",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "model-gateway",
          name: "Model Gateway",
          owner: "model-gateway-service",
          endpoint: $model_gateway_endpoint,
          dataClass: "model-gateway",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        }
      ]'
  else
    jq -nc \
      --arg parser_endpoint "$PARSER_URL/v0/parse" \
      --arg ir_endpoint "$SEMANTIC_IR_URL/v0/ir" \
      --arg generator_endpoint "$TARGET_JAVA_GENERATION_URL/v0/generate" \
      --arg build_test_endpoint "$BUILD_TEST_RUNNER_URL/v0/run-verification" \
      --arg evidence_endpoint "$EVIDENCE_URL/v0/packs" \
      '[
        {
          id: "cobol.parse",
          name: "COBOL Parser",
          owner: "cobol-parser-service",
          endpoint: $parser_endpoint,
          dataClass: "parser",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "cobol.ir",
          name: "Semantic IR Generator",
          owner: "semantic-ir-service",
          endpoint: $ir_endpoint,
          dataClass: "parser",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "target.java.generate",
          name: "Target Java Generator",
          owner: "target-java-generation-service",
          endpoint: $generator_endpoint,
          dataClass: "generator",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "build-test.run",
          name: "Build/Test Runner",
          owner: "build-test-runner-service",
          endpoint: $build_test_endpoint,
          dataClass: "build-test",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        },
        {
          id: "evidence.writer",
          name: "Evidence Pack Writer",
          owner: "evidence-service",
          endpoint: $evidence_endpoint,
          dataClass: "evidence",
          policyProfile: "harness-control-plane",
          version: "v0.1.0"
        }
      ]'
  fi
}

start_harness() {
  local bin
  bin="$(build_go_binary harness "$ROOT_DIR/services/agentic-harness-core")"
  start_bg harness "$LOG_DIR/harness.log" \
    HARNESS_PORT="$HARNESS_PORT" \
    HARNESS_EVENT_LOG_PATH="$VAR_DIR/harness-events.jsonl" \
    HARNESS_CONTROL_PLANE_TOKEN="$HARNESS_TOKEN" \
    -- \
    "$bin"
  wait_http harness "$HARNESS_URL/v0/health"
  wait_http harness "$HARNESS_URL/v0/ready"
}

start_evidence() {
  local bin
  bin="$(build_go_binary evidence "$ROOT_DIR/services/evidence-service")"
  start_bg evidence "$LOG_DIR/evidence.log" \
    EVIDENCE_PORT="$EVIDENCE_PORT" \
    EVIDENCE_EVENT_LOG_PATH="$VAR_DIR/evidence-events.jsonl" \
    EVIDENCE_EXPORT_DIR="$VAR_DIR/evidence-exports" \
    -- \
    "$bin"
  wait_http evidence "$EVIDENCE_URL/v0/health"
  wait_http evidence "$EVIDENCE_URL/v0/ready"
}

start_experience_learning() {
  local bin
  bin="$(build_go_binary experience-learning "$ROOT_DIR/services/experience-learning-service")"
  start_bg experience-learning "$LOG_DIR/experience-learning.log" \
    EXPERIENCE_LEARNING_LISTEN_ADDR=":$EXPERIENCE_PORT" \
    EXPERIENCE_LEARNING_HARNESS_EVENTS_PATH="$VAR_DIR/experience-harness-events.jsonl" \
    EXPERIENCE_LEARNING_TRAJECTORY_LEDGER_PATH="$VAR_DIR/agent-trajectory-ledger.jsonl" \
    EXPERIENCE_LEARNING_EVENTS_PATH="$VAR_DIR/experience-events.jsonl" \
    EXPERIENCE_LEARNING_ARTIFACT_REGISTRY_PATH="$VAR_DIR/learning-artifact-registry.json" \
    EXPERIENCE_LEARNING_AUTO_ANALYZE=true \
    -- \
    "$bin"
  wait_http experience-learning "$EXPERIENCE_URL/v0/health"
}

start_model_gateway() {
  if ! is_truthy "$MODEL_GATEWAY_ENABLED"; then
    return 0
  fi
  local bin
  bin="$(build_go_binary model-gateway "$ROOT_DIR/services/go/model-gateway-service")"
  start_bg model-gateway "$LOG_DIR/model-gateway.log" \
    MODEL_GATEWAY_LISTEN_ADDR=":$MODEL_GATEWAY_PORT" \
    MODEL_GATEWAY_MODEL_REGISTRY_PATH="$ROOT_DIR/config/model-registry.example.yaml" \
    MODEL_GATEWAY_ALLOWLIST_PATH="$ROOT_DIR/config/foundry-development-allowlist-v0.yaml" \
    MODEL_GATEWAY_LEDGER_PATH="$VAR_DIR/model-invocation-ledger-v0.jsonl" \
    MODEL_GATEWAY_EVENT_LOG_PATH="$VAR_DIR/model-gateway-events-v0.jsonl" \
    C2C_MODEL_INVOCATION_LEDGER_ENABLED=true \
    C2C_HARNESS_EVENT_EMISSION_ENABLED=true \
    HARNESS_EVENT_URL="$HARNESS_URL/v0/events" \
    -- \
    "$bin"
  wait_http model-gateway "$MODEL_GATEWAY_URL/v0/health"
}

start_java_services() {
  local jar
  # The Java services accept a port, :port, or host:port; pass host:port
  # explicitly so the launcher's listen-address convention is unambiguous.
  jar="$(shaded_jar cobol-parser-service)"
  start_bg parser "$LOG_DIR/parser.log" \
    COBOL_PARSER_LISTEN_ADDR="127.0.0.1:$PARSER_PORT" \
    HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
    HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    -- \
    java -jar "$jar"
  wait_http parser "$PARSER_URL/health"

  jar="$(shaded_jar semantic-ir-service)"
  start_bg semantic-ir "$LOG_DIR/semantic-ir.log" \
    SEMANTIC_IR_LISTEN_ADDR="127.0.0.1:$SEMANTIC_IR_PORT" \
    HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
    HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    -- \
    java -jar "$jar"
  wait_http semantic-ir "$SEMANTIC_IR_URL/health"

  jar="$(shaded_jar target-java-generation-service)"
  start_bg target-java-generation "$LOG_DIR/target-java-generation.log" \
    TARGET_JAVA_GENERATION_LISTEN_ADDR="127.0.0.1:$TARGET_JAVA_GENERATION_PORT" \
    HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
    HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    -- \
    java -jar "$jar"
  wait_http target-java-generation "$TARGET_JAVA_GENERATION_URL/health"

  jar="$(shaded_jar build-test-runner-service)"
  start_bg build-test-runner "$LOG_DIR/build-test-runner.log" \
    BUILD_TEST_RUNNER_LISTEN_ADDR="127.0.0.1:$BUILD_TEST_RUNNER_PORT" \
    HARNESS_EVENT_ENDPOINT="$HARNESS_URL" \
    HARNESS_EVENT_TOKEN="$HARNESS_TOKEN" \
    EXPERIENCE_EVENT_ENDPOINT="$EXPERIENCE_URL" \
    -- \
    java -jar "$jar"
  wait_http build-test-runner "$BUILD_TEST_RUNNER_URL/health"
}

start_orchestrator() {
  local capabilities_json
  capabilities_json="$(build_orchestrator_capabilities_json)"
  start_bg orchestrator "$LOG_DIR/orchestrator.log" \
    ORCHESTRATOR_LISTEN_ADDR=":${ORCHESTRATOR_PORT}" \
    ORCHESTRATOR_HARNESS_BASE_URL="$HARNESS_URL" \
    ORCHESTRATOR_HARNESS_TOKEN="$HARNESS_TOKEN" \
    ORCHESTRATOR_W0_CAPABILITIES="$capabilities_json" \
    ORCHESTRATOR_PARSE_CAPABILITY_ENDPOINT="$PARSER_URL/v0/parse" \
    ORCHESTRATOR_IR_CAPABILITY_ENDPOINT="$SEMANTIC_IR_URL/v0/ir" \
    ORCHESTRATOR_GENERATOR_CAPABILITY_ENDPOINT="$TARGET_JAVA_GENERATION_URL/v0/generate" \
    ORCHESTRATOR_BUILD_TEST_CAPABILITY_ENDPOINT="$BUILD_TEST_RUNNER_URL/v0/run-verification" \
    ORCHESTRATOR_EVIDENCE_CAPABILITY_ENDPOINT="$EVIDENCE_URL/v0/packs" \
    ORCHESTRATOR_MODEL_GATEWAY_CAPABILITY_ENDPOINT="$MODEL_GATEWAY_URL/v0/invoke" \
    ORCHESTRATOR_MODEL_GATEWAY_MODEL_ID="${C2C_LOCAL_MODEL_GATEWAY_MODEL_ID:-gpt-oss-120b}" \
    ORCHESTRATOR_EXPERIENCE_LEARNING_BASE_URL="$EXPERIENCE_URL" \
    C2C_RUN_ARTIFACT_ROOT="${C2C_RUN_ARTIFACT_ROOT:-$VAR_DIR/runs}" \
    PYTHONPATH="$ROOT_DIR/services/orchestrator-service/src" \
    -- \
    python3 -m orchestrator_service.main
  wait_http orchestrator "$ORCHESTRATOR_URL/health"
}

start_bff() {
  start_bg c2c-bff "$LOG_DIR/c2c-bff.log" \
    C2C_REPO_ROOT="$ROOT_DIR" \
    C2C_UI_DIST="$ROOT_DIR/apps/c2c-ui/dist" \
    C2C_BFF_PORT="$BFF_PORT" \
    C2C_ORCHESTRATOR_URL="$ORCHESTRATOR_URL" \
    C2C_EVIDENCE_URL="$EVIDENCE_URL" \
    C2C_EXPERIENCE_LEARNING_URL="$EXPERIENCE_URL" \
    -- \
    node "$ROOT_DIR/services/c2c-bff/dist/index.js"
  wait_http c2c-bff "$BFF_URL/api/v0/health"
}

build_java_runtime
build_java_services
build_ui_bundle
build_bff

start_harness
start_evidence
start_experience_learning
start_model_gateway
start_java_services
start_orchestrator
start_bff

mode_json="$(curl -fsS --max-time 2 "$BFF_URL/api/v0/mode")"
if ! jq -e '.orchestrator == "live" and .evidence == "live"' >/dev/null <<<"$mode_json"; then
  fail "c2c-bff did not report live product mode: $mode_json"
fi

printf '%s\n' "$BFF_URL" >"$READY_MARKER"
printf 'c2c local application ready: %s\n' "$BFF_URL"

while true; do
  for pid_file in "$PID_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    pid=""
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      fail "background service exited unexpectedly: $(basename "$pid_file" .pid)"
    fi
  done
  sleep 1
done
