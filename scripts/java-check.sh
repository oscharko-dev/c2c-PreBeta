#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven not installed; skipping java service checks."
  exit 0
fi

mapfile -t SERVICES < <(
  python3 scripts/validate-service-catalog.py \
    --worktree \
    --list-field path \
    --language java \
    --kind service \
    --release-gate ci
)

JAVA_RUNTIME_DIR="$(
  python3 scripts/validate-service-catalog.py \
    --worktree \
    --print-field path \
    --component-id c2c-target-java-runtime
)"

TARGET_JAVA_GENERATOR_DIR="$(
  python3 scripts/validate-service-catalog.py \
    --worktree \
    --print-field path \
    --component-id target-java-generation-service
)"

# target-java-generation-service depends on c2c-target-java-runtime, so run the
# runtime tests first and then install it to the local repo before per-service
# tests.
if [ -f "$JAVA_RUNTIME_DIR/pom.xml" ]; then
  echo "Running Java checks in $JAVA_RUNTIME_DIR"
  (cd "$JAVA_RUNTIME_DIR" && mvn -q test)
  echo "Installing c2c-target-java-runtime to the local Maven repository"
  (cd "$JAVA_RUNTIME_DIR" && mvn -q -DskipTests install)
fi

# build-test-runner-service uses target-java-generation-service as a test-scope
# dependency (the W0 smoke integration test re-runs the generator before
# invoking the runner). Install it to the local repo before per-service tests.
if [ -f "$TARGET_JAVA_GENERATOR_DIR/pom.xml" ]; then
  echo "Installing target-java-generation-service to the local Maven repository"
  (cd "$TARGET_JAVA_GENERATOR_DIR" && mvn -q -DskipTests install)
fi

for service_dir in "${SERVICES[@]}"; do
  if [ -f "$service_dir/pom.xml" ]; then
    echo "Running Java checks in $service_dir"
    (cd "$service_dir" && mvn -q test)
  fi
done
