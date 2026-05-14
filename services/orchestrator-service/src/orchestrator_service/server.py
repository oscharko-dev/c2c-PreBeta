"""HTTP API for orchestrator service."""

from __future__ import annotations

import json
import logging
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

from .artifacts import (
    KIND_BUILD_TEST_RESULT,
    KIND_EVIDENCE_PACK_MANIFEST,
    KIND_GENERATED_PROJECT_FILE,
    KIND_GENERATED_PROJECT_MANIFEST,
    KIND_GENERATION_RESPONSE,
    KIND_MODEL_INVOCATION_LEDGER,
    KIND_MODEL_POLICY_SKIPPED,
    KIND_TRAJECTORY_LEDGER,
    MIME_JAVA,
    MIME_PLAIN,
    RunArtifactStore,
)
from .client import JSONHTTPClient
from .config import OrchestratorConfig, load_config
from .client import HttpClientError
from .harness import HarnessFailure, HarnessGateway
from .workflow import W0RunContext, W0WorkflowRunner


class UpstreamServiceError(Exception):
    """Raised when Harness cannot be reached or returns an invalid upstream result."""


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
        artifact_store: Optional[RunArtifactStore] = None,
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

            def _route_parts(self) -> List[str]:
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
                    if len(parts) == 2 and parts[0] == "v0" and parts[1] == "runs":
                        payload = self._read_json()
                        status_code, response_body = service._start_run(payload)
                        self._write_json(status_code, response_body)
                        return
                    self._write_json(404, {"error": "not found"})
                except json.JSONDecodeError:
                    self._write_json(400, {"error": "invalid JSON body"})
                except ValueError as exc:
                    self._write_json(400, {"error": str(exc)})
                except Exception as exc:
                    service.logger.error("POST handling failed", exc_info=exc)
                    self._write_json(500, {"error": "internal server error"})

            # noinspection PyPep8Naming
            def do_PATCH(self) -> None:
                self._write_json(405, {"error": "method not allowed"})

            def log_message(self, fmt: str, *args: object) -> None:
                return

        return RequestHandler

    def _artifact_endpoint(self, run_id: str, action: str) -> Tuple[int, Dict[str, Any]]:
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
        return 404, {"error": "not found"}

    def _artifact_payload(
        self,
        run_id: str,
        envelope: Dict[str, Any],
        *,
        relpath: str,
        kind: str,
        missing_label: str,
    ) -> Dict[str, Any]:
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

    def _generated_artifact_ref(self, run_id: str) -> Optional[Dict[str, Any]]:
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

    def _generated_view(self, run_id: str, envelope: Dict[str, Any]) -> Dict[str, Any]:
        response = self.artifact_store.read_json(run_id, "generation-response.json")
        response_meta = self.artifact_store.find_metadata(run_id, "generation-response.json")
        manifest = self.artifact_store.read_json(run_id, "generated-project-manifest.json")
        manifest_meta = self.artifact_store.find_metadata(run_id, "generated-project-manifest.json")
        file_metas = self.artifact_store.find_by_kind(run_id, KIND_GENERATED_PROJECT_FILE)
        files: Dict[str, str] = {}
        file_refs: List[Dict[str, Any]] = []
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
        missing: List[str] = []
        if response is None:
            missing.append("generation-response")
        if not files:
            missing.append("generated-project")
        if manifest is None and files:
            missing.append("generated-project-manifest")
        generated_project: Dict[str, Any] = {}
        if isinstance(response, dict):
            project = response.get("generatedProject")
            if isinstance(project, dict):
                generated_project = project
        manifest_traceability: Dict[str, Any] = {}
        if isinstance(manifest, dict):
            traceability = manifest.get("traceability")
            if isinstance(traceability, dict):
                manifest_traceability = traceability
        artifact_ref: Optional[Dict[str, Any]] = None
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
    def _safe_generated_relpath(raw: str) -> Optional[str]:
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

    def _generated_files_index(self, run_id: str) -> Tuple[int, Dict[str, Any]]:
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
        file_refs: List[Dict[str, Any]] = []
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
        missing: List[str] = []
        if not file_refs:
            missing.append("generated-project")
        if manifest is None and file_refs:
            missing.append("generated-project-manifest")
        artifact_ref: Optional[Dict[str, Any]] = None
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

    def _generated_file_content(self, run_id: str, raw_path: str) -> Tuple[int, Dict[str, Any]]:
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

    def _events_view(self, run_id: str, envelope: Dict[str, Any]) -> Dict[str, Any]:
        ledger = self.artifact_store.read_json(run_id, "trajectory-ledger.json")
        ledger_meta = self.artifact_store.find_metadata(run_id, "trajectory-ledger.json")
        events: List[Dict[str, Any]] = []
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

    def _run_state(self, run_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self.runner.gateway.get_run(run_id)
        except Exception as exc:
            if "404" in str(exc):
                return None
            raise UpstreamServiceError("harness run status unavailable") from exc

    def _runs_list(self) -> List[Dict[str, Any]]:
        try:
            list_response = self.runner.gateway.http.get_json(f"{self.runner.gateway.base_url}/v0/runs")
            if isinstance(list_response.payload, list):
                return list_response.payload
        except Exception as exc:
            raise UpstreamServiceError("harness run list unavailable") from exc
        return []

    def _start_run(self, payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
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

    def _execute_run(self, context: W0RunContext, input_ref: Dict[str, Any]) -> None:
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
    artifact_store: Optional[RunArtifactStore] = None,
) -> HTTPServer:
    service = OrchestratorService(config, runner, artifact_store=artifact_store)
    server = HTTPServer((host, port), service.handler_factory())
    return server


def create_configured_server(config: OrchestratorConfig) -> Tuple[HTTPServer, W0WorkflowRunner]:
    harness_headers = {}
    if config.harness_token:
        harness_headers = {
            "Authorization": f"Bearer {config.harness_token}",
            "X-Harness-Actor": config.service_name,
            "X-Harness-Role": "orchestrator",
        }
    http_client = JSONHTTPClient(timeout_seconds=config.request_timeout_seconds)
    gateway = HarnessGateway(config.harness_base_url, http_client, harness_headers=harness_headers)
    _register_capabilities_with_harness(config=config, gateway=gateway)
    artifact_store = RunArtifactStore(config.run_artifact_root, created_by=config.service_name)
    runner = W0WorkflowRunner(config=config, gateway=gateway, artifact_store=artifact_store)
    host, port = _split_listen_address(config.listen_addr)
    server = create_http_server(
        config=config,
        runner=runner,
        host=host,
        port=port,
        artifact_store=artifact_store,
    )
    return server, runner


def _split_listen_address(listen_addr: str) -> Tuple[str, int]:
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
