"""Harness gateway client used by orchestrator workflow."""

from __future__ import annotations

import json
import urllib.parse
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, Optional

from .client import JSONHTTPClient


@dataclass
class HarnessFailure(Exception):
    status: int
    details: str


@dataclass(frozen=True)
class DataReference:
    uri: str
    sha256: str
    byte_size: int


    def build_reference(uri: str, payload: Any) -> DataReference:
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        return DataReference(uri=uri, sha256=sha256(raw).hexdigest(), byte_size=len(raw))


class HarnessGateway:
    def __init__(self, base_url: str, http: JSONHTTPClient):
        if not base_url:
            raise ValueError("harness base URL is required")
        self.base_url = base_url.rstrip("/")
        self.http = http

    def create_run(self, workflow_id: str, requester: str = "orchestrator", evidence_refs=None) -> Dict[str, Any]:
        if evidence_refs is None:
            evidence_refs = []
        payload: Dict[str, Any] = {
            "workflowId": workflow_id,
            "requester": requester,
            "evidenceRefs": list(evidence_refs),
        }
        resp = self.http.post_json(f"{self.base_url}/v0/runs", payload)
        if resp.status != 201:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict) or "runId" not in resp.payload:
            raise ValueError("invalid run create response")
        return resp.payload

    def update_run(
        self,
        run_id: str,
        status: str,
        *,
        updated_by: str = "orchestrator",
        message: str = "",
        evidence_refs: Optional[list[str]] = None,
        policy_decision: str = "policy allow",
    ) -> Dict[str, Any]:
        if not run_id:
            raise ValueError("run_id is required")
        payload: Dict[str, Any] = {
            "status": status,
            "updatedBy": updated_by,
            "message": message,
            "evidenceRefs": list(evidence_refs or []),
            "policyDecision": policy_decision,
        }
        resp = self.http.patch_json(f"{self.base_url}/v0/runs/{urllib.parse.quote(run_id)}", payload)
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid run update response")
        return resp.payload

    def get_run(self, run_id: str) -> Dict[str, Any]:
        if not run_id:
            raise ValueError("run_id is required")
        resp = self.http.get_json(f"{self.base_url}/v0/runs/{urllib.parse.quote(run_id)}")
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid run state response")
        return resp.payload

    def get_capability(self, capability_id: str) -> Dict[str, Any]:
        if not capability_id:
            raise ValueError("capability_id is required")
        resp = self.http.get_json(f"{self.base_url}/v0/capabilities/{urllib.parse.quote(capability_id)}")
        if resp.status != 200:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid capability response")
        return resp.payload

    def invoke_capability(self, capability: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
        endpoint = str(capability.get("endpoint", "")).strip()
        if not endpoint:
            raise ValueError("capability endpoint is required")
        resp = self.http.post_json(endpoint, payload)
        if resp.status not in (200, 201):
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid capability response")
        return resp.payload

    def post_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        if "schemaVersion" not in event:
            event = dict(event)
            event["schemaVersion"] = "v0"
        resp = self.http.post_json(f"{self.base_url}/v0/events", event)
        if resp.status != 201:
            raise HarnessFailure(resp.status, str(resp.payload))
        if not isinstance(resp.payload, dict):
            raise ValueError("invalid event response")
        return resp.payload
