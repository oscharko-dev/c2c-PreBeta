#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "🔧 Bootstrapping c2c W0 repository..."

echo "- Python: $(python3 --version 2>/dev/null || true)"
echo "- Go: $(go version 2>/dev/null | head -n1 || true)"
echo "- Node: $(node --version 2>/dev/null || true)"
echo "- Maven: $(mvn -version 2>/dev/null | head -n1 || true)"
echo "- Java: $(java -version 2>&1 | head -n1 || true)"

echo "- Repository health checks"
./scripts/validate-platform.sh

echo "- Service command hints:"
echo "  Java:     ./scripts/java-check.sh"
echo "  Go:       ./scripts/go-check.sh"
echo "  Python:   ./scripts/python-check.sh"
echo "  TypeScript: ./scripts/typescript-check.sh"
echo "  Security/SBOM: ./scripts/license-sbom.sh"

echo "Bootstrap complete."
