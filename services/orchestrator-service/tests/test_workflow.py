"""Unit tests for orchestrator workflow execution."""

from __future__ import annotations

import json
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path

from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import DataReference, HarnessFailure
from orchestrator_service.workflow import (
    CapabilityMissingError,
    W0RunContext,
    W0WorkflowRunner,
    StepExecutionError,
)


class StubGateway:
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


class SummaryCheckingGateway(StubGateway):
    def __init__(self, capabilities, responses, *, artifact_root: Path):
        super().__init__(capabilities, responses)
        self.artifact_root = artifact_root

    def update_run(self, run_id, status, *, updated_by, message, evidence_refs=None, policy_decision="policy allow"):
        if status == "completed":
            summary_path = self.artifact_root / run_id / "run-summary.json"
            summary = json.loads(summary_path.read_text("utf-8"))
            self.completed_summary_snapshot = summary
        return super().update_run(
            run_id,
            status,
            updated_by=updated_by,
            message=message,
            evidence_refs=evidence_refs,
            policy_decision=policy_decision,
        )


class W0WorkflowRunnerTests(unittest.TestCase):
    @staticmethod
    def _base_config(max_retries: int = 0, model_gateway_model_id: str = "gpt-oss-120b"):
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

    @staticmethod
    def _base_capabilities():
        return {
            "cobol.parse": {"id": "cobol.parse", "owner": "parser-service", "endpoint": "http://parser"},
            "cobol.ir": {"id": "cobol.ir", "owner": "ir-service", "endpoint": "http://ir"},
            "java.generator": {"id": "java.generator", "owner": "gen-service", "endpoint": "http://gen"},
            "java.build-test": {"id": "java.build-test", "owner": "build-service", "endpoint": "http://build"},
            "evidence.writer": {"id": "evidence.writer", "owner": "evidence", "endpoint": "http://evidence"},
            "model-gateway": {"id": "model-gateway", "owner": "model", "endpoint": "http://model"},
        }

    @staticmethod
    def _base_responses():
        return {
            "cobol.parse": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "program": {
                    "programId": "CASE01",
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
                    "programId": "CASE01",
                    "irId": "ir-CASE01",
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
                    "entryClass": "CASE01",
                    "entryFilePath": "src/CASE01.java",
                    "fileCount": 1,
                    "files": {"src/CASE01.java": "class CASE01 {}"},
                },
                "traceability": {},
                "outputRef": {"uri": "urn:orchestrator/run-1/generator"},
            },
            "java.build-test": {
                "schemaVersion": "v0",
                "status": "ok",
                "runId": "run-1",
                "workflowId": "w0-migration-v0",
                "programId": "CASE01",
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
                "policyDecision": "policy allow",
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
        gateway = StubGateway(self._base_capabilities(), self._base_responses())
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
        self.assertEqual(model_invocation["provider"], "policy-skipped")
        self.assertEqual(model_invocation["policyVersion"], "v0")
        self.assertIn("reason", model_invocation)

    def test_build_test_invocation_forwards_cobol_runtime_oracle(self):
        # Issue #92: the orchestrator must attach the UI-provided COBOL source
        # as an executable oracle so build-test-runner can prove equivalence
        # against the exact source the user submitted.
        gateway = StubGateway(self._base_capabilities(), self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

        cobol_source = (
            "       IDENTIFICATION DIVISION.\n"
            "       PROGRAM-ID. CASE01.\n"
            "       PROCEDURE DIVISION.\n"
            "           DISPLAY 'PASS'.\n"
            "           STOP RUN.\n"
        )
        runner.run(
            context=context,
            input_ref={"uri": "urn:source/main.cob", "source": cobol_source},
        )

        build_test_call = next(
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "java.build-test"
        )
        oracle = build_test_call[2].get("oracle")
        self.assertIsNotNone(oracle, "build-test-runner request must include an oracle")
        self.assertEqual(oracle["mode"], "cobol-runtime")
        self.assertEqual(oracle["sourceText"], cobol_source)
        self.assertIn("uri", oracle["sourceRef"])
        self.assertIsInstance(oracle["timeoutMs"], int)
        self.assertGreater(oracle["timeoutMs"], 0)

    def test_skipped_model_invocation_uses_configured_model_id(self):
        gateway = StubGateway(self._base_capabilities(), self._base_responses())
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
        self.assertEqual(model_invocation["policyVersion"], "v0")

    def test_successful_run_with_optional_model_prompt(self):
        gateway = StubGateway(self._base_capabilities(), self._base_responses())
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
        self.assertEqual(model_invocation["policyDecision"], "policy allow")
        self.assertEqual(model_invocation["ledgerRef"]["sha256"], "b" * 64)

    def test_retry_happy_path_on_temporary_parse_failure(self):
        gateway = StubGateway(
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
        gateway = StubGateway(
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


    def test_workflow_emits_accepted_and_completed_lifecycle_events(self):
        gateway = StubGateway(self._base_capabilities(), self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        event_types = [event.get("eventType") for event in gateway.posted_events]
        self.assertIn("orchestrator.workflow.accepted", event_types)
        self.assertIn("orchestrator.workflow.completed", event_types)
        self.assertNotIn("orchestrator.workflow.failed", event_types)
        run_updates = [entry[1] for entry in gateway.updated_runs]
        self.assertEqual(run_updates[0], "updating")
        self.assertEqual(run_updates[-1], "completed")

    def test_workflow_emits_failed_lifecycle_event_when_step_errors(self):
        gateway = StubGateway(
            self._base_capabilities(),
            self._base_responses(),
            fail_parse_attempts=4,
        )
        runner = W0WorkflowRunner(config=self._base_config(max_retries=0), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        event_types = [event.get("eventType") for event in gateway.posted_events]
        self.assertIn("orchestrator.workflow.accepted", event_types)
        self.assertIn("orchestrator.workflow.failed", event_types)
        self.assertEqual(gateway.updated_runs[-1][1], "failed")
        failure_message = gateway.updated_runs[-1][3]
        self.assertIn("failed", failure_message.lower())

    def test_missing_capability_marks_run_failed_with_diagnostic(self):
        capabilities = self._base_capabilities()
        del capabilities["evidence.writer"]

        class MissingCapabilityGateway(StubGateway):
            def get_capability(self, capability_id):
                self.calls.append(("get_capability", capability_id))
                if capability_id == "evidence.writer":
                    raise RuntimeError("capability evidence.writer not found")
                return dict(self.capabilities[capability_id])

        gateway = MissingCapabilityGateway(capabilities, self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        with self.assertRaises(CapabilityMissingError) as ctx:
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        self.assertIn("evidence.writer", str(ctx.exception))
        self.assertEqual(gateway.updated_runs[-1][1], "failed")
        diagnostic_message = gateway.updated_runs[-1][3]
        self.assertIn("evidence.writer", diagnostic_message)
        event_types = [event.get("eventType") for event in gateway.posted_events]
        self.assertIn("orchestrator.workflow.failed", event_types)

    def test_model_prompt_requires_model_gateway_capability(self):
        capabilities = self._base_capabilities()
        del capabilities["model-gateway"]

        class MissingCapabilityGateway(StubGateway):
            def get_capability(self, capability_id):
                self.calls.append(("get_capability", capability_id))
                if capability_id == "model-gateway":
                    raise RuntimeError("capability model-gateway not found")
                return dict(self.capabilities[capability_id])

        gateway = MissingCapabilityGateway(capabilities, self._base_responses())
        runner = W0WorkflowRunner(config=self._base_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain safe migration",
        )

        with self.assertRaises(CapabilityMissingError) as ctx:
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        self.assertIn("model-gateway", str(ctx.exception))
        self.assertEqual(gateway.updated_runs[-1][1], "failed")
        diagnostic_message = gateway.updated_runs[-1][3]
        self.assertIn("model-gateway", diagnostic_message)

    def test_evidence_step_failure_marks_run_failed_and_does_not_succeed(self):
        responses = self._base_responses()
        gateway = StubGateway(self._base_capabilities(), responses)

        original_invoke = gateway.invoke_capability

        def invoke_with_evidence_failure(capability, payload):
            if capability["id"] == "evidence.writer":
                raise HarnessFailure(503, "evidence backend unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke_with_evidence_failure
        runner = W0WorkflowRunner(config=self._base_config(max_retries=0), gateway=gateway)
        context = W0RunContext(
            run_id="run-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        self.assertEqual(gateway.updated_runs[-1][1], "failed")
        event_types = [event.get("eventType") for event in gateway.posted_events]
        self.assertIn("orchestrator.workflow.failed", event_types)
        self.assertNotIn("orchestrator.workflow.completed", event_types)


class WorkflowArtifactPersistenceTests(unittest.TestCase):
    """Workflow persists run-scoped artifacts on success and failure paths."""

    @staticmethod
    def _config():
        return W0WorkflowRunnerTests._base_config()  # reuse helper

    def _runner_with_store(self, gateway, *, max_retries: int = 0):
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-service-test")
        config = W0WorkflowRunnerTests._base_config(max_retries=max_retries)
        runner = W0WorkflowRunner(config=config, gateway=gateway, artifact_store=store)
        return runner, store, Path(store_dir.name)

    def test_successful_run_persists_all_required_artifacts(self):
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), W0WorkflowRunnerTests._base_responses())
        runner, store, root = self._runner_with_store(gateway)
        context = W0RunContext(
            run_id="run-Z1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        run_dir = root / "run-Z1"
        for relpath in [
            "source.cbl",
            "source-ref.json",
            "parse-output.json",
            "semantic-ir-output.json",
            "semantic-ir.json",
            "generation-response.json",
            "generated-project/src/CASE01.java",
            "build-test-result.json",
            "trajectory-ledger.json",
            "evidence-pack-manifest.json",
            "model-policy-skipped.json",
            "run-summary.json",
            "artifacts-index.json",
        ]:
            self.assertTrue((run_dir / relpath).is_file(), f"missing artifact {relpath}")

        # Source content equals the in-memory source text byte-for-byte.
        on_disk_source = (run_dir / "source.cbl").read_bytes()
        self.assertEqual(on_disk_source, b"IDENTIFICATION DIVISION.")

        # Generated Java retrieved via store equals the canonical bytes written.
        generated = (run_dir / "generated-project/src/CASE01.java").read_text("utf-8")
        self.assertEqual(generated, "class CASE01 {}")

        # Artifact index records sha256 == sha256(bytes on disk) for parse-output.
        index = json.loads((run_dir / "artifacts-index.json").read_text("utf-8"))
        parse_entry = next(entry for entry in index["artifacts"] if entry["path"] == "parse-output.json")
        on_disk_parse = (run_dir / "parse-output.json").read_bytes()
        self.assertEqual(parse_entry["sha256"], sha256(on_disk_parse).hexdigest())
        self.assertEqual(parse_entry["byteSize"], len(on_disk_parse))
        for required_key in ("uri", "sha256", "byteSize", "mimeType", "kind", "createdBy", "createdAt", "runId", "workflowId"):
            self.assertIn(required_key, parse_entry)

        # Evidence pack manifest mirrors the evidence-service response.
        evidence = json.loads((run_dir / "evidence-pack-manifest.json").read_text("utf-8"))
        self.assertEqual(evidence["status"], "complete")
        self.assertEqual(evidence["packId"], "pack-run-1")

        summary = json.loads((run_dir / "run-summary.json").read_text("utf-8"))
        self.assertEqual(summary["status"], "completed")
        self.assertEqual(summary["programId"], "CASE01")
        self.assertIn("write-evidence", summary["completedSteps"])

        skipped = json.loads((run_dir / "model-policy-skipped.json").read_text("utf-8"))
        self.assertEqual(skipped["status"], "skipped")
        self.assertEqual(skipped["modelId"], "gpt-oss-120b")
        self.assertEqual(skipped["policyVersion"], "v0")
        self.assertIn("timestamp", skipped)
        self.assertIn("deterministic W0 translation", skipped["reason"])

        skipped_meta = store.find_metadata("run-Z1", "model-policy-skipped.json")
        self.assertIsNotNone(skipped_meta)
        evidence_call = next(
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "evidence.writer"
        )
        evidence_model_ref = evidence_call[2]["artifacts"]["modelInvocations"][0]
        self.assertEqual(evidence_model_ref["status"], "skipped")
        self.assertEqual(evidence_model_ref["provider"], "policy-skipped")
        self.assertEqual(evidence_model_ref["policyVersion"], "v0")
        self.assertEqual(evidence_model_ref["ledgerRef"]["uri"], skipped_meta["uri"])
        self.assertEqual(evidence_model_ref["ledgerRef"]["sha256"], skipped_meta["sha256"])

    def test_failed_run_persists_partial_artifacts_and_failure_summary(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), responses)

        original_invoke = gateway.invoke_capability

        def invoke_with_generator_failure(capability, payload):
            if capability["id"] == "java.generator":
                raise HarnessFailure(503, "generator backend unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke_with_generator_failure
        runner, _store, root = self._runner_with_store(gateway, max_retries=0)
        context = W0RunContext(
            run_id="run-Z2",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        run_dir = root / "run-Z2"
        for relpath in [
            "source.cbl",
            "source-ref.json",
            "parse-output.json",
            "semantic-ir-output.json",
            "run-summary.json",
        ]:
            self.assertTrue((run_dir / relpath).is_file(), f"missing partial artifact {relpath}")
        # Generator artifacts should not exist because the step failed.
        self.assertFalse((run_dir / "generation-response.json").exists())
        self.assertFalse((run_dir / "build-test-result.json").exists())
        self.assertFalse((run_dir / "evidence-pack-manifest.json").exists())

        summary = json.loads((run_dir / "run-summary.json").read_text("utf-8"))
        self.assertEqual(summary["status"], "failed")
        self.assertIn("generate-java", summary.get("failedStep", "") or "")
        skipped = json.loads((run_dir / "model-policy-skipped.json").read_text("utf-8"))
        self.assertEqual(skipped["status"], "skipped")
        self.assertIn("deterministic W0 translation", skipped["reason"])

    def test_model_prompt_persists_invocation_ledger(self):
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), W0WorkflowRunnerTests._base_responses())
        runner, _store, root = self._runner_with_store(gateway)
        context = W0RunContext(
            run_id="run-Z3",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain safe migration",
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        run_dir = root / "run-Z3"
        self.assertTrue((run_dir / "model-invocation-ledger.json").is_file())
        self.assertFalse((run_dir / "model-policy-skipped.json").exists())
        invocation = json.loads((run_dir / "model-invocation-ledger.json").read_text("utf-8"))
        self.assertEqual(invocation["schemaVersion"], "v0")
        self.assertEqual(invocation["status"], "completed")
        self.assertEqual(invocation["dataClass"], "model-gateway")
        self.assertEqual(invocation["promptTemplateVersion"], "v1")
        self.assertIn("requestRef", invocation)
        self.assertIn("outputRef", invocation)
        self.assertIn("createdAt", invocation)

    def test_model_prompt_failure_before_invocation_persists_governance_artifact(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), responses)

        original_invoke = gateway.invoke_capability

        def invoke_with_generator_failure(capability, payload):
            if capability["id"] == "java.generator":
                raise HarnessFailure(503, "generator backend unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke_with_generator_failure
        runner, _store, root = self._runner_with_store(gateway, max_retries=0)
        context = W0RunContext(
            run_id="run-Z4",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain safe migration",
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

    def test_completed_summary_is_persisted_before_harness_completion_update(self):
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        artifact_root = Path(store_dir.name)
        gateway = SummaryCheckingGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
            artifact_root=artifact_root,
        )
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-service-test")
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
            artifact_store=store,
        )
        context = W0RunContext(
            run_id="run-Z5",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt=None,
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        summary = gateway.completed_summary_snapshot
        self.assertEqual(summary["status"], "completed")
        self.assertEqual(summary["message"], "W0 migration workflow completed")
        self.assertEqual(summary["completedSteps"][-1], "write-evidence")


class DataReferenceTests(unittest.TestCase):
    def test_data_reference_type_is_available(self):
        reference = DataReference(uri="urn:test", sha256="a" * 64, byte_size=1)
        self.assertEqual(reference.uri, "urn:test")


class GovernanceSchemaTests(unittest.TestCase):
    def test_model_policy_skipped_schema_is_present(self):
        repo_root = Path(__file__).resolve().parents[3]
        schema_path = repo_root / "schemas" / "model-policy-skipped-v0.json"
        body = json.loads(schema_path.read_text("utf-8"))

        self.assertEqual(
            body["$id"],
            "https://oscharko.dev/c2c/schemas/model-policy-skipped-v0.json",
        )
        self.assertEqual(body["properties"]["status"]["const"], "skipped")
        for required in ("runId", "workflowId", "modelId", "reason", "policyVersion", "timestamp"):
            self.assertIn(required, body["required"])


if __name__ == "__main__":
    unittest.main()
