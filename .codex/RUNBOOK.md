# Codex Agent Team Runbook

This runbook defines how to use the project-scoped Codex agent team for c2c.
The GitHub issue is always the source of truth for scope, acceptance criteria,
dependencies, and definition of done.

## Default Lifecycle

1. Start from a GitHub issue ID.
2. Fetch the issue, linked PRs, comments, labels, and current CI state.
3. Choose the execution mode from the issue template.
4. Load coordinator memory and relevant role memory.
5. Create a short coordination plan with file ownership, agent roles, stop
   conditions, and verification gates.
6. Run read-only discovery before write work when the scope touches multiple
   modules, architecture, security, UI behavior, release gates, or CI.
7. Assign write agents only to disjoint scopes.
8. Integrate work in the coordinator thread.
9. Run the narrowest meaningful checks locally, then verify GitHub `ci`.
10. Update durable memory. Do not store secrets, customer data, raw source dumps,
    or token-bearing logs.

## Agent Routing by Issue Signal

- `type: epic`: `coordinator` + `architect`; do not implement the whole epic
  unless a child issue is selected.
- `type: task` or `type: feature`: `coordinator`, `explorer`, then
  `implementor`/`developer`, `test-engineer`, `verifier`.
- `type: bug`: `explorer`, `browser-debugger` when UI-visible,
  `implementor`, `test-engineer`, `verifier`.
- `type: follow-up`: usually `developer` or small agent team.
- `area: frontend`: add `ui-engineer`, `a11y-auditor`, and
  `performance-engineer` when UI risk is material.
- `area: bff`: add `security-reviewer` when request/session/rate-limit/CSP
  behavior changes.
- `area: architecture`: add `architect` and `docs-editor`.
- `area: security`: add `security-auditor` or `security-reviewer`.
- `area: release`: add `pr-shepherd` and `verifier`.
- `area: evidence`, `area: orchestration`, `area: harness`, or
  `area: model-gateway`: add `architect` and `security-reviewer`.

## Verification Routing

- Always required before merge: GitHub check `ci`.
- Studio UI or BFF browser behavior: Studio browser quality gate.
- Monaco/editor performance, rendering, large-file behavior: Studio perf/memory.
- Visible UI structure: Studio visual regression.
- Markdown docs: markdown link check.
- W0.2 workflow/evidence/model behavior: W0.2 release gate.
- W0.3 workflow/Studio hardening behavior: W0.3 release gate.
- Security-sensitive changes: security review plus Qodana/static-analysis review
  when practical.

## Stop Conditions

Stop and report instead of improvising when:

- The issue has no acceptance criteria and the intended behavior is not obvious.
- The issue is an epic and no executable child issue is selected.
- The requested change expands beyond the issue scope.
- Two agents need to write the same files in parallel.
- The work requires secrets, customer data, private runtime logs, or token dumps.
- A refactor target has no meaningful behavior coverage and the issue does not
  authorize adding coverage first.
- Required `ci` fails after three repair attempts with different root causes.
- The implementation would weaken deterministic-first, evidence, release-gate,
  model-gateway, CSP, or security-scan guarantees.

## Memory Rules

- Memory path: `.codex/agent-memory/<agent-name>/MEMORY.md`.
- Store only durable project lessons, recurring pitfalls, false positives,
  verification commands, and architecture invariants.
- Keep entries short and dated.
- Keep each memory file below 25 KB.
- Never store secrets, customer data, raw private source dumps, full logs, or
  token-bearing command output.

## Tooling Rules

- GitHub plugin/app first for issue, PR, review, and merge workflows.
- `gh` for CI logs, branch state, and cases where the plugin is weaker.
- Context7 for current framework/library/API documentation.
- OpenAI Developer Docs MCP for OpenAI product/API questions.
- Playwright/browser tooling for UI reproduction and browser evidence.
- Figma MCP only when the issue provides a design source or asks for design
  implementation.
- Web search only for unstable external facts; prefer primary sources.
