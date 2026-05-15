# c2c-bff and c2c-ui

W0 surface for the c2c walking skeleton. Two packages, one reference-run path:

- [`services/c2c-bff`](../../services/c2c-bff) — TypeScript/Node 20 HTTP
  facade that brokers all UI calls to the W0 capability mesh.
- [`apps/c2c-ui`](../../apps/c2c-ui) — TypeScript/vanilla-DOM static
  bundle served by the BFF.

This document is the entrypoint for reviewers, walks through the reference run
flow, and records the open assumptions a reviewer should expect.

## Reference Run flow

1. Open the UI. The header shows whether the BFF is in `mock` or `live`
   mode based on `C2C_ORCHESTRATOR_URL` and `C2C_EVIDENCE_URL`.
2. Pick a sample COBOL program from the picker (registry derived from
   `fixtures/golden-master/index.json`).
3. Click **Start migration run**. The BFF asks the orchestrator (live) or
   produces a deterministic fixture (mock) and the UI shows the run
   `runId`, `status`, and policy decision.
4. Side-by-side: the UI shows the COBOL source and the generated Java
   for the run. Any unsupported features and open assumptions are listed
   under the generated panel — they are not hidden.
5. Build & test: the UI shows expected vs actual stdout, with the
   classification from `build-test-runner-service`; the checked-in W0 samples
   are expected to report `classification: "match"`.
6. Evidence Pack v0: the UI shows the manifest reference and the list
   of missing artifacts.

## Local validation run

For the W0.1 product shell, prefer the repository-level launcher:

```bash
./scripts/start-c2c-local.sh
```

This starts the Nuxt Studio on `http://127.0.0.1:3000` and wires it to the BFF
API on `http://127.0.0.1:18089`.

For BFF-only validation of the legacy `c2c-ui` surface:

```bash
# 1. Build the UI bundle.
(cd apps/c2c-ui && npm install && npm run build)

# 2. Start the BFF. Mock mode is automatic when upstream URLs are unset.
(cd services/c2c-bff && npm install && npm run build && npm run start)

# 3. Open http://localhost:8090
```

Live mode wiring (start the mesh first, then export upstream URLs):

```bash
C2C_ORCHESTRATOR_URL=http://localhost:8084 \
C2C_EVIDENCE_URL=http://localhost:8080 \
  (cd services/c2c-bff && npm run start)
```

## API contract

See [`services/c2c-bff/openapi.yaml`](../../services/c2c-bff/openapi.yaml)
for the canonical schema. The UI consumes only `/api/v0/*` and is not
allowed to bypass it.

## What W0 deliberately does not do

- Customer-data upload paths.
- Full application explorer / graph visualisations.
- Multi-user authentication, RBAC, or audit dashboards.
- A live aggregator that pulls generated-Java back through the BFF — at
  W0 the BFF labels generated-Java as `skipped` when in live mode and
  defers reviewers to `target-java-generation-service`. Mock mode shows
  documented stubs for the three checked-in samples.
- Bundler-based UI; the UI is vanilla TypeScript compiled with `tsc`.

## ADR

See [`docs/adr/0001-c2c-ui-and-bff-w0-architecture.md`](../adr/0001-c2c-ui-and-bff-w0-architecture.md).
