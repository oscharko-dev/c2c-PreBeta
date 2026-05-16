"""Issue #96: pipeline progress and Experience Learning telemetry.

These tests pin the orchestrator-side contract:
* every successful UI-started run produces step records with started/finished
  timestamps for parser, IR, generator, build/test, and evidence;
* a failed capability marks the corresponding step `failed` with a diagnostic
  and never collapses into a generic success;
* Harness events and the trajectory ledger are forwarded to the
  experience-learning-service (best-effort, but invoked exactly once);
* the Evidence Pack input includes a reference to the experience-learning
  run summary endpoint.
"""

from __future__ import annotations

import tempfile
import unittest

from orchestrator_service.artifacts import RunArtifactStore
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.workflow import (
    REQUIRED_RUN_STEP_NAMES,
    STEP_ACCEPTED,
    STEP_COMPLETED,
    STEP_FAILED,
    STEP_MODEL_POLICY_SKIPPED,
    STEP_STATUS_FAILED,
    STEP_STATUS_OK,
    StepExecutionError,
    W0RunContext,
    W0WorkflowRunner,
)

from test_workflow import StubGateway, W0WorkflowRunnerTests


class _StubExperienceLearning:
    """Captures the events and ledgers forwarded to experience-learning."""

    enabled = True
    base_url = "http://experience-learning.test"

    # noinspection PyTypeHintsInspection
    def __init__(self, *, summary: dict | None = None):
        self.harness_event_batches: list[list[dict]] = []
        self.trajectory_ledgers: list[dict] = []
        self.summary_lookups: list[str] = []
        self._summary = summary or {
            "runId": "stub",
            "runStatus": "completed",
            "candidateCount": 1,
            "candidateByPattern": {"accepted_pattern": 1},
            "experienceEventIds": ["evt-1"],
            "observedPatterns": ["accepted_pattern"],
            "observationOnly": True,
            "policyVersion": "v0",
        }

    def post_harness_events(self, events):
        self.harness_event_batches.append([dict(event) for event in events])

    def post_trajectory_ledger(self, ledger):
        self.trajectory_ledgers.append(dict(ledger))

    def get_run_summary(self, run_id):
        self.summary_lookups.append(run_id)
        summary = dict(self._summary)
        summary["runId"] = run_id
        return summary

    def summary_uri(self, run_id):
        return f"{self.base_url}/v0/runs/{run_id}/summary"


def _required_step_names_in(payload: list[dict]) -> set[str]:
    return {entry["name"] for entry in payload}


class StepProgressContractTests(unittest.TestCase):
    """Step-level progress is recorded for UI-started runs."""

    def _runner(self, gateway, *, learning=None):
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-test")
        # noinspection PyProtectedMemberInspection
        config = W0WorkflowRunnerTests._base_config()
        runner = W0WorkflowRunner(
            config=config,
            gateway=gateway,
            artifact_store=store,
            experience_learning=learning,
        )
        return runner

    def test_successful_run_records_required_steps_with_timestamps(self):
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        learning = _StubExperienceLearning()
        runner = self._runner(gateway, learning=learning)
        context = W0RunContext(
            run_id="run-prog-1",
            workflow_id="w0-migration-v0",
            requester="ui",
            evidence_refs=[],
            model_prompt=None,
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        steps = runner.progress_payload("run-prog-1")
        names = _required_step_names_in(steps)
        # Issue #96: required pipeline steps must all be present.
        for required in REQUIRED_RUN_STEP_NAMES:
            self.assertIn(required, names, f"missing required step {required}")
        self.assertIn(STEP_ACCEPTED, names)
        self.assertIn(STEP_COMPLETED, names)
        # No model prompt → skipped marker present, model-guidance absent.
        self.assertIn(STEP_MODEL_POLICY_SKIPPED, names)
        self.assertNotIn("model-guidance", names)
        # Every step exposes the contract fields.
        for entry in steps:
            self.assertIn("stepId", entry)
            self.assertIn("name", entry)
            self.assertIn("status", entry)
            self.assertIn("capabilityId", entry)
            self.assertIn("service", entry)
            self.assertIn("actor", entry)
            self.assertIn("startedAt", entry)
        # Required pipeline steps recorded as `ok` and have inputRef/outputRef.
        for entry in steps:
            if entry["name"] in REQUIRED_RUN_STEP_NAMES:
                self.assertEqual(entry["status"], STEP_STATUS_OK, entry)
                self.assertIn("inputRef", entry, entry)
                self.assertIn("outputRef", entry, entry)
                self.assertIn("finishedAt", entry, entry)

    def test_failed_capability_records_step_with_diagnostic(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), responses)
        original_invoke = gateway.invoke_capability

        def invoke_with_generator_failure(capability, payload):
            if capability["id"] == "java.generator":
                raise HarnessFailure(503, "generator backend unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke_with_generator_failure
        learning = _StubExperienceLearning()
        runner = self._runner(gateway, learning=learning)
        context = W0RunContext(
            run_id="run-prog-2",
            workflow_id="w0-migration-v0",
            requester="ui",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        steps = runner.progress_payload("run-prog-2")
        by_name = {entry["name"]: entry for entry in steps}
        # The failing step is recorded with status=failed and a diagnostic.
        self.assertEqual(by_name["generate-java"]["status"], STEP_STATUS_FAILED)
        self.assertIn("diagnostic", by_name["generate-java"])
        self.assertIn("generator", by_name["generate-java"]["diagnostic"].lower())
        # The terminal `failed` marker is added so consumers cannot mistake the
        # run for a success, and the run never reaches `completed`.
        self.assertIn(STEP_FAILED, by_name)
        self.assertEqual(by_name[STEP_FAILED]["status"], STEP_STATUS_FAILED)
        self.assertNotIn(STEP_COMPLETED, by_name)
        # Pipeline steps after the failure are absent (they never ran).
        self.assertNotIn("compile-test-java", by_name)
        self.assertNotIn("write-evidence", by_name)


class ExperienceLearningForwardingTests(unittest.TestCase):
    """Harness events and trajectory ledgers are forwarded to EL on completion."""

    def _runner(self, gateway, learning):
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-test")
        # noinspection PyProtectedMemberInspection
        config = W0WorkflowRunnerTests._base_config()
        return W0WorkflowRunner(
            config=config,
            gateway=gateway,
            artifact_store=store,
            experience_learning=learning,
        )

    def test_successful_run_forwards_events_and_trajectory_to_learning(self):
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        learning = _StubExperienceLearning()
        runner = self._runner(gateway, learning)
        context = W0RunContext(
            run_id="run-flush-1",
            workflow_id="w0-migration-v0",
            requester="ui",
            evidence_refs=[],
        )

        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        # Issue #96: a single batched flush at the end of the run is enough.
        self.assertEqual(len(learning.harness_event_batches), 1)
        forwarded = learning.harness_event_batches[0]
        forwarded_run_ids = {event["runId"] for event in forwarded}
        self.assertEqual(forwarded_run_ids, {"run-flush-1"})
        forwarded_event_ids = {event["eventId"] for event in forwarded}
        # Each event has a stable id derived from the run + step counter.
        for event_id in forwarded_event_ids:
            self.assertTrue(event_id.startswith("orch-run-flush-1-"), event_id)
        # Trajectory ledger forwarded once.
        self.assertEqual(len(learning.trajectory_ledgers), 1)
        self.assertEqual(learning.trajectory_ledgers[0].get("runId"), "run-flush-1")

    def test_failed_run_still_forwards_events_to_learning(self):
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = StubGateway(W0WorkflowRunnerTests._base_capabilities(), responses)
        original_invoke = gateway.invoke_capability

        def invoke_with_evidence_failure(capability, payload):
            if capability["id"] == "evidence.writer":
                raise HarnessFailure(503, "evidence backend unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke_with_evidence_failure
        learning = _StubExperienceLearning()
        runner = self._runner(gateway, learning)
        context = W0RunContext(
            run_id="run-flush-2",
            workflow_id="w0-migration-v0",
            requester="ui",
            evidence_refs=[],
        )

        with self.assertRaises(StepExecutionError):
            runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        # The orchestrator still flushes whatever events it observed so the
        # EL pattern detector can see the failure trail (no ledger because
        # the run failed before fetch).
        self.assertEqual(len(learning.harness_event_batches), 1)
        self.assertGreater(len(learning.harness_event_batches[0]), 0)


class EvidencePackReferencesLearningTests(unittest.TestCase):
    """The Evidence Pack must reference the experience-learning summary URI."""

    def test_evidence_input_includes_experience_learning_summary_ref(self):
        from orchestrator_service.experience import ExperienceLearningGateway
        from orchestrator_service.client import HttpResponse

        captured: dict[str, object] = {}

        # noinspection PyClassHasNoInitInspection
        class _CapturingHttp:
            @staticmethod
            # noinspection PyUnusedLocal
            def post_json(url, payload, headers=None):
                captured["post_url"] = url
                captured["post_payload"] = payload
                return HttpResponse(201, {"ok": True})

            @staticmethod
            # noinspection PyUnusedLocal
            def get_json(url, headers=None):
                captured["get_url"] = url
                return HttpResponse(404, None)

        learning = ExperienceLearningGateway("http://el.test", _CapturingHttp())
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        store_dir = tempfile.TemporaryDirectory()
        self.addCleanup(store_dir.cleanup)
        store = RunArtifactStore(store_dir.name, created_by="orchestrator-test")
        runner = W0WorkflowRunner(
            config=W0WorkflowRunnerTests._base_config(),
            gateway=gateway,
            artifact_store=store,
            experience_learning=learning,
        )
        context = W0RunContext(
            run_id="run-evpkg-1",
            workflow_id="w0-migration-v0",
            requester="ui",
            evidence_refs=[],
        )
        runner.run(context=context, input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."})

        evidence_call = next(
            entry for entry in gateway.calls if entry[0] == "invoke" and entry[1] == "evidence.writer"
        )
        artifacts = evidence_call[2]["artifacts"]
        self.assertIn("experienceEvents", artifacts)
        learning_ref = artifacts["experienceEvents"][0]
        self.assertTrue(learning_ref["uri"].endswith("/v0/runs/run-evpkg-1/summary"))
        self.assertEqual(len(learning_ref["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
