# c2c-bff

W0 backend-for-frontend that brokers Studio calls to the W0 capability mesh.

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
4. Optionally serve a static bundle under `/` when `C2C_UI_DIST` is set;
   when the directory does not exist the BFF simply skips the static
   route (no error). This path is unused in the current Studio-only setup.

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
- `GET /api/v0/acceptance-fixtures` and
  `GET /api/v0/acceptance-fixtures/{fixtureId}` — W0.2 acceptance fixture
  and oracle contract from `fixtures/acceptance/index.json`.
- `POST /api/v0/transform` — product-mode source submission. Accepts
  `sourceText`, optional `expectedOutput` and `oracleInput`, and forwards
  to the orchestrator when `C2C_ORCHESTRATOR_URL` is configured.
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

| Env var                          | Default                  | Purpose                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C2C_BFF_PORT`                   | `8090`                   | HTTP listen port.                                                                                                                                                                                                                               |
| `C2C_BFF_HOST`                   | `127.0.0.1`              | HTTP listen host. Defaults to loopback; set explicitly (for example `0.0.0.0`) only behind network controls and authenticated routes.                                                                                                           |
| `C2C_REPO_ROOT`                  | walks up from package    | Repo root used to locate `corpus/` and `fixtures/`.                                                                                                                                                                                             |
| `C2C_UI_DIST`                    | `../../apps/c2c-ui/dist` | Optional static root served under `/`. Unused in the current Studio-only setup; the BFF silently skips static routing when the directory is missing.                                                                                            |
| `C2C_ORCHESTRATOR_URL`           | empty                    | Base URL for `orchestrator-service`. Empty means product mode is not ready.                                                                                                                                                                     |
| `C2C_ORCHESTRATOR_CONTROL_TOKEN` | empty                    | Bearer/control token for orchestrator live-mode calls. Required whenever `C2C_ORCHESTRATOR_URL` is set.                                                                                                                                         |
| `C2C_EVIDENCE_URL`               | empty                    | Base URL for `evidence-service`. Empty means evidence-service is not reachable; product runs still proceed but artifact endpoints report `productMode: "unavailable"` until upstream payloads land.                                             |
| `C2C_UPSTREAM_TIMEOUT_MS`        | `4000`                   | Per-upstream-request timeout.                                                                                                                                                                                                                   |
| `C2C_STUDIO_CORS_ORIGINS`        | `http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000` | Comma-separated exact Studio browser origins allowed to make credentialed split-server requests. Do not use wildcard localhost origins for cookie-backed routes. |
| `C2C_EDITOR_ASSIST_LEDGER_PATH`  | `var/c2c-local/trajectory-ledger/editor-assist.jsonl` | Append-only JSONL sink for `kind=editor_assist` ledger entries produced by `/api/v0/editor/explain`; overrides must resolve inside `C2C_REPO_ROOT`, and symlinked parent directories, symlink targets, or special-file targets are rejected. |
| `C2C_ENABLE_DIAGNOSTIC_FIXTURES` | unset                    | Developer opt-in. When `true`, `POST /api/v0/runs` produces a `diagnostic-fixture` run (deterministic local content) instead of `503`. The resulting run is never labelled as a product result. Must not be set in W0 browser acceptance flows. |

Editor-assist endpoints require the `c2c.sid` session cookie. The BFF derives
`tenantId` and `userId` from the server-side session record for budget and
ledger attribution; request body or query identity fields are treated only as
legacy echoes and must match the active session.

Java editor execution-adjacent routes (`/api/v0/format/java`,
`/api/v0/compile-check`, and `/api/v0/verify`) also require the session cookie,
an allowed Studio browser origin when `Origin` is present, and
`Content-Type: application/json` before request bodies are parsed or upstream
build/test services are invoked.

## Local commands

```bash
cd services/c2c-bff
npm install
npm run lint
npm run test
npm run start
```

`npm run test` compiles with `tsc` and runs `node --test` against the
`dist/` output, matching the `services/reference/w0-service-typescript` convention.

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
  Shared ownership rules for these fixture sources are documented in
  [`docs/governance/fixture-ownership.md`](../../docs/governance/fixture-ownership.md).

The W0 BFF does not retrieve generated Java, build-test output, or
evidence-pack manifests from local files when serving a product run.
Those views always come from the orchestrator's persisted artifacts.

## Safety constraints

- Product mode is fail-closed: missing orchestrator URL or missing
  upstream artifacts surface as `503` or `incomplete`, never as a
  successful placeholder.
- Successful product responses are scanned for the placeholder markers
  defined in `placeholder-markers.ts`. A match downgrades the response
  to `incomplete` and adds `real-generated-java` to `missingArtifacts`.
- Source submissions are accepted only through `POST /api/v0/transform`
  and are forwarded to the configured orchestrator. When the orchestrator
  is not configured, product mode fails closed instead of storing or
  fabricating a successful run locally.
- All upstream calls have a configurable timeout. On timeout or
  non-2xx response the BFF returns `502`/`incomplete`, never a local
  success.
- The static file server prevents `..` traversal beyond the configured
  static root.
- The BFF has zero runtime dependencies; only `typescript` and
  `@types/node` are dev dependencies.
