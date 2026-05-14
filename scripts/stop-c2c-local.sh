#!/usr/bin/env bash
# Stop the c2c local product-mode stack.

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
PID_DIR="$VAR_DIR/pids"
READY_MARKER="${C2C_LOCAL_READY_MARKER:-$VAR_DIR/ready}"

log() { printf '[c2c-local] %s\n' "$*" >&2; }

if [[ ! -d "$PID_DIR" ]]; then
  rm -f "$READY_MARKER"
  exit 0
fi

stop_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

if [[ -f "$PID_DIR/launcher.pid" ]]; then
  stop_pid "$(cat "$PID_DIR/launcher.pid" 2>/dev/null || true)"
fi

for pid_file in "$PID_DIR"/*.pid; do
  [[ -f "$pid_file" ]] || continue
  stop_pid "$(cat "$pid_file" 2>/dev/null || true)"
done

attempts=100
while (( attempts > 0 )); do
  still_running=false
  for pid_file in "$PID_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
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
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
done

rm -f "$READY_MARKER"
log "c2c local stack stopped"
