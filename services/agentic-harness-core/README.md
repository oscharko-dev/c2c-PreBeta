# Agentic Harness Core

The `agentic-harness-core` service is the Wave 0 control-plane for tool capability registration, workflow run-state tracking, MCP server inventory, policy hooks, and Harness event emission.

## Run locally

```bash
cd services/agentic-harness-core
go test ./...
go run .
```

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

- Agents must not register or own direct integration capabilities for core infra services (model, evidence, rag, graph, parser, generator, test). Such attempts are denied by default policy.
- Capability and MCP registries are maintained as in-memory stores in W0 for deterministic baseline behavior.
- Run transitions are explicit and stateful for `starting`, `updating`, `completed`, and `failed`.
- Event envelopes are persisted in JSONL (`data/harness-events-v0.jsonl` by default) and include stable `runId`/`stepId`.
- Event envelopes are guaranteed for capability registration, MCP registration, run state changes, and external service ingestion via `POST /v0/events`.
- Local sample ledger output is available as `docs/agentic-harness-core/harness-events-v0.jsonl`.
