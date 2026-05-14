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

log() { printf '[c2c-local-smoke] %s\n' "$*" >&2; }
fail() { printf '[c2c-local-smoke][error] %s\n' "$*" >&2; exit 1; }

wait_for_file() {
  local file="$1"
  local attempts="${2:-600}"
  while (( attempts > 0 )); do
    if [[ -f "$file" ]]; then
      return 0
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

launcher_log="$(mktemp "${TMPDIR:-/tmp}/c2c-local-launcher.XXXXXX.log")"
launcher_pid=""

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
"$ROOT_DIR/scripts/start-c2c-local.sh" --ci >"$launcher_log" 2>&1 &
launcher_pid=$!

if ! wait_for_file "$READY_MARKER" 1800; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "ready marker did not appear: $READY_MARKER"
fi

ready_url="$(tr -d '\r\n' <"$READY_MARKER")"
[[ "$ready_url" == "$BFF_URL" ]] || fail "ready marker pointed at $ready_url, expected $BFF_URL"

expected_line="c2c local application ready: $BFF_URL"
ready_count="$(grep -Fxc "$expected_line" "$launcher_log" | tr -d '[:space:]')"
[[ "$ready_count" == "1" ]] || fail "expected exactly one ready line in launcher output"

if ! wait_http "$BFF_URL/api/v0/health"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-bff health endpoint never became ready"
fi

mode_json="$(curl -fsS --max-time 2 "$BFF_URL/api/v0/mode")"
if ! jq -e '.orchestrator == "live" and .evidence == "live"' >/dev/null <<<"$mode_json"; then
  tail -n 120 "$launcher_log" >&2 || true
  fail "c2c-bff did not report live product mode: $mode_json"
fi

log "smoke checks passed, stopping stack"
"$ROOT_DIR/scripts/stop-c2c-local.sh"
wait "$launcher_pid" 2>/dev/null || true
