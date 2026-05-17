"""Regression tests for ``scripts/check_w0_2_evidence.py``.

The validator is part of the W0.2 release gate (Issue #175). These tests
freeze the contract it enforces so a future refactor cannot silently
weaken the gate.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("check_w0_2_evidence.py")


def _hex(byte: str) -> str:
    return byte * 64


GOOD_SUCCESS_MANIFEST: dict[str, Any] = {
    "schemaVersion": "v0",
    "capability": "evidence.pack",
    "service": "evidence-service",
    "packId": "epk-hellow02-test",
    "runId": "run-hellow02-test",
    "wave": "w0.2",
    "status": "complete",
    "completenessStatus": "complete",
    "classification": "success",
    "createdAt": "2026-05-16T00:00:00Z",
    "artifacts": {
        "sourceCobol": [
            {"uri": "file:///tmp/source.cbl", "sha256": _hex("a"), "byteSize": 100}
        ],
        "sourceMetadata": {
            "uri": "file:///tmp/source-ref.json",
            "sha256": _hex("4"),
            "byteSize": 100,
        },
        "parseOutput": {
            "uri": "file:///tmp/parse-output.json",
            "sha256": _hex("5"),
            "byteSize": 100,
        },
        "semanticIr": {"uri": "file:///tmp/ir.json", "sha256": _hex("b"), "byteSize": 100},
        "generatedJava": {"uri": "file:///tmp/Hello.java", "sha256": _hex("d"), "byteSize": 200},
        "generatedJavaArtifacts": [
            {
                "uri": "file:///tmp/Hello.java",
                "sha256": _hex("d"),
                "byteSize": 200,
                "origin": "deterministic-baseline",
                "attemptNumber": 0,
                "selected": True,
            }
        ],
        "finalJavaArtifact": {
            "uri": "file:///tmp/Hello.java",
            "sha256": _hex("d"),
            "byteSize": 200,
            "origin": "deterministic-baseline",
            "attemptNumber": 0,
            "selected": True,
        },
        "buildTestResults": [
            {"uri": "file:///tmp/build-test.json", "sha256": _hex("e"), "byteSize": 50}
        ],
        "harnessEvents": {"uri": "file:///tmp/events.jsonl", "sha256": _hex("f"), "byteSize": 50},
        "modelInvocations": [
            {
                "invocationId": "inv-1",
                "modelId": "none",
                "status": "skipped",
                "ledgerRef": {"uri": "file:///tmp/ledger.json", "sha256": _hex("0"), "byteSize": 50},
            }
        ],
        "agentTrajectories": [
            {
                "agentRole": "orchestrator",
                "ledgerRef": {"uri": "file:///tmp/orch.json", "sha256": _hex("1"), "byteSize": 50},
            }
        ],
        "oracleComparison": {
            "matched": True,
            "oracleKind": "cobol-runtime",
            "expectedSha256": _hex("2"),
            "actualSha256": _hex("2"),
        },
        "runtimeVersion": {
            "id": "c2c-target-java-runtime:21",
            "ref": {"uri": "file:///tmp/runtime.json", "sha256": _hex("6"), "byteSize": 50},
        },
        # Issue #217 (W0.3-6): the W0.2 success contract now requires
        # assist-decision and budget-summary lineage in the evidence pack.
        "assistDecision": {
            "outcome": "assist_not_required",
            "reasonCode": "caller_did_not_opt_in",
            "decidedAt": "2026-05-17T00:00:00Z",
            "repairBudgetSnapshot": {"limit": 2, "used": 0, "remaining": 2},
            "assistBudgetSnapshot": {"limit": 1, "used": 0, "remaining": 1},
            "modelInvocationBudgetSnapshot": {"limit": 6, "used": 0, "remaining": 6},
            "rationale": "caller did not opt into productive assist",
        },
        "budgetSummary": {
            "repair": {"limit": 2, "used": 0, "remaining": 2},
            "assist": {"limit": 1, "used": 0, "remaining": 1},
            "modelInvocation": {"limit": 6, "used": 1, "remaining": 5},
        },
    },
    "validation": {
        "ok": True,
        "requiredArtifacts": ["evidence-pack-manifest"],
        "missingArtifacts": [],
    },
}


class CheckW02EvidenceTest(unittest.TestCase):
    @staticmethod
    def _run(manifest: dict[str, Any], *extra_args: str) -> subprocess.CompletedProcess[str]:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(manifest, handle)
            path = handle.name
        try:
            return subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", path, *extra_args],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            Path(path).unlink(missing_ok=True)

    # ----- success-path acceptance --------------------------------------

    def test_success_with_policy_skipped_passes(self) -> None:
        result = self._run(GOOD_SUCCESS_MANIFEST, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_success_with_foundry_invocation_passes(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["modelInvocations"] = [
            {
                "invocationId": "inv-2",
                "modelId": "gpt-oss-120b",
                "provider": "azure_foundry",
                "status": "completed",
                "ledgerRef": {
                    "uri": "file:///tmp/foundry-ledger.json",
                    "sha256": _hex("3"),
                    "byteSize": 50,
                },
            }
        ]
        result = self._run(manifest, "--success", "--expect-foundry-invocation")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    # ----- success-path rejection ----------------------------------------

    def test_missing_oracle_comparison_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("oracleComparison")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("oracleComparison", result.stderr)

    def test_missing_final_java_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("finalJavaArtifact")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("finalJavaArtifact", result.stderr)

    def test_missing_source_metadata_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("sourceMetadata")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("sourceMetadata", result.stderr)

    def test_missing_parse_output_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("parseOutput")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("parseOutput", result.stderr)

    def test_missing_runtime_version_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("runtimeVersion")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("runtimeVersion", result.stderr)

    def test_legacy_singular_trajectory_ledger_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("agentTrajectories")
        manifest["artifacts"]["trajectoryLedger"] = {
            "uri": "file:///tmp/legacy.json",
            "sha256": _hex("9"),
            "byteSize": 50,
        }
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("agentTrajectories", result.stderr)

    def test_oracle_unmatched_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["oracleComparison"]["matched"] = False
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("oracleComparison.matched", result.stderr)

    def test_expect_foundry_but_skipped_fails(self) -> None:
        result = self._run(GOOD_SUCCESS_MANIFEST, "--success", "--expect-foundry-invocation")
        self.assertEqual(result.returncode, 3)
        self.assertIn("status='completed'", result.stderr)

    def test_completeness_not_complete_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["completenessStatus"] = "evidence_incomplete"
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("completenessStatus", result.stderr)

    def test_java_candidate_sha_mismatch_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["finalJavaArtifact"]["sha256"] = _hex("e")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("finalJavaArtifact", result.stderr)

    def test_legacy_generated_java_mismatch_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["generatedJava"]["sha256"] = _hex("e")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("generatedJava", result.stderr)

    # ----- W0.3-6 (Issue #217) assist-decision + budget lineage ---------

    def test_missing_assist_decision_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("assistDecision")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("assistDecision", result.stderr)

    def test_assist_decision_with_unknown_reason_code_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["assistDecision"]["reasonCode"] = "made_up"
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("reasonCode", result.stderr)

    def test_assist_required_without_selected_agent_role_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["assistDecision"]["outcome"] = "assist_required"
        manifest["artifacts"]["assistDecision"]["reasonCode"] = "baseline_open_assumptions"
        manifest["artifacts"]["assistDecision"].pop("selectedAgentRole", None)
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("selectedAgentRole", result.stderr)

    def test_assist_budget_exhausted_must_force_not_required(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["assistDecision"]["outcome"] = "assist_required"
        manifest["artifacts"]["assistDecision"]["reasonCode"] = "assist_budget_exhausted"
        manifest["artifacts"]["assistDecision"]["selectedAgentRole"] = "transformation_agent"
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("assist_budget_exhausted", result.stderr)

    def test_missing_budget_summary_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("budgetSummary")
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("budgetSummary", result.stderr)

    def test_budget_summary_with_inconsistent_remaining_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"]["budgetSummary"]["repair"]["remaining"] = 99
        result = self._run(manifest, "--success", "--expect-policy-skipped")
        self.assertEqual(result.returncode, 3)
        self.assertIn("remaining", result.stderr)

    # ----- blocked-path acceptance --------------------------------------

    def test_blocked_manifest_passes(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["classification"] = "blocked"
        manifest["completenessStatus"] = "blocked"
        manifest["status"] = "incomplete"
        manifest["artifacts"].pop("generatedJava")
        manifest["artifacts"].pop("finalJavaArtifact")
        for candidate in manifest["artifacts"]["generatedJavaArtifacts"]:
            candidate.pop("selected", None)
        manifest["validation"] = {
            "ok": False,
            "requiredArtifacts": ["evidence-pack-manifest"],
            "missingArtifacts": [],
        }
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_blocked_manifest_with_final_java_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["classification"] = "blocked"
        manifest["completenessStatus"] = "blocked"
        manifest["status"] = "incomplete"
        manifest["artifacts"].pop("generatedJava")
        # leave finalJavaArtifact in place — this MUST be a contract violation
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 3)
        self.assertIn("finalJavaArtifact", result.stderr)

    def test_blocked_manifest_with_legacy_generated_java_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["classification"] = "blocked"
        manifest["completenessStatus"] = "blocked"
        manifest["status"] = "incomplete"
        manifest["artifacts"].pop("finalJavaArtifact")
        for candidate in manifest["artifacts"]["generatedJavaArtifacts"]:
            candidate.pop("selected", None)
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 3)
        self.assertIn("generatedJava", result.stderr)

    def test_blocked_manifest_with_selected_candidate_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["classification"] = "blocked"
        manifest["completenessStatus"] = "blocked"
        manifest["status"] = "incomplete"
        manifest["artifacts"].pop("generatedJava")
        manifest["artifacts"].pop("finalJavaArtifact")
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 3)
        self.assertIn("selected", result.stderr)

    def test_failed_classification_accepted_as_blocked(self) -> None:
        # The orchestrator surfaces `parse_failed` (W0.2 workflow contract,
        # Issue #166) for unsupported source whose parser bails before
        # emitting structured diagnostics. The resulting manifest has
        # classification="failed" — which is still a non-success outcome
        # and must be accepted by the blocked-path validator.
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["classification"] = "failed"
        manifest["completenessStatus"] = "evidence_incomplete"
        manifest["status"] = "incomplete"
        manifest["artifacts"].pop("generatedJava")
        manifest["artifacts"].pop("finalJavaArtifact")
        for candidate in manifest["artifacts"]["generatedJavaArtifacts"]:
            candidate.pop("selected", None)
        manifest["validation"] = {
            "ok": False,
            "requiredArtifacts": ["evidence-pack-manifest"],
            "missingArtifacts": [],
        }
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_success_classification_rejected_as_blocked(self) -> None:
        # Symmetric to the above: a manifest whose classification is
        # "success" must NOT pass the blocked-path validator. Otherwise
        # the gate could silently accept a successful agentic run on the
        # negative-fixture path and lose the honest-blocking guarantee.
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        manifest["artifacts"].pop("finalJavaArtifact")
        result = self._run(manifest, "--blocked")
        self.assertEqual(result.returncode, 3)
        # The validator rejects this with the blocked-path classification
        # check, NOT the secret-scan check. Anchor on the
        # classification='success' fragment which is the actual diagnostic
        # the user needs to act on.
        self.assertIn("classification='success'", result.stderr)

    # ----- secret-scan --------------------------------------------------

    def test_referenced_artifact_with_secret_token_fails(self) -> None:
        manifest = copy.deepcopy(GOOD_SUCCESS_MANIFEST)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            tainted = tmp_root / "ledger.jsonl"
            tainted.write_text(
                "{\"invocationId\":\"inv-1\",\"prompt\":\"AZURE_FOUNDRY_API_KEY=abcdefghijklmnop\"}\n"
            )
            manifest["artifacts"]["modelInvocations"][0]["ledgerRef"] = {
                "uri": tainted.as_uri(),
                "sha256": _hex("4"),
                "byteSize": tainted.stat().st_size,
            }
            with tempfile.NamedTemporaryFile("w", suffix=".json", dir=tmp_root, delete=False) as handle:
                json.dump(manifest, handle)
                manifest_path = handle.name
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--manifest",
                    manifest_path,
                    "--success",
                    "--expect-policy-skipped",
                    "--root",
                    str(tmp_root),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 3)
            self.assertIn("secret-scan", result.stderr)

    # ----- CLI guards ---------------------------------------------------

    def test_requires_mode_flag(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(GOOD_SUCCESS_MANIFEST, handle)
            path = handle.name
        try:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", path],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--success", result.stderr)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_expect_foundry_and_policy_skipped_are_exclusive(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(GOOD_SUCCESS_MANIFEST, handle)
            path = handle.name
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--manifest",
                    path,
                    "--success",
                    "--expect-foundry-invocation",
                    "--expect-policy-skipped",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("mutually exclusive", result.stderr)
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
