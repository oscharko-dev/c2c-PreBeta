# Contributing

All implementation in this repository is issue-driven: issue first, then branch, then PR.

Before starting work:
- Read `docs/governance/development-workflow.md`.
- Open or update a task issue from `.github/ISSUE_TEMPLATE/feature_task.md`.
- Follow `.github/pull_request_template.md` when opening a PR.
- Create or update ADRs using `docs/adr/0000-template.md` for significant technical decisions.

If scope grows during implementation, create a follow-up issue and keep the current PR scoped to the original issue.

## Pre-commit security check

Run the repository pre-commit hook setup once per clone to guard against committing credentials:

```bash
./scripts/setup-git-hooks.sh
```

The hook scans staged files for credentials-like content and blocks staging/commit for suspicious findings.

On CI, the same scanner runs on every PR to `dev` and every push to `dev` in
`.github/workflows/secret-scan.yml`.
