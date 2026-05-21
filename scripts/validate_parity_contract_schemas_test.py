"""Regression tests for ``scripts/validate_parity_contract_schemas.py``.

Issue #351 introduces shared schemas for the first parity and repair slice.
These tests keep the contract honest at two levels:

* the validator command must accept a complete schema bundle when copied into
  an isolated repo root;
* the schema documents themselves must keep the required run fields, approval
  gate, evidence references, and transient output handling that the issue
  calls for.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from scripts.validate_parity_contract_schemas import ContractValidationError, sample_payloads, validate_payload


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_SCRIPT = REPO_ROOT / "scripts" / "validate_parity_contract_schemas.py"

CONTRACT_SCHEMA_FILES = [
    "schemas/parity-run-v0.json",
    "schemas/parity-execution-result-v0.json",
    "schemas/parity-build-result-v0.json",
    "schemas/parity-comparison-result-v0.json",
    "schemas/repair-diagnosis-v0.json",
    "schemas/patch-proposal-v0.json",
]


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_contract_bundle(root: Path = REPO_ROOT) -> dict[str, dict[str, Any]]:
    return {relative_path: _load_json(root / relative_path) for relative_path in CONTRACT_SCHEMA_FILES}


def _write_contract_bundle(root: Path, bundle: dict[str, dict[str, Any]]) -> None:
    schema_root = root / "schemas"
    schema_root.mkdir(parents=True, exist_ok=True)
    for relative_path, schema in bundle.items():
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _copy_validator_repo(root: Path) -> Path:
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(VALIDATOR_SCRIPT, scripts_dir / VALIDATOR_SCRIPT.name)
    _write_contract_bundle(root, _load_contract_bundle())
    return scripts_dir / VALIDATOR_SCRIPT.name


def _run_validator(repo_root: Path) -> subprocess.CompletedProcess[str]:
    script = repo_root / "scripts" / VALIDATOR_SCRIPT.name
    return subprocess.run(
        [sys.executable, str(script)],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )


def _assert_ref_property(testcase: unittest.TestCase, schema: dict[str, Any], property_name: str) -> None:
    properties = schema.get("properties")
    testcase.assertIsInstance(properties, dict, f"{property_name} properties missing")
    prop_schema = properties.get(property_name)
    testcase.assertIsInstance(prop_schema, dict, f"{property_name} schema missing")
    testcase.assertEqual(prop_schema.get("$ref"), "#/$defs/artifactReference", property_name)


def _assert_required_fields(testcase: unittest.TestCase, schema: dict[str, Any], required_fields: set[str]) -> None:
    required = schema.get("required")
    testcase.assertIsInstance(required, list, "required list missing")
    testcase.assertTrue(required_fields.issubset(set(required)), f"missing required fields: {required_fields - set(required)}")


def _assert_sequence_contains(testcase: unittest.TestCase, sequence: Any, expected: list[str], label: str) -> None:
    testcase.assertIsInstance(sequence, list, f"{label} must be a list")
    testcase.assertTrue(expected == sequence[: len(expected)] or all(item in sequence for item in expected), f"{label} missing expected entries")


class ValidateParityContractSchemasTest(unittest.TestCase):
    def test_validator_command_accepts_an_isolated_copy_of_the_contract_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            _copy_validator_repo(repo_root)

            result = _run_validator(repo_root)

            self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_repository_bundle_keeps_required_fields_approval_semantics_and_transient_outputs(self) -> None:
        bundle = _load_contract_bundle()

        parity_run = bundle["schemas/parity-run-v0.json"]
        _assert_required_fields(
            self,
            parity_run,
            {
                "schemaVersion",
                "runId",
                "trustCaseId",
                "executionMode",
                "status",
                "sourceArtifactRef",
                "generatedArtifactRef",
                "referenceArtifactRef",
                "sourceRevisionRef",
                "currentHeadRef",
                "evidenceRefs",
                "createdAt",
                "updatedAt",
            },
        )
        self.assertEqual(parity_run["properties"]["schemaVersion"]["const"], "v0")
        self.assertEqual(parity_run["properties"]["executionMode"]["const"], "parity")
        _assert_ref_property(self, parity_run, "sourceArtifactRef")
        _assert_ref_property(self, parity_run, "generatedArtifactRef")
        _assert_ref_property(self, parity_run, "referenceArtifactRef")
        _assert_ref_property(self, parity_run, "sourceRevisionRef")
        _assert_ref_property(self, parity_run, "currentHeadRef")
        _assert_ref_property(self, parity_run, "buildResultRef")
        _assert_ref_property(self, parity_run, "executionResultRef")
        _assert_ref_property(self, parity_run, "comparisonResultRef")
        _assert_ref_property(self, parity_run, "repairDiagnosisRef")
        _assert_ref_property(self, parity_run, "patchProposalRef")
        evidence_refs = parity_run["properties"]["evidenceRefs"]
        self.assertEqual(evidence_refs["items"]["$ref"], "#/$defs/artifactReference")

        execution = bundle["schemas/parity-execution-result-v0.json"]
        _assert_required_fields(
            self,
            execution,
            {
                "schemaVersion",
                "executionId",
                "runId",
                "executionSurface",
                "command",
                "status",
                "exitCode",
                "timedOut",
                "stdoutRef",
                "stderrRef",
                "normalizedOutputRef",
                "diagnostics",
                "createdAt",
            },
        )
        self.assertEqual(execution["properties"]["executionSurface"]["enum"], ["source-reference", "generated-java"])
        self.assertEqual(
            execution["properties"]["referenceMode"]["enum"],
            ["reference-fixture", "native-cobol"],
        )
        self.assertNotIn("stdout", execution["properties"])
        self.assertNotIn("stderr", execution["properties"])
        self.assertNotIn("normalizedOutput", execution["properties"])
        _assert_ref_property(self, execution, "stdoutRef")
        _assert_ref_property(self, execution, "stderrRef")
        _assert_ref_property(self, execution, "normalizedOutputRef")
        _assert_ref_property(self, execution, "outputRef")
        _assert_ref_property(self, execution, "logRef")
        _assert_ref_property(self, execution, "sourceArtifactRef")
        _assert_ref_property(self, execution, "inputArtifactRef")
        _assert_ref_property(self, execution, "generatedArtifactRef")
        _assert_ref_property(self, execution, "referenceArtifactRef")
        self.assertEqual(
            execution["allOf"][0]["then"]["required"],
            ["referenceMode"],
        )
        self.assertEqual(execution["properties"]["diagnostics"]["items"]["$ref"], "#/$defs/diagnostic")
        diagnostic = execution["$defs"]["diagnostic"]
        _assert_required_fields(self, diagnostic, {"severity", "message"})
        self.assertEqual(diagnostic["properties"]["severity"]["enum"], ["info", "warning", "error"])
        self.assertEqual(diagnostic["properties"]["rawLogRef"]["$ref"], "#/$defs/artifactReference")

        build = bundle["schemas/parity-build-result-v0.json"]
        _assert_required_fields(
            self,
            build,
            {
                "schemaVersion",
                "buildId",
                "runId",
                "buildMode",
                "command",
                "status",
                "inputArtifactRef",
                "buildOutputRef",
                "logRef",
                "diagnostics",
                "createdAt",
            },
        )
        self.assertEqual(build["properties"]["buildMode"]["const"], "generated-java")
        self.assertEqual(build["properties"]["diagnostics"]["items"]["$ref"], "#/$defs/buildDiagnostic")
        build_diagnostic = build["$defs"]["buildDiagnostic"]
        _assert_required_fields(self, build_diagnostic, {"filePath", "line", "column", "severity", "message"})
        self.assertEqual(build_diagnostic["properties"]["rawLogRef"]["$ref"], "#/$defs/artifactReference")

        comparison = bundle["schemas/parity-comparison-result-v0.json"]
        _assert_required_fields(
            self,
            comparison,
            {
                "schemaVersion",
                "comparisonId",
                "runId",
                "status",
                "comparisonPolicyVersion",
                "sourceNormalizedRef",
                "targetNormalizedRef",
                "diffSummary",
                "mismatchClassification",
                "createdAt",
            },
        )
        self.assertEqual(
            comparison["properties"]["mismatchClassification"]["enum"],
            [
                "none",
                "content",
                "formatting",
                "line_endings",
                "stderr",
                "exit_code",
                "runtime_failure",
                "unsupported_input",
                "policy",
                "intentional",
                "unknown",
            ],
        )
        _assert_ref_property(self, comparison, "comparisonPolicyRef")
        _assert_ref_property(self, comparison, "sourceNormalizedRef")
        _assert_ref_property(self, comparison, "targetNormalizedRef")
        _assert_ref_property(self, comparison, "diffRef")
        _assert_ref_property(self, comparison, "sourceStdoutRef")
        _assert_ref_property(self, comparison, "sourceStderrRef")
        _assert_ref_property(self, comparison, "targetStdoutRef")
        _assert_ref_property(self, comparison, "targetStderrRef")
        _assert_ref_property(self, comparison, "normalizedDiffRef")
        self.assertEqual(comparison["properties"]["evidenceRefs"]["items"]["$ref"], "#/$defs/artifactReference")

        diagnosis = bundle["schemas/repair-diagnosis-v0.json"]
        _assert_required_fields(
            self,
            diagnosis,
            {
                "schemaVersion",
                "diagnosisId",
                "runId",
                "failureClass",
                "scopeClass",
                "likelyRootCause",
                "confidence",
                "evidenceRefs",
                "createdAt",
            },
        )
        self.assertIn("manual_edit", diagnosis["properties"]["scopeClass"]["enum"])
        self.assertIn("generated_code", diagnosis["properties"]["scopeClass"]["enum"])
        self.assertIn("fixture_reference", diagnosis["properties"]["scopeClass"]["enum"])
        self.assertIn("out_of_scope", diagnosis["properties"]["scopeClass"]["enum"])
        self.assertEqual(diagnosis["properties"]["confidence"]["type"], "object")
        self.assertEqual(diagnosis["properties"]["confidence"]["required"], ["level"])
        self.assertEqual(diagnosis["properties"]["evidenceRefs"]["items"]["$ref"], "#/$defs/artifactReference")

        patch = bundle["schemas/patch-proposal-v0.json"]
        _assert_required_fields(
            self,
            patch,
            {
                "schemaVersion",
                "proposalId",
                "runId",
                "diagnosisId",
                "patchSha256",
                "applicationState",
                "approvalState",
                "files",
                "sourceRevisionRef",
                "currentHeadRef",
                "evidenceRefs",
                "createdAt",
            },
        )
        self.assertEqual(patch["properties"]["applicationState"]["enum"], ["draft", "review_pending", "applied", "rejected"])
        self.assertEqual(patch["properties"]["approvalState"]["enum"], ["pending", "approved", "rejected"])
        self.assertIn("allOf", patch)
        self.assertGreaterEqual(len(patch["allOf"]), 2)
        approved_gate = patch["allOf"][0]
        applied_gate = patch["allOf"][1]
        self.assertEqual(approved_gate["if"]["properties"]["approvalState"]["const"], "approved")
        self.assertIn("developerApproval", approved_gate["then"]["required"])
        self.assertEqual(
            approved_gate["then"]["properties"]["developerApproval"]["required"],
            ["approvedBy", "approvedAt", "approvedPatchSha256"],
        )
        self.assertEqual(applied_gate["if"]["properties"]["applicationState"]["const"], "applied")
        self.assertIn("approvedAt", applied_gate["then"]["required"])
        self.assertEqual(
            applied_gate["then"]["properties"]["developerApproval"]["required"],
            ["approvedBy", "approvedAt", "approvedPatchSha256"],
        )
        self.assertEqual(patch["properties"]["files"]["items"]["$ref"], "#/$defs/fileChange")

    def test_parity_run_requires_the_primary_artifact_and_evidence_fields(self) -> None:
        bundle = _load_contract_bundle()
        mutated = copy.deepcopy(bundle)
        required = mutated["schemas/parity-run-v0.json"]["required"]
        required.remove("generatedArtifactRef")

        with self.assertRaises(AssertionError):
            self._assert_parity_run_contract(mutated["schemas/parity-run-v0.json"])

    def test_patch_proposal_requires_the_approval_gate(self) -> None:
        bundle = _load_contract_bundle()
        mutated = copy.deepcopy(bundle)
        patch = mutated["schemas/patch-proposal-v0.json"]
        patch["required"].remove("approvalState")
        patch["allOf"] = patch["allOf"][:1]

        with self.assertRaises(AssertionError):
            self._assert_patch_proposal_contract(patch)

    def test_repair_diagnosis_requires_evidence_refs(self) -> None:
        bundle = _load_contract_bundle()
        mutated = copy.deepcopy(bundle)
        diagnosis = mutated["schemas/repair-diagnosis-v0.json"]
        diagnosis["required"].remove("evidenceRefs")

        with self.assertRaises(AssertionError):
            self._assert_repair_diagnosis_contract(diagnosis)

    def test_execution_result_rejects_inline_stdout_and_stderr_shapes(self) -> None:
        bundle = _load_contract_bundle()
        mutated = copy.deepcopy(bundle)
        execution = mutated["schemas/parity-execution-result-v0.json"]
        execution["required"] = [
            field
            for field in execution["required"]
            if field not in {"stdoutRef", "stderrRef", "normalizedOutputRef"}
        ]
        execution["properties"].pop("stdoutRef")
        execution["properties"].pop("stderrRef")
        execution["properties"].pop("normalizedOutputRef")
        execution["properties"]["stdout"] = {"type": "string"}
        execution["properties"]["stderr"] = {"type": "string"}
        execution["properties"]["normalizedOutput"] = {"type": "string"}

        with self.assertRaises(AssertionError):
            self._assert_execution_result_contract(execution)

    def test_issue_354_projection_fields_remain_available_on_parity_surfaces(self) -> None:
        bundle = _load_contract_bundle()
        parity_run = bundle["schemas/parity-run-v0.json"]
        comparison = bundle["schemas/parity-comparison-result-v0.json"]

        for field in ("executionResultRef", "comparisonResultRef"):
            _assert_ref_property(self, parity_run, field)

        self.assertEqual(
            comparison["properties"]["comparisonPolicyVersion"]["type"], "string"
        )
        _assert_ref_property(self, comparison, "comparisonPolicyRef")
        _assert_ref_property(self, comparison, "diffRef")

    def _assert_parity_run_contract(self, schema: dict[str, Any]) -> None:
        _assert_required_fields(
            self,
            schema,
            {
                "schemaVersion",
                "runId",
                "trustCaseId",
                "executionMode",
                "status",
                "sourceArtifactRef",
                "generatedArtifactRef",
                "referenceArtifactRef",
                "sourceRevisionRef",
                "currentHeadRef",
                "evidenceRefs",
                "createdAt",
                "updatedAt",
            },
        )
        self.assertEqual(schema["properties"]["executionMode"]["const"], "parity")
        for field in (
            "sourceArtifactRef",
            "generatedArtifactRef",
            "referenceArtifactRef",
            "sourceRevisionRef",
            "currentHeadRef",
            "buildResultRef",
            "executionResultRef",
            "comparisonResultRef",
            "repairDiagnosisRef",
            "patchProposalRef",
        ):
            if field in schema.get("properties", {}):
                _assert_ref_property(self, schema, field)
        self.assertEqual(schema["properties"]["evidenceRefs"]["items"]["$ref"], "#/$defs/artifactReference")

    def _assert_execution_result_contract(self, schema: dict[str, Any]) -> None:
        _assert_required_fields(
            self,
            schema,
            {
                "schemaVersion",
                "executionId",
                "runId",
                "executionSurface",
                "command",
                "status",
                "exitCode",
                "timedOut",
                "stdoutRef",
                "stderrRef",
                "normalizedOutputRef",
                "diagnostics",
                "createdAt",
            },
        )
        self.assertNotIn("stdout", schema.get("properties", {}))
        self.assertNotIn("stderr", schema.get("properties", {}))
        self.assertNotIn("normalizedOutput", schema.get("properties", {}))
        for field in ("stdoutRef", "stderrRef", "normalizedOutputRef", "logRef", "sourceArtifactRef", "generatedArtifactRef", "referenceArtifactRef"):
            if field in schema.get("properties", {}):
                _assert_ref_property(self, schema, field)

    def _assert_repair_diagnosis_contract(self, schema: dict[str, Any]) -> None:
        _assert_required_fields(
            self,
            schema,
            {
                "schemaVersion",
                "diagnosisId",
                "runId",
                "failureClass",
                "scopeClass",
                "likelyRootCause",
                "confidence",
                "evidenceRefs",
                "createdAt",
            },
        )
        self.assertIn("manual_edit", schema["properties"]["scopeClass"]["enum"])
        self.assertIn("generated_code", schema["properties"]["scopeClass"]["enum"])
        self.assertIn("fixture_reference", schema["properties"]["scopeClass"]["enum"])
        self.assertIn("out_of_scope", schema["properties"]["scopeClass"]["enum"])
        self.assertEqual(schema["properties"]["evidenceRefs"]["items"]["$ref"], "#/$defs/artifactReference")

    def _assert_patch_proposal_contract(self, schema: dict[str, Any]) -> None:
        _assert_required_fields(
            self,
            schema,
            {
                "schemaVersion",
                "proposalId",
                "runId",
                "diagnosisId",
                "patchSha256",
                "applicationState",
                "approvalState",
                "files",
                "sourceRevisionRef",
                "currentHeadRef",
                "evidenceRefs",
                "createdAt",
            },
        )
        self.assertEqual(schema["properties"]["applicationState"]["enum"], ["draft", "review_pending", "approved", "applied", "rejected"])
        self.assertEqual(schema["properties"]["approvalState"]["enum"], ["pending", "approved", "rejected"])
        self.assertGreaterEqual(len(schema.get("allOf", [])), 2)
        self.assertEqual(schema["allOf"][0]["if"]["properties"]["approvalState"]["const"], "approved")
        self.assertEqual(
            schema["allOf"][0]["then"]["properties"]["developerApproval"]["required"],
            ["approvedBy", "approvedAt", "approvedPatchSha256"],
        )
        self.assertEqual(schema["allOf"][1]["if"]["properties"]["applicationState"]["const"], "applied")
        self.assertEqual(
            schema["allOf"][1]["then"]["properties"]["developerApproval"]["required"],
            ["approvedBy", "approvedAt", "approvedPatchSha256"],
        )
        self.assertEqual(schema["properties"]["files"]["items"]["$ref"], "#/$defs/fileChange")
        self.assertEqual(
            schema["$defs"]["fileChange"]["properties"]["path"]["pattern"],
            "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$",
        )

    def test_validator_rejects_path_traversal_and_secret_like_text(self) -> None:
        patch_payload = copy.deepcopy(sample_payloads()["patch-proposal-v0"])
        patch_payload["files"][0]["path"] = "../../services/evidence-service/server.go"
        with self.assertRaises(ContractValidationError):
            validate_payload("patch-proposal-v0", patch_payload)

        diagnosis_payload = copy.deepcopy(sample_payloads()["repair-diagnosis-v0"])
        diagnosis_payload["likelyRootCause"] = "password=supersecretvalue123456"
        with self.assertRaises(ContractValidationError):
            validate_payload("repair-diagnosis-v0", diagnosis_payload)

    def test_validator_rejects_terminal_passed_runs_without_proof_refs(self) -> None:
        payload = copy.deepcopy(sample_payloads()["parity-run-v0"])
        del payload["buildResultRef"]
        del payload["executionResultRef"]
        del payload["comparisonResultRef"]
        with self.assertRaises(ContractValidationError):
            validate_payload("parity-run-v0", payload)

    def test_validator_rejects_tampered_patch_content_after_approval(self) -> None:
        payload = copy.deepcopy(sample_payloads()["patch-proposal-v0"])
        payload["files"][0]["diff"] = "@@ -1,1 +1,1 @@\n-return old;\n+return tampered;"
        with self.assertRaises(ContractValidationError):
            validate_payload("patch-proposal-v0", payload)

    def test_validator_accepts_reference_only_diff_payloads(self) -> None:
        payload = copy.deepcopy(sample_payloads()["patch-proposal-v0"])
        diff_value = payload["files"][0].pop("diff")
        payload["files"][0]["diffRef"] = {
            "uri": "urn:patch-diff",
            "sha256": payload["files"][0]["afterSha256"],
            "byteSize": len(diff_value.encode("utf-8")),
            "mimeType": "text/x-diff",
            "kind": "patch-diff",
        }
        canonical = hashlib.sha256(
            json.dumps(
                [
                    {
                        "path": payload["files"][0]["path"],
                        "changeType": payload["files"][0]["changeType"],
                        "beforeSha256": payload["files"][0]["beforeSha256"],
                        "afterSha256": payload["files"][0]["afterSha256"],
                        "diffRef": {
                            "uri": payload["files"][0]["diffRef"]["uri"],
                            "sha256": payload["files"][0]["diffRef"]["sha256"],
                            "byteSize": payload["files"][0]["diffRef"]["byteSize"],
                        },
                    }
                ],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        payload["patchSha256"] = canonical
        payload["developerApproval"]["approvedPatchSha256"] = canonical
        validate_payload("patch-proposal-v0", payload)


if __name__ == "__main__":
    unittest.main()
