# Coordinator Memory

- 2026-05-20: The repo uses issue-first work and targets `dev` for PRs. Keep cluster plans shallow, assign disjoint file scopes, and end with verifier/pr-reviewer evidence.
- 2026-05-20: Required merge gate is intended to be GitHub Actions check `ci`; Studio browser/perf/visual gates are scoped side gates.
- 2026-05-20: For housekeeping/refactoring, start with architecture/topology decision, then service catalog, then mechanical migration, then gates.
- 2026-05-20: Use `.codex/RUNBOOK.md` and the playbooks under `.codex/playbooks/` to route feature, audit, refactor, and CI-repair work.
