# Developer Memory

- 2026-05-20: Product path is deterministic-first. Do not route productive model calls outside `services/go/model-gateway-service`.
- 2026-05-20: Local validation entrypoints: `./scripts/validate-platform.sh`, `./scripts/go-check.sh`, `./scripts/java-check.sh`, `./scripts/python-check.sh`, `./scripts/typescript-check.sh`.
- 2026-05-20: Keep behavior changes separate from service-layout or CI housekeeping refactors.
