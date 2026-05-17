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
from orchestrator_service.artifacts import KIND_PARSE_OUTPUT, KIND_SOURCE_REF
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


def _model_invocation_ref(
    agent_role: str,
    *,
    invocation_id: str,
    sha: str,
) -> dict[str, JsonValue]:
    return {
        "invocationId": invocation_id,
        "modelId": "gpt-oss-120b",
        "provider": "foundry-development",
        "agentRole": agent_role,
        "status": "completed",
        "ledgerRef": {
            "uri": f"urn:model-gateway/{invocation_id}",
            "sha256": sha,
            "byteSize": 64,
        },
    }


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
                "comparison": {
                    "matched": True,
                    "actualSha256": "b" * 64,
                    "expectedSha256": "b" * 64,
                    "actualRef": {"uri": "urn:run/java-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "java-stdout"},
                    "expectedRef": {"uri": "urn:run/oracle-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "cobol-oracle-stdout"},
                },
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

    def _write_source_and_parse_metadata(self, context: W0RunContext) -> None:
        self.runner.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "source-ref.json",
            {
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "inputRef": {"uri": "urn:source/HELLO.cob", "sha256": "a" * 64, "byteSize": 12},
                "rawInputRef": {"uri": "urn:source/HELLO.cob", "sha256": "a" * 64, "byteSize": 12},
            },
            kind=KIND_SOURCE_REF,
        )
        self.runner.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "parse-output.json",
            {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "program": {"programId": "CASE01"},
            },
            kind=KIND_PARSE_OUTPUT,
        )

    def test_successful_w02_emits_complete_w02_artifacts(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        self._write_source_and_parse_metadata(context)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-2", "sha256": "c" * 64, "byteSize": 1})
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        repair_model_ref = _model_invocation_ref(
            "verification-repair",
            invocation_id="inv-run-evidence-01-repair",
            sha="b" * 64,
        )

        # Simulate one repair attempt that proposed the winning candidate.
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "propose_candidate",
            "failureCategory": "java_compile_failed",
            "javaCandidateRef": {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10, "kind": "transformation-agent-project-manifest"},
            "repairDecisionRef": {"uri": "urn:run/repair-decision-1", "sha256": "e" * 64, "byteSize": 6},
            "modelInvocationRef": repair_model_ref,
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
                "comparison": {
                    "matched": True,
                    "actualSha256": "b" * 64,
                    "expectedSha256": "b" * 64,
                    "actualRef": {"uri": "urn:run/java-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "java-stdout"},
                    "expectedRef": {"uri": "urn:run/oracle-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "cobol-oracle-stdout"},
                },
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
            productive_model_invocations=[transformation_model_ref, repair_model_ref],
        )

        self.assertEqual(payload["wave"], "w0.2")
        self.assertFalse(payload["blocked"])
        artifacts = payload["artifacts"]
        self.assertIn("sourceMetadata", artifacts)
        self.assertIn("parseOutput", artifacts)
        self.assertIn("runtimeVersion", artifacts)
        self.assertEqual(artifacts["runtimeVersion"]["id"], "c2c-target-java-runtime:21")
        self.assertEqual(artifacts["sourceMetadata"]["kind"], KIND_SOURCE_REF)
        self.assertEqual(artifacts["parseOutput"]["kind"], KIND_PARSE_OUTPUT)

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
        self.assertEqual(
            attempts[0]["modelInvocationRef"]["invocationId"],
            "inv-run-evidence-01-repair",
        )

        model_roles = sorted(entry["agentRole"] for entry in artifacts["modelInvocations"])
        self.assertEqual(model_roles, ["transformation", "verification-repair"])

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
        self.assertEqual(oc["actualRef"]["kind"], "java-stdout")
        self.assertEqual(oc["expectedRef"]["kind"], "cobol-oracle-stdout")

    def test_blocked_w02_run_signals_blocked_flag(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        self._write_source_and_parse_metadata(context)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1})
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        repair_model_ref = _model_invocation_ref(
            "verification-repair",
            invocation_id="inv-run-evidence-01-repair",
            sha="b" * 64,
        )
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "refuse",
            "failureCategory": "oracle_mismatch",
            "refusalCode": "unsupported_construct",
            "modelInvocationRef": repair_model_ref,
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
            productive_model_invocations=[transformation_model_ref, repair_model_ref],
        )

        self.assertEqual(payload["wave"], "w0.2")
        self.assertTrue(payload["blocked"])
        artifacts = payload["artifacts"]
        self.assertNotIn("generatedJava", artifacts)
        self.assertNotIn("finalJavaArtifact", artifacts)
        # Repair attempts include the refuse decision with refusalCode.
        attempts = artifacts["repairAttempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["decision"], "refuse")
        self.assertEqual(attempts[0]["refusalCode"], "unsupported_construct")
        self.assertEqual(
            attempts[0]["modelInvocationRef"]["invocationId"],
            "inv-run-evidence-01-repair",
        )
        # When the run is blocked we keep candidate history only as an
        # unselected audit trail, never as an authoritative final artifact.
        history = artifacts.get("generatedJavaArtifacts") or []
        selected = [e for e in history if e.get("selected")]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["origin"], "deterministic-baseline")
        self.assertEqual(selected, [])
        # Oracle comparison surfaces matched=False.
        self.assertFalse(artifacts["oracleComparison"]["matched"])

    def test_w02_payload_does_not_fabricate_source_or_parse_metadata(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/baseline"),
            build_test_output=_step("compile-test-java", output_uri="urn:run/build-1"),
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload={"schemaVersion": "v0", "runId": "run-evidence", "steps": []},
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
            productive_model_invocations=[transformation_model_ref],
        )

        artifacts = payload["artifacts"]
        self.assertNotIn("sourceMetadata", artifacts)
        self.assertNotIn("parseOutput", artifacts)

    def test_w02_payload_uses_persisted_source_and_parse_metadata_when_available(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-2", "sha256": "c" * 64, "byteSize": 1})

        source_meta = self.runner.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "source-ref.json",
            {
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "inputRef": {"uri": "urn:source/HELLO.cob", "sha256": "a" * 64, "byteSize": 12},
                "rawInputRef": {"uri": "urn:source/HELLO.cob", "sha256": "a" * 64, "byteSize": 12},
            },
            kind=KIND_SOURCE_REF,
        )
        parse_meta = self.runner.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "parse-output.json",
            {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "program": {"programId": "CASE01"},
            },
            kind=KIND_PARSE_OUTPUT,
        )

        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "comparison": {"matched": True, "actualSha256": "b" * 64, "expectedSha256": "b" * 64},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-2",
        )
        contract.record_agent_attempt()
        final_ref = {"uri": "urn:run/transformation-agent", "sha256": "d" * 64, "byteSize": 10, "kind": "transformation-agent-project-manifest"}
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12, "kind": "generated-project-manifest"}

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
            productive_model_invocations=[transformation_model_ref],
        )

        artifacts = payload["artifacts"]
        self.assertEqual(artifacts["sourceMetadata"]["uri"], source_meta.uri)
        self.assertEqual(artifacts["sourceMetadata"]["kind"], KIND_SOURCE_REF)
        self.assertEqual(artifacts["parseOutput"]["uri"], parse_meta.uri)
        self.assertEqual(artifacts["parseOutput"]["kind"], KIND_PARSE_OUTPUT)
        self.assertEqual(len(artifacts["generatedJavaArtifacts"]), 2)
        self.assertEqual(artifacts["generatedJavaArtifacts"][0]["origin"], "deterministic-baseline")
        self.assertEqual(artifacts["generatedJavaArtifacts"][1]["origin"], "transformation-agent")
        self.assertTrue(artifacts["generatedJavaArtifacts"][1]["selected"])
        self.assertEqual(artifacts["finalJavaArtifact"]["uri"], final_ref["uri"])
        self.assertTrue(artifacts["finalJavaArtifact"]["selected"])

    def test_repair_attempt_without_build_ref_is_not_fabricated(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-final", "sha256": "c" * 64, "byteSize": 1})
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        repair_model_ref = _model_invocation_ref(
            "verification-repair",
            invocation_id="inv-run-evidence-01-repair",
            sha="b" * 64,
        )
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "propose_candidate",
            "failureCategory": "java_compile_failed",
            "javaCandidateRef": {"uri": "urn:run/repair-1", "sha256": "d" * 64, "byteSize": 10},
            "repairDecisionRef": {"uri": "urn:run/repair-decision-1", "sha256": "e" * 64, "byteSize": 6},
            "modelInvocationRef": repair_model_ref,
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
            productive_model_invocations=[transformation_model_ref, repair_model_ref],
        )

        artifacts = payload["artifacts"]
        self.assertNotIn("repairAttempts", artifacts)
        roles = sorted(entry["agentRole"] for entry in artifacts["agentTrajectories"])
        self.assertEqual(roles, ["orchestrator", "transformation", "verification-repair"])

    def test_no_change_w02_evidence_carries_attempt_model_invocation(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1})
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        repair_model_ref = _model_invocation_ref(
            "verification-repair",
            invocation_id="inv-run-evidence-01-repair",
            sha="b" * 64,
        )
        contract.record_repair_attempt({
            "attemptNumber": 1,
            "repairDecision": "no_change",
            "failureCategory": "java_compile_failed",
            "javaCandidateRef": {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12},
            "repairDecisionRef": {"uri": "urn:run/repair-decision-1", "sha256": "e" * 64, "byteSize": 6},
            "modelInvocationRef": repair_model_ref,
            "buildTestResultRef": {"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1},
            "rationale": "same candidate",
        })
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}
        build = _step(
            "compile-test-java",
            payload={
                "status": "failed",
                "classification": "java_compile_failed",
                "comparison": {"matched": False},
                "goldenMaster": {"classification": "synthetic"},
            },
            output_uri="urn:run/build-1",
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
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=True,
            productive_model_invocations=[transformation_model_ref, repair_model_ref],
        )

        attempt = payload["artifacts"]["repairAttempts"][0]
        self.assertTrue(attempt["noChange"])
        self.assertEqual(attempt["decision"], "no_change")
        self.assertEqual(
            attempt["modelInvocationRef"]["invocationId"],
            "inv-run-evidence-01-repair",
        )

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
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
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
            trajectory_payload=trajectory,
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
            productive_model_invocations=[transformation_model_ref],
        )
        self.assertEqual(payload["artifacts"]["oracleComparison"]["oracleKind"], "absent")


if __name__ == "__main__":
    unittest.main()
