# Refactor Playbook

Use for behavior-preserving cleanup and housekeeping work.

1. Fetch the issue and identify the explicit refactor boundary.
2. Use `architect` when the refactor changes layout, ownership, or public
   structure.
3. Use `explorer` to map callers, tests, scripts, docs, and generated artifacts.
4. Use `test-engineer` to identify coverage before moving code.
5. Refactor in mechanical slices:
   - topology/catalog first;
   - path moves second;
   - script/CI/docs updates third;
   - guardrails and verification last.
6. Use write agents only for disjoint scopes.
7. Do not mix product behavior changes with refactoring.
8. Use `verifier` to compare acceptance criteria and expected gates.

Stop if the refactor cannot be verified or would require weakening gates.
