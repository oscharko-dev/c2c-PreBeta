"""Integration test for orchestrator HTTP API and mocked Harness behavior."""

from __future__ import annotations

import json
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.server import create_configured_server


class MockHarnessState:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.runs: dict[str, dict] = {}
        self.events: list[dict] = []
        self.run_sequence = 0
        self.capability_invocations: list[tuple[str, dict]] = []
        self.pause_parse_seconds = 0.0
        self.fail_run_reads = False
        self.fail_run_list = False

        self.capabilities = {
            "cobol.parse": {
                "id": "cobol.parse",
                "owner": "parser-service",
                "endpoint": f"http://{host}:{port}/caps/parse",
            },
            "cobol.ir": {
                "id": "cobol.ir",
                "owner": "ir-service",
                "endpoint": f"http://{host}:{port}/caps/ir",
            },
            "java.generator": {
                "id": "java.generator",
                "owner": "generator-service",
                "endpoint": f"http://{host}:{port}/caps/generator",
            },
            "java.build-test": {
                "id": "java.build-test",
                "owner": "build-service",
                "endpoint": f"http://{host}:{port}/caps/build-test",
            },
            "evidence.writer": {
                "id": "evidence.writer",
                "owner": "evidence-service",
                "endpoint": f"http://{host}:{port}/caps/evidence",
            },
            "model-gateway": {
                "id": "model-gateway",
                "owner": "model-service",
                "endpoint": f"http://{host}:{port}/caps/model-gateway",
            },
        }

    def next_run_id(self) -> str:
        self.run_sequence += 1
        return f"run-{self.run_sequence}"


class MockHarnessHandler(BaseHTTPRequestHandler):
    state: MockHarnessState

    def _write_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        size = int(self.headers.get("Content-Length", "0") or "0")
        if size <= 0:
            return {}
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def _path_parts(self) -> list[str]:
        return [segment for segment in urlparse(self.path).path.split("/") if segment]

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        parts = self._path_parts()
        if len(parts) == 2 and parts[0] == "v0" and parts[1] == "runs":
            if self.state.fail_run_list:
                self._write_json(503, {"error": "harness unavailable"})
                return
            self._write_json(200, list(self.state.runs.values()))
            return
        if len(parts) == 3 and parts[0] == "v0" and parts[1] == "runs":
            if self.state.fail_run_reads:
                self._write_json(503, {"error": "harness unavailable"})
                return
            run_id = parts[2]
            if run_id not in self.state.runs:
                self._write_json(404, {"error": "run not found"})
                return
            self._write_json(200, self.state.runs[run_id])
            return
        if len(parts) == 3 and parts[0] == "v0" and parts[1] == "capabilities":
            capability = self.state.capabilities.get(parts[2])
            if capability is None:
                self._write_json(404, {"error": "capability not found"})
                return
            self._write_json(200, capability)
            return
        self._write_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        parts = self._path_parts()
        if parts == ["v0", "runs"]:
            payload = self._read_json()
            run_id = self.state.next_run_id()
            run = {
                "runId": run_id,
                "workflowId": payload.get("workflowId", "w0-migration-v0"),
                "status": "starting",
                "evidenceRefs": list(payload.get("evidenceRefs", [])),
                "message": "",
                "updatedBy": payload.get("requester", "orchestrator"),
                "policyDecision": "policy allow",
            }
            self.state.runs[run_id] = run
            self._write_json(201, run)
            return
        if parts == ["v0", "events"]:
            event = self._read_json()
            self.state.events.append(event)
            self._write_json(201, {"eventId": f"evt-{len(self.state.events)}"})
            return
        if parts[:1] == ["caps"]:
            capability = parts[1] if len(parts) > 1 else ""
            payload = self._read_json()
            self.state.capability_invocations.append((capability, payload))
            if capability == "parse":
                if self.state.pause_parse_seconds > 0:
                    time.sleep(self.state.pause_parse_seconds)
                self._write_json(200, {"irRef": {"uri": "urn:test/ir"}})
            elif capability == "ir":
                self._write_json(200, {"irRef": {"uri": "urn:test/normalized-ir"}})
            elif capability == "generator":
                self._write_json(200, {"javaRef": {"uri": "urn:test/compiled.java"}})
            elif capability == "build-test":
                self._write_json(200, {"status": "ok", "buildOutcome": "compile"})
            elif capability == "evidence":
                self._write_json(200, {"evidenceRef": {"uri": "urn:test/evidence"}})
            elif capability == "model-gateway":
                self._write_json(200, {"status": "ok", "advice": "Use standard profile."})
            else:
                self._write_json(404, {"error": "unknown capability"})
            return
        self._write_json(404, {"error": "not found"})

    def do_PATCH(self) -> None:
        parts = self._path_parts()
        if len(parts) == 3 and parts[0] == "v0" and parts[1] == "runs":
            run_id = parts[2]
            if run_id not in self.state.runs:
                self._write_json(404, {"error": "run not found"})
                return
            payload = self._read_json()
            run = self.state.runs[run_id]
            for key, value in payload.items():
                if key == "evidenceRefs":
                    run[key] = list(value)
                else:
                    run[key] = value
            self._write_json(200, run)
            return
        self._write_json(404, {"error": "not found"})


def _start_server(handler_cls) -> tuple[HTTPServer, int, threading.Thread]:
    server = HTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_port, thread


class OrchestratorIntegrationTests(unittest.TestCase):
    def _create_orchestrator(self, host: str, mock_port: int):
        config = OrchestratorConfig(
            listen_addr=f"{host}:0",
            harness_base_url=f"http://{host}:{mock_port}",
            workflow_id="w0-migration-v0",
            max_retries=0,
            retry_delay_ms=1,
            request_timeout_seconds=2,
            parse_capability_id="cobol.parse",
            ir_capability_id="cobol.ir",
            generator_capability_id="java.generator",
            build_test_capability_id="java.build-test",
            evidence_capability_id="evidence.writer",
            model_gateway_capability_id="model-gateway",
        )
        return create_configured_server(config)

    def test_run_is_executed_and_status_becomes_completed(self):
        mock_server, mock_port, mock_thread = _start_server(MockHarnessHandler)
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            MockHarnessHandler.state = state

            orchestrator_server, _runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            orchestrator_thread = threading.Thread(target=orchestrator_server.serve_forever, daemon=True)
            orchestrator_thread.start()

            payload = {
                "requester": "integration",
                "inputRef": {"uri": "urn:integration/main.cob"},
            }
            status_response = None
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    "/v0/runs",
                    body=json.dumps(payload),
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                response_body = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            run_id = response_body["run"]["runId"]
            status = ""
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{run_id}")
                    status_response = connection.getresponse()
                    run_state = json.loads(status_response.read().decode("utf-8"))
                    status = run_state.get("status", "")
                finally:
                    connection.close()
                if status in {"completed", "failed"}:
                    break
                time.sleep(0.05)

            self.assertEqual(status, "completed")
            assert status_response is not None
            self.assertEqual(status_response.status, 200)
            self.assertEqual(
                sorted(capability for capability, _ in state.capability_invocations),
                ["build-test", "evidence", "generator", "ir", "parse"],
            )
            self.assertGreaterEqual(len(state.events), 5)
            self.assertGreater(len(run_state.get("evidenceRefs", [])), 0)
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            try:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()
            except UnboundLocalError:
                pass

    def test_run_status_is_visible_while_workflow_is_in_flight(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.pause_parse_seconds = 0.25
            MockHarnessHandler.state = state
            orchestrator_server, _ = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    "/v0/runs",
                    body=json.dumps({"requester": "integration", "inputRef": {"uri": "urn:integration/main.cob"}}),
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()
            time.sleep(0.05)
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", f"/v0/runs/{run_id}")
                mid_response = connection.getresponse()
                run_state = json.loads(mid_response.read().decode("utf-8"))
                self.assertEqual(mid_response.status, 200)
                self.assertIn(run_state.get("status"), {"starting", "updating", "completed"})
            finally:
                connection.close()
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            try:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()
            except UnboundLocalError:
                pass

    def test_status_endpoints_return_503_when_harness_is_unavailable(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.fail_run_list = True
            state.fail_run_reads = True
            MockHarnessHandler.state = state
            orchestrator_server, _ = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", "/v0/runs")
                list_response = connection.getresponse()
                self.assertEqual(list_response.status, 503)
            finally:
                connection.close()
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", "/v0/runs/run-1")
                run_response = connection.getresponse()
                self.assertEqual(run_response.status, 503)
            finally:
                connection.close()
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            try:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()
            except UnboundLocalError:
                pass


if __name__ == "__main__":
    unittest.main()
