# build-test-runner-service

W0 capability service that turns a generated Java project into a structured
verification result for the c2c Evidence Pack v0.

## Responsibility

1. Materialise a generated project (file map keyed by relative path) into an
   isolated working directory.
2. Compile the project's Java sources in-memory using the `javax.tools`
   `JavaCompiler` API.
3. Execute the generated entry class with a captured stdout/stderr through a
   sandboxed in-process classloader. No `Runtime.exec` of generated code.
4. Compare captured stdout to a documented Golden Master output (true
   `GnuCOBOL` execution where it exists, otherwise a clearly labelled
   synthetic fixture) and classify the outcome.
5. Emit a Harness Event (`build-test.executed`) and an Experience Event for
   compile failures, run failures, output divergence, and repeated divergence
   patterns. Output is also returned synchronously to the caller.
6. Reference build/test outputs by SHA-256 hash so they can be linked from
   the Evidence Pack v0.

The service is intentionally Java-first per the W0 engineering notes; a Go
worker hardening pass is a future-wave concern.

## Endpoints

- `GET /health` — service health probe.
- `POST /v0/run-verification` — accept a request payload (see
  [`openapi.yaml`](./openapi.yaml)) describing the generated project and an
  optional Golden Master hint. Returns a `BuildTestResult` envelope conforming
  to [`schemas/build-test-result-v0.json`](../../schemas/build-test-result-v0.json).

## Safety constraints

- Only the JDK in-process compile and run paths are exercised. No shelling
  out to `mvn`, `javac`, or arbitrary commands inside the verifier.
- Generated programs are run on a dedicated worker thread with a configurable
  wall-clock timeout (default 5 seconds) so a runaway generated loop cannot
  hang the runner.
- File materialisation rejects relative paths that escape the working root
  via `..` segments or absolute paths.
- The optional Golden Master executor for true GnuCOBOL output is gated on a
  detected `cobcrun` binary AND on the source path being inside the
  repository corpus directory; in W0 it is not invoked, all checked-in
  fixtures are documented as synthetic.

## Inputs

The service accepts either:

- A `generatedProject` field (`{entryClass, entryFilePath, files}`) shaped
  like the response from `target-java-generation-service`, or
- A wrapper `generationResponse` object that the service unwraps to the same
  shape.

A `programId` is required and is used to look up the Golden Master entry from
[`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
unless an inline Golden Master is provided.

## Outputs

- `status`: one of `ok`, `compile-failed`, `run-failed`, `output-divergence`,
  `missing-golden-master`, `skipped`.
- `classification`: a coarse evidence classifier — `match`,
  `divergence-known-w0-coverage-gap`, `divergence-unknown`, `compile-error`,
  `run-error`, or `skipped-no-execution`.
- `outputRef`: a hash-stamped reference to the canonical result JSON.

See [`docs/build-test-runner-service/README.md`](../../docs/build-test-runner-service/README.md)
for a worked example and local verification commands.
