# c2c : COBOL-to-Code

Experience Learning Harness · Open Source · Open Weight · EU Sovereignty

Think Big, Start Small.

This repository is the W0/W0.1/W0.2 foundation and current W0.3 hardening line
for a polyglot service mesh that prepares and validates COBOL-to-code
migrations. The implemented product path is intentionally constrained,
deterministic-first, and reproducible; W0.2 added the first productive AI-agent
transformation loop and W0.3 hardens explicit assist decisions.
Deterministic capabilities and model-backed agents are not separate product
paths: both run through the global Orchestrator, which is a deterministic state
machine rather than an LLM.

The Harness is the long-term differentiation layer: shared infrastructure,
governance, ledgers, and Experience Learning. It observes agent, tool, model,
artifact, and verification outcomes, learns which patterns work, and exposes
those signals to orchestrators and agents. The Orchestrator still controls each
workflow; the Harness does not become a hidden workflow engine.

Architecture shorthand: deterministic services are used whenever their
semantics are known; LLMs enter through bounded agent steps only when they add
value. Later LLM-based Team Leads or Planner Agents may coordinate specialist
agents inside an Orchestrator-approved step, but they never replace the global
Orchestrator and never bypass deterministic build/test/evidence gates.

Minimal concept and roadmap:

- [c2c Fachkonzept](docs/concept/c2c-fachkonzept.md)
- [Development workflow governance](docs/governance/development-workflow.md)
- `scripts/w0-reference-run.sh`
- `scripts/w0-2-release-gate.sh`
- [W0.3 orchestrator workflow contract](docs/contracts/orchestrator-w03-workflow.md)

## Repository Architecture

The product path is a deterministic-first capability mesh behind the BFF and
Studio:

Repository topology policy for the housekeeping migration stream is defined in
[ADR 0008](docs/adr/0008-repository-topology-and-service-taxonomy.md).

- `apps/c2c-studio` is the current Next.js Studio UI.
- `apps/c2c-ui` is the older static reference workbench still served by the BFF.
- `services/c2c-bff` is the browser boundary.
- `services/orchestrator-service` owns run sequencing, assist decisions,
  budgets, repair loops, and final classification.
- `services/cobol-parser-service`, `services/semantic-ir-service`,
  `services/target-java-generation-service`,
  `services/build-test-runner-service`, and `services/evidence-service` are the
  deterministic proof path.
- `services/agentic-harness-core`, `services/experience-learning-service`, and
  `services/model-gateway-service` provide registry, policy, ledgers,
  learning signals, and governed model access.
- `libs/c2c-target-java-runtime` is linked by generated Java projects.
- `services/reference/w0-service-java`, `services/reference/w0-service-go`,
  `services/reference/w0-service-python`, and
  `services/reference/w0-service-typescript` remain language baseline services
  for the W0 platform checks.

W0 remains Java-first for the target runtime. Target-generation compatibility
is enforced by service code, schemas, runtime metadata, and tests, not by a
separate copied contract document.

## Service Catalog

`config/service-catalog.json` is the machine-readable inventory for current
product components, W0 reference services, and the generated Java runtime. It
records the current live filesystem path for each component together with
language, package manager, validation-relevant contract files, ownership,
runtime role, and release-gate participation. Each entry keeps a stable `id`
separate from the current live `path`, which lets the repository describe
today's layout without pretending that future migration targets already exist.
For Issue #328, the same catalog is also the ownership map for service
`openapi` files and shared root schemas declared through `schemas`; see
[Contract and Schema Ownership](docs/governance/contract-ownership.md).
Fixture and corpus ownership are documented separately in
[Fixture and Golden-Master Ownership](docs/governance/fixture-ownership.md).
Dependency and license visibility is catalog-driven: each component records its
`packageManifest`, `dependencyManifest`, and `supplyChainParticipation`, and
`scripts/license-sbom.sh` resolves the live paths from that metadata instead of
relying on hand-maintained path lists.

The catalog follows the topology policy in
[ADR 0008](docs/adr/0008-repository-topology-and-service-taxonomy.md). Validate
it with:

```bash
python3 scripts/validate-service-catalog.py
```

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
and brings up the Next.js Studio at `http://127.0.0.1:3000` with the BFF API on
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

## Wave status

| Wave | Status  | Product meaning                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0   | Done    | Deterministic COBOL-to-Java enterprise kernel: parser, Semantic IR, Java generation, build/test, evidence, Harness, Experience Learning telemetry, and no required model call.                                                                                                                                                                                                                                                                          |
| W0.1 | Done    | Next.js/Tailwind c2c Studio: editable COBOL, BFF-backed transformation run, generated Java artifact view, build/test, evidence, artifacts, and honest blocked states.                                                                                                                                                                                                                                                                                   |
| W0.2 | Done    | First productive AI transformation loop on the Experience Learning Harness: orchestrator-steered Transformation and Verification/Repair Agents, Model Gateway/Foundry calls, bounded repair, first read-only learning signals, deterministic verification/evidence gate, and an executable release gate at [`scripts/w0-2-release-gate.sh`](scripts/w0-2-release-gate.sh).                                                                              |
| W0.3 | In progress | Deterministic-first multi-agent hardening: explicit assist decisions, no implicit productive agent activation from model availability, stricter budgets, and Evidence/UI lineage while deterministic verification remains the only path to success. See [ADR 0003](docs/adr/0003-w0-3-deterministic-first-multi-agent-hardening.md) and [W0.3 workflow contract](docs/contracts/orchestrator-w03-workflow.md). |

The W0/W0.1 product can transform supported W0 COBOL programs and selected
small custom sources that stay inside the implemented subset. It must not be
described as a feature-complete COBOL translator. W0.2 is responsible for the
first real model-backed agent workflow and the first read-only learning signals;
W0.3 hardens deterministic-first multi-agent control; W1 and later waves then
broaden custom COBOL coverage and Experience Learning maturity on top of that
cleaner control model.

## CI and quality gates

Pull request CI runs:

- Repository hygiene and bootstrap validation
- Per-language lint, build, and unit-test gates
- Secret diff scanning for changed files
- Monaco lazy-load verification for the Studio bundle

Additional quality workflows are scoped by cost and signal:

- Studio browser quality, performance, memory, and visual gates run only for
  Studio-relevant changes.
- Markdown link checks run only for documentation changes.
- Full platform-baseline, full repository secret scan, and Qodana static
  analysis run on schedule or manual dispatch.

The baseline is intentionally lightweight for W0 and tuned for predictability.

## Artifact and versioning

W0 artifacts are versioned by convention using SemVer + git revision:

`<service>-<lang>-v<major>.<minor>.<patch>-<sha>-<yyyymmddThhmmssZ>`

Examples:

- `w0-service-java-v0.1.0-7f3c2a1-20260514T101010Z`
- `w0-service-python-v0.1.0-7f3c2a1-20260514T101010Z`

The local convention is produced by `scripts/build-metadata.sh`. The stable
artifact stem is the catalog component `id`, followed by the compatibility
language tag, version, git SHA, and UTC timestamp, so names stay stable even
when live filesystem paths change. Build and run artifacts for product-mode
runs are materialized under `var/c2c-local/` by the launcher and Orchestrator.

## Repo layout map

```text
.github/
  workflows/
    ci.yml                 # required pull checks
    platform-baseline.yml  # scheduled/manual full language baseline
    secret-scan.yml        # scheduled/manual full credential scan
apps/
  c2c-studio/
  c2c-ui/
services/
  cobol-parser-service/
  semantic-ir-service/
  target-java-generation-service/
  build-test-runner-service/
  evidence-service/
  orchestrator-service/
  c2c-bff/
  agentic-harness-core/
  experience-learning-service/
  model-gateway-service/
  reference/
    w0-service-go/
    w0-service-java/
    w0-service-python/
    w0-service-typescript/
libs/
  c2c-target-java-runtime/
config/
corpus/
fixtures/
schemas/
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
  adr/
  configuration/
  contracts/
  concept/
  corpus/
  evidence-service/
  governance/
```

## Safety constraints

See CONTRIBUTING.md for issue, branch, PR, and ADR workflow entrypoints.

- No customer source code in W0.
- No externally sourced data is required to run W0 services.
- Public examples and templates used here are only those explicitly approved for W0.
- Every change must be traceable to an issue and PR.
- Any change to wave scope, architecture, model participation, agent workflow,
  or release acceptance must update the [c2c Fachkonzept](docs/concept/c2c-fachkonzept.md)
  and the development workflow where applicable.
- When adding, renaming, or removing a service or component, update
  `config/service-catalog.json`, related path references, and affected docs or
  tests in the same change, using the current live filesystem path rather than a
  planned future path.
