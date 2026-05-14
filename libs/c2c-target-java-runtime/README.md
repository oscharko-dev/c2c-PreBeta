# c2c-target-java-runtime

The W0 Java target runtime for c2c. Generated Java programs (produced from
COBOL via the c2c semantic IR) link against this library for COBOL-compatible
primitives: fixed-point decimal, working-storage fields, class- and relational
conditions, and an open-assumption registry.

This runtime implements the requirements of
[`docs/contracts/target-generator-contract-v0.md`](../../docs/contracts/target-generator-contract-v0.md).

## Coordinates

| Property         | Value                            |
|------------------|----------------------------------|
| GroupId          | `com.c2c`                        |
| ArtifactId       | `c2c-target-java-runtime`        |
| Version          | `0.1.0`                          |
| IR version       | `semantic-ir-v0`                 |
| Contract version | `target-generator-contract-v0`   |

The same identity is exposed at runtime via
`com.c2c.target.java.runtime.RuntimeMetadata` and via jar manifest attributes
`C2c-Runtime-Name`, `C2c-Runtime-Version`, `C2c-Contract-Version`,
`C2c-Ir-Version`.

## What it provides (W0)

| Class                | Purpose                                                              |
|----------------------|----------------------------------------------------------------------|
| `CobolDecimal`       | Fixed-point decimal with declared scale and HALF_EVEN rounding       |
| `PictureSpec`        | Parsed `PIC` clause for the W0 numeric / alphanumeric / alphabetic subset |
| `CobolField`         | Working-storage field bound to an IR node id, with overflow checks   |
| `ConditionStatus`    | NUMERIC / ALPHABETIC / ZERO / POSITIVE / NEGATIVE + relational operators |
| `AssumptionRegistry` | Append-only record of open semantic assumptions surfaced at runtime  |
| `RuntimeMetadata`    | Identity constants pinned for generators                             |

The W0 surface is intentionally narrow — see
[`docs/corpus/w0-cobol-subset.md`](../../docs/corpus/w0-cobol-subset.md). Out-of-scope
COBOL features (CICS, DB2, indexed files, edited PIC clauses, packed-decimal
nuances beyond `S9(n)V9(s)`) are not supported, and the runtime fails fast
rather than silently producing wrong semantics.

## Building

```bash
cd libs/c2c-target-java-runtime
mvn -B test          # runs the W0 unit tests
mvn -B package       # produces target/c2c-target-java-runtime-0.1.0.jar
```

Java 21 is required (matching the rest of the c2c Java services).

The runtime has no production-time dependencies beyond the JDK; the only
declared dependency is JUnit 5 in test scope.

## Java-first now, multi-target later

W0 ships only the Java target. Rust, Go, and Python targets are explicitly
out of scope for this wave but the contract is written so they can be added
without changing the IR or refactoring the existing target. See
[`docs/target-java-runtime/README.md`](../../docs/target-java-runtime/README.md)
for the architecture rationale.

## Documented W0 simplifications

- Rounding is `HALF_EVEN` on division and rescale.
- `MOVE` from numeric to numeric rescales using `HALF_EVEN`.
- `MOVE` from alphanumeric to a wider field pads on the right with spaces.
- `MOVE` from alphanumeric to a narrower field truncates from the right.
- `IS NUMERIC` on alphanumeric data accepts plain `BigDecimal`-parseable
  text; sign overpunch and `COMP-3` decoding are not modelled in W0.
- `IS POSITIVE` / `IS NEGATIVE` apply only to numeric fields.
- The PIC parser accepts `9(n)`/`99…9`, `S9(n)`/`S99…9`, with optional
  `V9(s)`/`V9…9`; `X(n)`/`X…X`; `A(n)`/`A…A`. Edited PIC clauses are rejected.

These simplifications are recorded here as the canonical list. Any future
runtime change that loosens or changes one of them MUST be reflected both in
this README and in the generator's IR `assumptions[]` mapping.
