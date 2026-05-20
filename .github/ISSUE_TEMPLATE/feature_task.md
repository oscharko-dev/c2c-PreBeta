---
name: Feature / Task
about: Propose a new feature, implementation task, or chore
title: ''
labels: ['type: task', 'wave: w0', 'status: ready']
assignees: ''
---

## Purpose
[Describe the goal of this issue]

## Agent Execution Mode
- [ ] Single-agent
- [ ] Agent team
- [ ] Audit-only
- [ ] Refactor-only
- [ ] Human-led / agent-assisted

## Agent Routing Hints
- Primary area label: `area:<...>`
- Recommended lead agent: `coordinator | developer | architect | pr-shepherd`
- Suggested specialist agents, if relevant: `explorer | implementor | test-engineer | security-reviewer | performance-engineer | a11y-auditor | docs-editor | verifier`
- Expected write ownership: [List files/modules that may be edited, or say "TBD by coordinator"]

## Scope
[Clearly define what is in scope. Remember: No implementation happens without an issue.]

## Governance Checklist
- [ ] Required: This is an implementation task, not work outside governance.
- [ ] Required: Follow-up scope is explicitly listed in Out of Scope.
- [ ] Required: Ownership is assigned (one owner before coding starts).
- [ ] Required: Branch naming follows issue rule (`issue-<number>-<short-description>`).

## Deliverables
- [ ] Deliverable 1
- [ ] Deliverable 2

## Acceptance Criteria
- [ ] Criteria 1
- [ ] Criteria 2

## Expected Verification
- [ ] Required GitHub check: `ci`
- [ ] Studio browser quality gate (a11y/CSP) when Studio UI or BFF browser behavior changes
- [ ] Studio perf/memory gate when editor performance, Monaco, rendering, or large-file behavior changes
- [ ] Studio visual regression when visible UI structure changes
- [ ] Markdown link check when docs change
- [ ] W0.2 release gate when W0.2 product-path semantics change
- [ ] W0.3 release gate when W0.3 workflow/Studio hardening semantics change
- [ ] Security review when trust boundaries, auth/session, secrets, CSP, model access, or external calls change
- [ ] Qodana/static-analysis review when security-sensitive or shared control-plane code changes

## Stop Conditions
- [ ] Stop if acceptance criteria are missing or contradictory.
- [ ] Stop if implementation would expand scope beyond this issue.
- [ ] Stop if the task requires secrets, customer data, or private runtime logs.
- [ ] Stop if two parallel agents would need to edit the same file scope.
- [ ] Stop if CI fails after three repair attempts with different root causes.

## Engineering Notes
[Any specific constraints, architectural notes, or related ADRs]

## Out of Scope
[List items that are explicitly not part of this issue. Use follow-up issues for deferred scope.]
