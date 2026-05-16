# Agentic Harness Core

The `agentic-harness-core` service is the Wave 0 Harness infrastructure layer
for tool capability registration, run metadata and state tracking, MCP server
inventory, policy hooks, and Harness event emission.

In W0.2, the Orchestrator controls workflow state, step order, retries,
cancellation, and final classification. The Harness stores shared run context,
events, and ledgers for those orchestrator-driven workflows; it does not
control workflow progression or decide what the agent team does next.

## Run locally

```bash
cd services/agentic-harness-core
export HARNESS_CONTROL_PLANE_TOKEN="local-dev-token"
go test ./...
go run .
```

Mutating endpoints require the control-plane token via `Authorization: Bearer
<token>` or `X-Harness-Token`, plus `X-Harness-Actor` and `X-Harness-Role`
headers. `GET /v0/health`, `GET /v0/ready`, catalog reads, run reads, event
reads, and ledger reads remain unauthenticated for W0 local inspection.

## Endpoints

- `GET /v0/health`
- `GET /v0/ready`
- `GET /v0/capabilities`
- `POST /v0/capabilities`
- `GET /v0/capabilities/{capabilityId}`
- `POST /v0/capabilities/{capabilityId}/validate`
- `GET /v0/mcp-servers`
- `POST /v0/mcp-servers`
- `GET /v0/mcp-servers/{serverId}`
- `GET /v0/runs`
- `POST /v0/runs`
- `GET /v0/runs/{runId}`
- `PATCH /v0/runs/{runId}`
- `GET /v0/events`
- `POST /v0/events`
- `POST /v0/policy/decide`
- `GET /v0/runs/{runId}/ledger`

## Design notes

- Agents must not register or own direct integration capabilities for core infra services (model, evidence, rag, graph, parser, generator, build-test, test, model-gateway). Such attempts are denied by default policy.
- Capability and MCP registries are maintained as in-memory stores in W0 for deterministic baseline behavior.
- Capability and MCP registrations reject duplicate ids; callers must update configuration intentionally rather than overwrite existing records.
- Run transitions are explicit and stateful for `starting`, `updating`, `completed`, and `failed`.
- Event envelopes are persisted in JSONL (`data/harness-events-v0.jsonl` by default) and include stable `runId`/`stepId`.
- Event envelopes are guaranteed for capability registration, MCP registration, run state changes, and authenticated external service ingestion via `POST /v0/events`.
- Local sample ledger output is available as `docs/agentic-harness-core/harness-events-v0.jsonl`.
