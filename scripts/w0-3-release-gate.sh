#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[w0.3-gate] %s\n' "$*" >&2; }
fail() { printf '[w0.3-gate][error] %s\n' "$*" >&2; exit 1; }

catalog_path() {
  python3 scripts/validate-service-catalog.py --worktree --print-field path --component-id "$1"
}

component_dir() {
  printf '%s/%s\n' "$ROOT_DIR" "$(catalog_path "$1")"
}

ORCHESTRATOR_SERVICE_DIR="$(component_dir orchestrator-service)"
STUDIO_DIR="$(component_dir c2c-studio)"

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "missing required W0.3 gate input: $path"
}

require_file "scripts/w0-2-release-gate.sh"
require_file "scripts/check_w0_2_evidence_test.py"
require_file "$STUDIO_DIR/tests/e2e/w0-3-assist-decision.spec.ts"
require_file "$STUDIO_DIR/tests/components/run/AgentActivityPanel.test.tsx"
require_file "$ORCHESTRATOR_SERVICE_DIR/tests/test_workflow_transformation_agent.py"
require_file "$ORCHESTRATOR_SERVICE_DIR/tests/test_workflow_repair_loop.py"
require_file "$ORCHESTRATOR_SERVICE_DIR/tests/test_workflow_w02_evidence.py"
require_file "$ORCHESTRATOR_SERVICE_DIR/tests/test_w02_contract.py"

for tool in python3 npm npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done

log "orchestrator assist, repair, budget, and evidence semantics"
(
  cd "$ORCHESTRATOR_SERVICE_DIR"
  PYTHONPATH=src python3 -m unittest \
    tests.test_workflow_transformation_agent \
    tests.test_workflow_repair_loop \
    tests.test_workflow_w02_evidence \
    tests.test_w02_contract
)

log "evidence-pack validator rejects missing assist and budget lineage"
python3 -m unittest scripts/check_w0_2_evidence_test.py

log "Studio contract and causal agent-activity rendering"
(
  cd "$STUDIO_DIR"
  npm test -- \
    tests/components/source/SourceWorkspace.test.tsx \
    tests/components/run/AgentActivityPanel.test.tsx \
    tests/apiClient.test.ts \
    tests/productState.test.tsx
)

log "browser acceptance for deterministic-only versus AI-assisted presentation"
(
  cd "$STUDIO_DIR"
  npx playwright test tests/e2e/w0-3-assist-decision.spec.ts
)

log "deterministic product release gate"
C2C_LOCAL_MODEL_GATEWAY_ENABLED=false "$ROOT_DIR/scripts/w0-2-release-gate.sh"

log "W0.3 release gate passed"
