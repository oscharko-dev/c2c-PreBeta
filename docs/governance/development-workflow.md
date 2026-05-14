# Development Workflow Governance

## 1. Golden Rule: Issue First
**There is absolutely no implementation work outside of GitHub issues in this repository.** Every branch, commit, pull request, and code change must be directly linked to an existing, approved issue.

**W0 Contribution Rule:** Issue first, then branch, then PR.

## 2. Issue Lifecycle & Structure
- **Epics**: Large scope items that represent significant milestones. Epics should be broken down into child issues.
- **Child Issues**: Concrete, actionable tasks. Must link back to the parent Epic.
- **Follow-up Issues**: If scope expansion occurs during implementation or a PR review, **do not silently expand scope**. Instead, create a follow-up issue, link it to the current work, and defer the additional scope.
- **ADRs (Architecture Decision Records)**: Any significant architectural change or technical decision must be documented using our ADR template before or during the issue implementation.

## 3. Labels and Taxonomy (Wave 0)
For Wave 0, we use a minimal label taxonomy:
- `type: feature` - New implementations or product features.
- `type: bug` - Bug fixes and corrections.
- `type: chore` - Maintenance, CI, and governance work.
- `type: epic` - Large milestones.
- `status: ready` - Ready for implementation.
- `status: blocked` - Blocked by another issue or decision.

**Ownership Expectations**: Issues must have an assigned owner before work begins. The assignee is responsible for driving the issue to completion.

## 4. Branching and Commits
- **Branch Naming**: `issue-<issue_number>-<short-description>` (e.g., `issue-2-governance-setup`).
- **Commit Messages**: Use Conventional Commits and reference the issue number. E.g., `feat: add governance workflow docs (#2)`.
- **PR Naming**: Similar to commits, `feat: add governance workflow docs (#2)`. PRs should automatically link to the issue they resolve by including `Resolves #<issue_number>` in the description.

## 5. Code Review Expectations
- PRs must pass all CI checks before merge.
- For a one-owner project, PRs are merged by the issue owner after passing CI.
- For a multi-owner project, at least one explicit approver is required.
- PRs must focus exclusively on the linked issue. Scope creep will be rejected, and the author will be asked to create a follow-up issue.

## 6. Definition of Ready (DoR) - Wave 0
An issue is ready to be worked on when:
- It has a clear title and description.
- Deliverables and Acceptance Criteria are defined.
- It is linked to an epic (if applicable).
- It is assigned to a developer.

## 7. Definition of Done (DoD) - Wave 0
An issue is considered done and ready for merge when:
- All Acceptance Criteria are met.
- The PR has been reviewed and approved.
- **CI is green** (build passes).
- **Tests** are written and passing (where applicable).
- **SBOM/license posture** is valid (where applicable).
- **Harness event visibility** is established (where applicable).
- No TODOs or temporary workarounds remain unless explicitly tracked in a follow-up issue.
