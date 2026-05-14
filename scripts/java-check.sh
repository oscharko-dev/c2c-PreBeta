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
  "services/target-java-generation-service"
)

# target-java-generation-service depends on c2c-target-java-runtime, so install
# the runtime to the local repo before running per-service tests.
if [ -f "libs/c2c-target-java-runtime/pom.xml" ]; then
  echo "Installing c2c-target-java-runtime to the local Maven repository"
  (cd "libs/c2c-target-java-runtime" && mvn -q -DskipTests install)
fi

for service_dir in "${SERVICES[@]}"; do
  if [ -f "$service_dir/pom.xml" ]; then
    echo "Running Java checks in $service_dir"
    (cd "$service_dir" && mvn -q test)
  fi
done
