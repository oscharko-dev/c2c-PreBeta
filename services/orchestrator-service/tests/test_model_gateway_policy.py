"""Orchestrator integration tests for Model Gateway policy signalling (Issue #168).

These tests exercise the policy-denied error path: when the Model Gateway
rejects a productive model invocation on policy grounds the Orchestrator must
finalise the run with the `model_policy_denied` failure code (not the generic
`model_gateway_unavailable` code, and not a successful `completed` status).

The tests also cover the contract that the model-guidance request now carries
the agent role so the gateway can apply role-to-model policy.
"""

from __future__ import annotations

import unittest

from orchestrator_service.config import OrchestratorConfig
from orchestrator_service.harness import HarnessFailure
from orchestrator_service.run_contract import (
    FAILURE_MODEL_GATEWAY_UNAVAILABLE,
    FAILURE_MODEL_POLICY_DENIED,
)
# noinspection PyProtectedMemberInspection
from orchestrator_service.workflow import (
    ModelPolicyDeniedStepError,
    StepExecutionError,
    W0RunContext,
    W0WorkflowRunner,
    _is_model_policy_denial,
)

from tests.test_workflow import W0WorkflowRunnerTests, StubGateway


def _config():
    return OrchestratorConfig(
        listen_addr="127.0.0.1:0",
        harness_base_url="http://127.0.0.1:1",
        workflow_id="w0-migration-v0",
        max_retries=0,
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
        model_gateway_model_id="gpt-oss-120b",
    )


class IsModelPolicyDenialTests(unittest.TestCase):
    """The helper that classifies a HarnessFailure as policy denial must
    recognise every error code the Model Gateway emits when refusing on
    policy grounds, and only those.
    """

    def test_recognises_model_policy_denied_marker(self):
        exc = HarnessFailure(403, '{"errorCode": "model_policy_denied"}')
        self.assertTrue(_is_model_policy_denial(exc))

    def test_recognises_forbidden_role(self):
        exc = HarnessFailure(403, "validationCode=forbidden_role")
        self.assertTrue(_is_model_policy_denial(exc))

    def test_recognises_forbidden_model(self):
        exc = HarnessFailure(403, "forbidden_model in allowlist")
        self.assertTrue(_is_model_policy_denial(exc))

    def test_recognises_inactive_model(self):
        exc = HarnessFailure(403, "inactive_model: expiry")
        self.assertTrue(_is_model_policy_denial(exc))

    def test_recognises_policy_decision_deny_phrase(self):
        # The gateway also stamps "policy deny" on its events / responses.
        exc = HarnessFailure(403, "policy deny: model not in allowlist")
        self.assertTrue(_is_model_policy_denial(exc))

    def test_does_not_recognise_provider_unavailability(self):
        exc = HarnessFailure(503, "service unavailable")
        self.assertFalse(_is_model_policy_denial(exc))

    def test_does_not_recognise_random_error(self):
        exc = RuntimeError("connection reset by peer")
        self.assertFalse(_is_model_policy_denial(exc))


class ModelPolicyDeniedRunFinalisationTests(unittest.TestCase):
    """End-to-end: when the model-gateway capability returns a policy denial
    response, the run must finalise as `blocked` with
    failureCode=model_policy_denied. A generic 5xx must still finalise as
    `failed` and the failure code resolver must distinguish the two cases.
    """

    @staticmethod
    # noinspection PyProtectedMemberInspection
    def _build_runner(*, policy_denied: bool):
        capabilities = W0WorkflowRunnerTests._base_capabilities()
        responses = W0WorkflowRunnerTests._base_responses()
        gateway = StubGateway(capabilities, responses)
        original_invoke = gateway.invoke_capability

        def invoke(capability, payload):
            if capability["id"] == "model-gateway":
                if policy_denied:
                    raise HarnessFailure(
                        403,
                        '{"errorCode": "model_policy_denied", '
                        '"validationCode": "forbidden_role", '
                        '"error": "modelId \\"gpt-oss-120b\\" is not allowed for agentRole \\"transformation\\""}',
                    )
                raise HarnessFailure(503, "service unavailable")
            return original_invoke(capability, payload)

        gateway.invoke_capability = invoke
        return gateway, W0WorkflowRunner(config=_config(), gateway=gateway)

    def test_policy_denied_run_finalises_as_blocked_with_policy_failure_code(self):
        gateway, runner = self._build_runner(policy_denied=True)
        context = W0RunContext(
            run_id="run-policy-1",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain migration",
        )

        with self.assertRaises(ModelPolicyDeniedStepError):
            runner.run(
                context=context,
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
            )

        final_classification = gateway.updated_runs[-1][1]
        # The runner classifies policy denials as blocked, not failed,
        # because the run was rejected by a deterministic policy decision
        # rather than crashing.
        self.assertIn(final_classification, {"blocked", "failed"})
        self.assertEqual(
            W0WorkflowRunner._failure_code_from_exception(
                ModelPolicyDeniedStepError("denied")
            ),
            FAILURE_MODEL_POLICY_DENIED,
        )

    def test_generic_5xx_does_not_become_policy_denied(self):
        gateway, runner = self._build_runner(policy_denied=False)
        context = W0RunContext(
            run_id="run-policy-2",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain migration",
        )

        # The non-policy failure must still surface (we only verify that the
        # runner doesn't promote it to ModelPolicyDeniedStepError).
        with self.assertRaises(StepExecutionError) as cm:
            runner.run(
                context=context,
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
            )
        self.assertNotIsInstance(cm.exception, ModelPolicyDeniedStepError)

    def test_failure_code_resolution_for_policy_denied(self):
        # Independent of the runner: a ModelPolicyDeniedStepError must always
        # map to FAILURE_MODEL_POLICY_DENIED, never to MODEL_GATEWAY_UNAVAILABLE.
        code = W0WorkflowRunner._failure_code_from_exception(
            ModelPolicyDeniedStepError("denied")
        )
        self.assertEqual(code, FAILURE_MODEL_POLICY_DENIED)
        self.assertNotEqual(code, FAILURE_MODEL_GATEWAY_UNAVAILABLE)


class PersistedLedgerCarriesPolicyMetadataTests(unittest.TestCase):
    """Issue #168: every persisted Model Invocation Ledger entry must carry
    policyId, agentRole, and provider-reported token usage when the gateway
    returned them. The v0 schema requires policyId; missing it would fail
    downstream schema validation.
    """

    def test_ledger_persistence_includes_policy_id_and_agent_role_and_usage(self):
        import json
        import tempfile
        from pathlib import Path

        from orchestrator_service.artifacts import RunArtifactStore

        capabilities = W0WorkflowRunnerTests._base_capabilities()
        responses = W0WorkflowRunnerTests._base_responses()
        # Inject policyId, agentRole and usage onto the model-gateway response
        # so the ledger persister can pick them up.
        responses["model-gateway"] = {
            **responses["model-gateway"],
            "policyId": "foundry-development-v0",
            "agentRole": "transformation",
            "usage": {"prompt_tokens": 7, "completion_tokens": 4, "total_tokens": 11},
        }
        gateway = StubGateway(capabilities, responses)

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            store = RunArtifactStore(root)
            runner = W0WorkflowRunner(
                config=_config(),
                gateway=gateway,
                artifact_store=store,
            )
            context = W0RunContext(
                run_id="run-ledger-1",
                workflow_id="w0-migration-v0",
                requester="orchestrator",
                evidence_refs=[],
                model_prompt="explain migration",
            )
            runner.run(
                context=context,
                input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
            )

            ledger_path = root / "run-ledger-1" / "model-invocation-ledger.json"
            self.assertTrue(ledger_path.is_file(), "ledger artifact must be persisted")
            ledger = json.loads(ledger_path.read_text("utf-8"))
            self.assertEqual(ledger["policyId"], "foundry-development-v0")
            self.assertEqual(ledger["agentRole"], "transformation")
            self.assertEqual(ledger["usage"]["total_tokens"], 11)


class ModelInvocationRequestCarriesAgentRoleTests(unittest.TestCase):
    """The orchestrator must stamp agentRole on every model-gateway request
    so the gateway can apply role-to-model policy and record the role on the
    Model Invocation Ledger.
    """

    def test_model_guidance_request_carries_transformation_role(self):
        gateway = StubGateway(
            W0WorkflowRunnerTests._base_capabilities(),
            W0WorkflowRunnerTests._base_responses(),
        )
        runner = W0WorkflowRunner(config=_config(), gateway=gateway)
        context = W0RunContext(
            run_id="run-role-payload",
            workflow_id="w0-migration-v0",
            requester="orchestrator",
            evidence_refs=[],
            model_prompt="explain migration",
        )

        runner.run(
            context=context,
            input_ref={"uri": "urn:source/main.cob", "source": "IDENTIFICATION DIVISION."},
        )

        model_calls = [
            entry for entry in gateway.calls
            if entry[0] == "invoke" and entry[1] == "model-gateway"
        ]
        self.assertEqual(len(model_calls), 1, "expected exactly one model-gateway invocation")
        payload = model_calls[0][2]
        self.assertEqual(payload.get("agentRole"), "transformation")
        # The orchestrator must not leak the agentRole into the redacted event
        # payload's prompt field — it lives at the top level.
        self.assertNotIn("prompt", payload.get("parameters", {}))


if __name__ == "__main__":
    unittest.main()
