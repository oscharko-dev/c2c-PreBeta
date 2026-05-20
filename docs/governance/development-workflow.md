# Development Workflow Governance

Good code is the documentation. Issues track work. Repo docs record only stable
rules that code, tests, schemas, or scripts cannot express clearly enough.

## Issue First

Every code, test, architecture, release, or governance change must be linked to
a GitHub issue.

Workflow:

1. Issue
2. Branch
3. PR
4. CI
5. Merge

Do not copy issue bodies into the repo. Link the issue instead.

## Labels

Use the existing GitHub labels:

- `type: epic|task|feature|bug|chore|follow-up`
- `wave: preflight|w0|w0.1|w0.2|w0.3|w1`
- `priority: p0|p1|p2`
- `status: ready|blocked|in-progress`
- `area: governance|platform|security|orchestration|experience-learning|harness|model-gateway|semantics|target-java|verification|evidence|frontend|bff|corpus|release|architecture|agents`

Use one primary `area:*` label. Put secondary areas in the issue body.

## Branches and PRs

- Branch: `issue-<number>-<short-description>` or `codex/issue-<number>-<short-description>`
- Commit: Conventional Commit plus issue reference, e.g. `feat: add assist gate (#214)`
- PR body: include `Resolves #<issue>`

## ADRs

Create an ADR only for a durable architecture decision. Do not create ADRs for
normal implementation work.

ADR files live under `docs/adr/` and must stay short:

- context;
- decision;
- consequences;
- issue link.

## Service Catalog Changes

When a service or service-local component is added, moved, renamed, or removed:

- update `config/service-catalog.json` in the same PR;
- update any affected path references, contracts, fixtures, or docs;
- run `python3 scripts/validate-service-catalog.py`;
- run `make dev-check` if the change touches executable code or service wiring.
- For path migrations, keep the migration note narrow. The only approved
  exceptions are the W0 reference namespace and temporary old-path
  compatibility shims while references are still being moved.

## Definition of Ready

An issue is ready when it has:

- clear scope;
- acceptance criteria;
- owner;
- labels;
- known dependencies;
- explicit note if docs, contracts, release gates, or model policy change.

## Definition of Done

An issue is done when:

- acceptance criteria are met;
- tests or checks match the risk;
- CI passes;
- no unrelated cleanup is mixed in;
- any required docs are updated in the same PR.

## Documentation Rule

Documentation is justified only for:

- product invariants;
- architecture decisions;
- externally consumed contracts;
- configuration needed to run the product;
- release or verification rules that are not already clear in scripts/tests.

Everything else belongs in code, tests, schemas, scripts, or GitHub.
