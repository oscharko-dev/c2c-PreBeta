# evidence-service (W0)

The differentiator for regulated COBOL-to-Java migrations is not that an LLM
emitted Java — it is that c2c can prove **what happened** during a run. The
Evidence Pack manifest is the W0 instrument of that proof.

This document describes the v0 manifest fields, the W0 required artifact set,
the export contract, and the known limitations the orchestrator and BFF should
present alongside any pack.

## Where things live

| Item | Path |
|------|------|
| Canonical manifest schema | [`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json) |
| Worked sample manifest | [`sample-evidence-pack-manifest.json`](./sample-evidence-pack-manifest.json) |
| Go service implementation | [`services/evidence-service/`](../../services/evidence-service/) |
| HTTP contract | [`services/evidence-service/openapi.yaml`](../../services/evidence-service/openapi.yaml) |

## Manifest field guide

| Field | Required (W0) | Notes |
|-------|---------------|-------|
| `schemaVersion` | yes | Always `"v0"`. |
| `capability` | yes | Always `"evidence.pack"`. |
| `service` | yes | Issuing service identifier (`evidence-service`). |
| `packId` | yes | `epk-<runId>-<seq>`; stable for the run. |
| `runId` | yes | Cross-references the agentic-harness-core run. |
| `workflowId` | optional | Filled in when the orchestrator created the run with one. |
| `wave` | yes | `"w0"` for the deterministic baseline; `"w0.2"` when productive agents ran. The wave enum controls which completeness rule the service applies. |
| `status` | yes | `complete` only when every required artifact is populated. |
| `completenessStatus` | yes (W0.2) | `complete` / `evidence_incomplete` / `blocked`. Independent of `status` so the orchestrator can distinguish *missing required evidence* from *upstream failure blocked the run*. |
| `classification` | yes (W0.2) | `success` / `evidence_incomplete` / `blocked` / `failed`. A run is success-classifiable **only** when `completenessStatus=complete`; absence of any required artifact forces `evidence_incomplete` (fail closed). |
| `createdAt` | yes | UTC RFC 3339 timestamp. |
| `artifacts.sourceCobol` | **yes** | One or more references to ingested COBOL source files. |
| `artifacts.corpusMetadata` | optional | Pointer to the corpus index entry used for the run. |
| `artifacts.semanticIr` | **yes** | Reference to the Semantic IR document. |
| `artifacts.transformationPasses` | optional | Ordered list of transformation pass outputs. |
| `artifacts.generatedJava` | **yes** | Reference to the final generated Java project bundle (legacy single-ref field). For W0.2 runs the same artifact is mirrored as the selected entry of `generatedJavaArtifacts[]`. |
| `artifacts.generatedJavaArtifacts` | **yes (W0.2)** | One entry per Java candidate persisted during the run: the deterministic baseline, the Transformation Agent's candidate, and each Verification/Repair Agent candidate. Each entry carries `origin`, `attemptNumber`, and `selected`. |
| `artifacts.finalJavaArtifact` | **yes (W0.2)** | The candidate that passed the deterministic gate (or the last attempt before the repair budget was exhausted). Required for `completenessStatus=complete`. |
| `artifacts.repairAttempts` | **yes when ≥1 attempt ran** | One entry per Verification/Repair Agent invocation. Captures `attemptNumber`, `decision`, `decisionRef`, optional `newJavaCandidateRef`, `buildTestResultRef`, and `refusalCode`/`noChange` when applicable. |
| `artifacts.agentTrajectories` | **yes (W0.2)** | Per-agent trajectory ledger references (`orchestrator`, `transformation`, `verification-repair`). Replaces the singular `trajectoryLedger` for W0.2 runs; both fields are populated for backwards compatibility. |
| `artifacts.oracleComparison` | **yes (W0.2)** | Flat envelope summarising the comparison between the Java output and the COBOL oracle / golden master. Carries `matched`, `oracleKind`, `actualSha256`, `expectedSha256`, `classification`, and a pointer to the build/test result. `oracleKind=absent` when no oracle was available. |
| `artifacts.runtimeVersion` | optional | Target Java runtime coordinate plus optional reference. |
| `artifacts.modelInvocations` | **yes** | One entry per model invocation; each carries a pointer to the model-invocation-ledger record. The ledger holds the structured request/response references — the evidence pack never embeds raw prompts or completions. |
| `artifacts.buildTestResults` | **yes** | References to `build-test-runner-service` results. |
| `artifacts.sbom` | optional | SBOM document references (CycloneDX, SPDX). |
| `artifacts.licenseReports` | optional | License/policy report references. |
| `artifacts.harnessEvents` | **yes** | Reference to the harness JSONL event log for the run. |
| `artifacts.trajectoryLedger` | optional | Reference to the agent trajectory ledger snapshot. |
| `artifacts.experienceEvents` | optional | One entry per emitted Experience Event. |
| `openAssumptions` | optional | Semantic assumptions the run is taking; surface in UI. |
| `unsupportedFeatures` | optional | Features encountered but not supported in W0. |
| `validation` | yes | `{ ok, requiredArtifacts, missingArtifacts, messages }`. |
| `exports` | optional | Appended on each `POST /v0/packs/{id}/export`. |

The full set of structural rules is in
[`schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json).
The Go service mirrors those rules in
[`services/evidence-service/manifest.go`](../../services/evidence-service/manifest.go).

## Required artifact set

### W0 (deterministic baseline, `wave="w0"`)

A pack is `complete` only when **all** of the following resolve to non-empty
references:

- `sourceCobol`
- `semanticIr`
- `generatedJava`
- `buildTestResults`
- `harnessEvents`
- `modelInvocations`

### W0.2 (productive agents, `wave="w0.2"`)

Issue #171 extends the required set for productive-agent runs. A
`completenessStatus=complete` requires every entry below:

- `sourceCobol`
- `semanticIr`
- `generatedJava` *(legacy single ref preserved for backwards compatibility)*
- `generatedJavaArtifacts` *(every persisted candidate)*
- `finalJavaArtifact` *(the selected candidate)*
- `buildTestResults`
- `oracleComparison`
- `harnessEvents`
- `modelInvocations`
- `agentTrajectories`

Missing artifacts move the manifest to `status="incomplete"` and surface in
`validation.missingArtifacts`. W0.2 packs additionally flip
`completenessStatus` to `evidence_incomplete` (fail closed) and
`classification` to `evidence_incomplete`, so a successful-looking run
**cannot** be promoted to `success` while required evidence is absent. The
service refuses to export an incomplete pack with `422 Unprocessable Entity`
so consumers never receive a half-bundle that looks complete.

### Secret scrubbing

Evidence packs are reviewer-visible and MUST NOT contain raw secrets. The
service rejects creates/updates whose `modelInvocations[]` entries embed
values matching well-known credential patterns (OpenAI `sk-...`, AWS
`AKIA...`, GitHub `ghp_.../ghs_...`, Hugging Face `hf_...`, JWT
triplets, PEM `-----BEGIN ... PRIVATE KEY-----` blocks, bearer-token
strings, `api_key=...` assignments). Callers must pre-redact before
posting; evidence-service fails closed with `400 Bad Request` if any field
on a model-invocation reference appears credential-shaped.

## Export contract

`POST /v0/packs/{packId}/export`

| Body field | Default | Meaning |
|------------|---------|---------|
| `format` | `directory` | `directory` writes `manifest.json` at the root; `tar` produces a PAX-format archive with the same single entry. |
| `destination` | auto | Optional path constrained to the configured `EVIDENCE_EXPORT_DIR` root. |

The response returns the updated manifest (with the new `exports[]` entry
appended) and the `ExportRecord` for the latest export. Every successful
export emits an `evidence.pack.exported` Harness Event keyed by the run id.

## Known W0 limitations

- The pack store and event sink are in-memory plus an append-only JSONL log;
  there is no relational catalog yet.
- Cryptographic signing of the manifest is **out of scope for v0**; consumers
  rely on artifact sha256s and the harness JSONL ledger.
- PDF/A audit reports and customer-specific compliance packs are explicitly
  out of scope for Issue #14.
- The W0 corpus has mixed Golden Master provenance: BRNCH01 is reproduced
  through GnuCOBOL `cobcrun`, while CTRLDEC01 and BATCH01 remain synthetic.
  Packs surface this through `openAssumptions` entries reported by
  `build-test-runner-service`.
- The export base directory is local-filesystem; an object-store backed
  exporter is a future-wave concern.

## Orchestrator / BFF integration sketch

1. Orchestrator creates a run on `agentic-harness-core`.
2. Each service (`cobol-parser-service`, `semantic-ir-service`,
   `target-java-generation-service`, `build-test-runner-service`,
   `model-gateway-service`) reports the references for its outputs.
3. Orchestrator opens the pack via `POST /v0/packs` with `runId` and any
   artifacts already known, and PATCHes the pack as more artifacts arrive.
4. When the run terminates, orchestrator calls `POST /v0/packs/{id}/export`
   to materialize a directory or tar archive for the BFF/UI to surface.
5. The BFF presents `status`, `validation`, `openAssumptions`, and
   `unsupportedFeatures` alongside a link to the exported bundle.
