"""Tests for the W0.2 acceptance-fixture and oracle contract (Issue #174).

These tests bind the on-disk fixtures/acceptance/index.json registry to the
run-contract vocabulary owned by the orchestrator. They prove that:

* The acceptance registry can be loaded from the repository tree.
* Every fixture's ``expectedFinalClassification`` is a member of
  ``FINAL_CLASSIFICATIONS``.
* Every fixture's ``expectedFailureCode`` (when set) is a member of
  ``FAILURE_CODES``.
* Both file-backed and paste-mode entry points share the same fixture
  contract — the registry MUST declare both modes for the shipping
  acceptance fixtures so that the BFF paste flow and the file-backed test
  fixtures stay aligned.
* Every fixture's declared ``sourceCobolArtifactRef`` resolves to an
  on-disk file that hashes to the declared sha256 and matches the
  declared byte size. This is the integrity gate that prevents fixtures
  from drifting from the registry.
* Negative fixtures (expectedFinalClassification == 'blocked') declare at
  least one unsupportedConstruct so the orchestrator can reject the run
  honestly with ``failure_code=unsupported_cobol`` instead of producing
  misleading Java.
"""

from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from typing import Any

from orchestrator_service.run_contract import (
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_SUCCESS,
    FAILURE_CODES,
    FAILURE_UNSUPPORTED_COBOL,
    FINAL_CLASSIFICATIONS,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
ACCEPTANCE_INDEX_PATH = REPO_ROOT / "fixtures" / "acceptance" / "index.json"
ACCEPTANCE_SCHEMA_PATH = REPO_ROOT / "schemas" / "acceptance-fixture-v0.json"

_DIAGNOSTIC_CODES = {
    "unsupported-feature",
    "unsupported-data-declaration",
    "unsupported-statement",
    "unterminated-block",
    "unmatched-block-end",
    "mismatched-block-end",
}


def _load_index() -> dict[str, Any]:
    with ACCEPTANCE_INDEX_PATH.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# noinspection PyAttributeOutsideInitInspection
class AcceptanceFixtureContractTests(unittest.TestCase):
    # noinspection PyPep8Naming
    def setUp(self) -> None:
        self.assertTrue(
            ACCEPTANCE_INDEX_PATH.is_file(),
            f"missing acceptance fixture index at {ACCEPTANCE_INDEX_PATH}",
        )
        self.index = _load_index()
        self.fixtures: list[dict[str, Any]] = self.index["fixtures"]

    def test_schema_version_is_v0(self) -> None:
        self.assertEqual(self.index.get("schemaVersion"), "v0")

    def test_schema_file_exists_and_has_required_defs(self) -> None:
        self.assertTrue(ACCEPTANCE_SCHEMA_PATH.is_file(), "schemas/acceptance-fixture-v0.json missing")
        with ACCEPTANCE_SCHEMA_PATH.open("r", encoding="utf-8") as fh:
            schema = json.load(fh)
        self.assertEqual(schema.get("$id"), "https://oscharko.dev/c2c/schemas/acceptance-fixture-v0.json")
        defs = schema.get("$defs", {})
        for required_def in ("acceptanceFixture", "unsupportedConstruct", "artifactReference", "cobolConstructName"):
            self.assertIn(required_def, defs, f"acceptance-fixture-v0 missing $defs.{required_def}")

    def test_registry_has_at_least_one_positive_and_one_negative_fixture(self) -> None:
        positives = [f for f in self.fixtures if f["expectedFinalClassification"] == CLASSIFICATION_SUCCESS]
        negatives = [f for f in self.fixtures if f["expectedFinalClassification"] == CLASSIFICATION_BLOCKED]
        self.assertGreaterEqual(len(positives), 1, "acceptance registry must contain at least one success fixture")
        self.assertGreaterEqual(len(negatives), 1, "acceptance registry must contain at least one blocked fixture")

    def test_every_fixture_classification_is_known(self) -> None:
        for fixture in self.fixtures:
            self.assertIn(
                fixture["expectedFinalClassification"],
                FINAL_CLASSIFICATIONS,
                f"fixture {fixture['fixtureId']} declares unknown classification",
            )

    def test_every_failure_code_is_known(self) -> None:
        for fixture in self.fixtures:
            failure_code = fixture.get("expectedFailureCode")
            if failure_code is None:
                continue
            self.assertIn(
                failure_code,
                FAILURE_CODES,
                f"fixture {fixture['fixtureId']} declares unknown failureCode {failure_code!r}",
            )

    def test_blocked_fixtures_require_unsupported_constructs_and_failure_code(self) -> None:
        for fixture in self.fixtures:
            if fixture["expectedFinalClassification"] != CLASSIFICATION_BLOCKED:
                continue
            self.assertGreaterEqual(
                len(fixture["unsupportedConstructs"]),
                1,
                f"blocked fixture {fixture['fixtureId']} must declare at least one unsupportedConstruct",
            )
            self.assertIn(
                fixture.get("expectedFailureCode"),
                FAILURE_CODES,
                f"blocked fixture {fixture['fixtureId']} must declare a known expectedFailureCode",
            )

    def test_success_fixtures_must_declare_oracle_generation_mode(self) -> None:
        for fixture in self.fixtures:
            if fixture["expectedFinalClassification"] != CLASSIFICATION_SUCCESS:
                continue
            mode = fixture.get("oracleGenerationMode")
            self.assertIn(
                mode,
                {"cobol-runtime", "static-fixture", "user-provided"},
                f"success fixture {fixture['fixtureId']} must declare oracleGenerationMode",
            )
            self.assertNotIn(
                "expectedFailureCode",
                fixture,
                f"success fixture {fixture['fixtureId']} must not declare expectedFailureCode",
            )

    def test_static_fixture_oracle_requires_expected_output_ref(self) -> None:
        for fixture in self.fixtures:
            if fixture.get("oracleGenerationMode") != "static-fixture":
                continue
            self.assertIn(
                "expectedOutputArtifactRef",
                fixture,
                f"fixture {fixture['fixtureId']} oracleGenerationMode=static-fixture requires expectedOutputArtifactRef",
            )

    def test_artifact_refs_match_on_disk_content(self) -> None:
        for fixture in self.fixtures:
            for field in ("sourceCobolArtifactRef", "expectedOutputArtifactRef"):
                ref = fixture.get(field)
                if not ref:
                    continue
                resolved = REPO_ROOT / ref["path"]
                self.assertTrue(
                    resolved.is_file(),
                    f"fixture {fixture['fixtureId']}.{field}.path does not resolve to a file: {resolved}",
                )
                self.assertEqual(
                    resolved.stat().st_size,
                    ref["byteSize"],
                    f"fixture {fixture['fixtureId']}.{field}.byteSize mismatch",
                )
                self.assertEqual(
                    _sha256(resolved),
                    ref["sha256"].lower(),
                    f"fixture {fixture['fixtureId']}.{field}.sha256 mismatch",
                )

    def test_unsupported_construct_codes_match_parser_diagnostic_vocabulary(self) -> None:
        for fixture in self.fixtures:
            for entry in fixture["unsupportedConstructs"]:
                self.assertIn(
                    entry["code"],
                    _DIAGNOSTIC_CODES,
                    f"fixture {fixture['fixtureId']} unsupportedConstruct.code "
                    f"{entry['code']!r} is not a known parser diagnostic code",
                )

    def test_target_language_is_java_for_w02(self) -> None:
        for fixture in self.fixtures:
            self.assertEqual(
                fixture.get("targetLanguage"),
                "java",
                f"fixture {fixture['fixtureId']} must target Java in W0.2",
            )

    def test_shipping_fixtures_support_both_file_and_paste_modes(self) -> None:
        """Issue #174: both file-backed and paste-mode flows share the contract.

        The BFF paste-mode submission accepts `sourceText` + optional
        `expectedOutput` (Issue #172) and validates against the same
        acceptance contract. The registry MUST declare both modes for every
        shipping fixture so the test surface and the UI surface stay in
        sync. Fixtures that should only run in one mode would need to
        declare their reason explicitly.
        """

        for fixture in self.fixtures:
            modes = set(fixture.get("modes") or [])
            self.assertIn("file-backed", modes, f"fixture {fixture['fixtureId']} missing file-backed mode")
            self.assertIn("paste-mode", modes, f"fixture {fixture['fixtureId']} missing paste-mode")

    def test_hello_w02_is_canonical_positive_fixture(self) -> None:
        hello = next((f for f in self.fixtures if f["fixtureId"] == "HELLOW02"), None)
        self.assertIsNotNone(hello, "HELLOW02 must be registered as the canonical positive acceptance fixture")
        assert hello is not None
        self.assertEqual(hello["expectedFinalClassification"], CLASSIFICATION_SUCCESS)
        self.assertEqual(hello["oracleGenerationMode"], "cobol-runtime")
        self.assertIn("DISPLAY", hello["supportedSubset"])
        self.assertIn("PERFORM-VARYING", hello["supportedSubset"])
        self.assertEqual(hello["unsupportedConstructs"], [])

    def test_fileio_negative_fixture_maps_to_unsupported_cobol(self) -> None:
        blocked = next((f for f in self.fixtures if f["fixtureId"] == "FILEIO-UNSUPPORTED"), None)
        self.assertIsNotNone(blocked, "FILEIO-UNSUPPORTED must be registered as the canonical negative fixture")
        assert blocked is not None
        self.assertEqual(blocked["expectedFinalClassification"], CLASSIFICATION_BLOCKED)
        self.assertEqual(blocked["expectedFailureCode"], FAILURE_UNSUPPORTED_COBOL)
        constructs = {entry["construct"] for entry in blocked["unsupportedConstructs"]}
        # All five W0.2-forbidden File-I/O constructs must be in the registry.
        self.assertTrue({"FILE SECTION", "FD", "OPEN", "READ", "CLOSE"}.issubset(constructs))


if __name__ == "__main__":
    unittest.main()
