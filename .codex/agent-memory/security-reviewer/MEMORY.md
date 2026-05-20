# Security Reviewer Memory

- 2026-05-20: Model calls must remain behind Model Gateway. Do not log or persist tokens in prompts, hooks, PR bodies, or memory.
- 2026-05-20: Security-sensitive Studio areas include CSP middleware, sanitization, IndexedDB persistence, editor assist, session routes, and rate limits.
