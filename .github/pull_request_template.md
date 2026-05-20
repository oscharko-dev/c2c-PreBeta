## Description
Please describe the changes made in this PR.

**Resolves #<issue_number>**

## Agent Team Summary

- Issue source of truth: #<issue_number>
- Execution mode: `single-agent | agent-team | audit-only | refactor-only | human-led`
- Coordinator:
- Agents used:
- File ownership:
- Memory updates:
  - [ ] Durable lessons captured where useful.
  - [ ] No secrets, customer data, raw private source dumps, or token-bearing logs stored.

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

## PR Checklist
Please review the following checklist to ensure your PR meets our governance standards.

- [ ] **Issue Link**: This PR is linked to a valid GitHub issue (No implementation without an issue).
- [ ] **Scope Alignment**: This PR does not expand scope silently. (If scope expansion was needed, a follow-up issue has been created).
- [ ] **Commit Message**: Commits follow conventional guidelines and reference the issue.
- [ ] **Definition of Done (Wave 0)**:
  - [ ] Required `ci` check is passing.
  - [ ] Tests are included and passing (where applicable).
  - [ ] SBOM/license posture is verified (where applicable).
  - [ ] Harness event, trajectory, and Experience Learning visibility is implemented (where applicable).
- [ ] **ADR**: Any significant architectural changes are documented in an ADR.
- [ ] **No Temporary Code**: No un-tracked TODOs, commented-out code, or placeholders are left behind.
- [ ] **Agent Safety**: No unrelated changes were reverted; no destructive git commands were used.
