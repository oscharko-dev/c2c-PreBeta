"""Unit tests for orchestrator workflow execution."""

from __future__ import annotations

import unittest

from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import DataReference, HarnessFailure
from orchestrator_service.workflow import (
    W0RunContext,
    W0WorkflowRunner,
    StepExecutionError,
)


class FakeGateway:
    def __init__(self, capabilities, responses, *, fail_parse_attempts: int = 0):
        self.capabilities = capabilities
        self.responses = responses
        self.fail_parse_attempts = fail_parse_attempts
        self.calls = []
        self.created_run = None
        self.updated_runs = []
        self.posted_events = []
        self.parse_attempts = 0
        self.registered_capabilities = []
        self.trajectory_ledger = {}

    def create_run(self, workflow_id: str, requester: str = "orchestrator", evidence_refs=None):
        self.created_run = {
            "runId": "run-1",
            "workflowId": workflow_id,
            "status": "starting",
            "updatedBy": requester,
            "evidenceRefs": evidence_refs or [],
        }
        return self.created_run

    def update_run(self, run_id, status, *, updated_by, message, evidence_refs=None, policy_decision="policy allow"):
        self.updated_runs.append((run_id, status, updated_by, message, list(evidence_refs or []), policy_decision))
        return {"runId": run_id, "status": status}

    def get_capability(self, capability_id: str):
        self.calls.append(("get_capability", capability_id))
        return dict(self.capabilities[capability_id])

    def register_capability(self, capability):
        self.calls.append(("register_capability", str(capability.get("id", ""))))
        self.registered_capabilities.append(dict(capability))
        return dict(capability)

    def invoke_capability(self, capability, payload):
        capability_id = capability["id"]
        self.calls.append(("invoke", capability_id, dict(payload)))
        if capability_id == "cobol.parse":
            self.parse_attempts += 1
            if self.parse_attempts <= self.fail_parse_attempts:
                raise HarnessFailure(503, "temporary failure")
        if capability_id not in self.responses:
            raise RuntimeError(f"unexpected capability {capability_id}")
        return dict(self.responses[capability_id])

    def post_event(self, event):
        self.posted_events.append(event)
        return {"eventId": "evt-1"}

    def get_trajectory_ledger(self, run_id: str):
        self.calls.append(("get_trajectory_ledger", run_id))
        return dict(self.trajectory_ledger.get(run_id, {"runId": run_id, "events": []}))


class W0WorkflowRunnerTests(unittest.TestCase):
    def _base_config(self, max_retries: int = 0, model_gateway_model_id: str = "gpt-oss-120b"):
        return OrchestratorConfig(
            listen_addr="127.0.0.1:0",
            harness_base_url="http://127.0.0.1:1",
            workflow_id="w0-migration-v0",
            max_retries=max_retries,
            retry_delay_ms=1,
            request_timeout_seconds=1,
            parse_capability_id="cobol.parse",
            ir_capability_id="cobol.ir",
            generator_capability_id="java.generator",
            build_test_capability_id="java.build-test",
            evidence_capability_id="evidence.writer",
            model_gateway_capability_id="model-gateway",
            w0_capabilities=(
                {"id": "cobol.parse", "name": "COBOL Parser", "owner": "parser-service", "endpoint": "http://parser"},
                {"id": "cobol.ir", "name": "Semantic IR", "owner": "ir-service", "endpoint": "http://ir"},
                {"id": "java.generator", "name": "Java Generator", "owner": "generator-service", "endpoint": "http://generator"},
                {"id": "java.build-test", "name": "Build Test", "owner": "build-service", "endpoint": "http://build-test"},
                {"id": "evidence.writer", "name": "Evidence Writer", "owner": "evidence-service", "endpoint": "http://evidence"},
                {"id": "model-gateway", "name": "Model Gateway", "owner": "model-gateway", "endpoint": "http://model"},
            ),
            model_gateway_model_id=model_gateway_model_id,
        )

    def _base_capabilities(self):
        return {
            "cobol.parse": {"id": "cobol.parse", "owner": "parser-service", "endpoint": "http://parser"},
            "cobol.ir": {"id": "cobol.ir", "owner": "ir-service", "endpoint": "http://ir"},
            "java.generator": {"id": "java.generator", "owner": "gen-service", "endpoint": "http://gen"},
            "java.build-test": {"id": "java.build-test", "owner": "build-service", "endpoint": "http://build"},
            "evidence.writer": {"id": "evidence.writer", "owner": "evidence", "endpoint": "http://evidence"},
            "model-gateway": {"id": "model-gateway", "owner": "model", "endpoint": "http://model"},
        }

    def _base_responses(self):
        return {
            "cobol.parse": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "program": {
                    "programId": "DEMO01",
                    "sourceHash": "a" * 64,
                    "sourceKind": "cobol",
                },
                "sourceRef": {
                    "uri": "urn:source/main.cob",
                    "sha256": "a" * 64,
                    "byteSize": 12,
                },
                "outputRef": {"uri": "urn:orchestrator/run-1/parse"},
            },
            "cobol.ir": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "sourceRef": {
                    "uri": "urn:source/main.cob",
                    "sha256": "a" * 64,
                    "byteSize": 12,
                },
                "ir": {
                    "schemaVersion": "v0",
                    "programId": "DEMO01",
                    "irId": "ir-DEMO01",
                },
                "outputRef": {"uri": "urn:orchestrator/run-1/ir"},
            },
            "java.generator": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "sourceRef": {
                    "uri": "urn:source/main.cob",
                    "sha256": "a" * 64,
                    "byteSize": 12,
                },
                "generatedProject": {
                    "entryClass": "DEMO01",
                    "entryFilePath": "src/DEMO01.java",
                    "fileCount": 1,
                    "files": {"src/DEMO01.java": "class DEMO01 {}"},
                },
                "traceability": {},
                "outputRef": {"uri": "urn:orchestrator/run-1/generator"},
            },
            "java.build-test": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "programId": "DEMO01",
                "outputRef": {"uri": "urn:orchestrator/run-1/build"},
            },
            "evidence.writer": {
                "schemaVersion": "v0",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "status": "complete",
                "packId": "pack-run-1",
                "outputRef": {"uri": "urn:orchestrator/run-1/evidence"},
            },
            "model-gateway": {
                "invocationId": "mg-run-1-1",
                "runId": "run-1",
                "modelId": "gpt-oss-120b",
                "provider": "foundry-development",
                "promptTemplateVersion": "v1",
                "status": "completed",
                "ledgerRef": {
                    "uri": "urn:model-gateway/invocations/mg-run-1-1",
                    "sha256": "b" * 64,
                    "byteSize": 512,
                },
                "output": {"status": "completed"},
            },
        }

    def test_successful_run_without_model_prompt(self):
        gateway = FakeGateway(self._base_capabilities(), self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

        result = runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        self.assertEqual(result["status"], "completed")
        invoked = [entry[1] for entry in gateway.calls if entry[0] == "invoke"]
        self.assertEqual(
            invoked,
            ["cobol.parse", "cobol.ir", "java.generator", "java.build-test", "evidence.writer"],
        )
        resolved = [entry[1] for entry in gateway.calls if entry[0] == "get_capability"]
        self.assertEqual(
            resolved,
            ["cobol.parse", "cobol.ir", "java.generator", "java.build-test", "evidence.writer"],
        )
        self.assertEqual(gateway.updated_runs[0][1], "updating")
        self.assertEqual(gateway.updated_runs[-1][1], "completed")
        self.assertGreater(len(gateway.posted_events), 0)
        evidence_call = next(entry for entry in gateway.calls if entry[0] == "invoke" and entry[1] == "evidence.writer")
        model_invocation = evidence_call[2]["artifacts"]["modelInvocations"][0]
        self.assertEqual(model_invocation["status"], "skipped")
        self.assertEqual(model_invocation["provider"], "orchestrator")

    def test_skipped_model_invocation_uses_configured_model_id(self):
        gateway = FakeGateway(self._base_capabilities(), self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(model_gateway_model_id="phi-4"), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        evidence_call = next(entry for entry in gateway.calls if entry[0] == "invoke" and entry[1] == "evidence.writer")
        model_invocation = evidence_call[2]["artifacts"]["modelInvocations"][0]
        self.assertEqual(model_invocation["status"], "skipped")
        self.assertEqual(model_invocation["modelId"], "phi-4")

    def test_successful_run_with_optional_model_prompt(self):
        gateway = FakeGateway(self._base_capabilities(), self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="Optimize with ISO-8859-1 checks.",
        )

        result = runner.run(
            context=context,
            input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
        )
        invoked = [entry[1] for entry in gateway.calls if entry[0] == "invoke"]

        self.assertEqual(result["status"], "completed")
        self.assertIn("model-gateway", invoked)
        model_call = next(entry for entry in gateway.calls if entry[0] == "invoke" and entry[1] == "model-gateway")
        self.assertEqual(model_call[2]["modelId"], "gpt-oss-120b")
        self.assertEqual(model_call[2]["dataClass"], "model-gateway")
        model_events = [
            event for event in gateway.posted_events
            if event.get("capability") == "model-gateway"
            and event.get("stateTransition") == "step.completed"
        ]
        self.assertEqual(len(model_events), 1)
        self.assertNotIn("prompt", model_events[0]["payload"]["input"])
        self.assertEqual(model_events[0]["payload"]["input"]["promptRedacted"], True)
        evidence_call = next(entry for entry in gateway.calls if entry[0] == "invoke" and entry[1] == "evidence.writer")
        model_invocation = evidence_call[2]["artifacts"]["modelInvocations"][0]
        self.assertEqual(model_invocation["status"], "completed")
        self.assertEqual(model_invocation["provider"], "foundry-development")
        self.assertEqual(model_invocation["promptTemplateVersion"], "v1")
        self.assertEqual(model_invocation["ledgerRef"]["sha256"], "b" * 64)

    def test_retry_happy_path_on_temporary_parse_failure(self):
        gateway = FakeGateway(
            self._base_capabilities(),
            self._base_responses(),
            fail_parse_attempts=1,
        )
        runner = W0WorkflowRunner(config=self._base_config(max_retries=2), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        parse_invocations = [
            call for call in gateway.calls
            if call[0] == "invoke" and call[1] == "cobol.parse"
        ]
        self.assertEqual(len(parse_invocations), 2)

    def test_run_fails_after_retries_are_exhausted(self):
        gateway = FakeGateway(
            self._base_capabilities(),
            self._base_responses(),
            fail_parse_attempts=4,
        )
        runner = W0WorkflowRunner(config=self._base_config(max_retries=1), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(
                context=context,
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION.", "sha256": "a" * 64, "byteSize": 12},
            )

        self.assertEqual(gateway.updated_runs[-1][1], "failed")
        retry_events = [event for event in gateway.posted_events if event.get("stateTransition") == "step.retry"]
        failed_events = [event for event in gateway.posted_events if event.get("stateTransition") == "step.failed"]
        self.assertGreater(len(retry_events), 0)
        self.assertGreater(len(failed_events), 0)


class DataReferenceTests(unittest.TestCase):
    def test_data_reference_type_is_available(self):
        reference = DataReference(uri="urn:test", sha256="a" * 64, byte_size=1)
        self.assertEqual(reference.uri, "urn:test")


if __name__ == "__main__":
    unittest.main()
