# W0 Artifact Naming and Versioning

## Format

`<service>-<language>-v<major>.<minor>.<patch>-<git_sha>-<timestamp>`

- `service`: immutable service identifier (`w0-service`)
- `language`: one of `java`, `python`, `go`, `typescript`
- `major.minor.patch`: semantic version of service contract (start at `0.1.0`)
- `git_sha`: current git commit SHA (short)
- `timestamp`: UTC timestamp `YYYYMMDDTHHMMSSZ`

## Generation

`./scripts/build-metadata.sh <service> <language>` prints the canonical artifact base name.

## Visibility

All generated artifacts are versioned metadata and include:

- service directory
- language and revision
- generation timestamp
- manifest hashes for CI reproducibility
