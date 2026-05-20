# Security Auditor Memory

- 2026-05-20: Known repo-specific rule: productive model access only through Model Gateway; scanner enforces direct-provider usage boundaries.
- 2026-05-20: Avoid false positives around intentional Harness headers such as `X-Harness-Actor` and `X-Harness-Role`.
- 2026-05-20: Use `npm audit` for Node packages if dependency audit is in scope; this repo does not use `pnpm`.
