# Synthetic Corpus Generator Requirements

## Generator Objective
Produce deterministic COBOL programs and fixtures that are small enough for W0 parsing and conversion smoke tests.

## Generation Rules
- Each generated sample must remain in UTF-8 and ASCII-safe syntax.
- Every sample must include:
  - at least one control-flow construct (`IF`, `EVALUATE`, or `PERFORM UNTIL`)
  - at least one decimal or field semantics check (`PIC ... V ...` or equivalent)
  - no external file I/O by default
  - deterministic output statements (`DISPLAY` / standardized lines)
- Each sample must include an accompanying fixture output snapshot.
- Numeric formatting must be stable across runs.
- No external/custodian code is allowed.
