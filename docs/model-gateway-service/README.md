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

## Configuration

- Registry: `config/model-registry.example.yaml`
- Allowlist: `config/foundry-development-allowlist-v0.yaml`
- Runtime defaults can be overridden with environment variables:
  - `MODEL_GATEWAY_MODEL_REGISTRY_PATH`
  - `MODEL_GATEWAY_ALLOWLIST_PATH`
  - `MODEL_GATEWAY_LEDGER_PATH`
  - `MODEL_GATEWAY_EVENT_LOG_PATH`
  - `MODEL_GATEWAY_LISTEN_ADDR`
  - `HARNESS_EVENT_URL`

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
