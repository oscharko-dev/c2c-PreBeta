# W0.2 Release Gate

This document is the go / no-go checklist for closing the W0.2 wave. It is the
final integration proof that the agentic COBOL → Java path is production-ready
on this branch. Every item must be evidenced by a real artifact the reviewer
can re-derive from a clean checkout. Verbal claims and screenshots are not
acceptable.

> Issue: [#175](https://github.com/oscharko-dev/c2c-PreBeta/issues/175) ·
> Parent epic: [#164](https://github.com/oscharko-dev/c2c-PreBeta/issues/164) ·
> W0 baseline gate: [w0-release-gate.md](w0-release-gate.md) ·
> W0.2 workflow contract: [orchestrator-w02-workflow.md](../contracts/orchestrator-w02-workflow.md) ·
> W0.2 BFF contract: [w0.2-api-contract.md](../c2c-bff/w0.2-api-contract.md) ·
> W0.2 acceptance fixtures: [w02-acceptance.md](../corpus/w02-acceptance.md) ·
> Runbook companion: [w0-2-reference-runbook.md](../showcase/w0-2-reference-runbook.md).

## Decision contract

W0.2 is **GO** for closure when, on a clean checkout of `dev`:

1. `./scripts/w0-2-release-gate.sh` exits 0 in the deterministic
   (no-Foundry) configuration. CI runs this gate on every PR. This
   mode uses the deterministic BRNCH01 source for the success-path
   assertions because the productive agentic loop requires the
   Model Gateway, which is intentionally absent in public CI. The
   W0.2 workflow contract envelope and the negative-path
   (FILEIO-UNSUPPORTED) assertion are exercised on every run.
2. `./scripts/w0-2-release-gate.sh --foundry` exits 0 on a developer
   machine that has Microsoft Foundry credentials exported. This
   mode uses the W0.2 acceptance fixture HELLOW02, requires a
   productive `modelInvocations[*].status == "completed"` ledger
   entry, and exercises the full agentic Transformation /
   Verification / Repair path. It is manual and must not happen in
   public CI without secrets.
3. The Studio browser acceptance suite (`apps/c2c-studio/tests/e2e/`)
   reports green for both the legacy W0.1 path
   (`workflow.spec.ts`) and the new W0.2 acceptance path
   (`w0-2-workflow.spec.ts`).
4. The PR closing this issue links a CI run on `dev` showing all the above.

W0.2 is **NO-GO** if any of those exit non-zero, if the scripted gate is
bypassed, or if any item in §"Acceptance Contract" below is unevidenced.

## Acceptance Contract

The gate is an executable specification. Each row below must be true and
must be re-derivable from the artifact path in the right column.

### 1. The local product stack starts with one command

- [x] `./scripts/start-c2c-local.sh --ci` brings the full stack up
      (Harness, evidence-service, experience-learning-service, parser,
      semantic-ir, target-java-generation, build-test-runner,
      model-gateway-service, orchestrator-service, c2c-bff, c2c-studio)
      and writes the readiness marker that points the Studio at
      `http://127.0.0.1:${C2C_LOCAL_STUDIO_PORT:-3000}`.
      _Evidence_: [`scripts/start-c2c-local.sh`](../../scripts/start-c2c-local.sh),
      [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh).

### 2. The BFF is the only browser-facing backend boundary

- [x] The Studio Playwright suite hits only `${NEXT_PUBLIC_C2C_BFF_BASE_URL}`.
      No call goes directly to orchestrator-service, evidence-service,
      experience-learning-service, model-gateway-service, or any other
      downstream port.
      _Evidence_: [`apps/c2c-studio/src/lib/apiClient.ts`](../../apps/c2c-studio/src/lib/apiClient.ts),
      the Playwright specs under [`apps/c2c-studio/tests/e2e/`](../../apps/c2c-studio/tests/e2e/),
      and the BFF OpenAPI surface
      [`services/c2c-bff/openapi.yaml`](../../services/c2c-bff/openapi.yaml).

### 3. The Orchestrator owns the W0.2 workflow contract

- [x] `GET /api/v0/runs/{runId}/workflow` returns a `RunWorkflowView` whose
      `state`, `activeStep`, `activeAgent`, `agentAttemptCount`,
      `repairBudget`, `repairAttempts`, `finalClassification`,
      `failureCode`, `generatedJavaRef`, `buildTestResultRef`, and
      `evidencePackRef` fields conform to the closed sets in
      [`orchestrator-w02-workflow.md`](../contracts/orchestrator-w02-workflow.md).
      The release-gate script asserts the shape and the terminal
      `state == "final_classification"` for the success run.
      _Evidence_: the workflow-contract assertion block in
      [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh).

### 4. The Harness records events and trajectories as infrastructure

- [x] Every Java candidate, repair attempt, agent invocation, and policy
      decision is recorded against the Harness event ledger, model
      invocation ledger, and agent trajectory ledger. The release-gate
      evidence validator
      [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py)
      asserts that the Evidence Pack carries:
      - `artifacts.harnessEvents` (single reference);
      - `artifacts.modelInvocations` (non-empty list of ledger refs);
      - `artifacts.agentTrajectories` (non-empty list with an
        `orchestrator` role entry; the legacy singular `trajectoryLedger`
        no longer satisfies the W0.2 contract on its own).

### 5. Model calls go through the Model Gateway

- [x] The deterministic gate run records a `modelInvocations[*]` entry
      with `status == "skipped"` referencing the no-model policy decision.
      The `--foundry` gate run records a `modelInvocations[*]` entry with
      `status == "completed"`, `provider == "azure_foundry"`, and a
      ledger reference written by the Model Gateway, not by the
      Orchestrator.
      _Evidence_: [`services/go/model-gateway-service`](../../services/go/model-gateway-service),
      [`scripts/foundry-smoke.sh`](../../scripts/foundry-smoke.sh),
      [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py).

### 6. Generated Java is persisted on disk with sha256

- [x] `GeneratedView.artifactRef.sha256`, `BuildTestView.generatedArtifactRef.sha256`,
      and `EvidenceView.generatedArtifactRef.sha256` carry the same
      64-hex-character digest. The Evidence Pack manifest's
      `artifacts.generatedJavaArtifacts[*]` list must contain that digest,
      and the entry flagged `selected: true` must equal
      `artifacts.finalJavaArtifact.sha256`.
      _Evidence_: the consistency-check block in
      [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh) and
      [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py).

### 7. Java compiles and executes through the build/test runner

- [x] `BuildTestView.status == "ok"` and `classification == "match"` for
      the HELLOW02 acceptance fixture, and the build/test result is
      reachable as a hashed artifact through `runs/{runId}/build-test`.
      The pipeline ran the real `cobc`/`cobcrun` oracle, not a synthetic
      shortcut.
      _Evidence_: [`services/build-test-runner-service`](../../services/build-test-runner-service),
      [`fixtures/acceptance/index.json`](../../fixtures/acceptance/index.json) (HELLOW02 entry,
      `oracleGenerationMode == "cobol-runtime"`).

### 8. Behavioural verification runs against an explicit oracle

- [x] `artifacts.oracleComparison.matched == true`,
      `oracleKind ∈ {cobol-runtime, synthetic, true-golden-master}`, and
      `actualSha256 == expectedSha256`.
      _Evidence_:
      [`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json) ·
      validator block in
      [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py).

### 9. The Evidence Pack is complete for successful runs

- [x] The manifest carries `completenessStatus == "complete"` and
      `status == "complete"`, every required slot
      (`sourceCobol`, `semanticIr`, `generatedJava`,
      `buildTestResults`, `harnessEvents`, `modelInvocations`) is
      populated, and the W0.2-specific slots
      (`generatedJavaArtifacts`, `finalJavaArtifact`, `oracleComparison`,
      `agentTrajectories`) are present.
      _Evidence_: the strict `--success` mode of
      [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py).

### 10. The UI shows the result accurately

- [x] The Studio renders the generated Java pane with the same `sha256`
      the BFF advertises, the Build & Test tab shows the W0.2 pipeline
      stages (`Parse COBOL`, `Generate Java`, `Equivalence Analysis`, and
      `Model Policy Skipped` in the deterministic mode), the Agent tab
      shows the agent activity without a final-failure verdict, and the
      Evidence Pack tab shows "Evidence Pack Complete".
      _Evidence_:
      [`apps/c2c-studio/tests/e2e/workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/workflow.spec.ts),
      [`apps/c2c-studio/tests/e2e/w0-2-workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/w0-2-workflow.spec.ts).

### 11. Unsupported source is blocked honestly

- [x] Submitting the `FILEIO-UNSUPPORTED` fixture through
      `POST /api/v0/transform` produces a non-success
      `finalClassification` (`blocked`, `failed`, or `incomplete`), a
      closed-set unsupported-source `failureCode`
      (`unsupported_cobol` or `parse_failed`), **no** generated Java
      artifact, and a Studio surface that does not present any
      "Verified" affordance. The gate accepts either failure code
      because the orchestrator's mapping is owned by Issue #166 and
      may surface unsupported source through the parser-diagnostic
      path (`unsupported_cobol`) or the parser-rejection path
      (`parse_failed`); both are honest non-success classifications.
      _Evidence_: blocked-path block of
      [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh) ·
      blocked-path test in
      [`apps/c2c-studio/tests/e2e/w0-2-workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/w0-2-workflow.spec.ts).

### 12. Logs and artifacts contain no provider credentials

- [x] `scripts/check_w0_2_evidence.py` scans every locally resolvable
      artifact referenced by the manifest for forbidden token shapes
      (`AZURE_FOUNDRY_API_KEY=...`, `Bearer ...`, `sk-...`, `AKIA...`)
      and fails closed if any match. Combined with the repository-wide
      [`scripts/secret-scan.sh`](../../scripts/secret-scan.sh) and the
      [`secret-scan`](../../.github/workflows/secret-scan.yml) workflow,
      this gives a defence-in-depth guarantee that the Evidence Pack
      does not leak secrets.

### 13. Experience Learning emits first read-only signals

- [x] The Experience Learning surface records first-class W0.2 signals
      for the run: tool/capability availability, model invocation
      outcome, agent handoff, repair-loop progress, and generated-Java
      candidate outcome class. The Studio renders these read-only via
      `runs/{runId}/learning` and `runs/{runId}/experience`. The Harness
      MUST NOT take control decisions; the Orchestrator and the
      deterministic gatekeeper remain in charge.
      _Evidence_:
      [`services/experience-learning-service`](../../services/experience-learning-service),
      [`apps/c2c-studio/src/components/observability/ExperienceLearningPanel.tsx`](../../apps/c2c-studio/src/components/observability/ExperienceLearningPanel.tsx),
      run inspection in
      [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh).

### 14. W0/W0.1 gates remain green

- [x] `./scripts/smoke-test-c2c-local.sh` and
      `./scripts/w0-reference-run.sh` still pass on this branch. The W0.2
      gate does not weaken the W0/W0.1 contract; it adds to it.
      _Evidence_: [`w0-release-gate.md`](w0-release-gate.md).

## W0.2 non-scope (must not be claimed)

The release gate intentionally does not claim, and must not be claimed in
marketing, sales, or release notes, the following items. They are out of
scope for W0.2 and remain on the longer roadmap:

- Full COBOL coverage beyond the W0.2 supported subset declared in
  [`docs/corpus/w02-acceptance.md`](../corpus/w02-acceptance.md).
- A productive Experience Learning **decisioning** system. W0.2 ships
  only the first read-only signals.
- Complex mainframe semantics: file I/O, hierarchical databases, CICS,
  IMS, JCL chains, sort/merge utilities, EXEC SQL, EXEC CICS.
- Multiple orchestrators or agent teams. W0.2 ships one Orchestrator and
  one Transformation Agent plus one Verification/Repair Agent in a
  bounded repair loop.
- Target languages other than Java. W0.2 rejects any `targetLanguage`
  other than `java` at the BFF layer.
- Customer onboarding, multi-tenant authentication, or any claim of
  production readiness for arbitrary customer source.

## Re-evidencing this gate

A reviewer can re-derive every "ready" row above with the following
commands on a clean checkout:

```bash
# 1. Repository-level CI mirror
./scripts/ci-checks.sh

# 2. W0 baseline gate (must still pass)
W0_REFERENCE_RUN_ENV_FILE="$PWD/.env" \
  W0_REFERENCE_RUN_MODEL_GATEWAY_ENABLED=false \
  ./scripts/w0-reference-run.sh
C2C_LOCAL_ENV_FILE="$PWD/.env" \
  C2C_LOCAL_MODEL_GATEWAY_ENABLED=false \
  ./scripts/smoke-test-c2c-local.sh

# 3. W0.2 release gate (deterministic / no-Foundry)
C2C_LOCAL_ENV_FILE="$PWD/.env" \
  ./scripts/w0-2-release-gate.sh

# 4. Browser acceptance — both the W0.1 baseline and the W0.2 fixtures
cd apps/c2c-studio && \
  CI=1 \
  C2C_LOCAL_ENV_FILE="$PWD/../../.env" \
  C2C_LOCAL_MODEL_GATEWAY_ENABLED=false \
  npm run test:e2e:ci
```

To re-derive the Foundry-backed development row, on a workstation that has
Microsoft Foundry credentials exported:

```bash
export AZURE_FOUNDRY_ENDPOINT=...    # see .env.example
export AZURE_FOUNDRY_API_KEY=...     # never commit
./scripts/w0-2-release-gate.sh --foundry
```

That command refuses to start if the Foundry secrets are absent. The CI
workflow declines to run it.

## Governance hygiene

- No source for this issue lives outside an issue/PR. Branch:
  `claude/issue-175-w02-release-gate`. PR links back to Issue #175 with
  `Resolves #175`.
- No TODOs or temporary workarounds are merged with this gate. Any
  deferred work is filed as a follow-up issue, not left commented out.
- All required environment variables are documented in
  [`.env.example`](../../.env.example). Secrets are never embedded in
  this document, the gate scripts, the BFF, or the evidence artifacts.
