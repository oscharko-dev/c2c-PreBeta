"""Tests for the repo-owned trust-case catalog and parity ingress validation."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.server import OrchestratorService
from orchestrator_service.trust_cases import (
    TrustCaseCatalogError,
    load_trust_case_catalog,
)
from orchestrator_service.workflow import W0WorkflowRunner

from tests.test_workflow import StubGateway, W0WorkflowRunnerTests


def _valid_catalog_payload() -> dict[str, object]:
    return {
        "schemaVersion": "v0",
        "catalogVersion": "2026-05-21",
        "trustCases": [
            {
                "trustCaseId": "HELLOW02-DEFAULT",
                "version": "2026-05-21",
                "programId": "HELLOW02",
                "title": "HELLOW02 default",
                "description": "Default immutable parity trust case.",
                "defaultForProgram": True,
                "sourceReference": {
                    "fixtureId": "HELLOW02",
                    "mode": "reference-fixture",
                },
                "controlledInput": {
                    "stdin": None,
                    "dataSetIds": [],
                    "expectedOutputFixtureId": "HELLOW02",
                },
                "runtime": {"programArgs": []},
                "environmentProfile": {
                    "profileId": "generated-java-sandbox-v1",
                    "description": "Controlled generated Java sandbox.",
                    "variables": {},
                },
                "comparison": {
                    "strategy": "deterministic-output",
                    "policyVersion": "deterministic-output-v1",
                },
                "supportedProgramShape": {
                    "language": "cobol",
                    "programId": "HELLOW02",
                    "supportedSubset": ["DISPLAY", "STOP-RUN"],
                },
                "evidenceIdentity": {
                    "kind": "trust-case",
                    "artifactName": "executed-trust-case.json",
                },
            }
        ],
    }


class TrustCaseCatalogTests(unittest.TestCase):
    def _write_catalog(self, payload: dict[str, object]) -> Path:
        tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_dir.cleanup)
        catalog_path = Path(tmp_dir.name) / "index.json"
        catalog_path.write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )
        return catalog_path

    def test_default_catalog_resolution_exposes_authoritative_identity(self) -> None:
        catalog = load_trust_case_catalog()
        resolved = catalog.resolve(
            "HELLOW02-DEFAULT",
            program_id="HELLOW02",
        ).to_identity_payload()

        self.assertEqual(resolved["trustCaseId"], "HELLOW02-DEFAULT")
        self.assertEqual(resolved["version"], "2026-05-21")
        self.assertEqual(resolved["programId"], "HELLOW02")
        self.assertEqual(resolved["catalogVersion"], "2026-05-21")
        self.assertTrue(resolved["catalogHash"])
        self.assertTrue(resolved["configurationDigest"])
        self.assertEqual(resolved["sourceReferenceFixtureId"], "HELLOW02")
        self.assertEqual(resolved["sourceReferenceMode"], "reference-fixture")
        self.assertEqual(resolved["environmentProfileId"], "generated-java-sandbox-v1")
        self.assertEqual(resolved["comparisonPolicyVersion"], "deterministic-output-v1")
        self.assertEqual(resolved["runtimeProgramArgs"], [])

    def test_catalog_rejects_conflicting_selection(self) -> None:
        catalog = load_trust_case_catalog()

        with self.assertRaises(TrustCaseCatalogError):
            catalog.resolve("HELLOW02-DEFAULT", program_id="MISMATCH")

        with self.assertRaises(TrustCaseCatalogError):
            catalog.resolve(
                "HELLOW02-DEFAULT",
                source_reference_fixture_id="OTHER",
            )

        with self.assertRaises(TrustCaseCatalogError):
            catalog.resolve(
                "HELLOW02-DEFAULT",
                source_reference_mode="native-cobol",
            )

    def test_loader_rejects_invalid_catalog_content(self) -> None:
        tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_dir.cleanup)
        catalog_path = Path(tmp_dir.name) / "index.json"
        catalog_path.write_text(
            json.dumps(
                {
                    "schemaVersion": "v0",
                    "catalogVersion": "2026-05-21",
                    "trustCases": [
                        {
                            "trustCaseId": "BROKEN-CASE",
                            "version": "2026-05-21",
                            "programId": "BROKEN",
                            "title": "Broken",
                            "description": "Broken catalog entry.",
                            "defaultForProgram": True,
                            "sourceReference": {"fixtureId": "BROKEN", "mode": "invalid-mode"},
                            "controlledInput": {
                                "stdinFixtureId": None,
                                "expectedOutputFixtureId": "BROKEN",
                            },
                            "runtime": {"programArgs": []},
                            "environmentProfile": {
                                "profileId": "generated-java-sandbox-v1",
                                "description": "Broken",
                            },
                            "comparison": {
                                "strategyId": "deterministic-output",
                                "policyVersion": "deterministic-output-v1",
                            },
                            "supportedProgramShape": {
                                "targetLanguage": "java",
                                "supportedSubset": [],
                                "unsupportedConstructPolicy": "block-before-execution",
                            },
                            "evidenceIdentity": {
                                "kind": "trust-case",
                                "artifactName": "executed-trust-case.json",
                            },
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with self.assertRaises(TrustCaseCatalogError):
            load_trust_case_catalog(catalog_path=catalog_path)

    def test_loader_requires_schema_required_nullable_and_empty_fields(self) -> None:
        cases = [
            ("controlledInput", "stdin", "controlledInput.stdin is required"),
            ("controlledInput", "dataSetIds", "controlledInput.dataSetIds is required"),
            (
                "environmentProfile",
                "variables",
                "environmentProfile.variables is required",
            ),
        ]
        for section, key, message in cases:
            with self.subTest(field=f"{section}.{key}"):
                payload = _valid_catalog_payload()
                trust_cases = payload["trustCases"]
                self.assertIsInstance(trust_cases, list)
                trust_case = trust_cases[0]
                self.assertIsInstance(trust_case, dict)
                section_payload = trust_case[section]
                self.assertIsInstance(section_payload, dict)
                del section_payload[key]
                catalog_path = self._write_catalog(payload)

                with self.assertRaisesRegex(TrustCaseCatalogError, message):
                    load_trust_case_catalog(catalog_path=catalog_path)


class TrustCaseIngressTests(unittest.TestCase):
    def _service(self) -> OrchestratorService:
        config = W0WorkflowRunnerTests._base_config()
        tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_dir.cleanup)
        store = RunArtifactStore(tmp_dir.name, created_by="orchestrator-test")
        runner = W0WorkflowRunner(
            config=config,
            gateway=StubGateway(
                W0WorkflowRunnerTests._base_capabilities(),
                W0WorkflowRunnerTests._base_responses(),
            ),
            artifact_store=store,
        )
        return OrchestratorService(config, runner, artifact_store=store)

    def test_invalid_trust_case_is_rejected_before_run_creation(self) -> None:
        service = self._service()

        with self.assertRaises(ValueError):
            service._start_run(
                {
                    "requester": "integration",
                    "inputRef": {
                        "uri": "urn:integration/main.cob",
                        "source": "IDENTIFICATION DIVISION.",
                    },
                    "executionMode": "parity",
                    "trustCaseId": "UNKNOWN-CASE",
                }
            )

        self.assertIsNone(service.runner.gateway.created_run)
