#!/usr/bin/env bash
set -euo pipefail

SERVICEDIR="services/go/w0-service"
cd "$SERVICEDIR"

if ! command -v go >/dev/null 2>&1; then
  echo "Go toolchain not installed; skipping go service checks."
  exit 0
fi

go test ./...
go test -run TestComputeGrossPay ./...
