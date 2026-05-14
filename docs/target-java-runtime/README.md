# Target Java Runtime — Architecture Notes

This page explains *why* the c2c W0 target stack is Java-only and *how* the
architecture is intentionally shaped so additional target languages can be
added later without breaking what already ships.

## Java-first now

W0 selects Java as the only target language for these reasons:

1. **Operational fit.** Most COBOL workloads at our reference customers
   already coexist with the JVM. A Java target has the shortest path from
   "generated code" to "deployed code" inside their existing platforms.
2. **Decimal semantics.** `java.math.BigDecimal` gives us declared scale and
   `HALF_EVEN` rounding without a third-party numeric library, which matches
   COBOL fixed-point semantics closely enough to make the W0 golden-master
   strategy credible.
3. **Tooling depth.** The repository already runs Java services
   (`services/cobol-parser-service`, `services/semantic-ir-service`,
   `services/java/w0-service`), so a Java runtime reuses the existing build
   discipline (Maven, JUnit 5, Java 21) instead of introducing a new toolchain.
4. **Scoping discipline.** The W0 corpus is intentionally narrow
   (`docs/corpus/w0-cobol-subset.md`). Picking one target prevents premature
   abstraction over runtime differences before we have evidence of what the
   abstractions need to look like.

## Multi-target later

The architecture is shaped so that adding Rust, Go, or Python later is a
build-out, not a refactor:

- The **Semantic IR** (`schemas/semantic-ir-v0.json`) is target-agnostic. It
  encodes program structure, symbol table, field layouts, statements,
  control-flow edges, and open assumptions — but says nothing about how those
  are rendered as code.
- The **target-generator contract**
  (`docs/contracts/target-generator-contract-v0.md`) is written to apply to any
  target. It enumerates what every generator and every runtime must provide
  (IR validation, runtime pinning, traceability, assumption handling) and
  treats the Java runtime as the W0 reference implementation, not the only
  permitted implementation.
- The **runtime location** is `libs/c2c-target-<lang>-runtime/`. Adding a
  Rust runtime means adding `libs/c2c-target-rust-runtime/` and an
  accompanying generator that emits Rust projects depending on it. No change
  to existing Java code is required.
- The **runtime surface** required by the contract (decimal, field, OCCURS
  arrays, condition helpers, assumption registry) is the same in every
  language. Each runtime picks idiomatic types, but the conceptual surface is
  fixed so the IR doesn't need a target-specific dialect.

## What we are deliberately not building in W0

- Rust, Go, and Python target runtimes.
- A general "polyglot generator" abstraction. Until two targets exist there is
  nothing to abstract over; building it now would be designing against a
  hypothetical second case.
- Performance optimization of the Java runtime. Correctness and clarity come
  first; W0 corpus programs are small enough that arithmetic overhead is not
  a concern.

## How to add a new target later (sketch, not a plan)

When the W1 (or later) wave introduces a second target language:

1. Implement `libs/c2c-target-<lang>-runtime/` with the same conceptual
   surface as the Java runtime (decimal, field, conditions, assumption
   registry, identity metadata).
2. Implement a generator service for that language that consumes the same
   IR version and emits code matching the contract.
3. If the contract needs to be tightened or extended in a way that breaks
   existing generators, bump it (`target-generator-contract-v1.md`); if not,
   the new target reuses `v0`.
4. Document language-specific behavior alongside the new runtime
   (`docs/target-<lang>-runtime/README.md`) the same way this page documents
   Java.

The W0 work is sized so that none of these steps require touching the IR, the
contract, or the existing Java code — only adding new directories.
