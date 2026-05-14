# c2c-bff

W0 backend-for-frontend that brokers c2c-ui calls to the W0 capability mesh
and serves the c2c-ui static bundle on the same origin.

## Responsibility

1. Expose a thin reference-run API under `/api/v0/*` for selecting samples, starting
   migration runs, fetching run status, side-by-side viewing, build/test
   results, and Evidence Pack references.
2. Proxy live calls to `orchestrator-service` and `evidence-service` when
   `C2C_ORCHESTRATOR_URL` and `C2C_EVIDENCE_URL` are set.
3. **Default product mode is fail-closed.** When `C2C_ORCHESTRATOR_URL` is
   not configured the BFF returns `503` from `POST /api/v0/runs` and
   `POST /api/v0/transform`. Product mode never fabricates a successful
   run from local fixtures.
4. Serve the c2c-ui build output under `/` (defaults to
   `../../apps/c2c-ui/dist`).

The UI never talks to capability services directly; everything routes
through this BFF, per Issue #15 acceptance criteria.

## Endpoints

See [`openapi.yaml`](./openapi.yaml). Highlights:

- `GET /api/v0/health` — service health probe.
- `GET /api/v0/mode` — `{ orchestrator: live|mock, evidence: live|mock }`
  reports upstream reachability. `mock` here means "no upstream URL is
  configured"; it is independent of the per-run `mode` and `productMode`
  fields described below.
- `GET /api/v0/samples` and `GET /api/v0/samples/{programId}` — sample
  COBOL registry derived from `fixtures/golden-master/index.json`.
- `POST /api/v0/runs` — start a run for a given `programId`. Returns
  `503` in product mode unless `C2C_ORCHESTRATOR_URL` is set.
- `GET /api/v0/runs/{runId}` — current run status (proxied from
  orchestrator).
- `GET /api/v0/runs/{runId}/generated` — generated-Java view for
  side-by-side display.
- `GET /api/v0/runs/{runId}/build-test` — build/test outcome with
  classification (`match`, `divergence-known-w0-coverage-gap`, etc.).
- `GET /api/v0/runs/{runId}/evidence` — Evidence Pack reference.

Every payload from a run-scoped endpoint includes two mode signals:

- `mode: "live" | "diagnostic-fixture"` — the run's storage mode.
- `productMode: "live" | "unavailable"` — the contract signal that the
  UI uses to decide whether the response is a real product result.
  `productMode` is `"live"` only when the response represents a real
  orchestrated outcome (and, for artifact endpoints, when the orchestrator
  has actually persisted the relevant artifact). Diagnostic-fixture runs
  always report `productMode: "unavailable"`.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `C2C_BFF_PORT` | `8090` | HTTP listen port. |
| `C2C_REPO_ROOT` | walks up from package | Repo root used to locate `corpus/` and `fixtures/`. |
| `C2C_UI_DIST` | `../../apps/c2c-ui/dist` | Static root served under `/`. |
| `C2C_ORCHESTRATOR_URL` | empty | Base URL for `orchestrator-service`. Empty means product mode is not ready. |
| `C2C_EVIDENCE_URL` | empty | Base URL for `evidence-service`. Empty means evidence-service is not reachable; product runs still proceed but artifact endpoints report `productMode: "unavailable"` until upstream payloads land. |
| `C2C_UPSTREAM_TIMEOUT_MS` | `4000` | Per-upstream-request timeout. |
| `C2C_ENABLE_DIAGNOSTIC_FIXTURES` | unset | Developer opt-in. When `true`, `POST /api/v0/runs` produces a `diagnostic-fixture` run (deterministic local content) instead of `503`. The resulting run is never labelled as a product result. Must not be set in W0 browser acceptance flows. |

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

## Product mode vs diagnostic fixtures

- **Product mode** is enabled by setting `C2C_ORCHESTRATOR_URL`. The BFF
  proxies the orchestrator and only returns artifacts that the
  orchestrator has actually persisted. Missing artifacts are reported
  with `status: "incomplete"` and `productMode: "unavailable"`; they are
  never replaced with local placeholders.
- **Diagnostic-fixture mode** is opt-in via
  `C2C_ENABLE_DIAGNOSTIC_FIXTURES=true`. Diagnostic fixtures are
  deterministic, derived from `corpus/synthetic/` and
  `fixtures/golden-master/`, and are clearly labelled with
  `mode: "diagnostic-fixture"` and `productMode: "unavailable"`. The
  fixture module lives under `src/diagnostic-fixtures/` and is imported
  only by `run-store.ts` when a diagnostic-fixture run is created.

The W0 BFF does not retrieve generated Java, build-test output, or
evidence-pack manifests from local files when serving a product run.
Those views always come from the orchestrator's persisted artifacts.

## Safety constraints

- Product mode is fail-closed: missing orchestrator URL or missing
  upstream artifacts surface as `503` or `incomplete`, never as a
  successful placeholder.
- Successful product responses are scanned for the placeholder markers
  shared with the UI (`placeholder-markers.ts`). A match downgrades the
  response to `incomplete` and adds `real-generated-java` to
  `missingArtifacts`.
- No customer source code is uploaded or accepted; only repo-checked-in
  corpus samples are visible.
- All upstream calls have a configurable timeout. On timeout or
  non-2xx response the BFF returns `502`/`incomplete`, never a local
  success.
- The static file server prevents `..` traversal beyond the configured
  static root.
- The BFF has zero runtime dependencies; only `typescript` and
  `@types/node` are dev dependencies.
