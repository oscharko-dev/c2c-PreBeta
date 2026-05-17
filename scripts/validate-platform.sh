#!/usr/bin/env bash
set -euo pipefail

REQUIRED_DIRS=(
  "services/go/w0-service"
  "services/agentic-harness-core"
  "services/python/w0-service"
  "services/typescript/w0-service"
  "services/java/w0-service"
  "services/cobol-parser-service"
  "services/semantic-ir-service"
)

for d in "${REQUIRED_DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    echo "Missing required service directory: $d" >&2
    exit 1
  fi
 done

echo "Validated service directories."

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
  services/go/w0-service/main.go \
  services/go/w0-service/main_test.go \
  services/go/w0-service/Dockerfile \
  services/agentic-harness-core/main.go \
  services/agentic-harness-core/main_test.go \
  services/agentic-harness-core/Dockerfile \
  services/python/w0-service/requirements.txt \
  services/python/w0-service/src/c2c_service.py \
  services/python/w0-service/src/cli.py \
  services/python/w0-service/tests/test_service.py \
  services/python/w0-service/Dockerfile \
  services/typescript/w0-service/package.json \
  services/typescript/w0-service/tsconfig.json \
  services/typescript/w0-service/src/index.ts \
  services/typescript/w0-service/src/index.test.ts \
  services/typescript/w0-service/Dockerfile \
  services/java/w0-service/pom.xml \
  services/java/w0-service/src/main/java/com/c2c/w0/service/ServiceApp.java \
  services/java/w0-service/src/test/java/com/c2c/w0/service/ServiceAppTest.java \
  services/java/w0-service/Dockerfile \
  services/cobol-parser-service/pom.xml \
  services/cobol-parser-service/src/main/java/com/c2c/w0/parser/CobolParser.java \
  services/cobol-parser-service/src/main/java/com/c2c/w0/parser/ServiceApp.java \
  services/cobol-parser-service/src/test/java/com/c2c/w0/parser/CobolParserTest.java \
  services/cobol-parser-service/Dockerfile \
  services/semantic-ir-service/pom.xml \
  services/semantic-ir-service/src/main/java/com/c2c/w0/semanticir/SemanticIrService.java \
  services/semantic-ir-service/src/main/java/com/c2c/w0/semanticir/ServiceApp.java \
  services/semantic-ir-service/src/test/java/com/c2c/w0/semanticir/SemanticIrServiceTest.java \
  services/semantic-ir-service/Dockerfile \
  services/build-test-runner-service/pom.xml \
  services/build-test-runner-service/openapi.yaml \
  services/build-test-runner-service/Dockerfile \
  services/build-test-runner-service/src/main/java/com/c2c/w0/buildtest/CobolRuntimeExecutor.java \
  services/build-test-runner-service/src/main/java/com/c2c/w0/buildtest/BuildTestRunnerService.java \
  services/build-test-runner-service/src/main/java/com/c2c/w0/buildtest/ServiceApp.java \
  services/build-test-runner-service/src/test/java/com/c2c/w0/buildtest/BuildTestRunnerServiceTest.java \
  services/build-test-runner-service/src/test/java/com/c2c/w0/buildtest/W0SmokeIntegrationTest.java \
  services/evidence-service/go.mod \
  services/evidence-service/main.go \
  services/evidence-service/manifest.go \
  services/evidence-service/server.go \
  services/evidence-service/store.go \
  services/evidence-service/export.go \
  services/evidence-service/events.go \
  services/evidence-service/manifest_test.go \
  services/evidence-service/server_test.go \
  services/evidence-service/Dockerfile \
  services/evidence-service/openapi.yaml \
  services/evidence-service/README.md \
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
    echo "Missing required file: $f" >&2
    exit 1
  fi
done

echo "Validated required platform files."
