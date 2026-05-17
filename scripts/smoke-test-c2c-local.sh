#!/usr/bin/env bash
# CI smoke harness for the c2c local product-mode launcher.

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

VAR_DIR="${C2C_LOCAL_VAR_DIR:-$ROOT_DIR/var/c2c-local}"
READY_MARKER="${C2C_LOCAL_READY_MARKER:-$VAR_DIR/ready}"
BFF_PORT="${C2C_LOCAL_BFF_PORT:-18089}"
BFF_URL="http://127.0.0.1:${BFF_PORT}"
STUDIO_PORT="${C2C_LOCAL_STUDIO_PORT:-3000}"
STUDIO_URL="http://127.0.0.1:${STUDIO_PORT}"
MODEL_GATEWAY_FLAG="$(printf '%s' "${C2C_LOCAL_MODEL_GATEWAY_ENABLED:-}" | tr '[:upper:]' '[:lower:]')"

log() { printf '[c2c-local-smoke] %s\n' "$*" >&2; }
fail() { printf '[c2c-local-smoke][error] %s\n' "$*" >&2; exit 1; }

wait_for_file() {
  local file="$1"
  local launcher_pid="$2"
  local attempts="${3:-600}"
  while (( attempts > 0 )); do
    if [[ -f "$file" ]]; then
      return 0
    fi
    if [[ -n "$launcher_pid" ]] && ! kill -0 "$launcher_pid" 2>/dev/null; then
      return 2
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  return 1
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  while (( attempts > 0 )); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  return 1
}

curl_json() {
  local url="$1"
  curl -fsS --max-time 10 "$url"
}

post_json() {
  local url="$1"
  local payload="$2"
  curl -fsS --max-time 20 \
    -H 'Content-Type: application/json' \
    -X POST \
    --data "$payload" \
    "$url"
}

encode_generated_path() {
  local relpath="$1"
  jq -rn --arg path "$relpath" '$path | split("/") | map(@uri) | join("/")'
}

effective_model_gateway_enabled() {
  case "$MODEL_GATEWAY_FLAG" in
    1|true|yes|on)
      printf 'true'
      ;;
    0|false|no|off)
      printf 'false'
      ;;
    auto|"")
      if [[ -n "${C2C_MODEL_PROVIDER:-}" || -n "${AZURE_FOUNDRY_ENDPOINT:-}" || -n "${C2C_MODEL_DEFAULT_DEPLOYMENT:-}" ]]; then
        printf 'true'
      else
        printf 'false'
      fi
      ;;
    *)
      fail "C2C_LOCAL_MODEL_GATEWAY_ENABLED must be true, false, or auto (got $MODEL_GATEWAY_FLAG)"
      ;;
  esac
}

assert_product_transform() {
  local source_file="$1"
  local source_name
  source_name="$(basename "$source_file")"
  [[ -f "$source_file" ]] || fail "product-path COBOL fixture missing: $source_file"

  log "starting product transform through BFF: $source_name"
  local transform_payload transform_json run_id run_json run_status
  transform_payload="$(jq -n \
    --rawfile source "$source_file" \
    --arg sourceName "$source_name" \
    --argjson useAgent "$EFFECTIVE_MODEL_GATEWAY_ENABLED" \
    '{sourceText: $source, sourceName: $sourceName, useTransformationAgent: $useAgent}')"
  transform_json="$(post_json "$BFF_URL/api/v0/transform" "$transform_payload")"
  run_id="$(jq -r '.runId // empty' <<<"$transform_json")"
  [[ -n "$run_id" ]] || fail "$source_name: transform response did not include runId: $transform_json"

  run_json=""
  for _ in $(seq 1 240); do
    run_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id")"
    run_status="$(jq -r '.status // empty' <<<"$run_json")"
    if [[ "$run_status" == "completed" ]]; then
      break
    fi
    if [[ "$run_status" == "failed" ]]; then
      fail "$source_name: transform run failed: $run_json"
    fi
    sleep 1
  done

  if [[ "$(jq -r '.status // empty' <<<"$run_json")" != "completed" ]]; then
    fail "$source_name: transform run did not complete before timeout: $run_json"
  fi

  local generated_json generated_files_json build_test_json evidence_json progress_json artifacts_json
  generated_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/generated")"
  generated_files_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/generated/files")"
  build_test_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/build-test")"
  evidence_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/evidence")"
  progress_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/progress")"
  artifacts_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/artifacts")"

  jq -e --arg run "$run_id" '.runId == $run and .status == "generated" and (.artifactRef.sha256 | type == "string")' >/dev/null <<<"$generated_json" \
    || fail "$source_name: generated view did not report artifact-backed Java for $run_id: $generated_json"
  jq -e --arg run "$run_id" '.runId == $run and .status == "complete" and (.files | length > 0)' >/dev/null <<<"$generated_files_json" \
    || fail "$source_name: generated files index is incomplete for $run_id: $generated_files_json"
  jq -e --arg run "$run_id" '.runId == $run and .status == "ok" and .classification == "match"' >/dev/null <<<"$build_test_json" \
    || fail "$source_name: build/test result is not a matching success for $run_id: $build_test_json"
  jq -e --arg run "$run_id" '.runId == $run and .status == "complete"' >/dev/null <<<"$evidence_json" \
    || fail "$source_name: evidence pack is not complete for $run_id: $evidence_json"
  if [[ "$EFFECTIVE_MODEL_GATEWAY_ENABLED" == "false" ]]; then
    jq -e --arg run "$run_id" '.runId == $run and .status == "complete" and ([.steps[].name] | index("model-policy-skipped"))' >/dev/null <<<"$progress_json" \
      || fail "$source_name: progress timeline did not include model-policy-skipped for deterministic no-model mode: $progress_json"
    jq -e --arg run "$run_id" '.runId == $run and ([.artifacts[].kind] | index("model-policy-skipped"))' >/dev/null <<<"$artifacts_json" \
      || fail "$source_name: run artifacts did not include model-policy-skipped for deterministic no-model mode: $artifacts_json"
  else
    jq -e --arg run "$run_id" '.runId == $run and ([.steps[].name] | index("transformation-agent"))' >/dev/null <<<"$progress_json" \
      || fail "$source_name: progress timeline did not include transformation-agent for model mode: $progress_json"
    jq -e --arg run "$run_id" '.runId == $run and ([.artifacts[].kind] | index("transformation-agent-response"))' >/dev/null <<<"$artifacts_json" \
      || fail "$source_name: run artifacts did not include transformation-agent-response for model mode: $artifacts_json"
  fi

  local generated_artifact_sha entry_file_path encoded_entry_path generated_file_json entry_file_sha
  generated_artifact_sha="$(jq -r '.artifactRef.sha256' <<<"$generated_json")"
  jq -e --arg sha "$generated_artifact_sha" '.generatedArtifactRef.sha256 == $sha' >/dev/null <<<"$build_test_json" \
    || fail "$source_name: build/test generated artifact ref does not align with generated view"
  jq -e --arg sha "$generated_artifact_sha" '.generatedArtifactRef.sha256 == $sha' >/dev/null <<<"$evidence_json" \
    || fail "$source_name: evidence generated artifact ref does not align with generated view"

  entry_file_path="$(jq -r '.entryFilePath // .files[0].path // empty' <<<"$generated_files_json")"
  [[ -n "$entry_file_path" ]] || fail "$source_name: generated files index did not include an entry file: $generated_files_json"
  encoded_entry_path="$(encode_generated_path "$entry_file_path")"
  generated_file_json="$(curl_json "$BFF_URL/api/v0/runs/$run_id/generated/files/$encoded_entry_path")"
  entry_file_sha="$(jq -r --arg path "$entry_file_path" '.files[] | select(.path == $path) | .sha256' <<<"$generated_files_json")"
  jq -e --arg run "$run_id" --arg path "$entry_file_path" --arg sha "$entry_file_sha" \
    '.runId == $run and .path == $path and .sha256 == $sha and (.content | test("public[[:space:]]+(final[[:space:]]+)?class"))' >/dev/null <<<"$generated_file_json" \
    || fail "$source_name: entry generated Java file content did not match the files index for $run_id: $generated_file_json"

  log "product transform passed: $source_name ($run_id)"
}

launcher_log="$(mktemp "${TMPDIR:-/tmp}/c2c-local-launcher.XXXXXX.log")"
launcher_pid=""
EFFECTIVE_MODEL_GATEWAY_ENABLED="$(effective_model_gateway_enabled)"

cleanup() {
  local exit_code=$?
  "$ROOT_DIR/scripts/stop-c2c-local.sh" >/dev/null 2>&1 || true
  if [[ -n "$launcher_pid" ]]; then
    wait "$launcher_pid" 2>/dev/null || true
  fi
  rm -f "$launcher_log"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

log "starting launcher"
rm -f "$READY_MARKER"
"$ROOT_DIR/scripts/start-c2c-local.sh" --ci >"$launcher_log" 2>&1 &
launcher_pid=$!

wait_result=0
wait_for_file "$READY_MARKER" "$launcher_pid" 1800 || wait_result=$?
if (( wait_result != 0 )); then
  tail -n 120 "$launcher_log" >&2 || true
  if [[ "$wait_result" == "2" ]]; then
    fail "launcher exited before writing ready marker"
  fi
  fail "ready marker did not appear: $READY_MARKER"
fi

ready_url="$(tr -d '\r\n' <"$READY_MARKER")"
[[ "$ready_url" == "$STUDIO_URL" ]] || fail "ready marker pointed at $ready_url, expected $STUDIO_URL"

if ! wait_http "$BFF_URL/api/v0/health"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-bff health endpoint never became ready"
fi

if ! wait_http "$STUDIO_URL"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-studio endpoint never became ready"
fi

studio_html="$(curl -fsS --max-time 2 "$STUDIO_URL")"
if ! grep -Fq 'c2c Transformation Studio' <<<"$studio_html"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-studio root did not render the expected Studio shell"
fi

mode_json="$(curl -fsS --max-time 2 "$BFF_URL/api/v0/mode")"
if ! jq -e '.orchestrator == "live" and .evidence == "live"' >/dev/null <<<"$mode_json"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-bff did not report live product mode: $mode_json"
fi

studio_health_html="$(curl -fsS --max-time 2 "$STUDIO_URL")"
if grep -Fq 'Error loading programs: Contract error: API returned malformed JSON.' <<<"$studio_health_html"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-studio loaded against the wrong API origin and could not fetch reference programs"
fi

if [[ "$EFFECTIVE_MODEL_GATEWAY_ENABLED" == "true" ]]; then
  if ! wait_http "$BFF_URL/api/v0/model-gateway/health"; then
    tail -n 120 "$launcher_log" >&2 || true
    fail "model-gateway health endpoint never became ready"
  fi
fi

supported_sources=(
  "$ROOT_DIR/corpus/synthetic/programs/arithmetic-adjustment-ledger.cbl"
  "$ROOT_DIR/corpus/synthetic/programs/branch-account-guard.cbl"
  "$ROOT_DIR/corpus/synthetic/programs/ctrl-decimal-payroll.cbl"
  "$ROOT_DIR/corpus/synthetic/programs/decimal-batch-aggregator.cbl"
  "$ROOT_DIR/corpus/synthetic/programs/hello-w02.cbl"
)

for source_file in "${supported_sources[@]}"; do
  assert_product_transform "$source_file"
done

log "smoke checks passed, stopping stack"
"$ROOT_DIR/scripts/stop-c2c-local.sh"
wait "$launcher_pid" 2>/dev/null || true
