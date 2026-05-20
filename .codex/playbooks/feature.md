# Feature / Task Playbook

Use for issue-scoped implementation work.

1. Fetch the issue and confirm acceptance criteria, dependencies, labels, and
   expected verification.
2. Load coordinator memory and relevant role memory.
3. Use `explorer` to map code paths and tests when more than one module is
   touched.
4. Use `architect` when contracts, service boundaries, workflow semantics, or
   durable docs may change.
5. Split implementation into disjoint file scopes.
6. Assign `implementor` or `developer` agents to write scopes.
7. Assign `test-engineer` to coverage when behavior risk is non-trivial.
8. Run or request relevant verification.
9. Use `verifier` or `pr-reviewer` before final delivery.
10. Open/update a PR targeting `dev` and require green `ci`.

Do not add product scope that is not in the issue.
