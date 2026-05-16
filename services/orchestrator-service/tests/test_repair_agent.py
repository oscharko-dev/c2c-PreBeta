"""Tests for the productive Verification/Repair Agent adapter (Issue #170).

The test suite covers:

* repair input assembly — every required and optional reference reaches the
  validated ``agent-repair-input-v0`` payload,
* the propose_candidate happy path (Java persisted, manifest hashed,
  decision conformant with ``agent-repair-decision-v0``),
* refuse and escalate decision paths for each enum value,
* no-change detection: identical-files repair degrades to ``no_change``,
* gateway failure modes (policy denied, unavailable, timeout, malformed
  output) — each persists a synthetic decision artifact and raises the
  typed error,
* invalid candidate envelopes — non-Java content, missing entry class,
  oversized output, path traversal, missing package declaration,
* the model gateway request stamps ``agentRole=verification-repair`` so
  the gateway role policy from Issue #168 applies,
* the module never imports a provider SDK or raw HTTP client.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from collections.abc import Mapping
from typing import Any

from orchestrator_service.agent_contracts import (
    guard_repair_decision,
    validate_repair_input,
)
from orchestrator_service.artifacts import (
    KIND_REPAIR_AGENT_DECISION,
    KIND_REPAIR_AGENT_INPUT,
    KIND_REPAIR_AGENT_JAVA_FILE,
    KIND_REPAIR_AGENT_PROJECT_MANIFEST,
    JsonObject,
    RunArtifactStore,
)
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.repair_agent import (
    DECISION_ESCALATE,
    DECISION_NO_CHANGE,
    DECISION_PROPOSE,
    DECISION_REFUSE,
    MODEL_GATEWAY_AGENT_ROLE,
    REPAIR_AGENT_DIR,
    REPAIR_AGENT_ROLE,
    RepairAgent,
    RepairAgentContractInvalidError,
    RepairAgentGatewayUnavailableError,
    RepairAgentPolicyDeniedError,
    RepairAgentRequest,
    RepairAgentTimeoutError,
)


SAMPLE_JAVA_PREVIOUS = (
    "package com.c2c.generated;\n"
    "public class Hello {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"old\");\n"
    "    }\n"
    "}\n"
)


SAMPLE_JAVA_REPAIRED = (
    "package com.c2c.generated;\n"
    "public class Hello {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"repaired\");\n"
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


def _ref(uri: str = "urn:src/main.cob", *, sha_char: str = "a", byte_size: int = 16) -> JsonObject:
    return {"uri": uri, "sha256": sha_char * 64, "byteSize": byte_size}


def _request(**overrides: Any) -> RepairAgentRequest:
    base: JsonObject = dict(
        run_id="run-1",
        workflow_id="w0-migration-v0",
        attempt_number=1,
        requester="orchestrator",
        previous_java_candidate_ref=_ref("urn:gen/manifest", sha_char="b", byte_size=128),
        previous_java_files={
            "src/main/java/com/c2c/generated/Hello.java": SAMPLE_JAVA_PREVIOUS,
        },
        build_test_result_ref=_ref("urn:build/result", sha_char="c", byte_size=64),
        build_test_payload={"status": "failed", "reason": "java_compile_failed"},
        failure_category="java_compile_failed",
        capability_id="model-gateway",
        capability_version="v0.1.0",
        capability_provider="model-gateway-service",
        capability_resolved_at="2026-05-16T00:00:00Z",
        model_id="gpt-oss-120b",
        policy_version="v0",
        repair_budget_remaining=2,
        source_text="IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.\n",
        source_cobol_ref=_ref("urn:src/main.cob", sha_char="a", byte_size=16),
        semantic_ir={"schemaVersion": "v0", "programId": "HELLO"},
        semantic_ir_ref=_ref("urn:ir/HELLO", sha_char="d", byte_size=32),
        previous_repair_decision_refs=(),
        deadline_ms=15000,
        trace_ref="trace-run-1",
    )
    base.update(overrides)
    return RepairAgentRequest(**base)


class _StubInvoker:
    def __init__(self, response):
        self._response = response
        self.calls: list[JsonObject] = []

    def invoke(self, payload):
        self.calls.append(dict(payload))
        if isinstance(self._response, Exception):
            raise self._response
        return dict(self._response)


def _ok_propose_response(*, files=None, **overrides):
    payload_files = dict(files) if files is not None else {
        "src/main/java/com/c2c/generated/Hello.java": SAMPLE_JAVA_REPAIRED,
    }
    output = {
        "decision": DECISION_PROPOSE,
        "rationale": "Fixed the missing semicolon on line 5.",
        "files": payload_files,
        "entryClass": "Hello",
        "entryPackage": "com.c2c.generated",
        "entryFilePath": "src/main/java/com/c2c/generated/Hello.java",
        "explanation": "Added missing semicolon",
        "unsupportedConstructs": [],
        "confidence": 0.85,
    }
    response = {
        "invocationId": "inv-run-1-01-repair",
        "runId": "run-1",
        "modelId": "gpt-oss-120b",
        "provider": "foundry-development",
        "policyDecision": "policy allow",
        "agentRole": "verification-repair",
        "promptTemplateVersion": "v0",
        "status": "completed",
        "ledgerRef": {
            "uri": "urn:model-gateway/inv-run-1-01-repair",
            "sha256": "e" * 64,
            "byteSize": 256,
        },
        "output": output,
    }
    if "output_overrides" in overrides:
        response["output"].update(overrides.pop("output_overrides"))
    response.update(overrides)
    return response


def _refuse_response(refusal_code: str, *, rationale: str = "Cannot repair safely.") -> JsonObject:
    return _ok_propose_response(
        output_overrides={
            "decision": DECISION_REFUSE,
            "refusalCode": refusal_code,
            "rationale": rationale,
            "files": None,
        }
    )


def _escalate_response(escalation_code: str, *, rationale: str = "Out of scope.") -> JsonObject:
    response = _ok_propose_response(
        output_overrides={
            "decision": DECISION_ESCALATE,
            "escalationCode": escalation_code,
            "rationale": rationale,
        }
    )
    # The escalate envelope must not carry candidate fields per the agent
    # contract; rebuild it cleanly so we don't accidentally satisfy
    # propose_candidate.
    response["output"] = {
        "decision": DECISION_ESCALATE,
        "rationale": rationale,
        "escalationCode": escalation_code,
        "confidence": 0.5,
    }
    return response


# Helper that wires up the agent + a temp store with a single call.
def _agent_for(response_or_exc) -> tuple[RepairAgent, RunArtifactStore, str]:
    tmp = tempfile.mkdtemp()
    store = RunArtifactStore(tmp)
    store.init_run("run-1", "w0-migration-v0")
    agent = RepairAgent(
        config=_config(),
        artifact_store=store,
        model_invoker=_StubInvoker(response_or_exc),
    )
    return agent, store, tmp


# ---------------------------------------------------------------------------
# Input payload assembly
# ---------------------------------------------------------------------------


class RepairAgentRequestAssemblyTests(unittest.TestCase):
    def test_input_payload_passes_schema_validation(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        request = _request()
        payload = agent._build_repair_input_payload(request, "2026-05-16T00:00:00Z")
        validate_repair_input(payload)
        self.assertEqual(payload["schemaVersion"], "v0")
        self.assertEqual(payload["attemptNumber"], 1)
        self.assertEqual(payload["failureCategory"], "java_compile_failed")
        self.assertEqual(payload["repairBudgetRemaining"], 2)
        self.assertEqual(
            payload["previousJavaCandidateRef"]["uri"], "urn:gen/manifest"
        )
        self.assertEqual(payload["semanticIrRef"]["uri"], "urn:ir/HELLO")
        self.assertEqual(payload["sourceCobolRef"]["uri"], "urn:src/main.cob")

    def test_input_payload_omits_optional_refs_when_absent(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        request = _request(
            semantic_ir=None,
            semantic_ir_ref=None,
            source_cobol_ref=None,
            source_text=None,
            previous_repair_decision_refs=(),
        )
        payload = agent._build_repair_input_payload(request, "2026-05-16T00:00:00Z")
        validate_repair_input(payload)
        self.assertNotIn("semanticIrRef", payload)
        self.assertNotIn("sourceCobolRef", payload)

    def test_request_rejects_unknown_failure_category(self):
        with self.assertRaises(ValueError):
            _request(failure_category="bogus_failure")

    def test_request_rejects_zero_attempt_number(self):
        with self.assertRaises(ValueError):
            _request(attempt_number=0)

    def test_request_rejects_invalid_previous_candidate_ref(self):
        with self.assertRaises(ValueError):
            _request(previous_java_candidate_ref={"uri": "x", "sha256": "short"})

    def test_request_rejects_negative_budget(self):
        with self.assertRaises(ValueError):
            _request(repair_budget_remaining=-1)


# ---------------------------------------------------------------------------
# Model Gateway request shape
# ---------------------------------------------------------------------------


class RepairAgentGatewayRequestTests(unittest.TestCase):
    def test_gateway_request_carries_verification_repair_role_and_refs(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        invoker: _StubInvoker = agent._model_invoker  # type: ignore[assignment]
        agent.invoke(_request())
        self.assertEqual(len(invoker.calls), 1)
        call = invoker.calls[0]
        self.assertEqual(call["agentRole"], MODEL_GATEWAY_AGENT_ROLE)
        self.assertEqual(call["agentRole"], "verification-repair")
        self.assertEqual(call["modelId"], "gpt-oss-120b")
        self.assertTrue(call["structuredOutput"])
        params = call["parameters"]
        self.assertEqual(params["failureCategory"], "java_compile_failed")
        self.assertEqual(params["previousJavaCandidateRef"]["uri"], "urn:gen/manifest")
        self.assertEqual(params["buildTestResultRef"]["uri"], "urn:build/result")
        self.assertEqual(params["semanticIrRef"]["uri"], "urn:ir/HELLO")
        self.assertEqual(params["sourceCobolRef"]["uri"], "urn:src/main.cob")
        prompt = json.loads(call["prompt"])
        self.assertEqual(prompt["task"], "java-verification-repair")
        self.assertEqual(prompt["failureCategory"], "java_compile_failed")
        self.assertIn("previousJavaFiles", prompt)


# ---------------------------------------------------------------------------
# propose_candidate persistence
# ---------------------------------------------------------------------------


class RepairAgentProposePersistenceTests(unittest.TestCase):
    def test_propose_persists_files_manifest_and_decision(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        result = agent.invoke(_request())

        self.assertEqual(result.decision, DECISION_PROPOSE)
        self.assertIsNotNone(result.candidate)
        self.assertEqual(result.candidate.entry_class, "Hello")
        self.assertIsNotNone(result.new_java_candidate_ref)
        attempt_dir = Path(tmp).resolve() / "run-1" / REPAIR_AGENT_DIR / "attempt-01"
        self.assertTrue((attempt_dir / "agent-repair-input.json").is_file())
        self.assertTrue((attempt_dir / "agent-repair-decision.json").is_file())
        self.assertTrue((attempt_dir / "generated-project-manifest.json").is_file())
        java_path = (
            attempt_dir / "java" / "src" / "main" / "java" / "com" / "c2c" / "generated" / "Hello.java"
        )
        self.assertTrue(java_path.is_file())
        # Decision artifact must round-trip through the W0.2 guard.
        decision_payload = json.loads(
            (attempt_dir / "agent-repair-decision.json").read_text("utf-8")
        )
        guard_repair_decision(decision_payload)
        self.assertEqual(decision_payload["decision"], DECISION_PROPOSE)
        self.assertIn("newJavaCandidateRef", decision_payload)
        # Persisted manifest is the source of truth for newJavaCandidateRef.
        self.assertEqual(
            decision_payload["newJavaCandidateRef"]["uri"],
            (attempt_dir / "generated-project-manifest.json").resolve().as_uri(),
        )

        # Artifact index records all four kinds.
        kinds = {entry["kind"] for entry in store.list_artifacts("run-1")}
        self.assertIn(KIND_REPAIR_AGENT_INPUT, kinds)
        self.assertIn(KIND_REPAIR_AGENT_DECISION, kinds)
        self.assertIn(KIND_REPAIR_AGENT_JAVA_FILE, kinds)
        self.assertIn(KIND_REPAIR_AGENT_PROJECT_MANIFEST, kinds)

    def test_propose_result_carries_model_invocation_ref(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        result = agent.invoke(_request())
        self.assertEqual(
            result.model_invocation_ref["invocationId"], "inv-run-1-01-repair"
        )
        self.assertEqual(result.model_invocation_ref["modelId"], "gpt-oss-120b")
        self.assertEqual(result.model_invocation_ref["provider"], "foundry-development")
        self.assertIn("ledgerRef", result.model_invocation_ref)


# ---------------------------------------------------------------------------
# refuse / escalate decision paths
# ---------------------------------------------------------------------------


class RepairAgentRefuseAndEscalateTests(unittest.TestCase):
    def test_refuse_with_each_refusal_code(self):
        for code in (
            "no_safe_repair",
            "unsupported_construct",
            "policy_denied",
            "insufficient_context",
        ):
            with self.subTest(refusalCode=code):
                agent, store, tmp = _agent_for(_refuse_response(code))
                result = agent.invoke(_request())
                self.assertEqual(result.decision, DECISION_REFUSE)
                self.assertEqual(result.refusal_code, code)
                self.assertIsNone(result.candidate)
                self.assertIsNone(result.new_java_candidate_ref)
                # Decision artifact validates as agent-repair-decision-v0.
                decision = json.loads(
                    (
                        Path(tmp)
                        / "run-1"
                        / REPAIR_AGENT_DIR
                        / "attempt-01"
                        / "agent-repair-decision.json"
                    ).read_text("utf-8")
                )
                guard_repair_decision(decision)
                self.assertEqual(decision["refusalCode"], code)

    def test_escalate_with_each_escalation_code(self):
        for code in (
            "needs_human_review",
            "needs_capability_expansion",
            "out_of_scope_for_w0_2",
        ):
            with self.subTest(escalationCode=code):
                agent, store, tmp = _agent_for(_escalate_response(code))
                result = agent.invoke(_request())
                self.assertEqual(result.decision, DECISION_ESCALATE)
                self.assertEqual(result.escalation_code, code)
                self.assertIsNone(result.candidate)

    def test_refuse_without_refusal_code_is_invalid(self):
        bad = _ok_propose_response()
        bad["output"] = {"decision": DECISION_REFUSE, "rationale": "no code"}
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_escalate_without_escalation_code_is_invalid(self):
        bad = _ok_propose_response()
        bad["output"] = {"decision": DECISION_ESCALATE, "rationale": "no code"}
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())


# ---------------------------------------------------------------------------
# No-change detection
# ---------------------------------------------------------------------------


class RepairAgentNoChangeTests(unittest.TestCase):
    def test_no_change_when_files_match_previous_candidate(self):
        # The agent returns exactly the same files as the previous candidate.
        identical_response = _ok_propose_response(
            files={
                "src/main/java/com/c2c/generated/Hello.java": SAMPLE_JAVA_PREVIOUS,
            }
        )
        agent, store, tmp = _agent_for(identical_response)
        result = agent.invoke(_request())
        self.assertEqual(result.decision, DECISION_NO_CHANGE)
        # The candidate is still attached to the result so the loop has
        # access to what the agent produced for traceability.
        self.assertIsNotNone(result.candidate)
        self.assertIsNotNone(result.new_java_candidate_ref)
        self.assertEqual(result.failure_code, "java_generation_failed")
        self.assertIn("no-change", result.failure_message)

    def test_no_change_recognises_same_files_in_different_order(self):
        # Two-file map; reverse the iteration order for one set vs the other.
        previous_files = {
            "src/A.java": "package com.c2c.generated;\nclass A {}\n",
            "src/B.java": "package com.c2c.generated;\nclass B {}\n",
        }
        # Same files, different insertion order
        new_files = {
            "src/B.java": "package com.c2c.generated;\nclass B {}\n",
            "src/A.java": "package com.c2c.generated;\nclass A {}\n",
        }
        request = _request(previous_java_files=previous_files)
        response = _ok_propose_response(files=new_files)
        # Adjust the entry-class metadata to match the file map.
        response["output"]["entryClass"] = "A"
        response["output"]["entryFilePath"] = "src/A.java"
        agent, store, tmp = _agent_for(response)
        result = agent.invoke(request)
        self.assertEqual(result.decision, DECISION_NO_CHANGE)

    def test_proposed_change_with_different_content_is_not_no_change(self):
        agent, store, tmp = _agent_for(_ok_propose_response())
        result = agent.invoke(_request())
        self.assertEqual(result.decision, DECISION_PROPOSE)


# ---------------------------------------------------------------------------
# Gateway failure paths persist a synthetic decision and raise typed errors
# ---------------------------------------------------------------------------


class RepairAgentGatewayFailureTests(unittest.TestCase):
    def _assert_synthetic_decision_exists(self, tmp: str):
        decision_path = (
            Path(tmp)
            / "run-1"
            / REPAIR_AGENT_DIR
            / "attempt-01"
            / "agent-repair-decision.json"
        )
        self.assertTrue(decision_path.is_file())
        synthetic = json.loads(decision_path.read_text("utf-8"))
        guard_repair_decision(synthetic)
        self.assertEqual(synthetic["decision"], DECISION_REFUSE)
        self.assertEqual(synthetic["refusalCode"], "no_safe_repair")

    def test_policy_denial_raises_typed_error_and_persists_synthetic(self):
        agent, store, tmp = _agent_for(
            HarnessFailure(403, '{"errorCode":"model_policy_denied"}')
        )
        with self.assertRaises(RepairAgentPolicyDeniedError) as ctx:
            agent.invoke(_request())
        self.assertEqual(ctx.exception.failure_code, "model_policy_denied")
        self._assert_synthetic_decision_exists(tmp)

    def test_provider_timeout_raises_agent_timeout(self):
        agent, store, tmp = _agent_for(
            HarnessFailure(504, '{"errorCode":"model_provider_timeout"}')
        )
        with self.assertRaises(RepairAgentTimeoutError) as ctx:
            agent.invoke(_request())
        self.assertEqual(ctx.exception.failure_code, "agent_timeout")
        self._assert_synthetic_decision_exists(tmp)

    def test_generic_5xx_raises_gateway_unavailable(self):
        agent, store, tmp = _agent_for(HarnessFailure(503, "service down"))
        with self.assertRaises(RepairAgentGatewayUnavailableError) as ctx:
            agent.invoke(_request())
        self.assertEqual(ctx.exception.failure_code, "model_gateway_unavailable")
        self._assert_synthetic_decision_exists(tmp)

    def test_invalid_decision_envelope_raises_contract_invalid(self):
        bad = _ok_propose_response()
        bad["output"] = "not a json object at all"
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())
        self._assert_synthetic_decision_exists(tmp)

    def test_unknown_decision_value_raises_contract_invalid(self):
        bad = _ok_propose_response()
        bad["output"] = {"decision": "invent_a_decision", "rationale": "x"}
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())


# ---------------------------------------------------------------------------
# Java candidate validation (delegated to transformation_agent decoder)
# ---------------------------------------------------------------------------


class RepairAgentCandidateValidationTests(unittest.TestCase):
    def test_non_java_content_rejected(self):
        bad = _ok_propose_response(
            files={"src/main/java/com/c2c/generated/Hello.java": "this is not java"}
        )
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_non_java_extension_rejected(self):
        bad = _ok_propose_response(
            files={"src/main/java/com/c2c/generated/Hello.txt": SAMPLE_JAVA_REPAIRED}
        )
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_path_traversal_rejected(self):
        bad = _ok_propose_response(
            files={"../escape/Hello.java": SAMPLE_JAVA_REPAIRED}
        )
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_missing_entry_class_rejected(self):
        bad = _ok_propose_response()
        bad["output"].pop("entryClass")
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_entry_file_must_declare_package(self):
        bad = _ok_propose_response(
            files={
                "src/main/java/com/c2c/generated/Hello.java": (
                    "public class Hello { /* missing package */ }\n"
                ),
            }
        )
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())

    def test_oversized_repair_output_rejected(self):
        big_content = (
            "package com.c2c.generated;\npublic class Big {}\n"
            + ("// padding\n" * 200000)
        )
        bad = _ok_propose_response(
            files={"src/main/java/com/c2c/generated/Big.java": big_content}
        )
        bad["output"]["entryClass"] = "Big"
        bad["output"]["entryFilePath"] = "src/main/java/com/c2c/generated/Big.java"
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError) as ctx:
            agent.invoke(_request())
        self.assertIn("size limit", str(ctx.exception))

    def test_invalid_confidence_rejected(self):
        bad = _ok_propose_response()
        bad["output"]["confidence"] = 1.5
        agent, store, tmp = _agent_for(bad)
        with self.assertRaises(RepairAgentContractInvalidError):
            agent.invoke(_request())


# ---------------------------------------------------------------------------
# Module hygiene: no provider SDKs, no raw HTTP
# ---------------------------------------------------------------------------


class RepairAgentNoDirectFoundryImportTests(unittest.TestCase):
    def test_module_does_not_import_provider_sdks_or_raw_http(self):
        from orchestrator_service import repair_agent

        source = Path(repair_agent.__file__).read_text("utf-8")
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
                f"repair_agent.py must not contain {marker!r}",
            )


# ---------------------------------------------------------------------------
# Harness event emission
# ---------------------------------------------------------------------------


class RepairAgentHarnessEventTests(unittest.TestCase):
    def test_invoked_and_completed_events_emitted(self):
        events: list[JsonObject] = []

        # noinspection PyClassHasNoInitInspection
        class Sink:
            @staticmethod
            def post_event(event):
                events.append(dict(event))
                return {"eventId": f"evt-{len(events)}"}

        tmp = tempfile.mkdtemp()
        store = RunArtifactStore(tmp)
        store.init_run("run-1", "w0-migration-v0")
        agent = RepairAgent(
            config=_config(),
            artifact_store=store,
            model_invoker=_StubInvoker(_ok_propose_response()),
            harness_events=Sink(),
        )
        agent.invoke(_request())

        event_types = [event["eventType"] for event in events]
        self.assertIn("orchestrator.agent.repair.invoked", event_types)
        self.assertIn("orchestrator.agent.repair.propose_candidate", event_types)
        for event in events:
            self.assertEqual(event["actor"], REPAIR_AGENT_ROLE)
            self.assertEqual(event["dataClass"], "generator")
            self.assertEqual(event["policyDecision"], "policy allow")

    def test_emit_errors_do_not_break_invocation(self):
        # noinspection PyClassHasNoInitInspection
        class FailingSink:
            def post_event(self, event):
                raise RuntimeError("harness down")

        tmp = tempfile.mkdtemp()
        store = RunArtifactStore(tmp)
        store.init_run("run-1", "w0-migration-v0")
        agent = RepairAgent(
            config=_config(),
            artifact_store=store,
            model_invoker=_StubInvoker(_ok_propose_response()),
            harness_events=FailingSink(),
        )
        result = agent.invoke(_request())
        self.assertEqual(result.decision, DECISION_PROPOSE)


if __name__ == "__main__":
    unittest.main()
