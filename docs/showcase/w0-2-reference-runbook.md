# W0.2 Reference Runbook

Companion to [`docs/release/w0-2-release-gate.md`](../release/w0-2-release-gate.md).
This runbook is the one-command reproduction recipe for a developer or
reviewer who needs to re-derive the W0.2 release-gate outcome from a clean
checkout. It does not replace the W0 reference runbook
([w0-reference-runbook.md](w0-reference-runbook.md)), which is still the
deterministic walking-skeleton recipe for the W0 corpus.

> Issue: [#175](https://github.com/oscharko-dev/c2c-PreBeta/issues/175)

## Prerequisites

| Tool        | Why                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| `bash`      | Launcher and gate scripts are Bash. macOS and Linux are supported.     |
| `python3`   | Runs the gate's evidence validator and several supporting scripts.     |
| `curl`      | Probes BFF endpoints during the gate.                                  |
| `jq`        | Parses JSON responses for assertions.                                  |
| `node`/`npm`| Required only when running the Studio Playwright suite.                |
| `mvn`, `cobc`/`cobcrun`, `java 21`, `go 1.23+` | Required by the local product stack and CI to build the services and run the COBOL oracle. |

The repository bootstrap script verifies the toolchain:

```bash
make bootstrap
```

## Environment

Copy `.env.example` to `.env` and review the values:

```bash
cp .env.example .env
```

The W0.2 gate respects these variables (defaults shown):

| Variable | Default | Purpose |
| --- | --- | --- |
| `C2C_LOCAL_ENV_FILE` | `$PWD/.env` | Env file the launcher sources. |
| `C2C_LOCAL_VAR_DIR` | `var/c2c-local` | Runtime working directory for the launcher. |
| `C2C_LOCAL_READY_MARKER` | `var/c2c-local/ready` | File the launcher writes when the stack is up. |
| `C2C_LOCAL_BFF_PORT` | `18089` | BFF HTTP port. |
| `C2C_LOCAL_STUDIO_PORT` | `3000` | Studio Next.js port. |
| `C2C_LOCAL_MODEL_GATEWAY_ENABLED` | `false` for the gate | Set by the gate; do not hard-code. |
| `C2C_RUN_ARTIFACT_ROOT` | `var/c2c-local/runs` | Where the orchestrator persists run artifacts. |
| `AZURE_FOUNDRY_ENDPOINT` / `AZURE_FOUNDRY_API_KEY` | (none) | Required only for `--foundry` mode. Never commit. |

## One-command reproduction

```bash
# Deterministic, no Foundry credentials. CI runs this on every PR.
./scripts/w0-2-release-gate.sh
```

Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` | All gate assertions passed. |
| `1` | Pre-flight failed (missing tool, secret, port, or fixture). |
| `2` | Local stack failed to come up. |
| `3` | HELLOW02 success path failed an assertion. |
| `4` | FILEIO-UNSUPPORTED blocked path failed an assertion. |
| `5` | Evidence Pack manifest failed the W0.2 completeness contract. |

## Foundry-backed development verification

To verify the Model Gateway can talk to Microsoft Foundry, run the gate
with the `--foundry` flag on a workstation that has the credentials
exported in its shell:

```bash
export AZURE_FOUNDRY_ENDPOINT=https://workspacedevfoundry...cognitiveservices.azure.com/openai/deployments
export AZURE_FOUNDRY_API_KEY=...   # never commit; never persist to memory
./scripts/w0-2-release-gate.sh --foundry
```

The gate refuses to start without those variables. It also refuses to run
in public CI without the secrets, by enabling the Model Gateway only when
`--foundry` is passed; CI omits the flag.

## What the gate checks

The gate is the executable expression of
[`docs/release/w0-2-release-gate.md`](../release/w0-2-release-gate.md).
At a high level:

1. **Stack health.** Launches `scripts/start-c2c-local.sh --ci`, waits for
   the ready marker, asserts the Studio root renders the workbench shell,
   the BFF reports `orchestrator=live`, `evidence=live`, and the
   `/api/v0/harness/ready` endpoint responds. In `--foundry` mode the
   Model Gateway health endpoint must also respond.
2. **HELLOW02 success path.** Submits the canonical W0.2 acceptance
   fixture through `POST /api/v0/transform`, polls `/runs/{runId}/workflow`
   until `finalClassification == "success"`, asserts the contract shape
   (state machine, repair budget, generated/build-test/evidence refs).
3. **Cross-view consistency.** Asserts the `sha256` reported by
   `GeneratedView`, `BuildTestView`, and `EvidenceView` for the same run
   are identical, the progress timeline includes the W0.2 step names
   (with `model-policy-skipped` in the deterministic path), and the run
   artifacts listing exposes the evidence-pack manifest by kind.
4. **Evidence Pack completeness.** Resolves the manifest URI to a local
   path and runs `scripts/check_w0_2_evidence.py --success`. With
   `--foundry` the validator also requires
   `modelInvocations[*].status == "completed"`; without it, the validator
   requires `status == "skipped"`.
5. **FILEIO-UNSUPPORTED blocked path.** Submits the negative fixture and
   asserts `finalClassification == "blocked"`,
   `failureCode == "unsupported_cobol"`, `generatedJavaRef == null`, and
   that the blocked manifest passes the validator's `--blocked` mode.
6. **Foundry capability (optional).** With `--foundry`, runs
   `scripts/foundry-smoke.sh transformation $C2C_MODEL_DEFAULT_DEPLOYMENT`
   to assert the Model Gateway can hold a live conversation with the
   provider.
7. **Cleanup.** Stops the local stack and tails the launcher log on
   failure.

## Re-running the Studio Playwright suite

The Playwright suite is the browser-visible proof for both the W0.1 and
the W0.2 paths. It runs in CI on every PR.

```bash
cd apps/c2c-studio
npm ci --no-fund --no-audit
CI=1 \
  C2C_LOCAL_ENV_FILE="$PWD/../../.env" \
  C2C_LOCAL_MODEL_GATEWAY_ENABLED=false \
  npm run test:e2e:ci
```

The W0.2 spec ([`tests/e2e/w0-2-workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/w0-2-workflow.spec.ts))
asserts:

- HELLOW02 reaches `finalClassification == "success"` from the browser.
- The generated Java pane displays the same `sha256` the BFF advertises.
- The Agent and Evidence Pack tabs render without a failure verdict.
- FILEIO-UNSUPPORTED is blocked honestly: no Java pane, no "Verified",
  and `GeneratedView.status == "unsupported"` with non-empty
  `unsupportedFeatures`.

## Updating the gate

The gate is intentionally narrow: it does not duplicate evidence-service
or orchestrator-service unit tests. When the W0.2 contract changes:

1. Update [`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json)
   first. The release gate validator reads the schema as source-of-truth
   for required fields.
2. Update the contract docs:
   [`orchestrator-w02-workflow.md`](../contracts/orchestrator-w02-workflow.md) and
   [`w0.2-api-contract.md`](../c2c-bff/w0.2-api-contract.md).
3. Update [`scripts/check_w0_2_evidence.py`](../../scripts/check_w0_2_evidence.py)
   only if a new required field needs an explicit assertion.
4. Update [`scripts/w0-2-release-gate.sh`](../../scripts/w0-2-release-gate.sh)
   only for new BFF endpoints or new cross-view consistency checks.
5. Re-record this runbook if a new variable or command is needed.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ready marker did not appear` | Stack failed to bind a port. | Run `./scripts/stop-c2c-local.sh` and rerun. Check `var/c2c-local/launcher.log` for the binding error. |
| `HELLOW02 run did not succeed` | `cobc`/`cobcrun` is not installed locally. | Install GnuCOBOL (`gnucobol3` on Debian/Ubuntu, `gnu-cobol` on Homebrew). |
| `--foundry requires AZURE_FOUNDRY_API_KEY` | Secrets are not in this shell. | `source` your secrets file before re-running. Never commit secrets. |
| `Evidence Pack manifest did not satisfy the W0.2 success contract` | A previous merge regressed evidence emission. | Inspect the printed failures, fix the responsible service, re-run the gate. |
