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

if [ ! -f "docs/platform/w0-artifact-naming.md" ]; then
  echo "Missing docs/platform/w0-artifact-naming.md" >&2
  exit 1
fi

echo "Validated W0 artifact naming docs."

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
  schemas/semantic-ir-v0.json
 do
  if [ ! -f "$f" ]; then
    echo "Missing required file: $f" >&2
    exit 1
  fi
done

echo "Validated required platform files."
