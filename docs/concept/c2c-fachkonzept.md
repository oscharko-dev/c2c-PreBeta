# c2c Fachkonzept

**Status:** canonical product concept
**Last updated:** 2026-05-17

Good code, tests, schemas, and executable gates are the primary documentation.
This file keeps only the product invariants that must survive across issues and
PRs.

## Product Intent

c2c is an AI-assisted COBOL-to-Java modernization platform for regulated banks
and insurers.

The product promise is narrow and strict:

- deterministic services handle semantics whenever we can specify them;
- AI agents help with ambiguity, candidate improvement, and bounded repair;
- deterministic compile/run/oracle/evidence checks decide success;
- unsupported, blocked, failed, and incomplete states are shown honestly.

## Architecture Rules

- The Studio calls only the BFF.
- The BFF starts product runs through the Orchestrator.
- The Orchestrator is the workflow controller and remains deterministic.
- The Harness provides registry, policy, events, ledgers, and Experience
  Learning signals. It does not decide the workflow.
- Model calls go only through the Model Gateway.
- Parser, Semantic IR, Java generation, build/test, oracle comparison, and
  evidence are the proof path.
- AI output is a candidate, never proof.
- `success` requires generated Java, build/test, oracle/equivalence, artifact
  hashes, and Evidence Pack to agree.

## Role Boundaries

- **Orchestrator:** run state, sequencing, assist decisions, budgets, aborts,
  final classification.
- **Harness:** capability and policy infrastructure, event ledger, trajectory
  ledger, Experience Learning telemetry.
- **Transformation Agent:** proposes or improves a Java candidate when the
  Orchestrator authorizes assist.
- **Verification/Repair Agent:** proposes bounded repairs after deterministic
  verification fails.
- **Model Gateway:** the only model boundary.
- **BFF:** browser boundary.
- **Deterministic services:** source of truth for proof.

## Wave Roadmap

| Wave | Status | Meaning | Gate |
| --- | --- | --- | --- |
| W0 | Done | Deterministic enterprise kernel. | Service mesh produces Java, build/test, telemetry, and Evidence Pack without required model calls. |
| W0.1 | Done | Studio UI over the W0 kernel. | Browser starts BFF/Orchestrator runs and shows artifact-backed status honestly. |
| W0.2 | Done | First productive AI loop. | Transformation and repair agents can participate through Model Gateway; deterministic gates still decide success. |
| W0.3 | In progress | Deterministic-first multi-agent hardening. | Productive AI requires an explicit Orchestrator assist decision; budgets and evidence lineage are visible. |
| W1 | Planned | Broader enterprise hardening. | More COBOL coverage, richer mainframe semantics, stronger model governance, and larger bounded agent patterns. |

## Current W0.3 Target

W0.3 exists to remove ambiguity from AI participation:

- deterministic baseline first;
- no implicit agent activation from model availability;
- explicit assist-decision gate;
- reason codes for transformation assist;
- separate assist, repair, and model invocation budgets;
- Evidence Pack records why AI was used and whether deterministic verification
  accepted the result;
- UI distinguishes deterministic-only from AI-assisted runs.

## Documentation Rule

Do not duplicate GitHub issues in the repository.

Repo docs are allowed only when they define one of these:

- product invariant;
- architecture decision;
- externally consumed contract;
- configuration needed to run the product;
- executable release or verification rule that cannot live in code alone.

Everything else belongs in code, tests, schemas, scripts, GitHub issues, or not
at all.
