"""Parity workflow regression coverage for Issue #355.

These tests pin the orchestrator-side contract for the parity extension:

* a successful parity run records productive-transform progress and emits
  parityComparison evidence,
* structured build-test failures keep the run blocked instead of silently
  passing a partial result,
* failed source/reference execution remains visible in the projected parity
  lineage, and
* the parity-specific path stays isolated from the legacy W0 shape when the
  productive agent is not enabled.
"""

from __future__ import annotations

import tempfile
import unittest

from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.run_contract import (
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_RUNTIME_FAILED,
    FAILURE_SOURCE_REFERENCE_FAILED,
    FAILURE_ORACLE_MISMATCH,
)
from orchestrator_service.workflow import (
    W0RunContext,
    W0WorkflowRunner,
    _bounded_diagnostic_message,
    _DIAGNOSTIC_MESSAGE_MAX_LENGTH,
    _DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL,
)

from tests.test_workflow import StubGateway, W0WorkflowRunnerTests


RUN_ID = "run-parity-1"


def _transformation_agent_response() -> dict:
    return {
        "invocationId": "inv-run-parity-1-01-transformation",
        "runId": RUN_ID,
        "modelId": "gpt-oss-120b",
        "provider": "foundry-development",
        "policyId": "foundry-development-v0",
        "policyDecision": "policy allow",
        "agentRole": "transformation",
        "promptTemplateVersion": "v0",
        "status": "completed",
        "ledgerRef": {
            "uri": "urn:model-gateway/inv-run-parity-1-01",
            "sha256": "e" * 64,
            "byteSize": 256,
        },
        "output": {
            "status": "success",
            "files": {
                "src/main/java/com/c2c/generated/CASE01.java": (
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"hi\");\n"
                    "    }\n"
                    "}\n"
                ),
            },
            "entryClass": "CASE01",
            "entryPackage": "com.c2c.generated",
            "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
            "explanation": "Translated the sample COBOL program to Java.",
            "unsupportedConstructs": [],
        },
    }


def _parity_build_response(
    *,
    status: str = "ok",
    classification: str = "match",
    reason: str | None = None,
    comparison_status: str = "passed",
    matched: bool = True,
    mismatch_classification: str | None = "none",
    execution_status: str = "passed",
    diff_summary: str = "Outputs matched after deterministic normalization.",
) -> dict:
    payload: dict = {
        "schemaVersion": "v0",
        "status": status,
        "classification": classification,
        "runId": RUN_ID,
        "workflowId": "w0-migration-v0",
        "programId": "CASE01",
        "executionResult": {
            "schemaVersion": "v0",
            "executionId": f"exec-{RUN_ID}",
            "runId": RUN_ID,
            "workflowId": "w0-migration-v0",
            "executionSurface": "generated-java",
            "command": "java -jar generated.jar",
            "status": execution_status,
            "exitCode": 0 if execution_status == "passed" else 1,
            "timedOut": False,
            "stdoutRef": {
                "uri": f"urn:{RUN_ID}/java-stdout",
                "sha256": "b" * 64,
                "byteSize": 16,
                "kind": "java-stdout",
            },
            "stderrRef": {
                "uri": f"urn:{RUN_ID}/java-stderr",
                "sha256": "c" * 64,
                "byteSize": 0,
                "kind": "java-stderr",
            },
            "normalizedOutputRef": {
                "uri": f"urn:{RUN_ID}/java-normalized",
                "sha256": "d" * 64,
                "byteSize": 16,
                "kind": "java-normalized",
            },
            "diagnostics": [],
            "createdAt": "2026-05-20T12:00:00Z",
        },
        "comparison": {
            "matched": matched,
            "comparisonPolicyVersion": "deterministic-output-v1",
            "expectedRef": {
                "uri": f"urn:{RUN_ID}/reference-stdout",
                "sha256": "a" * 64,
                "byteSize": 16,
                "kind": "reference-output",
            },
            "actualRef": {
                "uri": f"urn:{RUN_ID}/java-stdout",
                "sha256": "b" * 64,
                "byteSize": 16,
                "kind": "java-stdout",
            },
            "diffSummary": diff_summary,
        },
        "comparisonResult": {
            "schemaVersion": "v0",
            "comparisonId": f"cmp-{RUN_ID}",
            "runId": RUN_ID,
            "workflowId": "w0-migration-v0",
            "status": comparison_status,
            "matched": matched,
            "comparisonPolicyVersion": "deterministic-output-v1",
            "comparisonPolicyRef": {
                "uri": f"urn:{RUN_ID}/comparison-policy",
                "sha256": "1" * 64,
                "byteSize": 12,
                "kind": "parity-comparison-policy",
            },
            "executionResultRef": {
                "uri": f"urn:{RUN_ID}/execution-result",
                "sha256": "2" * 64,
                "byteSize": 16,
                "kind": "parity-execution-result",
            },
            "comparisonResultRef": {
                "uri": f"urn:{RUN_ID}/comparison-result",
                "sha256": "3" * 64,
                "byteSize": 24,
                "kind": "parity-comparison-result",
            },
            "diffRef": {
                "uri": f"urn:{RUN_ID}/comparison-diff",
                "sha256": "4" * 64,
                "byteSize": 18,
                "kind": "parity-comparison-diff",
            },
            "sourceNormalizedRef": {
                "uri": f"urn:{RUN_ID}/source-normalized",
                "sha256": "5" * 64,
                "byteSize": 16,
                "kind": "oracle-normalized",
            },
            "targetNormalizedRef": {
                "uri": f"urn:{RUN_ID}/target-normalized",
                "sha256": "6" * 64,
                "byteSize": 16,
                "kind": "java-normalized",
            },
            "diffSummary": diff_summary,
            "mismatchClassification": mismatch_classification,
            "createdAt": "2026-05-20T12:00:00Z",
        },
        "goldenMaster": {"classification": "true"},
        "outputRef": {"uri": f"urn:orchestrator/{RUN_ID}/build"},
    }
    if reason is not None:
        payload["reason"] = reason
    return payload


class _StubTransformationAgentInvoker:
    def __init__(self, response: dict | None = None) -> None:
        self._response = dict(response or _transformation_agent_response())
        self.calls: list[dict] = []

    def invoke(self, payload):
        self.calls.append(dict(payload))
        return dict(self._response)


class ParityWorkflowRegressionTests(unittest.TestCase):
    def _config(self, *, repair_budget_max: int = 0) -> OrchestratorConfig:
        base = W0WorkflowRunnerTests._base_config()
        params = base.__dict__.copy()
        params["repair_budget_max"] = repair_budget_max
        return OrchestratorConfig(**params)

    def _runner(
        self,
        gateway,
        *,
        repair_budget_max: int = 0,
        transformation_agent_invoker=None,
    ) -> W0WorkflowRunner:
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-test")
        return W0WorkflowRunner(
            config=self._config(repair_budget_max=repair_budget_max),
            gateway=gateway,
            artifact_store=store,
            transformation_agent_invoker=(
                transformation_agent_invoker or _StubTransformationAgentInvoker()
            ),
        )

    @staticmethod
    def _context() -> W0RunContext:
        return W0RunContext(
            run_id=RUN_ID,
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            execution_mode="parity",
            trust_case_id="HELLOW02",
            source_reference_fixture_id="HELLOW02",
            source_reference_mode="reference-fixture",
            use_transformation_agent=True,
        )

    def _run_case(
        self,
        build_response: dict,
        *,
        repair_budget_max: int = 0,
        source_reference_response: dict | None = None,
    ):
        responses = W0WorkflowRunnerTests._base_responses()
        responses["java.build-test"] = build_response
        if source_reference_response is not None:
            responses["source-reference.execute"] = source_reference_response
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            responses,
        )
        transformation_invoker = _StubTransformationAgentInvoker()
        runner = self._runner(
            gateway,
            repair_budget_max=repair_budget_max,
            transformation_agent_invoker=transformation_invoker,
        )
        result = runner.run(
            context=self._context(),
            input_ref={
                "uri": "urn:source/main.cob",
                "source": "IDENTIFICATION DIVISION.",
            },
        )
        return runner, gateway, transformation_invoker, result

    def test_successful_parity_workflow_records_progress_and_evidence(self) -> None:
        runner, gateway, transformation_invoker, result = self._run_case(
            _parity_build_response()
        )

        self.assertEqual(result["status"], "completed")

        progress_names = {entry["name"] for entry in runner.progress_payload(RUN_ID)}
        self.assertIn("transform", progress_names)
        self.assertIn("source-reference-execution", progress_names)
        self.assertIn("java-build", progress_names)
        self.assertIn("java-execution", progress_names)
        self.assertIn("parity-comparison", progress_names)
        self.assertIn("parity-evidence-capture", progress_names)
        self.assertIn("write-evidence", progress_names)
        self.assertIn("completed", progress_names)

        contract = result["workflowContract"]
        parity = contract["parityComparison"]
        self.assertEqual(parity["status"], "passed")
        self.assertTrue(parity["matched"])
        self.assertEqual(parity["mismatchClassification"], "none")

        evidence_call = next(
            entry
            for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "evidence.writer"
        )
        evidence_payload = evidence_call[2]
        self.assertEqual(evidence_payload["wave"], "w0.2")
        self.assertFalse(evidence_payload["blocked"])
        self.assertIn("parityComparison", evidence_payload["artifacts"])
        self.assertEqual(
            evidence_payload["artifacts"]["parityComparison"]["status"], "passed"
        )
        self.assertEqual(
            evidence_payload["artifacts"]["parityComparison"]["comparisonResultRef"]["kind"],
            "parity-comparison-result",
        )
        self.assertEqual(
            evidence_payload["artifacts"]["parityComparison"]["executionResultRef"]["kind"],
            "parity-execution-result",
        )

    def test_source_reference_failure_blocks_before_build_test(self) -> None:
        source_reference_failure = {
            "schemaVersion": "v0",
            "status": "failed",
            "runId": RUN_ID,
            "workflowId": "w0-migration-v0",
            "summary": "Source/reference execution failed.",
            "diagnostics": [],
            "outputRef": {"uri": f"urn:{RUN_ID}/source-reference"},
        }
        runner, gateway, _, result = self._run_case(
            _parity_build_response(),
            repair_budget_max=0,
            source_reference_response=source_reference_failure,
        )

        self.assertEqual(result["status"], "blocked")
        contract = result["workflowContract"]
        self.assertEqual(contract["finalClassification"], "blocked")
        self.assertEqual(contract["failureCode"], FAILURE_SOURCE_REFERENCE_FAILED)
        self.assertIsNone(contract["parityComparison"])

        progress_names = {entry["name"] for entry in runner.progress_payload(RUN_ID)}
        self.assertIn("source-reference-execution", progress_names)
        self.assertIn("failed", progress_names)
        self.assertNotIn("java-build", progress_names)
        self.assertNotIn("java-execution", progress_names)
        self.assertNotIn("parity-comparison", progress_names)
        self.assertNotIn("completed", progress_names)

        evidence_call = next(
            entry
            for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "evidence.writer"
        )
        evidence_payload = evidence_call[2]
        self.assertEqual(evidence_payload["wave"], "w0.2")
        self.assertTrue(evidence_payload["blocked"])
        self.assertNotIn("parityComparison", evidence_payload["artifacts"])

    def test_parity_failure_modes_block_runs_with_structured_lineage(self) -> None:
        cases = [
            (
                "java_build_failure",
                _parity_build_response(
                    status="failed",
                    classification="compile-error",
                    reason="compile_failed",
                    comparison_status="failed",
                    matched=False,
                    mismatch_classification="content",
                    execution_status="passed",
                    diff_summary="Generated Java failed to compile.",
                ),
                FAILURE_JAVA_COMPILE_FAILED,
                "content",
            ),
            (
                "java_runtime_failure",
                _parity_build_response(
                    status="failed",
                    classification="run-error",
                    reason="runtime_failed",
                    comparison_status="failed",
                    matched=False,
                    mismatch_classification="content",
                    execution_status="failed",
                    diff_summary="Generated Java crashed at runtime.",
                ),
                FAILURE_JAVA_RUNTIME_FAILED,
                "content",
            ),
            (
                "comparison_failure",
                _parity_build_response(
                    status="failed",
                    classification="run-error",
                    reason="oracle_mismatch",
                    comparison_status="failed",
                    matched=False,
                    mismatch_classification="content",
                    execution_status="passed",
                    diff_summary="Outputs diverged during parity comparison.",
                ),
                FAILURE_ORACLE_MISMATCH,
                "content",
            ),
        ]

        for case_name, build_response, expected_failure_code, expected_mismatch in cases:
            with self.subTest(case=case_name):
                runner, gateway, _, result = self._run_case(
                    build_response,
                    repair_budget_max=0,
                )

                self.assertEqual(result["status"], "blocked")
                contract = result["workflowContract"]
                self.assertEqual(contract["finalClassification"], "blocked")
                if expected_failure_code is not None:
                    self.assertEqual(contract["failureCode"], expected_failure_code)

                parity = contract["parityComparison"]
                self.assertEqual(parity["status"], "failed")
                self.assertFalse(parity["matched"])
                self.assertEqual(parity["mismatchClassification"], expected_mismatch)

                progress_names = {entry["name"] for entry in runner.progress_payload(RUN_ID)}
                self.assertIn("transform", progress_names)
                self.assertIn("source-reference-execution", progress_names)
                self.assertIn("java-build", progress_names)
                self.assertIn("java-execution", progress_names)
                self.assertIn("parity-comparison", progress_names)
                self.assertIn("parity-evidence-capture", progress_names)
                self.assertIn("failed", progress_names)
                self.assertNotIn("completed", progress_names)

                evidence_call = next(
                    entry
                    for entry in gateway.calls
                    if entry[0] == "invoke" and entry[1] == "evidence.writer"
                )
                evidence_payload = evidence_call[2]
                self.assertEqual(evidence_payload["wave"], "w0.2")
                self.assertTrue(evidence_payload["blocked"])
                self.assertIn("parityComparison", evidence_payload["artifacts"])
                self.assertEqual(
                    evidence_payload["artifacts"]["parityComparison"]["status"],
                    "failed",
                )
                self.assertEqual(
                    evidence_payload["artifacts"]["parityComparison"]["mismatchClassification"],
                    expected_mismatch,
                )

    def test_oversize_source_reference_summary_is_bounded_at_producer(self) -> None:
        """The orchestrator must apply the 4000-char ceiling to upstream
        ``summary`` text before it lands in the step diagnostic, the W0.2
        state-history transition message, and the run-summary message.

        Symmetric with PR #397/#401's producer-side bounds on the Java side
        (#351/#354): a runaway upstream string would otherwise pass through
        the orchestrator unchecked and fail evidence-ledger schema validation
        at ingest.
        """
        oversize = "x" * (_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 500)
        source_reference_failure = {
            "schemaVersion": "v0",
            "status": "failed",
            "runId": RUN_ID,
            "workflowId": "w0-migration-v0",
            "summary": oversize,
            "diagnostics": [],
            "outputRef": {"uri": f"urn:{RUN_ID}/source-reference"},
        }
        runner, _, _, _ = self._run_case(
            _parity_build_response(),
            repair_budget_max=0,
            source_reference_response=source_reference_failure,
        )

        by_name = {entry["name"]: entry for entry in runner.progress_payload(RUN_ID)}
        diagnostic = by_name["source-reference-execution"].get("diagnostic")
        self.assertIsNotNone(diagnostic)
        self.assertLessEqual(len(diagnostic), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)
        self.assertTrue(
            diagnostic.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL),
            "orchestrator must apply the truncation sentinel when the upstream "
            "summary exceeds the diagnostic ceiling",
        )

        contract = runner.artifact_store.read_json(RUN_ID, "w02-run-contract.json")
        for entry in contract["stateHistory"]:
            message = entry.get("message", "")
            self.assertLessEqual(len(message), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)

        summary = runner.artifact_store.read_json(RUN_ID, "run-summary.json")
        message = summary.get("message", "")
        self.assertLessEqual(len(message), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)
        self.assertTrue(message.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL))

    @staticmethod
    def _comparison_only_failure_response(diff_summary: str) -> dict:
        """Build a parity build-test response where compile and execution
        succeed but the comparison fails.

        The orchestrator infers per-step status from a payload mapping per
        step: ``buildResult``, ``executionResult``, and ``comparisonResult``.
        When ``buildResult`` is omitted the orchestrator falls back to the
        top-level ``status``, which in :func:`_parity_build_response` is
        wired to mirror the overall classification. Setting an explicit
        passed ``buildResult`` is necessary for the parity-comparison step
        to actually exercise the comparison-result diagnostic path rather
        than the build-failed marker path.
        """
        response = _parity_build_response(
            status="failed",
            classification="run-error",
            reason="oracle_mismatch",
            comparison_status="failed",
            matched=False,
            mismatch_classification="content",
            execution_status="passed",
            diff_summary=diff_summary,
        )
        response["buildResult"] = {
            "schemaVersion": "v0",
            "status": "passed",
            "summary": "Generated Java compiled cleanly.",
            "outputRef": {
                "uri": f"urn:{RUN_ID}/build-output",
                "sha256": "7" * 64,
                "byteSize": 12,
                "kind": "parity-build-result",
            },
        }
        return response

    def test_oversize_parity_comparison_diff_summary_is_bounded_at_producer(
        self,
    ) -> None:
        """The parity-comparison step diagnostic reflects the upstream
        ``diffSummary`` from the comparison result. The orchestrator must
        apply the same 4000-char ceiling so a runaway producer-side
        ``diffSummary`` cannot pass through into the evidence-eligible
        ``diagnostic`` field.
        """
        oversize = "y" * (_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 2_500)
        runner, _, _, _ = self._run_case(
            self._comparison_only_failure_response(oversize),
            repair_budget_max=0,
        )

        by_name = {entry["name"]: entry for entry in runner.progress_payload(RUN_ID)}
        comparison_diagnostic = by_name["parity-comparison"].get("diagnostic")
        self.assertIsNotNone(comparison_diagnostic)
        self.assertLessEqual(
            len(comparison_diagnostic), _DIAGNOSTIC_MESSAGE_MAX_LENGTH
        )
        self.assertTrue(
            comparison_diagnostic.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL),
            "parity-comparison step diagnostic must be truncated with the "
            "sentinel when the upstream diffSummary exceeds the ceiling",
        )

    def test_in_bound_diff_summary_is_preserved_unchanged(self) -> None:
        """Bounded inputs must pass through verbatim — the producer-side cap
        must not corrupt or alter ``diffSummary`` values that already satisfy
        the schema ceiling.
        """
        diff_summary = "Outputs diverged on line 12: expected 42, got 41."
        runner, _, _, _ = self._run_case(
            self._comparison_only_failure_response(diff_summary),
            repair_budget_max=0,
        )

        by_name = {entry["name"]: entry for entry in runner.progress_payload(RUN_ID)}
        comparison_diagnostic = by_name["parity-comparison"].get("diagnostic")
        self.assertEqual(comparison_diagnostic, diff_summary)
        self.assertFalse(
            comparison_diagnostic.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL)
        )


class BoundedDiagnosticMessageHelperTests(unittest.TestCase):
    """Unit coverage for :func:`_bounded_diagnostic_message`.

    Each Trust-* issue has had a producer-side bound paired with a regression
    suite that exercises the boundary explicitly (#397 for diagnostic.message,
    #399 for generated-Java diagnostic, #401 for parity-comparison
    diffSummary). The orchestrator-side bound (#355 follow-up) follows the
    same pattern — these tests pin the helper at the four-thousand-char
    boundary so a mutation that drops or shifts the cap is caught.
    """

    def test_returns_none_for_none(self) -> None:
        self.assertIsNone(_bounded_diagnostic_message(None))

    def test_returns_empty_for_empty(self) -> None:
        self.assertEqual(_bounded_diagnostic_message(""), "")

    def test_returns_value_unchanged_when_under_limit(self) -> None:
        value = "Source/reference execution failed."
        self.assertEqual(_bounded_diagnostic_message(value), value)

    def test_returns_value_unchanged_at_limit(self) -> None:
        value = "a" * _DIAGNOSTIC_MESSAGE_MAX_LENGTH
        result = _bounded_diagnostic_message(value)
        self.assertEqual(result, value)
        self.assertEqual(len(result), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)
        self.assertFalse(result.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL))

    def test_truncates_with_sentinel_one_char_over_limit(self) -> None:
        value = "a" * (_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1)
        result = _bounded_diagnostic_message(value)
        self.assertEqual(len(result), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)
        self.assertTrue(result.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL))

    def test_truncates_with_sentinel_for_long_value(self) -> None:
        value = "x" * 50_000
        result = _bounded_diagnostic_message(value)
        self.assertEqual(len(result), _DIAGNOSTIC_MESSAGE_MAX_LENGTH)
        self.assertTrue(result.endswith(_DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL))
        kept = _DIAGNOSTIC_MESSAGE_MAX_LENGTH - len(
            _DIAGNOSTIC_MESSAGE_TRUNCATION_SENTINEL
        )
        self.assertEqual(result[:kept], "x" * kept)


if __name__ == "__main__":
    unittest.main()
