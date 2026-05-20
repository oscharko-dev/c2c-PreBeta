# Codex Agent Memory

Project-scoped agent memory lives under `.codex/agent-memory/<agent-name>/MEMORY.md`.

Rules:

- Store only durable project facts, recurring pitfalls, verification commands, and resolved false positives.
- Never store secrets, tokens, customer data, raw private source dumps, or full command logs.
- Keep each role memory below 25 KB.
- Prefer short dated bullets over long transcripts.
- Update memory after a completed task only when the learning will help future work.
