# c2c : COBOL-to-Code

Experience Learning Harness · Open Source · Open Weight · EU Sovereignty

Think Big, Start Small.

This repository is the W0 platform foundation for a polyglot service mesh that prepares and validates COBOL-to-code migrations.
The initial walking skeleton is intentionally constrained, deterministic, and reproducible.

## W0 Repository Architecture

The W0 architecture is organized as a microservice repository with one service skeleton per supported runtime:

- `services/java/w0-service` (Java 21 + Maven)
- `services/cobol-parser-service` (Java 21 + Maven, W0 COBOL S0/S1 parser)
- `services/semantic-ir-service` (Java 21 + Maven, Semantic IR v0 normalizer)
- `services/go/w0-service` (Go 1.22 + Modules)
- `services/agentic-harness-core` (Go control-plane for registries and run-state)
- `services/python/w0-service` (Python 3.12 + stdlib tests)
- `services/typescript/w0-service` (TypeScript + Node 20)

W0 remains **Java-first for platform orchestration**, while every additional target language must follow the
`target-generator contract` defined in this repository (scripts, folder layout, artifact naming, and CI checks).

## Bootstrap (Local)

A clean checkout can be prepared with:

```bash
./scripts/bootstrap.sh
./scripts/validate-platform.sh
```

### Required tooling (optional per language when you touch that service)

- Bash-compatible shell
- Git 2.31+
- Java 21 + Maven 3.9+
- Go 1.22+
- Python 3.12+
- Node.js 20+
- Docker (for container checks and local image builds)

The bootstrap script verifies repository health and prints per-service command helpers.

### Local dev sweet-spot setup (recommended)

Use this setup to keep development fast while retaining reproducible behavior:

- Go 1.26+
- Java 21 + Maven 3.9+
- Rust (via `rustup`, usually latest stable)
- Docker for container/runtime validation

```bash
# Install/refresh toolchain (macOS/Homebrew)
brew install go maven openjdk@21 rustup-init

# Configure Java 21 and Rust in this shell
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
export CPPFLAGS="-I/opt/homebrew/opt/openjdk@21/include"
source "$HOME/.cargo/env"

# Repository bootstrap + checks
./scripts/bootstrap.sh
./scripts/go-check.sh
./scripts/java-check.sh
./scripts/python-check.sh
./scripts/typescript-check.sh
./scripts/license-sbom.sh
```

Minimal validation (run on every new machine/session):

```bash
go version
mvn -v
java -version
cargo --version
docker --version
./scripts/bootstrap.sh
```

## Service commands

```bash
# Java
./scripts/java-check.sh

# Go
./scripts/go-check.sh

# Python
./scripts/python-check.sh

# TypeScript
./scripts/typescript-check.sh
```

### Shared checks

```bash
# Security + dependency visibility baseline
./scripts/license-sbom.sh

# Full local verification (best effort)
make ci-checks
```

Alternatively:

```bash
make dev-check
```

## Product-Mode Local Stack

Start the full local stack from the repository root with one command:

```bash
./scripts/start-c2c-local.sh
```

The launcher builds the required artifacts, starts the local capability mesh,
and brings up the Nuxt Studio at `http://127.0.0.1:3000` with the BFF API on
`http://127.0.0.1:18089`. The BFF still builds the legacy `apps/c2c-ui/dist`
bundle for the older reference-run surface, but the local product entrypoint
for W0.1 is the Studio shell. The launcher uses explicit non-conflicting
defaults and writes all run state under `var/c2c-local/`:

- Logs: `var/c2c-local/logs/`
- PIDs: `var/c2c-local/pids/`
- Ready marker: `var/c2c-local/ready`
- Harness, experience-learning, evidence, and model-gateway ledgers and
  artifacts: `var/c2c-local/`

The BFF comes up in live product mode by wiring its orchestrator and evidence
URLs to the local services. When the stack is ready, the launcher prints
exactly:

```text
c2c local application ready: http://127.0.0.1:3000
```

To stop the stack:

```bash
./scripts/stop-c2c-local.sh
```

For CI or other automation, use:

```bash
./scripts/start-c2c-local.sh --ci
```

Automation can wait on `var/c2c-local/ready`, then verify the Studio shell and
`GET /api/v0/health`
and `GET /api/v0/mode` on the BFF before shutting the stack down.

Launcher overrides are documented in `.env.example`:

- `C2C_LOCAL_VAR_DIR`
- `C2C_LOCAL_READY_MARKER`
- `C2C_LOCAL_*_PORT`
- `C2C_LOCAL_HARNESS_TOKEN`
- `C2C_LOCAL_MODEL_GATEWAY_ENABLED`

## CI and quality gates

Pull request CI runs:

- Repository hygiene and bootstrap validation
- Per-language lint and unit-test gate (service touched in W0 layout)
- Secret scan baseline (`patterns.yaml` + `secret` linter)
- Dependency manifest generation
- License + SBOM artifact generation

The baseline is intentionally lightweight for W0 and tuned for predictability.

## Artifact and versioning

W0 artifacts are versioned by convention using SemVer + git revision:

`<service>-<lang>-v<major>.<minor>.<patch>-<sha>-<yyyymmddThhmmssZ>`

Examples:

- `w0-service-java-v0.1.0-7f3c2a1-20260514T101010Z`
- `w0-service-python-v0.1.0-7f3c2a1-20260514T101010Z`

The canonical version source is `artifacts/build-metadata.json`, produced by the CI scripts.

## Repo layout map

```text
.github/
  workflows/
    ci.yml                 # foundational pull checks
    platform-baseline.yml  # language, supply-chain and artifact gates
services/
  go/w0-service/
  java/w0-service/
  cobol-parser-service/
  semantic-ir-service/
  python/w0-service/
  typescript/w0-service/
scripts/
  bootstrap.sh
  ci-checks.sh
  go-check.sh
  java-check.sh
  license-sbom.sh
  python-check.sh
  typescript-check.sh
  secret-scan.sh
  build-metadata.sh
docs/
  corpus/
  governance/
  adr/
```

## W0 safety constraints

See CONTRIBUTING.md for issue, branch, PR, and ADR workflow entrypoints.

- No customer source code in W0.
- No externally sourced data is required to run W0 services.
- Public examples and templates used here are only those explicitly approved for W0.
- Every change must be traceable to an issue and PR.
