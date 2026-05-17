# Model Gateway Service v0

## Purpose

`model-gateway-service` is the single controlled access point for model
invocations during development. W0 and W0.2 services must call this service
for all model-related operations and must not call model providers directly.

## Endpoints

- `GET /v0/health`
  - Returns service, schema, provider list, configured mode, the resolved
    `policyId`, and the active model count.
- `GET /v0/models`
  - Returns all configured models from the registry.
- `GET /v0/models/{id}`
  - Returns registry metadata for a single model.
- `GET /v0/capabilities` (Issue #168)
  - Returns per-role availability for the W0.2 agent roles
    (`transformation`, `verification-repair`) so the Orchestrator can fail
    early with `model_gateway_unavailable` when no approved model is
    reachable for the requested role. Each role entry carries
    `availableModels`, `configuredModels`, `policyId`, and a `status` of
    `ok` or `unavailable`. The top-level `status` is `ok` only when every
    role has at least one available model.
- `POST /v0/invoke`
  - Executes a model invocation through the configured provider mode.
  - Requires `Authorization: Bearer <MODEL_GATEWAY_CONTROL_TOKEN>` (or the
    shared `C2C_INTERNAL_CONTROL_TOKEN`) because this route can spend governed
    model budget.
  - Accepts an optional `agentRole` field. When present the gateway
    enforces the role-to-model policy declared under `roles:` in the
    allowlist YAML; a role-to-model mismatch returns HTTP 403 with
    `errorCode: model_policy_denied`.
  - Successful responses include `policyId`, `agentRole`, `provider`,
    `promptTemplateVersion`, `status`, `usage` (token counts where the
    provider returned them), and `ledgerRef`. Raw prompts are not embedded
    in the ledger record or evidence manifest.

### Error codes

The `/v0/invoke` response (non-2xx) and the ledger entry both carry an
`errorCode` and an `errorClass` so consumers can distinguish failure modes
without parsing free-form error text:

| HTTP status | `errorCode`                | `errorClass`         | Meaning                                                       |
|-------------|----------------------------|----------------------|---------------------------------------------------------------|
| 400         | `malformed_request`        | `validation`         | malformed request (missing fields, bad JSON, etc.)            |
| 403         | `model_policy_denied`      | `validation`         | policy denial (forbidden role/model, inactive model, timeout) |
| 503         | `model_provider_unavailable` | `validation`       | configured provider is not ready                             |
| 502         | `model_provider_error`     | `provider_error`     | upstream model provider rejected the call                     |
| 504         | `model_provider_timeout`   | `provider_timeout`   | upstream model provider exceeded the configured timeout       |

The Orchestrator maps `model_policy_denied` to `FAILURE_MODEL_POLICY_DENIED`
and the gateway-unavailable / provider-error / provider-timeout signals to
`FAILURE_MODEL_GATEWAY_UNAVAILABLE` in the W0.2 run contract.

## Configuration

- Registry: `config/model-registry.example.yaml`
- Allowlist: `config/foundry-development-allowlist-v0.yaml`
- Listen default: `127.0.0.1:8085`; bare ports and `:port` values are
  normalized to loopback unless an explicit host is provided.
- Invocation auth: `/v0/invoke` requires `MODEL_GATEWAY_CONTROL_TOKEN` or
  `C2C_INTERNAL_CONTROL_TOKEN` as a bearer/control token.
- Runtime defaults can be overridden with environment variables:
  - `C2C_MODEL_PROVIDER` (`azure_foundry` or `foundry-development`)
  - `C2C_MODEL_DEFAULT_DEPLOYMENT`
  - `C2C_MODEL_FALLBACK_DEPLOYMENTS`
  - `C2C_MODEL_ALLOWED_DEPLOYMENTS`
  - `C2C_MODEL_DATA_POLICY`
  - `C2C_MODEL_POLICY_ID` (Issue #168; defaults to the allowlist `policyId`
    or `foundry-development-v0`)
  - `C2C_MODEL_INVOCATION_LEDGER_ENABLED`
  - `C2C_HARNESS_EVENT_EMISSION_ENABLED`
  - `HARNESS_EVENT_TOKEN` (required when remote Harness event emission is
    enabled and `HARNESS_EVENT_URL` targets an auth-protected Harness)
  - `AZURE_FOUNDRY_ENDPOINT`
  - `AZURE_FOUNDRY_API_KEY`
  - `AZURE_FOUNDRY_API_KEY_REF`
  - `AZURE_FOUNDRY_API_VERSION`
  - legacy compatibility names:
    - `MODEL_GATEWAY_MODEL_REGISTRY_PATH`
    - `MODEL_GATEWAY_ALLOWLIST_PATH`
    - `MODEL_GATEWAY_LEDGER_PATH`
    - `MODEL_GATEWAY_EVENT_LOG_PATH`
    - `MODEL_GATEWAY_LISTEN_ADDR`
    - `MODEL_GATEWAY_CONTROL_TOKEN`
    - `MODEL_GATEWAY_PROVIDER`
    - `MODEL_GATEWAY_FOUNDRY_ENDPOINT`
    - `MODEL_GATEWAY_FOUNDRY_API_KEY_REF`
    - `MODEL_GATEWAY_INVOCATION_LEDGER_ENABLED`
    - `MODEL_GATEWAY_HARNESS_EVENT_EMISSION_ENABLED`
    - `MODEL_GATEWAY_POLICY_ID`
  - `HARNESS_EVENT_URL`

## Role-to-model policy

The allowlist YAML accepts a `roles:` map that pins each W0.2 agent role to a
strict subset of `allowedModelIds`:

```yaml
mode: "foundry-development"
policyId: "foundry-development-v0"
allowedModelIds: [gpt-oss-120b, mistral-large-3, phi-4, phi-4-mini-instruct]
roles:
  transformation: [gpt-oss-120b, mistral-large-3, phi-4]
  verification-repair: [gpt-oss-120b, mistral-large-3, phi-4-mini-instruct]
```

Constraints enforced at load time:

- every role name must be non-empty
- every role must list at least one model
- every model named in a role must also appear in `allowedModelIds`

A request is rejected with HTTP 403 + `errorCode: model_policy_denied`
when `agentRole` is missing, unknown, or not allowed to use the chosen
`modelId`. Non-agent callers must be represented as explicit configured
roles rather than relying on an implicit bypass.

## Credential setup

For local development with Azure Foundry:

1. Set `AZURE_FOUNDRY_ENDPOINT` to the approved Azure Foundry endpoint for
   your development subscription, for example
   `https://<foundry-resource>.cognitiveservices.azure.com/openai/deployments`.
2. Prefer a secret reference via `AZURE_FOUNDRY_API_KEY_REF`. Use
   `AZURE_FOUNDRY_API_KEY` only in a local shell that cannot resolve the
   reference.
3. Keep secrets out of source control. Populate `.env` locally (it is
   ignored) and keep `.env.example` with placeholders.
The Foundry adapter sends the key as the `api-key` header when
`AZURE_FOUNDRY_API_KEY` is set, otherwise it sends the value of
`AZURE_FOUNDRY_API_KEY_REF` as `x-api-key-ref` and expects the secret to be
resolved provider-side. The Foundry endpoint is the only place that ever
holds a raw key in this code path.

See [`docs/configuration/foundry-development.md`](../configuration/foundry-development.md)
for a step-by-step local setup walk-through.

## Policy validation

The `/v0/invoke` endpoint applies:

- model allowlist check
- active model check (`lifecycleStatus`, `licenseStatus`, expiry)
- role-to-model check (Issue #168) when `agentRole` is present
- endpoint-mode consistency
- data class and prompt template validation
- structured-output requirements
- timeout and provider timeout bound checks

## Governance constraint

Direct model endpoint calls from W0 and W0.2 services are forbidden. All
model calls in development mode must be routed through
`model-gateway-service` so that:

- invocation metadata is written to the Model Invocation Ledger v0,
  including `policyId`, `agentRole`, and provider-reported token usage
  where available
- Harness Event Envelope v0 records are emitted with the policy decision
- policy decisions can be audited consistently

`scripts/check_model_governance.py` scans the repository for direct
provider imports and HTTP calls; CI runs it on every PR to `dev`.

## Optional Foundry smoke test

`scripts/foundry-smoke.sh` exercises a real Foundry deployment end-to-end.
It is intentionally not part of the default CI pipeline because it requires
secrets. Run it locally after setting `AZURE_FOUNDRY_API_KEY` and
`AZURE_FOUNDRY_ENDPOINT` to verify that the configured policy actually
reaches a productive model.

## Artifacts

- `schemas/model-invocation-ledger-v0.json`
- `schemas/harness-event-envelope-v0.json`
- `schemas/model-gateway-capabilities-v0.json`
