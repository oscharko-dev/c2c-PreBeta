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
    def _run_catalog(catalog_path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--repo-root", str(REPO_ROOT), "--catalog", str(catalog_path)],
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


if __name__ == "__main__":
    unittest.main()
