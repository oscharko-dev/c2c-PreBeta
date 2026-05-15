# Development Workflow Governance

## 1. Golden Rule: Issue First
**There is absolutely no implementation work outside of GitHub issues in this repository.** Every branch, commit, pull request, and code change must be directly linked to an existing, approved issue.

**Contribution Rule:** Issue first, then branch, then PR. This applies to
code, tests, documentation, architecture records, release gates, and local
automation.

## 2. Issue Lifecycle & Structure
- **Epics**: Large scope items that represent significant milestones. Epics should be broken down into child issues.
- **Child Issues**: Concrete, actionable tasks. Must link back to the parent Epic.
- **Follow-up Issues**: If scope expansion occurs during implementation or a PR review, **do not silently expand scope**. Instead, create a follow-up issue, link it to the current work, and defer the additional scope.
- **ADRs (Architecture Decision Records)**: Any significant architectural change or technical decision must be documented using our ADR template before or during the issue implementation.

### ADR Workflow
1. Create a new ADR from `docs/adr/0000-template.md`.
2. Number it sequentially as `NNNN-short-kebab-title.md` under `docs/adr/`.
3. Reference the driving issue in the ADR metadata and body.
4. Link the ADR from the issue and PR that depend on it.
5. Update ADR status as the decision matures (`Proposed`, `Accepted`, `Superseded`).

## 3. Labels and Taxonomy
Use this label taxonomy for Wave 0 and follow-on W0.x waves:
- `type: epic|task|feature|bug|chore` - Work kind for planning and reporting.
- `wave: preflight|w0|w0.1|w0.2|w1` - Delivery wave classification.
- `priority: p0|p1|p2` - Urgency for sequencing and triage.
- `status: ready|blocked|in-progress` - Current execution state.
- `area: governance|platform|security|orchestrator|experience-learning|harness|model-gateway|semantics|target-java|verification|evidence|frontend|bff|corpus|release|architecture|agents` - Primary ownership domain.

**Ownership Expectations**: Issues must have an assigned owner before work begins. The assignee is responsible for driving the issue to completion.

## 4. Branching and Commits
- **Branch Naming**: `issue-<issue_number>-<short-description>` (e.g., `issue-2-governance-setup`). If an automation namespace is used, preserve the same suffix (e.g., `claude/Issue-2-governance-setup`).
- **Commit Messages**: Use Conventional Commits and reference the issue number. E.g., `feat: add governance workflow docs (#2)`.
- **PR Naming**: Similar to commits, `feat: add governance workflow docs (#2)`. PRs should automatically link to the issue they resolve by including `Resolves #<issue_number>` in the description.

## 5. Code Review Expectations
- PRs must pass all CI checks before merge.
- For a one-owner project, PRs are merged by the issue owner after passing CI.
- For a multi-owner project, at least one explicit approver is required.
- PRs must focus exclusively on the linked issue. Scope creep will be rejected, and the author will be asked to create a follow-up issue.

## 6. Concept and Workflow Synchronization
The [c2c Fachkonzept](../concept/c2c-fachkonzept.md) is the canonical product
and architecture concept. Any issue that changes one of the following must
update the Fachkonzept and any affected release gate or workflow document in
the same PR:

- wave scope or sequencing;
- product architecture;
- microservice boundaries;
- Harness/orchestrator responsibilities, including the Harness role as
  Experience Learning system;
- model provider, Model Gateway, Foundry, or customer endpoint policy;
- agent workflow semantics;
- success, blocked, unsupported, failed, or incomplete UI states;
- Evidence Pack or equivalence semantics;
- release acceptance gates.

If the change is architectural, add or update an ADR under `docs/adr/`.

## 7. Definition of Ready (DoR)
An issue is ready to be worked on when:
- It has a clear title and description.
- Deliverables and Acceptance Criteria are defined.
- It is linked to an epic (if applicable).
- It is assigned to a developer.
- It states whether concept, ADR, release-gate, or development-workflow
  documentation must change.
- It states whether the deterministic W0/W0.1 no-model gate must keep passing.

## 8. Definition of Done (DoD)
An issue is considered done and ready for merge when:
- All Acceptance Criteria are met.
- The PR has been reviewed and approved.
- **CI is green** (build passes).
- **Tests** are written and passing (where applicable).
- **SBOM/license posture** is valid (where applicable).
- **Harness event, trajectory, and Experience Learning visibility** is
  established (where applicable).
- No TODOs or temporary workarounds remain unless explicitly tracked in a follow-up issue.
- Any required Fachkonzept, ADR, release-gate, runbook, or workflow updates are
  included.
- If the issue touches W0.2 or later AI behavior, model access is routed only
  through model-gateway-service and deterministic verification/evidence gates
  still decide success.
