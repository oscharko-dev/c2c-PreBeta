"""Integration tests for the W0.2 verification/repair loop (Issue #170).

These tests drive :class:`W0WorkflowRunner` end-to-end with a stubbed
Harness gateway and a stubbed Verification/Repair Agent invoker. They
assert:

* a refused initial candidate that the agent fixes recovers the run,
* an agent ``refuse`` decision blocks the run with the canonical W0.2
  failure code derived from the ``refusalCode``,
* an agent ``escalate`` decision blocks the run and surfaces the
  escalation code to the trajectory ledger,
* identical-files repair (``no_change``) breaks the loop with
  ``java_generation_failed`` rather than burning more budget,
* a malformed gateway response surfaces as ``agent_contract_invalid``,
* repeated propose/fail attempts exhaust the budget and the LAST build
  failure code is preserved on the run contract,
* every repair attempt — successful or terminal — produces an artifact
  on disk under ``repair-agent/attempt-NN/`` and a corresponding entry
  in ``W02RunContract.repairAttempts``,
* a repair-decision payload missing the modelInvocationRef on the
  trajectory entry still validates the on-disk decision, but the run
  reports ``agent_contract_invalid`` if the decoded candidate is bad.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from collections.abc import Mapping
from types import SimpleNamespace
from orchestrator_service.artifacts import JsonObject, JsonValue, RunArtifactStore
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.repair_agent import (
    DECISION_ESCALATE,
    DECISION_PROPOSE,
    DECISION_REFUSE,
    REPAIR_AGENT_DIR,
)
from orchestrator_service.run_contract import (
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_INCOMPLETE,
    CLASSIFICATION_SUCCESS,
    DEFAULT_REPAIR_BUDGET,
    FAILURE_AGENT_CONTRACT_INVALID,
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_MODEL_POLICY_DENIED,
    FAILURE_ORACLE_MISMATCH,
    FAILURE_UNSUPPORTED_COBOL,
    STATE_RUN_BLOCKED,
    STATE_VERIFICATION_REPAIR_INVOKED,
)
from orchestrator_service.workflow import (
    W0RunContext,
    W0WorkflowRunner,
)

from tests.test_workflow import StubGateway, W0WorkflowRunnerTests


SAMPLE_REPAIRED_JAVA = (
    "package com.c2c.generated;\n"
    "public class CASE01 {\n"
    "    public static void main(String[] args) {\n"
    "        System.out.println(\"repaired\");\n"
    "    }\n"
    "}\n"
)


def _propose_envelope(*, marker: str = "v1") -> JsonObject:
    return {
        "decision": DECISION_PROPOSE,
        "rationale": f"repaired java ({marker})",
        "files": {
            "src/main/java/com/c2c/generated/CASE01.java": (
                f"// {marker}\n" + SAMPLE_REPAIRED_JAVA
            ),
        },
        "entryClass": "CASE01",
        "entryPackage": "com.c2c.generated",
        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
        "explanation": f"variant {marker}",
        "unsupportedConstructs": [],
        "confidence": 0.9,
    }


def _identical_envelope_to_previous(files: Mapping[str, str]) -> JsonObject:
    """Return a propose envelope whose files exactly match ``files`` so
    the orchestrator-side no-change detector classifies the attempt as
    no_change. ``files`` MUST contain a properly packaged Java entry file
    so the agent's candidate decoder accepts the envelope."""
    return {
        "decision": DECISION_PROPOSE,
        "rationale": "same files as before",
        "files": dict(files),
        "entryClass": "CASE01",
        "entryPackage": "com.c2c.generated",
        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
        "explanation": "identical attempt",
        "unsupportedConstructs": [],
    }


def _refuse_envelope(refusal_code: str) -> JsonObject:
    return {
        "decision": DECISION_REFUSE,
        "rationale": f"cannot repair: {refusal_code}",
        "refusalCode": refusal_code,
        "confidence": 0.2,
    }


def _escalate_envelope(escalation_code: str) -> JsonObject:
    return {
        "decision": DECISION_ESCALATE,
        "rationale": f"escalating: {escalation_code}",
        "escalationCode": escalation_code,
    }


class _StubRepairAgentInvoker:
    """Returns a fixed sequence of repair-agent envelopes via the gateway.

    Each ``invoke`` call consumes the next envelope from the queue. After
    the queue is drained, raises ``RuntimeError`` so tests fail loudly when
    the loop runs further than expected.
    """

    def __init__(self, envelopes: list[Mapping[str, JsonValue]] | Mapping[str, JsonValue]):
        if isinstance(envelopes, Mapping):
            self._envelopes = [dict(envelopes)]
        else:
            self._envelopes = [dict(env) for env in envelopes]
        self.calls: list[JsonObject] = []

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
        self.calls.append(dict(payload))
        if not self._envelopes:
            raise RuntimeError("repair agent invoker exhausted")
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


class _ExceptionRepairAgentInvoker:
    """Repair invoker that raises a fixed exception on every call."""

    def __init__(self, exc: Exception):
        self._exc = exc
        self.calls: list[JsonObject] = []

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
        self.calls.append(dict(payload))
        raise self._exc


class _StubGatewayWithBuildOutcomes(StubGateway):
    """Stub gateway that lets tests inject a sequence of build-test payloads."""

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


def _build_failed(reason: str, *, attempt_uri: str) -> JsonObject:
    return {
        "schemaVersion": "v0",
        "status": "failed",
        "reason": reason,
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "outputRef": {"uri": attempt_uri},
    }


def _build_ok(attempt_uri: str) -> JsonObject:
    return {
        "schemaVersion": "v0",
        "status": "ok",
        "runId": "run-1",
        "workflowId": "w0-migration-v0",
        "outputRef": {"uri": attempt_uri},
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class _BaseRepairLoopFixture(unittest.TestCase):
    @staticmethod
    def _config(repair_budget_max: int = DEFAULT_REPAIR_BUDGET) -> OrchestratorConfig:
        # noinspection PyProtectedMemberInspection
        base = W0WorkflowRunnerTests._base_config()
        params = base.__dict__.copy()
        params["repair_budget_max"] = repair_budget_max
        return OrchestratorConfig(**params)

    def _runner(
        self,
        gateway: StubGateway,
        repair_agent_invoker,
        repair_budget_max: int = DEFAULT_REPAIR_BUDGET,
    ) -> tuple[W0WorkflowRunner, str]:
        tmp = tempfile.mkdtemp()
        artifact_store = RunArtifactStore(tmp, created_by="orchestrator-service")
        runner = W0WorkflowRunner(
            config=self._config(repair_budget_max=repair_budget_max),
            gateway=gateway,
            artifact_store=artifact_store,
            repair_agent_invoker=repair_agent_invoker,
        )
        return runner, tmp

    @staticmethod
    def _context() -> W0RunContext:
        return W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
        )

    @staticmethod
    def _input_ref() -> JsonObject:
        return {"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class RepairLoopRecoveryTests(_BaseRepairLoopFixture):
    """Test 1 — positive recovery: a single repair fixes the candidate."""

    def test_repair_agent_fixes_first_failure_and_run_succeeds(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
                _build_ok("urn:run-1/build/2"),
            ],
        )
        invoker = _StubRepairAgentInvoker([_propose_envelope(marker="fix-1")])
        runner, tmp = self._runner(gateway, invoker, repair_budget_max=2)

        result = runner.run(context=self._context(), input_ref=self._input_ref())

        self.assertEqual(result["status"], "completed")
        contract = runner.workflow_contract_payload("run-1")
        self.assertIsNotNone(contract)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        self.assertEqual(contract["repairBudget"]["used"], 1)
        self.assertEqual(contract["repairBudget"]["remaining"], 1)
        # Trajectory ledger captures the repair attempt.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        entry = contract["repairAttempts"][0]
        self.assertEqual(entry["attemptNumber"], 1)
        self.assertEqual(entry["repairDecision"], DECISION_PROPOSE)
        self.assertEqual(entry["failureCategory"], "java_compile_failed")
        self.assertIn("javaCandidateRef", entry)
        self.assertEqual(
            entry["modelInvocationRef"]["invocationId"],
            "inv-run-1-01-repair",
        )
        self.assertEqual(
            entry["modelInvocationRef"]["ledgerRef"]["uri"],
            "urn:model-gateway/inv-run-1-01-repair",
        )
        self.assertIn("repairInputRef", entry)
        self.assertIn("repairDecisionRef", entry)
        self.assertIn("buildTestResultRef", entry)
        # Build/test was invoked twice (initial + after repair).
        build_calls = [c for c in gateway.calls if c[0] == "invoke" and c[1] == "java.build-test"]
        self.assertEqual(len(build_calls), 2)
        # Repair agent's manifest is the generatedJavaRef.
        repair_manifest = (
            Path(tmp) / "run-1" / REPAIR_AGENT_DIR / "attempt-01" / "generated-project-manifest.json"
        )
        self.assertTrue(repair_manifest.is_file())
        self.assertEqual(contract["generatedJavaRef"]["uri"], repair_manifest.resolve().as_uri())
        # The Java file the agent persisted is on disk.
        java_path = (
            Path(tmp) / "run-1" / REPAIR_AGENT_DIR / "attempt-01" / "java"
            / "src" / "main" / "java" / "com" / "c2c" / "generated" / "CASE01.java"
        )
        self.assertTrue(java_path.is_file())

    def test_repair_agent_receives_runner_projected_diff_ref(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                {
                    "schemaVersion": "v0",
                    "status": "output-divergence",
                    "reason": "oracle_mismatch",
                    "classification": "divergence-unknown",
                    "runId": "run-1",
                    "workflowId": "w0-migration-v0",
                    "outputRef": {"uri": "urn:run-1/build/1"},
                    "executionResult": {
                        "schemaVersion": "v0",
                        "executionId": "exec-1",
                        "runId": "run-1",
                        "workflowId": "w0-migration-v0",
                        "executionSurface": "generated-java",
                        "command": "java -jar generated.jar",
                        "status": "passed",
                        "exitCode": 0,
                        "timedOut": False,
                        "stdoutRef": {"uri": "urn:stdout", "sha256": "a" * 64, "byteSize": 8},
                        "stderrRef": {"uri": "urn:stderr", "sha256": "b" * 64, "byteSize": 0},
                        "normalizedOutputRef": {
                            "uri": "urn:target-normalized",
                            "sha256": "c" * 64,
                            "byteSize": 8,
                        },
                        "diagnostics": [],
                        "createdAt": "2026-05-20T12:00:00Z",
                    },
                    "comparisonResult": {
                        "schemaVersion": "v0",
                        "comparisonId": "cmp-1",
                        "runId": "run-1",
                        "workflowId": "w0-migration-v0",
                        "status": "failed",
                        "comparisonPolicyVersion": "trust-5-deterministic-v1",
                        "sourceNormalizedRef": {
                            "uri": "urn:source-normalized",
                            "sha256": "d" * 64,
                            "byteSize": 8,
                        },
                        "targetNormalizedRef": {
                            "uri": "urn:target-normalized",
                            "sha256": "c" * 64,
                            "byteSize": 8,
                        },
                        "diffSummary": "first divergence at normalized line 1",
                        "mismatchClassification": "content",
                        "createdAt": "2026-05-20T12:00:00Z",
                    },
                    "comparison": {
                        "matched": False,
                        "normalisation": "trust-5-deterministic-v1",
                        "diff": "@@ normalized-line-1 @@\n-REFERENCE\n+JAVA\n",
                    },
                }
            ],
        )
        invoker = _StubRepairAgentInvoker([_refuse_envelope("unsupported_construct")])
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)

        runner.run(context=self._context(), input_ref=self._input_ref())

        params = invoker.calls[0]["parameters"]
        self.assertEqual(
            params["oracleDiffRef"]["kind"], "parity-comparison-diff"
        )
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(
            contract["parityComparison"]["comparisonPolicyVersion"],
            "trust-5-deterministic-v1",
        )
        self.assertEqual(
            contract["parityComparison"]["mismatchClassification"],
            "content",
        )


class RepairLoopRefuseTests(_BaseRepairLoopFixture):
    """Test 2 — refuse maps to the canonical failure code."""

    def test_refuse_unsupported_construct_blocks_with_unsupported_cobol(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("oracle_mismatch", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _StubRepairAgentInvoker([_refuse_envelope("unsupported_construct")])
        runner, tmp = self._runner(gateway, invoker, repair_budget_max=2)

        result = runner.run(context=self._context(), input_ref=self._input_ref())

        self.assertIn(result["status"], {CLASSIFICATION_BLOCKED, CLASSIFICATION_INCOMPLETE})
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_UNSUPPORTED_COBOL)
        self.assertIn(STATE_VERIFICATION_REPAIR_INVOKED, [
            entry["state"] for entry in contract["stateHistory"]
        ])
        # Only one repair attempt was made before refusal terminated the loop.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        self.assertEqual(contract["repairAttempts"][0]["repairDecision"], DECISION_REFUSE)
        self.assertEqual(contract["repairAttempts"][0]["refusalCode"], "unsupported_construct")
        # Only one build/test invocation (the initial failure); the loop
        # bailed out before re-running build/test.
        build_calls = [c for c in gateway.calls if c[0] == "invoke" and c[1] == "java.build-test"]
        self.assertEqual(len(build_calls), 1)

    def test_refuse_policy_denied_blocks_with_model_policy_denied(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("oracle_mismatch", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _StubRepairAgentInvoker([_refuse_envelope("policy_denied")])
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_MODEL_POLICY_DENIED)


class RepairLoopNoChangeTests(_BaseRepairLoopFixture):
    """Test 3 — identical files trigger no-change termination."""

    def test_no_change_terminates_loop_without_extra_budget(self):
        # Override the generator response so the baseline produces a
        # properly-packaged Java file the repair-agent decoder will
        # accept. The agent then returns the same file map back, which
        # is what triggers no-change detection.
        responses = W0WorkflowRunnerTests._base_responses()
        baseline_java = (
            "package com.c2c.generated;\n"
            "public class CASE01 {\n"
            "    public static void main(String[] args) {\n"
            "        System.out.println(\"baseline\");\n"
            "    }\n"
            "}\n"
        )
        baseline_files = {
            "src/main/java/com/c2c/generated/CASE01.java": baseline_java,
        }
        responses["java.generator"] = {
            **responses["java.generator"],
            "generatedProject": {
                "entryClass": "CASE01",
                "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
                "fileCount": 1,
                "files": dict(baseline_files),
            },
        }
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        # Agent returns exactly the same files as the deterministic baseline.
        invoker = _StubRepairAgentInvoker(
            [_identical_envelope_to_previous(baseline_files)]
        )
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=3)

        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_JAVA_GENERATION_FAILED)
        self.assertIn("no-change", contract["failureMessage"])
        # Exactly one repair budget slot consumed before no-change broke
        # the loop (the slot belonging to the no-change attempt itself).
        self.assertEqual(contract["repairBudget"]["used"], 1)
        # The agent was invoked exactly once. The loop did NOT call the
        # agent again to burn the rest of the budget.
        self.assertEqual(len(invoker.calls), 1)
        # The repairAttempts ledger records the synthetic no_change.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        self.assertEqual(contract["repairAttempts"][0]["repairDecision"], "no_change")


class RepairLoopManualRegionGuardTests(_BaseRepairLoopFixture):
    """ADR 0007 §5 / Issue #280 — the manual-edit assist-interaction rule
    short-circuits the repair iteration without calling the Model Gateway
    when ``assistDecision.reasonCode != caller_explicit_opt_in``.
    """

    @staticmethod
    def _context_with_overlay(
        regions: tuple[Mapping[str, JsonValue], ...],
        *,
        use_transformation_agent: bool = False,
    ) -> W0RunContext:
        return W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            use_transformation_agent=use_transformation_agent,
            manual_overlay_regions=regions,
        )

    @staticmethod
    def _manual_region(**overrides) -> dict[str, JsonValue]:
        region: dict[str, JsonValue] = {
            "filePath": "src/main/java/com/c2c/generated/Hello.java",
            "originClass": "manual_modified",
            "startLine": 1,
            "endLine": 3,
            "generatorBaselineRunId": "run-baseline",
            "generatorBaselineRegionHash": "c" * 64,
            "lastModifiedAt": "2026-05-18T09:14:33Z",
            "lastModifiedBy": {"userId": "user-1", "tenantId": "tenant-A"},
            "manualEditCount": 1,
        }
        region.update(overrides)
        return region

    def test_manual_region_blocks_repair_without_caller_opt_in(self):
        """The guard fires when manual regions exist and the assist
        decision is anything other than ``caller_explicit_opt_in``. The
        run blocks with ``java_generation_failed``; no model invocation
        is recorded; no model-invocation budget unit is consumed.
        """
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        # The invoker raises if reached. The guard must prevent the
        # gateway hop entirely.
        invoker = _ExceptionRepairAgentInvoker(
            RuntimeError("model gateway must not be called for manual-blocked iteration")
        )
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=3)
        regions = (
            self._manual_region(
                filePath="src/main/java/com/c2c/generated/CASE01.java",
                startLine=3,
                endLine=5,
            ),
        )
        # ``use_transformation_agent=False`` → reasonCode
        # ``caller_did_not_opt_in``; the guard fires.
        result = runner.run(
            context=self._context_with_overlay(regions),
            input_ref=self._input_ref(),
        )

        self.assertEqual(result["status"], "blocked")
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_JAVA_GENERATION_FAILED)
        self.assertIn("manual region", contract["failureMessage"])
        # Exactly one trajectory entry: the no_change scoped to the region.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        entry = contract["repairAttempts"][0]
        self.assertEqual(entry["repairDecision"], "no_change")
        self.assertTrue(entry["manualRegionBlock"])
        self.assertEqual(len(entry["affectedRegions"]), 1)
        self.assertEqual(
            entry["affectedRegions"][0]["originClass"], "manual_modified"
        )
        # No model invocation reference and no input/decision artifact
        # references — the agent never persisted anything for this attempt.
        self.assertNotIn("modelInvocationRef", entry)
        self.assertNotIn("repairInputRef", entry)
        self.assertNotIn("repairDecisionRef", entry)
        # The repair-budget slot is still consumed (one iteration ran),
        # but the model-invocation budget is NOT charged because the
        # gateway was never contacted.
        self.assertEqual(contract["repairBudget"]["used"], 1)
        self.assertEqual(
            contract["modelInvocationBudget"]["used"], 0
        )
        # The agent's invoker was never reached.
        self.assertEqual(len(invoker.calls), 0)

    def test_caller_explicit_opt_in_bypasses_guard_and_proceeds(self):
        """With ``reasonCode = caller_explicit_opt_in`` the guard does
        not fire even when manual regions are present; the agent
        proceeds normally and a build-test run after the propose-candidate
        succeeds.
        """
        # ``caller_explicit_opt_in`` requires the productive Transformation
        # Agent path. Stub a successful agent response so the run's first
        # build-test (run on the AGENT's candidate, not the deterministic
        # baseline) fails the first time and succeeds after repair.
        sample_java = (
            "package com.c2c.generated;\n"
            "public class Hello {\n"
            "    public static void main(String[] args) {\n"
            "        System.out.println(\"hi\");\n"
            "    }\n"
            "}\n"
        )
        agent_response = {
            "invocationId": "inv-run-1-01-transformation",
            "runId": "run-1",
            "modelId": "gpt-oss-120b",
            "provider": "foundry-development",
            "policyDecision": "policy allow",
            "agentRole": "transformation",
            "promptTemplateVersion": "v0",
            "status": "completed",
            "ledgerRef": {
                "uri": "urn:model-gateway/inv-run-1-01",
                "sha256": "e" * 64,
                "byteSize": 256,
            },
            "output": {
                "status": "success",
                "files": {
                    "src/main/java/com/c2c/generated/Hello.java": sample_java,
                },
                "entryClass": "Hello",
                "entryPackage": "com.c2c.generated",
                "entryFilePath": "src/main/java/com/c2c/generated/Hello.java",
                "unsupportedConstructs": [],
            },
        }

        # noinspection PyClassHasNoInitInspection
        class _AgentInvoker:
            def __init__(self, response: JsonObject) -> None:
                self._response = response
                self.calls: list[JsonObject] = []

            def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
                self.calls.append(dict(payload))
                return dict(self._response)

        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
                _build_ok("urn:run-1/build/2"),
            ],
        )
        repair_invoker = _StubRepairAgentInvoker(
            [_propose_envelope(marker="opt-in")]
        )
        tmp = tempfile.mkdtemp()
        artifact_store = RunArtifactStore(tmp, created_by="orchestrator-service")
        runner = W0WorkflowRunner(
            config=self._config(repair_budget_max=2),
            gateway=gateway,
            artifact_store=artifact_store,
            transformation_agent_invoker=_AgentInvoker(agent_response),
            repair_agent_invoker=repair_invoker,
        )
        regions = (
            self._manual_region(
                originClass="manual_edit",
                generatorBaselineRegionHash=None,
            ),
        )
        # ``use_transformation_agent=True`` with no baseline uncertainty
        # markers → reasonCode ``caller_explicit_opt_in``; the guard MUST
        # NOT fire.
        result = runner.run(
            context=self._context_with_overlay(
                regions, use_transformation_agent=True
            ),
            input_ref=self._input_ref(),
        )

        self.assertEqual(result["status"], "completed")
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        # The trajectory has one propose_candidate entry; the manual-edit
        # block fields MUST be absent on this entry because the guard did
        # not fire.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        entry = contract["repairAttempts"][0]
        self.assertEqual(entry["repairDecision"], DECISION_PROPOSE)
        self.assertNotIn("manualRegionBlock", entry)
        self.assertNotIn("affectedRegions", entry)
        # The repair agent was invoked exactly once on the productive path.
        self.assertEqual(len(repair_invoker.calls), 1)
        # Sanity: the assist decision recorded on the contract is the
        # explicit-opt-in code, which is precisely what bypasses the
        # guard.
        self.assertEqual(
            contract["assistDecision"]["reasonCode"],
            "caller_explicit_opt_in",
        )

    def test_guard_skips_when_no_manual_overlay_present(self):
        """When no manual regions are supplied, the repair loop behaves
        identically to the pre-Issue-280 baseline (the guard is dormant).
        """
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
                _build_ok("urn:run-1/build/2"),
            ],
        )
        invoker = _StubRepairAgentInvoker([_propose_envelope(marker="no-overlay")])
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)

        # No manual overlay at all — the default empty tuple matches
        # greenfield runs.
        result = runner.run(
            context=self._context_with_overlay(()),
            input_ref=self._input_ref(),
        )

        self.assertEqual(result["status"], "completed")
        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_SUCCESS)
        self.assertEqual(len(contract["repairAttempts"]), 1)
        entry = contract["repairAttempts"][0]
        self.assertEqual(entry["repairDecision"], DECISION_PROPOSE)
        self.assertNotIn("manualRegionBlock", entry)


class RepairLoopEscalateTests(_BaseRepairLoopFixture):
    """Test 4 — escalate terminates the loop and surfaces the code."""

    def test_escalate_blocks_run_and_records_escalation_code(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_runtime_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _StubRepairAgentInvoker([_escalate_envelope("needs_human_review")])
        runner, tmp = self._runner(gateway, invoker, repair_budget_max=2)

        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_JAVA_GENERATION_FAILED)
        self.assertIn("needs_human_review", contract["failureMessage"])
        self.assertEqual(len(contract["repairAttempts"]), 1)
        attempt = contract["repairAttempts"][0]
        self.assertEqual(attempt["repairDecision"], DECISION_ESCALATE)
        self.assertEqual(attempt["escalationCode"], "needs_human_review")


class RepairLoopMalformedResponseTests(_BaseRepairLoopFixture):
    """Test 5 — gateway garbage surfaces as agent_contract_invalid."""

    def test_malformed_envelope_blocks_run_with_agent_contract_invalid(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )

        # The output is a syntactically broken JSON string — the agent's
        # parser must reject it. We pass an envelope where the inner
        # ``output`` will be a non-object.
        # noinspection PyClassHasNoInitInspection
        class _BadInvoker:
            calls: list[JsonObject] = []

            def invoke(self, payload):
                self.calls.append(dict(payload))
                return {
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
                        "sha256": "f" * 64,
                        "byteSize": 256,
                    },
                    "output": "not even close to json {{",
                }

        runner, _tmp = self._runner(gateway, _BadInvoker(), repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_AGENT_CONTRACT_INVALID)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        self.assertEqual(len(contract["repairAttempts"]), 1)
        attempt = contract["repairAttempts"][0]
        self.assertEqual(attempt["repairDecision"], DECISION_REFUSE)
        self.assertEqual(attempt["refusalCode"], "no_safe_repair")
        self.assertEqual(
            attempt["modelInvocationRef"]["invocationId"],
            "inv-run-1-01-repair",
        )
        self.assertIn("repairInputRef", attempt)
        self.assertIn("repairDecisionRef", attempt)
        self.assertIn(
            STATE_RUN_BLOCKED,
            [entry["state"] for entry in contract["stateHistory"]],
        )
        build_calls = [
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        ]
        self.assertEqual(len(build_calls), 1)


class RepairLoopBudgetExhaustionTests(_BaseRepairLoopFixture):
    """Test 6 — repeated propose/fail exhausts the budget; LAST build
    failure code is preserved."""

    def test_budget_exhaustion_preserves_last_build_failure_code(self):
        responses = W0WorkflowRunnerTests._base_responses()
        # 3 build failures in a row — initial + two repair attempts. The
        # last failure is oracle_mismatch; that code must survive on the
        # final run contract.
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
                _build_failed("java_runtime_failed", attempt_uri="urn:run-1/build/2"),
                _build_failed("oracle_mismatch", attempt_uri="urn:run-1/build/3"),
            ],
        )
        # Agent proposes a different (repaired-looking but still wrong) candidate
        # each time so no-change detection does not short-circuit the loop.
        invoker = _StubRepairAgentInvoker(
            [
                _propose_envelope(marker="attempt-A"),
                _propose_envelope(marker="attempt-B"),
            ]
        )
        runner, tmp = self._runner(gateway, invoker, repair_budget_max=2)

        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["repairBudget"]["used"], 2)
        self.assertEqual(contract["repairBudget"]["remaining"], 0)
        self.assertEqual(contract["failureCode"], FAILURE_ORACLE_MISMATCH)
        # Two repair attempts both proposed candidates; both visible.
        self.assertEqual(len(contract["repairAttempts"]), 2)
        for entry in contract["repairAttempts"]:
            self.assertEqual(entry["repairDecision"], DECISION_PROPOSE)
            self.assertIn("modelInvocationRef", entry)
            self.assertIn("repairInputRef", entry)
            self.assertIn("repairDecisionRef", entry)
        second_prompt = json.loads(invoker.calls[1]["prompt"])
        self.assertIn("previousRepairDecisionRefs", second_prompt)
        self.assertEqual(len(second_prompt["previousRepairDecisionRefs"]), 1)
        self.assertEqual(
            second_prompt["previousRepairDecisionRefs"][0]["uri"],
            contract["repairAttempts"][0]["repairDecisionRef"]["uri"],
        )
        # Build/test was called three times overall.
        build_calls = [c for c in gateway.calls if c[0] == "invoke" and c[1] == "java.build-test"]
        self.assertEqual(len(build_calls), 3)


class RepairLoopEvidenceTrailTests(_BaseRepairLoopFixture):
    """Test 7 — every attempt leaves an artifact on disk."""

    def test_attempt_artifacts_visible_on_disk(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
                _build_failed("oracle_mismatch", attempt_uri="urn:run-1/build/2"),
                _build_ok("urn:run-1/build/3"),
            ],
        )
        invoker = _StubRepairAgentInvoker(
            [
                _propose_envelope(marker="attempt-A"),
                _propose_envelope(marker="attempt-B"),
            ]
        )
        runner, tmp = self._runner(gateway, invoker, repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())

        repair_root = Path(tmp) / "run-1" / REPAIR_AGENT_DIR
        self.assertTrue((repair_root / "attempt-01" / "agent-repair-input.json").is_file())
        self.assertTrue((repair_root / "attempt-01" / "agent-repair-decision.json").is_file())
        self.assertTrue(
            (repair_root / "attempt-01" / "generated-project-manifest.json").is_file()
        )
        self.assertTrue((repair_root / "attempt-02" / "agent-repair-input.json").is_file())
        self.assertTrue((repair_root / "attempt-02" / "agent-repair-decision.json").is_file())
        self.assertTrue(
            (repair_root / "attempt-02" / "generated-project-manifest.json").is_file()
        )
        # Each repair attempt's decision must validate as agent-repair-decision-v0.
        for attempt in (1, 2):
            payload = json.loads(
                (repair_root / f"attempt-{attempt:02d}" / "agent-repair-decision.json")
                .read_text("utf-8")
            )
            self.assertEqual(payload["attemptNumber"], attempt)
            self.assertEqual(payload["decision"], DECISION_PROPOSE)


class RepairLoopGatewayUnavailableTests(_BaseRepairLoopFixture):
    """Test 8 — gateway-level failure during repair invocation surfaces
    via the typed RepairAgent error onto the run contract."""

    def test_gateway_503_surfaces_as_model_gateway_unavailable(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _ExceptionRepairAgentInvoker(HarnessFailure(503, "service down"))
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], "model_gateway_unavailable")
        # The trajectory still has one entry recording the failed attempt.
        self.assertEqual(len(contract["repairAttempts"]), 1)
        attempt = contract["repairAttempts"][0]
        self.assertEqual(attempt["repairDecision"], DECISION_REFUSE)
        self.assertEqual(attempt["refusalCode"], "no_safe_repair")
        self.assertIn("repairInputRef", attempt)
        self.assertIn("repairDecisionRef", attempt)
        self.assertNotIn("modelInvocationRef", attempt)

    def test_gateway_timeout_surfaces_as_agent_timeout(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _ExceptionRepairAgentInvoker(
            HarnessFailure(504, '{"errorCode":"model_provider_timeout"}')
        )
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], "agent_timeout")
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        self.assertEqual(len(contract["repairAttempts"]), 1)

    def test_gateway_policy_denial_surfaces_as_model_policy_denied(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = _StubGatewayWithBuildOutcomes(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
            build_outcomes=[
                _build_failed("java_compile_failed", attempt_uri="urn:run-1/build/1"),
            ],
        )
        invoker = _ExceptionRepairAgentInvoker(
            HarnessFailure(403, '{"errorCode":"model_policy_denied"}')
        )
        runner, _tmp = self._runner(gateway, invoker, repair_budget_max=2)
        runner.run(context=self._context(), input_ref=self._input_ref())

        contract = runner.workflow_contract_payload("run-1")
        self.assertEqual(contract["failureCode"], FAILURE_MODEL_POLICY_DENIED)
        self.assertEqual(contract["finalClassification"], CLASSIFICATION_BLOCKED)
        self.assertEqual(len(contract["repairAttempts"]), 1)


class ManualDiagnosisClassificationTests(_BaseRepairLoopFixture):
    def test_failure_class_and_follow_up_mappings_cover_runtime_parity_and_scope(self):
        runtime_result = SimpleNamespace(
            proposed_candidate=False,
            is_escalation=False,
            escalation_code=None,
            is_refusal=False,
            refusal_code=None,
        )
        scope_result = SimpleNamespace(
            proposed_candidate=False,
            is_escalation=True,
            escalation_code="out_of_scope_for_w0_2",
            is_refusal=False,
            refusal_code=None,
        )
        refusal_result = SimpleNamespace(
            proposed_candidate=False,
            is_escalation=False,
            escalation_code=None,
            is_refusal=True,
            refusal_code="insufficient_context",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "java_runtime_failed",
                build_payload={},
                manual_overlay_regions=(),
                repair_result=runtime_result,
            ),
            "generated_code_defect",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "oracle_mismatch",
                build_payload={},
                manual_overlay_regions=(),
                repair_result=runtime_result,
            ),
            "generated_code_defect",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "java_compile_failed",
                build_payload={},
                manual_overlay_regions=(),
                repair_result=runtime_result,
            ),
            "generated_code_defect",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "oracle_mismatch",
                build_payload={},
                manual_overlay_regions=(),
                repair_result=scope_result,
            ),
            "out_of_scope",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_follow_up(
                runtime_result,
                build_payload={"classification": "missing-golden-master"},
            ),
            "repair_fixture",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_follow_up(
                refusal_result,
                build_payload={},
            ),
            "stop",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_scope_class(
                build_payload={},
                manual_overlay_regions=({"filePath": "A.java"},),
                repair_result=runtime_result,
            ),
            "manual_edit",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "oracle_mismatch",
                build_payload={"classification": "missing-golden-master"},
                manual_overlay_regions=(),
                repair_result=runtime_result,
            ),
            "fixture_issue",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_scope_class(
                build_payload={"classification": "missing-golden-master"},
                manual_overlay_regions=(),
                repair_result=runtime_result,
            ),
            "fixture_reference",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                None,
                build_payload={},
                manual_overlay_regions=({"filePath": "A.java"},),
                repair_result=runtime_result,
            ),
            "manual_edit_issue",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_scope_class(
                build_payload={},
                manual_overlay_regions=(),
                repair_result=scope_result,
            ),
            "out_of_scope",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_failure_class(
                "oracle_mismatch",
                build_payload={},
                manual_overlay_regions=(),
                repair_result=refusal_result,
            ),
            "unknown",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_scope_class(
                build_payload={},
                manual_overlay_regions=(),
                repair_result=refusal_result,
            ),
            "unknown",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_follow_up(
                SimpleNamespace(
                    proposed_candidate=False,
                    is_escalation=False,
                    escalation_code=None,
                ),
                build_payload={},
            ),
            "stop",
        )
        self.assertEqual(
            W0WorkflowRunner._manual_diagnosis_follow_up(
                SimpleNamespace(
                    proposed_candidate=False,
                    is_escalation=True,
                    escalation_code="out_of_scope_for_w0_2",
                ),
                build_payload={},
            ),
            "escalate",
        )


if __name__ == "__main__":
    unittest.main()
