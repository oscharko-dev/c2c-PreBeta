"""Harness gateway client used by orchestrator workflow."""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Any

from .client import JSONHTTPClient


# noinspection PyClassHasNoInitInspection
@dataclass
class HarnessFailure(Exception):
    status: int
    details: str


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class DataReference:
    uri: str
    sha256: str
    byte_size: int


class HarnessGateway:
    def __init__(self, base_url: str, http: JSONHTTPClient, harness_headers: Mapping[str, str] | None = None):
        if not base_url:
            raise ValueError("harness base URL is required")
        self.base_url = base_url.rstrip("/")
        self.http = http
        self.harness_headers = dict(harness_headers or {})

    def create_run(self, workflow_id: str, requester: str = "orchestrator", evidence_refs=None) -> dict[str, Any]:
        if evidence_refs is None:
            evidence_refs = []
        payload: dict[str, Any] = {
            "workflowId": workflow_id,
            "requester": requester,
            "evidenceRefs": list(evidence_refs),
        }
        resp = self.http.post_json(f"{self.base_url}/v0/runs", payload, headers=self.harness_headers)
        if resp.status != 201:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict) or "runId" not in resp.payload:
            raise ValueError("invalid run create response")
        return resp.payload

    def register_capability(self, capability: Mapping[str, Any]) -> dict[str, Any]:
        payload = {
            "callerRole": "orchestrator",
            "capability": dict(capability),
        }
        resp = self.http.post_json(f"{self.base_url}/v0/capabilities", payload, headers=self.harness_headers)
        if resp.status not in (200, 201):
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid capability registration response")
        return resp.payload

    def get_trajectory_ledger(self, run_id: str) -> dict[str, Any]:
        if not run_id:
            raise ValueError("run_id is required")
        resp = self.http.get_json(f"{self.base_url}/v0/runs/{urllib.parse.quote(run_id)}/ledger", headers=self.harness_headers)
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid trajectory ledger response")
        return resp.payload

    def update_run(
        self,
        run_id: str,
        status: str,
        *,
        updated_by: str = "orchestrator",
        message: str = "",
        evidence_refs: list[str] | None = None,
        policy_decision: str = "policy allow",
    ) -> dict[str, Any]:
        if not run_id:
            raise ValueError("run_id is required")
        payload: dict[str, Any] = {
            "status": status,
            "updatedBy": updated_by,
            "message": message,
            "evidenceRefs": list(evidence_refs or []),
            "policyDecision": policy_decision,
        }
        resp = self.http.patch_json(f"{self.base_url}/v0/runs/{urllib.parse.quote(run_id)}", payload, headers=self.harness_headers)
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid run update response")
        return resp.payload

    def get_run(self, run_id: str) -> dict[str, Any]:
        if not run_id:
            raise ValueError("run_id is required")
        resp = self.http.get_json(f"{self.base_url}/v0/runs/{urllib.parse.quote(run_id)}")
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid run state response")
        return resp.payload

    def get_capability(self, capability_id: str) -> dict[str, Any]:
        if not capability_id:
            raise ValueError("capability_id is required")
        resp = self.http.get_json(f"{self.base_url}/v0/capabilities/{urllib.parse.quote(capability_id)}")
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid capability response")
        return resp.payload

    def invoke_capability(self, capability: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        endpoint = str(capability.get("endpoint", "")).strip()
        if not endpoint:
            raise ValueError("capability endpoint is required")
        resp = self.http.post_json(endpoint, payload)
        if resp.status not in (200, 201):
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid capability response")
        return resp.payload

    def post_event(self, event: dict[str, Any]) -> dict[str, Any]:
        if "schemaVersion" not in event:
            event = dict(event)
            event["schemaVersion"] = "v0"
        resp = self.http.post_json(f"{self.base_url}/v0/events", event, headers=self.harness_headers)
        if resp.status != 201:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid event response")
        return resp.payload
