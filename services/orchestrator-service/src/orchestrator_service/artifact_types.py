"""TypedDicts for well-known artifact shapes owned by orchestrator-service.

These types describe the JSON structures written by the artifact store for
kinds defined in artifacts.py. Import these in callers that need to narrow
the generic JsonObject type to a concrete shape.
"""

from __future__ import annotations

from typing import TypedDict

from orchestrator_service.artifacts import JsonObject


class ArtifactEntryDict(TypedDict):
    uri: str
    sha256: str
    byteSize: int
    mimeType: str
    kind: str
    createdBy: str
    createdAt: str
    runId: str
    workflowId: str
    path: str
    name: str


class ArtifactIndexDict(TypedDict):
    runId: str
    workflowId: str
    requester: str
    createdAt: str
    artifacts: list[ArtifactEntryDict]


class ModelPolicySkippedDict(TypedDict):
    reason: str
    createdAt: str


class RunProgressDict(TypedDict):
    runId: str
    workflowId: str
    status: str
    phase: str
    updatedAt: str


class LearningEventDict(TypedDict):
    runId: str
    workflowId: str
    status: str


class ModelInvocationRef(TypedDict):
    uri: str
    sha256: str
    byteSize: int
