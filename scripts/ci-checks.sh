#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Running repository-level platform bootstrap validation"
./scripts/validate-platform.sh

for lang in go python typescript java; do
  echo "Running $lang checks"
  "./scripts/${lang}-check.sh" || {
    echo "$lang service checks failed"
    exit 1
  }

done

echo "Running security and supply-chain checks"
./scripts/secret-scan.sh
./scripts/license-sbom.sh

echo "CI checks passed."
