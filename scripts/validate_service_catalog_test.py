"""Regression tests for ``scripts/validate-service-catalog.py``."""

from __future__ import annotations

import copy
import json
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
