"""Unit tests for orchestrator configuration."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from orchestrator_service.config import load_config


class OrchestratorConfigTests(unittest.TestCase):
    def test_default_capabilities_include_model_gateway(self):
        with patch.dict(os.environ, {}, clear=True):
            config = load_config()

        capability_ids = {capability["id"] for capability in config.w0_capabilities}
        self.assertIn("source-reference.execute", capability_ids)
        self.assertIn("model-gateway", capability_ids)
        self.assertEqual(config.listen_addr, "127.0.0.1:8084")
        self.assertEqual(config.model_gateway_model_id, "gpt-oss-120b")
        self.assertEqual(config.model_policy_version, "v0")
        self.assertEqual(config.source_reference_capability_id, "source-reference.execute")

    def test_port_only_listen_addr_normalizes_to_loopback(self):
        with patch.dict(os.environ, {"ORCHESTRATOR_LISTEN_ADDR": ":18088"}, clear=True):
            config = load_config()

        self.assertEqual(config.listen_addr, "127.0.0.1:18088")

    def test_control_tokens_can_be_configured(self):
        with patch.dict(
            os.environ,
            {
                "ORCHESTRATOR_CONTROL_TOKEN": "orchestrator-token",
                "ORCHESTRATOR_CAPABILITY_CONTROL_TOKEN": "capability-token",
            },
            clear=True,
        ):
            config = load_config()

        self.assertEqual(config.control_token, "orchestrator-token")
        self.assertEqual(config.capability_control_token, "capability-token")

    def test_model_gateway_endpoint_model_id_and_policy_version_can_be_overridden(self):
        with patch.dict(
            os.environ,
            {
                "ORCHESTRATOR_MODEL_GATEWAY_CAPABILITY_ENDPOINT": "http://127.0.0.1:9999/v0/invoke",
                "ORCHESTRATOR_MODEL_GATEWAY_MODEL_ID": "phi-4",
                "ORCHESTRATOR_MODEL_POLICY_VERSION": "v2",
            },
            clear=True,
        ):
            config = load_config()

        model_gateway = next(
            capability for capability in config.w0_capabilities
            if capability["id"] == "model-gateway"
        )
        self.assertEqual(model_gateway["endpoint"], "http://127.0.0.1:9999/v0/invoke")
        self.assertEqual(config.model_gateway_model_id, "phi-4")
        self.assertEqual(config.model_policy_version, "v2")

    def test_repair_agent_defaults_when_no_env_overrides(self):
        with patch.dict(os.environ, {}, clear=True):
            config = load_config()
        self.assertEqual(
            config.repair_agent_prompt_template_id,
            "c2c.verification-repair-agent.cobol-to-java.v0",
        )
        self.assertEqual(config.repair_agent_prompt_template_version, "v0")
        self.assertEqual(config.repair_agent_deadline_ms, 60000)
        self.assertEqual(config.repair_agent_max_output_bytes, 0)
        # By default the repair agent reuses the transformation agent's
        # package base.
        self.assertEqual(
            config.repair_agent_package_base, config.transformation_agent_package_base
        )
        # No dedicated model id by default; the runner falls back to the
        # global model gateway model id at invocation time.
        self.assertEqual(config.repair_agent_model_id, "")

    def test_repair_agent_env_overrides(self):
        with patch.dict(
            os.environ,
            {
                "ORCHESTRATOR_REPAIR_AGENT_PROMPT_TEMPLATE_ID": "custom.repair.v1",
                "ORCHESTRATOR_REPAIR_AGENT_PROMPT_TEMPLATE_VERSION": "v1",
                "ORCHESTRATOR_REPAIR_AGENT_DEADLINE_MS": "45000",
                "ORCHESTRATOR_REPAIR_AGENT_MAX_OUTPUT_BYTES": "65536",
                "ORCHESTRATOR_REPAIR_AGENT_PACKAGE_BASE": "com.example.repaired",
                "ORCHESTRATOR_REPAIR_AGENT_MODEL_ID": "phi-4",
            },
            clear=True,
        ):
            config = load_config()
        self.assertEqual(config.repair_agent_prompt_template_id, "custom.repair.v1")
        self.assertEqual(config.repair_agent_prompt_template_version, "v1")
        self.assertEqual(config.repair_agent_deadline_ms, 45000)
        self.assertEqual(config.repair_agent_max_output_bytes, 65536)
        self.assertEqual(config.repair_agent_package_base, "com.example.repaired")
        self.assertEqual(config.repair_agent_model_id, "phi-4")

    def test_repair_agent_invalid_deadline_falls_back_to_default(self):
        with patch.dict(
            os.environ,
            {"ORCHESTRATOR_REPAIR_AGENT_DEADLINE_MS": "0"},
            clear=True,
        ):
            config = load_config()
        self.assertEqual(config.repair_agent_deadline_ms, 60000)


if __name__ == "__main__":
    unittest.main()
