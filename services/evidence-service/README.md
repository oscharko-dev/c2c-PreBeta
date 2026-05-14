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
| `EVIDENCE_EXPORT_DIR` | `data/evidence-exports` | Root directory for directory/tar exports. **Recommended to set an absolute path** owned exclusively by the service user; relative values are resolved against the process working directory at startup and the resolved path is then symlink-normalized before the containment check. Destinations passed in API calls must be relative and stay under this root. |

## Safety constraints

- The manifest never embeds raw secrets, model prompts, or generated code —
  every artifact is referenced by URI and sha256 only.
- Export destinations must be **relative** paths under the configured
  `EVIDENCE_EXPORT_DIR`; absolute paths and `..` traversal are rejected with
  `400`.
- Export records expose stable `urn:c2c/evidence-export/<name>` URIs instead
  of host-local `file://` paths, so committed manifests do not leak workstation
  or CI filesystem layouts.
- Exports require `validation.ok == true`; an incomplete pack returns `422`.
- JSON request bodies use `DisallowUnknownFields` and are size-capped at
  1 MiB to bound memory use on adversarial input.
- The JSONL event log is opened mode `0o640`; the service is expected to run
  under a dedicated UID/GID.

## Trust boundary

evidence-service v0 has **no built-in authentication or authorization** and
serves plaintext HTTP. It is designed to run cluster-local behind an
authenticating mesh/proxy (mTLS or shared-secret) — never expose it directly
to a public ingress. Customer-facing access is mediated by the orchestrator
and the BFF, which add their own auth layer. Cryptographic signing of the
manifest is intentionally out of scope for v0; consumers rely on artifact
sha256s plus the harness JSONL ledger.

## Run locally

```bash
cd services/evidence-service
go test ./...                          # unit + integration tests
go test ./... -race                    # race-detector pass
go test ./... -bench=. -run=^$         # benchmarks (baseline below)
go run .                               # start service on :8080
```

### Performance baseline (Apple M4 Max, Go 1.26)

| Benchmark | ns/op | B/op | allocs/op |
|-----------|-------|------|-----------|
| `BenchmarkPackStoreCreate` | ~2,950 | ~2,370 | 23 |
| `BenchmarkPackStoreGet` | ~232 | ~1,230 | 8 |
| `BenchmarkExportDirectory` | ~55,000 | ~13,650 | 97 |
| `BenchmarkEvaluateValidation` | ~27 | 96 | 1 |

Use these numbers as a regression baseline when bumping the toolchain or
refactoring hot paths.

## Sample manifest

A worked W0 example lives at
[`docs/evidence-service/sample-evidence-pack-manifest.json`](../../docs/evidence-service/sample-evidence-pack-manifest.json),
along with documentation of the W0 limitations in
[`docs/evidence-service/README.md`](../../docs/evidence-service/README.md).
