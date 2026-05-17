"""Unit tests for HarnessGateway transport behavior."""

from __future__ import annotations

import unittest

from orchestrator_service.client import HttpResponse
from orchestrator_service.harness import HarnessGateway


class HarnessGatewayTests(unittest.TestCase):
    def test_capability_invocation_uses_internal_token_not_harness_token(self) -> None:
        calls: list[tuple[str, dict[str, str], int | None]] = []

        class CapturingHttp:
            @staticmethod
            def post_json(url, payload, headers=None, timeout_seconds=None):
                calls.append((url, dict(headers or {}), timeout_seconds))
                if url.endswith("/v0/runs"):
                    return HttpResponse(201, {"runId": "run-1"})
                return HttpResponse(200, {"status": "ok"})

        gateway = HarnessGateway(
            "http://harness.test",
            CapturingHttp(),
            harness_headers={"Authorization": "Bearer harness-control-token"},
            capability_headers={"Authorization": "Bearer internal-capability-token"},
        )

        gateway.create_run("workflow-v0")
        gateway.invoke_capability(
            {"id": "cobol.parse", "endpoint": "http://parser.test/v0/parse"},
            {"sourceText": "IDENTIFICATION DIVISION.", "timeoutMs": 60000},
        )

        self.assertEqual(calls[0], (
            "http://harness.test/v0/runs",
            {"Authorization": "Bearer harness-control-token"},
            None,
        ))
        self.assertEqual(calls[1], (
            "http://parser.test/v0/parse",
            {"Authorization": "Bearer internal-capability-token"},
            65,
        ))


if __name__ == "__main__":
    unittest.main()
