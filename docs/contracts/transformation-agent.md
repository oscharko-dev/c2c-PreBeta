# Transformation Agent Adapter

**Status:** v0 (Issue [#169](https://github.com/oscharko-dev/c2c-PreBeta/issues/169))
**Owner:** orchestrator-service
**Consumers:** Orchestrator workflow, evidence-service, experience-learning-service,
build-test-runner-service, c2c-bff, c2c-studio UI

## Purpose

W0.2 introduces the first productive AI capability: a COBOL-to-Java
Transformation Agent invoked by the Orchestrator. The agent must be:

- **Orchestrator-invoked.** No part of the system except the Orchestrator
  decides when a transformation agent runs.
- **Policy-governed.** All model calls go through the Model Gateway with
  `agentRole = "transformation"` so the role allowlist from Issue #168
  applies.
- **Contract-validated.** The agent's request and response shapes are the
  ones from Issue #167 (`agent-invocation-request-v0`, `agent-invocation-response-v0`).
- **Artifact-first.** Every Java candidate the agent produces is persisted
  as a real artifact in the run artifact store. Inline text in the agent
  response is a convenience view; the artifact reference is the source of
  truth.
- **Productive, not decorative.** The agent must materially produce or
  improve Java; it does not bypass the deterministic gatekeeper (build/test)
  and never claims behavioural correctness.

## Where the agent lives

The adapter ships inside the Orchestrator service at
[`services/orchestrator-service/src/orchestrator_service/transformation_agent.py`](../../services/orchestrator-service/src/orchestrator_service/transformation_agent.py).
Keeping the adapter in-process for W0.2 is intentional — the boundary is
explicit (one dataclass in, one dataclass out, model gateway as a Protocol)
so the module can be lifted into its own service when W0.3 needs it.

The Orchestrator wires the agent through `W0WorkflowRunner` and invokes it
between the deterministic baseline generator and `build-test`. The run is
opted into the agent path with a per-request flag:

```jsonc
POST /v0/runs
{
  "inputRef": { ... },
  "useTransformationAgent": true
}
```

The default (`false`) preserves the W0 deterministic-only behaviour so
existing callers are unaffected.

## Inputs the agent receives

| Field | Required | Source |
|-------|----------|--------|
| `runId`, `workflowId`, `attemptNumber` | yes | Orchestrator run context |
| `agentRole = "transformation-agent"` | yes | constant |
| `capabilityRef` | yes | model-gateway capability resolved via Harness |
| `promptTemplateId`, `promptTemplateVersion` | yes | configured via `ORCHESTRATOR_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_*` |
| `inputArtifactRefs` | yes (≥1) | content-addressed refs to source COBOL, Semantic IR, deterministic baseline manifest, oracle |
| `policyDecisionRef` | yes | `policy allow` decision stamped at request time |
| `modelInvocationRef` | yes | Provisional invocation id the gateway can reuse. `ledgerRef` is intentionally omitted here because the gateway creates the invocation ledger during the model call; the persisted response must include it. |
| `deadlineMs` | yes | configured per agent (default 30 s) |
| `traceRef` | optional | `trace-{runId}` for Experience Learning correlation |

The request payload is validated against
[`schemas/agent-invocation-request-v0.json`](../../schemas/agent-invocation-request-v0.json)
before the agent does anything else; an invalid request raises
`AgentContractInvalidAgentError` and the orchestrator surfaces
`agent_contract_invalid` on the run contract.

## Model Gateway invocation

The agent never imports a provider SDK. It calls the Model Gateway through
the `model-gateway` capability registered on the Harness. Before prompt
content is sent, the Orchestrator validates that the resolved capability
matches the configured allowlist for id, owner, data class, and exact
`/v0/invoke` endpoint. A registry entry that points somewhere else fails
closed as `model_gateway_unavailable`.

The payload shape is:

```jsonc
{
  "schemaVersion": "v0",
  "runId": "...",
  "agentRole": "transformation",
  "modelId": "gpt-oss-120b",
  "dataClass": "model-gateway",
  "promptTemplateVersion": "v0",
  "prompt": "<JSON envelope referencing promptTemplateId>",
  "structuredOutput": true,
  "structuredOutputSchema": { ... },
  "parameters": {
    "runId": "...",
    "attemptNumber": 1,
    "promptTemplateId": "c2c.transformation-agent.cobol-to-java.v0",
    "sourceRef": { "uri": "...", "sha256": "...", "byteSize": ... },
    "semanticIrRef": { ... },
    "baselineJavaRef": { ... },
    "oracleRef": { ... }
  },
  "timeoutMs": 30000
}
```

`agentRole` is always `"transformation"` so the gateway role policy
applies. Any policy denial (HTTP 403 with a recognised marker) surfaces as
`ModelPolicyDeniedAgentError` and the run finalises as
`failureCode = model_policy_denied`. Provider timeouts surface as
`AgentTimeoutError` with `failureCode = agent_timeout`. Other transport
failures surface as `ModelGatewayUnavailableError` with
`failureCode = model_gateway_unavailable`.

## Outputs the agent must return

The agent calls the Model Gateway with `structuredOutput: true` and the
inner output schema published below. The orchestrator rejects anything
outside that shape.

### Inner structured-output schema

```jsonc
{
  "status": "success" | "blocked" | "failed",
  "files": { "<relative.java path>": "<UTF-8 file body>" },
  "entryClass":     "Foo",
  "entryPackage":   "com.c2c.generated",
  "entryFilePath":  "src/main/java/com/c2c/generated/Foo.java",
  "unsupportedConstructs": ["..."],
  "explanation":    "...",
  "failureCode":    "...",
  "failureMessage": "..."
}
```

### Validation rules

Applied **before** the orchestrator persists or builds:

- `status` must be one of `success`, `blocked`, `failed`.
- For `success`:
  - `files` is non-empty.
  - Every file path is a relative POSIX path ending in `.java`.
  - At least one file contains a Java type declaration
    (`class`/`interface`/`enum`/`record`).
  - `entryClass` is a valid Java identifier.
  - `entryPackage` is a valid dotted Java package; defaults to the
    configured package base when omitted.
  - `entryFilePath` is present in `files` and its body carries a
    `package` declaration.
  - Total `files` byte size ≤ 1 MiB
    (`transformation_agent_max_output_bytes`).
- For `blocked`: `unsupportedConstructs` non-empty; `failureCode` defaults
  to `unsupported_cobol`.
- For `failed`: `failureCode` defaults to `java_generation_failed`.
- A `success` response that includes any `unsupportedConstructs` is
  rejected as `agent_contract_invalid` — unsupported COBOL must be
  reported as `blocked`, never `success`.
- A `blocked` response must include non-empty `unsupportedConstructs`.
- A gateway response without both `invocationId` and `ledgerRef` is
  rejected as `agent_contract_invalid`; the agent must not synthesize
  successful model lineage.
- A response whose serialised form exceeds the global 256 KiB agent-I/O
  limit (Issue #167) is rejected as `agent_contract_invalid` regardless
  of the inner status.
- Any field name resembling a credential (`apiKey`, `accessToken`, …) in
  the response triggers the secret-leak guard from Issue #167.

The final `agent-invocation-response-v0` payload the orchestrator records
is run through `guard_agent_response()` so it must additionally satisfy
the W0.2 agent I/O contract (`agentRole`, `modelInvocationRef`,
`javaCandidateRef` for successful transformations, `trajectoryRecord`,
RFC 3339 timestamps).

## Persisted artifacts

Every attempt writes the following artifacts under
`var/c2c-local/runs/{runId}/transformation-agent/attempt-NN/`:

| Path | Kind | Contents |
|------|------|----------|
| `agent-request.json` | `transformation-agent-request` | validated `agent-invocation-request-v0` |
| `agent-response.json` | `transformation-agent-response` | validated `agent-invocation-response-v0` |
| `generated-project-manifest.json` | `transformation-agent-project-manifest` | manifest with `runId`, `attemptNumber`, `sourceProgramId`, `generationSource = "agent"`, `targetLanguage = "java"`, structured `modelInvocationRef` including ledger reference, `semanticIrRef`, `sourceProgramRef`, per-file sha256/byteSize, `entryClass`, `entryPackage`, `entryFilePath`, `unsupportedConstructs` |
| `java/<path>.java` (each generated file) | `transformation-agent-java-file` | UTF-8 Java source |

The manifest's URI/sha256/byteSize is the value used as `javaCandidateRef`
on the agent response and as `generatedJavaRef` on the W0.2 run contract
when the agent path replaces the baseline.

W0.2 evidence packs must preserve real lineage only. Repair attempts are
included only when the attempt carries its concrete `buildTestResultRef`; the
orchestrator never substitutes a run-level build/test result or synthetic
reference. If verification-repair ran but attempt evidence is missing, the
evidence-service marks the pack `evidence_incomplete` instead of promoting it
to success.

## Workflow integration

```
parse-cobol → generate-ir → baseline generate-java
                              │
                              ▼
              ┌── use_transformation_agent = true ──┐
              │                                     │
              ▼                                     ▼
   transformation-agent.invoked          (deterministic-only path)
              │
              ▼
   transformation-agent.success      →    java_candidate_persisted → build-test
   transformation-agent.blocked      →    run_blocked (no build-test)
   transformation-agent.failed       →    run_blocked / failed
   transformation-agent.policy_denied → run_blocked (model_policy_denied)
   transformation-agent.timeout      →    run_blocked (agent_timeout)
```

When the agent returns `success`, the agent manifest becomes the Java
candidate fed to build-test. The deterministic baseline is preserved as a
referenced artifact for traceability. If the agent returns `blocked` /
`failed` or raises one of the typed errors above, the orchestrator skips
build-test, drives the W0.2 state machine into `run_blocked`, and
finalises the run with the matching failure code from
[`run_contract.py`](../../services/orchestrator-service/src/orchestrator_service/run_contract.py).

## Experience Learning signals

The Harness emits the following observational events for every agent
attempt (no side-effects on the workflow):

- `orchestrator.agent.transformation.invoked` — start, with request ref.
- `orchestrator.agent.transformation.completed` / `.blocked` / `.failed` /
  `.invalid` — end, with response ref, status, failure code, and the
  agent latency in milliseconds.

The agent also stamps a single trajectory record (composable with
`agent-trajectory-ledger-v0`) on the response so the Harness ledger can
absorb it without re-mapping. Together with the Model Invocation Ledger
entry the gateway writes, this gives Experience Learning enough material
to detect repeated no-change attempts, repeated invalid outputs, and
ineffective prompt templates.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `ORCHESTRATOR_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID` | `c2c.transformation-agent.cobol-to-java.v0` | Stable id of the policy-controlled prompt template (registry-owned, never the body) |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION` | `v0` | Version of the template the gateway will render |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_DEADLINE_MS` | `30000` | Per-attempt deadline forwarded to the gateway |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES` | `1048576` | Maximum total byte size of generated Java files |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_PACKAGE_BASE` | `com.c2c.generated` | Default Java package when the model omits `entryPackage` |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_JAVA_VERSION` | `21` | Target Java version stamped on the prompt envelope |
| `ORCHESTRATOR_TRANSFORMATION_AGENT_RUNTIME_LIBRARY` | `c2c-target-java-runtime` | Runtime library the agent's Java is expected to link against |

`ORCHESTRATOR_MODEL_GATEWAY_*` controls the gateway endpoint and model id,
unchanged from Issue #168.

## Stability promise

`schemaVersion: "v0"` is stable. Adding optional fields to the inner
structured output is allowed under `v0`. Adding new agent roles, new
status values, or new failure codes requires bumping the request /
response contract schemas in lockstep (Issue #167) and a matching
orchestrator validator update.
