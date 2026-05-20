# Verifier Memory

- 2026-05-20: For repo-wide workflow changes, minimum static verification is YAML parse plus `git diff --check`; full confidence comes from GitHub Actions.
- 2026-05-20: For product path changes, verify local stack and release gates only when requested or when the task explicitly requires end-to-end proof.
- 2026-05-20: Report residual risk separately from pass/fail verdict.
