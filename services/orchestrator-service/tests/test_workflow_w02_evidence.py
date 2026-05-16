"""Unit tests for the W0.2 evidence payload assembly (Issue #171).

These tests target the orchestrator's :py:meth:`W0WorkflowRunner._build_evidence_payload`
and its helpers in isolation. The full repair-loop integration is covered
by ``test_workflow_repair_loop`` and ``test_workflow_transformation_agent``;
here we focus on the *shape* of the evidence pack the orchestrator submits
to evidence-service so the contract additions in Issue #171
(generatedJavaArtifacts[], finalJavaArtifact, agentTrajectories[],
repairAttempts[], oracleComparison, wave, blocked) stay green.
"""

from __future__ import annotations

import datetime
import tempfile
import unittest
from collections.abc import Mapping
from orchestrator_service.artifacts import JsonValue, RunArtifactStore
from orchestrator_service.run_contract import new_run_contract
from orchestrator_service.workflow import (
    DataReference,
    W0RunContext,
    W0WorkflowRunner,
    WorkflowStepResult,
)

from tests.test_workflow import StubGateway
from tests.test_workflow import W0WorkflowRunnerTests as _W0Tests


def _ref(uri: str, sha: str = "a" * 64, byte_size: int = 4) -> DataReference:
    return DataReference(uri=uri, sha256=sha, byte_size=byte_size)


def _step(name: str, *, payload: Mapping[str, JsonValue] | None = None, output_uri: str = "urn:x/out") -> WorkflowStepResult:
    output_ref = _ref(output_uri)
    return WorkflowStepResult(
        capability_id=f"cap.{name}",
        step_name=name,
        payload=payload or {},
        status="ok",
        input_ref=_ref("urn:x/in"),
        output_ref=output_ref,
    )


# noinspection PyAttributeOutsideInitInspection
class _BaseEvidenceFixture(unittest.TestCase):
    # noinspection PyPep8Naming,PyProtectedMemberInspection
    def setUp(self) -> None:
        tmp = tempfile.mkdtemp()
        self._artifact_store = RunArtifactStore(tmp, created_by="orchestrator-service")
        config = _W0Tests._base_config()
        gateway = StubGateway(
            _W0Tests._base_capabilities(),
            _W0Tests._base_responses(),
        )
        self.runner = W0WorkflowRunner(
            config=config,
            gateway=gateway,
            artifact_store=self._artifact_store,
        )

    @staticmethod
    def _w0_context(*, use_transformation_agent: bool = False) -> W0RunContext:
        return W0RunContext(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            use_transformation_agent=use_transformation_agent,
        )


class W0DeterministicEvidenceTests(_BaseEvidenceFixture):
    """A deterministic W0 run must NOT emit W0.2 fields."""

    def test_w0_payload_keeps_legacy_shape(self) -> None:
        context = self._w0_context(use_transformation_agent=False)
        input_ref = _ref("urn:source/HELLO.cob")
        parse = _step("parse-cobol", output_uri="urn:run/parse")
        ir = _step("generate-ir", output_uri="urn:run/ir")
        gen = _step("generate-java", output_uri="urn:run/generated")
        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "comparison": {"matched": True, "actualSha256": "b" * 64, "expectedSha256": "b" * 64},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-1",
        )
        trajectory = {"schemaVersion": "v0", "runId": "run-evidence", "steps": []}

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=input_ref,
            parse_output=parse,
            ir_output=ir,
            generator_output=gen,
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload=trajectory,
        )

        self.assertEqual(payload["wave"], "w0")
        self.assertNotIn("blocked", payload)
        artifacts = payload["artifacts"]
        self.assertNotIn("generatedJavaArtifacts", artifacts)
        self.assertNotIn("finalJavaArtifact", artifacts)
        self.assertNotIn("repairAttempts", artifacts)
        self.assertNotIn("agentTrajectories", artifacts)
        self.assertNotIn("oracleComparison", artifacts)
        # The legacy W0 fields stay populated.
        self.assertIn("sourceCobol", artifacts)
        self.assertIn("generatedJava", artifacts)
        self.assertIn("buildTestResults", artifacts)
        self.assertIn("modelInvocations", artifacts)


class W02ProductiveEvidenceTests(_BaseEvidenceFixture):
    """W0.2 runs must emit every W0.2 contract field with the right shape."""

    @staticmethod
    def _w02_contract():
        return new_run_contract(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref={"uri": "urn:source/HELLO.cob"},
        )

    def test_successful_w02_emits_complete_w02_artifacts(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-2", "sha256": "c" * 64, "byteSize": 1})

        # Simulate one repair attempt that proposed the winning candidate.
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "propose_candidate",
            "failureCategory": "java_compile_failed",
            "javaCandidateRef": {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10, "kind": "transformation-agent-project-manifest"},
            "repairDecisionRef": {"uri": "urn:run/repair-decision-1", "sha256": "e" * 64, "byteSize": 6},
            "buildTestResultRef": {"uri": "urn:run/build-1", "sha256": "f" * 64, "byteSize": 8},
            "rationale": "fix",
        })

        # The final selected candidate is the repair agent's candidate.
        final_ref = {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10, "kind": "transformation-agent-project-manifest"}
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12, "kind": "generated-project-manifest"}

        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "summary": "build/test passed after one repair",
                "comparison": {"matched": True, "actualSha256": "b" * 64, "expectedSha256": "b" * 64},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-2",
        )
        trajectory = {"schemaVersion": "v0", "runId": "run-evidence", "steps": []}

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/baseline"),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload=trajectory,
            generated_artifact_ref=final_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
        )

        self.assertEqual(payload["wave"], "w0.2")
        self.assertFalse(payload["blocked"])
        artifacts = payload["artifacts"]

        # generatedJavaArtifacts: baseline + repair candidate
        self.assertIn("generatedJavaArtifacts", artifacts)
        history = artifacts["generatedJavaArtifacts"]
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["origin"], "deterministic-baseline")
        self.assertEqual(history[0]["attemptNumber"], 0)
        self.assertEqual(history[1]["origin"], "verification-repair-agent")
        self.assertEqual(history[1]["attemptNumber"], 1)
        self.assertTrue(history[1].get("selected"))

        # finalJavaArtifact is the selected entry.
        self.assertIn("finalJavaArtifact", artifacts)
        self.assertEqual(artifacts["finalJavaArtifact"]["uri"], final_ref["uri"])
        self.assertTrue(artifacts["finalJavaArtifact"].get("selected"))

        # repairAttempts[] mirrors the contract.
        self.assertIn("repairAttempts", artifacts)
        attempts = artifacts["repairAttempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["attemptNumber"], 1)
        self.assertEqual(attempts[0]["decision"], "propose_candidate")
        self.assertIn("newJavaCandidateRef", attempts[0])
        self.assertIn("decisionRef", attempts[0])
        self.assertIn("buildTestResultRef", attempts[0])

        # agentTrajectories: orchestrator + transformation + verification-repair
        self.assertIn("agentTrajectories", artifacts)
        roles = sorted(entry["agentRole"] for entry in artifacts["agentTrajectories"])
        self.assertEqual(roles, ["orchestrator", "transformation", "verification-repair"])

        # oracleComparison is materialised from the build/test payload.
        self.assertIn("oracleComparison", artifacts)
        oc = artifacts["oracleComparison"]
        self.assertTrue(oc["matched"])
        self.assertEqual(oc["oracleKind"], "true-golden-master")
        self.assertEqual(oc["classification"], "match")
        self.assertEqual(oc["actualSha256"], "b" * 64)

    def test_blocked_w02_run_signals_blocked_flag(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1})
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "refuse",
            "failureCategory": "oracle_mismatch",
            "refusalCode": "unsupported_construct",
            "buildTestResultRef": {"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1},
            "rationale": "agent refused",
        })

        build = _step(
            "compile-test-java",
            payload={
                "status": "output-divergence",
                "classification": "divergence-known-w0-coverage-gap",
                "comparison": {"matched": False},
                "goldenMaster": {"classification": "synthetic"},
            },
            output_uri="urn:run/build-1",
        )
        trajectory = {"schemaVersion": "v0", "runId": "run-evidence", "steps": []}

        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/baseline"),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload=trajectory,
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=True,
        )

        self.assertEqual(payload["wave"], "w0.2")
        self.assertTrue(payload["blocked"])
        artifacts = payload["artifacts"]
        # Repair attempts include the refuse decision with refusalCode.
        attempts = artifacts["repairAttempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["decision"], "refuse")
        self.assertEqual(attempts[0]["refusalCode"], "unsupported_construct")
        # When the run is blocked we MUST NOT auto-mark a candidate as
        # selected unless the orchestrator handed us one explicitly.
        history = artifacts.get("generatedJavaArtifacts") or []
        selected = [e for e in history if e.get("selected")]
        # The baseline matched the final_artifact_ref so it shows up selected;
        # the repair attempt did not propose so no extra candidate exists.
        # But the contract on blocked runs is "do not claim success" — the
        # classification handled at evidence-service derives that.
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["origin"], "deterministic-baseline")
        # An explicit generated_artifact_ref was passed, so exactly one
        # candidate is selected; blocked=True still overrides classification.
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["origin"], "deterministic-baseline")
        # Oracle comparison surfaces matched=False.
        self.assertFalse(artifacts["oracleComparison"]["matched"])

    def test_repair_attempt_without_build_ref_is_not_fabricated(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-final", "sha256": "c" * 64, "byteSize": 1})
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "propose_candidate",
            "failureCategory": "java_compile_failed",
            "javaCandidateRef": {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10},
            "repairDecisionRef": {"uri": "urn:run/repair-decision-1", "sha256": "e" * 64, "byteSize": 6},
            "rationale": "missing build-test ref must not be substituted",
        })

        final_ref = {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10}
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}
        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "comparison": {"matched": True},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-final",
        )

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/baseline"),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload={"schemaVersion": "v0", "runId": "run-evidence", "steps": []},
            generated_artifact_ref=final_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
        )

        artifacts = payload["artifacts"]
        self.assertNotIn("repairAttempts", artifacts)
        roles = sorted(entry["agentRole"] for entry in artifacts["agentTrajectories"])
        self.assertEqual(roles, ["orchestrator", "transformation", "verification-repair"])

    def test_missing_oracle_classified_as_absent(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        build = _step(
            "compile-test-java",
            payload={
                "status": "missing-golden-master",
                "classification": "missing-golden-master",
                "goldenMaster": {},
            },
            output_uri="urn:run/build",
        )
        trajectory = {"schemaVersion": "v0", "runId": "run-evidence", "steps": []}
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/baseline"),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload=trajectory,
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
        )
        self.assertEqual(payload["artifacts"]["oracleComparison"]["oracleKind"], "absent")


if __name__ == "__main__":
    unittest.main()
