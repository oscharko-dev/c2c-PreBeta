"""Tests for the W0.2 orchestrator workflow contract (Issue #166).

Covers:

* Unit tests for the state machine (legal/illegal transitions).
* Unit tests for repair-budget exhaustion semantics.
* Contract-shape tests for the JSON envelope returned by
  ``W02RunContract.to_dict()``.
* Integration tests with stubbed agent adapters that walk the runner
  through the full state sequence on success and the repair-loop +
  blocked path when build-test reports failure.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.run_contract import (
    ASSIST_BUDGET_MAX,
    ASSIST_BUDGET_MIN,
    AssistBudget,
    AssistBudgetExhaustedError,
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_FAILED,
    CLASSIFICATION_INCOMPLETE,
    CLASSIFICATION_SUCCESS,
    DEFAULT_ASSIST_BUDGET,
    DEFAULT_MODEL_INVOCATION_BUDGET,
    DEFAULT_REPAIR_BUDGET,
    FAILURE_CODES,
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_ORACLE_MISMATCH,
    FAILURE_PARSE_FAILED,
    FAILURE_SEMANTIC_IR_FAILED,
    FINAL_CLASSIFICATIONS,
    IllegalTransitionError,
    MODEL_INVOCATION_BUDGET_MAX,
    MODEL_INVOCATION_BUDGET_MIN,
    ModelInvocationBudget,
    ModelInvocationBudgetExhaustedError,
    RepairBudget,
    RepairBudgetExhaustedError,
    SCHEMA_VERSION,
    STATE_BUILD_TEST_RUNNING,
    STATE_COBOL_PARSE_ATTEMPTED,
    STATE_EVIDENCE_INCOMPLETE,
    STATE_EVIDENCE_MATERIALIZED,
    STATE_FINAL_CLASSIFICATION,
    STATE_FINAL_JAVA_SELECTED,
    STATE_RUN_ACCEPTED,
    STATE_RUN_BLOCKED,
    STATE_SEMANTIC_IR_BLOCKED,
    STATE_SEMANTIC_IR_READY,
    STATE_SOURCE_NORMALIZED,
    STATE_TRANSFORMATION_AGENT_INVOKED,
    STATE_VERIFICATION_REPAIR_INVOKED,
    W02RunContract,
    WORKFLOW_STATES,
    WorkflowStateMachine,
    build_test_outcome,
    clamp_assist_budget,
    clamp_model_invocation_budget,
    clamp_repair_budget,
    new_run_contract,
)
from orchestrator_service.workflow import W0RunContext, W0WorkflowRunner, _build_reference

# Reuse the StubGateway from test_workflow.py without dragging its TestCase
# into discovery (which would re-run those tests under this module).
from tests.test_workflow import StubGateway


# noinspection PyClassHasNoInitInspection
class _BaseFixture:
    """Static fixture factory equivalent to ``W0WorkflowRunnerTests`` helpers.

    Keeping it as a plain class (not a TestCase) prevents unittest discovery
    from re-running the imported W0WorkflowRunnerTests cases in this module.
    """

    @staticmethod
    def _base_config():
        from tests.test_workflow import W0WorkflowRunnerTests
        # noinspection PyProtectedMemberInspection
        return W0WorkflowRunnerTests._base_config()

    @staticmethod
    def _base_capabilities():
        from tests.test_workflow import W0WorkflowRunnerTests
        # noinspection PyProtectedMemberInspection
        return W0WorkflowRunnerTests._base_capabilities()

    @staticmethod
    def _base_responses():
        from tests.test_workflow import W0WorkflowRunnerTests
        # noinspection PyProtectedMemberInspection
        return W0WorkflowRunnerTests._base_responses()


# ---------------------------------------------------------------------------
# State machine unit tests
# ---------------------------------------------------------------------------


class WorkflowStateMachineTests(unittest.TestCase):
    def test_initial_state_is_run_accepted_with_history(self):
        machine = WorkflowStateMachine()
        self.assertEqual(machine.current, STATE_RUN_ACCEPTED)
        self.assertEqual(len(machine.history()), 1)
        self.assertEqual(machine.history()[0].state, STATE_RUN_ACCEPTED)

    def test_happy_path_transitions_are_allowed(self):
        machine = WorkflowStateMachine()
        sequence = [
            STATE_SOURCE_NORMALIZED,
            STATE_COBOL_PARSE_ATTEMPTED,
            STATE_SEMANTIC_IR_READY,
            "baseline_generation_attempted",
            "java_candidate_persisted",
            STATE_BUILD_TEST_RUNNING,
            STATE_FINAL_JAVA_SELECTED,
            STATE_EVIDENCE_MATERIALIZED,
            STATE_FINAL_CLASSIFICATION,
        ]
        for state in sequence:
            machine.advance(state)
        self.assertEqual(machine.current, STATE_FINAL_CLASSIFICATION)
        # History includes the initial state plus every advance.
        self.assertEqual(len(machine.history()), len(sequence) + 1)

    def test_illegal_transition_raises(self):
        machine = WorkflowStateMachine()
        with self.assertRaises(IllegalTransitionError):
            machine.advance(STATE_FINAL_CLASSIFICATION)

    def test_terminal_state_rejects_further_transitions(self):
        machine = WorkflowStateMachine()
        machine.advance(STATE_RUN_BLOCKED)
        machine.advance(STATE_EVIDENCE_INCOMPLETE)
        machine.advance(STATE_FINAL_CLASSIFICATION)
        with self.assertRaises(IllegalTransitionError):
            machine.advance(STATE_RUN_BLOCKED)

    def test_advance_records_message_and_failure_code(self):
        machine = WorkflowStateMachine()
        machine.advance(
            STATE_RUN_BLOCKED,
            message="parser refused source",
            failure_code=FAILURE_PARSE_FAILED,
        )
        last = machine.history()[-1]
        self.assertEqual(last.state, STATE_RUN_BLOCKED)
        self.assertEqual(last.message, "parser refused source")
        self.assertEqual(last.failure_code, FAILURE_PARSE_FAILED)

    def test_unknown_state_is_rejected(self):
        machine = WorkflowStateMachine()
        with self.assertRaises(Exception):
            machine.advance("not_a_real_state")

    def test_unknown_failure_code_is_rejected(self):
        machine = WorkflowStateMachine()
        with self.assertRaises(Exception):
            machine.advance(STATE_RUN_BLOCKED, failure_code="not_a_real_code")

    def test_states_cover_issue_166_required_states(self):
        # Twelve W0.2 states plus the success/blocked variants. The order in
        # WORKFLOW_STATES is canonical for the contract.
        required_subset = {
            STATE_RUN_ACCEPTED,
            STATE_SOURCE_NORMALIZED,
            STATE_COBOL_PARSE_ATTEMPTED,
            STATE_SEMANTIC_IR_READY,
            STATE_SEMANTIC_IR_BLOCKED,
            "baseline_generation_attempted",
            STATE_TRANSFORMATION_AGENT_INVOKED,
            "java_candidate_persisted",
            STATE_BUILD_TEST_RUNNING,
            STATE_VERIFICATION_REPAIR_INVOKED,
            STATE_FINAL_JAVA_SELECTED,
            STATE_RUN_BLOCKED,
            STATE_EVIDENCE_MATERIALIZED,
            STATE_EVIDENCE_INCOMPLETE,
            STATE_FINAL_CLASSIFICATION,
        }
        self.assertTrue(required_subset.issubset(set(WORKFLOW_STATES)))


# ---------------------------------------------------------------------------
# Repair-budget tests
# ---------------------------------------------------------------------------


class RepairBudgetTests(unittest.TestCase):
    def test_default_budget_is_two(self):
        self.assertEqual(DEFAULT_REPAIR_BUDGET, 2)

    def test_budget_consumes_until_exhausted(self):
        budget = RepairBudget(limit=2)
        self.assertFalse(budget.exhausted)
        self.assertEqual(budget.remaining, 2)
        budget.consume()
        self.assertEqual(budget.remaining, 1)
        budget.consume()
        self.assertEqual(budget.remaining, 0)
        self.assertTrue(budget.exhausted)

    def test_exhausted_consume_raises(self):
        budget = RepairBudget(limit=1)
        budget.consume()
        with self.assertRaises(RepairBudgetExhaustedError):
            budget.consume()

    def test_clamp_repair_budget_enforces_w02_range(self):
        self.assertEqual(clamp_repair_budget(0), 1)
        self.assertEqual(clamp_repair_budget(-5), 1)
        self.assertEqual(clamp_repair_budget(1), 1)
        self.assertEqual(clamp_repair_budget(2), 2)
        self.assertEqual(clamp_repair_budget(3), 3)
        self.assertEqual(clamp_repair_budget(10), 3)

    def test_budget_rejects_out_of_range_limit(self):
        with self.assertRaises(ValueError):
            RepairBudget(limit=0)
        with self.assertRaises(ValueError):
            RepairBudget(limit=4)


# ---------------------------------------------------------------------------
# Assist budget (Issue #216 / W0.3-5)
# ---------------------------------------------------------------------------


class AssistBudgetTests(unittest.TestCase):
    """Contract-level coverage for the W0.3-5 productive-assist budget."""

    def test_default_assist_budget_is_one(self):
        self.assertEqual(DEFAULT_ASSIST_BUDGET, 1)

    def test_budget_consumes_until_exhausted(self):
        budget = AssistBudget(limit=2)
        self.assertFalse(budget.exhausted)
        self.assertEqual(budget.remaining, 2)
        self.assertEqual(budget.consume(), 1)
        self.assertEqual(budget.remaining, 1)
        self.assertEqual(budget.consume(), 2)
        self.assertEqual(budget.remaining, 0)
        self.assertTrue(budget.exhausted)

    def test_exhausted_consume_raises(self):
        budget = AssistBudget(limit=1)
        budget.consume()
        with self.assertRaises(AssistBudgetExhaustedError):
            budget.consume()

    def test_clamp_assist_budget_enforces_w03_range(self):
        self.assertEqual(clamp_assist_budget(0), ASSIST_BUDGET_MIN)
        self.assertEqual(clamp_assist_budget(-5), ASSIST_BUDGET_MIN)
        self.assertEqual(clamp_assist_budget(1), 1)
        self.assertEqual(clamp_assist_budget(3), ASSIST_BUDGET_MAX)
        self.assertEqual(clamp_assist_budget(100), ASSIST_BUDGET_MAX)

    def test_budget_rejects_out_of_range_limit(self):
        with self.assertRaises(ValueError):
            AssistBudget(limit=0)
        with self.assertRaises(ValueError):
            AssistBudget(limit=4)

    def test_budget_rejects_negative_used(self):
        with self.assertRaises(ValueError):
            AssistBudget(limit=2, used=-1)

    def test_to_dict_shape(self):
        budget = AssistBudget(limit=2)
        budget.consume()
        self.assertEqual(budget.to_dict(), {"limit": 2, "used": 1, "remaining": 1})


# ---------------------------------------------------------------------------
# Model invocation budget (Issue #216 / W0.3-5)
# ---------------------------------------------------------------------------


class ModelInvocationBudgetTests(unittest.TestCase):
    """Contract-level coverage for the W0.3-5 Model Gateway invocation budget."""

    def test_default_model_invocation_budget_is_six(self):
        self.assertEqual(DEFAULT_MODEL_INVOCATION_BUDGET, 6)

    def test_budget_consumes_until_exhausted(self):
        budget = ModelInvocationBudget(limit=3)
        for expected_used in (1, 2, 3):
            self.assertEqual(budget.consume(), expected_used)
        self.assertEqual(budget.remaining, 0)
        self.assertTrue(budget.exhausted)

    def test_exhausted_consume_raises(self):
        budget = ModelInvocationBudget(limit=1)
        budget.consume()
        with self.assertRaises(ModelInvocationBudgetExhaustedError):
            budget.consume()

    def test_clamp_model_invocation_budget_enforces_w03_range(self):
        self.assertEqual(
            clamp_model_invocation_budget(0), MODEL_INVOCATION_BUDGET_MIN
        )
        self.assertEqual(
            clamp_model_invocation_budget(-3), MODEL_INVOCATION_BUDGET_MIN
        )
        self.assertEqual(clamp_model_invocation_budget(6), 6)
        self.assertEqual(
            clamp_model_invocation_budget(MODEL_INVOCATION_BUDGET_MAX),
            MODEL_INVOCATION_BUDGET_MAX,
        )
        self.assertEqual(
            clamp_model_invocation_budget(MODEL_INVOCATION_BUDGET_MAX + 5),
            MODEL_INVOCATION_BUDGET_MAX,
        )

    def test_budget_rejects_out_of_range_limit(self):
        with self.assertRaises(ValueError):
            ModelInvocationBudget(limit=0)
        with self.assertRaises(ValueError):
            ModelInvocationBudget(limit=MODEL_INVOCATION_BUDGET_MAX + 1)

    def test_budget_rejects_negative_used(self):
        with self.assertRaises(ValueError):
            ModelInvocationBudget(limit=3, used=-1)

    def test_to_dict_shape(self):
        budget = ModelInvocationBudget(limit=4)
        budget.consume()
        budget.consume()
        self.assertEqual(
            budget.to_dict(), {"limit": 4, "used": 2, "remaining": 2}
        )


class NewRunContractBudgetWiringTests(unittest.TestCase):
    """``new_run_contract`` accepts and clamps the new budget limits."""

    @staticmethod
    def _source_ref() -> dict[str, object]:
        return {"uri": "urn:source/main.cob", "sha256": "f" * 64, "byteSize": 24}

    def test_defaults_match_module_constants(self):
        contract = new_run_contract(
            run_id="run-default-budgets",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref=self._source_ref(),
        )
        self.assertEqual(contract.assist_budget.limit, DEFAULT_ASSIST_BUDGET)
        self.assertEqual(
            contract.model_invocation_budget.limit,
            DEFAULT_MODEL_INVOCATION_BUDGET,
        )

    def test_clamps_out_of_range_assist_budget_limit(self):
        contract = new_run_contract(
            run_id="run-clamp-assist",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref=self._source_ref(),
            assist_budget_limit=99,
        )
        self.assertEqual(contract.assist_budget.limit, ASSIST_BUDGET_MAX)

    def test_clamps_out_of_range_model_invocation_budget_limit(self):
        contract = new_run_contract(
            run_id="run-clamp-model",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref=self._source_ref(),
            model_invocation_budget_limit=-5,
        )
        self.assertEqual(
            contract.model_invocation_budget.limit, MODEL_INVOCATION_BUDGET_MIN
        )


# ---------------------------------------------------------------------------
# Run-contract shape tests
# ---------------------------------------------------------------------------


class W02RunContractShapeTests(unittest.TestCase):
    @staticmethod
    def _build() -> W02RunContract:
        return new_run_contract(
            run_id="run-42",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref={"uri": "urn:source/main.cob", "sha256": "f" * 64, "byteSize": 24},
            repair_budget_limit=2,
        )

    def test_initial_payload_has_required_fields(self):
        contract = self._build()
        payload = contract.to_dict()
        for key in (
            "schemaVersion",
            "runId",
            "workflowId",
            "requester",
            "sourceRef",
            "currentState",
            "stateHistory",
            "activeStep",
            "agentAttemptCount",
            "repairBudget",
            # Issue #216 (W0.3-5): assist + model invocation budgets are
            # part of the contract envelope from the moment the run is
            # accepted.
            "assistBudget",
            "modelInvocationBudget",
            "generatedJavaRef",
            "buildTestResultRef",
            "evidencePackRef",
            "finalClassification",
            "failureCode",
            "failureMessage",
            "repairAttempts",
            "createdAt",
            "updatedAt",
        ):
            self.assertIn(key, payload, f"missing field {key}")
        # Initial repair-attempts ledger is empty.
        self.assertEqual(payload["repairAttempts"], [])
        self.assertEqual(payload["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(payload["currentState"], STATE_RUN_ACCEPTED)
        self.assertEqual(payload["agentAttemptCount"], 0)
        self.assertEqual(payload["repairBudget"]["limit"], 2)
        self.assertEqual(payload["repairBudget"]["used"], 0)
        self.assertEqual(payload["repairBudget"]["remaining"], 2)
        # Issue #216 (W0.3-5): the new budgets are populated from
        # ``new_run_contract`` defaults and carry the same flat shape.
        self.assertEqual(
            payload["assistBudget"],
            {"limit": DEFAULT_ASSIST_BUDGET, "used": 0, "remaining": DEFAULT_ASSIST_BUDGET},
        )
        self.assertEqual(
            payload["modelInvocationBudget"],
            {
                "limit": DEFAULT_MODEL_INVOCATION_BUDGET,
                "used": 0,
                "remaining": DEFAULT_MODEL_INVOCATION_BUDGET,
            },
        )
        self.assertIsNone(payload["finalClassification"])
        self.assertIsNone(payload["failureCode"])

    def test_finalize_requires_failure_code_for_non_success(self):
        contract = self._build()
        contract.state_machine.advance(STATE_RUN_BLOCKED)
        with self.assertRaises(ValueError):
            contract.finalize(CLASSIFICATION_BLOCKED)

    def test_finalize_success_records_classification(self):
        contract = self._build()
        # Drive the machine through to a state from which success can be
        # finalised.
        for state in [
            STATE_SOURCE_NORMALIZED,
            STATE_COBOL_PARSE_ATTEMPTED,
            STATE_SEMANTIC_IR_READY,
            "baseline_generation_attempted",
            "java_candidate_persisted",
            STATE_BUILD_TEST_RUNNING,
            STATE_FINAL_JAVA_SELECTED,
            STATE_EVIDENCE_MATERIALIZED,
        ]:
            contract.state_machine.advance(state)
        contract.finalize(CLASSIFICATION_SUCCESS)
        payload = contract.to_dict()
        self.assertEqual(payload["finalClassification"], CLASSIFICATION_SUCCESS)
        self.assertEqual(payload["currentState"], STATE_FINAL_CLASSIFICATION)
        self.assertIsNone(payload["failureCode"])

    def test_finalize_rejects_unknown_classification(self):
        contract = self._build()
        with self.assertRaises(ValueError):
            contract.finalize("bogus")

    def test_record_agent_attempt_increments_counter(self):
        contract = self._build()
        self.assertEqual(contract.record_agent_attempt(), 1)
        self.assertEqual(contract.record_agent_attempt(), 2)

    def test_record_repair_attempt_normalises_and_appends(self):
        contract = self._build()
        contract.record_repair_attempt(
            {
                "attemptNumber": 1,
                "repairDecision": "propose_candidate",
                "failureCategory": "java_compile_failed",
                "rationale": "fixed semicolon",
                "modelInvocationRef": {
                    "invocationId": "inv-1",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                },
                "repairInputRef": {
                    "uri": "file://x",
                    "sha256": "a" * 64,
                    "byteSize": 16,
                },
                "repairDecisionRef": {
                    "uri": "file://y",
                    "sha256": "b" * 64,
                    "byteSize": 32,
                },
            }
        )
        contract.record_repair_attempt(
            {
                "attemptNumber": 2,
                "repairDecision": "no_change",
                "failureCategory": "java_compile_failed",
            }
        )
        payload = contract.to_dict()
        self.assertIn("repairAttempts", payload)
        self.assertEqual(len(payload["repairAttempts"]), 2)
        self.assertEqual(payload["repairAttempts"][0]["attemptNumber"], 1)
        self.assertEqual(payload["repairAttempts"][0]["repairDecision"], "propose_candidate")
        self.assertEqual(
            payload["repairAttempts"][0]["modelInvocationRef"]["invocationId"], "inv-1"
        )
        self.assertEqual(payload["repairAttempts"][1]["repairDecision"], "no_change")

    def test_record_repair_attempt_rejects_unknown_decision(self):
        contract = self._build()
        with self.assertRaises(ValueError):
            contract.record_repair_attempt(
                {"attemptNumber": 1, "repairDecision": "totally_made_up"}
            )

    def test_record_repair_attempt_rejects_zero_attempt_number(self):
        contract = self._build()
        with self.assertRaises(ValueError):
            contract.record_repair_attempt(
                {"attemptNumber": 0, "repairDecision": "refuse"}
            )

    def test_record_repair_attempt_rejects_non_mapping(self):
        contract = self._build()
        with self.assertRaises(TypeError):
            contract.record_repair_attempt("not a mapping")

    def test_repeated_no_change_count_property(self):
        contract = self._build()
        self.assertEqual(contract.repeated_no_change_count, 0)
        contract.record_repair_attempt(
            {"attemptNumber": 1, "repairDecision": "propose_candidate"}
        )
        self.assertEqual(contract.repeated_no_change_count, 0)
        contract.record_repair_attempt(
            {"attemptNumber": 2, "repairDecision": "no_change"}
        )
        contract.record_repair_attempt(
            {"attemptNumber": 3, "repairDecision": "no_change"}
        )
        self.assertEqual(contract.repeated_no_change_count, 2)

    def test_failure_codes_match_issue_166_required_set(self):
        required = {
            "unsupported_cobol",
            "parse_failed",
            "semantic_ir_failed",
            "model_gateway_unavailable",
            "model_policy_denied",
            "agent_timeout",
            # Issue #167 extends the closed set with one additional code for
            # invalid agent I/O contract output. The orchestrator-w02-workflow
            # contract doc lists the full set.
            "agent_contract_invalid",
            "java_generation_failed",
            "java_compile_failed",
            "java_runtime_failed",
            "oracle_mismatch",
            "evidence_incomplete",
            "cancelled",
        }
        self.assertEqual(required, set(FAILURE_CODES))

    def test_orchestrator_openapi_matches_runtime_failure_codes(self):
        openapi_path = Path(__file__).resolve().parents[1] / "openapi.yaml"
        openapi_text = openapi_path.read_text("utf-8")
        contract_start = openapi_text.index("    W02RunContract:")
        contract_end = openapi_text.index("    W02StateTransition:", contract_start)
        contract_section = openapi_text[contract_start:contract_end]
        failure_start = contract_section.index("        failureCode:")
        failure_end = contract_section.index("        failureMessage:", failure_start)
        failure_section = contract_section[failure_start:failure_end]

        for failure_code in FAILURE_CODES:
            self.assertIn(
                f"- {failure_code}",
                failure_section,
                f"orchestrator OpenAPI is missing failureCode {failure_code!r}",
            )
        self.assertIn("        repairAttempts:", contract_section)
        self.assertIn("    W02RepairAttempt:", contract_section)

    def test_final_classifications_match_issue_166_required_set(self):
        required = {"success", "blocked", "failed", "cancelled", "incomplete"}
        self.assertEqual(required, set(FINAL_CLASSIFICATIONS))


# ---------------------------------------------------------------------------
# build-test outcome classifier
# ---------------------------------------------------------------------------


class BuildTestOutcomeTests(unittest.TestCase):
    def test_ok_is_success(self):
        success, code = build_test_outcome({"status": "ok"})
        self.assertTrue(success)
        self.assertIsNone(code)

    def test_passed_is_success(self):
        success, _ = build_test_outcome({"status": "passed"})
        self.assertTrue(success)

    def test_oracle_mismatch_reason(self):
        success, code = build_test_outcome(
            {"status": "failed", "reason": "oracle_mismatch"},
        )
        self.assertFalse(success)
        self.assertEqual(code, FAILURE_ORACLE_MISMATCH)

    def test_unknown_failure_defaults_to_compile_failed(self):
        success, code = build_test_outcome({"status": "failed"})
        self.assertFalse(success)
        self.assertEqual(code, FAILURE_JAVA_COMPILE_FAILED)


# ---------------------------------------------------------------------------
# Integration tests via the W0WorkflowRunner
# ---------------------------------------------------------------------------


class _StubGatewayWithBuildOutcomes(StubGateway):
    """Stub gateway that lets a test inject a sequence of build-test payloads.

    Each call to ``invoke_capability(java.build-test, ...)`` consumes the next
    pre-staged outcome. After the queue is drained the gateway falls back to
    the default ``responses['java.build-test']`` shape so misuse fails loudly
    rather than masking a queue-depth error.
    """

    def __init__(self, capabilities, responses, build_outcomes):
        super().__init__(capabilities, responses)
        self._build_outcomes = list(build_outcomes)
        self._build_index = 0

    def invoke_capability(self, capability, payload):
        if capability["id"] == "java.build-test":
            self.calls.append(("invoke", "java.build-test", dict(payload)))
            if self._build_index < len(self._build_outcomes):
                outcome = self._build_outcomes[self._build_index]
                self._build_index += 1
                return dict(outcome)
            return dict(self.responses["java.build-test"])
        return super().invoke_capability(capability, payload)


class _StubGatewayWithIrFailure(StubGateway):
    """Stub gateway that fails Semantic IR generation after parse succeeds."""

    def invoke_capability(self, capability, payload):
        if capability["id"] == "cobol.ir":
            self.calls.append(("invoke", "cobol.ir", dict(payload)))
            raise RuntimeError("semantic IR unavailable")
        return super().invoke_capability(capability, payload)


_REPAIR_AGENT_SAMPLE_JAVA = (
    "package com.c2c.generated;\n"
    "public class CASE01 {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"hi\");\n"
    "    }\n"
    "}\n"
)


class _StubRepairAgentInvoker:
    """Returns a fixed repair-agent envelope on every Model Gateway call.

    The default behaviour is to ``propose_candidate`` with a static piece of
    Java that the build-test stub then verifies. Tests can pass a sequence
    of envelopes to model multi-attempt loops and refusal/escalate paths.
    """

    def __init__(self, envelopes):
        if isinstance(envelopes, dict):
            self._envelopes = [envelopes]
        else:
            self._envelopes = list(envelopes)
        self.calls = []

    def invoke(self, payload):
        self.calls.append(dict(payload))
        if not self._envelopes:
            envelope = self._propose_default(payload)
        else:
            envelope = self._envelopes.pop(0)
        attempt_number = int(payload.get("parameters", {}).get("attemptNumber") or 1)
        return {
            "invocationId": f"inv-run-1-{attempt_number:02d}-repair",
            "runId": payload.get("runId"),
            "modelId": payload.get("modelId") or "gpt-oss-120b",
            "provider": "foundry-development",
            "policyDecision": "policy allow",
            "agentRole": "verification-repair",
            "promptTemplateVersion": "v0",
            "status": "completed",
            "ledgerRef": {
                "uri": f"urn:model-gateway/inv-run-1-{attempt_number:02d}-repair",
                "sha256": "f" * 64,
                "byteSize": 256,
            },
            "output": dict(envelope),
        }

    @staticmethod
    def _propose_default(payload):
        attempt_number = int(payload.get("parameters", {}).get("attemptNumber") or 1)
        # Vary the explanation slightly per attempt so the canonical hash of
        # successive candidates is not identical (no-change detection only
        # kicks in for byte-identical candidate file maps; a varying
        # explanation keeps the file map identical, so we vary a comment in
        # the source instead).
        marker = f"// repair-attempt-{attempt_number}\n"
        files = {
            "src/main/java/com/c2c/generated/CASE01.java": marker
            + _REPAIR_AGENT_SAMPLE_JAVA,
        }
        return {
            "decision": "propose_candidate",
            "rationale": f"repaired java for attempt {attempt_number}",
            "files": files,
            "entryClass": "CASE01",
            "entryPackage": "com.c2c.generated",
            "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
            "explanation": "auto-generated repaired java",
            "unsupportedConstructs": [],
        }


class W02WorkflowIntegrationTests(unittest.TestCase):
    @staticmethod
    def _config(
        repair_budget_max: int = DEFAULT_REPAIR_BUDGET,
        assist_budget_max: int = DEFAULT_ASSIST_BUDGET,
        model_invocation_budget_max: int = DEFAULT_MODEL_INVOCATION_BUDGET,
    ) -> OrchestratorConfig:
        # noinspection PyProtectedMemberInspection
        base = _BaseFixture._base_config()
        # ``OrchestratorConfig`` is frozen — round-trip through ``dict`` so we
        # can override budgets without rebuilding the whole fixture.
        params = base.__dict__.copy()
        params["repair_budget_max"] = repair_budget_max
        # Issue #216 (W0.3-5): tests can override the assist + model
        # invocation budgets to force budget exhaustion in a single run.
        params["assist_budget_max"] = assist_budget_max
        params["model_invocation_budget_max"] = model_invocation_budget_max
        return OrchestratorConfig(**params)

    def _runner(
        self,
        gateway: StubGateway,
        repair_budget_max: int = DEFAULT_REPAIR_BUDGET,
        repair_agent_invoker=None,
        assist_budget_max: int = DEFAULT_ASSIST_BUDGET,
        model_invocation_budget_max: int = DEFAULT_MODEL_INVOCATION_BUDGET,
    ) -> W0WorkflowRunner:
        tmp = tempfile.mkdtemp()
        artifact_store = RunArtifactStore(tmp, created_by="orchestrator-service")
        return W0WorkflowRunner(
            config=self._config(
                repair_budget_max=repair_budget_max,
                assist_budget_max=assist_budget_max,
                model_invocation_budget_max=model_invocation_budget_max,
            ),
            gateway=gateway,
            artifact_store=artifact_store,
            repair_agent_invoker=repair_agent_invoker or _StubRepairAgentInvoker([]),
        )

    @staticmethod
    def _context() -> W0RunContext:
        return W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            model_prompt=None,
        )

    @staticmethod
    def _input_ref():
        return {"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."}

    def test_success_run_drives_state_machine_to_final_classification(self):
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway)
        result = runner.run(context=self._context(), input_ref=self._input_ref())
        self.assertEqual(result["status"], "completed")

        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["currentState"], STATE_FINAL_CLASSIFICATION)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        self.assertIsNone(contract["failureCode"])
        self.assertEqual(contract["agentAttemptCount"], 0)
        self.assertEqual(contract["repairBudget"]["used"], 0)
        self.assertIsNotNone(contract["generatedJavaRef"])
        self.assertIsNotNone(contract["buildTestResultRef"])
        self.assertIsNotNone(contract["evidencePackRef"])

        states = [entry["state"] for entry in contract["stateHistory"]]
        # The runner must walk through the deterministic W0 prefix on the
        # success path before reaching final classification.
        for required in (
            STATE_RUN_ACCEPTED,
            STATE_SOURCE_NORMALIZED,
            STATE_COBOL_PARSE_ATTEMPTED,
            STATE_SEMANTIC_IR_READY,
            "baseline_generation_attempted",
            "java_candidate_persisted",
            STATE_BUILD_TEST_RUNNING,
            STATE_FINAL_JAVA_SELECTED,
            STATE_EVIDENCE_MATERIALIZED,
            STATE_FINAL_CLASSIFICATION,
        ):
            self.assertIn(required, states, f"missing state {required}")

    def test_success_run_emits_w02_state_events(self):
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway)
        runner.run(context=self._context(), input_ref=self._input_ref())

        w02_event_types = [
            event.get("eventType")
            for event in gateway.posted_events
            if str(event.get("eventType", "")).startswith("orchestrator.workflow.state.")
        ]
        self.assertIn("orchestrator.workflow.state.source_normalized", w02_event_types)
        self.assertIn("orchestrator.workflow.state.final_classification", w02_event_types)

    def test_blocked_run_exhausts_budget_and_finalises_as_blocked(self):
        responses = _BaseFixture._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            _BaseFixture._base_capabilities(),
            responses,
            build_outcomes=[
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "runId": "run-1",
                    "workflowId": "w0-migration-v0",
                    "outputRef": {"uri": "urn:orchestrator/run-1/build/attempt-1"},
                },
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "runId": "run-1",
                    "workflowId": "w0-migration-v0",
                    "outputRef": {"uri": "urn:orchestrator/run-1/build/attempt-2"},
                },
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "runId": "run-1",
                    "workflowId": "w0-migration-v0",
                    "outputRef": {"uri": "urn:orchestrator/run-1/build/attempt-3"},
                },
            ],
        )
        runner = self._runner(gateway, repair_budget_max=2)
        result = runner.run(context=self._context(), input_ref=self._input_ref())

        self.assertEqual(result["status"], CLASSIFICATION_BLOCKED)
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        self.assertEqual(contract["failureCode"], FAILURE_ORACLE_MISMATCH)
        # The repair budget must be fully consumed.
        self.assertEqual(contract["repairBudget"]["used"], 2)
        self.assertEqual(contract["repairBudget"]["remaining"], 0)
        self.assertEqual(contract["agentAttemptCount"], 2)

        # The state history must visit verification/repair and run_blocked.
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_VERIFICATION_REPAIR_INVOKED, states)
        self.assertIn(STATE_RUN_BLOCKED, states)
        self.assertIn(STATE_EVIDENCE_MATERIALIZED, states)
        self.assertNotIn(STATE_EVIDENCE_INCOMPLETE, states)
        self.assertEqual(contract["currentState"], STATE_FINAL_CLASSIFICATION)
        self.assertEqual(
            contract["repairAttempts"][0]["buildTestResultRef"]["uri"],
            "urn:orchestrator/run-1/build/attempt-1",
        )
        self.assertEqual(
            contract["repairAttempts"][1]["buildTestResultRef"]["uri"],
            "urn:orchestrator/run-1/build/attempt-2",
        )

        # The runner must have actually invoked build-test three times
        # (initial + two repair attempts).
        build_calls = [c for c in gateway.calls if c[0] == "invoke" and c[1] == "java.build-test"]
        self.assertEqual(len(build_calls), 3)

    def test_repair_loop_recovers_when_budget_remains(self):
        responses = _BaseFixture._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            _BaseFixture._base_capabilities(),
            responses,
            build_outcomes=[
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "outputRef": {"uri": "urn:orchestrator/run-1/build/attempt-1"},
                },
                {
                    "schemaVersion": "v0",
                    "status": "ok",
                    "outputRef": {"uri": "urn:orchestrator/run-1/build/attempt-2"},
                },
            ],
        )
        runner = self._runner(gateway, repair_budget_max=2)
        result = runner.run(context=self._context(), input_ref=self._input_ref())

        self.assertEqual(result["status"], "completed")
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        self.assertEqual(contract["repairBudget"]["used"], 1)
        self.assertEqual(contract["agentAttemptCount"], 1)

    # ----- Issue #216 (W0.3-5): budget hardening integration coverage -----

    def test_deterministic_success_leaves_new_budgets_unused(self):
        """Deterministic-only path consumes neither assist nor model budget.

        AC: "Deterministic verification remains the only path to ``success``
        regardless of budget state." A run that never opts into a productive
        agent must succeed with the new budgets at ``used=0`` so consumers
        can audit that no productive activation happened.
        """
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(
            gateway,
            assist_budget_max=1,
            model_invocation_budget_max=1,
        )
        result = runner.run(context=self._context(), input_ref=self._input_ref())

        self.assertEqual(result["status"], "completed")
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        # Budgets surfaced on every snapshot.
        self.assertEqual(contract["assistBudget"]["limit"], 1)
        self.assertEqual(contract["assistBudget"]["used"], 0)
        self.assertEqual(contract["assistBudget"]["remaining"], 1)
        self.assertEqual(contract["modelInvocationBudget"]["limit"], 1)
        self.assertEqual(contract["modelInvocationBudget"]["used"], 0)
        self.assertEqual(contract["modelInvocationBudget"]["remaining"], 1)

    def test_model_invocation_budget_exhaustion_blocks_repair_loop(self):
        """An exhausted Model Gateway budget hard-terminates the repair loop.

        AC: "No hidden continuation happens after budget exhaustion." The
        repair loop must consume one Model Gateway unit per attempt and stop
        invoking the agent the moment the budget is gone, recording an
        explicit ``refuse`` trajectory entry tagged
        ``model_invocation_budget_exhausted`` so consumers can distinguish
        budget exhaustion from agent-side failures.
        """
        responses = _BaseFixture._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            _BaseFixture._base_capabilities(),
            responses,
            build_outcomes=[
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "outputRef": {
                        "uri": "urn:orchestrator/run-1/build/attempt-1"
                    },
                },
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "outputRef": {
                        "uri": "urn:orchestrator/run-1/build/attempt-2"
                    },
                },
            ],
        )
        # repair_budget allows two iterations; model_invocation budget allows
        # only one. The first repair attempt consumes the gateway unit, the
        # second attempt's pre-flight raises ``ModelInvocationBudgetExhausted``
        # and the run blocks before contacting the gateway.
        runner = self._runner(
            gateway,
            repair_budget_max=2,
            model_invocation_budget_max=1,
        )
        result = runner.run(context=self._context(), input_ref=self._input_ref())
        self.assertEqual(result["status"], CLASSIFICATION_BLOCKED)

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        # Build-test failure code surfaced as the canonical failure code.
        self.assertEqual(contract["failureCode"], FAILURE_ORACLE_MISMATCH)
        # Model invocation budget fully consumed exactly once.
        self.assertEqual(contract["modelInvocationBudget"]["used"], 1)
        self.assertEqual(contract["modelInvocationBudget"]["remaining"], 0)
        # The second repair attempt was recorded as a refuse with the
        # dedicated refusal code so the trajectory ledger is honest.
        budget_refusals = [
            entry
            for entry in contract["repairAttempts"]
            if entry.get("refusalCode") == "model_invocation_budget_exhausted"
        ]
        self.assertEqual(len(budget_refusals), 1)

    def test_assist_budget_exhaustion_degrades_gate_to_assist_not_required(self):
        """Exhausted assist budget forces the gate to ``assist_not_required``.

        AC: "Exhaustion semantics are explicit and tested." The dedicated
        ``assist_budget_exhausted`` reason code is the contract-level signal
        that productive activation was declined because the budget cap was
        reached, not because the caller opted out — and the deterministic
        baseline remains the final candidate without a hidden continuation.
        """
        from orchestrator_service.run_contract import (
            ASSIST_OUTCOME_NOT_REQUIRED,
            ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED,
        )

        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway, assist_budget_max=1)
        contract = new_run_contract(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref={"uri": "urn:source/main.cob"},
            assist_budget_limit=1,
        )
        # Pre-exhaust the assist budget so the gate has nothing to consume
        # when it evaluates the caller's opt-in.
        contract.assist_budget.consume()
        self.assertTrue(contract.assist_budget.exhausted)

        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            model_prompt=None,
            use_transformation_agent=True,
        )
        ir_output_ref = _build_reference(
            f"urn:orchestrator/{context.run_id}/ir-out",
            {"irId": "ir-0"},
        )
        # noinspection PyProtectedMember
        decision = runner._record_assist_decision(
            context,
            contract,
            baseline_artifact_ref=None,
            ir_output_ref=ir_output_ref,
            ir_document=None,
            baseline_generated_project=None,
        )
        self.assertEqual(decision.outcome, ASSIST_OUTCOME_NOT_REQUIRED)
        self.assertEqual(decision.reason_code, ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED)
        self.assertIsNone(decision.selected_agent_role)
        # Budget snapshots are persisted on the decision payload.
        payload = decision.to_dict()
        self.assertEqual(payload["assistBudgetSnapshot"]["used"], 1)
        self.assertEqual(payload["assistBudgetSnapshot"]["remaining"], 0)
        self.assertIn("modelInvocationBudgetSnapshot", payload)

    def test_parse_failure_marks_run_failed_with_canonical_failure_code(self):
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
            fail_parse_attempts=4,
        )
        runner = self._runner(gateway)
        with self.assertRaises(Exception):
            runner.run(context=self._context(), input_ref=self._input_ref())
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_FAILED)
        self.assertEqual(contract["failureCode"], FAILURE_PARSE_FAILED)
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_RUN_BLOCKED, states)
        self.assertNotIn(STATE_EVIDENCE_INCOMPLETE, states)

    def test_missing_generator_capability_uses_step_failure_code(self):
        capabilities = _BaseFixture._base_capabilities()
        capabilities.pop("java.generator")
        gateway = StubGateway(capabilities, _BaseFixture._base_responses())
        runner = self._runner(gateway)
        with self.assertRaises(Exception):
            runner.run(context=self._context(), input_ref=self._input_ref())
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_FAILED)
        self.assertEqual(contract["failureCode"], FAILURE_JAVA_GENERATION_FAILED)
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_RUN_BLOCKED, states)
        self.assertNotIn(STATE_EVIDENCE_INCOMPLETE, states)

    def test_unknown_pre_evidence_failure_code_is_state_scoped(self):
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway)
        self.assertEqual(
            runner._failure_code_from_exception(
                RuntimeError("unexpected control-plane failure"),
                current_state=STATE_SOURCE_NORMALIZED,
            ),
            FAILURE_PARSE_FAILED,
        )

    def test_model_invocation_budget_exhaustion_maps_to_model_gateway_unavailable(self):
        """Issue #216 (W0.3-5): ``ModelInvocationBudgetExhaustedError`` on the
        transformation-agent path must surface as ``model_gateway_unavailable``
        (→ ``blocked``) rather than the step-name fallback
        ``java_generation_failed`` (→ ``failed``). The classifier picks up the
        special case both when the exhaustion is raised directly and when it
        is carried as the cause of a wrapping ``StepExecutionError``.
        """
        from orchestrator_service.run_contract import (
            FAILURE_MODEL_GATEWAY_UNAVAILABLE,
            ModelInvocationBudgetExhaustedError,
        )
        from orchestrator_service.workflow import StepExecutionError

        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway)
        direct = ModelInvocationBudgetExhaustedError(
            "model invocation budget exhausted (limit=1, used=1)"
        )
        self.assertEqual(
            runner._failure_code_from_exception(
                direct,
                current_state=STATE_TRANSFORMATION_AGENT_INVOKED,
                failed_step="transformation-agent",
            ),
            FAILURE_MODEL_GATEWAY_UNAVAILABLE,
        )
        wrapped = StepExecutionError("transformation agent blocked")
        wrapped.__cause__ = direct
        self.assertEqual(
            runner._failure_code_from_exception(
                wrapped,
                current_state=STATE_TRANSFORMATION_AGENT_INVOKED,
                failed_step="transformation-agent",
            ),
            FAILURE_MODEL_GATEWAY_UNAVAILABLE,
        )
        # Non-exhaustion StepExecutionError on the same step still gets the
        # step-name fallback (java_generation_failed → failed).
        bare = StepExecutionError("transformation agent crashed")
        self.assertEqual(
            runner._failure_code_from_exception(
                bare,
                current_state=STATE_TRANSFORMATION_AGENT_INVOKED,
                failed_step="transformation-agent",
            ),
            FAILURE_JAVA_GENERATION_FAILED,
        )

    def test_semantic_ir_failure_emits_semantic_ir_blocked_state(self):
        gateway = _StubGatewayWithIrFailure(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        runner = self._runner(gateway)
        with self.assertRaises(Exception):
            runner.run(context=self._context(), input_ref=self._input_ref())
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_FAILED)
        self.assertEqual(contract["failureCode"], FAILURE_SEMANTIC_IR_FAILED)
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_COBOL_PARSE_ATTEMPTED, states)
        self.assertIn(STATE_SEMANTIC_IR_BLOCKED, states)
        self.assertIn(STATE_RUN_BLOCKED, states)
        self.assertNotIn(STATE_EVIDENCE_INCOMPLETE, states)

    def test_unusable_semantic_ir_response_emits_semantic_ir_blocked_state(self):
        responses = _BaseFixture._base_responses()
        responses["cobol.ir"] = {
            "schemaVersion": "v0",
            "status": "failed",
            "reason": "unsupported",
            "runId": "run-1",
            "workflowId": "w0-migration-v0",
            "outputRef": {"uri": "urn:orchestrator/run-1/ir-failed"},
        }
        gateway = StubGateway(_BaseFixture._base_capabilities(), responses)
        runner = self._runner(gateway)
        with self.assertRaises(Exception):
            runner.run(context=self._context(), input_ref=self._input_ref())
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_FAILED)
        self.assertEqual(contract["failureCode"], FAILURE_SEMANTIC_IR_FAILED)
        states = [entry["state"] for entry in contract["stateHistory"]]
        self.assertIn(STATE_SEMANTIC_IR_BLOCKED, states)
        self.assertIn(STATE_RUN_BLOCKED, states)
        self.assertNotIn(STATE_EVIDENCE_INCOMPLETE, states)

    def test_contract_is_persisted_to_artifact_store(self):
        gateway = StubGateway(
            _BaseFixture._base_capabilities(),
            _BaseFixture._base_responses(),
        )
        tmp = tempfile.mkdtemp()
        artifact_store = RunArtifactStore(tmp, created_by="orchestrator-service")
        runner = W0WorkflowRunner(
            config=self._config(),
            gateway=gateway,
            artifact_store=artifact_store,
        )
        runner.run(context=self._context(), input_ref=self._input_ref())
        contract_path = Path(tmp) / "run-1" / "w02-run-contract.json"
        self.assertTrue(contract_path.exists(), "w02-run-contract.json must be persisted")
        persisted = json.loads(contract_path.read_text("utf-8"))
        self.assertEqual(persisted["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(persisted["finalClassification"], CLASSIFICATION_SUCCESS)


if __name__ == "__main__":
    unittest.main()
class AssistDecisionTests(unittest.TestCase):
    """W0.3-3 (#214): contract-level AssistDecision dataclass behaviour."""

    def test_assist_required_serialises_full_payload(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_AGENT_ROLE_TRANSFORMATION,
            ASSIST_OUTCOME_REQUIRED,
            ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            AssistDecision,
        )

        decision = AssistDecision(
            outcome=ASSIST_OUTCOME_REQUIRED,
            reason_code=ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            decided_at="2026-05-17T00:00:00Z",
            selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
            affected_artifact_refs=({"uri": "urn:baseline", "sha256": "abc"},),
            repair_budget_snapshot={"limit": 2, "used": 0, "remaining": 2},
            rationale="caller opted in",
        )

        payload = decision.to_dict()

        self.assertEqual(payload["outcome"], "assist_required")
        self.assertEqual(payload["reasonCode"], "caller_explicit_opt_in")
        self.assertEqual(payload["decidedAt"], "2026-05-17T00:00:00Z")
        self.assertEqual(payload["selectedAgentRole"], "transformation_agent")
        self.assertEqual(payload["rationale"], "caller opted in")
        self.assertEqual(
            payload["affectedArtifactRefs"],
            [{"uri": "urn:baseline", "sha256": "abc"}],
        )
        self.assertEqual(
            payload["repairBudgetSnapshot"],
            {"limit": 2, "used": 0, "remaining": 2},
        )

    def test_assist_not_required_omits_agent_role(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_OUTCOME_NOT_REQUIRED,
            ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
            AssistDecision,
        )

        decision = AssistDecision(
            outcome=ASSIST_OUTCOME_NOT_REQUIRED,
            reason_code=ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
            decided_at="2026-05-17T00:00:00Z",
        )

        payload = decision.to_dict()

        self.assertEqual(payload["outcome"], "assist_not_required")
        self.assertEqual(payload["reasonCode"], "caller_did_not_opt_in")
        self.assertNotIn(
            "selectedAgentRole",
            payload,
            "assist_not_required must not carry a selected agent role",
        )
        self.assertNotIn("affectedArtifactRefs", payload)
        self.assertNotIn("repairBudgetSnapshot", payload)
        self.assertNotIn("rationale", payload)

    def test_rejects_unknown_outcome(self) -> None:
        from orchestrator_service.run_contract import AssistDecision

        with self.assertRaises(ValueError):
            AssistDecision(
                outcome="maybe",
                reason_code="caller_did_not_opt_in",
                decided_at="2026-05-17T00:00:00Z",
            )

    def test_rejects_unknown_reason_code(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_OUTCOME_NOT_REQUIRED,
            AssistDecision,
        )

        with self.assertRaises(ValueError):
            AssistDecision(
                outcome=ASSIST_OUTCOME_NOT_REQUIRED,
                reason_code="vibes_said_so",
                decided_at="2026-05-17T00:00:00Z",
            )

    def test_assist_required_without_agent_role_rejected(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_OUTCOME_REQUIRED,
            ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            AssistDecision,
        )

        with self.assertRaises(ValueError):
            AssistDecision(
                outcome=ASSIST_OUTCOME_REQUIRED,
                reason_code=ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
                decided_at="2026-05-17T00:00:00Z",
            )

    def test_assist_not_required_with_agent_role_rejected(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_AGENT_ROLE_TRANSFORMATION,
            ASSIST_OUTCOME_NOT_REQUIRED,
            ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
            AssistDecision,
        )

        with self.assertRaises(ValueError):
            AssistDecision(
                outcome=ASSIST_OUTCOME_NOT_REQUIRED,
                reason_code=ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
                decided_at="2026-05-17T00:00:00Z",
                selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
            )

    def test_contract_to_dict_includes_assist_decision_when_recorded(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_AGENT_ROLE_TRANSFORMATION,
            ASSIST_OUTCOME_REQUIRED,
            ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            AssistDecision,
            new_run_contract,
        )

        contract = new_run_contract(
            run_id="run-x",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            source_ref={"uri": "urn:src"},
        )
        self.assertIsNone(contract.to_dict()["assistDecision"])
        decision = AssistDecision(
            outcome=ASSIST_OUTCOME_REQUIRED,
            reason_code=ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            decided_at="2026-05-17T00:00:00Z",
            selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
        )
        contract.record_assist_decision(decision)
        payload = contract.to_dict()
        self.assertIsNotNone(payload["assistDecision"])
        self.assertEqual(payload["assistDecision"]["outcome"], "assist_required")


class DeterministicUncertaintyReasonCodesTests(unittest.TestCase):
    """W0.3-4 (#215): deterministic uncertainty reason codes."""

    def test_closed_set_includes_uncertainty_codes_in_priority_order(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES,
            ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
            ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
            ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
            ASSIST_REASON_CODES,
            ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE,
            ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY,
            ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE,
        )

        # The priority order is a contract: changes are a v1 bump.
        self.assertEqual(
            ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES,
            (
                ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY,
                ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE,
                ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
                ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE,
            ),
        )
        # All deterministic codes are members of the wider closed set, and
        # the caller-driven codes remain the documented fallbacks.
        for code in ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES:
            self.assertIn(code, ASSIST_REASON_CODES)
        self.assertIn(ASSIST_REASON_CALLER_EXPLICIT_OPT_IN, ASSIST_REASON_CODES)
        self.assertIn(ASSIST_REASON_CALLER_DID_NOT_OPT_IN, ASSIST_REASON_CODES)

    def test_assist_decision_accepts_each_uncertainty_code(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_AGENT_ROLE_TRANSFORMATION,
            ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES,
            ASSIST_OUTCOME_REQUIRED,
            AssistDecision,
        )

        for code in ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES:
            decision = AssistDecision(
                outcome=ASSIST_OUTCOME_REQUIRED,
                reason_code=code,
                decided_at="2026-05-17T00:00:00Z",
                selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
                rationale=f"uncertainty marker: {code}",
            )
            self.assertEqual(decision.to_dict()["reasonCode"], code)

    def test_unknown_uncertainty_marker_string_rejected(self) -> None:
        from orchestrator_service.run_contract import (
            ASSIST_AGENT_ROLE_TRANSFORMATION,
            ASSIST_OUTCOME_REQUIRED,
            AssistDecision,
        )

        with self.assertRaises(ValueError):
            AssistDecision(
                outcome=ASSIST_OUTCOME_REQUIRED,
                reason_code="generator_felt_unsure",
                decided_at="2026-05-17T00:00:00Z",
                selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
            )

