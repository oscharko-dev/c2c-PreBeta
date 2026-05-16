"""Tests for the run-scoped artifact store used by orchestrator-service."""

from __future__ import annotations

import json
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse, unquote

from orchestrator_service.artifacts import (
    INDEX_FILE,
    KIND_PARSE_OUTPUT,
    KIND_SOURCE,
    RunArtifactStore,
)


# noinspection PyAttributeOutsideInitInspection
class RunArtifactStoreTests(unittest.TestCase):
    # noinspection PyPep8Naming
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.store = RunArtifactStore(self.root, created_by="orchestrator-service-test")

    def test_init_run_creates_index_with_artifacts_list(self) -> None:
        self.store.init_run("run-A", "w0-migration-v0", requester="test-suite")

        index_path = self.root / "run-A" / INDEX_FILE
        self.assertTrue(index_path.is_file())
        data = json.loads(index_path.read_text("utf-8"))
        self.assertEqual(data["runId"], "run-A")
        self.assertEqual(data["workflowId"], "w0-migration-v0")
        self.assertEqual(data["requester"], "test-suite")
        self.assertEqual(data["artifacts"], [])

    def test_write_json_persists_canonical_bytes_and_records_metadata(self) -> None:
        self.store.init_run("run-B", "w0-migration-v0")

        payload = {"runId": "run-B", "status": "ok", "items": [1, 2, 3]}
        meta = self.store.write_json("run-B", "w0-migration-v0", "parse-output.json", payload, kind=KIND_PARSE_OUTPUT)

        on_disk = (self.root / "run-B" / "parse-output.json").read_bytes()
        expected_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.assertEqual(on_disk, expected_bytes)
        self.assertEqual(meta.sha256, sha256(expected_bytes).hexdigest())
        self.assertEqual(meta.byteSize, len(expected_bytes))
        self.assertEqual(meta.kind, KIND_PARSE_OUTPUT)
        self.assertEqual(meta.mimeType, "application/json")
        self.assertEqual(meta.runId, "run-B")
        self.assertEqual(meta.workflowId, "w0-migration-v0")
        self.assertEqual(meta.path, "parse-output.json")
        self.assertEqual(meta.name, "parse-output.json")
        parsed = urlparse(meta.uri)
        self.assertEqual(parsed.scheme, "file")
        self.assertEqual(Path(unquote(parsed.path)), (self.root / "run-B" / "parse-output.json").resolve())

        index = self.store.read_index("run-B")
        self.assertIsNotNone(index)
        assert index is not None
        self.assertEqual(len(index["artifacts"]), 1)
        self.assertEqual(index["artifacts"][0]["path"], "parse-output.json")
        self.assertEqual(index["artifacts"][0]["sha256"], meta.sha256)

    def test_write_text_records_mime_type_and_keeps_utf8_content(self) -> None:
        self.store.init_run("run-C", "w0-migration-v0")

        text = "IDENTIFICATION DIVISION.\nPROGRAM-ID. CASE01.\n"
        meta = self.store.write_text(
            "run-C",
            "w0-migration-v0",
            "source.cbl",
            text,
            kind=KIND_SOURCE,
            mime_type="text/x-cobol",
        )
        on_disk = (self.root / "run-C" / "source.cbl").read_text("utf-8")
        self.assertEqual(on_disk, text)
        self.assertEqual(meta.mimeType, "text/x-cobol")
        self.assertEqual(meta.sha256, sha256(text.encode("utf-8")).hexdigest())

    def test_nested_paths_create_parent_directories(self) -> None:
        self.store.init_run("run-D", "w0-migration-v0")
        meta = self.store.write_text(
            "run-D",
            "w0-migration-v0",
            "generated-project/src/main/java/c2c/CASE01.java",
            "class CASE01 {}\n",
            kind="generated-project-file",
        )
        self.assertTrue((self.root / "run-D" / "generated-project" / "src" / "main" / "java" / "c2c" / "CASE01.java").is_file())
        self.assertEqual(meta.path, "generated-project/src/main/java/c2c/CASE01.java")

    def test_write_rejects_path_traversal(self) -> None:
        self.store.init_run("run-E", "w0-migration-v0")
        with self.assertRaises(ValueError):
            self.store.write_text("run-E", "w0-migration-v0", "../escape.json", "x", kind="x")
        with self.assertRaises(ValueError):
            self.store.write_text("run-E", "w0-migration-v0", "/abs.json", "x", kind="x")

    def test_overwriting_same_path_replaces_index_entry_not_duplicates(self) -> None:
        self.store.init_run("run-F", "w0-migration-v0")
        self.store.write_json("run-F", "w0-migration-v0", "run-summary.json", {"status": "starting"}, kind="run-summary")
        self.store.write_json("run-F", "w0-migration-v0", "run-summary.json", {"status": "completed"}, kind="run-summary")
        index = self.store.read_index("run-F") or {}
        entries = [entry for entry in index["artifacts"] if entry["path"] == "run-summary.json"]
        self.assertEqual(len(entries), 1)

    def test_missing_run_returns_none(self) -> None:
        self.assertIsNone(self.store.read_index("never-existed"))
        self.assertFalse(self.store.has_run("never-existed"))

    def test_find_metadata_returns_recorded_entry(self) -> None:
        self.store.init_run("run-G", "w0-migration-v0")
        self.store.write_json("run-G", "w0-migration-v0", "build-test-result.json", {"status": "ok"}, kind="build-test-result")
        meta = self.store.find_metadata("run-G", "build-test-result.json")
        self.assertIsNotNone(meta)
        assert meta is not None
        self.assertEqual(meta["sha256"], sha256(b'{"status":"ok"}').hexdigest())


if __name__ == "__main__":
    unittest.main()
