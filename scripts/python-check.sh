#!/usr/bin/env bash
set -euo pipefail

SERVICEDIR="services/python/w0-service"
cd "$SERVICEDIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python3 not installed; skipping python service checks."
  exit 0
fi

export PYTHONPATH="src:${PYTHONPATH:-}"
python3 -m unittest discover -s tests -p "*test*.py"
