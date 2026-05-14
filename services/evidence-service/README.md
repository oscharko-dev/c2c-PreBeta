# evidence-service

W0 capability service that assembles an **Evidence Pack manifest v0** for each
COBOL-to-Java migration run. The manifest references every input,
transformation, generated artifact, model invocation, runtime version, and
verification result by URI and sha256 so the bundle is reproducible and
auditable without copying raw payloads or secrets.

## Responsibility

1. Accept artifact references from the orchestrator and other W0 services
   (`cobol-parser-service`, `semantic-ir-service`,
   `target-java-generation-service`, `build-test-runner-service`).
2. Maintain an in-memory pack store keyed by `packId` (`epk-<runId>-<seq>`).
3. Continuously re-evaluate the W0 required artifact set on create and patch.
4. Emit Harness Events (`evidence.pack.created`, `evidence.pack.updated`,
   `evidence.pack.exported`) using the v0 envelope shape so the agentic
   harness can ingest them via `POST /v0/events`.
5. Export the manifest as a directory or deterministic tar archive. Exports
   are refused when the pack is still incomplete.

The service is intentionally Go-first per Issue #14 engineering notes.

## Endpoints

- `GET /v0/health`
- `GET /v0/ready`
- `GET /v0/packs`
- `POST /v0/packs`
- `GET /v0/packs/{packId}`
- `PATCH /v0/packs/{packId}`
- `POST /v0/packs/{packId}/validate`
- `POST /v0/packs/{packId}/export`
- `GET /v0/events`

See [`openapi.yaml`](./openapi.yaml) for the full request/response shapes and
[`../../schemas/evidence-pack-manifest-v0.json`](../../schemas/evidence-pack-manifest-v0.json)
for the canonical manifest schema.

## Required W0 artifacts

A pack is considered `complete` only when every entry below resolves to a
non-empty reference. Anything missing is reported in
`validation.missingArtifacts` and the manifest status flips to `incomplete`.

| Field | Source |
|-------|--------|
| `sourceCobol` | `cobol-parser-service` ingest |
| `semanticIr` | `semantic-ir-service` |
| `generatedJava` | `target-java-generation-service` |
| `buildTestResults` | `build-test-runner-service` |
| `harnessEvents` | `agentic-harness-core` JSONL ledger |
| `modelInvocations` | `model-gateway-service` model invocation ledger |

Optional fields cover `corpusMetadata`, `transformationPasses`,
`runtimeVersion`, `sbom`, `licenseReports`, `trajectoryLedger`, and
`experienceEvents`. Open semantic assumptions and unsupported features can be
attached to the manifest at any point in the run.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `EVIDENCE_PORT` | `8080` | HTTP listen port |
| `EVIDENCE_EVENT_LOG_PATH` | `data/evidence-events-v0.jsonl` | JSONL Harness event sink (falls back to in-memory if the path cannot be opened) |
| `EVIDENCE_EXPORT_DIR` | `data/evidence-exports` | Root directory for directory/tar exports. Destination paths are constrained to stay under this root. |

## Safety constraints

- The manifest never embeds raw secrets, model prompts, or generated code —
  every artifact is referenced by URI and sha256 only.
- Export destinations are constrained to the configured `EVIDENCE_EXPORT_DIR`;
  `..` traversal and arbitrary absolute paths are rejected with `400`.
- Exports require `validation.ok == true`; an incomplete pack returns `422`.
- JSON request bodies use `DisallowUnknownFields` to surface drift early.

## Run locally

```bash
cd services/evidence-service
go test ./...
go run .
```

## Sample manifest

A worked W0 example lives at
[`docs/evidence-service/sample-evidence-pack-manifest.json`](../../docs/evidence-service/sample-evidence-pack-manifest.json),
along with documentation of the W0 limitations in
[`docs/evidence-service/README.md`](../../docs/evidence-service/README.md).
