# Model Gateway Service v0

## Purpose

`model-gateway-service` is the single controlled access point for model invocations during development. W0 services must call this service for all model-related operations and must not call model providers directly.

## Endpoints

- `GET /v0/health`
  - Returns service, schema, provider list, configured mode, and active model count.
- `GET /v0/models`
  - Returns all configured models from the registry.
- `GET /v0/models/{id}`
  - Returns registry metadata for a single model.
- `POST /v0/invoke`
  - Executes a model invocation through the configured provider mode.
  - Returns safe invocation metadata, including `provider`,
    `promptTemplateVersion`, `status`, and `ledgerRef`; raw prompts are not
    embedded in the ledger record or evidence manifest.

## Configuration

- Registry: `config/model-registry.example.yaml`
- Allowlist: `config/foundry-development-allowlist-v0.yaml`
- Runtime defaults can be overridden with environment variables:
  - `C2C_MODEL_PROVIDER` (`azure_foundry` or `foundry-development`)
  - `C2C_MODEL_DEFAULT_DEPLOYMENT`
  - `C2C_MODEL_FALLBACK_DEPLOYMENTS`
  - `C2C_MODEL_ALLOWED_DEPLOYMENTS`
  - `C2C_MODEL_DATA_POLICY`
  - `C2C_MODEL_INVOCATION_LEDGER_ENABLED`
  - `C2C_HARNESS_EVENT_EMISSION_ENABLED`
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
    - `MODEL_GATEWAY_PROVIDER`
    - `MODEL_GATEWAY_FOUNDRY_ENDPOINT`
    - `MODEL_GATEWAY_FOUNDRY_API_KEY_REF`
    - `MODEL_GATEWAY_INVOCATION_LEDGER_ENABLED`
    - `MODEL_GATEWAY_HARNESS_EVENT_EMISSION_ENABLED`
  - `HARNESS_EVENT_URL`

## Credential setup

For local development with Azure Foundry:

1. Set `AZURE_FOUNDRY_ENDPOINT` to the Azure endpoint for the resource (for example `https://workspacedevfoundrywnal9xa1.cognitiveservices.azure.com/openai/deployments`).
2. Supply credentials either as a direct key or as a reference:
   - direct key: `AZURE_FOUNDRY_API_KEY`
   - secret reference: `AZURE_FOUNDRY_API_KEY_REF`
3. Keep secrets out of source control. Populate `.env` locally (it is ignored) and keep `.env.example` with placeholders.
4. Optional: you can inspect the key once for setup from Azure CLI (do not commit it):

```bash
az cognitiveservices account keys list \
  --name workspacedevfoundrywnal9xa1 \
  --resource-group rg-workspacedev-foundry-swc-001 \
  --query key1 -o tsv
```

## Policy validation

The `/v0/invoke` endpoint applies:

- model allowlist check
- active model check (`lifecycleStatus`, `licenseStatus`, expiry)
- endpoint-mode consistency
- data class and prompt template validation
- structured-output requirements
- timeout and provider timeout bound checks

## Governance constraint

Direct model endpoint calls from W0 services are forbidden.
All model calls in development mode must be routed through `model-gateway-service` so that:

- invocation metadata is written to the Model Invocation Ledger v0
- Harness Event Envelope v0 records are emitted
- policy decisions can be audited consistently

## Artifacts

- `schemas/model-invocation-ledger-v0.json`
- `schemas/harness-event-envelope-v0.json`
