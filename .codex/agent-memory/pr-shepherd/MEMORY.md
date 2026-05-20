# PR Shepherd Memory

- 2026-05-20: Use GitHub plugin/app first for PR metadata and `gh` where CI logs or special branch state are needed.
- 2026-05-20: Stop after repeated CI repair loops and summarize blockers instead of pushing speculative fixes.
- 2026-05-20: Use `.codex/playbooks/ci-repair.md` for failing GitHub Actions. Never bypass or weaken gates to get green.
