#!/usr/bin/env bash
set -euo pipefail

SERVICEDIR="services/typescript/w0-service"
cd "$SERVICEDIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed; skipping typescript service checks."
  exit 0
fi

npm install
npm run lint
npm run test
