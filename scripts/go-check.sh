#!/usr/bin/env bash
set -euo pipefail

if ! command -v go >/dev/null 2>&1; then
  echo "Go toolchain not installed; skipping go service checks."
  exit 0
fi

for SERVICEDIR in services/go/*; do
  if [ ! -d "$SERVICEDIR" ] || [ ! -f "$SERVICEDIR/go.mod" ]; then
    continue
  fi

  echo "Running Go checks in $SERVICEDIR"
  (cd "$SERVICEDIR" && go test ./...)
done
