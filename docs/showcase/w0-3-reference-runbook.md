# W0.3 Reference Runbook

This runbook is the procedural companion to the
[Orchestrator W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md).
It is the recipe a developer or reviewer follows to verify the
deterministic-first multi-agent hardening end-to-end from a clean checkout.

It is **additive** to the [W0.2 Reference Runbook](w0-2-reference-runbook.md):
all W0.2 stack-bring-up, oracle, and evidence-pack steps remain valid. This
document covers only what changed under W0.3 — the assist-decision gate,
budget hardening, and the new evidence-pack lineage — and how to confirm each
of them in practice.

> Issues: [#214](https://github.com/oscharko-dev/c2c-PreBeta/issues/214) ·
> [#215](https://github.com/oscharko-dev/c2c-PreBeta/issues/215) ·
> [#216](https://github.com/oscharko-dev/c2c-PreBeta/issues/216) ·
> [#217](https://github.com/oscharko-dev/c2c-PreBeta/issues/217) ·
> [#218](https://github.com/oscharko-dev/c2c-PreBeta/issues/218) ·
> [#222](https://github.com/oscharko-dev/c2c-PreBeta/issues/222)

## Scope

W0.3 hardens behaviour without expanding the supported COBOL subset. This
runbook therefore reuses the W0.2 fixtures
(`hello-w02.cbl`, `branch-account-guard.cbl`, `fileio-unsupported.cbl`) and
adds W0.3-specific assertions on top:

1. The product path never activates the productive Transformation Agent
   implicitly from `C2C_MODEL_GATEWAY_URL`.
2. The assist-decision gate fires on every run that reaches the baseline,
   recording a closed-set `outcome` and `reasonCode` on the contract.
3. Three bounded budgets are visible per run with monotonic consumption.
4. The Evidence Pack carries `artifacts.assistDecision` and
   `artifacts.budgetSummary`.
5. The Studio surfaces the gate causally without breaking the
   deterministic-only success affordance.

## Prerequisites

| Tool        | Why                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| `bash`      | Launcher and gate scripts are Bash. macOS and Linux are supported.     |
| `python3`   | Runs the gate's evidence validator and several supporting scripts.    |
| `curl`      | Probes BFF endpoints during the runbook.                              |
| `jq`        | Parses JSON responses for the assist-decision and budget assertions. |
| `node`/`npm` | Required only when running the Studio Playwright suite.              |
| `mvn`, `cobc`/`cobcrun`, `java 21`, `go 1.23+` | Required by the local product stack and CI to build the services and run the COBOL oracle. |

The repository bootstrap script verifies the toolchain:

```bash
make bootstrap
```

## Environment

The W0.3 budget caps are clamped on config load, so a mis-set environment
value cannot escape the documented caps. Defaults are the values the
orchestrator ships with.

| Variable | Default | W0.3 purpose |
| --- | --- | --- |
| `ORCHESTRATOR_REPAIR_BUDGET_MAX` | `2` | Per-run verification/repair iteration cap. Range `[1, 3]`. |
| `ORCHESTRATOR_ASSIST_BUDGET_MAX` | `1` | Per-run productive-assist activation cap. Range `[1, 3]`. |
| `ORCHESTRATOR_MODEL_INVOCATION_BUDGET_MAX` | `6` | Per-run Model Gateway invocation cap (transformation + each repair). Range `[1, 20]`. |
| `C2C_MODEL_GATEWAY_URL` | (unset) | **Infrastructure-only** as of W0.3 ([#213](https://github.com/oscharko-dev/c2c-PreBeta/issues/213)). Setting it does **not** activate the productive Transformation Agent. |
| `AZURE_FOUNDRY_ENDPOINT` / `AZURE_FOUNDRY_API_KEY` | (none) | Required only when exercising the productive `--foundry` mode. Never commit. |

All other W0.2 variables documented in the
[W0.2 reference runbook](w0-2-reference-runbook.md#environment) are unchanged.

## One-command reproduction

W0.3 currently rides on the W0.2 release-gate script. The script's workflow
assertion enforces `used + remaining == limit` for all three budgets and
verifies the new lineage fields on the Evidence Pack:

```bash
# Deterministic, no Foundry credentials. CI runs this on every PR.
./scripts/w0-2-release-gate.sh
```

Exit codes are inherited from the W0.2 gate (see
[W0.2 reference runbook](w0-2-reference-runbook.md#one-command-reproduction)).
A dedicated `w0-3-release-gate.sh` is owned by
[#224](https://github.com/oscharko-dev/c2c-PreBeta/issues/224) and will land
under the W0.3 closure evidence package.

## Verifying the W0.3 behaviour

The product run lifecycle stays unchanged: the Studio submits a transform via
`POST /api/v0/transform`, polls `GET /api/v0/runs/{runId}` for the lightweight
summary, and reads `GET /api/v0/runs/{runId}/workflow` for the full contract
(see the [BFF API contract](../c2c-bff/w0.2-api-contract.md)). The W0.3
assertions below operate on the same `workflow` endpoint.

### 1. Implicit activation is gone

The deterministic path must complete with `useTransformationAgent`
**absent** on the orchestrator input even when `C2C_MODEL_GATEWAY_URL` is
configured. Submit `branch-account-guard.cbl` without an explicit
`useTransformationAgent` field on the request body and confirm:

```bash
curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/workflow" \
  | jq '.contract.assistDecision.reasonCode'
# Expected: "caller_did_not_opt_in"
```

The BFF test suite enforces this directly
(`services/c2c-bff/src/server.test.ts` — "does not implicitly activate the
transformation agent when Model Gateway is enabled").

### 2. The assist-decision gate fires

Every run that reaches the deterministic baseline records an
`assistDecision` on the contract:

```bash
curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/workflow" \
  | jq '{
      outcome: .contract.assistDecision.outcome,
      reasonCode: .contract.assistDecision.reasonCode,
      decidedAt: .contract.assistDecision.decidedAt,
      role: .contract.assistDecision.selectedAgentRole
    }'
```

Acceptance:

- `outcome` is `assist_required` or `assist_not_required`.
- `reasonCode` is a member of the closed set defined in the
  [contract](../contracts/orchestrator-w03-workflow.md#deterministic-uncertainty-reason-codes).
- `decidedAt` is an ISO-8601 timestamp.
- When `outcome = assist_required` the role is `transformation_agent`;
  when `outcome = assist_not_required` the role is `null`.

For runs that legitimately do not reach the gate (`parse_failed`,
`semantic_ir_failed` before the baseline), the field is `null`. The
`fileio-unsupported.cbl` blocked-path fixture exercises this branch.

### 3. Budgets surface with monotonic consumption

The three budgets are exposed on the workflow view:

```bash
curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/workflow" \
  | jq '{
      repair: .contract.repairBudget,
      assist: .contract.assistBudget,
      modelInvocation: .contract.modelInvocationBudget
    }'
```

Acceptance:

- For every budget, `limit == used + remaining`.
- `used` is monotonic across polls — it never decreases between snapshots
  for the same run.
- On a deterministic-only success path both `assistBudget.used` and
  `modelInvocationBudget.used` remain `0`.
- The gate-time snapshots on `assistDecision.{repair,assist,modelInvocation}BudgetSnapshot`
  satisfy `snapshot.used <= final.used` for every budget (the live budget
  never regresses past its gate-time observation).

### 4. Evidence Pack carries the W0.3 lineage

For a non-blocked W0.2 run, the Evidence Pack must carry both
`artifacts.assistDecision` and `artifacts.budgetSummary`:

```bash
# Resolve the pack manifest from the run record:
MANIFEST=$(curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/evidence" \
  | jq -r '.manifestRef.path')

jq '{
  assistDecision: .artifacts.assistDecision,
  budgetSummary: .artifacts.budgetSummary
}' "${MANIFEST}"
```

Acceptance:

- `artifacts.assistDecision` mirrors the run-contract gate snapshot exactly
  (`outcome`, `reasonCode`, `decidedAt`, optional `selectedAgentRole`,
  optional `rationale`, plus the three budget snapshots).
- `artifacts.budgetSummary.{repair,assist,modelInvocation}` each carries the
  end-of-run `{ limit, used, remaining }` triple.
- For blocked runs that did not reach the gate (e.g.
  `fileio-unsupported.cbl` ⇒ `parse_failed` or `unsupported_cobol`),
  `assistDecision` may be absent but `budgetSummary` must still be present.

The validator script
[`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py)
enforces these rules in both `--success` and `--blocked` modes and is run by
the release gate.

### 5. Referential integrity holds

Two cross-artifact invariants are enforced by evidence-service:

- **Budget monotonicity**: a pack whose
  `budgetSummary.{repair,assist,modelInvocation}.used` is *lower* than the
  matching gate-time snapshot on `assistDecision` is rejected.
- **Agent-role backing**: a pack with `assistDecision.outcome = assist_required`
  and `selectedAgentRole = transformation_agent` must reference at least one
  `modelInvocations[]` entry with `agentRole = transformation`.

You can sanity-check both on a pack with `jq`:

```bash
jq '
  .artifacts.assistDecision as $d
  | .artifacts.budgetSummary as $b
  | {
      budgetsAreMonotonic:
        ($b.repair.used          >= $d.repairBudgetSnapshot.used) and
        ($b.assist.used          >= $d.assistBudgetSnapshot.used) and
        ($b.modelInvocation.used >= $d.modelInvocationBudgetSnapshot.used),
      agentBackedByInvocation:
        ($d.outcome != "assist_required")
        or ([.artifacts.modelInvocations[]? | select(.agentRole=="transformation")] | length > 0)
    }
' "${MANIFEST}"
```

Both fields should report `true` on every healthy pack.

### 6. Studio surfaces the gate causally

Open the Studio at `http://localhost:${C2C_LOCAL_STUDIO_PORT:-3000}` and
navigate to the run's Agent Activity panel. The panel must render:

- An `AssistDecisionRow` with the outcome badge and reason-code description.
- A mode badge: `deterministic-only` when `outcome = assist_not_required`,
  `ai-assisted` when `outcome = assist_required`.
- Three budget rows (`RepairBudgetRow`, `AssistBudgetRow`,
  `ModelInvocationBudgetRow`), each with progress styling.
- For a run that completed with `outcome = assist_required` but
  `completenessStatus = evidence_incomplete`, the **Verified** affordance is
  NOT shown. This is the deterministic-first invariant: AI assist never
  unlocks verified success.

The Playwright spec
[`apps/c2c-studio/tests/e2e/w0-3-assist-decision.spec.ts`](../../apps/c2c-studio/tests/e2e/w0-3-assist-decision.spec.ts)
asserts the deterministic-only, assist-required, and AI-assisted-but-incomplete
scenarios.

## Foundry-backed verification

To exercise the productive path end-to-end against Microsoft Foundry, export
the secrets and rerun the gate with `--foundry`:

```bash
export AZURE_FOUNDRY_ENDPOINT=https://<foundry-resource>.cognitiveservices.azure.com/openai/deployments
export AZURE_FOUNDRY_API_KEY_REF=keyring/foundry/API_KEY
./scripts/w0-2-release-gate.sh --foundry
```

In `--foundry` mode the gate submits **HELLOW02** with
`useTransformationAgent = true`. The W0.3 assertions then become:

- `assistDecision.outcome = assist_required`.
- `assistDecision.reasonCode` is one of the deterministic-uncertainty codes
  or `caller_explicit_opt_in`.
- `assistBudget.used = 1` and `modelInvocationBudget.used ≥ 1`.
- `artifacts.modelInvocations[]` contains at least one entry with
  `agentRole = transformation` and `status = completed`.

## Exhaustion paths

Two W0.3 behaviours are best exercised in isolation. Both are covered by
orchestrator unit tests; the local recipe below makes them reproducible by
hand.

### Assist-budget exhaustion (`assist_budget_exhausted`)

Set the assist budget to `1` (the default) and submit two runs with
`useTransformationAgent = true` against the same orchestrator process. The
second run still records the gate but degrades:

```bash
curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/workflow" \
  | jq '.contract.assistDecision | { outcome, reasonCode }'
# Expected: { "outcome": "assist_not_required", "reasonCode": "assist_budget_exhausted" }
```

The deterministic baseline is the final candidate and the run still
completes deterministically on the success path.

### Model-invocation-budget exhaustion

Set `ORCHESTRATOR_MODEL_INVOCATION_BUDGET_MAX=1` and submit a run that needs
both a productive transformation and at least one repair iteration. The
repair loop refuses the next gateway call before it reaches the gateway:

```bash
curl -sf "http://localhost:${C2C_LOCAL_BFF_PORT:-18089}/api/v0/runs/${RUN_ID}/workflow" \
  | jq '{
      classification: .contract.finalClassification,
      failureCode: .contract.failureCode,
      modelBudget: .contract.modelInvocationBudget,
      repairTrail: [.contract.repairAttempts[]?.repairDecision]
    }'
# Expected: classification "blocked", originating failure code preserved,
# modelInvocationBudget.remaining 0, repairTrail ending in "refuse".
```

The originating build-test or oracle failure code is preserved on
`failureCode`. The repair-trajectory entry is tagged
`model_invocation_budget_exhausted`.

## Updating this runbook

The runbook is intentionally narrow: it does not duplicate orchestrator,
BFF, or evidence-service unit tests. When the W0.3 contract changes:

1. Update the canonical
   [W0.3 contract](../contracts/orchestrator-w03-workflow.md) first.
2. Update the BFF surface in
   [`docs/c2c-bff/w0.2-api-contract.md`](../c2c-bff/w0.2-api-contract.md).
3. Update [`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json)
   if a new lineage field is required.
4. Update [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py)
   if a new evidence-pack assertion is required.
5. Re-record this runbook only when a new environment variable, command, or
   assertion is introduced.

## See also

- [Orchestrator W0.3 Workflow Contract](../contracts/orchestrator-w03-workflow.md) — the canonical run contract this runbook verifies.
- [c2c-bff W0.2/W0.3 API contract](../c2c-bff/w0.2-api-contract.md) — the BFF surface exercised by the `curl` commands above.
- [W0.2 reference runbook](w0-2-reference-runbook.md) — stack bring-up, Studio Playwright suite, troubleshooting.
- [ADR 0003: W0.3 Deterministic-First Multi-Agent Hardening](../adr/0003-w0-3-deterministic-first-multi-agent-hardening.md) — the architectural decision this runbook verifies in practice.
