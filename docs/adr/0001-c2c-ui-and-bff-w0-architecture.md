# ADR 0001: c2c-ui and c2c-bff for the W0 demo surface

**Date**: 2026-05-14
**Status**: Accepted

## Context

Issue #15 (`[W0-13] Build c2c-ui and c2c-bff v0 for the first end-to-end
demo`) requires a user-facing surface for the walking skeleton. An expert
demoing the harness needs to:

- Pick a sample COBOL program from the W0 corpus.
- Run the migration pipeline through the orchestrator (not by calling
  capability services directly).
- See the COBOL source and generated Java side-by-side.
- See the harness-reported run status, build/test outcome, and Evidence
  Pack v0 export.
- See unsupported features and known divergences clearly, instead of a
  marketing-style happy path.

The repository is intentionally restrained at W0. No bundler, no SPA
framework, no design system, no auth. Other W0 services in this repo follow a
"zero runtime deps, stdlib HTTP, `node --test`" rhythm
(`services/typescript/w0-service`, `services/agentic-harness-core`).

## Decision

We introduce two new packages:

1. **`services/c2c-bff/`** — TypeScript, Node 20, zero runtime dependencies.
   A small HTTP facade that:

   - Serves the c2c-ui static bundle under `/` and the demo API under
     `/api/v0/*`.
   - Brokers all calls to upstream capability services
     (`orchestrator-service`, `evidence-service`,
     `build-test-runner-service`, `target-java-generation-service`,
     `cobol-parser-service`, `semantic-ir-service`,
     `agentic-harness-core`). The UI never calls these directly.
   - Falls back to a documented mock mode when upstream services are
     unreachable, so a developer can run the demo on a fresh checkout
     without standing up the full mesh. Mock responses are labelled
     `mode: "mock"` on every payload.

2. **`apps/c2c-ui/`** — TypeScript SPA built with `tsc` only. Vanilla DOM,
   no framework, no bundler. The UI consumes `/api/v0/*` and is served as
   static files by the BFF.

The BFF API is documented in `services/c2c-bff/openapi.yaml`.

## Rationale

- **Why a BFF rather than direct UI-to-service calls?** Issue #15 acceptance
  criterion says the UI must not bypass the Harness architecture. A BFF lets
  us route everything through the orchestrator and the harness ledger, and
  keeps service URLs out of the browser.
- **Why TypeScript on both sides?** Existing TS service skeleton
  (`services/typescript/w0-service`) plus the issue specifying
  TypeScript/Node 20 on the BFF option. Shared type shapes can later be
  factored into a shared workspace; W0 keeps them duplicated to stay
  restrained.
- **Why zero runtime deps?** Matches the rest of W0. Avoids SBOM noise and
  supply-chain surface area for a demo surface. `tsc` is a build-time only
  devDependency.
- **Why no React/Vite/bundler?** Engineering Notes in the issue: "Keep the
  UI functional and restrained. This is a tool surface, not a marketing
  page." A bundler stack would also expand the SBOM/licence surface.
- **Why mock mode?** The issue accepts "local services OR documented mocks"
  as the demo path. Mock mode is explicit, labelled, and only kicks in when
  the upstream URL is empty or unreachable — never silently in front of a
  working service.

## Consequences

- A reviewer can run the demo with `npm install && npm run start` inside
  `services/c2c-bff/` against a fresh checkout, with no other services up.
- A reviewer running the full mesh will see real orchestrator/evidence
  responses via the same UI, because the BFF proxies live when reachable.
- Future waves can swap the vanilla UI for a React/SSR stack without
  changing the BFF contract.
- `scripts/typescript-check.sh` is generalised to discover every TS
  package under `services/` and `apps/`, so CI keeps validating new TS
  packages automatically.
- Generated Java visibility at W0 is partial; the W0 generator does not
  yet translate `PERFORM`/`EVALUATE`/`COMPUTE`. The UI is required to mark
  this honestly (`unsupported`, `known-divergence`) rather than mask it.

## References

- Issue #15 ([W0-13] Build c2c-ui and c2c-bff v0 for the first end-to-end demo)
- Issue #14 (Evidence Pack v0)
- Issue #13 (build-test-runner v0)
- `docs/governance/development-workflow.md`
- `services/orchestrator-service/openapi.yaml`
- `services/evidence-service/openapi.yaml`
- `services/build-test-runner-service/openapi.yaml`
- `fixtures/golden-master/index.json`
