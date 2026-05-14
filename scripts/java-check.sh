#!/usr/bin/env bash
set -euo pipefail

SERVICEDIR="services/java/w0-service"
cd "$SERVICEDIR"

if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven not installed; skipping java service checks."
  exit 0
fi

mvn -q test
