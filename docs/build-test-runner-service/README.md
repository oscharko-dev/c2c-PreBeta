# build-test-runner-service

Wave 0 capability service that turns generator output into structured build,
run, and Golden Master verification evidence for the c2c Evidence Pack v0.

## Why this service exists

The W0 walking skeleton claims that c2c is evidence-first: generated Java is
not "successful" until it compiles and runs, and its output is compared
against an oracle. Without a runner, every other service in the W0 pipeline
is producing artifacts no machine has actually executed. This service closes
the loop.

## What it does

For one verification request:

1. **Materialise** the generated project (file map keyed by relative path)
   into a per-request temp directory. Path safety is enforced so that
   absolute paths and `..` traversal cannot escape the working root.
2. **Compile** all `.java` sources with the in-process `javax.tools`
   `JavaCompiler` API — no `javac` or `mvn` subprocess.
3. **Run** the entry class on a daemon worker thread with a wall-clock
   timeout (default 5 s). Stdout and stderr are captured.
4. **Resolve** a Golden Master fixture for the program (inline in the
   request, by `expectedRef.path`, or via the
   [`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
   registry).
5. **Compare** captured stdout to the expected output (CRLF→LF + trim),
   classify the outcome, and emit a Harness `build-test.executed` event plus
   an Experience event for every non-`ok` outcome.
6. **Hash** the canonical result JSON and return an `outputRef` with the
   SHA-256 so downstream Evidence Pack v0 records can pin the result by hash.

## Local verification commands

The recommended invocation from the repository root, mirroring CI:

```bash
# Install the runtime + generator into the local Maven repo (one-time per
# checkout; the bundled scripts do this automatically).
(cd libs/c2c-target-java-runtime && mvn -q -DskipTests install)
(cd services/target-java-generation-service && mvn -q -DskipTests install)

# Required for entries with classification "true".
cobc --version
cobcrun --version

# Build + test build-test-runner-service. This runs the W0 smoke
# integration test that drives all three corpus programs end-to-end.
(cd services/build-test-runner-service && mvn -q test)

# Or, run all Java service checks (this is what CI invokes):
./scripts/java-check.sh
```

To exercise just the smoke integration:

```bash
(cd services/build-test-runner-service \
  && mvn -q -Dtest=W0SmokeIntegrationTest test)
```

To run the service locally and POST a verification request:

```bash
(cd services/build-test-runner-service && mvn -q package)
java -jar services/build-test-runner-service/target/build-test-runner-service-0.1.0.jar
# in another shell:
curl -s -X POST http://localhost:8084/v0/run-verification \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "runId": "run-local-1",
  "programId": "BRNCH01",
  "generatedProject": {
    "entryClass": "c2c.generated.brnch01.Brnch01",
    "entryFilePath": "src/main/java/c2c/generated/brnch01/Brnch01.java",
    "files": {
      "src/main/java/c2c/generated/brnch01/Brnch01.java": "..."
    }
  }
}
JSON
```

## Result envelope

The response conforms to
[`schemas/build-test-result-v0.json`](../../schemas/build-test-result-v0.json).

- `status` — `ok`, `compile-failed`, `run-failed`, `output-divergence`,
  `golden-master-reproduction-failed`, `missing-golden-master`, or
  `skipped`.
- `classification` — `match`, `divergence-known-w0-coverage-gap`,
  `divergence-unknown`, `true-golden-master-reproduction-error`,
  `true-golden-master-mismatch`, `compile-error`, `run-error`,
  `skipped-no-execution`, or `missing-golden-master`.
- `build` — javac diagnostics and source/file counts.
- `execution` — captured stdout, stderr, duration, and `stdoutSha256`.
- `goldenMaster` — the resolved fixture's expected text, classification
  (`true` vs `synthetic`), expected-output source path, COBOL source path,
  `expectedSha256`, `knownDivergenceAtW0`, and, for true fixtures, the
  `cobolRuntime` reproduction result.
- `comparison` — `matched`, `actualSha256`, `expectedSha256`, plus a brief
  diff summary when divergent.
- `outputRef` — canonical `urn:` URI + SHA-256 + byte size; this is the
  hash referenced from Evidence Pack v0 records.

## Golden Master fixture conventions

The W0 registry at `fixtures/golden-master/index.json` declares one entry per
program, each with:

- `programId` — must match the COBOL `PROGRAM-ID`.
- `cobolSource` — repo-relative path of the source COBOL program.
- `expectedOutputPath` — repo-relative path of the expected stdout fixture.
  Path safety is enforced; absolute paths and `..` traversal are rejected.
- `classification` — `synthetic` for hand-curated expected output, `true`
  for output produced by a COBOL runtime such as GnuCOBOL `cobcrun`.
- `knownDivergenceAtW0` — `true` only when a fixture is intentionally expected
  to diverge from generated Java. The runner uses this to classify documented
  divergences as `divergence-known-w0-coverage-gap` rather than
  `divergence-unknown`.
- `rationale` — human prose explaining the classification choice.

`BRNCH01` is the first W0 entry classified as `true`. The runner recompiles
`corpus/synthetic/programs/branch-account-guard.cbl` with `cobc -m`, executes
the resulting module with `cobcrun BRNCH01`, and requires byte-equal stdout
against `corpus/synthetic/fixtures/branch-account-guard-output.txt` before it
accepts the fixture as a valid oracle. The remaining W0 entries stay
`synthetic` and `knownDivergenceAtW0=false` because generated Java matches the
checked-in fixtures but their expected output has not yet been promoted to a
COBOL-runtime-produced Golden Master.

## Safety constraints

- The verifier never spawns `mvn`, `javac`, or any other subprocess for the
  generated code. Compilation uses `javax.tools.JavaCompiler`; execution
  uses an isolated `URLClassLoader` against the temp class output directory.
- Generated programs run on a dedicated daemon thread with a wall-clock
  timeout. A runaway loop is interrupted; if the thread refuses to stop the
  cancelled task is abandoned and the runner returns `errorClass=timeout`.
- Materialised file paths are validated against the working root; absolute
  paths, `..` traversal, and backslashes are rejected before any bytes hit
  disk.
- Golden Master path resolution rejects paths that escape the repository
  root.
- GnuCOBOL re-execution is gated on detected `cobc`/`cobcrun` binaries and on
  the COBOL source path being inside the corpus directory. A true fixture that
  cannot be compiled, run, or matched is classified as
  `golden-master-reproduction-failed`, separate from generated-Java output
  divergences and documented synthetic W0 gaps.

## Relationship to other W0 services

- Consumes the `generatedProject` shape produced by
  [target-java-generation-service](../../services/target-java-generation-service/README.md).
- Emits `build-test.executed` Harness Events conforming to the existing
  envelope schema. The `dataClass` is `build-test`, mirroring the sample
  event in [`docs/agentic-harness-core/harness-events-v0.jsonl`](../agentic-harness-core/harness-events-v0.jsonl).
- Emits Experience Events for non-`ok` outcomes, fingerprinted by
  `(classification, programId)` so the
  [experience-learning-service](../../services/experience-learning-service/)
  can detect repeated patterns.
