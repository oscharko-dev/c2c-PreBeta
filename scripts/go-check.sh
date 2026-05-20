#!/usr/bin/env bash
set -euo pipefail

if ! command -v go >/dev/null 2>&1; then
  echo "Go toolchain not installed; skipping go service checks."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mapfile -t SERVICE_DIRS < <(
  cd "$ROOT_DIR" &&
    python3 scripts/validate-service-catalog.py \
      --worktree \
      --list-field path \
      --language go \
      --release-gate ci
)

for SERVICEDIR in "${SERVICE_DIRS[@]}"; do
  if [ ! -d "$SERVICEDIR" ] || [ ! -f "$SERVICEDIR/go.mod" ]; then
    continue
  fi

  echo "Running Go checks in $SERVICEDIR"
  (cd "$SERVICEDIR" && go test ./...)
done
