# c2c-bff

W0 backend-for-frontend that brokers c2c-ui calls to the W0 capability mesh
and serves the c2c-ui static bundle on the same origin.

## Responsibility

1. Expose a thin demo API under `/api/v0/*` for selecting samples, starting
   migration runs, fetching run status, side-by-side viewing, build/test
   results, and Evidence Pack references.
2. Proxy live calls to `orchestrator-service` and `evidence-service` when
   `C2C_ORCHESTRATOR_URL` and `C2C_EVIDENCE_URL` are set.
3. Fall back to a documented mock-mode response set when upstream services
   are not configured or unreachable, so a fresh checkout can run the demo
   without standing up the full mesh.
4. Serve the c2c-ui build output under `/` (defaults to
   `../../apps/c2c-ui/dist`).

The UI never talks to capability services directly; everything routes
through this BFF, per Issue #15 acceptance criteria.

## Endpoints

See [`openapi.yaml`](./openapi.yaml). Highlights:

- `GET /api/v0/health` — service health probe.
- `GET /api/v0/mode` — `{ orchestrator: live|mock, evidence: live|mock }`.
- `GET /api/v0/samples` and `GET /api/v0/samples/{programId}` — sample
  COBOL registry derived from `fixtures/golden-master/index.json`.
- `POST /api/v0/runs` — start a run for a given `programId`.
- `GET /api/v0/runs/{runId}` — current run status (proxied from
  orchestrator when live, last-known cache when not).
- `GET /api/v0/runs/{runId}/generated` — generated-Java view for
  side-by-side display.
- `GET /api/v0/runs/{runId}/build-test` — build/test outcome with
  classification (`match`, `divergence-known-w0-coverage-gap`, etc.).
- `GET /api/v0/runs/{runId}/evidence` — Evidence Pack reference.

Every payload from a run-scoped endpoint includes `mode: "live" | "mock"`
so the UI can label content honestly.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `C2C_BFF_PORT` | `8090` | HTTP listen port. |
| `C2C_REPO_ROOT` | walks up from package | Repo root used to locate `corpus/` and `fixtures/`. |
| `C2C_UI_DIST` | `../../apps/c2c-ui/dist` | Static root served under `/`. |
| `C2C_ORCHESTRATOR_URL` | empty (mock) | Base URL for `orchestrator-service`. |
| `C2C_EVIDENCE_URL` | empty (mock) | Base URL for `evidence-service`. |
| `C2C_UPSTREAM_TIMEOUT_MS` | `4000` | Per-upstream-request timeout. |

## Local commands

```bash
cd services/c2c-bff
npm install
npm run lint
npm run test
npm run start
```

`npm run test` compiles with `tsc` and runs `node --test` against the
`dist/` output, matching the `services/typescript/w0-service` convention.

## Mock vs live

- **Mock mode** is automatic when `C2C_ORCHESTRATOR_URL` or
  `C2C_EVIDENCE_URL` is empty or the upstream is unreachable for a given
  request. Mock responses are deterministic, derived from
  `corpus/synthetic/` and `fixtures/golden-master/`, and clearly labelled
  with `mode: "mock"`.
- **Live mode** is enabled by setting the upstream URLs. The BFF then
  POSTs to `/v0/runs` and reads `/v0/runs/{runId}` on the orchestrator,
  and proxies `/v0/packs/{packId}` on evidence-service.

The W0 BFF intentionally does not retrieve generated Java or build-test
output from live services; those views show a skipped marker in live
mode and a documentation pointer instead of fake data. The downstream
services (`target-java-generation-service`, `build-test-runner-service`)
remain the canonical source while a richer aggregator is deferred to a
later wave.

## Safety constraints

- No customer source code is uploaded or accepted; only repo-checked-in
  corpus samples are visible.
- All upstream calls have a configurable timeout and fail-safe to mock.
- The static file server prevents `..` traversal beyond the configured
  static root.
- The BFF has zero runtime dependencies; only `typescript` and
  `@types/node` are dev dependencies.
