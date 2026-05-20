#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

catalog_field() {
  python3 scripts/validate-service-catalog.py --worktree --print-field "$1" --component-id "$2"
}

require_component_files() {
  local component_id="$1"
  shift
  local component_root
  component_root="$(catalog_field path "$component_id")"
  for relative_path in "$@"; do
    if [ ! -f "$component_root/$relative_path" ]; then
      echo "Missing required platform file: $component_root/$relative_path" >&2
      exit 1
    fi
  done
}

python3 scripts/validate-service-catalog.py --worktree

echo "Validated service catalog."

python3 scripts/check_model_governance.py --worktree

echo "Validated model governance scan."

python3 -m unittest scripts/check_model_governance_test.py

echo "Validated model governance scanner regression tests."

python3 -m unittest scripts/check_w0_2_evidence_test.py

echo "Validated W0.2 evidence pack validator regression tests."

(
  cd services/orchestrator-service
  PYTHONPATH=src python3 -m unittest tests.test_config tests.test_workflow tests.test_server_integration
)

echo "Validated orchestrator model governance behavior."

(
  cd services/evidence-service
  go test ./...
)
echo "Validated evidence-service model governance behavior."

for f in \
  docs/evidence-service/sample-evidence-pack-manifest.json \
  fixtures/golden-master/index.json \
  schemas/semantic-ir-v0.json \
  schemas/build-test-result-v0.json \
  schemas/model-policy-skipped-v0.json \
  schemas/evidence-pack-manifest-v0.json \
  scripts/w0-2-release-gate.sh \
  scripts/w0-3-release-gate.sh
do
  if [ ! -f "$f" ]; then
    echo "Missing required platform file: $f" >&2
    exit 1
  fi
done

require_component_files "w0-service-go" \
  main.go \
  main_test.go \
  Dockerfile

require_component_files "agentic-harness-core" \
  main.go \
  main_test.go \
  Dockerfile

require_component_files "w0-service-python" \
  requirements.txt \
  src/c2c_service.py \
  src/cli.py \
  tests/test_service.py \
  Dockerfile

require_component_files "w0-service-typescript" \
  package.json \
  tsconfig.json \
  src/index.ts \
  src/index.test.ts \
  Dockerfile

require_component_files "w0-service-java" \
  pom.xml \
  src/main/java/com/c2c/w0/service/ServiceApp.java \
  src/test/java/com/c2c/w0/service/ServiceAppTest.java \
  Dockerfile

require_component_files "cobol-parser-service" \
  pom.xml \
  src/main/java/com/c2c/w0/parser/CobolParser.java \
  src/main/java/com/c2c/w0/parser/ServiceApp.java \
  src/test/java/com/c2c/w0/parser/CobolParserTest.java \
  Dockerfile

require_component_files "semantic-ir-service" \
  pom.xml \
  src/main/java/com/c2c/w0/semanticir/SemanticIrService.java \
  src/main/java/com/c2c/w0/semanticir/ServiceApp.java \
  src/test/java/com/c2c/w0/semanticir/SemanticIrServiceTest.java \
  Dockerfile

require_component_files "build-test-runner-service" \
  pom.xml \
  openapi.yaml \
  Dockerfile \
  src/main/java/com/c2c/w0/buildtest/CobolRuntimeExecutor.java \
  src/main/java/com/c2c/w0/buildtest/BuildTestRunnerService.java \
  src/main/java/com/c2c/w0/buildtest/ServiceApp.java \
  src/test/java/com/c2c/w0/buildtest/BuildTestRunnerServiceTest.java \
  src/test/java/com/c2c/w0/buildtest/W0SmokeIntegrationTest.java

require_component_files "evidence-service" \
  go.mod \
  main.go \
  manifest.go \
  server.go \
  store.go \
  export.go \
  events.go \
  manifest_test.go \
  server_test.go \
  Dockerfile \
  openapi.yaml \
  README.md

echo "Validated required platform files."
