"""Integration tests for the W0.2 workflow + Transformation Agent (Issue #169).

These tests drive :class:`W0WorkflowRunner` end-to-end with a stubbed
Harness gateway and a stubbed Model Gateway invoker. They assert:

* the agent is invoked only when the run opts in,
* its Java candidate replaces the deterministic baseline as the artifact
  fed to build/test,
* the W0.2 contract state machine traverses the productive-agent path,
* the run finalises as ``blocked`` with the correct failure code when the
  agent returns ``blocked``,
* the run finalises with ``agent_contract_invalid`` when the agent
  produces a contract-violating response,
* the run finalises with ``model_policy_denied`` when the gateway rejects
  the invocation on policy grounds.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from collections.abc import Mapping
from typing import Any

from orchestrator_service.artifacts import JsonObject, JsonValue, RunArtifactStore
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.run_contract import (
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_INCOMPLETE,
    CLASSIFICATION_SUCCESS,
    FAILURE_AGENT_CONTRACT_INVALID,
    FAILURE_MODEL_POLICY_DENIED,
    STATE_TRANSFORMATION_AGENT_INVOKED,
    STATE_JAVA_CANDIDATE_PERSISTED,
    STATE_BUILD_TEST_RUNNING,
    STATE_RUN_BLOCKED,
)
from orchestrator_service.transformation_agent import (
    TRANSFORMATION_AGENT_DIR,
)
from orchestrator_service.workflow import (
    AgentContractInvalidStepError,
    ModelPolicyDeniedStepError,
    W0RunContext,
    W0WorkflowRunner,
)

from tests.test_workflow import W0WorkflowRunnerTests, StubGateway


SAMPLE_JAVA = (
    "package com.c2c.generated;\n"
    "public class Hello {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"hi\");\n"
    "    }\n"
    "}\n"
)


def _ok_model_response(*, files: Mapping[str, str] | None = None, status: str = "success") -> JsonObject:
    output: JsonObject = {"status": status}
    if status == "success":
        output["files"] = dict(files) if files else {
            "src/main/java/com/c2c/generated/Hello.java": SAMPLE_JAVA,
        }
        output["entryClass"] = "Hello"
        output["entryPackage"] = "com.c2c.generated"
        output["entryFilePath"] = "src/main/java/com/c2c/generated/Hello.java"
        output["unsupportedConstructs"] = []
    elif status == "blocked":
        output["unsupportedConstructs"] = ["GO TO"]
        output["explanation"] = "Verb GO TO is outside the W0 subset."
    return {
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


class _StubAgentInvoker:
    def __init__(self, response: Mapping[str, JsonValue] | Exception) -> None:
        self._response = response
        self.calls: list[Mapping[str, JsonValue]] = []

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
        self.calls.append(dict(payload))
        if isinstance(self._response, Exception):
            raise self._response
        return dict(self._response)


class TransformationAgentWorkflowIntegrationTests(unittest.TestCase):
    """End-to-end W0.2 workflow with the productive agent enabled."""

    # noinspection PyProtectedMemberInspection
    @staticmethod
    def _runner(*, agent_response: Any) -> tuple[W0WorkflowRunner, StubGateway, RunArtifactStore, str]:
        tmp = tempfile.mkdtemp()
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        store = RunArtifactStore(tmp)
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
            artifact_store=store,
            transformation_agent_invoker=_StubAgentInvoker(agent_response),
        )
        return runner, gateway, store, tmp

    def test_agent_success_replaces_baseline_in_build_test(self) -> None:
        runner, gateway, store, tmp = self._runner(agent_response=_ok_model_response())
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(result["status"], "completed")
        contract = result["workflowContract"]
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        # State history must include the productive-agent transition.
        state_history = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_TRANSFORMATION_AGENT_INVOKED, state_history)
        self.assertIn(STATE_JAVA_CANDIDATE_PERSISTED, state_history)
        self.assertIn(STATE_BUILD_TEST_RUNNING, state_history)
        # The agent's manifest IS the generatedJavaRef (not the baseline's).
        agent_manifest_path = (
            Path(tmp).resolve()
            / "run-1"
            / TRANSFORMATION_AGENT_DIR
            / "attempt-01"
            / "generated-project-manifest.json"
        )
        self.assertTrue(agent_manifest_path.is_file())
        self.assertEqual(contract["generatedJavaRef"]["uri"], agent_manifest_path.as_uri())
        # Build-test received the agent's Java content, not the baseline.
        build_test_call = next(
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        )
        generated_files = build_test_call[2]["generatedProject"]["files"]
        self.assertEqual(
            generated_files["src/main/java/com/c2c/generated/Hello.java"],
            SAMPLE_JAVA,
        )
        self.assertEqual(
            build_test_call[2]["generatedProject"]["generationSource"],
            "transformation-agent",
        )
        self.assertEqual(
            build_test_call[2]["generatedProject"]["entryClass"],
            "com.c2c.generated.Hello",
        )
        self.assertEqual(
            build_test_call[2]["generatedProject"]["entryPackage"],
            "com.c2c.generated",
        )

    def test_agent_disabled_preserves_deterministic_baseline(self) -> None:
        runner, gateway, store, _tmp = self._runner(agent_response=_ok_model_response())
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=False,
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(result["status"], "completed")
        # State history must NOT include the productive-agent transition.
        states = [entry["state"] for entry in result["workflowContract"]["stateHistory"]]
        self.assertNotIn(STATE_TRANSFORMATION_AGENT_INVOKED, states)
        # Build-test received the deterministic baseline.
        build_test_call = next(
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        )
        self.assertEqual(
            build_test_call[2]["generatedProject"]["files"]["src/CASE01.java"],
            "class CASE01 {}",
        )

    def test_agent_blocked_finalises_run_as_blocked(self) -> None:
        runner, gateway, store, tmp = self._runner(
            agent_response=_ok_model_response(status="blocked"),
        )
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        # blocked classification + canonical failure code.
        contract = result["workflowContract"]
        self.assertIn(
            contract["finalClassification"],
            {CLASSIFICATION_BLOCKED, CLASSIFICATION_INCOMPLETE},
        )
        self.assertEqual(contract["failureCode"], "unsupported_cobol")
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_TRANSFORMATION_AGENT_INVOKED, states)
        self.assertIn(STATE_RUN_BLOCKED, states)
        # build-test must NOT have been invoked when the agent blocks.
        build_test_calls = [
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        ]
        self.assertEqual(build_test_calls, [])

    def test_agent_contract_violation_surfaces_as_agent_contract_invalid(self) -> None:
        bad_response = _ok_model_response()
        # Non-Java content — the agent rejects, the workflow catches the
        # typed error and finalises the run.
        bad_response["output"]["files"] = {
            "src/main/java/com/c2c/generated/Hello.java": "this is not java",
        }
        runner, gateway, store, tmp = self._runner(agent_response=bad_response)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        with self.assertRaises(AgentContractInvalidStepError):
            runner.run(
                context=context,
                input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
            )

        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["failureCode"], FAILURE_AGENT_CONTRACT_INVALID)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        self.assertIn(
            STATE_RUN_BLOCKED,
            [entry["state"] for entry in contract["stateHistory"]],
        )
        build_test_calls = [
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        ]
        evidence_calls = [
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == runner.config.evidence_capability_id
        ]
        self.assertEqual(build_test_calls, [])
        self.assertEqual(evidence_calls, [])

    def test_agent_policy_denial_surfaces_as_model_policy_denied(self) -> None:
        runner, gateway, store, tmp = self._runner(
            agent_response=HarnessFailure(403, '{"errorCode":"model_policy_denied"}'),
        )
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        with self.assertRaises(ModelPolicyDeniedStepError):
            runner.run(
                context=context,
                input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
            )

        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["failureCode"], FAILURE_MODEL_POLICY_DENIED)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)

    def test_agent_request_payload_carries_baseline_reference(self) -> None:
        invoker = _StubAgentInvoker(_ok_model_response())
        tmp = tempfile.mkdtemp()
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
            artifact_store=RunArtifactStore(tmp),
            transformation_agent_invoker=invoker,
        )

        runner.run(
            context=W0RunContext(
                run_id="run-1",
                workflow_id="w0-migration-v0",
                requester="orchestrator",
                evidence_refs=[],
                use_transformation_agent=True,
            ),
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(len(invoker.calls), 1)
        gateway_request = invoker.calls[0]
        parameters = gateway_request["parameters"]
        # The deterministic baseline manifest MUST be referenced so the
        # agent has the baseline available to materially improve on.
        self.assertIn("baselineJavaRef", parameters)
        self.assertIn("semanticIrRef", parameters)
        self.assertIn("sourceRef", parameters)
        self.assertEqual(gateway_request["agentRole"], "transformation")

    def test_agent_blocked_does_not_enter_repair_loop(self) -> None:
        """Guard: build_test_input={} default is safe when w02_blocked=True.

        When the Transformation Agent returns ``blocked``, build_test_output
        is never set (remains None) so the repair loop guard
        ``while build_test_output is not None`` prevents any repair invocation.
        A loud-failure invoker makes any accidental loop entry an immediate
        test failure rather than a silent no-op.
        """
        class _LoudFailRepairInvoker:
            @staticmethod
            def invoke(_payload):
                raise AssertionError("repair loop entered when w02_blocked=True")

        tmp = tempfile.mkdtemp()
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
            artifact_store=RunArtifactStore(tmp),
            transformation_agent_invoker=_StubAgentInvoker(_ok_model_response(status="blocked")),
            repair_agent_invoker=_LoudFailRepairInvoker(),
        )

        result = runner.run(
            context=W0RunContext(
                run_id="run-1",
                workflow_id="w0-migration-v0",
                requester="orchestrator",
                evidence_refs=[],
                use_transformation_agent=True,
            ),
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        contract = result["workflowContract"]
        self.assertIn(
            contract["finalClassification"],
            {CLASSIFICATION_BLOCKED, CLASSIFICATION_INCOMPLETE},
        )
        self.assertEqual(contract.get("repairAttempts", []), [])


class W03AssistDecisionGateTests(TransformationAgentWorkflowIntegrationTests):
    """W0.3-3 (#214): the explicit Orchestrator-owned assist-decision gate.

    The gate runs once per productive run, records an outcome and reason
    code on the contract, persists the decision to the run artifact
    store, and emits a Harness event. Consumers must read the decision
    directly from the contract instead of inferring from
    ``agentAttemptCount > 0``.
    """

    def test_caller_opt_in_records_assist_required_decision(self) -> None:
        runner, gateway, _store, _tmp = self._runner(
            agent_response=_ok_model_response()
        )
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(result["status"], "completed")
        decision = result["workflowContract"]["assistDecision"]
        self.assertIsNotNone(decision, "assistDecision must be recorded on every productive run")
        self.assertEqual(decision["outcome"], "assist_required")
        self.assertEqual(decision["reasonCode"], "caller_explicit_opt_in")
        self.assertEqual(decision["selectedAgentRole"], "transformation_agent")
        # Decision includes a repair-budget snapshot so consumers can see
        # the relevant budget at decision time without reconstructing it.
        self.assertIsNotNone(decision["repairBudgetSnapshot"])
        self.assertIn("limit", decision["repairBudgetSnapshot"])
        self.assertIn("remaining", decision["repairBudgetSnapshot"])
        # The deterministic baseline artifact reference is attached so
        # the UI can show what input the gate decided against.
        self.assertTrue(
            decision["affectedArtifactRefs"],
            "assist decision must reference the deterministic baseline artifact",
        )
        # Rationale is sanitized human-readable string, never None.
        self.assertIsInstance(decision["rationale"], str)
        # Decided-at is an ISO-8601 UTC timestamp.
        self.assertTrue(decision["decidedAt"].endswith("Z"))

    def test_no_opt_in_records_assist_not_required_decision(self) -> None:
        runner, gateway, _store, _tmp = self._runner(
            agent_response=_ok_model_response()
        )
        context = W0RunContext(
            run_id="run-2",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=False,
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(result["status"], "completed")
        decision = result["workflowContract"]["assistDecision"]
        self.assertIsNotNone(
            decision,
            "every productive run that reaches the gate must record a decision, including the baseline-only path",
        )
        self.assertEqual(decision["outcome"], "assist_not_required")
        self.assertEqual(decision["reasonCode"], "caller_did_not_opt_in")
        # No selected agent role when assist is not required.
        self.assertNotIn(
            "selectedAgentRole",
            decision,
            "assist_not_required decisions must not name a selected agent role",
        )
        # State history must NOT include the productive-agent transition.
        states = [entry["state"] for entry in result["workflowContract"]["stateHistory"]]
        self.assertNotIn("transformation_agent_invoked", states)

    def test_assist_decision_event_emitted_with_decision_payload(self) -> None:
        runner, gateway, _store, _tmp = self._runner(
            agent_response=_ok_model_response()
        )
        context = W0RunContext(
            run_id="run-3",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            use_transformation_agent=True,
        )

        runner.run(
            context=context,
            input_ref={"uri": "urn:src/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        decision_events = [
            event
            for event in gateway.posted_events
            if isinstance(event, Mapping)
            and str(event.get("eventType", "")).startswith(
                "orchestrator.workflow.assist_decision."
            )
        ]
        self.assertEqual(
            len(decision_events),
            1,
            "exactly one assist-decision event must be emitted per productive run",
        )
        event = decision_events[0]
        self.assertEqual(
            event["eventType"],
            "orchestrator.workflow.assist_decision.assist_required",
        )
        output_payload = event.get("payload", {}).get("output") or {}
        self.assertEqual(output_payload.get("outcome"), "assist_required")
        self.assertEqual(
            output_payload.get("reasonCode"), "caller_explicit_opt_in"
        )
        self.assertEqual(
            output_payload.get("selectedAgentRole"), "transformation_agent"
        )


if __name__ == "__main__":
    unittest.main()
