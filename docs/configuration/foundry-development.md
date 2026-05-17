# Foundry Development Configuration

All productive model calls go through `services/go/model-gateway-service`.

## Required Environment

- `MODEL_GATEWAY_MODEL_REGISTRY_PATH=config/model-registry.example.yaml`
- `MODEL_GATEWAY_ALLOWLIST_PATH=config/foundry-development-allowlist-v0.yaml`
- `C2C_MODEL_PROVIDER=azure_foundry`
- `AZURE_FOUNDRY_ENDPOINT`
- `AZURE_FOUNDRY_API_KEY` or `AZURE_FOUNDRY_API_KEY_REF`
- `AZURE_FOUNDRY_API_VERSION=2024-05-01-preview`
- `C2C_MODEL_DEFAULT_DEPLOYMENT=gpt-oss-120b`

Provider credentials must never appear in browser responses, run artifacts,
Harness events, or Evidence Packs.

## Local Smoke

```bash
./scripts/foundry-smoke.sh
```

For the full W0.2 product gate with model traffic:

```bash
./scripts/w0-2-release-gate.sh --foundry
```

## Policy

The allowlist decides which model, role, endpoint, data class, and timeout are
valid. A rejected request must surface as a policy denial, not as success.

The Model Gateway writes model invocation records. Downstream services consume
those records by reference.
