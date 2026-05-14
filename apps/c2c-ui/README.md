# c2c-ui

Wave 0 product workbench for c2c. Vanilla TypeScript and DOM. No
framework, no bundler — built with `tsc` and served by `c2c-bff` on the
same origin.

## What the UI shows

The first screen is the workbench:

1. **Header status bar** — product name, product-mode readiness, current
   run status, and the Start button.
2. **Left pane — COBOL source** — editable `<textarea>` workbench. A
   reference-program loader can insert a supported sample into the
   editor; the user can also paste or type COBOL directly.
3. **Right pane — Generated Java** — read-only viewer that shows real
   generator output. Mock placeholder data is not presented as product
   output.
4. **Pipeline progress** — orchestrator-reported run state. Never
   synthesized.
5. **Build & test** — outcome from `build-test-runner-service` with the
   classification (`match`, `divergence-known-w0-coverage-gap`,
   `divergence-unknown`, etc.) and expected vs actual stdout. Mock data
   is labeled as such.
6. **Evidence Pack** — manifest reference assembled by
   `evidence-service`. Missing artifacts are listed explicitly.
7. **Limitations & assumptions** — generator-reported unsupported
   features and open assumptions for the run, shown only for real runs.

Pressing **Start** sends the current editor content to
`POST /api/v0/transform`. The BFF routes the source text through the
orchestrator; the UI polls run status and refreshes the artifact panels
as data arrives. The editor content is never overwritten by polling.

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

## Running the workbench

The simplest path on a fresh checkout, with no other services running:

```bash
# 1. Build the UI bundle
(cd apps/c2c-ui && npm install && npm run build)

# 2. Run the BFF (it will serve the UI; Start stays disabled without an
#    orchestrator because /api/v0/transform requires a live orchestrator)
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
- Disables Start until the BFF reports product mode ready and the editor
  has source content.
- Refuses to present mock fixture data as product output.
- Never invents run state — if the BFF returns nothing, the UI shows
  pending or idle.
- Does not introduce any customer-data upload path in W0; COBOL source
  is sent only when the user presses Start.
