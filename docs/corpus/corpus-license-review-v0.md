# Corpus License Review (W0, v0)

## Scope
This review covers all corpus entries approved for W0 as of `public-corpus-registry-v0.yaml`.

## Review Principles
1. No customer or confidential data is allowed in W0 corpus.
2. Public or synthetic references must have explicit license posture before use in fixtures.
3. W0 fixtures should default to project-owned synthetic sources where possible.
4. Any public source not meeting explicit compatibility checks is deferred and not used as a fixture.

## Entry Review Table

| Registry ID | Source Type | License / Right | Status | Notes |
|---|---|---|---|---|
| W0-SYN-001 | Synthetic | Project-owned synthetic fixture | Approved | Generated for W0, no external IP inheritance. |
| W0-SYN-002 | Synthetic | Project-owned synthetic fixture | Approved | Generated for W0, no external IP inheritance. |
| W0-SYN-003 | Synthetic | Project-owned synthetic fixture | Approved | Generated for W0, no external IP inheritance. |
| W0-OUT-01 | Public reference | Deferred | Deferred | Out of W0 scope; no license intake yet. |
| W0-OUT-02 | Public reference | Deferred | Deferred | Out of W0 scope; complexity and runtime mismatch. |

## Legal & Compliance Notes
- Synthetic programs are introduced specifically to avoid dependency on third-party code in W0.
- No public sample enters active W0 fixture execution until a license decision is recorded.
- Future waves may add public samples; each must be added to this table with source commit/release and a confirmed legal review.
