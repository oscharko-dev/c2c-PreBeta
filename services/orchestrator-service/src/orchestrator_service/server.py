"""HTTP API for orchestrator service."""

from __future__ import annotations

import json
import logging
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Optional

from .client import JSONHTTPClient
from .config import OrchestratorConfig, load_config
from .harness import HarnessGateway
from .workflow import W0RunContext, W0WorkflowRunner


class UpstreamServiceError(Exception):
    """Raised when Harness cannot be reached or returns an invalid upstream result."""


class OrchestratorService:
    """Small HTTP facade for asynchronous workflow execution."""

    def __init__(self, config: OrchestratorConfig, runner: W0WorkflowRunner):
        self.config = config
        self.runner = runner
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
                    self._write_json(404, {"error": "not found"})
                except Exception as exc:
                    if isinstance(exc, UpstreamServiceError):
                        self._write_json(503, {"error": str(exc)})
                        return
                    service.logger.error("GET handling failed", exc_info=exc)
                    self._write_json(500, {"error": "internal server error"})

            def do_POST(self) -> None:
                try:
                    parts = self._route_parts()
                    if len(parts) == 2 and parts[0] == "v0" and parts[1] == "runs":
                        payload = self._read_json()
                        service._start_run(self, payload)
                        return
                    self._write_json(404, {"error": "not found"})
                except json.JSONDecodeError:
                    self._write_json(400, {"error": "invalid JSON body"})
                except ValueError as exc:
                    self._write_json(400, {"error": str(exc)})
                except Exception as exc:
                    service.logger.error("POST handling failed", exc_info=exc)
                    self._write_json(500, {"error": "internal server error"})

            def do_PATCH(self) -> None:
                self._write_json(405, {"error": "method not allowed"})

            def log_message(self, fmt: str, *args: object) -> None:
                return

        return RequestHandler

    def _run_state(self, run_id: str) -> Optional[dict[str, Any]]:
        try:
            return self.runner.gateway.get_run(run_id)
        except Exception as exc:
            if "404" in str(exc):
                return None
            raise UpstreamServiceError("harness run status unavailable") from exc

    def _runs_list(self) -> list[dict[str, Any]]:
        try:
            list_response = self.runner.gateway.http.get_json(f"{self.runner.gateway.base_url}/v0/runs")
            if isinstance(list_response.payload, list):
                return list_response.payload
        except Exception as exc:
            raise UpstreamServiceError("harness run list unavailable") from exc
        return []

    def _start_run(self, request_handler: BaseHTTPRequestHandler, payload: dict[str, Any]) -> None:
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

        request_handler._write_json(
            201,
            {
                "run": run,
                "status": "started",
                "message": "orchestrator run started",
            },
        )

    def _execute_run(self, context: W0RunContext, input_ref: dict[str, Any]) -> None:
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
) -> HTTPServer:
    service = OrchestratorService(config, runner)
    server = HTTPServer((host, port), service.handler_factory())
    return server


def create_configured_server(config: OrchestratorConfig) -> tuple[HTTPServer, W0WorkflowRunner]:
    http_client = JSONHTTPClient(timeout_seconds=config.request_timeout_seconds)
    gateway = HarnessGateway(config.harness_base_url, http_client)
    runner = W0WorkflowRunner(config=config, gateway=gateway)
    host, port = _split_listen_address(config.listen_addr)
    return create_http_server(config=config, runner=runner, host=host, port=port), runner


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
