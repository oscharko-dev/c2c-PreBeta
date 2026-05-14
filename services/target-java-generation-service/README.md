# target-java-generation-service

W0 capability service that turns a validated Semantic IR v0 document into a
self-contained Java Maven project depending on
[`c2c-target-java-runtime`](../../libs/c2c-target-java-runtime).

The service implements the
[target-generator-contract-v0](../../docs/contracts/target-generator-contract-v0.md):
it validates IR schema version, refuses to emit on blocker assumptions, embeds
runtime coordinates in the generated `pom.xml`, and writes an
`src/main/resources/c2c-trace.json` traceability index keyed by file path to
IR node ids.

## Endpoints

| Method | Path           | Purpose                                       |
|--------|----------------|-----------------------------------------------|
| GET    | `/health`      | Liveness probe                                |
| POST   | `/v0/generate` | Generate a Java project from Semantic IR v0   |

The full contract is in [`openapi.yaml`](openapi.yaml).

## Local build

The service depends on the c2c-target-java-runtime library, so install it first:

```bash
cd libs/c2c-target-java-runtime && mvn -q -DskipTests install
cd ../../services/target-java-generation-service && mvn -q test
```

Or run the repository-wide script that takes care of order:

```bash
./scripts/java-check.sh
```

## Determinism

Generation is deterministic for a given (IR, generator version, runtime
version) tuple:

- The IR's input shape drives every emitted construct.
- File paths and JSON keys use stable ordering.
- No timestamps, UUIDs, or random data leak into the generated project.

The `outputRef` returned by the service is a SHA-256 of the canonical
serialization of the generated files map — identical IR input yields identical
`outputRef`.

## W0 translation coverage

The Java generator emits executable code for the checked-in W0 corpus subset:

- working-storage fields with initial `VALUE` clauses,
- basic `OCCURS` arrays with one-based COBOL subscripts,
- `MOVE`, `DISPLAY`, `COMPUTE`, `ADD`, `SUBTRACT`, `MULTIPLY`, and `DIVIDE`,
- `IF`/`ELSE` relational branches,
- `EVALUATE`/`WHEN` including `WHEN OTHER`,
- `PERFORM UNTIL` and `PERFORM VARYING ... UNTIL` blocks.

Unsupported IR nodes still produce explicit diagnostics and assumption records
instead of placeholders or silent fallback code.

## Harness events

When `HARNESS_EVENT_ENDPOINT` is set, the service POSTs envelope-conformant
events to `<endpoint>/v0/events` with capability `target.java.generate` and one
of these event types:

- `target.java.generate.completed`
- `target.java.generate.failed`
- `target.java.generate.unsupported` (additional event when diagnostics contain
  unsupported IR nodes — emitted alongside the completed/failed terminal event)

Eventing is best-effort: failures to publish do not affect the HTTP response.
