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


class W0WorkflowRunnerTests(unittest.TestCase):
    def _base_config(self, max_retries: int = 0):
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
            "cobol.parse": {"irRef": {"uri": "urn:ir"}},
            "cobol.ir": {"irRef": {"uri": "urn:ir/normalized"}},
            "java.generator": {"javaRef": {"uri": "urn:java/source"}},
            "java.build-test": {"status": "ok", "buildOutcome": "compile"},
            "evidence.writer": {"evidenceRef": {"uri": "urn:evidence"}},
            "model-gateway": {"status": "ok", "advice": "Use standard profile."},
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

        result = runner.run(context=context, input_ref={"uri": "urn:source/main.cob"})

        self.assertEqual(result["status"], "completed")
        invoked = [entry[1] for entry in gateway.calls if entry[0] == "invoke"]
        self.assertEqual(
            invoked,
            ["cobol.parse", "cobol.ir", "java.generator", "java.build-test", "evidence.writer"],
        )
        self.assertEqual(gateway.updated_runs[0][1], "updating")
        self.assertEqual(gateway.updated_runs[-1][1], "completed")
        self.assertGreater(len(gateway.posted_events), 0)

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

        result = runner.run(context=context, input_ref={"uri": "urn:source/main.cob"})
        invoked = [entry[1] for entry in gateway.calls if entry[0] == "invoke"]

        self.assertEqual(result["status"], "completed")
        self.assertIn("model-gateway", invoked)

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

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob"})

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
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob"})

        self.assertEqual(gateway.updated_runs[-1][1], "failed")


class DataReferenceTests(unittest.TestCase):
    def test_data_reference_type_is_available(self):
        reference = DataReference(uri="urn:test", sha256="a" * 64, byte_size=1)
        self.assertEqual(reference.uri, "urn:test")


if __name__ == "__main__":
    unittest.main()
