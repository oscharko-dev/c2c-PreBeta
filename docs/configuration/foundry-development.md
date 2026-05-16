# Foundry-backed development setup for W0.2

This guide walks a developer through the configuration that the W0.2 wave
expects when running the local stack. The Model Gateway is the only path
through which W0.2 services may reach a model; this document shows how to
wire it up against Microsoft Foundry without leaking secrets and without
adding direct provider calls anywhere else.

The customer-internal provider shape uses the same gateway contract — when
later environments swap Foundry for an internal model service the
allowlist YAML and a handful of environment variables change, but no
runtime code does. The shape is reused intentionally.

## Prerequisites

1. The repository bootstrap has run (`./scripts/bootstrap.sh`).
2. `.env` exists locally (copy `.env.example` and fill in values).
3. A Foundry resource is reachable from the developer workstation.

## Step 1 — Pick the policy id

The policy id is recorded on every Model Invocation Ledger entry, every
Harness Event Envelope emitted by the gateway, and is exposed on
`GET /v0/health` and `GET /v0/capabilities`. The default for W0.2 is
`foundry-development-v0`. Override it only when a different policy version
is rolled out.

```env
C2C_MODEL_POLICY_ID=foundry-development-v0
```

The same value appears in `config/foundry-development-allowlist-v0.yaml`
under the top-level `policyId` key. The env var wins when set; otherwise
the YAML value is used; otherwise the gateway falls back to the built-in
default.

## Step 2 — Configure the Foundry endpoint

```env
AZURE_FOUNDRY_ENDPOINT=https://<workspace>.cognitiveservices.azure.com/openai/deployments
AZURE_FOUNDRY_API_VERSION=2024-05-01-preview
# Prefer the reference path. Use the direct key only for local shells that
# cannot resolve the reference.
AZURE_FOUNDRY_API_KEY_REF=keyring/foundry/API_KEY
AZURE_FOUNDRY_API_KEY=         # optional local fallback; never commit
```

`.env.example` lists the canonical key names. Never commit a populated
`.env`; the secret-scan pre-commit hook will block staging files that look
like credentials.

## Step 3 — Pick allowed deployments and the data policy

The allowlist YAML at `config/foundry-development-allowlist-v0.yaml`
declares the canonical set of approved models. The runtime can further
restrict that list through env vars:

```env
C2C_MODEL_PROVIDER=azure_foundry
C2C_MODEL_DEFAULT_DEPLOYMENT=gpt-oss-120b
C2C_MODEL_ALLOWED_DEPLOYMENTS=gpt-oss-120b,mistral-large-3,phi-4,phi-4-mini-instruct
C2C_MODEL_FALLBACK_DEPLOYMENTS=mistral-large-3,phi-4
C2C_MODEL_DATA_POLICY=public_synthetic_only
```

The data policy controls which classes of payloads the gateway will accept
on `/v0/invoke`. `public_synthetic_only` blocks anything that smells like
production data and is the only supported value during W0.2.

## Step 4 — Pin agent roles to specific models

The allowlist YAML accepts a `roles:` block. Each role lists the subset of
`allowedModelIds` that the role is permitted to invoke; a role with no
entries blocks every model. The shipped allowlist pins the W0.2 roles like
this:

```yaml
roles:
  transformation:
    - gpt-oss-120b
    - mistral-large-3
    - phi-4
  verification-repair:
    - gpt-oss-120b
    - mistral-large-3
    - phi-4-mini-instruct
```

When the Orchestrator invokes the gateway it stamps the request with
`agentRole: "transformation"` (and, in a productive W0.2 run, the
verification/repair agent stamps `agentRole: "verification-repair"`). The
gateway enforces the role-to-model mapping at validation time and rejects
mismatches with HTTP 403 + `errorCode: model_policy_denied`.

## Step 5 — Verify the gateway is reachable

Start the local stack (`make dev-check`), then probe the gateway:

```bash
curl -s http://localhost:18087/v0/health | jq .
curl -s http://localhost:18087/v0/capabilities | jq .
```

The capabilities endpoint must list every W0.2 role with `status: "ok"`
and at least one entry in `availableModels`. If a role reports
`status: "unavailable"`, fix the allowlist or the registry before running
a productive transformation — the Orchestrator otherwise fails the run
with `model_gateway_unavailable`.

## Step 6 — Optional Foundry smoke test

`scripts/foundry-smoke.sh` issues a single governed invocation against the
configured deployment. It is intentionally excluded from the default CI
pipeline. Run it locally when you want to verify that the configured
policy reaches a productive model:

```bash
AZURE_FOUNDRY_API_KEY=... AZURE_FOUNDRY_ENDPOINT=... \
  scripts/foundry-smoke.sh transformation gpt-oss-120b
```

The script exits non-zero when the gateway is unreachable, when the
configured model is not on the role allowlist, or when the upstream
provider returns a non-2xx status.

## What never appears in tracked files

- raw API keys (only placeholders, key references, or empty values)
- raw prompts, raw completions, or any source COBOL content (only
  content-addressed references)
- customer environment URLs or production endpoints (a placeholder
  workspace URL is the only domain in `config/`)

The pre-commit hook (`./scripts/setup-git-hooks.sh`) and CI's
`secret-scan.yml` workflow enforce this. The governance scanner
(`scripts/check_model_governance.py`) additionally guarantees that no
service code imports a model SDK or calls a model provider directly.
