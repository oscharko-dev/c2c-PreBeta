import json
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

W02_REQUIRED_FIXTURES = [
    "corpus/synthetic/programs/hello-w02.cbl",
    "corpus/synthetic/programs/branch-account-guard.cbl",
    "corpus/synthetic/programs/file-io-unsupported.cbl",
]

REFERENCE_RUN_FIXTURES = [
    "corpus/synthetic/programs/branch-account-guard.cbl",
    "corpus/synthetic/programs/ctrl-decimal-payroll.cbl",
    "corpus/synthetic/programs/decimal-batch-aggregator.cbl",
]


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


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
        script = W02_GATE.read_text(encoding="utf-8")
        for fixture_path in W02_REQUIRED_FIXTURES:
            self.assertIn(fixture_path, script, f"W0.2 release gate missing fixture path {fixture_path}")

    def test_reference_run_uses_documented_reference_programs(self) -> None:
        script = W0_REFERENCE_RUN.read_text(encoding="utf-8")
        for fixture_path in REFERENCE_RUN_FIXTURES:
            self.assertIn(fixture_path, script, f"reference run missing fixture path {fixture_path}")


if __name__ == "__main__":
    unittest.main()
