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
from orchestrator_service.artifacts import (
    KIND_EVIDENCE_PACK_MANIFEST,
    KIND_PARSE_OUTPUT,
    KIND_SOURCE_REF,
    JsonValue,
    RunArtifactStore,
)
from orchestrator_service.run_contract import (
    ASSIST_AGENT_ROLE_TRANSFORMATION,
    ASSIST_OUTCOME_REQUIRED,
    ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_FAILED,
    CLASSIFICATION_INCOMPLETE,
    CLASSIFICATION_SUCCESS,
    AssistDecision,
    IntentionalDivergenceDecision,
    FAILURE_EVIDENCE_INCOMPLETE,
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_RUNTIME_FAILED,
    new_run_contract,
)
from orchestrator_service.workflow import (
    DataReference,
    W0RunContext,
    W0WorkflowRunner,
    WorkflowStepResult,
)
from orchestrator_service.trust_cases import load_trust_case_catalog

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
            # Keep this fixture deterministic by pinning finite budgets.
            # Production defaults are now unlimited, but this suite verifies
            # lineage math on a small, bounded contract surface.
            repair_budget_limit=2,
            assist_budget_limit=1,
            model_invocation_budget_limit=6,
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
                "comparisonResult": {
                    "status": "passed",
                    "matched": True,
                    "comparisonPolicyVersion": "deterministic-output-v1",
                    "mismatchClassification": "none",
                    "comparisonPolicyRef": {"uri": "urn:run/policy", "sha256": "1" * 64, "byteSize": 12, "kind": "parity-comparison-policy"},
                    "comparisonResultRef": {"uri": "urn:run/comparison-result", "sha256": "2" * 64, "byteSize": 24, "kind": "parity-comparison-result"},
                    "diffRef": {"uri": "urn:run/comparison-diff", "sha256": "3" * 64, "byteSize": 18, "kind": "parity-comparison-diff"},
                    "sourceNormalizedRef": {"uri": "urn:run/source-normalized", "sha256": "4" * 64, "byteSize": 16, "kind": "oracle-normalized"},
                    "targetNormalizedRef": {"uri": "urn:run/target-normalized", "sha256": "5" * 64, "byteSize": 16, "kind": "java-normalized"},
                    "sourceStdoutRef": {"uri": "urn:run/oracle-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "cobol-oracle-stdout"},
                    "targetStdoutRef": {"uri": "urn:run/java-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "java-stdout"},
                    "diffSummary": "Outputs matched after deterministic normalization.",
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
        self.assertEqual(oc["status"], "passed")
        self.assertEqual(oc["comparisonPolicyVersion"], "deterministic-output-v1")
        self.assertEqual(oc["mismatchClassification"], "none")
        self.assertEqual(oc["comparisonResultRef"]["kind"], "parity-comparison-result")
        self.assertEqual(oc["diffRef"]["kind"], "parity-comparison-diff")

    def test_resolved_trust_case_is_persisted_on_contract_and_evidence(self) -> None:
        trust_case = load_trust_case_catalog().resolve(
            "HELLOW02-DEFAULT",
            program_id="HELLOW02",
        ).to_identity_payload()
        context = W0RunContext(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            execution_mode="parity",
            trust_case_id="HELLOW02-DEFAULT",
            trust_case_resolution=trust_case,
            source_reference_fixture_id="HELLOW02",
            source_reference_mode="reference-fixture",
            use_transformation_agent=True,
        )
        self._write_source_and_parse_metadata(context)
        contract = self.runner._init_w02_contract(
            context,
            _ref("urn:source/HELLO.cob"),
        )

        contract_snapshot = self.runner.artifact_store.read_json(
            context.run_id,
            "w02-run-contract.json",
        )
        self.assertIsNotNone(contract_snapshot)
        self.assertEqual(
            contract_snapshot["resolvedTrustCase"]["trustCaseId"],
            "HELLOW02-DEFAULT",
        )
        self.assertEqual(
            contract_snapshot["resolvedTrustCase"]["catalogVersion"],
            "2026-05-21",
        )
        self.assertEqual(
            contract_snapshot["resolvedTrustCase"]["sourceReferenceFixtureId"],
            "HELLOW02",
        )
        self.assertEqual(
            contract_snapshot["resolvedTrustCase"]["runtimeProgramArgs"],
            [],
        )

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
                "comparisonResult": {
                    "status": "passed",
                    "matched": True,
                    "comparisonPolicyVersion": "deterministic-output-v1",
                    "mismatchClassification": "none",
                    "comparisonPolicyRef": {"uri": "urn:run/policy", "sha256": "1" * 64, "byteSize": 12, "kind": "parity-comparison-policy"},
                    "comparisonResultRef": {"uri": "urn:run/comparison-result", "sha256": "2" * 64, "byteSize": 24, "kind": "parity-comparison-result"},
                    "diffRef": {"uri": "urn:run/comparison-diff", "sha256": "3" * 64, "byteSize": 18, "kind": "parity-comparison-diff"},
                    "sourceNormalizedRef": {"uri": "urn:run/source-normalized", "sha256": "4" * 64, "byteSize": 16, "kind": "oracle-normalized"},
                    "targetNormalizedRef": {"uri": "urn:run/target-normalized", "sha256": "5" * 64, "byteSize": 16, "kind": "java-normalized"},
                    "sourceStdoutRef": {"uri": "urn:run/oracle-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "cobol-oracle-stdout"},
                    "targetStdoutRef": {"uri": "urn:run/java-stdout", "sha256": "b" * 64, "byteSize": 16, "kind": "java-stdout"},
                    "diffSummary": "Outputs matched after deterministic normalization.",
                },
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-trust-case",
        )

        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/generator"),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload={"schemaVersion": "v0", "runId": "run-evidence", "steps": []},
            w02_contract=contract,
            w02_blocked=False,
        )

        trust_case_artifact = payload["artifacts"]["trustCase"]
        self.assertEqual(trust_case_artifact["trustCaseId"], "HELLOW02-DEFAULT")
        self.assertEqual(trust_case_artifact["catalogVersion"], "2026-05-21")
        self.assertTrue(trust_case_artifact["catalogHash"])
        self.assertTrue(trust_case_artifact["configurationDigest"])
        self.assertEqual(trust_case_artifact["sourceReferenceFixtureId"], "HELLOW02")
        self.assertEqual(trust_case_artifact["sourceReferenceMode"], "reference-fixture")
        self.assertEqual(trust_case_artifact["environmentProfileId"], "generated-java-sandbox-v1")
        self.assertEqual(trust_case_artifact["comparisonPolicyVersion"], "deterministic-output-v1")
        self.assertEqual(trust_case_artifact["runtimeProgramArgs"], [])
        self.assertIn("artifactRef", trust_case_artifact)
        self.assertEqual(trust_case_artifact["artifactRef"]["kind"], "trust-case")

        persisted = self.runner.artifact_store.read_json(
            context.run_id,
            "executed-trust-case.json",
        )
        self.assertEqual(persisted["trustCaseId"], "HELLOW02-DEFAULT")
        self.assertEqual(persisted["catalogVersion"], "2026-05-21")

    def test_w02_payload_projects_runner_comparison_lineage(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        self._write_source_and_parse_metadata(context)
        contract = self._w02_contract()
        baseline_ref = {
            "uri": "urn:run/baseline",
            "sha256": "1" * 64,
            "byteSize": 12,
            "kind": "generated-project-manifest",
        }
        build = _step(
            "compile-test-java",
            payload={
                "status": "output-divergence",
                "classification": "divergence-unknown",
                "executionResult": {
                    "schemaVersion": "v0",
                    "executionId": "exec-1",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "executionSurface": "generated-java",
                    "command": "java -jar generated.jar",
                    "status": "passed",
                    "exitCode": 0,
                    "timedOut": False,
                    "stdoutRef": {"uri": "urn:stdout", "sha256": "a" * 64, "byteSize": 12},
                    "stderrRef": {"uri": "urn:stderr", "sha256": "b" * 64, "byteSize": 0},
                    "normalizedOutputRef": {
                        "uri": "urn:target-normalized",
                        "sha256": "c" * 64,
                        "byteSize": 14,
                    },
                    "diagnostics": [],
                    "createdAt": "2026-05-20T12:00:00Z",
                },
                "comparison": {
                    "matched": False,
                    "normalisation": "trust-5-deterministic-v1",
                    "expectedRef": {
                        "uri": "urn:source-output",
                        "sha256": "d" * 64,
                        "byteSize": 14,
                        "kind": "reference-output",
                    },
                    "actualRef": {
                        "uri": "urn:java-output",
                        "sha256": "e" * 64,
                        "byteSize": 14,
                        "kind": "java-stdout",
                    },
                    "diff": "@@ normalized-line-1 @@\n-REFERENCE\n+JAVA\n",
                },
                "comparisonResult": {
                    "schemaVersion": "v0",
                    "comparisonId": "cmp-1",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "status": "failed",
                    "comparisonPolicyVersion": "trust-5-deterministic-v1",
                    "comparisonPolicyRef": {
                        "uri": "urn:comparison-policy",
                        "sha256": "f" * 64,
                        "byteSize": 40,
                    },
                    "sourceNormalizedRef": {
                        "uri": "urn:source-normalized",
                        "sha256": "7" * 64,
                        "byteSize": 14,
                    },
                    "targetNormalizedRef": {
                        "uri": "urn:target-normalized",
                        "sha256": "c" * 64,
                        "byteSize": 14,
                    },
                    "diffSummary": "first divergence at normalized line 1",
                    "mismatchClassification": "content",
                    "createdAt": "2026-05-20T12:00:00Z",
                },
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-compare",
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
            w02_blocked=False,
            productive_model_invocations=[],
        )

        parity = payload["artifacts"]["parityComparison"]
        self.assertEqual(parity["status"], "failed")
        self.assertFalse(parity["matched"])
        self.assertEqual(
            parity["comparisonPolicyVersion"], "trust-5-deterministic-v1"
        )
        self.assertEqual(
            parity["comparisonPolicyRef"]["uri"], "urn:comparison-policy"
        )
        self.assertEqual(
            parity["executionResultRef"]["kind"], "parity-execution-result"
        )
        self.assertEqual(
            parity["comparisonResultRef"]["kind"], "parity-comparison-result"
        )
        self.assertEqual(parity["diffRef"]["kind"], "parity-comparison-diff")
        self.assertEqual(parity["mismatchClassification"], "content")

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

    def _trust_summary(
        self,
        *,
        context: W0RunContext,
        contract,
        build_test_output: WorkflowStepResult | None,
        final_classification: str,
        failure_code: str | None,
        evidence_materialized: bool,
    ) -> dict[str, JsonValue]:
        evidence_meta = self.runner.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "evidence-pack-manifest.json",
            {"status": "complete" if evidence_materialized else "incomplete"},
            kind=KIND_EVIDENCE_PACK_MANIFEST,
        )
        contract.set_evidence_pack_ref(
            {
                "uri": "urn:evidence-pack",
                "sha256": "9" * 64,
                "byteSize": 1,
            }
        )
        summary = self.runner._build_trust_summary(
            context=context,
            contract=contract,
            build_test_output=build_test_output,
            evidence_pack_meta=evidence_meta,
            final_classification=final_classification,
            failure_code=failure_code,
            evidence_materialized=evidence_materialized,
        )
        contract.set_trust_summary(summary)
        return summary

    def test_trust_summary_projects_parity_pass_and_evidence_refs(self) -> None:
        trust_case = load_trust_case_catalog().resolve(
            "HELLOW02-DEFAULT",
            program_id="HELLOW02",
        ).to_identity_payload()
        context = W0RunContext(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            execution_mode="parity",
            trust_case_id="HELLOW02-DEFAULT",
            trust_case_resolution=trust_case,
            source_reference_fixture_id="HELLOW02",
            source_reference_mode="reference-fixture",
            use_transformation_agent=True,
        )
        contract = self._w02_contract()
        contract.set_build_test_result_ref({"uri": "urn:run/build-1", "sha256": "c" * 64, "byteSize": 1})
        contract.set_parity_comparison(
            {
                "matched": True,
                "comparisonResultRef": {
                    "uri": "urn:run/comparison-result",
                    "sha256": "2" * 64,
                    "byteSize": 24,
                    "kind": "parity-comparison-result",
                },
                "diffRef": {
                    "uri": "urn:run/comparison-diff",
                    "sha256": "3" * 64,
                    "byteSize": 18,
                    "kind": "parity-comparison-diff",
                },
            }
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=_step(
                "compile-test-java",
                payload={
                    "status": "ok",
                    "classification": "match",
                    "comparison": {"matched": True},
                    "goldenMaster": {"classification": "true"},
                },
                output_uri="urn:run/build-1",
            ),
            final_classification=CLASSIFICATION_SUCCESS,
            failure_code=None,
            evidence_materialized=True,
        )

        self.assertEqual(summary["trustState"], "parity_passed")
        self.assertEqual(summary["trustCase"]["trustCaseId"], "HELLOW02-DEFAULT")
        self.assertEqual(summary["comparisonResult"]["status"], "matched")
        self.assertEqual(summary["repairStatus"], "not_attempted")
        self.assertEqual(summary["coverageStatus"], "full")
        self.assertEqual(summary["warningCodes"], [])
        self.assertEqual(summary["evidence"]["packRef"]["uri"], "urn:evidence-pack")
        self.assertEqual(
            summary["evidence"]["recordedAt"],
            contract.trust_summary["evidence"]["recordedAt"],
        )

    def test_trust_summary_projects_build_failure_and_known_coverage_gap_warning(self) -> None:
        trust_case = load_trust_case_catalog().resolve(
            "HELLOW02-DEFAULT",
            program_id="HELLOW02",
        ).to_identity_payload()
        context = W0RunContext(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            execution_mode="parity",
            trust_case_id="HELLOW02-DEFAULT",
            trust_case_resolution=trust_case,
            source_reference_fixture_id="HELLOW02",
            source_reference_mode="reference-fixture",
            use_transformation_agent=True,
        )
        contract = self._w02_contract()
        build_output = _step(
            "compile-test-java",
            payload={
                "status": "failed",
                "classification": "divergence-known-w0-coverage-gap",
                "mismatchClassification": "known-w0-coverage-gap",
                "goldenMaster": {"classification": "synthetic"},
            },
            output_uri="urn:run/build-failed",
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=build_output,
            final_classification=CLASSIFICATION_BLOCKED,
            failure_code=FAILURE_JAVA_COMPILE_FAILED,
            evidence_materialized=True,
        )

        self.assertEqual(summary["trustState"], "build_failed")
        self.assertEqual(summary["repairStatus"], "not_attempted")
        self.assertEqual(summary["coverageStatus"], "limited")
        warning_codes = summary["warningCodes"]
        self.assertIn("limited_coverage", warning_codes)
        self.assertIn("known_coverage_gap", warning_codes)

    def test_trust_summary_projects_runtime_failure_and_evidence_incomplete(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.record_repair_attempt(
            {
                "attemptNumber": 1,
                "repairDecision": "refuse",
                "failureCategory": "java_runtime_failed",
                "buildTestResultRef": {
                    "uri": "urn:run/build-runtime",
                    "sha256": "c" * 64,
                    "byteSize": 1,
                },
            }
        )
        build_output = _step(
            "compile-test-java",
            payload={
                "status": "failed",
                "classification": "runtime_failed",
                "runtimeStatus": "failed",
                "goldenMaster": {"classification": "synthetic"},
            },
            output_uri="urn:run/build-runtime",
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=build_output,
            final_classification=CLASSIFICATION_FAILED,
            failure_code=FAILURE_JAVA_RUNTIME_FAILED,
            evidence_materialized=False,
        )

        self.assertEqual(summary["trustState"], "runtime_failed")
        self.assertEqual(summary["javaResult"]["status"], "runtime_failed")
        self.assertEqual(summary["evidence"]["status"], "incomplete")
        self.assertEqual(summary["repairStatus"], "repair_blocked")
        self.assertEqual(summary["evidence"]["packRef"]["uri"], "urn:evidence-pack")
        self.assertEqual(
            summary["evidence"]["recordedAt"],
            contract.trust_summary["evidence"]["recordedAt"],
        )

    def test_trust_summary_projects_intentional_divergence_with_stale_evidence(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        comparison_result_ref = {
            "uri": "urn:run/comparison-result",
            "sha256": "2" * 64,
            "byteSize": 24,
        }
        contract.set_parity_comparison(
            {
                "matched": False,
                "mismatchClassification": "content",
                "completedAt": "9999-12-31T23:59:59Z",
                "comparisonResultRef": comparison_result_ref,
            }
        )
        contract.record_intentional_divergence_decision(
            IntentionalDivergenceDecision(
                decision_id="decision-1",
                run_id="run-evidence",
                workflow_id="w0-migration-v0",
                comparison_result_ref=comparison_result_ref,
                reviewer={
                    "reviewerId": "reviewer-1",
                    "displayName": "Reviewer One",
                    "role": "approver",
                },
                rationale={
                    "summary": "Business policy requires the mismatch.",
                    "technicalBasis": "The target output intentionally diverges.",
                    "businessImpact": "The changed output is expected.",
                },
                linked_evidence_refs=(
                    {
                        "uri": "urn:run/evidence",
                        "sha256": "4" * 64,
                        "byteSize": 8,
                    },
                ),
                affected_outputs=("java_output", "normalized_output"),
                invalidation_triggers=(
                    "comparison_result_changed",
                    "expires_at_reached",
                ),
                decided_at="2025-05-21T12:00:00Z",
            ),
            {
                "uri": "urn:run/decision-record",
                "sha256": "3" * 64,
                "byteSize": 10,
            },
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=None,
            final_classification=CLASSIFICATION_FAILED,
            failure_code=None,
            evidence_materialized=True,
        )

        self.assertEqual(summary["trustState"], "intentional_divergence")
        self.assertEqual(summary["divergenceDisposition"], "intentional")
        self.assertEqual(summary["comparisonResult"]["decisionStatus"], "active")
        self.assertEqual(
            summary["intentionalDivergenceDecision"]["decisionRef"]["uri"],
            "urn:run/decision-record",
        )
        self.assertEqual(summary["evidence"]["status"], "stale")
        self.assertEqual(
            summary["comparisonResult"]["decisionRecordRef"]["uri"],
            "urn:run/decision-record",
        )

    def test_trust_summary_projects_evidence_incomplete_without_runtime_or_build_failure(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=None,
            final_classification=CLASSIFICATION_INCOMPLETE,
            failure_code=FAILURE_EVIDENCE_INCOMPLETE,
            evidence_materialized=False,
        )

        self.assertEqual(summary["trustState"], "blocked")
        self.assertEqual(summary["evidence"]["status"], "incomplete")
        self.assertEqual(summary["comparisonResult"]["status"], "not_available")
        self.assertEqual(summary["repairStatus"], "not_attempted")

    def test_trust_summary_projects_parity_failure_with_unknown_divergence(self) -> None:
        # No intentional-divergence decision is recorded, so the disposition is
        # "unknown" rather than "intentional".
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        comparison_result_ref = {
            "uri": "urn:run/comparison-result-fail",
            "sha256": "f" * 64,
            "byteSize": 32,
        }
        diff_ref = {
            "uri": "urn:run/diff-fail",
            "sha256": "e" * 64,
            "byteSize": 8,
        }
        contract.set_parity_comparison(
            {
                "matched": False,
                "mismatchClassification": "content",
                "comparisonResultRef": comparison_result_ref,
                "diffRef": diff_ref,
            }
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=None,
            final_classification=CLASSIFICATION_FAILED,
            failure_code=None,
            evidence_materialized=True,
        )

        self.assertEqual(summary["trustState"], "parity_failed")
        self.assertEqual(summary["divergenceDisposition"], "unknown")
        self.assertEqual(summary["comparisonResult"]["status"], "mismatched")
        self.assertEqual(
            summary["comparisonResult"]["comparisonResultRef"]["uri"],
            "urn:run/comparison-result-fail",
        )

    def test_trust_summary_projects_repair_verified_after_winning_candidate(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.record_repair_attempt(
            {
                "attemptNumber": 1,
                "repairDecision": "propose_candidate",
                "repairDecisionRef": {
                    "uri": "urn:run/repair-decision-1",
                    "sha256": "a" * 64,
                    "byteSize": 6,
                },
                "buildTestResultRef": {
                    "uri": "urn:run/build-repaired",
                    "sha256": "b" * 64,
                    "byteSize": 8,
                },
                "javaCandidateRef": {
                    "uri": "urn:run/java-candidate-1",
                    "sha256": "c" * 64,
                    "byteSize": 10,
                },
                "createdAt": "2026-05-22T10:00:00Z",
            }
        )
        contract.set_parity_comparison(
            {
                "matched": True,
                "comparisonResultRef": {
                    "uri": "urn:run/comparison-result-ok",
                    "sha256": "d" * 64,
                    "byteSize": 24,
                },
                "diffRef": {
                    "uri": "urn:run/diff-ok",
                    "sha256": "e" * 64,
                    "byteSize": 4,
                },
            }
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=None,
            final_classification=CLASSIFICATION_SUCCESS,
            failure_code=None,
            evidence_materialized=True,
        )

        self.assertEqual(summary["repairStatus"], "repair_verified")
        self.assertEqual(summary["repair"]["status"], "repair_verified")
        self.assertEqual(
            summary["repair"]["repairDecisionRef"]["uri"],
            "urn:run/repair-decision-1",
        )
        self.assertEqual(
            summary["repair"]["repairedBuildTestResultRef"]["uri"],
            "urn:run/build-repaired",
        )
        self.assertEqual(
            summary["repair"]["repairedJavaCandidateRef"]["uri"],
            "urn:run/java-candidate-1",
        )
        self.assertEqual(summary["repairVerifiedAt"], "2026-05-22T10:00:00Z")

    def test_trust_summary_projects_repair_failed_after_unverified_candidate(self) -> None:
        context = self._w0_context(use_transformation_agent=True)
        contract = self._w02_contract()
        contract.record_repair_attempt(
            {
                "attemptNumber": 1,
                "repairDecision": "propose_candidate",
                "repairDecisionRef": {
                    "uri": "urn:run/repair-decision-1",
                    "sha256": "a" * 64,
                    "byteSize": 6,
                },
                "buildTestResultRef": {
                    "uri": "urn:run/build-repaired",
                    "sha256": "b" * 64,
                    "byteSize": 8,
                },
                "javaCandidateRef": {
                    "uri": "urn:run/java-candidate-1",
                    "sha256": "c" * 64,
                    "byteSize": 10,
                },
            }
        )

        summary = self._trust_summary(
            context=context,
            contract=contract,
            build_test_output=None,
            final_classification=CLASSIFICATION_FAILED,
            failure_code=None,
            evidence_materialized=True,
        )

        self.assertEqual(summary["repairStatus"], "repair_failed")
        self.assertEqual(summary["repair"]["status"], "repair_failed")


class W03AssistDecisionAndBudgetLineageTests(_BaseEvidenceFixture):
    """Issue #217 (W0.3-6): the W0.2 evidence pack records the Orchestrator-
    owned assist-decision and the final consumption of the three bounded
    run budgets so reviewers can audit AI activation and budget pressure
    without consulting the run contract."""

    @staticmethod
    def _w02_contract():
        return new_run_contract(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref={"uri": "urn:source/HELLO.cob"},
            repair_budget_limit=2,
            assist_budget_limit=1,
            model_invocation_budget_limit=6,
        )

    @staticmethod
    def _record_assist_required(contract) -> AssistDecision:
        decision = AssistDecision(
            outcome=ASSIST_OUTCOME_REQUIRED,
            reason_code=ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
            decided_at="2026-05-17T00:00:00Z",
            selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
            assist_budget_snapshot={"limit": 1, "used": 1, "remaining": 0},
            repair_budget_snapshot={"limit": 2, "used": 0, "remaining": 2},
            model_invocation_budget_snapshot={"limit": 6, "used": 1, "remaining": 5},
            rationale="baseline emitted openAssumptions",
        )
        contract.record_assist_decision(decision)
        return decision

    def _baseline_payload(self, *, blocked: bool, with_assist: bool):
        context = self._w0_context(use_transformation_agent=True)
        if not blocked:
            W02ProductiveEvidenceTests._write_source_and_parse_metadata(self, context)  # type: ignore[arg-type]
        contract = self._w02_contract()
        if with_assist:
            self._record_assist_required(contract)
        # Pull on a repair attempt so the budget summary shows non-zero use.
        repair_model_ref = _model_invocation_ref(
            "verification-repair",
            invocation_id="inv-run-evidence-01-repair",
            sha="b" * 64,
        )
        contract.repair_budget.consume()
        contract.model_invocation_budget.consume()
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}
        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "comparison": {"matched": True},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-1",
        )
        return self.runner._build_evidence_payload(
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
            w02_blocked=blocked,
            productive_model_invocations=[transformation_model_ref, repair_model_ref],
        )

    def test_successful_w02_run_emits_assist_decision_and_budget_summary(self) -> None:
        payload = self._baseline_payload(blocked=False, with_assist=True)

        artifacts = payload["artifacts"]
        self.assertIn("assistDecision", artifacts)
        decision = artifacts["assistDecision"]
        self.assertEqual(decision["outcome"], "assist_required")
        self.assertEqual(decision["reasonCode"], "baseline_open_assumptions")
        self.assertEqual(decision["selectedAgentRole"], "transformation_agent")
        # The gate snapshots are mirrored on the lineage envelope so reviewers
        # see the budget state at decision time.
        self.assertEqual(decision["assistBudgetSnapshot"]["used"], 1)
        self.assertEqual(decision["modelInvocationBudgetSnapshot"]["used"], 1)

        self.assertIn("budgetSummary", artifacts)
        summary = artifacts["budgetSummary"]
        self.assertEqual(summary["assist"], {"limit": 1, "used": 0, "remaining": 1})
        # The repair + model invocation budgets each consumed one unit above,
        # so the end-of-run summary reflects those increments.
        self.assertEqual(summary["repair"], {"limit": 2, "used": 1, "remaining": 1})
        self.assertEqual(summary["modelInvocation"], {"limit": 6, "used": 1, "remaining": 5})

    def test_w02_run_without_gate_omits_assist_decision_but_still_emits_budget_summary(
        self,
    ) -> None:
        payload = self._baseline_payload(blocked=False, with_assist=False)

        artifacts = payload["artifacts"]
        # No gate yet → the orchestrator must not invent an assist-decision.
        self.assertNotIn("assistDecision", artifacts)
        # The bounded budgets always exist on the contract, so the summary
        # is still emitted (acceptance: "blocked/failed/incomplete run still
        # records the relevant decision lineage").
        self.assertIn("budgetSummary", artifacts)
        self.assertEqual(artifacts["budgetSummary"]["assist"]["used"], 0)

    def test_blocked_w02_run_records_lineage_when_gate_already_fired(self) -> None:
        payload = self._baseline_payload(blocked=True, with_assist=True)

        artifacts = payload["artifacts"]
        # Blocked-post-gate: assist-decision still recorded for auditing.
        self.assertIn("assistDecision", artifacts)
        self.assertEqual(artifacts["assistDecision"]["outcome"], "assist_required")
        # budgetSummary mandatory on every W0.2 run.
        self.assertIn("budgetSummary", artifacts)

    def test_w0_run_does_not_emit_assist_decision_or_budget_summary(self) -> None:
        context = self._w0_context(use_transformation_agent=False)
        payload = self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step("generate-java", output_uri="urn:run/generated"),
            build_test_output=_step("compile-test-java", output_uri="urn:run/build-1"),
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload={"schemaVersion": "v0", "runId": "run-evidence", "steps": []},
        )

        artifacts = payload["artifacts"]
        self.assertNotIn("assistDecision", artifacts)
        self.assertNotIn("budgetSummary", artifacts)

    # ------------------------------------------------------------------
    # Issue #217 follow-up: guard the cross-service invariant that
    # evidence-service's runReachedAssistGate inference can rely on.
    # ------------------------------------------------------------------
    #
    # evidence-service infers "did the assist-decision gate fire?" from the
    # PRESENCE of post-gate signals in the pack (transformation /
    # verification-repair agent trajectories, repair attempts, or
    # productive model invocations). It uses that inference to decide
    # whether a blocked W0.2 pack may legitimately omit ``assistDecision``.
    #
    # The orchestrator is the upstream contract owner: whenever it emits an
    # ``assistDecision`` into the evidence pack, the same pack MUST also
    # carry at least one of those signals. A future refactor that records a
    # decision without writing a trajectory would silently cause
    # evidence-service to relax the requirement on blocked packs that
    # actually reached the gate — exactly the regression the post-review
    # tightening was meant to prevent.
    #
    # The tests below lock the invariant for both blocked and non-blocked
    # runs across the assist outcomes the gate may emit. Adding any new
    # outcome / agent role must update this guard.
    def _assert_pack_satisfies_assist_gate_inference(self, artifacts: dict) -> None:
        """Mirror of evidence-service's runReachedAssistGate inference."""
        trajectories = artifacts.get("agentTrajectories") or []
        repair_attempts = artifacts.get("repairAttempts") or []
        model_invocations = artifacts.get("modelInvocations") or []
        post_gate_trajectory_roles = {
            entry.get("agentRole")
            for entry in trajectories
            if isinstance(entry, dict)
        } & {"transformation", "verification-repair"}
        post_gate_invocation_roles = {
            entry.get("agentRole")
            for entry in model_invocations
            if isinstance(entry, dict)
        } & {"transformation", "verification-repair"}
        self.assertTrue(
            bool(post_gate_trajectory_roles)
            or bool(repair_attempts)
            or bool(post_gate_invocation_roles),
            "orchestrator emitted assistDecision but no post-gate signal "
            "(transformation/verification-repair trajectory, repair attempt, "
            "or productive model invocation). evidence-service would silently "
            "relax the assistDecision requirement on a blocked pack with this "
            "shape — Issue #217 guard.",
        )

    def test_guard_emitted_assist_decision_always_carries_gate_fired_signal_unblocked(
        self,
    ) -> None:
        payload = self._baseline_payload(blocked=False, with_assist=True)
        artifacts = payload["artifacts"]
        self.assertIn("assistDecision", artifacts)
        self._assert_pack_satisfies_assist_gate_inference(artifacts)

    def test_guard_emitted_assist_decision_always_carries_gate_fired_signal_blocked(
        self,
    ) -> None:
        payload = self._baseline_payload(blocked=True, with_assist=True)
        artifacts = payload["artifacts"]
        self.assertIn("assistDecision", artifacts)
        self._assert_pack_satisfies_assist_gate_inference(artifacts)

    def test_guard_emitted_assist_decision_carries_signal_for_assist_not_required(
        self,
    ) -> None:
        # The assist gate may decide ``assist_not_required`` (caller_did_not_opt_in,
        # baseline already complete, etc.). For those runs the productive
        # Transformation Agent does NOT run, so no transformation trajectory
        # is emitted — but the orchestrator still routes the deterministic
        # baseline through the productive path's evidence assembly because
        # ``use_transformation_agent=True`` was set on the context. Verify
        # that whenever an assist_not_required decision lands in the pack,
        # at least the inference signal that evidence-service falls back to
        # for blocked packs is present, OR the pack is non-blocked (in
        # which case assistDecision is required regardless of the
        # inference and the guard is satisfied vacuously).
        context = self._w0_context(use_transformation_agent=True)
        W02ProductiveEvidenceTests._write_source_and_parse_metadata(self, context)  # type: ignore[arg-type]
        contract = self._w02_contract()
        # Record an assist_not_required decision (caller did not opt in).
        decision = AssistDecision(
            outcome="assist_not_required",
            reason_code="caller_did_not_opt_in",
            decided_at="2026-05-17T00:00:00Z",
            selected_agent_role=None,
            assist_budget_snapshot={"limit": 1, "used": 0, "remaining": 1},
            repair_budget_snapshot={"limit": 2, "used": 0, "remaining": 2},
            model_invocation_budget_snapshot={"limit": 6, "used": 0, "remaining": 6},
            rationale="caller did not opt in",
        )
        contract.record_assist_decision(decision)
        transformation_model_ref = _model_invocation_ref(
            "transformation",
            invocation_id="inv-run-evidence-00-transformation",
            sha="a" * 64,
        )
        baseline_ref = {"uri": "urn:run/baseline", "sha256": "1" * 64, "byteSize": 12}
        build = _step(
            "compile-test-java",
            payload={
                "status": "ok",
                "classification": "match",
                "comparison": {"matched": True},
                "goldenMaster": {"classification": "true"},
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
            w02_blocked=False,
            productive_model_invocations=[transformation_model_ref],
        )
        artifacts = payload["artifacts"]
        self.assertIn("assistDecision", artifacts)
        self.assertEqual(artifacts["assistDecision"]["outcome"], "assist_not_required")
        # The orchestrator's W0.2 evidence assembly always emits a
        # transformation trajectory whenever use_transformation_agent=True,
        # regardless of the decision outcome. That trajectory IS the signal
        # evidence-service looks for; locking it here means a future
        # refactor that stops emitting trajectories for assist_not_required
        # runs would break this test before it could silently weaken the
        # blocked-pack relaxation rule downstream.
        self._assert_pack_satisfies_assist_gate_inference(artifacts)


class W02ManualEditOverlaySignalTests(_BaseEvidenceFixture):
    """ADR 0007 (#257): the orchestrator emits manual-edit provenance as
    a consistent run-summary + overlay-artifact pair."""

    def _manual_region(self, **overrides):
        region = {
            "filePath": "src/main/java/HELLO.java",
            "originClass": "manual_modified",
            "startLine": 3,
            "endLine": 4,
            "generatorBaselineRunId": "run-baseline",
            "generatorBaselineRegionHash": "b" * 64,
            "lastModifiedAt": "2026-05-18T09:14:33Z",
            "lastModifiedBy": {"userId": "user-1", "tenantId": "tenant-A"},
            "manualEditCount": 1,
        }
        region.update(overrides)
        return region

    def _w02_contract(self):
        return new_run_contract(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            source_ref={"uri": "urn:source/HELLO.cob"},
        )

    def _build_payload(self, contract, manual_overlay_regions=()):
        context = W0RunContext(
            run_id="run-evidence",
            workflow_id="w0-migration-v0",
            requester="bff",
            evidence_refs=[],
            use_transformation_agent=True,
            manual_overlay_regions=tuple(manual_overlay_regions),
        )
        baseline_ref = {
            "uri": "urn:run/baseline",
            "sha256": "1" * 64,
            "byteSize": 12,
        }
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
                "comparison": {"matched": True},
                "goldenMaster": {"classification": "true"},
            },
            output_uri="urn:run/build-1",
        )
        return self.runner._build_evidence_payload(
            context=context,
            input_ref=_ref("urn:source/HELLO.cob"),
            parse_output=_step("parse-cobol", output_uri="urn:run/parse"),
            ir_output=_step("generate-ir", output_uri="urn:run/ir"),
            generator_output=_step(
                "generate-java", output_uri="urn:run/baseline"
            ),
            build_test_output=build,
            model_output=None,
            model_policy_skipped_meta=None,
            trajectory_payload={
                "schemaVersion": "v0",
                "runId": "run-evidence",
                "steps": [],
            },
            generated_artifact_ref=baseline_ref,
            baseline_generated_artifact_ref=baseline_ref,
            w02_contract=contract,
            w02_blocked=False,
            productive_model_invocations=[transformation_model_ref],
        )

    def test_emits_default_manual_edit_signals_when_no_drift(self) -> None:
        contract = self._w02_contract()
        payload = self._build_payload(contract)
        self.assertFalse(payload["manualEditsCarriedOver"])
        self.assertEqual(payload["manualDriftRegionCount"], 0)
        self.assertNotIn("manualEditOverlay", payload["artifacts"])

    def test_emits_manual_edit_signals_with_overlay_reference(self) -> None:
        contract = self._w02_contract()
        contract.set_manual_edit_summary(
            carried_over=True, drift_region_count=2
        )
        payload = self._build_payload(
            contract,
            manual_overlay_regions=(
                self._manual_region(),
                self._manual_region(
                    originClass="manual_edit",
                    startLine=8,
                    endLine=8,
                    generatorBaselineRegionHash=None,
                    manualEditCount=2,
                ),
            ),
        )

        self.assertTrue(payload["manualEditsCarriedOver"])
        self.assertEqual(payload["manualDriftRegionCount"], 2)
        overlay_ref = payload["artifacts"]["manualEditOverlay"]
        self.assertEqual(overlay_ref["schemaVersion"], "v0")
        self.assertEqual(overlay_ref["regionCount"], 2)
        self.assertEqual(overlay_ref["kind"], "manual-edit-overlay")
        stored = self.runner.artifact_store.read_json(
            "run-evidence", "manual-edit-overlay.json"
        )
        self.assertIsNotNone(stored)
        self.assertEqual(len(stored["regions"]), 2)
        self.assertEqual(
            stored["regions"][0]["generatorBaselineRunId"], "run-baseline"
        )
        self.assertEqual(stored["regions"][0]["lastModifiedBy"]["userId"], "user-1")
        self.assertEqual(stored["regions"][0]["manualEditCount"], 1)
        self.assertNotIn("generatorBaselineRegionHash", stored["regions"][1])

    def test_rejects_manual_summary_without_overlay_reference(self) -> None:
        contract = self._w02_contract()
        contract.set_manual_edit_summary(carried_over=True, drift_region_count=1)
        with self.assertRaisesRegex(
            Exception, "manual edit provenance requires"
        ):
            self._build_payload(contract)

    def test_rejects_incomplete_manual_overlay_metadata(self) -> None:
        contract = self._w02_contract()
        with self.assertRaisesRegex(Exception, "generatorBaselineRunId"):
            self._build_payload(
                contract,
                manual_overlay_regions=(
                    {
                        "filePath": "src/main/java/HELLO.java",
                        "originClass": "manual_modified",
                        "startLine": 3,
                        "endLine": 4,
                    },
                ),
            )


if __name__ == "__main__":
    unittest.main()
