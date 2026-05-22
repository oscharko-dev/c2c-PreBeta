## Description

Describe the changes made in this PR and the user, developer, platform, or governance outcome they deliver.

**Refs #<issue_number>**

## Agent Team Summary

- Issue source of truth: #<issue_number>
- Execution mode: `single-agent | agent-team | audit-only | refactor-only | feature-delivery | audit/verification-heavy | human-led`
- Coordinator:
- Agents used:
- File ownership:
- Memory updates:
  - [ ] Durable lessons captured where useful.
  - [ ] No secrets, customer data, raw private source dumps, or token-bearing logs stored.

## Issue Scope and Acceptance Criteria

- [ ] The PR implements only the linked issue scope.
- [ ] Acceptance Criteria are mapped to concrete changes, tests, documentation, or evidence.
- [ ] Expected Verification items are completed or explicitly marked not applicable with rationale.
- [ ] Required documentation, migration notes, screenshots, logs, issue comments, or follow-up issues are included when requested by the issue.

## Verification

- [ ] Required GitHub check `ci` passes.
- [ ] Studio browser quality gate run or not applicable.
- [ ] Studio perf/memory gate run or not applicable.
- [ ] Studio visual regression run or not applicable.
- [ ] Markdown link check run or not applicable.
- [ ] W0.2 release gate run or not applicable.
- [ ] W0.3 release gate run or not applicable.
- [ ] Security review run or not applicable.
- [ ] Qodana/static-analysis reviewed when security-sensitive or shared control-plane code changed.

## Review Settlement

- [ ] All actionable review findings are fixed or explicitly dispositioned.
- [ ] No unresolved actionable review threads remain.
- [ ] Checks and review settlement were repeated after the latest pushed fixes.

## Issue Completion

- [ ] Issue Acceptance Criteria checkboxes are updated only where evidence exists.
- [ ] Issue Expected Verification checkboxes are updated only where evidence exists.
- [ ] Closure evidence is recorded in the issue or PR.
- [ ] Use `Resolves #<issue_number>` only when the issue is formally complete and should close on merge.

## PR Checklist

- [ ] **Issue Link**: This PR is linked to a valid GitHub issue (No implementation without an issue).
- [ ] **Scope Alignment**: This PR does not expand scope silently. (If scope expansion was needed, a follow-up issue has been created).
- [ ] **Commit Message**: Commits follow conventional guidelines and reference the issue.
- [ ] **ADR**: Any significant architectural changes are documented in an ADR.
- [ ] **No Temporary Code**: No un-tracked TODOs, commented-out code, or placeholders are left behind.
- [ ] **Agent Safety**: No unrelated changes were reverted; no destructive git commands were used.
- [ ] **Enterprise Standard**: The implementation is production-ready, state-of-the-art, and simple enough to maintain without unnecessary special cases or speculative abstractions.
