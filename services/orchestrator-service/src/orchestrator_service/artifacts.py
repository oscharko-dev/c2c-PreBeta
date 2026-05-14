"""Run-scoped artifact persistence for orchestrator-service.

Each transformation run owns a directory under the configured artifact root
(default: ``var/c2c-local/runs/{runId}``). Every artifact captured during a
run is written to disk through :class:`RunArtifactStore`, which also maintains
an ``artifacts-index.json`` index containing the metadata required by the
W0 product path (uri, sha256, byteSize, mimeType, kind, createdBy, createdAt,
runId, workflowId, path, name).

The hash recorded in every metadata entry is computed from the exact bytes
written to disk. Reads return ``None`` when the artifact is missing so callers
can return ``incomplete`` to the UI rather than fabricating success states.
"""

from __future__ import annotations

import datetime
import json
import os
import threading
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional


DEFAULT_RUN_ARTIFACT_ROOT = "var/c2c-local/runs"

KIND_SOURCE = "source"
KIND_SOURCE_REF = "source-ref"
KIND_PARSE_OUTPUT = "parse-output"
KIND_SEMANTIC_IR_OUTPUT = "semantic-ir-output"
KIND_SEMANTIC_IR = "semantic-ir"
KIND_GENERATED_PROJECT_FILE = "generated-project-file"
KIND_GENERATION_RESPONSE = "generation-response"
KIND_BUILD_TEST_RESULT = "build-test-result"
KIND_EVIDENCE_PACK_MANIFEST = "evidence-pack-manifest"
KIND_TRAJECTORY_LEDGER = "trajectory-ledger"
KIND_MODEL_INVOCATION_LEDGER = "model-invocation-ledger"
KIND_MODEL_POLICY_SKIPPED = "model-policy-skipped"
KIND_RUN_SUMMARY = "run-summary"

MIME_JSON = "application/json"
MIME_COBOL = "text/x-cobol"
MIME_JAVA = "text/x-java-source"
MIME_XML = "application/xml"
MIME_PLAIN = "text/plain"

INDEX_FILE = "artifacts-index.json"
SUMMARY_FILE = "run-summary.json"


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class ArtifactMetadata:
    """Persisted metadata for a single run artifact.

    The fields mirror the artifact reference contract required by Issue #89:
    every stored artifact must carry uri/sha256/byteSize/mimeType/kind plus
    audit fields (createdBy, createdAt, runId, workflowId).
    """

    uri: str
    sha256: str
    byteSize: int
    mimeType: str
    kind: str
    createdBy: str
    createdAt: str
    runId: str
    workflowId: str
    path: str
    name: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")


def _mime_for_path(relpath: str, default: str = "application/octet-stream") -> str:
    lower = relpath.lower()
    if lower.endswith(".json"):
        return MIME_JSON
    if lower.endswith(".java"):
        return MIME_JAVA
    if lower.endswith(".xml") or lower.endswith(".pom"):
        return MIME_XML
    if lower.endswith(".cbl") or lower.endswith(".cob"):
        return MIME_COBOL
    if lower.endswith(".txt") or lower.endswith(".md"):
        return MIME_PLAIN
    return default


class RunArtifactStore:
    """Filesystem-backed run artifact store with an artifact-metadata index."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        created_by: str = "orchestrator-service",
        clock: Optional[Callable[[], datetime.datetime]] = None,
    ) -> None:
        self.root = Path(root)
        self.created_by = created_by
        self._clock = clock or (lambda: datetime.datetime.now(tz=datetime.timezone.utc))
        self._locks: Dict[str, threading.Lock] = {}
        self._lock_table_mutex = threading.Lock()

    # ----- public API ------------------------------------------------------

    def init_run(self, run_id: str, workflow_id: str, *, requester: str = "") -> None:
        """Create the run directory and the artifacts index if absent."""
        run_dir = self._run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        index_path = run_dir / INDEX_FILE
        with self._run_lock(run_id):
            if not index_path.exists():
                state = {
                    "runId": run_id,
                    "workflowId": workflow_id,
                    "requester": requester,
                    "createdAt": self._timestamp(),
                    "artifacts": [],
                }
                self._atomic_write_bytes(index_path, _index_bytes(state))

    def write_bytes(
        self,
        run_id: str,
        workflow_id: str,
        relpath: str,
        data: bytes,
        *,
        kind: str,
        mime_type: Optional[str] = None,
    ) -> ArtifactMetadata:
        """Persist raw bytes and record their metadata in the run index."""
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("data must be bytes")
        if not relpath or relpath.startswith("/") or ".." in Path(relpath).parts:
            raise ValueError(f"invalid relative path: {relpath!r}")
        target = self._run_dir(run_id) / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._run_lock(run_id):
            self._atomic_write_bytes(target, bytes(data))
            meta = ArtifactMetadata(
                uri=self._uri(run_id, relpath),
                sha256=sha256(data).hexdigest(),
                byteSize=len(data),
                mimeType=mime_type or _mime_for_path(relpath),
                kind=kind,
                createdBy=self.created_by,
                createdAt=self._timestamp(),
                runId=run_id,
                workflowId=workflow_id,
                path=relpath,
                name=Path(relpath).name,
            )
            self._record(run_id, meta)
            return meta

    def write_json(
        self,
        run_id: str,
        workflow_id: str,
        relpath: str,
        payload: Any,
        *,
        kind: str,
    ) -> ArtifactMetadata:
        return self.write_bytes(
            run_id,
            workflow_id,
            relpath,
            _canonical_json_bytes(payload),
            kind=kind,
            mime_type=MIME_JSON,
        )

    def write_text(
        self,
        run_id: str,
        workflow_id: str,
        relpath: str,
        text: str,
        *,
        kind: str,
        mime_type: Optional[str] = None,
    ) -> ArtifactMetadata:
        return self.write_bytes(
            run_id,
            workflow_id,
            relpath,
            text.encode("utf-8"),
            kind=kind,
            mime_type=mime_type or _mime_for_path(relpath, MIME_PLAIN),
        )

    def update_summary(
        self,
        run_id: str,
        workflow_id: str,
        payload: Mapping[str, Any],
    ) -> ArtifactMetadata:
        """Persist run-summary.json. The summary is overwritten on every update."""
        return self.write_json(
            run_id,
            workflow_id,
            SUMMARY_FILE,
            dict(payload),
            kind=KIND_RUN_SUMMARY,
        )

    def has_run(self, run_id: str) -> bool:
        return (self._run_dir(run_id) / INDEX_FILE).is_file()

    def read_index(self, run_id: str) -> Optional[Dict[str, Any]]:
        index_path = self._run_dir(run_id) / INDEX_FILE
        if not index_path.is_file():
            return None
        try:
            return json.loads(index_path.read_text("utf-8"))
        except json.JSONDecodeError:
            return None

    def list_artifacts(self, run_id: str) -> Optional[List[Dict[str, Any]]]:
        index = self.read_index(run_id)
        if index is None:
            return None
        artifacts = index.get("artifacts")
        if not isinstance(artifacts, list):
            return []
        return list(artifacts)

    def read_summary(self, run_id: str) -> Optional[Dict[str, Any]]:
        return self.read_json(run_id, SUMMARY_FILE)

    def read_bytes(self, run_id: str, relpath: str) -> Optional[bytes]:
        target = self._run_dir(run_id) / relpath
        if not target.is_file():
            return None
        return target.read_bytes()

    def read_json(self, run_id: str, relpath: str) -> Optional[Any]:
        raw = self.read_bytes(run_id, relpath)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def find_metadata(self, run_id: str, relpath: str) -> Optional[Dict[str, Any]]:
        artifacts = self.list_artifacts(run_id) or []
        for entry in artifacts:
            if entry.get("path") == relpath:
                return entry
        return None

    def find_by_kind(self, run_id: str, kind: str) -> List[Dict[str, Any]]:
        artifacts = self.list_artifacts(run_id) or []
        return [entry for entry in artifacts if entry.get("kind") == kind]

    # ----- helpers ---------------------------------------------------------

    def _run_dir(self, run_id: str) -> Path:
        if not run_id:
            raise ValueError("run_id is required")
        if "/" in run_id or "\\" in run_id or ".." in run_id:
            raise ValueError(f"invalid run_id: {run_id!r}")
        return self.root / run_id

    def _run_lock(self, run_id: str) -> threading.Lock:
        with self._lock_table_mutex:
            existing = self._locks.get(run_id)
            if existing is None:
                existing = threading.Lock()
                self._locks[run_id] = existing
        return existing

    def _uri(self, run_id: str, relpath: str) -> str:
        absolute = (self._run_dir(run_id) / relpath).resolve()
        return absolute.as_uri()

    def _timestamp(self) -> str:
        now = self._clock()
        if now.tzinfo is None:
            now = now.replace(tzinfo=datetime.timezone.utc)
        return now.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    def _atomic_write_bytes(self, path: Path, data: bytes) -> None:
        tmp_path = path.with_name(f".{path.name}.tmp")
        with open(tmp_path, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)

    def _record(self, run_id: str, meta: ArtifactMetadata) -> None:
        index_path = self._run_dir(run_id) / INDEX_FILE
        if not index_path.exists():
            state: Dict[str, Any] = {
                "runId": run_id,
                "workflowId": meta.workflowId,
                "requester": "",
                "createdAt": self._timestamp(),
                "artifacts": [],
            }
        else:
            try:
                state = json.loads(index_path.read_text("utf-8"))
            except json.JSONDecodeError:
                state = {
                    "runId": run_id,
                    "workflowId": meta.workflowId,
                    "requester": "",
                    "createdAt": self._timestamp(),
                    "artifacts": [],
                }
        artifacts = [entry for entry in state.get("artifacts", []) if entry.get("path") != meta.path]
        artifacts.append(meta.to_dict())
        state["artifacts"] = artifacts
        state["updatedAt"] = self._timestamp()
        self._atomic_write_bytes(index_path, _index_bytes(state))


def _index_bytes(state: Mapping[str, Any]) -> bytes:
    return json.dumps(state, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")


class NullArtifactStore:
    """No-op store used when persistence is intentionally disabled."""

    root = Path()

    def init_run(self, run_id: str, workflow_id: str, *, requester: str = "") -> None:  # noqa: D401, ARG002
        return None

    def write_bytes(self, run_id: str, workflow_id: str, relpath: str, data: bytes, *, kind: str, mime_type: Optional[str] = None) -> Optional[ArtifactMetadata]:  # noqa: ARG002
        return None

    def write_json(self, run_id: str, workflow_id: str, relpath: str, payload: Any, *, kind: str) -> Optional[ArtifactMetadata]:  # noqa: ARG002
        return None

    def write_text(self, run_id: str, workflow_id: str, relpath: str, text: str, *, kind: str, mime_type: Optional[str] = None) -> Optional[ArtifactMetadata]:  # noqa: ARG002
        return None

    def update_summary(self, run_id: str, workflow_id: str, payload: Mapping[str, Any]) -> Optional[ArtifactMetadata]:  # noqa: ARG002
        return None

    def has_run(self, run_id: str) -> bool:  # noqa: ARG002
        return False

    def read_index(self, run_id: str) -> Optional[Dict[str, Any]]:  # noqa: ARG002
        return None

    def list_artifacts(self, run_id: str) -> Optional[List[Dict[str, Any]]]:  # noqa: ARG002
        return None

    def read_summary(self, run_id: str) -> Optional[Dict[str, Any]]:  # noqa: ARG002
        return None

    def read_bytes(self, run_id: str, relpath: str) -> Optional[bytes]:  # noqa: ARG002
        return None

    def read_json(self, run_id: str, relpath: str) -> Optional[Any]:  # noqa: ARG002
        return None

    def find_metadata(self, run_id: str, relpath: str) -> Optional[Dict[str, Any]]:  # noqa: ARG002
        return None

    def find_by_kind(self, run_id: str, kind: str) -> List[Dict[str, Any]]:  # noqa: ARG002
        return []
