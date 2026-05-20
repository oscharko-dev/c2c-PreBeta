import json
import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
OWNERSHIP_DOC = REPO_ROOT / "docs" / "governance" / "fixture-ownership.md"
ACCEPTANCE_INDEX = REPO_ROOT / "fixtures" / "acceptance" / "index.json"
GOLDEN_MASTER_INDEX = REPO_ROOT / "fixtures" / "golden-master" / "index.json"
W02_GATE = REPO_ROOT / "scripts" / "w0-2-release-gate.sh"
W0_REFERENCE_RUN = REPO_ROOT / "scripts" / "w0-reference-run.sh"

DOCUMENTED_PATHS = [
    "fixtures/acceptance/",
    "fixtures/golden-master/",
    "fixtures/semantic-ir/",
    "corpus/synthetic/programs/",
    "corpus/synthetic/fixtures/",
    "corpus/synthetic/generator/",
    "corpus/public/",
    "services/c2c-bff/src/diagnostic-fixtures/",
]

def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _extract_assignments(script: str, variable_name: str) -> list[str]:
    pattern = re.compile(rf'^\s*{re.escape(variable_name)}="([^"]*)"$', re.MULTILINE)
    return pattern.findall(script)


def _extract_array_entries(script: str, array_name: str) -> list[str]:
    match = re.search(rf'^{re.escape(array_name)}=\(\n(?P<body>.*?)^\)', script, re.MULTILINE | re.DOTALL)
    if not match:
        return []
    return re.findall(r'^\s*"([^"]+)"$', match.group("body"), re.MULTILINE)


class FixtureOwnershipValidationTests(unittest.TestCase):
    def test_ownership_doc_exists_and_lists_shared_fixture_paths(self) -> None:
        self.assertTrue(OWNERSHIP_DOC.is_file(), f"missing ownership doc at {OWNERSHIP_DOC}")
        body = OWNERSHIP_DOC.read_text(encoding="utf-8")
        for documented_path in DOCUMENTED_PATHS:
            self.assertIn(documented_path, body, f"{documented_path} missing from fixture ownership doc")

    def test_documented_shared_fixture_paths_exist(self) -> None:
        for documented_path in DOCUMENTED_PATHS:
            resolved = REPO_ROOT / documented_path.rstrip("/")
            self.assertTrue(resolved.exists(), f"documented shared fixture path missing: {resolved}")

    def test_acceptance_index_references_existing_artifacts(self) -> None:
        payload = _load_json(ACCEPTANCE_INDEX)
        fixtures = payload.get("fixtures") or []
        self.assertGreater(len(fixtures), 0, "acceptance fixture index must declare at least one fixture")
        for fixture in fixtures:
            fixture_id = fixture["fixtureId"]
            source = REPO_ROOT / fixture["sourceCobolArtifactRef"]["path"]
            self.assertTrue(source.is_file(), f"{fixture_id} source fixture missing: {source}")
            expected = fixture.get("expectedOutputArtifactRef")
            if expected:
                expected_path = REPO_ROOT / expected["path"]
                self.assertTrue(expected_path.is_file(), f"{fixture_id} expected output missing: {expected_path}")

    def test_golden_master_index_references_existing_artifacts(self) -> None:
        payload = _load_json(GOLDEN_MASTER_INDEX)
        entries = payload.get("entries") or []
        self.assertGreater(len(entries), 0, "golden-master index must declare at least one entry")
        for entry in entries:
            program_id = entry["programId"]
            source = REPO_ROOT / entry["cobolSource"]
            output = REPO_ROOT / entry["expectedOutputPath"]
            self.assertTrue(source.is_file(), f"{program_id} COBOL source missing: {source}")
            self.assertTrue(output.is_file(), f"{program_id} expected output missing: {output}")

    def test_w02_release_gate_uses_documented_acceptance_fixtures(self) -> None:
        payload = _load_json(ACCEPTANCE_INDEX)
        fixtures = {fixture["fixtureId"]: fixture for fixture in payload["fixtures"]}
        hello = fixtures["HELLOW02"]
        blocked = fixtures["FILEIO-UNSUPPORTED"]
        script = W02_GATE.read_text(encoding="utf-8")
        positive_sources = _extract_assignments(script, "POSITIVE_SOURCE")
        positive_expected = _extract_assignments(script, "POSITIVE_EXPECTED")
        negative_sources = _extract_assignments(script, "NEGATIVE_SOURCE")

        self.assertIn(
            f"$ROOT_DIR/{hello['sourceCobolArtifactRef']['path']}",
            positive_sources,
            "W0.2 release gate foundry positive source must come from HELLOW02",
        )
        self.assertIn(
            f"$ROOT_DIR/{hello['expectedOutputArtifactRef']['path']}",
            positive_expected,
            "W0.2 release gate foundry expected output must come from HELLOW02",
        )
        self.assertIn(
            f"$ROOT_DIR/{blocked['sourceCobolArtifactRef']['path']}",
            negative_sources,
            "W0.2 release gate negative source must come from FILEIO-UNSUPPORTED",
        )
        self.assertIn(
            "$ROOT_DIR/corpus/synthetic/programs/branch-account-guard.cbl",
            positive_sources,
            "W0.2 release gate deterministic positive source must remain BRNCH01",
        )

    def test_reference_run_uses_documented_reference_programs(self) -> None:
        payload = _load_json(GOLDEN_MASTER_INDEX)
        entries = {entry["programId"]: entry for entry in payload["entries"]}
        script = W0_REFERENCE_RUN.read_text(encoding="utf-8")
        default_programs = _extract_array_entries(script, "DEFAULT_PROGRAMS")
        parsed_defaults = dict(entry.split(":", 1) for entry in default_programs)

        self.assertEqual(
            parsed_defaults.get("BRNCH01"),
            entries["BRNCH01"]["cobolSource"],
            "reference run BRNCH01 path must match the golden-master registry",
        )
        self.assertEqual(
            parsed_defaults.get("CTRLDEC01"),
            entries["CTRLDEC01"]["cobolSource"],
            "reference run CTRLDEC01 path must match the golden-master registry",
        )
        self.assertEqual(
            parsed_defaults.get("BATCH01"),
            entries["BATCH01"]["cobolSource"],
            "reference run BATCH01 path must match the golden-master registry",
        )


if __name__ == "__main__":
    unittest.main()
