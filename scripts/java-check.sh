#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven not installed; skipping java service checks."
  exit 0
fi

SERVICES=(
  "services/reference/w0-service-java"
  "services/cobol-parser-service"
  "services/semantic-ir-service"
  "services/target-java-generation-service"
  "services/build-test-runner-service"
)

# target-java-generation-service depends on c2c-target-java-runtime, so run the
# runtime tests first and then install it to the local repo before per-service
# tests.
if [ -f "libs/c2c-target-java-runtime/pom.xml" ]; then
  echo "Running Java checks in libs/c2c-target-java-runtime"
  (cd "libs/c2c-target-java-runtime" && mvn -q test)
  echo "Installing c2c-target-java-runtime to the local Maven repository"
  (cd "libs/c2c-target-java-runtime" && mvn -q -DskipTests install)
fi

# build-test-runner-service uses target-java-generation-service as a test-scope
# dependency (the W0 smoke integration test re-runs the generator before
# invoking the runner). Install it to the local repo before per-service tests.
if [ -f "services/target-java-generation-service/pom.xml" ]; then
  echo "Installing target-java-generation-service to the local Maven repository"
  (cd "services/target-java-generation-service" && mvn -q -DskipTests install)
fi

for service_dir in "${SERVICES[@]}"; do
  if [ -f "$service_dir/pom.xml" ]; then
    echo "Running Java checks in $service_dir"
    (cd "$service_dir" && mvn -q test)
  fi
done
