# Audit Playbook

Use after implementation or when an issue asks for hardening/audit work.

1. Fetch the issue and the implementation PR/commits.
2. Use the issue acceptance criteria as the audit checklist.
3. Run read-only fan-out first:
   - `explorer` for changed paths and tests.
   - `architect` for boundaries and invariants.
   - `security-reviewer` or `security-auditor` for trust-boundary risk.
   - `performance-engineer` for measurable performance risk.
   - `a11y-auditor` for Studio/browser accessibility risk.
   - `pr-reviewer` for correctness and regression review.
4. Convert only confirmed findings into fix slices.
5. Assign disjoint write scopes to `implementor` or `developer`.
6. Use `test-engineer` for missing regression coverage.
7. Finish with `verifier` and `pr-shepherd`.

Do not report speculative findings as blockers. Evidence is required.
