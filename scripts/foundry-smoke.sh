#!/usr/bin/env bash
# Foundry smoke test (Issue #168).
#
# Issues a single governed invocation against the local Model Gateway. The
# gateway must be running locally (default: http://localhost:18087) and the
# Foundry credentials must already be exported. The script is intentionally
# excluded from default CI: it requires secrets that public CI cannot hold.
#
# Usage:
#   scripts/foundry-smoke.sh [agentRole] [modelId]
# Defaults:
#   agentRole = transformation
#   modelId   = gpt-oss-120b
#
# Exit codes:
#   0  invocation accepted and provider returned a 2xx with a text payload
#   1  pre-flight failed (missing env, gateway unreachable, role unavailable)
#   2  provider invocation failed
#   3  invocation returned a status other than `completed`

set -euo pipefail

AGENT_ROLE="${1:-transformation}"
MODEL_ID="${2:-gpt-oss-120b}"
GATEWAY_BASE_URL="${MODEL_GATEWAY_BASE_URL:-http://localhost:18087}"

if [[ -z "${AZURE_FOUNDRY_API_KEY:-}" && -z "${AZURE_FOUNDRY_API_KEY_REF:-}" ]]; then
  echo "AZURE_FOUNDRY_API_KEY or AZURE_FOUNDRY_API_KEY_REF must be set" >&2
  exit 1
fi
if [[ -z "${AZURE_FOUNDRY_ENDPOINT:-}" ]]; then
  echo "AZURE_FOUNDRY_ENDPOINT must be set" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

# Capability check first: refuse to send a prompt to an unavailable role.
caps_status="$(curl -fsS "${GATEWAY_BASE_URL}/v0/capabilities" -o /tmp/foundry-smoke-capabilities.json -w '%{http_code}' || true)"
if [[ "${caps_status}" != "200" ]]; then
  echo "model-gateway-service capabilities probe failed (status=${caps_status})" >&2
  exit 1
fi

# Use python3 (already required by the repo) for JSON inspection — avoids a
# jq dependency.
if ! python3 - "${AGENT_ROLE}" "${MODEL_ID}" <<'PY'
import json, sys
role = sys.argv[1]
model = sys.argv[2]
with open("/tmp/foundry-smoke-capabilities.json", "r", encoding="utf-8") as fh:
    payload = json.load(fh)
roles = {entry["role"]: entry for entry in payload.get("roles", [])}
entry = roles.get(role)
if entry is None:
    print(f"role {role!r} is not configured on the gateway", file=sys.stderr)
    sys.exit(1)
if entry.get("status") != "ok":
    print(f"role {role!r} is not available: status={entry.get('status')!r} reason={entry.get('reason')!r}", file=sys.stderr)
    sys.exit(1)
available = entry.get("availableModels") or []
if model not in available:
    print(f"model {model!r} is not on the {role!r} allowlist (available: {available})", file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

# Compose a minimal request. Prompt content is deliberately innocuous and
# carries the agentRole so the gateway applies the role-to-model policy.
request_body=$(cat <<JSON
{
  "schemaVersion": "v0",
  "runId": "foundry-smoke-$(date -u +%Y%m%d%H%M%S)",
  "modelId": "${MODEL_ID}",
  "actor": "scripts/foundry-smoke.sh",
  "agentRole": "${AGENT_ROLE}",
  "dataClass": "model-gateway",
  "promptTemplateVersion": "v1",
  "prompt": "Reply with the single word READY.",
  "structuredOutput": false,
  "parameters": {"temperature": 0, "max_tokens": 8},
  "timeoutMs": 15000
}
JSON
)

response_path="/tmp/foundry-smoke-response.json"
http_status="$(curl -sS \
  -H 'content-type: application/json' \
  -X POST "${GATEWAY_BASE_URL}/v0/invoke" \
  --data "${request_body}" \
  -o "${response_path}" \
  -w '%{http_code}')"

if [[ "${http_status}" != "200" ]]; then
  echo "foundry smoke test failed: gateway returned ${http_status}" >&2
  python3 -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1])), indent=2))' "${response_path}" >&2 || cat "${response_path}" >&2
  exit 2
fi

python3 - "${response_path}" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
status = payload.get("status")
provider = payload.get("provider")
policy = payload.get("policyId")
ledger_ref = payload.get("ledgerRef", {})
print(f"provider={provider} policyId={policy} status={status}")
print(f"ledger uri={ledger_ref.get('uri')} sha256={ledger_ref.get('sha256')}")
if status != "completed":
    print(f"unexpected status {status!r}", file=sys.stderr)
    sys.exit(3)
PY
