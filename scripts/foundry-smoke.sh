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
GATEWAY_CONTROL_TOKEN="${MODEL_GATEWAY_CONTROL_TOKEN:-${C2C_INTERNAL_CONTROL_TOKEN:-${C2C_LOCAL_INTERNAL_CONTROL_TOKEN:-${C2C_LOCAL_HARNESS_TOKEN:-c2c-local-control-plane-token}}}}"
HARNESS_BASE_URL="${HARNESS_BASE_URL:-${C2C_HARNESS_URL:-}}"
if [[ -z "${HARNESS_BASE_URL}" && -n "${HARNESS_EVENT_URL:-}" ]]; then
  HARNESS_BASE_URL="${HARNESS_EVENT_URL%/v0/events}"
fi
HARNESS_CONTROL_TOKEN="${HARNESS_CONTROL_TOKEN:-${HARNESS_EVENT_TOKEN:-${HARNESS_CONTROL_PLANE_TOKEN:-${C2C_LOCAL_HARNESS_TOKEN:-c2c-local-control-plane-token}}}}"
SMOKE_RUN_ID="${FOUNDRY_SMOKE_RUN_ID:-}"
CREATED_HARNESS_RUN_ID=""
CREATED_HARNESS_RUN_FINALIZED=false

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

create_harness_run() {
  local run_response run_status run_id
  run_response="$(mktemp "${TMPDIR:-/tmp}/foundry-smoke-run.XXXXXX.json")"
  run_status="$(curl -sS \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer ${HARNESS_CONTROL_TOKEN}" \
    -H 'X-Harness-Actor: model-gateway-service' \
    -H 'X-Harness-Role: service' \
    -X POST "${HARNESS_BASE_URL%/}/v0/runs" \
    --data '{"workflowId":"foundry-smoke-v0","requester":"foundry-smoke","evidenceRefs":["urn:c2c/foundry-smoke"]}' \
    -o "${run_response}" \
    -w '%{http_code}' || true)"
  if [[ "${run_status}" != "201" ]]; then
    echo "foundry smoke harness run create failed (status=${run_status})" >&2
    cat "${run_response}" >&2 || true
    rm -f "${run_response}"
    return 1
  fi
  run_id="$(python3 - "${run_response}" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)
print(payload.get("runId", ""))
PY
)"
  rm -f "${run_response}"
  if [[ -z "${run_id}" ]]; then
    echo "foundry smoke harness run create response did not include runId" >&2
    return 1
  fi
  printf '%s\n' "${run_id}"
}

mark_harness_run_terminal() {
  local run_id="$1"
  local terminal_status="$2"
  local terminal_message="$3"
  local run_response run_status
  run_response="$(mktemp "${TMPDIR:-/tmp}/foundry-smoke-run-complete.XXXXXX.json")"
  run_status="$(curl -sS \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer ${HARNESS_CONTROL_TOKEN}" \
    -H 'X-Harness-Actor: model-gateway-service' \
    -H 'X-Harness-Role: service' \
    -X PATCH "${HARNESS_BASE_URL%/}/v0/runs/${run_id}" \
    --data "{\"status\":\"${terminal_status}\",\"message\":\"${terminal_message}\"}" \
    -o "${run_response}" \
    -w '%{http_code}' || true)"
  if [[ "${run_status}" != "200" ]]; then
    echo "foundry smoke harness run finalization failed (status=${run_status})" >&2
    cat "${run_response}" >&2 || true
    rm -f "${run_response}"
    return 1
  fi
  rm -f "${run_response}"
}

finalize_created_harness_run() {
  local exit_code=$?
  if [[ -z "${CREATED_HARNESS_RUN_ID}" || "${CREATED_HARNESS_RUN_FINALIZED}" == "true" ]]; then
    return "${exit_code}"
  fi

  local terminal_status terminal_message
  if [[ "${exit_code}" == "0" ]]; then
    terminal_status="completed"
    terminal_message="foundry smoke completed"
  else
    terminal_status="failed"
    terminal_message="foundry smoke failed"
  fi

  if mark_harness_run_terminal "${CREATED_HARNESS_RUN_ID}" "${terminal_status}" "${terminal_message}"; then
    CREATED_HARNESS_RUN_FINALIZED=true
  elif [[ "${exit_code}" == "0" ]]; then
    return 1
  fi
  return "${exit_code}"
}

trap finalize_created_harness_run EXIT

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

if [[ -z "${SMOKE_RUN_ID}" && -n "${HARNESS_BASE_URL}" ]]; then
  if [[ -z "${HARNESS_CONTROL_TOKEN}" ]]; then
    echo "HARNESS_CONTROL_TOKEN is required when HARNESS_BASE_URL is set" >&2
    exit 1
  fi
  if ! SMOKE_RUN_ID="$(create_harness_run)"; then
    exit 1
  fi
  CREATED_HARNESS_RUN_ID="${SMOKE_RUN_ID}"
fi
if [[ -z "${SMOKE_RUN_ID}" ]]; then
  SMOKE_RUN_ID="foundry-smoke-$(date -u +%Y%m%d%H%M%S)"
fi

# Compose a minimal request. Prompt content is deliberately innocuous and
# carries the agentRole so the gateway applies the role-to-model policy.
request_body=$(cat <<JSON
{
  "runId": "${SMOKE_RUN_ID}",
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
curl_headers=(-H 'content-type: application/json')
if [[ -n "${GATEWAY_CONTROL_TOKEN}" ]]; then
  curl_headers+=(-H "Authorization: Bearer ${GATEWAY_CONTROL_TOKEN}")
fi
http_status="$(curl -sS \
  "${curl_headers[@]}" \
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
