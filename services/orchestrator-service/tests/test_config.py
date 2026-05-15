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
        self.assertIn("model-gateway", capability_ids)
        self.assertEqual(config.model_gateway_model_id, "gpt-oss-120b")
        self.assertEqual(config.model_policy_version, "v0")

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


if __name__ == "__main__":
    unittest.main()
