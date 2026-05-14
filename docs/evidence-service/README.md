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
| `wave` | yes | Pinned to `"w0"` so consumers reject future-wave fields. |
| `status` | yes | `complete` only when every required artifact is populated. |
| `createdAt` | yes | UTC RFC 3339 timestamp. |
| `artifacts.sourceCobol` | **yes** | One or more references to ingested COBOL source files. |
| `artifacts.corpusMetadata` | optional | Pointer to the corpus index entry used for the run. |
| `artifacts.semanticIr` | **yes** | Reference to the Semantic IR document. |
| `artifacts.transformationPasses` | optional | Ordered list of transformation pass outputs. |
| `artifacts.generatedJava` | **yes** | Reference to the generated Java project bundle. |
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

A pack is `complete` only when **all** of the following resolve to non-empty
references:

- `sourceCobol`
- `semanticIr`
- `generatedJava`
- `buildTestResults`
- `harnessEvents`
- `modelInvocations`

Missing artifacts move the manifest to `status: "incomplete"` and surface in
`validation.missingArtifacts`. The service refuses to export an incomplete
pack with `422 Unprocessable Entity` so consumers never receive a half-bundle
that looks complete.

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
- Golden Master fixtures for the W0 corpus are synthetic until GnuCOBOL
  fixtures land — packs surface this through `openAssumptions` entries
  reported by `build-test-runner-service`.
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
