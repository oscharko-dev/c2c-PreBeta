#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven not installed; skipping java service checks."
  exit 0
fi

SERVICES=(
  "services/java/w0-service"
  "services/cobol-parser-service"
  "services/semantic-ir-service"
)

for service_dir in "${SERVICES[@]}"; do
  if [ -f "$service_dir/pom.xml" ]; then
    echo "Running Java checks in $service_dir"
    (cd "$service_dir" && mvn -q test)
  fi
done
