"""Regression tests for ``scripts/validate-service-catalog.py``."""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("validate-service-catalog.py")
REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = REPO_ROOT / "config" / "service-catalog.json"


def _load_catalog() -> dict[str, Any]:
    with CATALOG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class ValidateServiceCatalogTest(unittest.TestCase):
    @staticmethod
    def _run_catalog(catalog_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--repo-root", str(REPO_ROOT), "--catalog", str(catalog_path), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    @staticmethod
    def _write_temp_catalog(catalog: dict[str, Any]) -> Path:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(catalog, handle)
            return Path(handle.name)

    def test_repository_catalog_passes(self) -> None:
        result = self._run_catalog(CATALOG_PATH)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_reference_component_must_keep_reference_classification(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "w0-service-go":
                component["classification"] = "product"
                break
        else:
            self.fail("w0-service-go missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("classification must be 'reference'", result.stderr)

    def test_missing_component_path_fails(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        mutated["components"][0]["path"] = "apps/does-not-exist"
        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("path does not exist", result.stderr)

    def test_missing_required_component_fails_catalog_completeness_check(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        mutated["components"] = [
            component for component in mutated["components"] if component["id"] != "c2c-studio"
        ]
        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("catalog coverage mismatch", result.stderr)
        self.assertIn("missing ids: c2c-studio", result.stderr)

    def test_missing_manifest_root_fails_catalog_completeness_check(self) -> None:
        expected_root = "/".join(("services", "issue-332-temp-catalog-gap"))
        temp_component = REPO_ROOT / expected_root
        temp_component.mkdir(parents=True, exist_ok=True)
        (temp_component / "package.json").write_text('{"name":"issue-332-temp-catalog-gap"}\n', encoding="utf-8")
        try:
            result = self._run_catalog(CATALOG_PATH)
        finally:
            shutil.rmtree(temp_component, ignore_errors=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("catalog completeness mismatch", result.stderr)
        self.assertIn(expected_root, result.stderr)

    def test_stale_service_path_in_non_allowlisted_file_fails(self) -> None:
        temp_note = REPO_ROOT / "docs" / "issue-332-temp-stale-path.md"
        stale_path = "/".join(("apps", "c2c-ui", "dist"))
        expected_fix = "/".join(("apps", "c2c-studio", "dist"))
        temp_note.write_text(f"Legacy note: {stale_path}\n", encoding="utf-8")
        try:
            result = self._run_catalog(CATALOG_PATH)
        finally:
            temp_note.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"stale service path {stale_path}", result.stderr)
        self.assertIn(f"expected {expected_fix}", result.stderr)

    def test_stale_service_path_under_generated_output_is_ignored(self) -> None:
        temp_output = REPO_ROOT / "var" / "issue-332-temp-output"
        temp_output.mkdir(parents=True, exist_ok=True)
        stale_path = "/".join(("apps", "c2c-ui", "dist"))
        (temp_output / "scan.txt").write_text(f"Legacy note: {stale_path}\n", encoding="utf-8")
        try:
            result = self._run_catalog(CATALOG_PATH)
        finally:
            shutil.rmtree(temp_output, ignore_errors=True)

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_stale_service_path_in_workflow_file_fails(self) -> None:
        temp_workflow = REPO_ROOT / ".github" / "workflows" / "issue-332-temp-stale-path.yml"
        stale_path = "/".join(("apps", "c2c-ui", "dist"))
        expected_fix = "/".join(("apps", "c2c-studio", "dist"))
        temp_workflow.write_text(f"name: temp\njobs:\n  scan:\n    run: echo '{stale_path}'\n", encoding="utf-8")
        try:
            result = self._run_catalog(CATALOG_PATH)
        finally:
            temp_workflow.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"stale service path {stale_path}", result.stderr)
        self.assertIn(".github/workflows/issue-332-temp-stale-path.yml", result.stderr)
        self.assertIn(f"expected {expected_fix}", result.stderr)

    def test_missing_declared_file_fails(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "c2c-bff":
                component["openapi"] = "missing-openapi.yaml"
                break
        else:
            self.fail("c2c-bff missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("openapi does not exist", result.stderr)

    def test_missing_openapi_owner_fails(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "evidence-service":
                component.pop("openapi", None)
                break
        else:
            self.fail("evidence-service missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be owned by exactly one catalog component", result.stderr)

    def test_missing_shared_schema_owner_fails(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "c2c-bff":
                component["schemas"] = [
                    path for path in component["schemas"] if path != "schemas/diagnostic-v0.json"
                ]
                break
        else:
            self.fail("c2c-bff missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("shared schema schemas/diagnostic-v0.json", result.stderr)

    def test_duplicate_shared_schema_owner_fails(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "orchestrator-service":
                component.setdefault("schemas", []).append("schemas/diagnostic-v0.json")
                break
        else:
            self.fail("orchestrator-service missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("shared schema schemas/diagnostic-v0.json", result.stderr)

    def test_service_local_schema_must_remain_local_to_its_component(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "experience-learning-service":
                component["schemas"] = [
                    "services/agentic-harness-core/schemas/capability-catalog.schema.json"
                ]
                break
        else:
            self.fail("experience-learning-service missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must stay under the owning component's schemas/ folder", result.stderr)

    def test_supply_chain_participation_is_required(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "c2c-studio":
                component.pop("supplyChainParticipation", None)
                break
        else:
            self.fail("c2c-studio missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("supplyChainParticipation must be a non-empty array", result.stderr)

    def test_supply_chain_participation_rejects_unknown_values(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "c2c-studio":
                component["supplyChainParticipation"] = ["sbom", "export"]
                break
        else:
            self.fail("c2c-studio missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("supplyChainParticipation values must be drawn from", result.stderr)

    def test_supply_chain_participant_requires_dependency_manifest(self) -> None:
        catalog = _load_catalog()
        mutated = copy.deepcopy(catalog)
        for component in mutated["components"]:
            if component["id"] == "c2c-target-java-runtime":
                component.pop("dependencyManifest", None)
                break
        else:
            self.fail("c2c-target-java-runtime missing from catalog fixture")

        temp_catalog = self._write_temp_catalog(mutated)
        try:
            result = self._run_catalog(temp_catalog)
        finally:
            temp_catalog.unlink(missing_ok=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "dependencyManifest is required for supply-chain participating components",
            result.stderr,
        )

    def test_query_lists_npm_dependency_manifests(self) -> None:
        result = self._run_catalog(
            CATALOG_PATH,
            "--list-field",
            "dependencyManifest",
            "--package-manager",
            "npm",
        )

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "apps/c2c-studio/package-lock.json",
                "services/c2c-bff/package-lock.json",
                "services/reference/w0-service-typescript/package-lock.json",
            ],
        )

    def test_query_prints_dependency_manifest_path(self) -> None:
        result = self._run_catalog(
            CATALOG_PATH,
            "--print-field",
            "dependencyManifest",
            "--component-id",
            "c2c-studio",
        )

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "apps/c2c-studio/package-lock.json")

    def test_query_filters_supply_chain_participants(self) -> None:
        result = self._run_catalog(
            CATALOG_PATH,
            "--list-field",
            "path",
            "--supply-chain",
            "sbom",
            "--kind",
            "library",
        )

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["libs/c2c-target-java-runtime"])

    def test_query_prints_component_path(self) -> None:
        result = self._run_catalog(
            CATALOG_PATH,
            "--print-field",
            "path",
            "--component-id",
            "w0-service-go",
        )

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "services/reference/w0-service-go")

    def test_query_requires_non_empty_matches(self) -> None:
        result = self._run_catalog(
            CATALOG_PATH,
            "--list-field",
            "path",
            "--language",
            "go",
            "--kind",
            "app",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("catalog query returned no values", result.stderr)


if __name__ == "__main__":
    unittest.main()
