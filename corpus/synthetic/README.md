# Synthetic Corpus

This directory contains W0 synthetic COBOL programs and deterministic fixture outputs.

## Layout
- `programs/` contains the sample COBOL inputs.
- `fixtures/` contains expected deterministic outputs.
- `generator/` contains generator requirements and conventions.

The synthetic corpus is intentionally minimal and excludes customer code and sensitive data categories, including PII, bank data, and insurance data.

## Golden Master usage

The expected outputs in `fixtures/` are referenced from
[`fixtures/golden-master/index.json`](../../fixtures/golden-master/index.json)
and consumed by
[`build-test-runner-service`](../../services/build-test-runner-service/) to
classify the verification outcome of a generated Java project.

Every W0 entry is **synthetic** (hand-curated expected output) rather than a
**true** Golden Master (output captured from a COBOL runtime such as
`cobcrun`). Because the W0 generator does not yet translate `PERFORM`,
`EVALUATE`, `IF`, `COMPUTE`, or `ADD`, the runner is expected to emit a
`divergence-known-w0-coverage-gap` classification for these programs. Future
waves will add real GnuCOBOL re-execution and pin its stdout by SHA-256.
