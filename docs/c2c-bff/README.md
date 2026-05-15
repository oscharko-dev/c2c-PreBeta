# c2c-bff and c2c Studio

W0/W0.1 surface for the c2c product path. The current product browser
entrypoint is the Next.js c2c Studio; the older `apps/c2c-ui` surface remains a
legacy reference-run surface only.

- [`services/c2c-bff`](../../services/c2c-bff) — TypeScript/Node 20 HTTP
  facade that brokers all UI calls to the W0 capability mesh.
- [`apps/c2c-studio`](../../apps/c2c-studio) — Next.js App Router, React,
  TypeScript, and Tailwind product Studio served locally on port 3000 and
  wired to the BFF.
- [`apps/c2c-ui`](../../apps/c2c-ui) — legacy TypeScript/vanilla-DOM static
  reference surface.

This document is the entrypoint for reviewers, walks through the reference run
flow, and records the open assumptions a reviewer should expect.

## Product Studio flow

1. Start the local stack with `./scripts/start-c2c-local.sh`.
2. Open `http://127.0.0.1:3000`.
3. Load or paste COBOL source in the left editor.
4. Click **Start Transformation**. The Studio calls the BFF, the BFF calls the
   orchestrator, and the orchestrator drives the capability mesh.
5. The generated Java pane renders only active-run generated files retrieved
   from `/api/v0/runs/{runId}/generated/files/{path}`.
6. Build/test, Evidence Pack, artifacts, progress, Harness, Model Gateway, and
   Experience Learning panels show state for the same run.

## Legacy reference surface flow

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

This starts the Next.js Studio on `http://127.0.0.1:3000` and wires it to the BFF
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

## What W0/W0.1 deliberately does not do

- Customer-data upload paths.
- Multi-user authentication, RBAC, or audit dashboards.
- Productive AI-agent transformation. W0/W0.1 are deterministic; W0.2 adds the
  first Harness-governed model-backed agent workflow.
- Browser access to internal services or model credentials. The Studio calls
  only the BFF.

## ADR

See [`docs/adr/0001-c2c-ui-and-bff-w0-architecture.md`](../adr/0001-c2c-ui-and-bff-w0-architecture.md).
