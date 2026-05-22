"""Integration test for orchestrator HTTP API and mocked Harness behavior."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from orchestrator_service.artifacts import (
    KIND_BUILD_TEST_RESULT,
    KIND_GENERATED_PROJECT_FILE,
    KIND_TRAJECTORY_LEDGER,
)
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.server import create_configured_server
import orchestrator_service.workflow as orchestrator_workflow


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
        self.build_test_responses: list[dict] = []
        self.model_gateway_responses: list[dict] = []

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
            "source-reference.execute": {
                "id": "source-reference.execute",
                "owner": "build-service",
                "endpoint": f"http://{host}:{port}/caps/source-reference",
            },
            "evidence.writer": {
                "id": "evidence.writer",
                "owner": "evidence-service",
                "endpoint": f"http://{host}:{port}/caps/evidence",
            },
            "model-gateway": {
                "id": "model-gateway",
                "owner": "model-gateway-service",
                "dataClass": "model-gateway",
                "endpoint": f"http://{host}:{port}/v0/invoke",
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
        if len(parts) == 2 and parts[0] == "v0" and parts[1] == "capabilities":
            self._write_json(
                200,
                {
                    "schema": "v0",
                    "service": "model-gateway",
                    "status": "ok",
                    "provider": "foundry-development",
                    "roles": [
                        {
                            "role": "verification-repair",
                            "status": "ok",
                            "availableModels": ["gpt-oss-120b"],
                            "configuredModels": ["gpt-oss-120b"],
                        }
                    ],
                },
            )
            return
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
        if parts[:1] == ["caps"] or parts == ["v0", "invoke"]:
            capability = "model-gateway" if parts == ["v0", "invoke"] else (parts[1] if len(parts) > 1 else "")
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
                response = (
                    self.state.build_test_responses.pop(0)
                    if self.state.build_test_responses
                    else {
                        "schemaVersion": "v0",
                        "status": "ok",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "programId": "CASE01",
                        "classification": "match",
                        "expectedOutput": "NORMALIZED-OUTPUT",
                        "comparisonResult": {
                            "matched": True,
                            "status": "matched",
                        },
                        "outputRef": {"uri": "urn:build-output"},
                    }
                )
                self._write_json(
                    200,
                    response,
                )
            elif capability == "source-reference":
                self._write_json(
                    200,
                    {
                        "schemaVersion": "v0",
                        "status": "passed",
                        "runId": payload.get("runId", "run-unknown"),
                        "workflowId": payload.get("workflowId", "w0-migration-v0"),
                        "fixtureId": payload.get("fixtureId", "HELLOW02"),
                        "referenceMode": payload.get("referenceMode", "reference-fixture"),
                        "executionResultRef": {"uri": "urn:source-reference/execution"},
                        "normalizedOutputRef": {
                            "uri": "urn:source-reference/normalized-output",
                        },
                        "outputRef": {"uri": "urn:source-reference/execution"},
                        "summary": "source/reference execution completed",
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
                response = (
                    self.state.model_gateway_responses.pop(0)
                    if self.state.model_gateway_responses
                    else {
                        "invocationId": "mg-integration-1",
                        "runId": payload.get("runId", "run-unknown"),
                        "modelId": payload.get("modelId", "gpt-oss-120b"),
                        "provider": "foundry-development",
                        "promptTemplateVersion": payload.get("promptTemplateVersion", "v1"),
                        "policyDecision": "policy allow",
                        "status": "completed",
                        "latencyMs": 1,
                        "ledgerRef": {
                            "uri": "urn:model-gateway/invocation/mg-integration-1",
                            "sha256": "c" * 64,
                            "byteSize": 256,
                        },
                        "output": {"status": "completed"},
                    }
                )
                self._write_json(
                    200,
                    response,
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


def _rmtree(path: str) -> None:
    import shutil
    shutil.rmtree(path, ignore_errors=True)


def _seed_manual_compile_repair_run(
    runner,
    *,
    run_id: str,
    program_id: str,
    java_path: str,
    java_source: str,
) -> None:
    workflow_id = "w0-migration-v0"
    runner.artifact_store.init_run(run_id, workflow_id, requester="integration")
    runner.artifact_store.update_summary(
        run_id,
        workflow_id,
        {
            "runId": run_id,
            "workflowId": workflow_id,
            "programId": program_id,
            "requester": "integration",
            "status": "completed",
        },
    )
    runner.artifact_store.write_text(
        run_id,
        workflow_id,
        f"generated-project/{java_path}",
        java_source,
        kind=KIND_GENERATED_PROJECT_FILE,
    )


def _stub_manual_compile_repair_artifact_refs(runner, *, run_id: str) -> None:
    runner._persist_manual_compile_baseline_diff = lambda *_args, **_kwargs: None


def _post_json(host: str, port: int, path: str, payload: dict, headers: dict) -> tuple[int, dict]:
    connection = HTTPConnection(host, port, timeout=3)
    try:
        connection.request(
            "POST",
            path,
            body=json.dumps(payload),
            headers=headers,
        )
        response = connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        connection.close()


def _post_manual_compile_repair_request(
    host: str,
    port: int,
    run_id: str,
    action: str,
    payload: dict,
    headers: dict,
) -> tuple[int, dict]:
    return _post_json(
        host,
        port,
        f"/v0/runs/{run_id}/manual-compile-repair/{action}/request",
        payload,
        headers,
    )


def _manual_compile_preview_request(
    *,
    run_id: str,
    entry_file_path: str,
    java_source: str,
    entry_class: str = "CASE01",
) -> dict:
    return {
        "runId": run_id,
        "entryClass": entry_class,
        "entryFilePath": entry_file_path,
        "javaFiles": [
            {
                "path": entry_file_path,
                "content": java_source,
            }
        ],
    }


def _request_manual_compile_preview(
    host: str,
    port: int,
    *,
    run_id: str,
    entry_file_path: str,
    java_source: str,
    headers: dict,
    entry_class: str = "CASE01",
) -> dict:
    status, body = _post_json(
        host,
        port,
        f"/v0/runs/{run_id}/manual-compile-repair/preview/request",
        _manual_compile_preview_request(
            run_id=run_id,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
            java_source=java_source,
        ),
        headers,
    )
    if status != 200:
        raise AssertionError(f"manual compile preview failed: {status} {body}")
    return body


class OrchestratorIntegrationTests(unittest.TestCase):
    CONTROL_TOKEN = "integration-control-token"
    AUTH_HEADERS = {"Authorization": f"Bearer {CONTROL_TOKEN}"}
    JSON_AUTH_HEADERS = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {CONTROL_TOKEN}",
    }

    def _create_orchestrator(self, host: str, mock_port: int):
        artifact_root = tempfile.mkdtemp(prefix="orchestrator-artifacts-")
        self.addCleanup(_rmtree, artifact_root)
        server, runner = self._create_orchestrator_with_root(host, mock_port, artifact_root)
        # expose for tests that want to inspect on-disk artifacts
        self._artifact_root = artifact_root
        return server, runner

    @staticmethod
    def _parity_mismatch_build_response(run_id: str = "run-ignored") -> dict:
        return {
            "schemaVersion": "v0",
            "status": "failed",
            "reason": "oracle_mismatch",
            "runId": run_id,
            "workflowId": "w0-migration-v0",
            "summary": "parity mismatch",
            "comparisonResultRef": {
                "uri": "urn:build/parity-comparison",
                "sha256": "4" * 64,
                "byteSize": 36,
            },
            "executionResultRef": {
                "uri": "urn:build/parity-execution",
                "sha256": "5" * 64,
                "byteSize": 28,
            },
            "parityComparison": {
                "status": "failed",
                "matched": False,
                "comparisonPolicyVersion": "deterministic-output-v1",
                "comparisonResultRef": {
                    "uri": "urn:build/parity-comparison",
                    "sha256": "4" * 64,
                    "byteSize": 36,
                },
                "executionResultRef": {
                    "uri": "urn:build/parity-execution",
                    "sha256": "5" * 64,
                    "byteSize": 28,
                },
                "sourceNormalizedRef": {
                    "uri": "urn:build/reference-output",
                    "sha256": "a" * 64,
                    "byteSize": 18,
                },
                "targetNormalizedRef": {
                    "uri": "urn:build/java-output",
                    "sha256": "b" * 64,
                    "byteSize": 18,
                },
                "diffRef": {
                    "uri": "urn:build/oracle-diff",
                    "sha256": "8" * 64,
                    "byteSize": 32,
                },
                "mismatchClassification": "content",
            },
            "oracleDiffRef": {
                "uri": "urn:build/oracle-diff",
                "sha256": "8" * 64,
                "byteSize": 32,
            },
        }

    def _seed_intentional_divergence_contract(
        self,
        runner,
        run_id: str,
    ) -> tuple[dict, dict]:
        live_contract = runner.workflow_contract(run_id)
        self.assertIsNotNone(live_contract)
        parity_response = self._parity_mismatch_build_response(run_id)
        contract_payload = live_contract.to_dict()
        contract_payload["parityComparison"] = parity_response["parityComparison"]
        contract_payload["intentionalDivergenceDecision"] = None
        contract_payload["intentionalDivergenceDecisionRef"] = None
        trust_summary = dict(live_contract.trust_summary or {})
        trust_summary["trustState"] = "parity_failed"
        trust_summary["divergenceDisposition"] = "unknown"
        trust_summary["comparisonResult"] = {
            **dict(trust_summary.get("comparisonResult") or {}),
            "status": "mismatched",
            "mismatchClassification": "content",
            "comparisonResultRef": parity_response["parityComparison"]["comparisonResultRef"],
            "diffRef": parity_response["parityComparison"]["diffRef"],
            "decisionRecordRef": None,
            "decisionStatus": "none",
        }
        live_contract.set_parity_comparison(parity_response["parityComparison"])
        live_contract.replace_trust_summary(trust_summary)
        contract_payload["trustSummary"] = trust_summary
        runner.artifact_store.write_json(
            run_id,
            contract_payload["workflowId"],
            "w02-run-contract.json",
            contract_payload,
            kind=orchestrator_workflow.KIND_W02_RUN_CONTRACT,
        )
        summary = runner.artifact_store.read_json(run_id, "run-summary.json")
        if isinstance(summary, dict):
            updated_summary = dict(summary)
            updated_summary["parityComparison"] = parity_response["parityComparison"]
            updated_summary["trustSummary"] = trust_summary
            runner.artifact_store.write_json(
                run_id,
                contract_payload["workflowId"],
                "run-summary.json",
                updated_summary,
                kind=orchestrator_workflow.KIND_RUN_SUMMARY,
            )
        with runner._contract_lock:
            runner._contracts_by_run.pop(run_id, None)
        return parity_response, trust_summary

    @staticmethod
    def _create_orchestrator_with_root(host: str, mock_port: int, artifact_root: str):
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
            source_reference_capability_id="source-reference.execute",
            build_test_capability_id="java.build-test",
            evidence_capability_id="evidence.writer",
            model_gateway_capability_id="model-gateway",
            control_token=OrchestratorIntegrationTests.CONTROL_TOKEN,
            capability_control_token=OrchestratorIntegrationTests.CONTROL_TOKEN,
            run_artifact_root=artifact_root,
            w0_capabilities=(
                {"id": "cobol.parse", "name": "COBOL Parser", "owner": "parser-service", "dataClass": "parser", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/parse"},
                {"id": "cobol.ir", "name": "Semantic IR", "owner": "ir-service", "dataClass": "generator", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/ir"},
                {"id": "java.generator", "name": "Target Java Generator", "owner": "generator-service", "dataClass": "generator", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/generator"},
                {"id": "source-reference.execute", "name": "Source Reference", "owner": "build-service", "dataClass": "build-test", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/source-reference"},
                {"id": "java.build-test", "name": "Build Test", "owner": "build-service", "dataClass": "build-test", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/build-test"},
                {"id": "evidence.writer", "name": "Evidence Writer", "owner": "evidence-service", "dataClass": "evidence", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/caps/evidence"},
                {"id": "model-gateway", "name": "Model Gateway", "owner": "model-gateway-service", "dataClass": "model-gateway", "policyProfile": "harness-control-plane", "version": "v0.1.0", "endpoint": f"http://{host}:{mock_port}/v0/invoke"},
            ),
        )
        return create_configured_server(config)

    def test_run_is_executed_and_status_becomes_completed(self):
        mock_server, mock_port, mock_thread = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        run_state: dict = {}
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
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
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
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
            self.assertEqual(model_invocation["policyDecision"], "policy allow")
            self.assertEqual(model_invocation["ledgerRef"]["sha256"], "c" * 64)
            self.assertEqual(
                sorted(entry.get("id") for entry in state.capability_registrations),
                [
                    "cobol.ir",
                    "cobol.parse",
                    "evidence.writer",
                    "java.build-test",
                    "java.generator",
                    "model-gateway",
                    "source-reference.execute",
                ],
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

    def test_manual_compile_repair_diagnose_apply_and_reject_cover_success_and_refusal_paths(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            prior_failure = {
                "schemaVersion": "v0",
                "status": "failed",
                "reason": "compile_failed",
                "runId": "manual-run-1",
                "workflowId": "w0-migration-v0",
                "summary": "compile failed",
                "diagnostics": [
                    {
                        "filePath": "src/main/java/com/c2c/generated/CASE01.java",
                        "message": "cannot find symbol",
                    }
                ],
            }
            sandbox_success = {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "manual-run-1",
                "workflowId": "w0-migration-v0",
                "programId": "CASE01",
                "outputRef": {"uri": "urn:build-output/manual-run-1"},
            }
            state.build_test_responses = [sandbox_success]
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-manual-1",
                    "runId": "manual-run-1",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-1",
                        "sha256": "f" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Fixed the missing semicolon.",
                        "files": {
                            "src/main/java/com/c2c/generated/CASE01.java": (
                                "package com.c2c.generated;\n"
                                "public class CASE01 {\n"
                                "    public static void main(String[] args) {\n"
                                "        System.out.println(\"repaired\");\n"
                                "    }\n"
                                "}\n"
                            )
                        },
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
                        "explanation": "Added the missing semicolon.",
                        "unsupportedConstructs": [],
                        "confidence": 0.92,
                    },
                },
                {
                    "invocationId": "mg-manual-1b",
                    "runId": "manual-run-1",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-1b",
                        "sha256": "e" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Fixed the missing semicolon.",
                        "files": {
                            "src/main/java/com/c2c/generated/CASE01.java": (
                                "package com.c2c.generated;\n"
                                "public class CASE01 {\n"
                                "    public static void main(String[] args) {\n"
                                "        System.out.println(\"repaired\");\n"
                                "    }\n"
                                "}\n"
                            )
                        },
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
                        "explanation": "Added the missing semicolon.",
                        "unsupportedConstructs": [],
                        "confidence": 0.92,
                    },
                },
            ]
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            current_java_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {\n"
                "        System.out.println(\"broken\")\n"
                "    }\n"
                "}\n"
            )
            _seed_manual_compile_repair_run(
                runner,
                run_id="manual-run-1",
                program_id="CASE01",
                java_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=current_java_source,
            )
            runner.artifact_store.write_json(
                "manual-run-1",
                "w0-migration-v0",
                "build-test-result.json",
                dict(prior_failure),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id="manual-run-1")
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            preview_body = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-1",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )
            diagnose_status, diagnose_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-1",
                    "previewId": preview_body["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(diagnose_status, 200)

            proposal = diagnose_body["proposal"]
            self.assertIsNotNone(proposal)
            self.assertEqual(diagnose_body["schemaVersion"], "v0")
            self.assertEqual(diagnose_body["runId"], "manual-run-1")
            self.assertEqual(diagnose_body["buildTest"]["status"], "failed")
            self.assertEqual(
                diagnose_body["diagnosis"]["failureClass"],
                "generated_code_defect",
            )
            self.assertEqual(
                diagnose_body["diagnosis"]["recommendedNextAction"],
                "repair_generated_code",
            )
            self.assertEqual(diagnose_body["candidateProject"]["entryClass"], "CASE01")
            self.assertEqual(
                state.capability_invocations[-1][0],
                "model-gateway",
            )

            reject_status, reject_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/reject/request",
                {
                    "runId": "manual-run-1",
                    "proposalId": proposal["proposalId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(reject_status, 200)
            self.assertEqual(reject_body["proposal"]["approvalState"], "rejected")
            self.assertEqual(reject_body["proposal"]["applicationState"], "rejected")

            apply_status, apply_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/apply/request",
                {
                    "runId": "manual-run-1",
                    "previewId": preview_body["previewId"],
                    "proposalId": proposal["proposalId"],
                    "patchSha256": proposal["patchSha256"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(apply_status, 409)
            self.assertIn("pending approval", apply_body["error"])

            second_preview_body = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-1",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )
            second_diagnose_status, second_diagnose_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-1",
                    "previewId": second_preview_body["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(second_diagnose_status, 200)
            accepted_proposal = second_diagnose_body["proposal"]

            sandbox_status, sandbox_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/apply/request",
                {
                    "runId": "manual-run-1",
                    "previewId": second_preview_body["previewId"],
                    "proposalId": accepted_proposal["proposalId"],
                    "patchSha256": accepted_proposal["patchSha256"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(sandbox_status, 200)
            self.assertEqual(
                sandbox_body["proposal"]["applicationState"],
                "sandbox_applied",
            )

            accept_status, accept_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-1/manual-compile-repair/accept/request",
                {
                    "runId": "manual-run-1",
                    "proposalId": accepted_proposal["proposalId"],
                    "patchSha256": accepted_proposal["patchSha256"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(accept_status, 200)
            self.assertEqual(accept_body["proposal"]["approvalState"], "approved")
            self.assertEqual(accept_body["proposal"]["applicationState"], "applied")
            self.assertEqual(
                [capability for capability, _ in state.capability_invocations],
                ["model-gateway", "model-gateway", "build-test"],
            )
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_manual_compile_repair_diagnose_returns_proposal_none_for_refusal_no_patch_path(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.build_test_responses = [
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "compile_failed",
                    "runId": "manual-run-2",
                    "workflowId": "w0-migration-v0",
                    "summary": "compile failed",
                }
            ]
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-manual-2",
                    "runId": "manual-run-2",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-2",
                        "sha256": "e" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "refuse",
                        "rationale": "No safe repair is available.",
                        "refusalCode": "no_safe_repair",
                        "confidence": 0.2,
                    },
                }
            ]
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            _seed_manual_compile_repair_run(
                runner,
                run_id="manual-run-2",
                program_id="CASE01",
                java_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"broken\")\n"
                    "    }\n"
                    "}\n"
                ),
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id="manual-run-2")
            current_java_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {\n"
                "        System.out.println(\"broken\")\n"
                "    }\n"
                "}\n"
            )
            runner.artifact_store.write_json(
                "manual-run-2",
                "w0-migration-v0",
                "build-test-result.json",
                dict(state.build_test_responses[0]),
                kind=KIND_BUILD_TEST_RESULT,
            )
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            preview_body = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-2",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )
            status, body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-2/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-2",
                    "previewId": preview_body["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(status, 200)

            self.assertIsNone(body["proposal"])
            self.assertEqual(body["diagnosis"]["likelyRootCause"], "No safe repair is available.")
            self.assertEqual(
                body["candidateProject"]["files"]["src/main/java/com/c2c/generated/CASE01.java"],
                current_java_source,
            )
            self.assertEqual(
                [capability for capability, _ in state.capability_invocations],
                ["model-gateway"],
            )
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_manual_compile_repair_diagnose_classifies_runtime_and_parity_failures(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            runtime_build_response = {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "runtime_failed",
                    "runId": "manual-run-3",
                    "workflowId": "w0-migration-v0",
                    "summary": "runtime exception",
                    "executionResultRef": {
                        "uri": "urn:build/runtime-execution",
                        "sha256": "6" * 64,
                        "byteSize": 40,
                    },
                    "runtimeErrorRef": {
                        "uri": "urn:build/runtime-error",
                        "sha256": "7" * 64,
                        "byteSize": 24,
                    },
                }
            parity_build_response = {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "runId": "manual-run-3",
                    "workflowId": "w0-migration-v0",
                    "summary": "parity mismatch",
                    "executionResultRef": {
                        "uri": "urn:build/parity-execution",
                        "sha256": "5" * 64,
                        "byteSize": 28,
                    },
                    "comparisonResultRef": {
                        "uri": "urn:build/parity-comparison",
                        "sha256": "4" * 64,
                        "byteSize": 36,
                    },
                    "parityComparison": {
                        "executionResultRef": {
                            "uri": "urn:build/parity-execution",
                            "sha256": "5" * 64,
                            "byteSize": 28,
                        },
                        "comparisonResultRef": {
                            "uri": "urn:build/parity-comparison",
                            "sha256": "4" * 64,
                            "byteSize": 36,
                        },
                        "expectedRef": {
                            "uri": "urn:build/reference-output",
                            "sha256": "a" * 64,
                            "byteSize": 18,
                        },
                        "actualRef": {
                            "uri": "urn:build/java-output",
                            "sha256": "b" * 64,
                            "byteSize": 18,
                        },
                        "diffRef": {
                            "uri": "urn:build/oracle-diff",
                            "sha256": "8" * 64,
                            "byteSize": 32,
                        }
                    },
                    "oracleDiffRef": {
                        "uri": "urn:build/oracle-diff",
                        "sha256": "8" * 64,
                        "byteSize": 32,
                    },
                }
            state.build_test_responses = [runtime_build_response, parity_build_response]
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-manual-3-runtime",
                    "runId": "manual-run-3",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-3-runtime",
                        "sha256": "f" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Fix the runtime exception.",
                        "files": {
                            "src/main/java/com/c2c/generated/CASE01.java": (
                                "package com.c2c.generated;\n"
                                "public class CASE01 {\n"
                                "    public static void main(String[] args) {\n"
                                "        System.out.println(\"runtime fixed\");\n"
                                "    }\n"
                                "}\n"
                            )
                        },
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
                        "explanation": "Runtime exception fixed.",
                        "unsupportedConstructs": [],
                        "confidence": 0.9,
                    },
                },
                {
                    "invocationId": "mg-manual-3-parity",
                    "runId": "manual-run-3",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-3-parity",
                        "sha256": "e" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Fix the parity mismatch.",
                        "files": {
                            "src/main/java/com/c2c/generated/CASE01.java": (
                                "package com.c2c.generated;\n"
                                "public class CASE01 {\n"
                                "    public static void main(String[] args) {\n"
                                "        System.out.println(\"parity fixed\");\n"
                                "    }\n"
                                "}\n"
                            )
                        },
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": "src/main/java/com/c2c/generated/CASE01.java",
                        "explanation": "Parity mismatch fixed.",
                        "unsupportedConstructs": [],
                        "confidence": 0.88,
                    },
                },
            ]
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            _seed_manual_compile_repair_run(
                runner,
                run_id="manual-run-3",
                program_id="CASE01",
                java_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"broken\")\n"
                    "    }\n"
                    "}\n"
                ),
            )
            runner.artifact_store.write_json(
                "manual-run-3",
                "w0-migration-v0",
                "build-test-result.json",
                dict(runtime_build_response),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id="manual-run-3")
            runner._persist_manual_compile_baseline_diff = lambda *_args, **_kwargs: {
                "uri": "urn:build/manual-edit-diff",
                "sha256": "d" * 64,
                "byteSize": 44,
            }
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            runtime_preview = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-3",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"runtime manual edit\")\n"
                    "    }\n"
                    "}\n"
                ),
                headers=self.JSON_AUTH_HEADERS,
            )
            runtime_status, runtime_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-3/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-3",
                    "previewId": runtime_preview["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(runtime_status, 200)
            self.assertEqual(
                runtime_body["diagnosis"]["failureClass"],
                "generated_code_defect",
            )
            self.assertEqual(
                runtime_body["diagnosis"]["recommendedNextAction"],
                "repair_generated_code",
            )
            runtime_prompt = json.loads(state.capability_invocations[-1][1]["prompt"])
            self.assertEqual(runtime_prompt["runtimeErrorRef"]["uri"], "urn:build/runtime-error")
            self.assertEqual(
                runtime_body["diagnosis"]["executionResultRef"]["uri"],
                "urn:build/runtime-execution",
            )
            self.assertEqual(runtime_body["diagnosis"]["scopeClass"], "generated_code")
            runtime_build_calls = [
                payload
                for capability, payload in state.capability_invocations
                if capability == "build-test"
            ]
            self.assertEqual(runtime_build_calls, [])

            runner.artifact_store.write_json(
                "manual-run-3",
                "w0-migration-v0",
                "build-test-result.json",
                dict(parity_build_response),
                kind=KIND_BUILD_TEST_RESULT,
            )

            parity_preview = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-3",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"parity manual edit\")\n"
                    "    }\n"
                    "}\n"
                ),
                headers=self.JSON_AUTH_HEADERS,
            )
            parity_status, parity_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-3/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-3",
                    "previewId": parity_preview["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(parity_status, 200)
            self.assertEqual(
                parity_body["diagnosis"]["failureClass"],
                "generated_code_defect",
            )
            self.assertEqual(parity_body["diagnosis"]["scopeClass"], "generated_code")
            self.assertEqual(
                parity_body["diagnosis"]["recommendedNextAction"],
                "repair_generated_code",
            )
            parity_prompt = json.loads(state.capability_invocations[-1][1]["prompt"])
            self.assertEqual(parity_prompt["oracleDiffRef"]["uri"], "urn:build/oracle-diff")
            self.assertEqual(
                parity_prompt["buildTestPayload"]["parityComparison"]["expectedRef"]["uri"],
                "urn:build/reference-output",
            )
            self.assertEqual(
                parity_prompt["buildTestPayload"]["parityComparison"]["actualRef"]["uri"],
                "urn:build/java-output",
            )
            self.assertTrue(
                parity_prompt["buildTestPayload"]["manualEditDiffRef"]["sha256"],
            )
            self.assertEqual(
                parity_body["diagnosis"]["comparisonResultRef"]["uri"],
                "urn:build/parity-comparison",
            )
            parity_build_calls = [
                payload
                for capability, payload in state.capability_invocations
                if capability == "build-test"
            ]
            self.assertEqual(parity_build_calls, [])
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_manual_compile_repair_diagnose_handles_no_proposal_and_out_of_scope_follow_up(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.build_test_responses = [
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "runtime_failed",
                    "runId": "manual-run-4",
                    "workflowId": "w0-migration-v0",
                    "summary": "runtime exception",
                },
                {
                    "schemaVersion": "v0",
                    "status": "failed",
                    "reason": "oracle_mismatch",
                    "runId": "manual-run-4",
                    "workflowId": "w0-migration-v0",
                    "summary": "parity mismatch",
                    "parityComparison": {
                        "diffRef": {
                            "uri": "urn:build/oracle-diff-2",
                            "sha256": "9" * 64,
                            "byteSize": 32,
                        }
                    },
                },
            ]
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-manual-4-refusal",
                    "runId": "manual-run-4",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-4-refusal",
                        "sha256": "d" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "refuse",
                        "rationale": "No safe repair is available.",
                        "refusalCode": "no_safe_repair",
                        "confidence": 0.2,
                    },
                },
                {
                    "invocationId": "mg-manual-4-escalate",
                    "runId": "manual-run-4",
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-manual-4-escalate",
                        "sha256": "c" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "escalate",
                        "rationale": "Out of scope for W0.2.",
                        "escalationCode": "out_of_scope_for_w0_2",
                    },
                },
            ]
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            _seed_manual_compile_repair_run(
                runner,
                run_id="manual-run-4",
                program_id="CASE01",
                java_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"broken\")\n"
                    "    }\n"
                    "}\n"
                ),
            )
            runner.artifact_store.write_json(
                "manual-run-4",
                "w0-migration-v0",
                "build-test-result.json",
                dict(state.build_test_responses[0]),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id="manual-run-4")
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            refusal_preview = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-4",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"broken\")\n"
                    "    }\n"
                    "}\n"
                ),
                headers=self.JSON_AUTH_HEADERS,
            )
            refusal_status, refusal_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-4/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-4",
                    "previewId": refusal_preview["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(refusal_status, 200)
            self.assertIsNone(refusal_body["proposal"])
            self.assertEqual(refusal_body["diagnosis"]["recommendedNextAction"], "stop")

            runner.artifact_store.write_json(
                "manual-run-4",
                "w0-migration-v0",
                "build-test-result.json",
                dict(state.build_test_responses[1]),
                kind=KIND_BUILD_TEST_RESULT,
            )

            escalation_preview = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="manual-run-4",
                entry_file_path="src/main/java/com/c2c/generated/CASE01.java",
                java_source=(
                    "package com.c2c.generated;\n"
                    "public class CASE01 {\n"
                    "    public static void main(String[] args) {\n"
                    "        System.out.println(\"broken\")\n"
                    "    }\n"
                    "}\n"
                ),
                headers=self.JSON_AUTH_HEADERS,
            )
            escalation_status, escalation_body = _post_json(
                host,
                orchestrator_port,
                "/v0/runs/manual-run-4/manual-compile-repair/diagnose/request",
                {
                    "runId": "manual-run-4",
                    "previewId": escalation_preview["previewId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(escalation_status, 200)
            self.assertIsNone(escalation_body["proposal"])
            self.assertEqual(
                escalation_body["diagnosis"]["recommendedNextAction"],
                "escalate",
            )
            self.assertEqual(escalation_body["diagnosis"]["failureClass"], "out_of_scope")
            self.assertEqual(escalation_body["diagnosis"]["scopeClass"], "out_of_scope")
            self.assertEqual(
                escalation_body["diagnosis"]["followUpRecommendation"]["suggestedIssueType"],
                "follow-up",
            )
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_deterministic_run_skips_model_gateway_and_persists_policy_artifact(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            orchestrator_thread = threading.Thread(target=orchestrator_server.serve_forever, daemon=True)
            orchestrator_thread.start()

            payload = {
                "requester": "integration",
                "inputRef": {
                    "uri": "urn:integration/main.cob",
                    "source": "IDENTIFICATION DIVISION.",
                },
            }
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    "/v0/runs",
                    body=json.dumps(payload),
                    headers=self.JSON_AUTH_HEADERS,
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
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
                    status_response = connection.getresponse()
                    run_state = json.loads(status_response.read().decode("utf-8"))
                    status = run_state.get("status", "")
                finally:
                    connection.close()
                if status in {"completed", "failed"}:
                    break
                time.sleep(0.05)

            self.assertEqual(status, "completed")
            self.assertEqual(
                sorted(capability for capability, _ in state.capability_invocations),
                ["build-test", "evidence", "generator", "ir", "parse"],
            )
            evidence_payload = next(
                payload for capability, payload in state.capability_invocations
                if capability == "evidence"
            )
            model_invocation = evidence_payload["artifacts"]["modelInvocations"][0]
            self.assertEqual(model_invocation["status"], "skipped")
            self.assertEqual(model_invocation["provider"], "policy-skipped")
            self.assertEqual(model_invocation["policyVersion"], "v0")
            self.assertTrue(model_invocation["ledgerRef"]["uri"].endswith("/model-policy-skipped.json"))

            run_dir = Path(self._artifact_root) / run_id
            skipped = json.loads((run_dir / "model-policy-skipped.json").read_text("utf-8"))
            self.assertEqual(skipped["runId"], run_id)
            self.assertEqual(skipped["policyVersion"], "v0")
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_startup_tolerates_existing_capability_registrations(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
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

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "GET",
                    "/health",
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                health = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["service"], "orchestrator-service")
            self.assertEqual(len(state.capability_registrations), 7)
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_run_routes_require_control_token(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", "/v0/runs")
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                _ = response.read()
            finally:
                connection.close()

            payload = {
                "requester": "integration",
                "inputRef": {
                    "uri": "urn:integration/main.cob",
                    "source": "IDENTIFICATION DIVISION.",
                },
            }
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    "/v0/runs",
                    body=json.dumps(payload),
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                _ = response.read()
            finally:
                connection.close()

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    "/v0/runs",
                    body=json.dumps(payload),
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                _ = response.read()
            finally:
                connection.close()
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_run_status_is_visible_while_workflow_is_in_flight(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.pause_parse_seconds = 0.25
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()
            time.sleep(0.05)
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
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
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.fail_run_list = True
            state.fail_run_reads = True
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", "/v0/runs", headers=self.AUTH_HEADERS)
                list_response = connection.getresponse()
                self.assertEqual(list_response.status, 503)
            finally:
                connection.close()
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", "/v0/runs/run-1", headers=self.AUTH_HEADERS)
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

    def test_workflow_endpoint_returns_contract_envelope(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()

            status = ""
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    status = body.get("status", "")
                finally:
                    connection.close()
                if status in {"completed", "failed"}:
                    break
                time.sleep(0.05)
            self.assertEqual(status, "completed")

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", f"/v0/runs/{run_id}/workflow", headers=self.AUTH_HEADERS)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                workflow = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            self.assertEqual(workflow["status"], "complete")
            self.assertEqual(workflow["source"], "live")
            self.assertEqual(workflow["missingArtifacts"], [])
            self.assertIn("contract", workflow)
            self.assertIsNotNone(workflow["contract"])
            self.assertIn("contractRef", workflow)
            self.assertIsNotNone(workflow["contractRef"])
            contract = workflow["contract"]
            self.assertEqual(contract["schemaVersion"], "v0")
            self.assertEqual(contract["currentState"], "final_classification")
            self.assertEqual(contract["finalClassification"], "success")
            self.assertIn("repairAttempts", contract)
            self.assertEqual(contract["repairAttempts"], [])
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_intentional_divergence_endpoint_creates_updates_and_exports_projection(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.build_test_responses = [self._parity_mismatch_build_response()]
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()

            status = ""
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    status = body.get("status", "")
                finally:
                    connection.close()
                if status in {"completed", "failed"}:
                    break
                time.sleep(0.05)
            self.assertIn(status, {"completed", "failed"})

            self._seed_intentional_divergence_contract(runner, run_id)

            build_meta = runner.artifact_store.find_metadata(run_id, "build-test-result.json")
            self.assertIsNotNone(build_meta)
            build_ref = {
                "uri": build_meta["uri"],
                "sha256": build_meta["sha256"],
                "byteSize": build_meta["byteSize"],
            }

            decision_request = {
                "requester": "studio",
                "reasonCode": "business_rule_alignment",
                "reviewer": {
                    "reviewerId": "reviewer-1",
                    "displayName": "Reviewer One",
                    "role": "approver",
                },
                "rationale": {
                    "summary": "Customer policy allows the expected divergence.",
                    "technicalBasis": "The target output intentionally differs from the reference.",
                    "businessImpact": "The behavioral difference is approved and documented.",
                },
                "linkedEvidenceRefs": [build_ref],
                "affectedOutputs": ["java_output", "normalized_output"],
                "invalidationTriggers": ["comparison_result_changed", "linked_evidence_changed"],
            }
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    f"/v0/runs/{run_id}/intentional-divergence/decision/request",
                    body=json.dumps(decision_request),
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                decision_response = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            self.assertEqual(
                decision_response["trustSummary"]["trustState"],
                "intentional_divergence",
            )
            self.assertEqual(
                decision_response["trustSummary"]["comparisonResult"]["decisionStatus"],
                "active",
            )
            self.assertEqual(
                decision_response["decision"]["reviewer"]["reviewerId"],
                "reviewer-1",
            )

            decision_request["rationale"]["summary"] = "The same divergence remains approved."
            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    f"/v0/runs/{run_id}/intentional-divergence/decision/request",
                    body=json.dumps(decision_request),
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                updated_response = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            self.assertEqual(
                updated_response["trustSummary"]["intentionalDivergenceDecision"]["rationale"]["summary"],
                "The same divergence remains approved.",
            )

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", f"/v0/runs/{run_id}/workflow", headers=self.AUTH_HEADERS)
                response = connection.getresponse()
                workflow = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            contract = workflow["contract"]
            self.assertEqual(contract["intentionalDivergenceDecision"]["rationale"]["summary"], "The same divergence remains approved.")
            self.assertEqual(contract["intentionalDivergenceDecisionRef"]["uri"], updated_response["decisionRef"]["uri"])
            summary = json.loads((Path(self._artifact_root) / run_id / "run-summary.json").read_text("utf-8"))
            self.assertEqual(summary["trustSummary"]["trustState"], "intentional_divergence")
            self.assertEqual(
                summary["trustSummary"]["intentionalDivergenceDecision"]["rationale"]["summary"],
                "The same divergence remains approved.",
            )
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_intentional_divergence_does_not_carry_over_to_new_run(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.build_test_responses = [self._parity_mismatch_build_response()]
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            def _start_parity_run() -> str:
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
                        headers=self.JSON_AUTH_HEADERS,
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 201)
                    return json.loads(response.read().decode("utf-8"))["run"]["runId"]
                finally:
                    connection.close()

            first_run_id = _start_parity_run()
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{first_run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    if body.get("status") in {"completed", "failed"}:
                        break
                finally:
                    connection.close()
                time.sleep(0.05)

            self._seed_intentional_divergence_contract(runner, first_run_id)

            build_meta = runner.artifact_store.find_metadata(first_run_id, "build-test-result.json")
            self.assertIsNotNone(build_meta)
            build_ref = {
                "uri": build_meta["uri"],
                "sha256": build_meta["sha256"],
                "byteSize": build_meta["byteSize"],
            }

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    f"/v0/runs/{first_run_id}/intentional-divergence/decision/request",
                    body=json.dumps(
                        {
                            "requester": "studio",
                            "reasonCode": "business_rule_alignment",
                            "reviewer": {
                                "reviewerId": "reviewer-1",
                                "displayName": "Reviewer One",
                                "role": "approver",
                            },
                            "rationale": {
                                "summary": "Approved for the first run only.",
                                "technicalBasis": "The difference is intentional.",
                                "businessImpact": "The run is documented.",
                            },
                            "linkedEvidenceRefs": [build_ref],
                            "affectedOutputs": ["java_output"],
                            "invalidationTriggers": ["comparison_result_changed"],
                        }
                    ),
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
            finally:
                connection.close()

            state.build_test_responses = [self._parity_mismatch_build_response()]
            second_run_id = _start_parity_run()
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{second_run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    if body.get("status") in {"completed", "failed"}:
                        break
                finally:
                    connection.close()
                time.sleep(0.05)

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request("GET", f"/v0/runs/{second_run_id}/workflow", headers=self.AUTH_HEADERS)
                response = connection.getresponse()
                workflow = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()

            contract = workflow["contract"]
            self.assertIsNone(contract.get("intentionalDivergenceDecision"))
            self.assertNotEqual(contract["trustSummary"]["trustState"], "intentional_divergence")
            self.assertEqual(contract["trustSummary"]["comparisonResult"]["decisionStatus"], "none")
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_intentional_divergence_endpoint_rejects_expired_decision(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            state.build_test_responses = [self._parity_mismatch_build_response()]
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()

            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    if body.get("status") in {"completed", "failed"}:
                        break
                finally:
                    connection.close()
                time.sleep(0.05)

            self._seed_intentional_divergence_contract(runner, run_id)

            build_meta = runner.artifact_store.find_metadata(run_id, "build-test-result.json")
            self.assertIsNotNone(build_meta)
            build_ref = {
                "uri": build_meta["uri"],
                "sha256": build_meta["sha256"],
                "byteSize": build_meta["byteSize"],
            }

            connection = HTTPConnection(host, orchestrator_port, timeout=3)
            try:
                connection.request(
                    "POST",
                    f"/v0/runs/{run_id}/intentional-divergence/decision/request",
                    body=json.dumps(
                        {
                            "requester": "studio",
                            "reasonCode": "business_rule_alignment",
                            "reviewer": {
                                "reviewerId": "reviewer-1",
                                "displayName": "Reviewer One",
                                "role": "approver",
                            },
                            "rationale": {
                                "summary": "This approval is expired.",
                                "technicalBasis": "It should fail validation.",
                                "businessImpact": "None.",
                            },
                            "linkedEvidenceRefs": [build_ref],
                            "affectedOutputs": ["java_output"],
                            "invalidationTriggers": ["comparison_result_changed"],
                            "expiresAt": "2000-01-01T00:00:00Z",
                        }
                    ),
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
            finally:
                connection.close()
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_artifact_endpoints_serve_persisted_run_outputs(self):
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            MockHarnessHandler.state = state
            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
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
                    headers=self.JSON_AUTH_HEADERS,
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                run_id = json.loads(response.read().decode("utf-8"))["run"]["runId"]
            finally:
                connection.close()

            status = ""
            for _ in range(60):
                connection = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    connection.request("GET", f"/v0/runs/{run_id}", headers=self.AUTH_HEADERS)
                    resp = connection.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    status = body.get("status", "")
                finally:
                    connection.close()
                if status in {"completed", "failed"}:
                    break
                time.sleep(0.05)
            self.assertEqual(status, "completed")

            def _fetch_json(path: str):
                conn = HTTPConnection(host, orchestrator_port, timeout=3)
                try:
                    conn.request("GET", path, headers=self.AUTH_HEADERS)
                    r = conn.getresponse()
                    return r.status, json.loads(r.read().decode("utf-8"))
                finally:
                    conn.close()

            # artifacts list returns metadata for every persisted artifact
            status_code, artifacts = _fetch_json(f"/v0/runs/{run_id}/artifacts")
            self.assertEqual(status_code, 200)
            paths = sorted(entry["path"] for entry in artifacts["artifacts"])
            for required in [
                "source.cbl",
                "source-ref.json",
                "parse-output.json",
                "semantic-ir-output.json",
                "semantic-ir.json",
                "generation-response.json",
                "build-test-result.json",
                "evidence-pack-manifest.json",
                "trajectory-ledger.json",
                "run-summary.json",
            ]:
                self.assertIn(required, paths, msg=f"missing artifact in index: {required}")
            for entry in artifacts["artifacts"]:
                for required_key in ("uri", "sha256", "byteSize", "mimeType", "kind", "createdBy", "createdAt", "runId", "workflowId"):
                    self.assertIn(required_key, entry, msg=f"artifact entry missing {required_key}: {entry}")

            # Generated endpoint exposes file content equal to the persisted Java
            status_code, generated = _fetch_json(f"/v0/runs/{run_id}/generated")
            self.assertEqual(status_code, 200)
            self.assertEqual(generated["status"], "complete")
            self.assertIn("src/CASE01.java", generated["files"])
            self.assertEqual(generated["files"]["src/CASE01.java"], "class CASE01 {}")

            # Issue #97: /generated must expose an artifactRef pointing at the
            # generated-project manifest plus traceability fields, and must
            # include per-file refs for the persisted project.
            self.assertIn("artifactRef", generated)
            self.assertIsNotNone(generated["artifactRef"])
            self.assertEqual(generated["artifactRef"]["path"], "generated-project-manifest.json")
            self.assertEqual(generated["artifactRef"]["kind"], "generated-project-manifest")
            self.assertTrue(generated["artifactRef"]["sha256"])
            self.assertIn("traceability", generated)
            self.assertEqual(generated["traceability"]["programId"], "CASE01")
            self.assertEqual(generated["traceability"]["irId"], "ir-CASE01")
            self.assertTrue(generated["traceability"]["sourceHash"])
            self.assertIn("fileRefs", generated)
            file_ref_paths = {entry["path"] for entry in generated["fileRefs"]}
            self.assertIn("src/CASE01.java", file_ref_paths)

            # Issue #97: dedicated /generated/files endpoint
            status_code, generated_files = _fetch_json(f"/v0/runs/{run_id}/generated/files")
            self.assertEqual(status_code, 200)
            self.assertEqual(generated_files["status"], "complete")
            file_index_paths = {entry["path"] for entry in generated_files["files"]}
            self.assertIn("src/CASE01.java", file_index_paths)
            self.assertEqual(
                generated_files["artifactRef"]["sha256"],
                generated["artifactRef"]["sha256"],
            )

            # Issue #97: dedicated single-file endpoint
            status_code, file_view = _fetch_json(f"/v0/runs/{run_id}/generated/files/src/CASE01.java")
            self.assertEqual(status_code, 200)
            self.assertEqual(file_view["path"], "src/CASE01.java")
            self.assertEqual(file_view["content"], "class CASE01 {}")
            self.assertEqual(file_view["byteSize"], len(b"class CASE01 {}"))

            # Issue #364: browser-safe artifact content for non-Java run artifacts.
            runner.artifact_store.write_text(
                run_id,
                "w0-migration-v0",
                "logs/studio/comparison.log",
                "comparison ok\n",
                kind=KIND_TRAJECTORY_LEDGER,
            )
            status_code, artifact_view = _fetch_json(
                f"/v0/runs/{run_id}/artifacts/files/logs/studio/comparison.log"
            )
            self.assertEqual(status_code, 200)
            self.assertEqual(artifact_view["path"], "logs/studio/comparison.log")
            self.assertEqual(artifact_view["content"], "comparison ok\n")
            self.assertEqual(
                artifact_view["byteSize"],
                len("comparison ok\n".encode("utf-8")),
            )

            # Issue #97: path traversal is rejected
            status_code, file_traversal = _fetch_json(
                f"/v0/runs/{run_id}/generated/files/..%2F..%2Fetc%2Fpasswd"
            )
            self.assertEqual(status_code, 400)

            status_code, artifact_traversal = _fetch_json(
                f"/v0/runs/{run_id}/artifacts/files/..%2F..%2Fetc%2Fpasswd"
            )
            self.assertEqual(status_code, 400)

            # Issue #97: unknown file inside the generated tree is 404, not leaking
            status_code, file_missing = _fetch_json(
                f"/v0/runs/{run_id}/generated/files/does/not/exist.java"
            )
            self.assertEqual(status_code, 404)

            # Build/test endpoint returns the build-test-result.json content
            status_code, build_test = _fetch_json(f"/v0/runs/{run_id}/build-test")
            self.assertEqual(status_code, 200)
            self.assertEqual(build_test["status"], "complete")
            self.assertEqual(build_test["data"]["status"], "ok")
            self.assertEqual(build_test["artifactRef"]["path"], "build-test-result.json")

            # Issue #97: build/test envelope must reference the same generated
            # Java artifact hash as /generated (parity between UI and build).
            self.assertIn("generatedArtifactRef", build_test)
            self.assertEqual(
                build_test["generatedArtifactRef"]["sha256"],
                generated["artifactRef"]["sha256"],
            )

            # Evidence endpoint returns the evidence-pack-manifest
            status_code, evidence = _fetch_json(f"/v0/runs/{run_id}/evidence")
            self.assertEqual(status_code, 200)
            self.assertEqual(evidence["status"], "complete")
            self.assertEqual(evidence["artifactRef"]["path"], "evidence-pack-manifest.json")

            # Issue #97: evidence envelope must reference the same generated
            # Java artifact hash so the UI can compare what build-test compiled
            # against what the Evidence Pack vouches for.
            self.assertIn("generatedArtifactRef", evidence)
            self.assertEqual(
                evidence["generatedArtifactRef"]["sha256"],
                generated["artifactRef"]["sha256"],
            )

            # Issue #97: the evidence input the orchestrator sent to
            # evidence-service must already carry the manifest hash as
            # artifacts.generatedJava.sha256 so the Evidence Pack written by
            # the downstream service is bound to the exact bytes the UI shows.
            evidence_invocations = [
                payload for capability, payload in state.capability_invocations
                if capability == "evidence"
            ]
            self.assertTrue(evidence_invocations, "evidence service was not invoked")
            evidence_input = evidence_invocations[-1]
            self.assertEqual(
                evidence_input["artifacts"]["generatedJava"]["sha256"],
                generated["artifactRef"]["sha256"],
            )

            # Issue #97: build-test input the orchestrator sent must also
            # carry the manifest hash so the runner is compiling the exact
            # bytes the UI sees.
            build_invocations = [
                payload for capability, payload in state.capability_invocations
                if capability == "build-test"
            ]
            self.assertTrue(build_invocations, "build-test was not invoked")
            self.assertEqual(
                build_invocations[-1]["generatedArtifactRef"]["sha256"],
                generated["artifactRef"]["sha256"],
            )

            export_status, export_body = _post_json(
                host,
                orchestrator_port,
                f"/v0/runs/{run_id}/evidence/export/request",
                {"exportName": "hello-regression"},
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(export_status, 200)
            self.assertEqual(export_body["status"], "created")
            self.assertEqual(
                export_body["export"]["qualification"],
                "clean",
            )
            self.assertIn(
                "CASE01ParityRegressionTest.java",
                export_body["export"]["scaffoldRef"]["path"],
            )

            status_code, evidence_after_export = _fetch_json(
                f"/v0/runs/{run_id}/evidence"
            )
            self.assertEqual(status_code, 200)
            exports = evidence_after_export["data"].get("exports", [])
            self.assertTrue(exports)
            self.assertEqual(
                exports[0]["path"],
                export_body["export"]["scaffoldRef"]["path"],
            )

            # Events endpoint returns the trajectory-ledger contents
            status_code, events = _fetch_json(f"/v0/runs/{run_id}/events")
            self.assertEqual(status_code, 200)
            self.assertEqual(events["status"], "complete")
            self.assertIsInstance(events["events"], list)

            # Issue #96: progress endpoint exposes step-level state.
            status_code, progress = _fetch_json(f"/v0/runs/{run_id}/progress")
            self.assertEqual(status_code, 200)
            self.assertEqual(progress["status"], "complete")
            self.assertEqual(progress["runStatus"], "completed")
            self.assertIsNone(progress.get("failedStep"))
            step_names = {entry["name"] for entry in progress["steps"]}
            for required in [
                "accepted",
                "parse-cobol",
                "generate-ir",
                "generate-java",
                "compile-test-java",
                "write-evidence",
                "completed",
            ]:
                self.assertIn(required, step_names, msg=f"missing step {required}")
            self.assertNotIn("failed", step_names)
            for entry in progress["steps"]:
                self.assertIn("stepId", entry)
                self.assertIn("status", entry)
                self.assertIn("capabilityId", entry)
                self.assertIn("startedAt", entry)

            # Issue #96: learning endpoint reports `unavailable` when EL is
            # not configured, but the envelope still has the run identity.
            status_code, learning = _fetch_json(f"/v0/runs/{run_id}/learning")
            self.assertEqual(status_code, 200)
            self.assertEqual(learning["source"], "unavailable")
            self.assertIsNone(learning["summary"])
            self.assertEqual(learning["missingArtifacts"], ["learning-summary"])

            # Unknown run returns 404
            status_code, missing = _fetch_json("/v0/runs/run-missing/artifacts")
            self.assertEqual(status_code, 404)

            # On-disk hashes match recorded metadata
            status_code, refreshed_artifacts = _fetch_json(f"/v0/runs/{run_id}/artifacts")
            self.assertEqual(status_code, 200)
            for entry in refreshed_artifacts["artifacts"]:
                run_dir = Path(self._artifact_root) / run_id
                on_disk = (run_dir / entry["path"]).read_bytes()
                from hashlib import sha256
                self.assertEqual(entry["sha256"], sha256(on_disk).hexdigest(), msg=f"sha256 mismatch for {entry['path']}")
                self.assertEqual(entry["byteSize"], len(on_disk))
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()


    # ------------------------------------------------------------------
    # Gap A — AC#3/AC#7a: repair-context secret redaction is verified
    # ------------------------------------------------------------------
    def test_manual_compile_repair_preview_redacts_secrets_and_excludes_out_of_scope_diagnostics(self):
        """
        Mutation caught:
          - Deleting the _bounded_preview_text call (line ~2227) leaves raw secret in preview.diagnostics[].message.
          - Deleting the out-of-scope exclusion branch (line ~2219) makes excludedDiagnosticCount stay 0.
          - Setting redactionsApplied=False would break the redactionsApplied assertion.
        """
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            # Prior build failure with diagnostics that contain secret-bearing messages
            # and one out-of-scope diagnostic (filePath not in javaFiles, sourceKind not in {build,test,""})
            prior_failure_with_secrets = {
                "schemaVersion": "v0",
                "status": "failed",
                "reason": "compile_failed",
                "runId": "secret-redact-run",
                "workflowId": "w0-migration-v0",
                "summary": "compile failed",
                "diagnostics": [
                    {
                        "filePath": "src/main/java/com/c2c/generated/CASE01.java",
                        # Bearer regex: r"(?i)bearer\s+[A-Za-z0-9._-]+" fully captures the token value
                        "message": "cannot resolve symbol; Bearer ghp_AbC123XYZ456",
                    },
                    {
                        "filePath": "src/main/java/com/c2c/generated/CASE01.java",
                        # password= regex: [^'\"\\s]+ captures until whitespace/quote/backslash/letter-s
                        # Use a value with no letter 's' so the full secret is captured and redacted
                        "message": "authentication failure: password=T0k3nV4lu3",
                    },
                    {
                        # out-of-scope: filePath not in javaFiles, sourceKind is "deploy" (not build/test/"")
                        "filePath": "infra/deploy/config.yaml",
                        "sourceKind": "deploy",
                        "message": "deployment config parse error",
                    },
                ],
            }
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            java_path = "src/main/java/com/c2c/generated/CASE01.java"
            current_java_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {}\n"
                "}\n"
            )
            _seed_manual_compile_repair_run(
                runner,
                run_id="secret-redact-run",
                program_id="CASE01",
                java_path=java_path,
                java_source=current_java_source,
            )
            runner.artifact_store.write_json(
                "secret-redact-run",
                "w0-migration-v0",
                "build-test-result.json",
                dict(prior_failure_with_secrets),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id="secret-redact-run")
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            preview_body = _request_manual_compile_preview(
                host,
                orchestrator_port,
                run_id="secret-redact-run",
                entry_file_path=java_path,
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )

            # Only the two in-scope diagnostics are included
            preview_diagnostics = preview_body["diagnostics"]
            self.assertEqual(len(preview_diagnostics), 2)

            # Secret values must NOT appear anywhere in the redacted messages
            all_messages = " ".join(d["message"] for d in preview_diagnostics)
            self.assertNotIn("ghp_AbC123XYZ456", all_messages)
            self.assertNotIn("T0k3nV4lu3", all_messages)

            # Redaction marker must be present, proving _bounded_preview_text ran
            self.assertIn("<redacted>", all_messages)

            # Exclusion summary must reflect one out-of-scope diagnostic
            exclusion = preview_body["exclusionSummary"]
            self.assertTrue(exclusion["redactionsApplied"])
            self.assertEqual(exclusion["excludedDiagnosticCount"], 1)
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    # ------------------------------------------------------------------
    # Gap B — AC#6/AC#7d: accept and reject audit-evidence artifact persistence
    # ------------------------------------------------------------------
    def test_manual_compile_repair_accept_writes_approval_artifact_to_artifact_store(self):
        """
        Mutation caught:
          - Deleting the write_json call for approval-{proposalId}.json (lines ~2856-2870) makes
            the read_json assertion fail with None (artifact absent).
          - Changing the kind constant leaves artifact absent when queried by kind.
          - Omitting any required field (approvedBy, approvedAt, approvedPatchSha256) raises KeyError.
        """
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            run_id = "accept-artifact-run"
            java_path = "src/main/java/com/c2c/generated/CASE01.java"
            repaired_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {\n"
                "        System.out.println(\"repaired\");\n"
                "    }\n"
                "}\n"
            )
            prior_failure = {
                "schemaVersion": "v0",
                "status": "failed",
                "reason": "compile_failed",
                "runId": run_id,
                "workflowId": "w0-migration-v0",
                "summary": "compile failed",
                "diagnostics": [
                    {"filePath": java_path, "message": "cannot find symbol"},
                ],
            }
            sandbox_success = {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": run_id,
                "workflowId": "w0-migration-v0",
                "programId": "CASE01",
                "outputRef": {"uri": f"urn:build-output/{run_id}"},
            }
            state.build_test_responses = [sandbox_success]
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-accept-artifact-1",
                    "runId": run_id,
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-accept-artifact-1",
                        "sha256": "f" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Fixed the issue.",
                        "files": {java_path: repaired_source},
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": java_path,
                        "explanation": "Fixed.",
                        "unsupportedConstructs": [],
                        "confidence": 0.95,
                    },
                }
            ]
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            current_java_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {}\n"
                "}\n"
            )
            _seed_manual_compile_repair_run(
                runner,
                run_id=run_id,
                program_id="CASE01",
                java_path=java_path,
                java_source=current_java_source,
            )
            runner.artifact_store.write_json(
                run_id,
                "w0-migration-v0",
                "build-test-result.json",
                dict(prior_failure),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id=run_id)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            # Drive: preview → diagnose → apply (sandbox) → accept
            preview_body = _request_manual_compile_preview(
                host, orchestrator_port,
                run_id=run_id,
                entry_file_path=java_path,
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )
            _, diagnose_body = _post_json(
                host, orchestrator_port,
                f"/v0/runs/{run_id}/manual-compile-repair/diagnose/request",
                {"runId": run_id, "previewId": preview_body["previewId"]},
                self.JSON_AUTH_HEADERS,
            )
            proposal = diagnose_body["proposal"]
            self.assertIsNotNone(proposal)

            sandbox_status, _ = _post_json(
                host, orchestrator_port,
                f"/v0/runs/{run_id}/manual-compile-repair/apply/request",
                {
                    "runId": run_id,
                    "previewId": preview_body["previewId"],
                    "proposalId": proposal["proposalId"],
                    "patchSha256": proposal["patchSha256"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(sandbox_status, 200)

            accept_status, accept_body = _post_json(
                host, orchestrator_port,
                f"/v0/runs/{run_id}/manual-compile-repair/accept/request",
                {
                    "runId": run_id,
                    "proposalId": proposal["proposalId"],
                    "patchSha256": proposal["patchSha256"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(accept_status, 200)

            # Read the approval artifact back from the artifact store directly
            proposal_id = proposal["proposalId"]
            approval_artifact = runner.artifact_store.read_json(
                run_id,
                f"manual-compile-repair/approval-{proposal_id}.json",
            )

            self.assertIsNotNone(approval_artifact, "approval artifact must exist on disk after accept")
            self.assertEqual(approval_artifact["proposalId"], proposal_id)
            self.assertEqual(approval_artifact["runId"], run_id)
            self.assertIn("approvedBy", approval_artifact)
            self.assertIn("approvedAt", approval_artifact)
            self.assertEqual(approval_artifact["approvedPatchSha256"], proposal["patchSha256"])

            # Verify kind is correct so evidence queries can locate it
            approval_meta = runner.artifact_store.find_by_kind(run_id, "manual-compile-repair-approval")
            artifact_paths = [m["path"] for m in approval_meta]
            self.assertIn(
                f"manual-compile-repair/approval-{proposal_id}.json",
                artifact_paths,
            )

            # HTTP response shape also reflects the approval
            self.assertEqual(accept_body["proposal"]["approvalState"], "approved")
            self.assertEqual(accept_body["proposal"]["applicationState"], "applied")
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()

    def test_manual_compile_repair_reject_writes_rejection_artifact_to_artifact_store(self):
        """
        Mutation caught:
          - Deleting the write_json call for approval-{proposalId}.json in reject (lines ~2918-2931) makes
            the read_json assertion fail with None.
          - Omitting `decision` field leaves the decision != "rejected" assertion failing.
          - Omitting rejectedBy/rejectedAt/patchSha256 raises KeyError.
        """
        mock_server, mock_port, _ = _start_server(MockHarnessHandler)
        orchestrator_server: HTTPServer | None = None
        try:
            host = "127.0.0.1"
            state = MockHarnessState(host=host, port=mock_port)
            run_id = "reject-artifact-run"
            java_path = "src/main/java/com/c2c/generated/CASE01.java"
            state.model_gateway_responses = [
                {
                    "invocationId": "mg-reject-artifact-1",
                    "runId": run_id,
                    "modelId": "gpt-oss-120b",
                    "provider": "foundry-development",
                    "policyDecision": "policy allow",
                    "agentRole": "verification-repair",
                    "promptTemplateVersion": "v0",
                    "status": "completed",
                    "ledgerRef": {
                        "uri": "urn:model-gateway/inv-reject-artifact-1",
                        "sha256": "e" * 64,
                        "byteSize": 256,
                    },
                    "output": {
                        "decision": "propose_candidate",
                        "rationale": "Proposed fix.",
                        "files": {
                            java_path: (
                                "package com.c2c.generated;\n"
                                "public class CASE01 {\n"
                                "    public static void main(String[] args) {\n"
                                "        System.out.println(\"proposed\");\n"
                                "    }\n"
                                "}\n"
                            )
                        },
                        "entryClass": "CASE01",
                        "entryPackage": "com.c2c.generated",
                        "entryFilePath": java_path,
                        "explanation": "Proposed.",
                        "unsupportedConstructs": [],
                        "confidence": 0.75,
                    },
                }
            ]
            prior_failure = {
                "schemaVersion": "v0",
                "status": "failed",
                "reason": "compile_failed",
                "runId": run_id,
                "workflowId": "w0-migration-v0",
                "summary": "compile failed",
                "diagnostics": [
                    {"filePath": java_path, "message": "cannot find symbol"},
                ],
            }
            MockHarnessHandler.state = state

            orchestrator_server, runner = self._create_orchestrator(host, mock_port)
            # Broken source — differs from the proposed repaired source so proposal_files is non-empty
            current_java_source = (
                "package com.c2c.generated;\n"
                "public class CASE01 {\n"
                "    public static void main(String[] args) {}\n"
                "}\n"
            )
            _seed_manual_compile_repair_run(
                runner,
                run_id=run_id,
                program_id="CASE01",
                java_path=java_path,
                java_source=current_java_source,
            )
            runner.artifact_store.write_json(
                run_id,
                "w0-migration-v0",
                "build-test-result.json",
                dict(prior_failure),
                kind=KIND_BUILD_TEST_RESULT,
            )
            _stub_manual_compile_repair_artifact_refs(runner, run_id=run_id)
            orchestrator_port = orchestrator_server.server_port
            threading.Thread(target=orchestrator_server.serve_forever, daemon=True).start()

            # Drive: preview → diagnose → reject (proposal is review_pending after diagnose)
            preview_body = _request_manual_compile_preview(
                host, orchestrator_port,
                run_id=run_id,
                entry_file_path=java_path,
                java_source=current_java_source,
                headers=self.JSON_AUTH_HEADERS,
            )
            _, diagnose_body = _post_json(
                host, orchestrator_port,
                f"/v0/runs/{run_id}/manual-compile-repair/diagnose/request",
                {"runId": run_id, "previewId": preview_body["previewId"]},
                self.JSON_AUTH_HEADERS,
            )
            proposal = diagnose_body["proposal"]
            self.assertIsNotNone(proposal)

            reject_status, reject_body = _post_json(
                host, orchestrator_port,
                f"/v0/runs/{run_id}/manual-compile-repair/reject/request",
                {
                    "runId": run_id,
                    "proposalId": proposal["proposalId"],
                },
                self.JSON_AUTH_HEADERS,
            )
            self.assertEqual(reject_status, 200)

            # Read the rejection artifact back from the artifact store directly
            proposal_id = proposal["proposalId"]
            rejection_artifact = runner.artifact_store.read_json(
                run_id,
                f"manual-compile-repair/approval-{proposal_id}.json",
            )

            self.assertIsNotNone(rejection_artifact, "rejection artifact must exist on disk after reject")
            self.assertEqual(rejection_artifact["decision"], "rejected")
            self.assertEqual(rejection_artifact["proposalId"], proposal_id)
            self.assertEqual(rejection_artifact["runId"], run_id)
            self.assertIn("rejectedBy", rejection_artifact)
            self.assertIn("rejectedAt", rejection_artifact)
            self.assertEqual(rejection_artifact["patchSha256"], proposal["patchSha256"])

            # Verify kind tagging for evidence queries
            rejection_meta = runner.artifact_store.find_by_kind(run_id, "manual-compile-repair-approval")
            artifact_paths = [m["path"] for m in rejection_meta]
            self.assertIn(
                f"manual-compile-repair/approval-{proposal_id}.json",
                artifact_paths,
            )

            # HTTP response shape also reflects the rejection
            self.assertEqual(reject_body["proposal"]["approvalState"], "rejected")
            self.assertEqual(reject_body["proposal"]["applicationState"], "rejected")
        finally:
            mock_server.shutdown()
            mock_server.server_close()
            if orchestrator_server is not None:
                orchestrator_server.shutdown()
                orchestrator_server.server_close()


if __name__ == "__main__":
    unittest.main()
