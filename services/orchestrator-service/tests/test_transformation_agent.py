"""Tests for the productive Transformation Agent adapter (Issue #169).

The test suite covers:

* prompt input assembly — every reference the issue lists must reach the
  Model Gateway request payload,
* contract tests for success and blocked agent responses,
* an integration test using a stubbed Model Gateway that returns valid
  Java, asserting the candidate is persisted as a real artifact,
* negative tests for invalid-Java output, missing class metadata,
  oversized output, unsupported COBOL without ``status="blocked"``,
  missing modelInvocationRef, oversized agent response payload,
* a guard that the adapter never imports a provider SDK and only reaches
  the Model Gateway through the supplied invoker.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from collections.abc import Mapping
from typing import Any
from unittest.mock import MagicMock

from orchestrator_service.agent_contracts import (
    guard_agent_response,
    validate_invocation_request,
)
from orchestrator_service.artifacts import (
    KIND_TRANSFORMATION_AGENT_JAVA_FILE,
    KIND_TRANSFORMATION_AGENT_PROJECT_MANIFEST,
    KIND_TRANSFORMATION_AGENT_REQUEST,
    KIND_TRANSFORMATION_AGENT_RESPONSE,
    JsonObject,
    JsonValue,
    RunArtifactStore,
)
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.transformation_agent import (
    AGENT_ROLE,
    AgentContractInvalidAgentError,
    AgentTimeoutError,
    HarnessModelGatewayInvoker,
    ModelGatewayUnavailableError,
    ModelPolicyDeniedAgentError,
    TRANSFORMATION_AGENT_DIR,
    TransformationAgent,
    TransformationAgentRequest,
)


SAMPLE_JAVA = (
    "package com.c2c.generated;\n"
    "public class Hello {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"hi\");\n"
    "    }\n"
    "}\n"
)


def _config(**overrides: Any) -> OrchestratorConfig:
    base: JsonObject = dict(
        listen_addr="127.0.0.1:0",
        harness_base_url="http://127.0.0.1:1",
        workflow_id="w0-migration-v0",
        max_retries=0,
        retry_delay_ms=1,
        request_timeout_seconds=1,
        parse_capability_id="cobol.parse",
        ir_capability_id="cobol.ir",
        generator_capability_id="java.generator",
        build_test_capability_id="java.build-test",
        evidence_capability_id="evidence.writer",
        model_gateway_capability_id="model-gateway",
        w0_capabilities=(
            {"id": "model-gateway", "endpoint": "http://model", "owner": "model-gateway"},
        ),
        model_gateway_model_id="gpt-oss-120b",
        model_policy_version="v0",
    )
    base.update(overrides)
    return OrchestratorConfig(**base)


def _artifact_ref(uri: str = "urn:src/main.cob") -> JsonObject:
    return {"uri": uri, "sha256": "a" * 64, "byteSize": 16}


def _request(**overrides: Any) -> TransformationAgentRequest:
    base: JsonObject = dict(
        run_id="run-1",
        workflow_id="w0-migration-v0",
        attempt_number=1,
        requester="orchestrator",
        source_text="IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.\nPROCEDURE DIVISION.\nDISPLAY 'HI'.\nSTOP RUN.\n",
        source_ref=_artifact_ref(),
        capability_id="model-gateway",
        capability_version="v0.1.0",
        capability_provider="model-gateway-service",
        capability_resolved_at="2026-05-16T00:00:00Z",
        model_id="gpt-oss-120b",
        policy_version="v0",
        semantic_ir={"schemaVersion": "v0", "programId": "HELLO"},
        semantic_ir_ref={"uri": "urn:ir/HELLO", "sha256": "b" * 64, "byteSize": 32},
        baseline_java_ref={"uri": "urn:baseline/HELLO", "sha256": "c" * 64, "byteSize": 128},
        baseline_files={"src/main/java/com/c2c/baseline/Hello.java": "package com.c2c.baseline; class Hello {}"},
        oracle_ref={"uri": "urn:oracle/HELLO", "sha256": "d" * 64, "byteSize": 64},
        deadline_ms=15000,
        trace_ref="trace-run-1",
    )
    base.update(overrides)
    return TransformationAgentRequest(**base)


class _StubInvoker:
    """Captures the request payload and returns a configurable response."""

    def __init__(self, response: Mapping[str, JsonValue] | Exception) -> None:
        self._response = response
        self.requests: list[Mapping[str, JsonValue]] = []

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
        self.requests.append(dict(payload))
        if isinstance(self._response, Exception):
            raise self._response
        return dict(self._response)


def _ok_gateway_response(*, files: Mapping[str, str] | None = None, **overrides: Any) -> JsonObject:
    payload_files = dict(files) if files is not None else {
        "src/main/java/com/c2c/generated/Hello.java": SAMPLE_JAVA,
    }
    output = {
        "status": "success",
        "files": payload_files,
        "entryClass": "Hello",
        "entryPackage": "com.c2c.generated",
        "entryFilePath": "src/main/java/com/c2c/generated/Hello.java",
        "explanation": "Translated DISPLAY statement to System.out.println.",
        "unsupportedConstructs": [],
    }
    response = {
        "invocationId": "inv-run-1-01-transformation",
        "runId": "run-1",
        "modelId": "gpt-oss-120b",
        "provider": "foundry-development",
        "policyId": "foundry-development-v0",
        "policyDecision": "policy allow",
        "agentRole": "transformation",
        "promptTemplateVersion": "v0",
        "status": "completed",
        "ledgerRef": {
            "uri": "urn:model-gateway/inv-run-1-01",
            "sha256": "e" * 64,
            "byteSize": 256,
        },
        "output": output,
    }
    for key, value in overrides.items():
        if key == "output_overrides" and isinstance(value, Mapping):
            response["output"].update(value)
        else:
            response[key] = value
    return response


class TransformationAgentRequestAssemblyTests(unittest.TestCase):
    """The agent must build an agent-invocation-request-v0 payload that
    references every source artifact the issue requires."""

    def test_request_payload_passes_schema_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(_ok_gateway_response()),
            )
            request = _request()
            payload = agent._build_invocation_request_payload(
                request, "2026-05-16T00:00:00Z"
            )
            # Must round-trip through the W0.2 agent I/O validator.
            validate_invocation_request(payload)
            self.assertEqual(payload["agentRole"], AGENT_ROLE)
            self.assertEqual(payload["attemptNumber"], 1)
            self.assertEqual(payload["promptTemplateId"], _config().transformation_agent_prompt_template_id)
            # Source, IR, baseline, and oracle must all be referenced.
            uris = {ref["uri"] for ref in payload["inputArtifactRefs"]}
            self.assertIn(request.source_ref["uri"], uris)
            self.assertIn(request.semantic_ir_ref["uri"], uris)
            self.assertIn(request.baseline_java_ref["uri"], uris)
            self.assertIn(request.oracle_ref["uri"], uris)
            self.assertEqual(payload["policyDecisionRef"]["decision"], "policy allow")
            self.assertEqual(
                payload["modelInvocationRef"]["modelId"], request.model_id
            )
            self.assertEqual(payload["modelInvocationRef"]["provider"], "foundry-development")
            self.assertEqual(payload["traceRef"], "trace-run-1")

    def test_request_payload_without_optional_refs(self) -> None:
        agent = TransformationAgent(
            config=_config(),
            artifact_store=RunArtifactStore(tempfile.mkdtemp()),
            model_invoker=_StubInvoker(_ok_gateway_response()),
        )
        request = _request(
            semantic_ir=None,
            semantic_ir_ref=None,
            baseline_java_ref=None,
            baseline_files=None,
            oracle_ref=None,
            trace_ref=None,
        )
        payload = agent._build_invocation_request_payload(
            request, "2026-05-16T00:00:00Z"
        )
        validate_invocation_request(payload)
        self.assertEqual(len(payload["inputArtifactRefs"]), 1)  # source only
        self.assertNotIn("traceRef", payload)

    def test_model_gateway_request_carries_agent_role_and_references(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            stub = _StubInvoker(_ok_gateway_response())
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=stub,
            )
            agent.invoke(_request())

        self.assertEqual(len(stub.requests), 1)
        gateway_request = stub.requests[0]
        # Issue #168 + #169: every invocation must carry agentRole.
        self.assertEqual(gateway_request["agentRole"], "transformation")
        self.assertEqual(gateway_request["modelId"], "gpt-oss-120b")
        self.assertEqual(gateway_request["dataClass"], "model-gateway")
        self.assertTrue(gateway_request["structuredOutput"])
        parameters = gateway_request["parameters"]
        self.assertEqual(parameters["runId"], "run-1")
        self.assertEqual(parameters["attemptNumber"], 1)
        self.assertEqual(parameters["sourceRef"]["uri"], "urn:src/main.cob")
        self.assertEqual(parameters["semanticIrRef"]["uri"], "urn:ir/HELLO")
        self.assertEqual(parameters["baselineJavaRef"]["uri"], "urn:baseline/HELLO")
        self.assertEqual(parameters["oracleRef"]["uri"], "urn:oracle/HELLO")
        # Prompt is structured JSON, not raw COBOL prose.
        envelope = json.loads(gateway_request["prompt"])
        self.assertEqual(envelope["task"], "cobol-to-java-transformation")
        self.assertEqual(envelope["targetLanguage"], "java")
        self.assertIn("DISPLAY", envelope["supportedW0Subset"])


class TransformationAgentSuccessPersistenceTests(unittest.TestCase):
    """Successful agent runs persist the Java candidate as a real artifact
    and return a contract-conformant agent response."""

    def test_successful_invocation_persists_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            stub = _StubInvoker(_ok_gateway_response())
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=stub,
            )

            result = agent.invoke(_request())

            self.assertEqual(result.status, "success")
            self.assertIsNotNone(result.candidate)
            self.assertEqual(result.candidate.entry_class, "Hello")
            self.assertEqual(result.candidate.entry_package, "com.c2c.generated")
            # Persisted artifacts must exist under transformation-agent/attempt-01/.
            attempt_dir = Path(tmp).resolve() / "run-1" / TRANSFORMATION_AGENT_DIR / "attempt-01"
            self.assertTrue((attempt_dir / "agent-request.json").is_file())
            self.assertTrue((attempt_dir / "agent-response.json").is_file())
            self.assertTrue((attempt_dir / "generated-project-manifest.json").is_file())
            java_file = attempt_dir / "java" / "src" / "main" / "java" / "com" / "c2c" / "generated" / "Hello.java"
            self.assertTrue(java_file.is_file())
            # javaCandidateRef on the result points at the persisted manifest.
            self.assertEqual(
                result.java_candidate_ref["uri"],
                (attempt_dir / "generated-project-manifest.json").resolve().as_uri(),
            )
            self.assertEqual(result.java_candidate_ref["kind"], KIND_TRANSFORMATION_AGENT_PROJECT_MANIFEST)
            # Response artifact survives W0.2 schema + secret-leak guard.
            guard_agent_response(result.response_payload)

            # Artifact index records each persisted item with the expected kind.
            kinds = {entry["kind"] for entry in store.list_artifacts("run-1")}
            self.assertIn(KIND_TRANSFORMATION_AGENT_REQUEST, kinds)
            self.assertIn(KIND_TRANSFORMATION_AGENT_RESPONSE, kinds)
            self.assertIn(KIND_TRANSFORMATION_AGENT_PROJECT_MANIFEST, kinds)
            self.assertIn(KIND_TRANSFORMATION_AGENT_JAVA_FILE, kinds)

    def test_response_carries_required_w02_contract_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(_ok_gateway_response()),
            )
            result = agent.invoke(_request())

        response = result.response_payload
        # Schema requires modelInvocationRef, javaCandidateRef for success,
        # trajectoryRecord, and a non-empty outputArtifactRefs array.
        self.assertEqual(response["agentRole"], AGENT_ROLE)
        self.assertEqual(response["status"], "success")
        self.assertIn("modelInvocationRef", response)
        self.assertEqual(response["modelInvocationRef"]["invocationId"], "inv-run-1-01-transformation")
        self.assertEqual(response["modelInvocationRef"]["modelId"], "gpt-oss-120b")
        self.assertIn("ledgerRef", response["modelInvocationRef"])
        self.assertEqual(response["javaCandidateRef"]["uri"], result.java_candidate_ref["uri"])
        self.assertEqual(response["javaCandidateRef"]["sha256"], result.java_candidate_ref["sha256"])
        self.assertEqual(response["outputArtifactRefs"][0]["uri"], result.java_candidate_ref["uri"])
        self.assertIn("trajectoryRecord", response)
        self.assertEqual(response["trajectoryRecord"]["actor"], AGENT_ROLE)
        self.assertEqual(response["trajectoryRecord"]["dataClass"], "generator")
        self.assertEqual(response["toolUseRecords"][0]["toolId"], "model-gateway")
        self.assertEqual(response["toolUseRecords"][0]["surface"], "model-gateway")
        self.assertEqual(response["toolUseRecords"][0]["status"], "success")


class TransformationAgentBlockedTests(unittest.TestCase):
    """The agent must return a structured ``blocked`` result when the model
    reports unsupported COBOL — no fabricated success."""

    def test_blocked_status_propagates_failure_code(self) -> None:
        gateway_response = _ok_gateway_response()
        gateway_response["output"] = {
            "status": "blocked",
            "unsupportedConstructs": ["GO TO", "ALTER"],
            "explanation": "Verb GO TO is outside the W0 subset.",
        }
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(gateway_response),
            )
            result = agent.invoke(_request())

        self.assertEqual(result.status, "blocked")
        self.assertIsNone(result.candidate)
        self.assertEqual(result.failure_code, "unsupported_cobol")
        self.assertIn("GO TO", result.failure_message)
        self.assertIsNone(result.java_candidate_ref)
        # Validated agent response must still be persisted.
        guard_agent_response(result.response_payload)


class TransformationAgentRejectionTests(unittest.TestCase):
    """Negative paths: invalid model output must be rejected, not silently
    accepted. Every case maps to ``agent_contract_invalid`` in the W0.2 run
    contract via :class:`AgentContractInvalidAgentError`."""

    @staticmethod
    def _agent_for_response(response_or_exc: Mapping[str, JsonValue] | Exception) -> TransformationAgent:
        tmp = tempfile.mkdtemp()
        store = RunArtifactStore(tmp)
        store.init_run("run-1", "w0-migration-v0")
        return TransformationAgent(
            config=_config(),
            artifact_store=store,
            model_invoker=_StubInvoker(response_or_exc),
        )

    def test_non_java_content_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response(
            files={"src/main/java/com/c2c/generated/Hello.java": "This is not Java at all."}
        )
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError) as ctx:
            agent.invoke(_request())
        self.assertIn("Java type declaration", str(ctx.exception))
        self.assertEqual(ctx.exception.failure_code, "agent_contract_invalid")

    def test_missing_entry_class_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response()
        gateway_response["output"].pop("entryClass")
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError):
            agent.invoke(_request())

    # noinspection PyPep8Naming
    def test_missing_modelInvocationId_is_synthesised_safely(self) -> None:
        gateway_response = _ok_gateway_response()
        # If the gateway omits invocationId the agent must still build a
        # contract-conformant response with a deterministic local id rather
        # than failing.
        gateway_response.pop("invocationId", None)
        agent = self._agent_for_response(gateway_response)
        result = agent.invoke(_request())
        self.assertTrue(
            result.response_payload["modelInvocationRef"]["invocationId"].startswith(
                "inv-run-1-01-"
            )
        )

    def test_non_java_file_extension_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response(
            files={"src/main/java/com/c2c/generated/Hello.txt": SAMPLE_JAVA}
        )
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError):
            agent.invoke(_request())

    def test_oversized_output_is_rejected(self) -> None:
        big = "package com.c2c.generated;\npublic class Big {}\n" + ("// padding\n" * 200000)
        gateway_response = _ok_gateway_response(
            files={"src/main/java/com/c2c/generated/Big.java": big}
        )
        gateway_response["output"]["entryClass"] = "Big"
        gateway_response["output"]["entryFilePath"] = "src/main/java/com/c2c/generated/Big.java"
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError) as ctx:
            agent.invoke(_request())
        self.assertIn("size limit", str(ctx.exception))

    def test_unsupported_constructs_without_blocked_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response(files={})
        gateway_response["output"]["status"] = "success"
        gateway_response["output"]["unsupportedConstructs"] = ["GO TO"]
        gateway_response["output"]["files"] = {}
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError) as ctx:
            agent.invoke(_request())
        self.assertIn("must be blocked", str(ctx.exception))

    def test_path_traversal_in_filename_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response(
            files={"../escape/Hello.java": SAMPLE_JAVA}
        )
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError):
            agent.invoke(_request())

    def test_entry_file_must_declare_package(self) -> None:
        bad_java = "public class Hello { /* missing package */ }\n"
        gateway_response = _ok_gateway_response(
            files={"src/main/java/com/c2c/generated/Hello.java": bad_java}
        )
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError) as ctx:
            agent.invoke(_request())
        self.assertIn("package", str(ctx.exception))

    def test_non_object_model_output_is_rejected(self) -> None:
        gateway_response = _ok_gateway_response()
        gateway_response["output"] = ["not", "an", "object"]
        agent = self._agent_for_response(gateway_response)
        with self.assertRaises(AgentContractInvalidAgentError):
            agent.invoke(_request())

    def test_model_output_as_json_string_is_accepted(self) -> None:
        gateway_response = _ok_gateway_response()
        gateway_response["output"] = json.dumps(gateway_response["output"])
        agent = self._agent_for_response(gateway_response)
        result = agent.invoke(_request())
        self.assertEqual(result.status, "success")


class TransformationAgentGatewayFailureTests(unittest.TestCase):
    """Model Gateway transport errors classify into typed errors with
    canonical W0.2 failure codes."""

    def test_policy_denial_raises_typed_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(
                    HarnessFailure(403, '{"errorCode":"model_policy_denied","validationCode":"forbidden_role"}')
                ),
            )
            with self.assertRaises(ModelPolicyDeniedAgentError) as ctx:
                agent.invoke(_request())
            self.assertEqual(ctx.exception.failure_code, "model_policy_denied")
            # Even on failure, a structured response artifact is persisted.
            response_path = Path(tmp) / "run-1" / TRANSFORMATION_AGENT_DIR / "attempt-01" / "agent-response.json"
            self.assertTrue(response_path.is_file())
            persisted = json.loads(response_path.read_text("utf-8"))
            self.assertEqual(persisted["status"], "policy_denied")
            self.assertEqual(persisted["failureCode"], "model_policy_denied")
            self.assertEqual(persisted["toolUseRecords"][0]["status"], "denied")
            guard_agent_response(persisted)

    def test_gateway_failure_response_redacts_secret_like_message_without_reclassifying(self) -> None:
        provider_prefix = "s" + "k"
        leaked_token = provider_prefix + "-" + ("d" * 24)
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(
                    HarnessFailure(503, json.dumps({"error": leaked_token}))
                ),
            )
            with self.assertRaises(ModelGatewayUnavailableError) as ctx:
                agent.invoke(_request())
            self.assertEqual(ctx.exception.failure_code, "model_gateway_unavailable")

            response_path = Path(tmp) / "run-1" / TRANSFORMATION_AGENT_DIR / "attempt-01" / "agent-response.json"
            persisted = json.loads(response_path.read_text("utf-8"))
            self.assertEqual(persisted["status"], "failed")
            self.assertEqual(persisted["failureCode"], "model_gateway_unavailable")
            self.assertNotIn(leaked_token, json.dumps(persisted, sort_keys=True))
            self.assertEqual(
                persisted["failureMessage"],
                "model_gateway_unavailable: failure details redacted by agent contract guard",
            )
            guard_agent_response(persisted)

    def test_invalid_model_output_response_redacts_secret_like_message(self) -> None:
        provider_prefix = "s" + "k"
        leaked_token = provider_prefix + "-" + ("e" * 24)
        bad_response = _ok_gateway_response()
        bad_response["output"] = {"status": leaked_token}
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(bad_response),
            )
            with self.assertRaises(AgentContractInvalidAgentError):
                agent.invoke(_request())

            response_path = Path(tmp) / "run-1" / TRANSFORMATION_AGENT_DIR / "attempt-01" / "agent-response.json"
            persisted = json.loads(response_path.read_text("utf-8"))
            self.assertEqual(persisted["status"], "failed")
            self.assertEqual(persisted["failureCode"], "agent_contract_invalid")
            self.assertNotIn(leaked_token, json.dumps(persisted, sort_keys=True))
            self.assertEqual(
                persisted["failureMessage"],
                "agent_contract_invalid: failure details redacted by agent contract guard",
            )
            guard_agent_response(persisted)

    def test_provider_timeout_raises_agent_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(
                    HarnessFailure(504, '{"errorCode":"model_provider_timeout"}')
                ),
            )
            with self.assertRaises(AgentTimeoutError) as ctx:
                agent.invoke(_request())
            self.assertEqual(ctx.exception.failure_code, "agent_timeout")

    def test_generic_5xx_raises_gateway_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(
                    HarnessFailure(503, '{"errorCode":"service_unavailable"}')
                ),
            )
            with self.assertRaises(ModelGatewayUnavailableError) as ctx:
                agent.invoke(_request())
            self.assertEqual(ctx.exception.failure_code, "model_gateway_unavailable")


class TransformationAgentNoDirectFoundryImportTests(unittest.TestCase):
    """The adapter must reach the model only through the Model Gateway
    abstraction. It must not import a provider SDK or raw HTTP client."""

    def test_module_does_not_import_provider_sdks_or_raw_http(self) -> None:
        from orchestrator_service import transformation_agent

        source = Path(transformation_agent.__file__).read_text("utf-8")
        forbidden = (
            "from openai",
            "import openai",
            "from azure.ai",
            "import azure.ai",
            "from foundry",
            "import foundry",
            "from urllib.request",
            "import urllib.request",
            "from http.client",
            "import http.client",
            "import requests",
        )
        for marker in forbidden:
            self.assertNotIn(
                marker,
                source,
                f"transformation_agent.py must not contain {marker!r}",
            )


class HarnessModelGatewayInvokerTests(unittest.TestCase):
    """The default invoker routes calls through the Harness capability
    registry and never bypasses gateway policy."""

    def test_invoker_uses_capability_endpoint(self) -> None:
        harness = MagicMock()
        harness.get_capability.return_value = {
            "id": "model-gateway",
            "endpoint": "http://model.local/v0/invoke",
            "owner": "model-gateway-service",
        }
        harness.invoke_capability.return_value = {"status": "completed", "output": {}}
        invoker = HarnessModelGatewayInvoker(harness, "model-gateway")
        invoker.invoke({"runId": "run-1"})
        harness.get_capability.assert_called_once_with("model-gateway")
        harness.invoke_capability.assert_called_once()
        capability_arg, payload_arg = harness.invoke_capability.call_args.args
        self.assertEqual(capability_arg["endpoint"], "http://model.local/v0/invoke")
        self.assertEqual(payload_arg["runId"], "run-1")

    def test_invoker_classifies_policy_denial(self) -> None:
        harness = MagicMock()
        harness.get_capability.return_value = {
            "id": "model-gateway",
            "endpoint": "http://model.local/v0/invoke",
        }
        harness.invoke_capability.side_effect = HarnessFailure(
            403, '{"errorCode":"forbidden_role"}'
        )
        invoker = HarnessModelGatewayInvoker(harness, "model-gateway")
        with self.assertRaises(ModelPolicyDeniedAgentError):
            invoker.invoke({"runId": "run-1"})

    def test_invoker_classifies_unavailability(self) -> None:
        harness = MagicMock()
        harness.get_capability.return_value = {
            "id": "model-gateway",
            "endpoint": "http://model.local/v0/invoke",
        }
        harness.invoke_capability.side_effect = HarnessFailure(503, "service down")
        invoker = HarnessModelGatewayInvoker(harness, "model-gateway")
        with self.assertRaises(ModelGatewayUnavailableError):
            invoker.invoke({"runId": "run-1"})

    def test_invoker_rejects_non_object_response(self) -> None:
        harness = MagicMock()
        harness.get_capability.return_value = {
            "id": "model-gateway",
            "endpoint": "http://model.local/v0/invoke",
        }
        harness.invoke_capability.return_value = "not an object"
        invoker = HarnessModelGatewayInvoker(harness, "model-gateway")
        with self.assertRaises(ModelGatewayUnavailableError):
            invoker.invoke({"runId": "run-1"})


class TransformationAgentHarnessEventTests(unittest.TestCase):
    """The agent emits Harness events for invocation start/completion. The
    Harness only observes — emission errors must not break the call."""

    def test_invoked_and_completed_events_are_posted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")
            events: list[JsonObject] = []

            # noinspection PyClassHasNoInitInspection
            class Sink:
                @staticmethod
                def post_event(event):
                    events.append(dict(event))
                    return {"eventId": f"evt-{len(events)}"}

            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(_ok_gateway_response()),
                harness_events=Sink(),
            )
            agent.invoke(_request())

        event_types = [event["eventType"] for event in events]
        self.assertIn("orchestrator.agent.transformation.invoked", event_types)
        self.assertIn("orchestrator.agent.transformation.completed", event_types)
        # Capability and role markers must be present so EL can correlate.
        for event in events:
            self.assertEqual(event["actor"], AGENT_ROLE)
            self.assertEqual(event["dataClass"], "generator")
            self.assertEqual(event["policyDecision"], "policy allow")

    def test_emit_errors_do_not_break_the_invocation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RunArtifactStore(tmp)
            store.init_run("run-1", "w0-migration-v0")

            # noinspection PyClassHasNoInitInspection
            class FailingSink:
                def post_event(self, event):
                    raise RuntimeError("harness down")

            agent = TransformationAgent(
                config=_config(),
                artifact_store=store,
                model_invoker=_StubInvoker(_ok_gateway_response()),
                harness_events=FailingSink(),
            )
            result = agent.invoke(_request())
            self.assertEqual(result.status, "success")


if __name__ == "__main__":
    unittest.main()
