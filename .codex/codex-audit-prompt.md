# Agent Team Audit Prompt

Use this template to audit, harden, or verify implemented work with the
project-scoped Codex agent team.

Replace `<ISSUE_NUMBER>` before use. Do not paste the issue body into this
prompt. The GitHub issue is the source of truth for original scope, acceptance
criteria, expected behavior, dependencies, and definition of done.

## Task

Audit the implementation for GitHub Issue `<ISSUE_NUMBER>` from the current
state of `origin/dev`, then fix confirmed gaps through a green PR targeting
`dev`.

You are the coordinator for the project-scoped Codex team defined in
`.codex/agents/`, `.codex/agent-memory/`, and `.codex/config.toml`.

## Source of Truth

1. Fetch GitHub Issue `<ISSUE_NUMBER>` before planning.
2. Inspect the issue body, labels, comments, linked PRs, linked commits, and any
   child issues.
3. Treat the issue acceptance criteria as the audit checklist.
4. If the implementation PR is already known, inspect it directly. Otherwise,
   find the PR or commits that claim to resolve the issue.
5. If no implementation can be found, stop and report that the issue is not
   audit-ready.
6. If the issue scope is ambiguous or conflicts with repository governance, stop
   and report the blocker. Do not invent product scope.

## Audit Operating Model

1. Load coordinator memory from `.codex/agent-memory/coordinator/MEMORY.md`.
2. Build a read-first audit wave:
   - `explorer` maps changed code, tests, and runtime paths.
   - `architect` checks architecture, contracts, and scope boundaries.
   - `security-reviewer` or `security-auditor` checks trust boundaries,
     secrets, auth, model access, and unsafe data flows when relevant.
   - `performance-engineer` checks measurable performance risk when relevant.
   - `a11y-auditor` checks WCAG/UI risk when relevant.
   - `pr-reviewer` reviews the implementation diff for correctness and
     regression risk.
3. Convert only confirmed findings into implementation slices.
4. Assign disjoint file ownership to `implementor` or `developer` agents for
   fixes.
5. Use `test-engineer` for missing or weak regression coverage.
6. Finish with `verifier` and, for PR work, `pr-shepherd`.
7. Update role memory only with durable project lessons. Never store secrets,
   customer data, private source dumps, or token-bearing logs.

## Audit Bar

- Findings must be evidence-based and cite files, lines, commands, screenshots,
  logs, or GitHub checks where applicable.
- Do not report speculative findings as blockers.
- Fix only confirmed gaps against Issue `<ISSUE_NUMBER>` or repository
  invariants.
- Preserve behavior unless the issue explicitly required a behavior change.
- Preserve deterministic-first c2c architecture.
- Keep productive model calls behind the Model Gateway.
- Keep CI, tests, release gates, CSP, security scans, and evidence semantics at
  least as strict as before.
- Required GitHub check `ci` must pass before merge.
- Qodana/static-analysis findings should be reviewed when the issue is
  security-sensitive or touches shared control-plane code.

## Tools and Grounding

1. Prefer the GitHub plugin/app for issue, PR, review, and merge workflows.
2. Use `gh` where CI logs, branch state, or review-thread details require it.
3. Use Context7 for current framework/library/API documentation.
4. Use OpenAI Developer Docs MCP for OpenAI product/API questions.
5. Use Playwright/browser tooling for UI reproduction or browser evidence.
6. Use Figma MCP only when the issue provides a Figma/design source or asks for
   design implementation.
7. Use web search only for unstable external facts and prefer primary sources.

## Git and PR Workflow

1. Branch from `origin/dev` using
   `codex/issue-<ISSUE_NUMBER>-audit`.
2. Make only issue-scoped audit fixes.
3. Commit with a Conventional Commit message that references
   `#<ISSUE_NUMBER>`.
4. Push the branch.
5. Open or update a PR targeting `dev`.
6. Include `Refs #<ISSUE_NUMBER>` when the audit does not close the issue, or
   `Resolves #<ISSUE_NUMBER>` only when the issue should close on merge.
7. Diagnose and repair CI failures with bounded attempts. Stop after three
   failed CI repair attempts and report the blocker.
8. Merge only when required checks are green, reviews are satisfied, and the PR
   is mergeable.

## Safety

- Never print, persist, or restate secrets.
- Never commit tokens, `.env` contents, customer data, or local runtime logs.
- Do not revert unrelated user or agent changes.
- Do not use destructive git commands.
- Do not amend or rewrite history unless explicitly requested.

## Final Delivery Contract

Return:

- Issue audited
- Audit team used and why
- Implementation source inspected
- Findings confirmed
- Findings fixed
- Files changed
- Tests/checks run
- GitHub PR and `ci` status
- Any additional relevant gate status
- Residual risks or follow-ups
