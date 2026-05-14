# c2c-ui

W0 expert-facing UI for the c2c walking skeleton. Vanilla TypeScript and
DOM. No framework, no bundler — built with `tsc` and served by `c2c-bff`
on the same origin.

## What the UI shows

1. **Sample picker** — W0 COBOL samples surfaced by the BFF from the repo
   corpus.
2. **Harness run status** — orchestrator-reported state, never faked. The
   `mode` badge in the header indicates whether the BFF is talking to
   live upstream services or returning documented mock fixtures.
3. **COBOL ↔ generated Java** — side-by-side view. Unsupported W0
   features and open assumptions are listed under the generated panel so
   they cannot be hidden by an over-polished demo.
4. **Build & test** — outcome from `build-test-runner-service` with the
   classification (`match`, `divergence-known-w0-coverage-gap`,
   `divergence-unknown`, etc.) and expected vs actual stdout.
5. **Evidence Pack v0** — manifest reference assembled by
   `evidence-service`. Missing artifacts are listed explicitly.

The UI never calls model, parser, generator, build/test or evidence
services directly. Every call goes through `/api/v0/*` on the BFF.

## Local commands

```bash
cd apps/c2c-ui
npm install
npm run lint
npm run test
npm run build
```

`npm run build` emits the static bundle to `dist/`. The BFF
(`services/c2c-bff`) serves that directory under `/` by default.

## Running the demo

The simplest path on a fresh checkout, with no other services running:

```bash
# 1. Build the UI bundle
(cd apps/c2c-ui && npm install && npm run build)

# 2. Run the BFF (it will serve the UI and use mock mode)
(cd services/c2c-bff && npm install && npm run build && npm run start)

# 3. Open http://localhost:8090
```

With the full mesh available, set upstream URLs on the BFF:

```bash
C2C_ORCHESTRATOR_URL=http://localhost:8084 \
C2C_EVIDENCE_URL=http://localhost:8080 \
  (cd services/c2c-bff && npm run start)
```

## Restraint posture

This is a tool surface, not a marketing page. The UI:

- Uses semantic HTML and a small CSS file. No design-system dependency.
- Labels every code panel as W0 stub or live output.
- Never invents run state — if the BFF returns nothing, the UI shows
  idle.
- Does not introduce any customer-data upload path in W0.
