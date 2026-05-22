# build-test-runner-service

W0 capability service that turns a generated Java project into a structured
verification result for the c2c Evidence Pack v0.

## Responsibility

1. Materialise a generated project (file map keyed by relative path) into an
   isolated working directory.
2. Compile the project's Java sources in-memory using the `javax.tools`
   `JavaCompiler` API.
3. Execute the generated entry class with captured stdout/stderr through a
   controlled in-process classloader. The runner preserves per-run hashes,
   timeouts, diagnostics, and artifact references, but it is not a
   container-grade isolation boundary.
4. Compare captured stdout to a documented Golden Master output (true
   `GnuCOBOL` execution where it exists, otherwise a clearly labelled
   synthetic fixture) and classify the outcome under a deterministic
   comparison policy that normalizes line endings, trims trailing
   whitespace, compares stderr explicitly, and records exit-code parity.
5. Execute one approved source/reference context for Trust-3 through an
   explicit `reference-fixture` or `native-cobol` mode and return the shared
   parity execution result contract.
6. Emit a Harness Event (`build-test.executed` or `source-reference.*`) and an Experience Event for
   compile failures, run failures, output divergence, and repeated divergence
   patterns. Output is also returned synchronously to the caller.
7. Reference build/test and source/reference outputs by SHA-256 hash so they can be linked from
   the Evidence Pack v0.

The service is intentionally Java-first per the W0 engineering notes; a Go
worker hardening pass is a future-wave concern.

## Endpoints

- `GET /health` — service health probe.
- `POST /v0/run-verification` — accept a request payload (see
  [`openapi.yaml`](./openapi.yaml)) describing the generated project and an
  optional Golden Master hint. Returns the legacy `BuildTestResult` envelope,
  with nested generated-Java `build` and `execution` sections aligned to the
  Trust-2 shared parity contracts
  [`schemas/parity-build-result-v0.json`](../../schemas/parity-build-result-v0.json)
  and
  [`schemas/parity-execution-result-v0.json`](../../schemas/parity-execution-result-v0.json),
  plus compatibility fields that current BFF/orchestrator consumers still
  expect.
- `POST /v0/source-reference/execute` — accept an approved acceptance-fixture
  id plus an explicit `referenceMode` (`reference-fixture` or `native-cobol`).
  Returns the shared parity execution result contract described in
  [`schemas/parity-execution-result-v0.json`](../../schemas/parity-execution-result-v0.json).

All `POST` endpoints require `Authorization: Bearer <BUILD_TEST_RUNNER_CONTROL_TOKEN>`.
The service no longer falls back to loopback-only authorization when the
control token is unset.

## Toolchain requirements

The W0 registry contains at least one true Golden Master. Java verification
therefore requires GnuCOBOL in addition to Maven/JDK:

```bash
cobc --version
cobcrun --version
```

On Ubuntu 24.04 CI this is installed with `apt-get install -y gnucobol3`.

## Safety constraints

- Only the JDK in-process compile and run paths are exercised. No shelling
  out to `mvn`, `javac`, or arbitrary commands inside the verifier.
- Generated programs are run on a dedicated worker thread with a configurable
  wall-clock timeout (default 5 seconds) so a runaway generated loop cannot
  hang the runner.
- File materialisation rejects relative paths that escape the working root
  via `..` segments or absolute paths.
- True Golden Master reproduction is allowed only for checked-in COBOL
  sources under the repository `corpus/` directory. The runner compiles those
  fixtures with `cobc -m`, executes them with `cobcrun`, and treats
  non-reproducible true fixtures as
  `golden-master-reproduction-failed`/`true-golden-master-reproduction-error`
  rather than as a generated-Java divergence or documented W0 synthetic
  coverage gap.

## Inputs

The service accepts either:

- A `generatedProject` field (`{entryClass, entryFilePath, files}`) shaped
  like the response from `target-java-generation-service`, or
- A wrapper `generationResponse` object that the service unwraps to the same
  shape.

A `programId` is required and is used to look up the Golden Master entry from
[`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
unless an inline Golden Master is provided.

For Trust-3 source/reference execution, the service accepts only:

- `fixtureId` from [`fixtures/acceptance/index.json`](../../fixtures/acceptance/index.json)
- explicit `referenceMode`
- optional `executionId`, `workflowId`, and `timeoutMs`

It does not accept arbitrary raw file paths, command lines, or inline COBOL
source for this endpoint.

## Outputs

- `status`: one of `ok`, `compile-failed`, `run-failed`, `output-divergence`,
  `golden-master-reproduction-failed`, `missing-golden-master`, `skipped`.
- `classification`: a coarse evidence classifier — `match`,
  `divergence-known-w0-coverage-gap`, `divergence-unknown`, `compile-error`,
  `run-error`, `true-golden-master-reproduction-error`,
  `true-golden-master-mismatch`, or `skipped-no-execution`.
- `build`: Trust-2 aligned generated-Java build result with `buildId`,
  `buildMode`, content-addressed `buildOutputRef`/`logRef`, structured
  compiler diagnostics, `evidenceRefs`, and compatibility fields such as
  `compileOk`.
- `buildResult`: exact canonical Trust-2 generated-Java build result without
  the legacy compatibility fields.
- `execution`: Trust-2 aligned generated-Java execution result with
  `executionId`, `executionSurface`, content-addressed stdout/stderr/normalized
  output refs, `sourceArtifactRef`/`inputArtifactRef`/`generatedArtifactRef`,
  structured runtime diagnostics, `evidenceRefs`, and compatibility fields
  such as `ran`, `ok`, `stdout`, and `stderr`.
- `executionResult`: exact canonical Trust-2 generated-Java execution result
  without the legacy compatibility fields.
- `comparisonResult`: canonical deterministic parity comparison artifact with
  `comparisonPolicyVersion`, content-addressed refs for source/reference and
  generated Java outputs, a concise `diffSummary`, a machine-readable
  `diffRef`, and deterministic `mismatchClassification`.
- `comparisonResultRef`: content-addressed reference to `comparisonResult`.
- `outputRef`: a hash-stamped reference to the canonical result JSON.

The executable examples are the service tests under `src/test/`; local
verification is `./scripts/java-check.sh` from the repository root.
