# Target Generator Contract v0

**Status**: Accepted (W0)
**Applies to**: any target-language generator that consumes Semantic IR v0
**Issue**: [#11](https://github.com/oscharko-dev/c2c-PreBeta/issues/11)

## Purpose

This contract defines what every c2c target-language generator must accept as
input and what it must produce. It exists so that:

1. The W0 Java generator cannot become a one-off path that prevents adding
   Rust, Go, Python, or other targets later.
2. Generated code is auditable: every emitted construct is traceable back to a
   Semantic IR node or transformation pass.
3. The runtime that generated code depends on is versioned and discoverable
   instead of being silently coupled to whichever runtime happens to ship.

The contract is intentionally minimal. Anything not specified here is left to
each generator implementation, but the requirements below are mandatory.

## Input

### IR Version

- A generator MUST declare which IR schema versions it accepts.
- W0 generators MUST accept Semantic IR v0 (`schemas/semantic-ir-v0.json`).
- A generator MUST refuse to run against an IR whose `schemaVersion` it does
  not list as supported. Silent best-effort transformation is forbidden.

### IR Validation

- Before emitting code, a generator MUST validate the input IR against the
  declared schema. Validation failures MUST produce explicit diagnostics that
  reference the offending IR node id (or the missing required field).
- A generator MUST refuse to emit code if the IR contains
  `assumptions[]` entries with `severity == "blocker"`.

## Runtime Dependency

### Pinned Runtime

- A generator MUST emit code that depends on exactly one target runtime
  artifact, identified by `(name, version, contract version, ir version)`.
- For the Java target, the runtime is `c2c-target-java-runtime` and the
  current pinned version is `0.1.0`. The runtime exposes its identity via
  `com.c2c.target.java.runtime.RuntimeMetadata` and via jar manifest
  attributes `C2c-Runtime-Name`, `C2c-Runtime-Version`, `C2c-Contract-Version`,
  `C2c-Ir-Version`.
- A generator MUST NOT inline runtime semantics into generated code as a way
  to avoid declaring the dependency.

### Runtime Surface (W0 minimum)

A target runtime that wants to be conformant for W0 MUST provide at least:

- A fixed-point decimal type with declared scale, signed flag, non-mutating
  arithmetic that widens to `max(scale)`, and `HALF_EVEN` rounding on division
  and rescale (W0 corpus is `PIC S9(n)V9(s)` and integer-like numerics).
- A field type that pairs an IR node id with a frozen `PIC` clause and
  enforces overflow / category rules on assignment.
- Class- and relational-condition helpers that map one IR `IF`/`EVALUATE`
  branch test to one boolean expression, with no implicit type coercion
  beyond what the IR records.
- An assumption registry that records open semantic assumptions emitted by
  the generator, keyed back to the IR `assumptions[]` array.

The Java reference implementation lives in
[`libs/c2c-target-java-runtime`](../../libs/c2c-target-java-runtime).

## Output

### Project Structure

A generator MUST emit a self-contained project that, at minimum:

- builds without network access to the c2c repository (the runtime is the only
  c2c dependency),
- runs the W0 golden-master fixtures it claims to support, and
- exposes a way to read the assumption registry alongside output.

For the Java target the generated project is a Maven module with the
following layout:

```
<generated-project>/
  pom.xml                          # depends on c2c-target-java-runtime:<version>
  src/main/java/...                # generated translation units
  src/main/resources/c2c-trace.json # IR traceability index (see below)
  src/test/java/...                # generated golden-master tests, if any
```

Other targets MAY use a different layout, but MUST keep:

- A single declared dependency on the pinned runtime.
- An on-disk traceability index in a structured format (JSON or equivalent).

### Traceability Requirements

For every emitted translation unit (Java class, Rust module, Python file,
etc.) the generator MUST be able to answer the question
"which IR node produced this code?".

The minimum traceability surface is:

| Generated artifact      | Required reference                                  |
|-------------------------|-----------------------------------------------------|
| Translation unit file   | `programId`, `irId`, `sourceHash`                   |
| Statement / expression  | `statement.id` from the IR                          |
| Working-storage field   | `fieldLayout.id` from the IR (e.g. via constructor) |
| Control-flow branch     | `controlFlow.id` from the IR                        |

Generators MUST emit at least one of:

- An on-disk `c2c-trace.json` keyed by file path → list of IR node ids, or
- Per-line annotations in source comments referencing IR ids.

For the Java target, both are recommended; `c2c-trace.json` is the canonical
machine-readable form.

### Evidence References

Every generated project MUST embed, somewhere a downstream tool can read:

- the IR `irId` and `sourceHash`,
- the runtime artifact coordinates (name + version),
- the contract version (`target-generator-contract-v0`).

For the Java target, these MAY be exposed via the generated project's `pom.xml`
properties or via `c2c-trace.json`. They MUST be present.

### Open Assumptions

Whenever a generator simplifies semantics (rounding mode, default behavior on
unspecified COBOL feature, runtime fallback), it MUST:

1. Reference an `assumptions[]` entry from the IR if the simplification was
   already known at parse time, or
2. Add a generator-emitted assumption record into the runtime's assumption
   registry at program start.

A generator MUST NOT silently drop or fabricate semantics.

## Forbidden Behavior

- Generating code that depends on an unspecified or unversioned runtime.
- Emitting placeholder code (`// TODO: implement`, `throw new
  UnsupportedOperationException()` without an IR-anchored assumption record).
- Translating unsupported COBOL constructs as comments in the generated
  target language.
- Using floating-point arithmetic for values that the IR marks as fixed-point
  decimal.

## Future-Target Extension Points

The contract is written to be reusable by future Rust, Go, and Python
generators. None of those targets are implemented in W0 — only the Java target
and the Java runtime ship in this wave. Future targets MUST:

- Implement the runtime surface above in the target language under
  `libs/c2c-target-<lang>-runtime/`.
- Reuse the same IR validation, traceability, and assumption rules.
- Bump the contract version (`v1`, `v2`, ...) only when adding a requirement
  that is not backwards-compatible. Adding a new optional output is not a
  breaking change.

Each future target SHOULD ship its own contract addendum
(`docs/contracts/target-generator-contract-v0-<lang>.md`) explaining language-
specific representation choices, but the W0 rules above are common.

## Versioning

- The contract version is `v0`. A breaking change requires a new file
  (`target-generator-contract-v1.md`) and a corresponding bump in
  `RuntimeMetadata.CONTRACT_VERSION` for any target that adopts it.
- Adding a new optional output (for example, an SBOM file) is not a breaking
  change.
- Tightening an existing requirement (e.g. making `c2c-trace.json`
  mandatory for all targets, not just Java) is a breaking change.

## References

- Issue [#11](https://github.com/oscharko-dev/c2c-PreBeta/issues/11) — W0 Java
  target runtime and generator contract.
- `schemas/semantic-ir-v0.json` — IR schema this contract consumes.
- `docs/corpus/w0-cobol-subset.md` — COBOL subset the W0 corpus exercises.
- `libs/c2c-target-java-runtime/` — reference runtime implementation.
- `docs/target-java-runtime/README.md` — Java-first now / multi-target later
  rationale.
