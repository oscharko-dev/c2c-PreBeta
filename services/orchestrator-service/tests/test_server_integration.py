"""Integration test for orchestrator HTTP API and mocked Harness behavior."""

from __future__ import annotations

import json
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
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
        self.capability_registrations: list[dict] = []
        self.pause_parse_seconds = 0.0
        self.fail_run_reads = False
        self.fail_run_list = False
        self.fail_capability_registration = False
        self.ledgers: dict[str, dict] = {}

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

    # noinspection PyPep8Naming
    def do_GET(self) -> None:
        parts = self._path_parts()
        if len(parts) == 2 and parts[0] == "v0" and parts[1] == "runs":
            if self.state.fail_run_list:
                self._write_json(503, {"error": "harness unavailable"})
                return
            self._write_json(200, list(self.state.runs.values()))
            return
        if len(parts) == 4 and parts[0] == "v0" and parts[1] == "runs" and parts[3] == "ledger":
            if self.state.fail_run_reads:
                self._write_json(503, {"error": "harness unavailable"})
                return
            run_id = parts[2]
            if run_id not in self.state.runs:
                self._write_json(404, {"error": "run not found"})
                return
            self._write_json(200, self.state.ledgers.get(run_id, {"runId": run_id, "events": []}))
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

    # noinspection PyPep8Naming
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
            self.state.ledgers[run_id] = {"runId": run_id, "events": []}
            self._write_json(201, run)
            return
        if parts == ["v0", "events"]:
            event = self._read_json()
            self.state.events.append(event)
            self._write_json(201, {"eventId": f"evt-{len(self.state.events)}"})
            return
        if parts == ["v0", "capabilities"]:
            payload = self._read_json()
            if self.state.fail_capability_registration:
                self._write_json(500, {"error": "capability registration backend unavailable"})
                return
            capability = payload.get("capability", {})
            capability_id = str(capability.get("id", "")).strip()
            if not capability_id:
                self._write_json(400, {"error": "capability id is required"})
                return
            if capability_id in self.state.runs:
                # keep shape close to harness behavior for duplicate registration
                self._write_json(400, {"error": f"capability {capability_id} already registered"})
                return
            if capability_id in (entry.get("id") for entry in self.state.capability_registrations):
                self._write_json(400, {"error": f"capability {capability_id} already registered"})
                return
            self.state.capability_registrations.append(capability)
            self._write_json(201, capability)
            return
        if parts[:1] == ["caps"]:
            capability = parts[1] if len(parts) > 1 else ""
            payload = self._read_json()
            self.state.capability_invocations.append((capability, payload))
            if capability == "parse":
                if self.state.pause_parse_seconds > 0:
                    time.sleep(self.state.pause_parse_seconds)
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "status": "ok",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "program": {
                            "programId": "CASE01",
                            "sourceHash": "a" * 64,
                        },
                        "sourceRef": {
                            "uri": "urn:source/main.cob",
                            "sha256": "a" * 64,
                            "byteSize": 12,
                        },
                        "outputRef": {"uri": "urn:parse-output"},
                    },
                )
            elif capability == "ir":
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "status": "ok",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "sourceRef": {
                            "uri": "urn:source/main.cob",
                            "sha256": "a" * 64,
                            "byteSize": 12,
                        },
                        "ir": {
                            "schemaVersion": "v0",
                            "programId": "CASE01",
                            "irId": "ir-CASE01",
                        },
                        "outputRef": {"uri": "urn:ir-output"},
                    },
                )
            elif capability == "generator":
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "status": "ok",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "sourceRef": {
                            "uri": "urn:source/main.cob",
                            "sha256": "a" * 64,
                            "byteSize": 12,
                        },
                        "generatedProject": {
                            "entryClass": "CASE01",
                            "entryFilePath": "src/CASE01.java",
                            "fileCount": 1,
                            "files": {"src/CASE01.java": "class CASE01 {}"},
                        },
                        "outputRef": {"uri": "urn:generated-java"},
                    },
                )
            elif capability == "build-test":
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "status": "ok",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "programId": "CASE01",
                        "outputRef": {"uri": "urn:build-output"},
                    },
                )
            elif capability == "evidence":
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "status": "complete",
                        "outputRef": {"uri": "urn:evidence"},
                    },
                )
            elif capability == "model-gateway":
                self._write_json(
                    200,
                    {
                        "invocationId": "mg-integration-1",
                        "runId": payload.get("runId", "run-unknown"),
                        "modelId": payload.get("modelId", "gpt-oss-120b"),
                        "provider": "foundry-development",
                        "promptTemplateVersion": payload.get("promptTemplateVersion", "v1"),
                        "status": "completed",
                        "latencyMs": 1,
                        "ledgerRef": {
                            "uri": "urn:model-gateway/invocations/mg-integration-1",
                            "sha256": "c" * 64,
                            "byteSize": 256,
                        },
                        "output": {"status": "completed"},
                    },
                )
            else:
                self._write_json(404, {"error": "unknown capability"})
            return
        self._write_json(404, {"error": "not found"})

    # noinspection PyPep8Naming
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
            if "status" in payload:
                if run_id in self.state.ledgers:
                    self.state.ledgers[run_id]["events"].append(
                        {
                            "runId": run_id,
                            "status": payload["status"],
                            "evidenceRefs": run.get("evidenceRefs", []),
                        }
                    )
            self._write_json(200, run)
            return
        self._write_json(404, {"error": "not found"})


def _start_server(handler_cls) -> tuple[HTTPServer, int, threading.Thread]:
    server = HTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_port, thread


class OrchestratorIntegrationTests(unittest.TestCase):
    @staticmethod
    def _create_orchestrator(host: str, mock_port: int):
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
            w0_capabilities=(
                {"id": "cobol.parse", "name": "COBOL Parser", "owner": "parser-service", "dataClass": "parser", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/parse"},
                {"id": "cobol.ir", "name": "Semantic IR", "owner": "ir-service", "dataClass": "generator", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/ir"},
                {"id": "java.generator", "name": "Target Java Generator", "owner": "generator-service", "dataClass": "generator", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/generator"},
                {"id": "java.build-test", "name": "Build Test", "owner": "build-service", "dataClass": "build-test", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/build-test"},
                {"id": "evidence.writer", "name": "Evidence Writer", "owner": "evidence-service", "dataClass": "evidence", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/evidence"},
                {"id": "model-gateway", "name": "Model Gateway", "owner": "model-gateway", "dataClass": "model-gateway", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/model-gateway"},
            ),
        )
        return create_configured_server(config)

    def test_run_is_executed_and_status_becomes_completed(self):
        mock_server, mock_port, mock_thread = _start_server(MockHarnessHandler)
        orchestrator_server: Optional[HTTPServer] = None
        run_state: dict = {}
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
                "modelPrompt": "Summarize safe migration considerations.",
                "inputRef": {
                    "uri": "urn:integration/main.cob",
                    "source": "IDENTIFICATION DIVISION.",
                },
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
                ["build-test", "evidence", "generator", "ir", "model-gateway", "parse"],
            )
            model_payload = next(
                payload for capability, payload in state.capability_invocations
                if capability == "model-gateway"
            )
            self.assertEqual(model_payload["modelId"], "gpt-oss-120b")
            self.assertEqual(model_payload["dataClass"], "model-gateway")
            evidence_payload = next(
                payload for capability, payload in state.capability_invocations
                if capability == "evidence"
            )
            model_invocation = evidence_payload["artifacts"]["modelInvocations"][0]
            self.assertEqual(model_invocation["status"], "completed")
            self.assertEqual(model_invocation["provider"], "foundry-development")
            self.assertEqual(model_invocation["ledgerRef"]["sha256"], "c" * 64)
            self.assertEqual(
                sorted(entry.get("id") for entry in state.capability_registrations),
                ["cobol.ir", "cobol.parse", "evidence.writer", "java.build-test", "java.generator", "model-gateway"],
            )
            self.assertGreaterEqual(len(state.events), 5)
            self.assertGreater(len(run_state.get("evidenceRefs", [])), 0)
            event_types = [event.get("eventType") for event in state.events]
            self.assertIn("orchestrator.workflow.accepted", event_types)
            self.assertIn("orchestrator.workflow.completed", event_types)
            self.assertNotIn("orchestrator.workflow.failed", event_types)
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_startup_tolerates_existing_capability_registrations(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: Optional[HTTPServer] = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.capability_registrations.extend(
                [
                    {
                        "id": "cobol.parse",
                        "name": "COBOL Parser",
                        "owner": "parser-service",
                        "endpoint": f"http://{host}:{mock_port}/caps/parse",
                    },
                    {
                        "id": "java.generator",
                        "name": "Target Java Generator",
                        "owner": "generator-service",
                        "endpoint": f"http://{host}:{mock_port}/caps/generator",
                    },
                ]
            )
            MockHarnessHandler.state = state

            orchestrator_server, _ = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "GET",
                    "/health",
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                health = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["service"], "orchestrator-service")
            self.assertEqual(len(state.capability_registrations), 6)
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_run_status_is_visible_while_workflow_is_in_flight(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: Optional[HTTPServer] = None
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
                    body=json.dumps(
                        {
                            "requester": "integration",
                            "inputRef": {
                                "uri": "urn:integration/main.cob",
                                "source": "IDENTIFICATION DIVISION.",
                            },
                        }
                    ),
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
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_status_endpoints_return_503_when_harness_is_unavailable(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: Optional[HTTPServer] = None
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
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()


if __name__ == "__main__":
    unittest.main()
