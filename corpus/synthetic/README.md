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

`BRNCH01` is a **true** Golden Master: its expected output is reproducible by
compiling `programs/branch-account-guard.cbl` with GnuCOBOL `cobc -m` and
executing the module with `cobcrun BRNCH01`. The remaining W0 entries are still
**synthetic** (hand-curated expected output) until they are promoted through the
same runtime reproduction path. The Java generator now matches all three
fixtures for the selected W0 `PERFORM`, `EVALUATE`, `IF`, arithmetic,
`DISPLAY`, and `OCCURS` subset.
