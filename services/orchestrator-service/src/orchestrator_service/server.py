"""HTTP API for orchestrator service."""

from __future__ import annotations

import json
import logging
import hmac
import threading
import urllib.parse
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import PurePosixPath
from typing import Any
from .artifacts import (
    KIND_BUILD_TEST_RESULT,
    KIND_EVIDENCE_PACK_MANIFEST,
    KIND_GENERATED_PROJECT_FILE,
    KIND_LEARNING_SUMMARY,
    MIME_JAVA,
    MIME_PLAIN,
    JsonObject,
    RunArtifactStore,
)
from .client import JSONHTTPClient
from .config import OrchestratorConfig, load_config
from .client import HttpClientError
from .experience import ExperienceLearningGateway, NullExperienceLearningGateway
from .harness import HarnessFailure, HarnessGateway
from . import region_classification
from .workflow import (
    EXECUTION_MODE_PARITY,
    EXECUTION_MODE_STANDARD,
    REFERENCE_MODE_NATIVE_COBOL,
    REFERENCE_MODE_REFERENCE_FIXTURE,
    OrchestratorError,
    W0RunContext,
    W0WorkflowRunner,
    normalise_manual_edit_overlay_region,
)


class UpstreamServiceError(Exception):
    """Raised when Harness cannot be reached or returns an invalid upstream result."""


def _extract_manual_overlay_regions(
    raw: Any,
) -> tuple[dict[str, Any], ...]:
    """Validate and normalise the optional ``manualOverlay`` payload.

    ADR 0007 §5 / Issue #280: the orchestrator accepts the manual-edit
    overlay as either an envelope ``{"schemaVersion": "v0", "regions": [...]}``
    or a bare ``regions`` array. ``None`` and empty payloads return an
    empty tuple — the default for greenfield runs. Each region MUST
    carry the full ADR 0007 provenance metadata required by the
    ``manual-edit-overlay.json`` artifact; anything else raises
    ``ValueError`` so the orchestrator never commits to a run with a
    malformed or audit-incomplete overlay.
    """
    if raw is None:
        return ()
    if isinstance(raw, dict):
        regions_raw = raw.get("regions", [])
        default_file_path = raw.get("javaFile")
    elif isinstance(raw, list):
        regions_raw = raw
        default_file_path = None
    else:
        raise ValueError(
            "manualOverlay must be an object or array; got "
            f"{type(raw).__name__}"
        )
    if not isinstance(regions_raw, list):
        raise ValueError("manualOverlay.regions must be an array")
    normalised: list[dict[str, Any]] = []
    for index, region in enumerate(regions_raw):
        if not isinstance(region, dict):
            raise ValueError(
                f"manualOverlay.regions[{index}] must be an object"
            )
        try:
            body_region = normalise_manual_edit_overlay_region(
                region,
                index=index,
                default_file_path=default_file_path,
            )
        except OrchestratorError as exc:
            raise ValueError(str(exc)) from exc
        line_range = body_region["lineRange"]
        assert isinstance(line_range, dict)
        entry: dict[str, Any] = {
            "filePath": body_region["filePath"],
            "originClass": body_region["originClass"],
            "startLine": line_range["startLine"],
            "endLine": line_range["endLine"],
            "generatorBaselineRunId": body_region["generatorBaselineRunId"],
            "lastModifiedAt": body_region["lastModifiedAt"],
            "lastModifiedBy": body_region["lastModifiedBy"],
            "manualEditCount": body_region["manualEditCount"],
        }
        if "generatorBaselineRegionHash" in body_region:
            entry["generatorBaselineRegionHash"] = body_region[
                "generatorBaselineRegionHash"
            ]
        normalised.append(entry)
    return tuple(normalised)


def _register_capabilities_with_harness(
    config: OrchestratorConfig,
    gateway: HarnessGateway,
) -> None:
    """Register orchestrator-owned capabilities into the Harness catalog."""
    for capability in config.w0_capabilities:
        capability_id = str(capability.get("id", "")).strip()
        if not capability_id:
            continue
        try:
            gateway.register_capability(capability)
        except HarnessFailure as exc:
            lower_message = str(exc.details).lower()
            if exc.status == 400 and "already registered" in lower_message:
                continue
            if exc.status == 409 and "already registered" in lower_message:
                continue
            raise
        except HttpClientError as exc:
            lower_message = str(exc).lower()
            if "already registered" in lower_message or "already exists" in lower_message:
                if "failed with 400" in lower_message:
                    continue
                if "failed with 409" in lower_message:
                    continue
            raise


class OrchestratorService:
    """Small HTTP facade for asynchronous workflow execution."""

    def __init__(
        self,
        config: OrchestratorConfig,
        runner: W0WorkflowRunner,
        artifact_store: RunArtifactStore | None = None,
    ):
        self.config = config
        self.runner = runner
        self.artifact_store = artifact_store or runner.artifact_store
        self.lock = threading.Lock()
        self.logger = logging.getLogger(__name__)

    def handler_factory(self):
        service = self

        class RequestHandler(BaseHTTPRequestHandler):
            server_version = "orchestrator-service/0.1"
            error_content_type = "application/json"

            def _route_parts(self) -> list[str]:
                path = urllib.parse.urlparse(self.path).path
                return [segment for segment in path.split("/") if segment]

            def _write_json(self, status: int, payload: Any) -> None:
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _read_json(self) -> Any:
                content_length = int(self.headers.get("Content-Length", "0") or "0")
                if content_length <= 0:
                    return {}
                raw = self.rfile.read(content_length)
                return json.loads(raw.decode("utf-8"))

            def _presented_control_token(self) -> str:
                raw = self.headers.get("X-C2C-Control-Token", "").strip()
                if raw:
                    return raw
                raw = self.headers.get("X-Harness-Token", "").strip()
                if raw:
                    return raw
                authorization = self.headers.get("Authorization", "").strip()
                prefix = "bearer "
                if authorization.lower().startswith(prefix):
                    return authorization[len(prefix):].strip()
                return ""

            def _is_authorized(self) -> bool:
                expected = service.config.control_token.strip()
                if not expected:
                    return False
                return hmac.compare_digest(self._presented_control_token(), expected)

            def _require_control_token(self) -> bool:
                if self._is_authorized():
                    return True
                self._write_json(401, {"error": "unauthorized"})
                return False

            # noinspection PyPep8Naming
            def do_GET(self) -> None:
                try:
                    parts = self._route_parts()
                    if not parts:
                        self._write_json(200, {"status": "ok", "service": service.config.service_name})
                        return
                    if parts == ["health"]:
                        self._write_json(
                            200,
                            {
                                "status": "ok",
                                "service": service.config.service_name,
                                "workflowId": service.config.workflow_id,
                            },
                        )
                        return
                    if not self._require_control_token():
                        return
                    if parts == ["v0", "runs"]:
                        self._write_json(200, service._runs_list())
                        return
                    if len(parts) == 3 and parts[0] == "v0" and parts[1] == "runs":
                        run_id = parts[2]
                        run_state = service._run_state(run_id)
                        if run_state is None:
                            self._write_json(404, {"error": "run not found"})
                            return
                        self._write_json(200, run_state)
                        return
                    if len(parts) == 4 and parts[0] == "v0" and parts[1] == "runs":
                        run_id = parts[2]
                        artifact_path = parts[3]
                        status, payload = service._artifact_endpoint(run_id, artifact_path)
                        self._write_json(status, payload)
                        return
                    if (
                        len(parts) >= 5
                        and parts[0] == "v0"
                        and parts[1] == "runs"
                        and parts[3] == "generated"
                        and parts[4] == "files"
                    ):
                        run_id = parts[2]
                        if len(parts) == 5:
                            status, payload = service._generated_files_index(run_id)
                            self._write_json(status, payload)
                            return
                        encoded_segments = parts[5:]
                        decoded = "/".join(
                            urllib.parse.unquote(segment) for segment in encoded_segments
                        )
                        status, payload = service._generated_file_content(run_id, decoded)
                        self._write_json(status, payload)
                        return
                    self._write_json(404, {"error": "not found"})
                except Exception as exc:
                    if isinstance(exc, UpstreamServiceError):
                        self._write_json(503, {"error": str(exc)})
                        return
                    service.logger.error("GET handling failed", exc_info=exc)
                    self._write_json(500, {"error": "internal server error"})

            # noinspection PyPep8Naming
            def do_POST(self) -> None:
                try:
                    parts = self._route_parts()
                    if not self._require_control_token():
                        return
                    if len(parts) == 2 and parts[0] == "v0" and parts[1] == "runs":
                        payload = self._read_json()
                        status_code, response_body = service._start_run(payload)
                        self._write_json(status_code, response_body)
                        return
                    if (
                        len(parts) == 6
                        and parts[0] == "v0"
                        and parts[1] == "runs"
                        and parts[3] == "manual-compile-repair"
                    ):
                        run_id = parts[2]
                        payload = self._read_json()
                        if parts[4] == "diagnose" and parts[5] == "request":
                            self._write_json(200, service._manual_compile_repair_diagnose(run_id, payload))
                            return
                        if parts[4] == "apply" and parts[5] == "request":
                            self._write_json(200, service._manual_compile_repair_apply(run_id, payload))
                            return
                        if parts[4] == "reject" and parts[5] == "request":
                            self._write_json(200, service._manual_compile_repair_reject(run_id, payload))
                            return
                    self._write_json(404, {"error": "not found"})
                except json.JSONDecodeError:
                    self._write_json(400, {"error": "invalid JSON body"})
                except ValueError as exc:
                    self._write_json(400, {"error": str(exc)})
                except OrchestratorError as exc:
                    self._write_json(409, {"error": str(exc)})
                except Exception as exc:
                    service.logger.error("POST handling failed", exc_info=exc)
                    self._write_json(500, {"error": "internal server error"})

            # noinspection PyPep8Naming
            def do_PATCH(self) -> None:
                if not self._require_control_token():
                    return
                self._write_json(405, {"error": "method not allowed"})

            def log_message(self, fmt: str, *args: object) -> None:
                return

        return RequestHandler

    def _artifact_endpoint(self, run_id: str, action: str) -> tuple[int, JsonObject]:
        if not self.artifact_store.has_run(run_id):
            return 404, {"error": "run not found", "runId": run_id}
        summary = self.artifact_store.read_summary(run_id) or {}
        run_status = str(summary.get("status") or "incomplete")
        program_id = summary.get("programId") or ""
        workflow_id = summary.get("workflowId") or self.config.workflow_id
        envelope_base = {
            "runId": run_id,
            "workflowId": workflow_id,
            "programId": program_id,
            "runStatus": run_status,
        }
        if action == "artifacts":
            index = self.artifact_store.read_index(run_id) or {}
            return 200, {
                **envelope_base,
                "artifacts": index.get("artifacts", []),
                "createdAt": index.get("createdAt"),
                "updatedAt": index.get("updatedAt"),
                "summary": summary,
            }
        if action == "generated":
            return 200, self._generated_view(run_id, envelope_base)
        generated_artifact_ref = self._generated_artifact_ref(run_id)
        if action == "build-test":
            payload = self._artifact_payload(
                run_id,
                envelope_base,
                relpath="build-test-result.json",
                kind=KIND_BUILD_TEST_RESULT,
                missing_label="build-test-result",
            )
            payload["generatedArtifactRef"] = generated_artifact_ref
            return 200, payload
        if action == "evidence":
            payload = self._artifact_payload(
                run_id,
                envelope_base,
                relpath="evidence-pack-manifest.json",
                kind=KIND_EVIDENCE_PACK_MANIFEST,
                missing_label="evidence-pack-manifest",
            )
            payload["generatedArtifactRef"] = generated_artifact_ref
            return 200, payload
        if action == "events":
            return 200, self._events_view(run_id, envelope_base)
        if action == "progress":
            return 200, self._progress_view(run_id, envelope_base)
        if action == "learning":
            return 200, self._learning_view(run_id, envelope_base)
        if action == "workflow":
            return 200, self._workflow_contract_view(run_id, envelope_base)
        if action == "traceability":
            return 200, self._traceability_view(run_id, envelope_base)
        return 404, {"error": "not found"}

    @staticmethod
    def _request_java_files(payload: Mapping[str, Any]) -> dict[str, str]:
        raw = payload.get("javaFiles")
        if not isinstance(raw, list) or not raw:
            raise ValueError("javaFiles must be a non-empty array")
        files: dict[str, str] = {}
        for index, entry in enumerate(raw):
            if not isinstance(entry, Mapping):
                raise ValueError(f"javaFiles[{index}] must be an object")
            path = str(entry.get("path") or "").strip()
            content = entry.get("content")
            if not path:
                raise ValueError(f"javaFiles[{index}].path must be a non-empty string")
            if not isinstance(content, str):
                raise ValueError(f"javaFiles[{index}].content must be a string")
            normalized = path.replace("\\", "/").strip().lstrip("/")
            if not normalized or ".." in PurePosixPath(normalized).parts or not normalized.endswith(".java"):
                raise ValueError(f"javaFiles[{index}].path must be a safe relative .java path")
            if normalized in files:
                raise ValueError(f"javaFiles[{index}].path must be unique")
            files[normalized] = content
        return files

    def _manual_compile_repair_diagnose(
        self,
        run_id: str,
        payload: Mapping[str, Any],
    ) -> JsonObject:
        java_files = self._request_java_files(payload)
        entry_file_path = str(payload.get("entryFilePath") or "").strip()
        if not entry_file_path:
            entry_file_path = next(iter(sorted(java_files)))
        if entry_file_path not in java_files:
            raise ValueError("entryFilePath must reference one of the provided javaFiles")
        entry_class = str(payload.get("entryClass") or "").strip()
        manual_overlay_regions = _extract_manual_overlay_regions(payload.get("manualOverlay"))
        requester = str(payload.get("requester") or self.config.service_name).strip()
        build_test_context = payload.get("buildTestContext")
        return self.runner.manual_compile_repair_diagnose(
            run_id=run_id,
            requester=requester,
            java_files=java_files,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
            manual_overlay_regions=manual_overlay_regions,
            build_test_context=build_test_context if isinstance(build_test_context, Mapping) else None,
        )

    def _manual_compile_repair_apply(
        self,
        run_id: str,
        payload: Mapping[str, Any],
    ) -> JsonObject:
        java_files = self._request_java_files(payload)
        entry_file_path = str(payload.get("entryFilePath") or "").strip()
        if not entry_file_path:
            entry_file_path = next(iter(sorted(java_files)))
        if entry_file_path not in java_files:
            raise ValueError("entryFilePath must reference one of the provided javaFiles")
        entry_class = str(payload.get("entryClass") or "").strip()
        proposal = payload.get("proposal")
        candidate_project = payload.get("candidateProject")
        if not isinstance(proposal, Mapping):
            raise ValueError("proposal must be an object")
        if not isinstance(candidate_project, Mapping):
            raise ValueError("candidateProject must be an object")
        requester = str(payload.get("requester") or self.config.service_name).strip()
        expected_output = payload.get("expectedOutput")
        oracle_input = payload.get("oracleInput")
        return self.runner.manual_compile_repair_apply(
            run_id=run_id,
            requester=requester,
            current_java_files=java_files,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
            proposal=proposal,
            candidate_project=candidate_project,
            expected_output=str(expected_output) if isinstance(expected_output, str) else None,
            oracle_input=str(oracle_input) if isinstance(oracle_input, str) else None,
        )

    def _manual_compile_repair_reject(
        self,
        run_id: str,
        payload: Mapping[str, Any],
    ) -> JsonObject:
        proposal = payload.get("proposal")
        if not isinstance(proposal, Mapping):
            raise ValueError("proposal must be an object")
        requester = str(payload.get("requester") or self.config.service_name).strip()
        return self.runner.manual_compile_repair_reject(
            run_id=run_id,
            requester=requester,
            proposal=proposal,
        )

    def _artifact_payload(
        self,
        run_id: str,
        envelope: JsonObject,
        *,
        relpath: str,
        kind: str,
        missing_label: str,
    ) -> JsonObject:
        data = self.artifact_store.read_json(run_id, relpath)
        meta = self.artifact_store.find_metadata(run_id, relpath)
        if data is None:
            return {
                **envelope,
                "status": "incomplete",
                "missingArtifacts": [missing_label],
                "data": None,
                "artifactRef": None,
            }
        return {
            **envelope,
            "status": "complete",
            "missingArtifacts": [],
            "data": data,
            "artifactRef": meta,
            "kind": kind,
        }

    def _generated_artifact_ref(self, run_id: str) -> JsonObject | None:
        manifest_meta = self.artifact_store.find_metadata(run_id, "generated-project-manifest.json")
        if manifest_meta is None:
            return None
        return {
            "uri": manifest_meta.get("uri"),
            "sha256": manifest_meta.get("sha256"),
            "byteSize": manifest_meta.get("byteSize"),
            "path": manifest_meta.get("path"),
            "kind": manifest_meta.get("kind"),
        }

    def _generated_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        response = self.artifact_store.read_json(run_id, "generation-response.json")
        response_meta = self.artifact_store.find_metadata(run_id, "generation-response.json")
        manifest = self.artifact_store.read_json(run_id, "generated-project-manifest.json")
        manifest_meta = self.artifact_store.find_metadata(run_id, "generated-project-manifest.json")
        file_metas = self.artifact_store.find_by_kind(run_id, KIND_GENERATED_PROJECT_FILE)
        files: dict[str, str] = {}
        file_refs: list[JsonObject] = []
        prefix = "generated-project/"
        for entry in file_metas:
            relpath = str(entry.get("path") or "")
            if not relpath.startswith(prefix):
                continue
            content = self.artifact_store.read_bytes(run_id, relpath)
            if content is None:
                continue
            short = relpath[len(prefix):]
            files[short] = content.decode("utf-8", errors="replace")
            file_refs.append(
                {
                    "path": short,
                    "absolutePath": relpath,
                    "uri": entry.get("uri"),
                    "sha256": entry.get("sha256"),
                    "byteSize": entry.get("byteSize"),
                    "mimeType": entry.get("mimeType"),
                }
            )
        file_refs.sort(key=lambda item: str(item.get("path") or ""))
        missing: list[str] = []
        if response is None:
            missing.append("generation-response")
        if not files:
            missing.append("generated-project")
        if manifest is None and files:
            missing.append("generated-project-manifest")
        generated_project: JsonObject = {}
        if isinstance(response, dict):
            project = response.get("generatedProject")
            if isinstance(project, dict):
                generated_project = project
        manifest_traceability: JsonObject = {}
        if isinstance(manifest, dict):
            traceability = manifest.get("traceability")
            if isinstance(traceability, dict):
                manifest_traceability = traceability
        artifact_ref: JsonObject | None = None
        if manifest_meta is not None:
            artifact_ref = {
                "uri": manifest_meta.get("uri"),
                "sha256": manifest_meta.get("sha256"),
                "byteSize": manifest_meta.get("byteSize"),
                "path": manifest_meta.get("path"),
                "kind": manifest_meta.get("kind"),
            }
        return {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "entryClass": str(generated_project.get("entryClass") or ""),
            "entryFilePath": str(generated_project.get("entryFilePath") or ""),
            "fileCount": len(files),
            "files": files,
            "fileRefs": file_refs,
            "unsupportedFeatures": list(generated_project.get("unsupportedFeatures", []) or []),
            "openAssumptions": list(generated_project.get("openAssumptions", []) or []),
            "generationResponse": response,
            "generationResponseRef": response_meta,
            "artifactRef": artifact_ref,
            "manifest": manifest,
            "manifestRef": manifest_meta,
            "traceability": {
                "programId": str(manifest_traceability.get("programId") or envelope.get("programId") or ""),
                "irId": str(manifest_traceability.get("irId") or ""),
                "sourceHash": str(manifest_traceability.get("sourceHash") or ""),
            },
        }

    @staticmethod
    def _safe_generated_relpath(raw: str) -> str | None:
        if not raw:
            return None
        if "\x00" in raw:
            return None
        normalized = raw.replace("\\", "/").strip()
        normalized = normalized.lstrip("/")
        if not normalized:
            return None
        parts = PurePosixPath(normalized).parts
        for segment in parts:
            if segment in ("", ".", ".."):
                return None
        return "/".join(parts)

    def _generated_files_index(self, run_id: str) -> tuple[int, JsonObject]:
        if not self.artifact_store.has_run(run_id):
            return 404, {"error": "run not found", "runId": run_id}
        summary = self.artifact_store.read_summary(run_id) or {}
        envelope = {
            "runId": run_id,
            "workflowId": summary.get("workflowId") or self.config.workflow_id,
            "programId": summary.get("programId") or "",
            "runStatus": str(summary.get("status") or "incomplete"),
        }
        manifest = self.artifact_store.read_json(run_id, "generated-project-manifest.json")
        manifest_meta = self.artifact_store.find_metadata(run_id, "generated-project-manifest.json")
        file_metas = self.artifact_store.find_by_kind(run_id, KIND_GENERATED_PROJECT_FILE)
        prefix = "generated-project/"
        file_refs: list[JsonObject] = []
        for entry in file_metas:
            relpath = str(entry.get("path") or "")
            if not relpath.startswith(prefix):
                continue
            short = relpath[len(prefix):]
            file_refs.append(
                {
                    "path": short,
                    "absolutePath": relpath,
                    "uri": entry.get("uri"),
                    "sha256": entry.get("sha256"),
                    "byteSize": entry.get("byteSize"),
                    "mimeType": entry.get("mimeType"),
                }
            )
        file_refs.sort(key=lambda item: str(item.get("path") or ""))
        missing: list[str] = []
        if not file_refs:
            missing.append("generated-project")
        if manifest is None and file_refs:
            missing.append("generated-project-manifest")
        artifact_ref: JsonObject | None = None
        if manifest_meta is not None:
            artifact_ref = {
                "uri": manifest_meta.get("uri"),
                "sha256": manifest_meta.get("sha256"),
                "byteSize": manifest_meta.get("byteSize"),
                "path": manifest_meta.get("path"),
                "kind": manifest_meta.get("kind"),
            }
        entry_file_path = ""
        if isinstance(manifest, dict):
            entry_file_path = str(manifest.get("entryFilePath") or "")
        return 200, {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "fileCount": len(file_refs),
            "files": file_refs,
            "entryFilePath": entry_file_path,
            "artifactRef": artifact_ref,
            "manifest": manifest,
            "manifestRef": manifest_meta,
        }

    def _generated_file_content(self, run_id: str, raw_path: str) -> tuple[int, JsonObject]:
        if not self.artifact_store.has_run(run_id):
            return 404, {"error": "run not found", "runId": run_id}
        safe = self._safe_generated_relpath(raw_path)
        if safe is None:
            return 400, {"error": "invalid generated file path", "path": raw_path}
        absolute = f"generated-project/{safe}"
        meta = self.artifact_store.find_metadata(run_id, absolute)
        content_bytes = self.artifact_store.read_bytes(run_id, absolute)
        if content_bytes is None or meta is None:
            return 404, {"error": "generated file not found", "path": safe}
        mime_type = str(meta.get("mimeType") or "")
        is_text = mime_type.startswith("text/") or mime_type in {MIME_JAVA, MIME_PLAIN, "application/json", "application/xml"}
        try:
            content_text = content_bytes.decode("utf-8") if is_text else content_bytes.decode("utf-8", errors="replace")
        except UnicodeDecodeError:
            content_text = content_bytes.decode("utf-8", errors="replace")
        return 200, {
            "runId": run_id,
            "path": safe,
            "absolutePath": absolute,
            "content": content_text,
            "sha256": meta.get("sha256"),
            "byteSize": meta.get("byteSize"),
            "mimeType": meta.get("mimeType"),
            "uri": meta.get("uri"),
            "kind": meta.get("kind"),
        }

    def _progress_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        """Issue #96: expose step-level progress for UI-started runs.

        The view prefers the in-memory progress log (live, includes a
        currently-running step) and falls back to the persisted
        `run-progress.json` artifact for runs that completed before the
        current process started, so refreshes after a restart still show
        the timeline.
        """
        live_steps = self.runner.progress_payload(run_id)
        persisted = self.artifact_store.read_json(run_id, "run-progress.json")
        persisted_meta = self.artifact_store.find_metadata(run_id, "run-progress.json")
        steps: list[JsonObject]
        current_step: str | None = None
        run_status = str(envelope.get("runStatus") or "incomplete")
        failed_step: str | None = None
        updated_at: str | None = None
        if live_steps:
            steps = live_steps
            for entry in steps:
                if entry.get("status") == "running":
                    current_step = entry.get("name")
                if entry.get("status") == "failed" and failed_step is None:
                    failed_step = entry.get("name")
        elif isinstance(persisted, dict):
            persisted_steps = persisted.get("steps")
            steps = [entry for entry in persisted_steps if isinstance(entry, dict)] if isinstance(persisted_steps, list) else []
            current_step = persisted.get("currentStep")
            failed_step = persisted.get("failedStep")
            run_status = str(persisted.get("runStatus") or run_status)
            updated_at = str(persisted.get("updatedAt") or "") or None
        else:
            steps = []
        completed_steps = [entry["name"] for entry in steps if entry.get("status") == "ok" and entry.get("name")]
        missing = [] if steps else ["run-progress"]
        return {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "runStatus": run_status,
            "currentStep": current_step,
            "failedStep": failed_step,
            "completedSteps": completed_steps,
            "stepCount": len(steps),
            "steps": steps,
            "progressRef": persisted_meta,
            "updatedAt": updated_at,
        }

    def _learning_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        """Issue #96: expose the experience-learning summary for the run.

        Pulls live data from the experience-learning-service when configured
        and caches a copy under `learning-summary.json` so the artifact is
        available for the Evidence Pack consumer even when EL is offline.
        """
        learning = getattr(self.runner, "experience_learning", None)
        live_summary: JsonObject | None = None
        endpoint = ""
        if isinstance(learning, ExperienceLearningGateway):
            fetched = learning.get_run_summary(run_id)
            if fetched is not None:
                live_summary = dict(fetched)
            endpoint = learning.summary_uri(run_id)
        if live_summary is not None:
            try:
                self.artifact_store.write_json(
                    run_id,
                    str(envelope.get("workflowId") or self.config.workflow_id),
                    "learning-summary.json",
                    live_summary,
                    kind=KIND_LEARNING_SUMMARY,
                )
            except Exception:  # pragma: no cover - persistence is best-effort
                pass
        cached = self.artifact_store.read_json(run_id, "learning-summary.json")
        cached_meta = self.artifact_store.find_metadata(run_id, "learning-summary.json")
        summary = live_summary if live_summary is not None else (cached if isinstance(cached, dict) else None)
        missing = [] if summary is not None else ["learning-summary"]
        return {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "summary": summary,
            "summaryRef": cached_meta,
            "endpoint": endpoint,
            "source": "live" if live_summary is not None else ("cached" if cached is not None else "unavailable"),
        }

    def _traceability_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        """Studio-IDE-6 (#248): per-run trust-pillar traceability payload.

        Combines the deterministic generator's ``c2c-trace.json`` (passed
        through verbatim), the semantic IR's symbol map (so consumers can
        resolve an IR node to its COBOL file + line), and the per-file
        Java region classification computed by the orchestrator at run
        finalisation. Missing components surface as ``null`` / empty
        objects rather than as a 5xx so a run that hasn't reached
        ``STATE_JAVA_CANDIDATE_PERSISTED`` still serves a well-formed
        response.
        """
        # Prefer the live in-memory contract (covers runs that haven't
        # been flushed to disk yet) and fall back to the persisted
        # snapshot so old runs still serve a value.
        live_contract = self.runner.workflow_contract_payload(run_id)
        cached_contract = self.artifact_store.read_json(run_id, "w02-run-contract.json")
        contract = live_contract if live_contract is not None else (
            cached_contract if isinstance(cached_contract, dict) else None
        )

        classification_raw: JsonObject | None = None
        if isinstance(contract, dict):
            value = contract.get("javaRegionClassification")
            if isinstance(value, dict):
                classification_raw = value

        program_id = str(envelope.get("programId") or "")
        if not program_id and isinstance(contract, dict):
            source_ref = contract.get("sourceRef")
            if isinstance(source_ref, dict):
                program_id = str(source_ref.get("programId") or program_id)

        # Resolve the COBOL source filename. Prefer an explicit hint on
        # the source ref so cross-platform paths round-trip; fall back to
        # the program-id convention otherwise (documented in the helper).
        source_filename_hint: str | None = None
        if isinstance(contract, dict):
            source_ref = contract.get("sourceRef")
            if isinstance(source_ref, dict):
                raw_hint = source_ref.get("cobolSourcePath")
                if isinstance(raw_hint, str) and raw_hint:
                    # Use just the basename so the path doesn't leak the
                    # orchestrator's filesystem layout.
                    source_filename_hint = PurePosixPath(raw_hint.replace("\\", "/")).name

        trace = self.artifact_store.read_json(
            run_id, "generated-project/src/main/resources/c2c-trace.json"
        )
        ir = self.artifact_store.read_json(run_id, "semantic-ir.json")

        # Build the per-region classification view by passing the
        # already-validated contract value through; the orchestrator does
        # not recompute it here so the route is idempotent and reflects
        # exactly what the contract holds.
        classification: dict[str, list[JsonObject]] | None
        if classification_raw is None:
            classification = None
        else:
            classification = {
                str(path): [
                    dict(region) for region in regions if isinstance(region, Mapping)
                ]
                for path, regions in classification_raw.items()
                if isinstance(regions, list)
            }

        view = region_classification.build_traceability_view(
            run_id=run_id,
            program_id=program_id,
            trace=trace,
            ir=ir,
            classification=classification,
            source_filename_hint=source_filename_hint,
        )
        return view

    def _workflow_contract_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        """Issue #166: expose the W0.2 run contract for BFF/UI/agent consumers.

        Prefers the in-memory snapshot held by the runner (always up-to-date
        while the run is active) and falls back to the persisted
        ``w02-run-contract.json`` artifact for runs that have already left
        memory.
        """
        live = self.runner.workflow_contract_payload(run_id)
        cached = self.artifact_store.read_json(run_id, "w02-run-contract.json")
        cached_meta = self.artifact_store.find_metadata(run_id, "w02-run-contract.json")
        contract = live if live is not None else (cached if isinstance(cached, dict) else None)
        missing: list[str] = [] if contract is not None else ["w02-run-contract"]
        return {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "contract": contract,
            "contractRef": cached_meta,
            "source": "live" if live is not None else ("cached" if cached is not None else "unavailable"),
        }

    def _events_view(self, run_id: str, envelope: JsonObject) -> JsonObject:
        ledger = self.artifact_store.read_json(run_id, "trajectory-ledger.json")
        ledger_meta = self.artifact_store.find_metadata(run_id, "trajectory-ledger.json")
        events: list[JsonObject] = []
        if isinstance(ledger, dict):
            raw_events = ledger.get("events")
            if isinstance(raw_events, list):
                events = [entry for entry in raw_events if isinstance(entry, dict)]
        missing = [] if ledger is not None else ["trajectory-ledger"]
        return {
            **envelope,
            "status": "incomplete" if missing else "complete",
            "missingArtifacts": missing,
            "events": events,
            "trajectoryRef": ledger_meta,
        }

    def _run_state(self, run_id: str) -> JsonObject | None:
        try:
            return self.runner.gateway.get_run(run_id)
        except HarnessFailure as exc:
            if exc.status == 404:
                return None
            raise UpstreamServiceError("harness run status unavailable") from exc
        except HttpClientError as exc:
            if "failed with 404" in str(exc):
                return None
            raise UpstreamServiceError("harness run status unavailable") from exc
        except Exception as exc:
            raise UpstreamServiceError("harness run status unavailable") from exc

    def _runs_list(self) -> list[JsonObject]:
        try:
            list_response = self.runner.gateway.http.get_json(f"{self.runner.gateway.base_url}/v0/runs")
            if isinstance(list_response.payload, list):
                return list_response.payload
        except Exception as exc:
            raise UpstreamServiceError("harness run list unavailable") from exc
        return []

    def _start_run(self, payload: JsonObject) -> tuple[int, JsonObject]:
        input_ref = payload.get("inputRef")
        if not isinstance(input_ref, dict):
            raise ValueError("inputRef is required and must be an object")
        if "uri" not in input_ref:
            raise ValueError("inputRef.uri is required")

        requester = str(payload.get("requester", self.config.service_name)).strip() or self.config.service_name
        evidence_refs = payload.get("evidenceRefs")
        if evidence_refs is None:
            evidence_refs = []
        elif not isinstance(evidence_refs, list):
            raise ValueError("evidenceRefs must be an array")
        for entry in evidence_refs:
            if not isinstance(entry, str):
                raise ValueError("evidenceRefs may only contain strings")
        model_prompt = payload.get("modelPrompt")
        if model_prompt is not None and not isinstance(model_prompt, str):
            raise ValueError("modelPrompt must be a string")
        execution_mode_raw = payload.get("executionMode", EXECUTION_MODE_STANDARD)
        if not isinstance(execution_mode_raw, str):
            raise ValueError("executionMode must be a string")
        execution_mode = execution_mode_raw.strip().lower() or EXECUTION_MODE_STANDARD
        if execution_mode not in {EXECUTION_MODE_STANDARD, EXECUTION_MODE_PARITY}:
            raise ValueError("executionMode must be standard or parity")
        fixture_id_raw = payload.get("sourceReferenceFixtureId")
        trust_case_id_raw = payload.get("trustCaseId")
        reference_mode_raw = payload.get("sourceReferenceMode")
        fixture_id = ""
        if isinstance(fixture_id_raw, str) and fixture_id_raw.strip():
            fixture_id = fixture_id_raw.strip()
        elif fixture_id_raw is not None:
            raise ValueError("sourceReferenceFixtureId must be a string")
        trust_case_id = ""
        if isinstance(trust_case_id_raw, str) and trust_case_id_raw.strip():
            trust_case_id = trust_case_id_raw.strip()
        elif trust_case_id_raw is not None:
            raise ValueError("trustCaseId must be a string")
        if reference_mode_raw is None:
            reference_mode = REFERENCE_MODE_REFERENCE_FIXTURE
        elif isinstance(reference_mode_raw, str):
            reference_mode = reference_mode_raw.strip().lower()
        else:
            raise ValueError("sourceReferenceMode must be a string")
        if reference_mode not in {REFERENCE_MODE_REFERENCE_FIXTURE, REFERENCE_MODE_NATIVE_COBOL}:
            raise ValueError("sourceReferenceMode must be reference-fixture or native-cobol")
        parity_mode = execution_mode == EXECUTION_MODE_PARITY or bool(fixture_id or trust_case_id)
        if parity_mode:
            execution_mode = EXECUTION_MODE_PARITY
            if not fixture_id:
                raise ValueError("sourceReferenceFixtureId is required for parity runs")
            if not trust_case_id:
                trust_case_id = fixture_id
        # Issue #169: optional opt-in for the productive Transformation
        # Agent. Defaults to ``False`` so existing W0 deterministic-only
        # callers retain their behaviour.
        use_transformation_agent_raw = payload.get("useTransformationAgent", False)
        if isinstance(use_transformation_agent_raw, str):
            use_transformation_agent = use_transformation_agent_raw.strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        elif isinstance(use_transformation_agent_raw, bool):
            use_transformation_agent = use_transformation_agent_raw
        elif use_transformation_agent_raw is None:
            use_transformation_agent = False
        else:
            raise ValueError("useTransformationAgent must be a boolean")
        # Issue #255 / Studio-IDE-13: optional ``generateOnly`` flag.
        # When ``True`` the orchestrator stops after the generate-java
        # step (build/test/oracle are skipped) and finalises the run
        # with the ``generate_only_complete`` failure code. Defaults to
        # ``False`` so existing /api/v0/transform callers preserve the
        # composed Generate & Verify pipeline.
        generate_only_raw = payload.get("generateOnly", False)
        if isinstance(generate_only_raw, str):
            generate_only = generate_only_raw.strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        elif isinstance(generate_only_raw, bool):
            generate_only = generate_only_raw
        elif generate_only_raw is None:
            generate_only = False
        else:
            raise ValueError("generateOnly must be a boolean")
        # ADR 0007 §5 / Issue #280: optional ``manualOverlay`` carries
        # the per-region manual-edit provenance from Studio so the
        # Verification/Repair Agent honours the assist-interaction rule
        # on re-runs that follow a manual edit. The wire shape mirrors
        # the evidence-pack ``manualEditOverlay`` artifact: an
        # ``{"schemaVersion": "v0", "regions": [...]}`` envelope OR a
        # bare ``regions`` array. Only the closed-set ``manual_modified``
        # and ``manual_edit`` classes are accepted; anything else is
        # rejected before the orchestrator commits to a run.
        manual_overlay_regions = _extract_manual_overlay_regions(
            payload.get("manualOverlay")
        )

        run = self.runner.gateway.create_run(
            self.config.workflow_id,
            requester=requester,
            evidence_refs=evidence_refs,
        )
        run_id = str(run.get("runId", "")).strip()
        if not run_id:
            raise ValueError("harness returned invalid run")

        context = W0RunContext(
            run_id=run_id,
            workflow_id=self.config.workflow_id,
            requester=requester,
            evidence_refs=[str(value) for value in evidence_refs],
            model_prompt=str(model_prompt).strip() if model_prompt else None,
            execution_mode=execution_mode,
            trust_case_id=trust_case_id or None,
            source_reference_fixture_id=fixture_id or None,
            source_reference_mode=reference_mode if parity_mode else None,
            use_transformation_agent=use_transformation_agent,
            generate_only=generate_only,
            manual_overlay_regions=manual_overlay_regions,
        )

        thread = threading.Thread(
            target=self._execute_run,
            kwargs={"context": context, "input_ref": input_ref},
            daemon=True,
        )
        thread.start()

        return 201, {
            "run": run,
            "status": "started",
            "message": "orchestrator run started",
        }

    def _execute_run(self, context: W0RunContext, input_ref: JsonObject) -> None:
        try:
            self.runner.run(context=context, input_ref=input_ref)
        except Exception as exc:  # pragma: no cover - asynchronous runtime error path
            self.logger.warning("run execution failed: run=%s err=%s", context.run_id, exc)


def create_http_server(
    config: OrchestratorConfig,
    runner: W0WorkflowRunner,
    *,
    host: str = "0.0.0.0",
    port: int = 8084,
    artifact_store: RunArtifactStore | None = None,
) -> HTTPServer:
    service = OrchestratorService(config, runner, artifact_store=artifact_store)
    server = HTTPServer((host, port), service.handler_factory())
    return server


def create_configured_server(config: OrchestratorConfig) -> tuple[HTTPServer, W0WorkflowRunner]:
    harness_headers = {}
    if config.harness_token:
        harness_headers = {
            "Authorization": f"Bearer {config.harness_token}",
            "X-Harness-Actor": config.service_name,
            "X-Harness-Role": "orchestrator",
        }
    http_client = JSONHTTPClient(timeout_seconds=config.request_timeout_seconds)
    capability_headers = {}
    if config.capability_control_token:
        capability_headers = {"Authorization": f"Bearer {config.capability_control_token}"}
    gateway = HarnessGateway(
        config.harness_base_url,
        http_client,
        harness_headers=harness_headers,
        capability_headers=capability_headers,
    )
    _register_capabilities_with_harness(config=config, gateway=gateway)
    artifact_store = RunArtifactStore(config.run_artifact_root, created_by=config.service_name)
    experience_learning: ExperienceLearningGateway | NullExperienceLearningGateway
    if config.experience_learning_base_url:
        experience_learning = ExperienceLearningGateway(
            config.experience_learning_base_url,
            http_client,
        )
    else:
        experience_learning = NullExperienceLearningGateway()
    runner = W0WorkflowRunner(
        config=config,
        gateway=gateway,
        artifact_store=artifact_store,
        experience_learning=experience_learning,
    )
    host, port = _split_listen_address(config.listen_addr)
    server = create_http_server(
        config=config,
        runner=runner,
        host=host,
        port=port,
        artifact_store=artifact_store,
    )
    return server, runner


def _split_listen_address(listen_addr: str) -> tuple[str, int]:
    if ":" not in listen_addr:
        raise ValueError("listen address must include host and port")
    host, port_text = listen_addr.rsplit(":", 1)
    if not host:
        host = "0.0.0.0"
    try:
        port = int(port_text)
    except ValueError as exc:
        raise ValueError(f"invalid port: {port_text}") from exc
    if not (0 <= port <= 65535):
        raise ValueError("port must be between 0 and 65535")
    return host, port


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="run orchestrator service")
    parser.parse_args()
    config = load_config()
    server, _runner = create_configured_server(config=config)
    try:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
        logging.getLogger(__name__).info("orchestrator-service listening on %s", config.listen_addr)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
