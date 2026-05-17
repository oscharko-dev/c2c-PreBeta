"""Unit tests for HarnessGateway transport behavior."""

from __future__ import annotations

import unittest

from orchestrator_service.client import HttpResponse
from orchestrator_service.harness import HarnessGateway


class HarnessGatewayTests(unittest.TestCase):
    def test_capability_invocation_does_not_forward_harness_control_headers(self) -> None:
        calls: list[tuple[str, dict[str, str]]] = []

        class CapturingHttp:
            @staticmethod
            def post_json(url, payload, headers=None):
                calls.append((url, dict(headers or {})))
                if url.endswith("/v0/runs"):
                    return HttpResponse(201, {"runId": "run-1"})
                return HttpResponse(200, {"status": "ok"})

        gateway = HarnessGateway(
            "http://harness.test",
            CapturingHttp(),
            harness_headers={"Authorization": "Bearer harness-control-token"},
        )

        gateway.create_run("workflow-v0")
        gateway.invoke_capability(
            {"id": "cobol.parse", "endpoint": "http://parser.test/v0/parse"},
            {"sourceText": "IDENTIFICATION DIVISION."},
        )

        self.assertEqual(calls[0], (
            "http://harness.test/v0/runs",
            {"Authorization": "Bearer harness-control-token"},
        ))
        self.assertEqual(calls[1], ("http://parser.test/v0/parse", {}))


if __name__ == "__main__":
    unittest.main()
