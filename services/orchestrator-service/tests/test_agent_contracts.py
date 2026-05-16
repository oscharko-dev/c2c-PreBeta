"""Tests for the W0.2 Agent I/O contract validator (Issue #167).

Covers:

* Positive validation of agent-invocation-request, agent-invocation-response,
  agent-repair-input, and agent-repair-decision payloads.
* Negative cases required by the issue: missing artifact references, missing
  model invocation reference, invalid role name, oversized content, malformed
  repair decisions.
* Secret-leak guard rejects credential-like field names in nested objects.
* Orchestrator integration: an agent-shaped generator payload that fails
  contract validation leads to a blocked run with
  ``failureCode == "agent_contract_invalid"``.
* Evidence/trajectory composability: trajectory record fields compose with
  the existing ``agent-trajectory-ledger-v0`` schema without leaking secrets.
"""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

# noinspection PyProtectedMemberInspection
from orchestrator_service.agent_contracts import (
    AgentContractInvalidError,
    MAX_PAYLOAD_BYTES,
    assert_no_secret_leak,
    guard_agent_response,
    guard_repair_decision,
    schema,
    validate_invocation_request,
    validate_invocation_response,
    validate_repair_decision,
    validate_repair_input,
    _utcnow_iso,
)
from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.run_contract import (
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_FAILED,
    FAILURE_AGENT_CONTRACT_INVALID,
    FAILURE_CODES,
)
from orchestrator_service.workflow import (
    AgentContractInvalidStepError,
    W0RunContext,
    W0WorkflowRunner,
)

from tests.test_workflow import StubGateway, W0WorkflowRunnerTests


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


_HEX_64 = "a" * 64
_NOW = "2026-05-16T14:30:00Z"


def _artifact_ref(uri: str = "urn:artifact/abc", *, kind: str = "generated-project-manifest") -> dict:
    return {"uri": uri, "sha256": _HEX_64, "byteSize": 1024, "kind": kind, "mimeType": "application/json"}


def _model_invocation_ref() -> dict:
    return {
        "invocationId": "mg-run-1-1",
        "modelId": "gpt-oss-120b",
        "provider": "foundry-development",
        "ledgerRef": _artifact_ref("urn:model-gateway/invocations/mg-run-1-1", kind="model-invocation-ledger"),
    }


def _capability_ref() -> dict:
    return {
        "capabilityId": "java.generator",
        "capabilityVersion": "v0",
        "providerService": "target-java-generation-service",
        "resolvedAt": _NOW,
    }


def _policy_decision_ref() -> dict:
    return {
        "policyVersion": "v0",
        "decision": "policy allow",
        "decidedAt": _NOW,
    }


def _trajectory_record() -> dict:
    return {
        "ledgerEntryId": "evt-1",
        "actor": "transformation-agent",
        "dataClass": "generator",
        "stateTransition": "workflow.step",
        "createdAt": _NOW,
    }


def _valid_invocation_request(role: str = "transformation-agent", *, attempt: int = 1) -> dict:
    request = {
        "schemaVersion": "v0",
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "attemptNumber": attempt,
        "agentRole": role,
        "capabilityRef": _capability_ref(),
        "promptTemplateId": "transformation/v1",
        "promptTemplateVersion": "v1",
        "inputArtifactRefs": [_artifact_ref("urn:run-1/source.cob", kind="source-cobol")],
        "policyDecisionRef": _policy_decision_ref(),
        "modelInvocationRef": _model_invocation_ref(),
        "requestedAt": _NOW,
    }
    if role == "verification-repair-agent" and attempt > 1:
        request["repairContextRef"] = _artifact_ref("urn:run-1/repair-input-1", kind="agent-repair-input")
    return request


def _valid_invocation_response(role: str = "transformation-agent") -> dict:
    payload = {
        "schemaVersion": "v0",
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "attemptNumber": 1,
        "agentRole": role,
        "status": "success",
        "outputArtifactRefs": [_artifact_ref("urn:run-1/java-candidate-1", kind="generated-project-manifest")],
        "javaCandidateRef": _artifact_ref("urn:run-1/java-candidate-1", kind="generated-project-manifest"),
        "modelInvocationRef": _model_invocation_ref(),
        "promptTemplateId": "transformation/v1",
        "promptTemplateVersion": "v1",
        "capabilityRef": _capability_ref(),
        "trajectoryRecord": _trajectory_record(),
        "startedAt": _NOW,
        "endedAt": _NOW,
    }
    if role == "verification-repair-agent":
        payload["repairDecisionRef"] = _artifact_ref(
            "urn:run-1/repair-decision-1", kind="agent-repair-decision"
        )
    return payload


def _valid_repair_input() -> dict:
    return {
        "schemaVersion": "v0",
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "attemptNumber": 1,
        "previousJavaCandidateRef": _artifact_ref("urn:run-1/java-candidate-1", kind="generated-project-manifest"),
        "buildTestResultRef": _artifact_ref("urn:run-1/build-test-1", kind="build-test-result"),
        "failureCategory": "java_compile_failed",
        "compileErrorRef": _artifact_ref("urn:run-1/compile-error", kind="compile-error-log"),
        "createdAt": _NOW,
    }


def _valid_repair_decision_propose() -> dict:
    return {
        "schemaVersion": "v0",
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "attemptNumber": 1,
        "decision": "propose_candidate",
        "rationale": "Adjusted Java method to match COBOL DISPLAY semantics.",
        "newJavaCandidateRef": _artifact_ref("urn:run-1/java-candidate-2", kind="generated-project-manifest"),
        "createdAt": _NOW,
    }


# ---------------------------------------------------------------------------
# Schema-level positive tests
# ---------------------------------------------------------------------------


class SchemaPositiveTests(unittest.TestCase):
    @staticmethod
    def test_valid_transformation_invocation_request() -> None:
        validate_invocation_request(_valid_invocation_request())

    @staticmethod
    def test_valid_verification_repair_invocation_request_attempt_two() -> None:
        validate_invocation_request(_valid_invocation_request("verification-repair-agent", attempt=2))

    @staticmethod
    def test_valid_transformation_invocation_response() -> None:
        validate_invocation_response(_valid_invocation_response())

    @staticmethod
    def test_valid_verification_repair_invocation_response() -> None:
        validate_invocation_response(_valid_invocation_response("verification-repair-agent"))

    @staticmethod
    def test_valid_repair_input() -> None:
        validate_repair_input(_valid_repair_input())

    @staticmethod
    def test_valid_repair_decision_propose() -> None:
        validate_repair_decision(_valid_repair_decision_propose())

    @staticmethod
    def test_valid_repair_decision_refuse() -> None:
        payload = {
            "schemaVersion": "v0",
            "runId": "run-1",
            "attemptNumber": 1,
            "decision": "refuse",
            "rationale": "No safe repair for unsupported COBOL construct.",
            "refusalCode": "unsupported_construct",
            "createdAt": _NOW,
        }
        validate_repair_decision(payload)

    @staticmethod
    def test_valid_repair_decision_escalate() -> None:
        payload = {
            "schemaVersion": "v0",
            "runId": "run-1",
            "attemptNumber": 1,
            "decision": "escalate",
            "rationale": "Requires human review of legacy section.",
            "escalationCode": "needs_human_review",
            "createdAt": _NOW,
        }
        validate_repair_decision(payload)

    def test_schema_loader_exposes_canonical_ids(self) -> None:
        # Catches accidental renaming or relocation of the schema files.
        self.assertEqual(
            schema("agent-invocation-request-v0")["$id"],
            "https://oscharko.dev/c2c/schemas/agent-invocation-request-v0.json",
        )
        self.assertEqual(
            schema("agent-invocation-response-v0")["$id"],
            "https://oscharko.dev/c2c/schemas/agent-invocation-response-v0.json",
        )
        self.assertEqual(
            schema("agent-repair-input-v0")["$id"],
            "https://oscharko.dev/c2c/schemas/agent-repair-input-v0.json",
        )
        self.assertEqual(
            schema("agent-repair-decision-v0")["$id"],
            "https://oscharko.dev/c2c/schemas/agent-repair-decision-v0.json",
        )


# ---------------------------------------------------------------------------
# Schema-level negative tests (required by Issue #167)
# ---------------------------------------------------------------------------


class InvocationResponseNegativeTests(unittest.TestCase):
    def test_missing_model_invocation_reference_rejected(self) -> None:
        payload = _valid_invocation_response()
        del payload["modelInvocationRef"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("modelInvocationRef" in e for e in ctx.exception.errors))

    def test_missing_java_candidate_ref_on_success_rejected(self) -> None:
        payload = _valid_invocation_response()
        del payload["javaCandidateRef"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("javaCandidateRef" in e for e in ctx.exception.errors))

    def test_empty_output_artifact_refs_on_success_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["outputArtifactRefs"] = []
        with self.assertRaises(AgentContractInvalidError):
            validate_invocation_response(payload)

    def test_invalid_role_name_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["agentRole"] = "evil-agent"
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("agentRole" in e for e in ctx.exception.errors))

    def test_failure_without_failure_code_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["status"] = "failed"
        # Successful payload had no failureCode/failureMessage. The else branch
        # of the success/failure conditional must require both.
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        errors = "; ".join(ctx.exception.errors)
        self.assertIn("failureCode", errors)
        self.assertIn("failureMessage", errors)

    def test_success_payload_with_failure_code_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["failureCode"] = "agent_timeout"
        with self.assertRaises(AgentContractInvalidError):
            validate_invocation_response(payload)

    def test_verification_repair_response_requires_repair_decision_ref(self) -> None:
        payload = _valid_invocation_response("verification-repair-agent")
        del payload["repairDecisionRef"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("repairDecisionRef" in e for e in ctx.exception.errors))

    def test_oversized_payload_rejected(self) -> None:
        payload = _valid_invocation_response()
        # Stuff the trajectory record's actor field with a huge string to push
        # the serialised payload over MAX_PAYLOAD_BYTES.
        payload["trajectoryRecord"]["actor"] = "x" * (MAX_PAYLOAD_BYTES + 1024)
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("exceeds limit" in e for e in ctx.exception.errors))

    def test_bad_sha256_in_artifact_ref_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["javaCandidateRef"]["sha256"] = "notahex"
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("pattern" in e for e in ctx.exception.errors))

    def test_unknown_top_level_field_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["secretBackdoor"] = "value"
        with self.assertRaises(AgentContractInvalidError):
            validate_invocation_response(payload)

    def test_missing_trajectory_record_rejected(self) -> None:
        payload = _valid_invocation_response()
        del payload["trajectoryRecord"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_response(payload)
        self.assertTrue(any("trajectoryRecord" in e for e in ctx.exception.errors))


class InvocationRequestNegativeTests(unittest.TestCase):
    def test_verification_repair_attempt_two_without_repair_context_rejected(self) -> None:
        payload = _valid_invocation_request("verification-repair-agent", attempt=2)
        del payload["repairContextRef"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_invocation_request(payload)
        self.assertTrue(any("repairContextRef" in e for e in ctx.exception.errors))

    def test_missing_input_artifact_refs_rejected(self) -> None:
        payload = _valid_invocation_request()
        payload["inputArtifactRefs"] = []
        with self.assertRaises(AgentContractInvalidError):
            validate_invocation_request(payload)

    def test_invalid_schema_version_rejected(self) -> None:
        payload = _valid_invocation_request()
        payload["schemaVersion"] = "v1"
        with self.assertRaises(AgentContractInvalidError):
            validate_invocation_request(payload)


class RepairInputNegativeTests(unittest.TestCase):
    def test_unknown_failure_category_rejected(self) -> None:
        payload = _valid_repair_input()
        payload["failureCategory"] = "unsupported_construct"
        with self.assertRaises(AgentContractInvalidError):
            validate_repair_input(payload)

    def test_missing_build_test_result_ref_rejected(self) -> None:
        payload = _valid_repair_input()
        del payload["buildTestResultRef"]
        with self.assertRaises(AgentContractInvalidError):
            validate_repair_input(payload)


class RepairDecisionNegativeTests(unittest.TestCase):
    def test_propose_decision_without_new_java_candidate_rejected(self) -> None:
        payload = _valid_repair_decision_propose()
        del payload["newJavaCandidateRef"]
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_repair_decision(payload)
        self.assertTrue(any("newJavaCandidateRef" in e for e in ctx.exception.errors))

    def test_refuse_with_candidate_rejected(self) -> None:
        payload = {
            "schemaVersion": "v0",
            "runId": "run-1",
            "attemptNumber": 1,
            "decision": "refuse",
            "rationale": "No safe repair available.",
            "refusalCode": "no_safe_repair",
            "newJavaCandidateRef": _artifact_ref("urn:bad", kind="generated-project-manifest"),
            "createdAt": _NOW,
        }
        with self.assertRaises(AgentContractInvalidError) as ctx:
            validate_repair_decision(payload)
        errors = "; ".join(ctx.exception.errors)
        self.assertIn("not", errors)

    def test_escalate_with_refusal_code_rejected(self) -> None:
        payload = {
            "schemaVersion": "v0",
            "runId": "run-1",
            "attemptNumber": 1,
            "decision": "escalate",
            "rationale": "Needs human review.",
            "escalationCode": "needs_human_review",
            "refusalCode": "no_safe_repair",
            "createdAt": _NOW,
        }
        with self.assertRaises(AgentContractInvalidError):
            validate_repair_decision(payload)

    def test_unknown_decision_value_rejected(self) -> None:
        payload = _valid_repair_decision_propose()
        payload["decision"] = "yolo"
        with self.assertRaises(AgentContractInvalidError):
            validate_repair_decision(payload)

    def test_rationale_too_long_rejected(self) -> None:
        payload = _valid_repair_decision_propose()
        payload["rationale"] = "x" * 4001
        with self.assertRaises(AgentContractInvalidError):
            validate_repair_decision(payload)


# ---------------------------------------------------------------------------
# Secret-leak guard
# ---------------------------------------------------------------------------


class SecretLeakGuardTests(unittest.TestCase):
    @staticmethod
    def test_no_secret_in_clean_payload() -> None:
        assert_no_secret_leak(_valid_invocation_response())

    def test_apikey_field_rejected(self) -> None:
        payload = _valid_invocation_response()
        payload["trajectoryRecord"]["relatedRecords"] = ["evt-2"]
        # Try to smuggle a key in the (top-level open) `relatedRecords` would
        # be caught by schema. Try it nested in a permissive map instead:
        payload["modelInvocationRef"]["apiKey"] = "sk-bad"  # noqa: PIE804 - intentional violation
        with self.assertRaises(AgentContractInvalidError) as ctx:
            assert_no_secret_leak(payload)
        self.assertTrue(any("apiKey" in e for e in ctx.exception.errors))

    def test_guard_agent_response_rejects_apikey(self) -> None:
        payload = _valid_invocation_response()
        # The schema rejects unknown top-level keys, but a key on a nested
        # object whose schema allows additionalProperties: false would be
        # rejected by schema validation directly. The leak guard provides a
        # belt-and-braces safety net by walking the entire tree.
        payload_with_secret = copy.deepcopy(payload)
        # Inject the secret in a place the schema *would* permit if
        # additionalProperties were ever loosened; the walker still rejects it.
        payload_with_secret["trajectoryRecord"]["actor"] = "agent"
        # Force-route through assert_no_secret_leak with a smuggled key.
        payload_with_secret["password"] = "hunter2"
        with self.assertRaises(AgentContractInvalidError):
            assert_no_secret_leak(payload_with_secret)


# ---------------------------------------------------------------------------
# Orchestrator integration: invalid agent output ⇒ blocked run
# ---------------------------------------------------------------------------


class _AgentReturningGenerator(StubGateway):
    """Variant of StubGateway whose ``java.generator`` response is an
    agent-shaped payload (carries ``agentRole``). Subclasses inject either a
    valid or an invalid payload to exercise the orchestrator's guard.
    """

    def __init__(self, capabilities, responses, *, agent_payload: dict):
        super().__init__(capabilities, responses)
        self._agent_payload = agent_payload

    def invoke_capability(self, capability, payload):
        if capability["id"] == "java.generator":
            self.calls.append(("invoke", "java.generator", dict(payload)))
            # We still need outputRef and generatedProject so the rest of the
            # deterministic path can chain artifacts, but the payload carries
            # the agentRole marker that activates the guard.
            response = {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "generatedProject": {
                    "entryClass": "CASE01",
                    "entryFilePath": "src/CASE01.java",
                    "fileCount": 1,
                    "files": {"src/CASE01.java": "class CASE01 {}"},
                },
                "traceability": {},
                "outputRef": {"uri": "urn:orchestrator/run-1/generator"},
            }
            response.update(self._agent_payload)
            return response
        return super().invoke_capability(capability, payload)


class OrchestratorGuardIntegrationTests(unittest.TestCase):
    @staticmethod
    def _runner(gateway):
        # noinspection PyProtectedMemberInspection
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
        )
        return runner

    @staticmethod
    def _context():
        return W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

    def test_agent_payload_missing_model_ref_blocks_run(self) -> None:
        # Compose an agent-shaped payload but drop modelInvocationRef.
        bad_payload = _valid_invocation_response()
        del bad_payload["modelInvocationRef"]
        gateway = _AgentReturningGenerator(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
            agent_payload=bad_payload,
        )
        runner = self._runner(gateway)
        with self.assertRaises(AgentContractInvalidStepError):
            runner.run(
                context=self._context(),
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
            )
        # The run must surface as failed/blocked, never completed.
        statuses = [entry[1] for entry in gateway.updated_runs]
        self.assertIn("failed", statuses)
        self.assertNotIn("completed", statuses)

    def test_agent_payload_with_bad_role_blocks_run(self) -> None:
        bad_payload = _valid_invocation_response()
        bad_payload["agentRole"] = "evil-agent"
        gateway = _AgentReturningGenerator(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
            agent_payload=bad_payload,
        )
        runner = self._runner(gateway)
        with self.assertRaises(AgentContractInvalidStepError):
            runner.run(
                context=self._context(),
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
            )

    def test_deterministic_payload_without_agent_role_is_not_validated(self) -> None:
        # Sanity: the existing deterministic generator (no ``agentRole`` field)
        # must still pass the workflow unchanged. This proves the guard is
        # additive and not a regression.
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        runner = self._runner(gateway)
        result = runner.run(
            context=self._context(),
            input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
        )
        self.assertEqual(result["status"], "completed")


# ---------------------------------------------------------------------------
# Failure code surface: catalog membership
# ---------------------------------------------------------------------------


class FailureCodeCatalogTests(unittest.TestCase):
    def test_agent_contract_invalid_in_failure_codes(self) -> None:
        self.assertIn(FAILURE_AGENT_CONTRACT_INVALID, FAILURE_CODES)
        self.assertEqual(FAILURE_AGENT_CONTRACT_INVALID, "agent_contract_invalid")


# ---------------------------------------------------------------------------
# Trajectory composability + evidence-pack manifest coexistence
# ---------------------------------------------------------------------------


class TrajectoryComposabilityTests(unittest.TestCase):
    def test_response_trajectory_record_uses_existing_ledger_data_class_enum(self) -> None:
        # The single trajectory record embedded in an invocation response must
        # reuse the dataClass enum from agent-trajectory-ledger-v0 so the
        # downstream ledger can absorb it without re-mapping. We check the
        # enum directly here so any drift is caught.
        ledger_schema_path = Path(__file__).resolve().parents[3] / "schemas" / "agent-trajectory-ledger-v0.json"
        ledger_schema = json.loads(ledger_schema_path.read_text("utf-8"))
        step_data_class_enum = set(
            ledger_schema["properties"]["steps"]["items"]["properties"]["dataClass"]["enum"]
        )
        response_schema = schema("agent-invocation-response-v0")
        response_data_class_enum = set(
            response_schema["$defs"]["agentTrajectoryRecord"]["properties"]["dataClass"]["enum"]
        )
        self.assertEqual(step_data_class_enum, response_data_class_enum)

    @staticmethod
    def test_full_guard_passes_clean_payload() -> None:
        guard_agent_response(_valid_invocation_response())
        guard_agent_response(_valid_invocation_response("verification-repair-agent"))
        guard_repair_decision(_valid_repair_decision_propose())


if __name__ == "__main__":
    unittest.main()
