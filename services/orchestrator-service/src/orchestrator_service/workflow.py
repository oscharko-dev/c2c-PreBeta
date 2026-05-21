"""Workflow orchestration for the first W0 Harness consumer."""

from __future__ import annotations

import datetime
import difflib
import json
import re
import threading
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from collections.abc import Mapping, Sequence
from typing import Any


def _iso_now() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")

from .agent_contracts import (
    AgentContractInvalidError,
    guard_agent_response,
)
from .artifacts import (
    KIND_BUILD_TEST_RESULT,
    KIND_EVIDENCE_PACK_MANIFEST,
    KIND_GENERATED_PROJECT_FILE,
    KIND_GENERATED_PROJECT_MANIFEST,
    KIND_GENERATION_RESPONSE,
    KIND_MANUAL_EDIT_OVERLAY,
    KIND_MODEL_INVOCATION_LEDGER,
    KIND_MODEL_POLICY_SKIPPED,
    KIND_PARSE_OUTPUT,
    KIND_RUN_PROGRESS,
    KIND_SEMANTIC_IR,
    KIND_SEMANTIC_IR_OUTPUT,
    KIND_SOURCE,
    KIND_SOURCE_REF,
    KIND_TRAJECTORY_LEDGER,
    KIND_W02_RUN_CONTRACT,
    MIME_JAVA,
    ArtifactMetadata,
    JsonObject,
    JsonValue,
    NullArtifactStore,
    RunArtifactStore,
)
from . import region_classification
from .config import OrchestratorConfig
from .experience import ExperienceLearningGateway, NullExperienceLearningGateway
from .harness import DataReference, HarnessFailure, HarnessGateway
from .repair_agent import (
    REFUSAL_TO_FAILURE_CODE as REPAIR_REFUSAL_TO_FAILURE_CODE,
    RepairAgent,
    RepairAgentContractInvalidError,
    RepairAgentError,
    RepairAgentGatewayUnavailableError,
    RepairAgentPolicyDeniedError,
    RepairAgentRequest,
    RepairAgentResult,
    RepairAgentTimeoutError,
    should_manual_region_block_repair,
)
from .transformation_agent import (
    AgentContractInvalidAgentError,
    AgentTimeoutError,
    HarnessModelGatewayInvoker,
    ModelGatewayInvoker,
    ModelGatewayUnavailableError,
    ModelPolicyDeniedAgentError,
    TransformationAgent,
    TransformationAgentRequest,
    TransformationAgentResult,
    _validate_model_gateway_capability,
)
from . import run_contract as w02
from .run_contract import (
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_FAILED,
    CLASSIFICATION_INCOMPLETE,
    CLASSIFICATION_SUCCESS,
    FAILURE_AGENT_CONTRACT_INVALID,
    FAILURE_AGENT_TIMEOUT,
    FAILURE_EVIDENCE_INCOMPLETE,
    FAILURE_GENERATE_ONLY_COMPLETE,
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_SOURCE_REFERENCE_FAILED,
    FAILURE_MODEL_GATEWAY_UNAVAILABLE,
    FAILURE_MODEL_POLICY_DENIED,
    FAILURE_JAVA_RUNTIME_FAILED,
    FAILURE_ORACLE_MISMATCH,
    FAILURE_UNSUPPORTED_COBOL,
    IllegalTransitionError,
    ModelInvocationBudgetExhaustedError,
    RepairBudgetExhaustedError,
    STEP_COMPILE_TEST_JAVA as W02_STEP_COMPILE_TEST_JAVA,
    STEP_FINALIZE as W02_STEP_FINALIZE,
    STEP_GENERATE_IR as W02_STEP_GENERATE_IR,
    STEP_GENERATE_JAVA as W02_STEP_GENERATE_JAVA,
    STEP_NORMALIZE_SOURCE as W02_STEP_NORMALIZE_SOURCE,
    STEP_PARSE_COBOL as W02_STEP_PARSE_COBOL,
    STEP_ASSIST_DECISION as W02_STEP_ASSIST_DECISION,
    STEP_TRANSFORMATION_AGENT as W02_STEP_TRANSFORMATION_AGENT,
    STEP_VERIFICATION_REPAIR_AGENT as W02_STEP_VERIFICATION_REPAIR_AGENT,
    STEP_WRITE_EVIDENCE as W02_STEP_WRITE_EVIDENCE,
    ASSIST_AGENT_ROLE_TRANSFORMATION,
    ASSIST_OUTCOME_NOT_REQUIRED,
    ASSIST_OUTCOME_REQUIRED,
    ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED,
    ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
    ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
    ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
    ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE,
    ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY,
    ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE,
    AssistDecision,
    SCHEMA_VERSION,
    STATE_BASELINE_GENERATION_ATTEMPTED,
    STATE_BUILD_TEST_RUNNING,
    STATE_COBOL_PARSE_ATTEMPTED,
    STATE_EVIDENCE_INCOMPLETE,
    STATE_EVIDENCE_MATERIALIZED,
    STATE_FINAL_JAVA_SELECTED,
    STATE_JAVA_CANDIDATE_PERSISTED,
    STATE_RUN_BLOCKED,
    STATE_SEMANTIC_IR_BLOCKED,
    STATE_SEMANTIC_IR_READY,
    STATE_SOURCE_NORMALIZED,
    STATE_TRANSFORMATION_AGENT_INVOKED,
    STATE_VERIFICATION_REPAIR_INVOKED,
    STEP_TO_FAILURE_CODE,
    W02RunContract,
    build_test_outcome,
    new_run_contract,
)


class OrchestratorError(Exception):
    """Base class for orchestrator execution failures."""


_SHA256_HEX_CHARS = frozenset("0123456789abcdefABCDEF")


def _manual_overlay_field(prefix: str, index: int, field: str) -> str:
    return f"{prefix}[{index}].{field}"


def _required_manual_overlay_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise OrchestratorError(f"{field} is required")
    return value.strip()


_SAFE_MANUAL_OVERLAY_ID_PATTERN = re.compile(r"^[A-Za-z0-9._\-]{1,128}$")


def _required_manual_overlay_safe_id(value: Any, field: str) -> str:
    text = _required_manual_overlay_string(value, field)
    if not _SAFE_MANUAL_OVERLAY_ID_PATTERN.fullmatch(text):
        raise OrchestratorError(
            f"{field} must match ^[A-Za-z0-9._-]{{1,128}}$"
        )
    return text


def _required_manual_overlay_file_path(value: Any, field: str) -> str:
    text = _required_manual_overlay_string(value, field)
    if "\x00" in text:
        raise OrchestratorError(f"{field} must be a safe relative Java path")
    normalized = text.replace("\\", "/").strip().lstrip("/")
    if not normalized:
        raise OrchestratorError(f"{field} must be a safe relative Java path")
    parts = PurePosixPath(normalized).parts
    if any(segment in ("", ".", "..") for segment in parts):
        raise OrchestratorError(f"{field} must be a safe relative Java path")
    if not normalized.endswith(".java"):
        raise OrchestratorError(f"{field} must point at a .java file")
    return "/".join(parts)


def _required_manual_overlay_timestamp(value: Any, field: str) -> str:
    text = _required_manual_overlay_string(value, field)
    if "T" not in text:
        raise OrchestratorError(f"{field} must be an ISO8601 timestamp")
    try:
        datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise OrchestratorError(
            f"{field} must be an ISO8601 timestamp"
        ) from exc
    return text


def _required_manual_overlay_count(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise OrchestratorError(f"{field} must be an integer")
    if value < 1:
        raise OrchestratorError(f"{field} must be >= 1")
    return value


def _required_manual_overlay_author(value: Any, field: str) -> JsonObject:
    if not isinstance(value, Mapping):
        raise OrchestratorError(f"{field} must be an object")
    return {
        "userId": _required_manual_overlay_safe_id(
            value.get("userId"), f"{field}.userId"
        ),
        "tenantId": _required_manual_overlay_safe_id(
            value.get("tenantId"), f"{field}.tenantId"
        ),
    }


def _required_manual_overlay_line(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise OrchestratorError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    raise OrchestratorError(f"{field} must be an integer")


def _required_manual_overlay_hash(value: Any, field: str) -> str:
    text = _required_manual_overlay_string(value, field)
    if len(text) != 64 or any(char not in _SHA256_HEX_CHARS for char in text):
        raise OrchestratorError(f"{field} must be a SHA-256 hex digest")
    return text


def normalise_manual_edit_overlay_region(
    raw: Mapping[str, Any],
    *,
    index: int,
    default_file_path: Any = None,
    field_prefix: str = "manualOverlay.regions",
) -> JsonObject:
    """Return the Evidence-Pack body shape for one manual-edit overlay region.

    ADR 0007 §3 makes the provenance metadata part of the audit contract,
    not an optional decoration. The orchestrator therefore rejects incomplete
    regions before writing ``manual-edit-overlay.json``.
    """
    file_path_value = raw.get("filePath") or default_file_path
    file_path = _required_manual_overlay_file_path(
        file_path_value,
        _manual_overlay_field(field_prefix, index, "filePath"),
    )
    origin_class = _required_manual_overlay_string(
        raw.get("originClass"),
        _manual_overlay_field(field_prefix, index, "originClass"),
    )
    if origin_class not in w02.JAVA_REGION_ORIGIN_MANUAL_CLASSES:
        raise OrchestratorError(
            f"{_manual_overlay_field(field_prefix, index, 'originClass')} "
            f"must be one of {sorted(w02.JAVA_REGION_ORIGIN_MANUAL_CLASSES)}, "
            f"got {origin_class!r}"
        )

    line_range = raw.get("lineRange")
    if isinstance(line_range, Mapping):
        start_raw = line_range.get("startLine")
        end_raw = line_range.get("endLine")
    else:
        start_raw = raw.get("startLine")
        end_raw = raw.get("endLine")
    start_line = _required_manual_overlay_line(
        start_raw,
        _manual_overlay_field(field_prefix, index, "lineRange.startLine"),
    )
    end_line = _required_manual_overlay_line(
        end_raw,
        _manual_overlay_field(field_prefix, index, "lineRange.endLine"),
    )
    if start_line < 1 or end_line < start_line:
        raise OrchestratorError(
            f"{field_prefix}[{index}] has invalid line range "
            f"[{start_line}, {end_line}]"
        )

    region: JsonObject = {
        "filePath": file_path,
        "lineRange": {
            "startLine": start_line,
            "endLine": end_line,
        },
        "originClass": origin_class,
        "generatorBaselineRunId": _required_manual_overlay_string(
            raw.get("generatorBaselineRunId"),
            _manual_overlay_field(field_prefix, index, "generatorBaselineRunId"),
        ),
        "lastModifiedAt": _required_manual_overlay_timestamp(
            raw.get("lastModifiedAt"),
            _manual_overlay_field(field_prefix, index, "lastModifiedAt"),
        ),
        "lastModifiedBy": _required_manual_overlay_author(
            raw.get("lastModifiedBy"),
            _manual_overlay_field(field_prefix, index, "lastModifiedBy"),
        ),
        "manualEditCount": _required_manual_overlay_count(
            raw.get("manualEditCount"),
            _manual_overlay_field(field_prefix, index, "manualEditCount"),
        ),
    }

    if origin_class == w02.JAVA_REGION_ORIGIN_MANUAL_MODIFIED:
        region["generatorBaselineRegionHash"] = _required_manual_overlay_hash(
            raw.get("generatorBaselineRegionHash"),
            _manual_overlay_field(
                field_prefix, index, "generatorBaselineRegionHash"
            ),
        )
    elif raw.get("generatorBaselineRegionHash") not in (None, ""):
        raise OrchestratorError(
            f"{_manual_overlay_field(field_prefix, index, 'generatorBaselineRegionHash')} "
            "must be omitted for manual_edit regions"
        )
    return region


class CapabilityMissingError(OrchestratorError):
    """Raised when a required capability is unavailable."""

    def __init__(
        self,
        message: str,
        *,
        step_name: str | None = None,
        failure_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.step_name = step_name
        self.failure_code = failure_code


class StepExecutionError(OrchestratorError):
    """Raised when a workflow step cannot be completed."""


class AgentContractInvalidStepError(StepExecutionError):
    """Raised when a productive agent returned a payload that fails W0.2
    Agent I/O contract validation (Issue #167). Surfaces as the
    ``agent_contract_invalid`` failure code on the run contract.
    """


class ModelPolicyDeniedStepError(StepExecutionError):
    """Raised when the Model Gateway rejected a productive model invocation
    on policy grounds (Issue #168). Surfaces as the ``model_policy_denied``
    failure code on the run contract.

    The gateway signals policy denial with either an HTTP 403 response that
    carries ``errorCode: "model_policy_denied"`` or a validation failure code
    in the policy set (``forbidden_model``, ``forbidden_role``,
    ``forbidden_data_class``, ``disallowed_model_endpoint``, ``inactive_model``,
    ``timeout_exceeded_*``). The Orchestrator's ``_invoke_step`` translates
    those signals into this exception type so the W0.2 contract can finalise
    the run as ``blocked`` with the precise failure code.
    """


PROFILE_CONTROLLED_BY_HARNESS = "harness-control-plane"
STATE_TRANSITION_FLOW = "workflow.step"
STATE_TRANSITION_CAPABILITY = "capability.resolved"
STATE_TRANSITION_STEP_COMPLETED = "step.completed"
STATE_TRANSITION_STEP_RETRY = "step.retry"
STATE_TRANSITION_STEP_FAILED = "step.failed"
POLICY_ALLOW = "policy allow"

DATA_CLASS_CONTROL = "other"
DATA_CLASS_PARSER = "parser"
DATA_CLASS_GENERATOR = "generator"
DATA_CLASS_BUILD_TEST = "build-test"
DATA_CLASS_EVIDENCE = "evidence"
DATA_CLASS_MODEL = "model-gateway"

DEFAULT_MODEL_ID = "gpt-oss-120b"
DEFAULT_PROMPT_TEMPLATE_VERSION = "v1"
DEFAULT_MODEL_TIMEOUT_MS = 15000
DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS = 5000
ORACLE_MODE_COBOL_RUNTIME = "cobol-runtime"
EXECUTION_MODE_STANDARD = "standard"
EXECUTION_MODE_PARITY = "parity"
REFERENCE_MODE_REFERENCE_FIXTURE = "reference-fixture"
REFERENCE_MODE_NATIVE_COBOL = "native-cobol"


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class W0RunContext:
    run_id: str
    workflow_id: str
    requester: str
    evidence_refs: Sequence[str]
    model_prompt: str | None = None
    execution_mode: str = EXECUTION_MODE_STANDARD
    trust_case_id: str | None = None
    trust_case_resolution: JsonObject | None = None
    source_reference_fixture_id: str | None = None
    source_reference_mode: str | None = None
    # Issue #169: when ``True``, the orchestrator invokes the productive
    # Transformation Agent after the deterministic baseline succeeds, uses
    # the agent's Java candidate as the artifact fed into build/test, and
    # records the agent attempt in the W0.2 contract. When ``False`` (the
    # default) the orchestrator preserves the W0/W0.2 deterministic-only
    # path.
    use_transformation_agent: bool = False
    # Issue #255 / Studio-IDE-13: when ``True``, the orchestrator stops
    # after the generate-java step (i.e. the generator pipeline has
    # produced Java artifacts) and finalises the run with classification
    # ``incomplete`` + failure_code ``generate_only_complete``. The Studio
    # consumes this signal as "Java artifacts ready; verification was not
    # requested" and renders the new files in the editor without
    # surfacing a verification error. Defaults to ``False`` so existing
    # ``/api/v0/transform`` callers preserve their composed
    # Generate & Verify behaviour.
    generate_only: bool = False
    # ADR 0007 §5 / Issue #280: per-region manual-edit overlay submitted
    # with the run. Each entry is a region record with ``filePath``,
    # ``originClass`` (``manual_modified`` or ``manual_edit``),
    # ``startLine``/``endLine`` (or ``lineRange``), and the required ADR
    # 0007 provenance metadata. The orchestrator forwards these to every
    # Verification/Repair Agent iteration; combined with the run's
    # ``assistDecision.reasonCode``, they gate whether the agent can propose
    # changes to a manual region (caller opt-in required per the
    # assist-interaction rule). The default empty tuple matches runs that
    # carry no manual-edit overlay (the common case for greenfield runs).
    manual_overlay_regions: tuple[Mapping[str, JsonValue], ...] = ()


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class WorkflowStepResult:
    capability_id: str
    step_name: str
    payload: Mapping[str, JsonValue]
    status: str
    input_ref: DataReference
    output_ref: DataReference


# Issue #96: required step ids for UI-started runs.
STEP_ACCEPTED = "accepted"
STEP_PARSE_COBOL = "parse-cobol"
STEP_GENERATE_IR = "generate-ir"
STEP_GENERATE_JAVA = "generate-java"
STEP_COMPILE_TEST_JAVA = "compile-test-java"
STEP_WRITE_EVIDENCE = "write-evidence"
STEP_TRANSFORM = "transform"
STEP_SOURCE_REFERENCE = "source-reference-execution"
STEP_JAVA_BUILD = "java-build"
STEP_JAVA_EXECUTION = "java-execution"
STEP_PARITY_COMPARISON = "parity-comparison"
STEP_PARITY_EVIDENCE_CAPTURE = "parity-evidence-capture"
STEP_MODEL_GUIDANCE = "model-guidance"
STEP_MODEL_POLICY_SKIPPED = "model-policy-skipped"

MANUAL_COMPILE_REPAIR_DIR = "manual-compile-repair"
MANUAL_COMPILE_REPAIR_SNAPSHOT_KIND = "manual-compile-repair-snapshot"
MANUAL_COMPILE_REPAIR_BASELINE_DIFF_KIND = "manual-compile-repair-baseline-diff"
MANUAL_COMPILE_REPAIR_DIAGNOSIS_KIND = "repair-diagnosis"
MANUAL_COMPILE_REPAIR_PROPOSAL_KIND = "patch-proposal"
MANUAL_COMPILE_REPAIR_APPROVAL_KIND = "manual-compile-repair-approval"
MANUAL_COMPILE_REPAIR_PROJECT_MANIFEST_KIND = "manual-compile-repair-project-manifest"
MANUAL_COMPILE_REPAIR_PROJECT_FILE_KIND = "manual-compile-repair-project-file"


def _canonical_patch_sha(files: Sequence[Mapping[str, JsonValue]]) -> str:
    payload = {
        "files": [
            {
                "path": str(entry.get("path") or ""),
                "changeType": str(entry.get("changeType") or ""),
                "beforeSha256": str(entry.get("beforeSha256") or ""),
                "afterSha256": str(entry.get("afterSha256") or ""),
                "diff": str(entry.get("diff") or ""),
            }
            for entry in sorted(files, key=lambda item: str(item.get("path") or ""))
        ]
    }
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _unified_file_diff(path: str, before: str, after: str) -> str:
    diff = difflib.unified_diff(
        before.splitlines(),
        after.splitlines(),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        lineterm="",
    )
    return "\n".join(diff)


def _confidence_level(score: float | None) -> str:
    if score is None:
        return "medium"
    if score >= 0.8:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"
STEP_COMPLETED = "completed"
STEP_FAILED = "failed"

REQUIRED_RUN_STEP_NAMES: tuple[str, ...] = (
    STEP_PARSE_COBOL,
    STEP_GENERATE_IR,
    STEP_GENERATE_JAVA,
    STEP_COMPILE_TEST_JAVA,
    STEP_WRITE_EVIDENCE,
)

STEP_STATUS_PENDING = "pending"
STEP_STATUS_RUNNING = "running"
STEP_STATUS_OK = "ok"
STEP_STATUS_FAILED = "failed"
STEP_STATUS_SKIPPED = "skipped"


# noinspection PyClassHasNoInitInspection
@dataclass
class StepRecord:
    """Per-step progress entry exposed by the orchestrator under /v0/runs/:id/progress.

    Issue #96 contract: each step must expose stepId, stepName, capabilityId,
    service/actor, status, started/finished timestamps where available,
    inputRef/outputRef, and a diagnostic message on failure.
    """

    step_id: int
    name: str
    capability_id: str
    service: str
    actor: str
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    input_ref: JsonObject | None = None
    output_ref: JsonObject | None = None
    diagnostic: str | None = None
    latency_ms: int | None = None

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
            "stepId": self.step_id,
            "name": self.name,
            "capabilityId": self.capability_id,
            "service": self.service,
            "actor": self.actor,
            "status": self.status,
        }
        if self.started_at is not None:
            payload["startedAt"] = self.started_at
        if self.finished_at is not None:
            payload["finishedAt"] = self.finished_at
        if self.input_ref is not None:
            payload["inputRef"] = self.input_ref
        if self.output_ref is not None:
            payload["outputRef"] = self.output_ref
        if self.diagnostic is not None:
            payload["diagnostic"] = self.diagnostic
        if self.latency_ms is not None:
            payload["latencyMs"] = self.latency_ms
        return payload


class RunProgressLog:
    """Mutable, ordered list of StepRecord entries for a single run.

    The log preserves first-write step ordering so the UI can render a stable
    pipeline timeline. Repeated calls to :meth:`update` keyed on the step name
    mutate the existing record in place rather than appending a duplicate.
    """

    def __init__(self) -> None:
        self._steps: list[StepRecord] = []
        self._index: dict[str, int] = {}
        self._lock = threading.Lock()

    def upsert(
        self,
        name: str,
        *,
        capability_id: str,
        service: str,
        actor: str,
        status: str,
        started_at: str | None = None,
        finished_at: str | None = None,
        input_ref: Mapping[str, JsonValue] | None = None,
        output_ref: Mapping[str, JsonValue] | None = None,
        diagnostic: str | None = None,
        latency_ms: int | None = None,
    ) -> StepRecord:
        with self._lock:
            existing_index = self._index.get(name)
            if existing_index is None:
                record = StepRecord(
                    step_id=len(self._steps) + 1,
                    name=name,
                    capability_id=capability_id,
                    service=service,
                    actor=actor,
                    status=status,
                    started_at=started_at,
                    finished_at=finished_at,
                    input_ref=dict(input_ref) if input_ref is not None else None,
                    output_ref=dict(output_ref) if output_ref is not None else None,
                    diagnostic=diagnostic,
                    latency_ms=latency_ms,
                )
                self._steps.append(record)
                self._index[name] = len(self._steps) - 1
            else:
                record = self._steps[existing_index]
                # Preserve original step_id to keep the stable ordering visible to
                # consumers; only refine timing/status/diagnostic on subsequent
                # updates.
                record.capability_id = capability_id or record.capability_id
                record.service = service or record.service
                record.actor = actor or record.actor
                record.status = status
                if started_at is not None and record.started_at is None:
                    record.started_at = started_at
                if finished_at is not None:
                    record.finished_at = finished_at
                if input_ref is not None:
                    record.input_ref = dict(input_ref)
                if output_ref is not None:
                    record.output_ref = dict(output_ref)
                if diagnostic is not None:
                    record.diagnostic = diagnostic
                if latency_ms is not None:
                    record.latency_ms = latency_ms
        return record

    def has(self, name: str) -> bool:
        with self._lock:
            result = name in self._index
        return result

    def to_payload(self) -> list[JsonObject]:
        with self._lock:
            result = [record.to_dict() for record in self._steps]
        return result


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text_value = str(value).strip()
    return text_value or None


def _first_non_empty_text(*values: Any) -> str | None:
    for value in values:
        text_value = _text(value)
        if text_value:
            return text_value
    return None


def _to_non_negative_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(0, parsed)


def _normalize_input_ref(raw: Mapping[str, JsonValue], run_id: str) -> DataReference:
    if not isinstance(raw, Mapping):
        raise OrchestratorError("inputRef must be an object")

    uri = _text(raw.get("uri")) or f"urn:orchestrator/{run_id}/input"
    source_text = _first_non_empty_text(raw.get("source"), raw.get("sourceText"), raw.get("code"))

    sha = _text(raw.get("sha256", raw.get("sha", raw.get("hash"))))
    if sha is None:
        sha = _build_reference(uri, source_text or uri).sha256

    byte_size = _to_non_negative_int(raw.get("byteSize", raw.get("byte_size", 0)))
    if byte_size == 0 and source_text is not None:
        byte_size = len(source_text.encode("utf-8"))

    return DataReference(uri=uri, sha256=sha, byte_size=byte_size)


def _extract_source(raw: Mapping[str, JsonValue]) -> str:
    source = _first_non_empty_text(raw.get("source"), raw.get("sourceText"), raw.get("code"))
    if not source:
        raise OrchestratorError("inputRef must include source, sourceText, or code")
    return source


def _raw_source(raw: Mapping[str, JsonValue]) -> str | None:
    """Return the source text exactly as supplied, preserving whitespace.

    Used for the COBOL oracle payload (Issue #92), where fixed-format COBOL
    requires leading-column whitespace to be retained character-for-character.
    """
    for key in ("source", "sourceText", "code"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _build_reference(uri: str, payload: Any) -> DataReference:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return DataReference(uri=uri, sha256=sha256(canonical).hexdigest(), byte_size=len(canonical))


def _as_reference_payload(ref: DataReference) -> Mapping[str, JsonValue]:
    return {
        "uri": ref.uri,
        "sha256": ref.sha256,
        "byteSize": ref.byte_size,
    }


def _reference_payload_from_metadata(raw: Mapping[str, JsonValue] | None) -> JsonObject | None:
    if not isinstance(raw, Mapping):
        return None
    ref = _data_reference_from_mapping(raw)
    if ref is None:
        return None
    payload = dict(_as_reference_payload(ref))
    mime_type = _text(raw.get("mimeType"))
    if mime_type:
        payload["mimeType"] = mime_type
    kind = _text(raw.get("kind"))
    if kind:
        payload["kind"] = kind
    return payload


def _data_reference_from_mapping(raw: Any) -> DataReference | None:
    if not isinstance(raw, Mapping):
        return None
    uri = _text(raw.get("uri"))
    sha = _text(raw.get("sha256"))
    if uri is None or sha is None:
        return None
    return DataReference(
        uri=uri,
        sha256=sha,
        byte_size=_to_non_negative_int(raw.get("byteSize", raw.get("byte_size", 0))),
    )


def _first_non_empty_mapping(value: Any) -> JsonObject:
    if isinstance(value, Mapping) and value:
        return dict(value)
    return {}


def _has_non_empty_list(mapping: Mapping[str, JsonValue] | None, key: str) -> bool:
    """Return ``True`` when ``mapping[key]`` is a non-empty list-like value.

    Used by the assist-decision gate (Issue #215) to detect deterministic
    uncertainty markers on the Semantic IR and the deterministic baseline
    without coercing scalar metadata into a marker. Strings and bytes are
    rejected even though they are technically sequences; only list, tuple,
    and similar iterables count as markers.
    """
    if not isinstance(mapping, Mapping):
        return False
    value = mapping.get(key)
    if value is None:
        return False
    if isinstance(value, (str, bytes, bytearray)):
        return False
    if isinstance(value, Mapping):
        return False
    try:
        return len(value) > 0  # type: ignore[arg-type]
    except TypeError:
        return False


GENERATED_PROJECT_DIR = "generated-project"
GENERATED_PROJECT_MANIFEST_FILE = "generated-project-manifest.json"
MANUAL_EDIT_OVERLAY_FILE = "manual-edit-overlay.json"
PARITY_RESULT_DIR = "parity-results"
SOURCE_REFERENCE_EXECUTION_RESULT_FILE = "source-reference-execution-result.json"
PARITY_EXECUTION_RESULT_FILE = "execution-result.json"
PARITY_COMPARISON_RESULT_FILE = "comparison-result.json"
PARITY_COMPARISON_DIFF_FILE = "comparison.diff"


def _build_generated_project_manifest(
    *,
    run_id: str,
    workflow_id: str,
    generated_project: Mapping[str, JsonValue],
    persisted_files: Sequence[Mapping[str, JsonValue]],
    program_id: str | None,
    ir_id: str | None,
    source_sha256: str | None,
) -> JsonObject:
    """Build the deterministic manifest describing the persisted Java project.

    The manifest pairs every persisted file with its on-disk sha256 and byte
    size, then sorts the entries by path so the canonical JSON encoding is
    stable. The orchestrator hashes this manifest to produce the single
    ``artifactRef`` referenced by `/generated`, build-test, and Evidence Pack,
    which is how Issue #97 guarantees those three consumers point at byte-for-
    byte identical generated Java.
    """
    files: list[JsonObject] = []
    prefix = f"{GENERATED_PROJECT_DIR}/"
    for entry in persisted_files:
        path = str(entry.get("path") or "")
        if not path.startswith(prefix):
            continue
        files.append(
            {
                "path": path[len(prefix):],
                "sha256": str(entry.get("sha256") or ""),
                "byteSize": int(entry.get("byteSize") or 0),
                "mimeType": str(entry.get("mimeType") or ""),
            }
        )
    files.sort(key=lambda item: item["path"])
    return {
        "runId": run_id,
        "workflowId": workflow_id,
        "entryClass": _text(generated_project.get("entryClass")) or "",
        "entryFilePath": _text(generated_project.get("entryFilePath")) or "",
        "fileCount": len(files),
        "files": files,
        "traceability": {
            "programId": program_id or "",
            "irId": ir_id or "",
            "sourceHash": source_sha256 or "",
        },
    }


def _iter_generated_files(generated_project: Mapping[str, JsonValue]):
    if not isinstance(generated_project, Mapping):
        return
    files = generated_project.get("files")
    if not isinstance(files, Mapping):
        return
    for raw_path, raw_content in files.items():
        path = str(raw_path).lstrip("/\\")
        if not path or ".." in PurePosixPath(path).parts:
            continue
        if isinstance(raw_content, str):
            yield path, raw_content
        elif raw_content is None:
            yield path, ""
        else:
            yield path, str(raw_content)


def _failed_step_from_exception(exc: BaseException) -> str | None:
    text = str(exc).lower()
    for marker in (
        ("parse-cobol", "parse-cobol"),
        ("generate-ir", "generate-ir"),
        ("generate-java", "generate-java"),
        ("compile-test-java", "compile-test-java"),
        ("source-reference-execution", STEP_SOURCE_REFERENCE),
        ("parity-comparison", STEP_PARITY_COMPARISON),
        ("parity-evidence-capture", STEP_PARITY_EVIDENCE_CAPTURE),
        ("model-guidance", "model-guidance"),
        ("write-evidence", "write-evidence"),
        # Issue #169: surface productive Transformation Agent failures.
        ("transformation-agent", "transformation-agent"),
        ("transformation agent", "transformation-agent"),
    ):
        if marker[0] in text:
            return marker[1]
    return None


# Markers that the Model Gateway emits when a request is denied on policy
# grounds (Issue #168). The gateway returns these in the JSON response body
# alongside HTTP 403; the HarnessFailure exception thrown by the gateway
# client stringifies the body into ``details``.
_MODEL_POLICY_DENY_MARKERS: tuple[str, ...] = (
    "model_policy_denied",
    "forbidden_model",
    "forbidden_role",
    "forbidden_data_class",
    "disallowed_model_endpoint",
    "inactive_model",
    "timeout_exceeded_provider",
    "timeout_exceeded_model_default",
    "unsupported_structured_output",
)


_UNSUPPORTED_COBOL_DIAGNOSTIC_MARKERS: tuple[str, ...] = (
    "unsupported-feature",
    "unsupported-data-declaration",
    "unsupported-statement",
)

_MAX_EXCEPTION_BODY_SCAN_CHARS = 65_536


def _exception_chain_text(exc: BaseException) -> str:
    parts: list[str] = []
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parts.append(str(current))
        body = getattr(current, "body", None)
        if isinstance(body, str) and body:
            parts.append(body[:_MAX_EXCEPTION_BODY_SCAN_CHARS])
        current = current.__cause__ or current.__context__
    return " ".join(parts).lower()


def _is_unsupported_cobol_diagnostic(exc: BaseException) -> bool:
    text = _exception_chain_text(exc)
    return any(marker in text for marker in _UNSUPPORTED_COBOL_DIAGNOSTIC_MARKERS)


def _is_model_policy_denial(exc: BaseException) -> bool:
    """Return True when the exception's string form contains a recognisable
    Model Gateway policy-denial marker. Used by ``_invoke_step`` to route
    model-guidance failures to ``ModelPolicyDeniedStepError`` rather than
    the generic ``StepExecutionError``.
    """
    text = str(exc).lower()
    if "policy deny" in text:
        return True
    for marker in _MODEL_POLICY_DENY_MARKERS:
        if marker in text:
            return True
    return False


_SENSITIVE_EVENT_PAYLOAD_KEYS = frozenset(
    {
        "source",
        "sourceText",
        "source_text",
        "code",
        "content",
        "rawSource",
        "raw_source",
    }
)


def _redacted_text_summary(value: str) -> JsonObject:
    encoded = value.encode("utf-8", errors="replace")
    return {
        "redacted": True,
        "sha256": sha256(encoded).hexdigest(),
        "byteSize": len(encoded),
    }


def _redact_event_payload(value: Any, *, key: str | None = None) -> JsonValue:
    if key in _SENSITIVE_EVENT_PAYLOAD_KEYS and isinstance(value, str):
        return _redacted_text_summary(value)
    if isinstance(value, Mapping):
        return {
            str(child_key): _redact_event_payload(child_value, key=str(child_key))
            for child_key, child_value in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_redact_event_payload(child_value) for child_value in value]
    return value


def _build_cobol_oracle_payload(
    source_text: str | None,
    input_reference: DataReference,
    timeout_ms: int,
    *,
    expected_output: str | None = None,
    oracle_input: str | None = None,
) -> JsonObject | None:
    """Construct a non-executing oracle payload for build-test-runner.

    Issue #92 requires the build-test runner to receive a deterministic
    COBOL runtime oracle whenever the requester supplied COBOL source text.
    Issue #172 extends that payload with optional user-provided
    ``expectedOutput`` and ``oracleInput`` metadata from the BFF.
    """
    if not isinstance(source_text, str) or not source_text:
        return None
    safe_timeout = timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS
    payload: JsonObject = {
        "mode": ORACLE_MODE_COBOL_RUNTIME,
        "sourceText": source_text,
        "sourceRef": _as_reference_payload(input_reference),
        "timeoutMs": safe_timeout,
    }
    if isinstance(expected_output, str) and expected_output:
        payload["expectedOutput"] = expected_output
    if isinstance(oracle_input, str) and oracle_input:
        payload["oracleInput"] = oracle_input
    return payload


def _extract_oracle_metadata(raw: Mapping[str, JsonValue]) -> dict[str, str | None]:
    """Extract Issue #172 oracle metadata from a BFF-forwarded inputRef.

    The BFF places ``expectedOutput`` and ``oracleInput`` on the inputRef
    when the UI submits them via /api/v0/transform. Returning ``None`` for
    missing/empty values keeps the W0/W0.1 deterministic path untouched.
    """
    expected: str | None = None
    oracle_input: str | None = None
    expected_value = raw.get("expectedOutput")
    if isinstance(expected_value, str) and expected_value:
        expected = expected_value
    oracle_value = raw.get("oracleInput")
    if isinstance(oracle_value, str) and oracle_value:
        oracle_input = oracle_value
    return {"expectedOutput": expected, "oracleInput": oracle_input}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _load_acceptance_fixture(fixture_id: str) -> JsonObject | None:
    if not fixture_id.strip():
        return None
    index_path = _repo_root() / "fixtures" / "acceptance" / "index.json"
    if not index_path.is_file():
        return None
    try:
        parsed = json.loads(index_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    fixtures = parsed.get("fixtures")
    if not isinstance(fixtures, list):
        return None
    for raw in fixtures:
        if not isinstance(raw, Mapping):
            continue
        if _text(raw.get("fixtureId")) == fixture_id:
            return dict(raw)
    return None


def _load_fixture_expected_output(fixture: Mapping[str, JsonValue]) -> str | None:
    ref = fixture.get("expectedOutputArtifactRef")
    if not isinstance(ref, Mapping):
        return None
    path = _text(ref.get("path"))
    if path is None:
        return None
    relative = PurePosixPath(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise OrchestratorError(f"unsafe acceptance-fixture path: {path}")
    resolved = (_repo_root() / Path(*relative.parts)).resolve()
    repo_root = _repo_root().resolve()
    if not str(resolved).startswith(str(repo_root)):
        raise OrchestratorError(f"fixture path escapes repository root: {path}")
    try:
        return resolved.read_text("utf-8")
    except OSError as exc:
        raise OrchestratorError(f"could not read acceptance fixture output {path}: {exc}") from exc


def _is_parity_run(context: W0RunContext) -> bool:
    return context.execution_mode == EXECUTION_MODE_PARITY


def _coerce_output_ref(payload: Mapping[str, JsonValue], fallback_uri: str, fallback_payload: Any) -> DataReference:
    raw = _first_non_empty_mapping(payload.get("outputRef"))
    if raw:
        return DataReference(
            uri=_text(raw.get("uri")) or fallback_uri,
            sha256=_text(raw.get("sha256")) or _build_reference(fallback_uri, fallback_payload).sha256,
            byte_size=_to_non_negative_int(raw.get("byteSize", raw.get("byte_size", 0))),
        )
    return _build_reference(fallback_uri, fallback_payload)


class W0WorkflowRunner:
    """Execute the W0 migration workflow through Harness capabilities."""

    def __init__(
        self,
        config: OrchestratorConfig,
        gateway: HarnessGateway,
        artifact_store: RunArtifactStore | None = None,
        experience_learning: ExperienceLearningGateway | NullExperienceLearningGateway | None = None,
        transformation_agent: TransformationAgent | None = None,
        transformation_agent_invoker: ModelGatewayInvoker | None = None,
        repair_agent: RepairAgent | None = None,
        repair_agent_invoker: ModelGatewayInvoker | None = None,
    ):
        self.config = config
        self.gateway = gateway
        self.artifact_store = artifact_store if artifact_store is not None else NullArtifactStore()
        # Issue #96: experience_learning is duck-typed against the
        # ExperienceLearningGateway protocol so a NullExperienceLearningGateway
        # can no-op when the service is unconfigured.
        self.experience_learning = experience_learning if experience_learning is not None else NullExperienceLearningGateway()
        # Issue #169: the productive Transformation Agent is optional. When
        # neither an instance nor a model invoker is supplied, the runner
        # builds an invoker on-demand from the Harness gateway capability
        # the first time a run requests ``use_transformation_agent=True``.
        self._transformation_agent: TransformationAgent | None = transformation_agent
        self._transformation_agent_invoker: ModelGatewayInvoker | None = transformation_agent_invoker
        # Issue #170: the productive Verification/Repair Agent is invoked
        # whenever the build/test runner reports failure and the repair
        # budget still has remaining attempts. Lazy construction lets tests
        # inject a stub agent through the constructor while production
        # falls back to the Harness-backed Model Gateway invoker (shared
        # with the transformation agent so both go through the same proxy).
        self._repair_agent: RepairAgent | None = repair_agent
        self._repair_agent_invoker: ModelGatewayInvoker | None = repair_agent_invoker
        self._step_lock = threading.Lock()
        self._step_id_by_run: dict[str, int] = {}
        self._capability_cache: dict[str, JsonObject] = {}
        self._progress_lock = threading.Lock()
        self._progress_by_run: dict[str, RunProgressLog] = {}
        self._event_buffer_lock = threading.Lock()
        self._event_buffer_by_run: dict[str, list[JsonObject]] = {}
        # Issue #166: per-run W0.2 contract snapshots, fetched by
        # ``GET /v0/runs/{runId}/workflow``.
        self._contract_lock = threading.Lock()
        self._contracts_by_run: dict[str, W02RunContract] = {}

    # ------------------------------------------------------------------
    # Issue #166: W0.2 workflow contract helpers
    # ------------------------------------------------------------------

    def workflow_contract(self, run_id: str) -> W02RunContract | None:
        with self._contract_lock:
            result = self._contracts_by_run.get(run_id)
        return result

    def workflow_contract_payload(self, run_id: str) -> JsonObject | None:
        contract = self.workflow_contract(run_id)
        if contract is None:
            return None
        return contract.to_dict()

    def generated_project_files(self, run_id: str) -> dict[str, str]:
        files: dict[str, str] = {}
        prefix = "generated-project/"
        for entry in self.artifact_store.find_by_kind(run_id, KIND_GENERATED_PROJECT_FILE):
            relpath = str(entry.get("path") or "")
            if not relpath.startswith(prefix):
                continue
            raw = self.artifact_store.read_bytes(run_id, relpath)
            if raw is None:
                continue
            files[relpath[len(prefix):]] = raw.decode("utf-8", errors="replace")
        return files

    def generated_project_manifest_ref(self, run_id: str) -> JsonObject | None:
        meta = self.artifact_store.find_metadata(run_id, "generated-project-manifest.json")
        if not isinstance(meta, Mapping):
            return None
        return self._artifact_ref_payload(meta)

    def _persist_manual_compile_snapshot(
        self,
        run_id: str,
        workflow_id: str,
        java_files: Mapping[str, str],
        *,
        entry_class: str,
        entry_file_path: str,
    ) -> JsonObject:
        manifest_files: list[JsonObject] = []
        for path, content in sorted(java_files.items()):
            encoded = content.encode("utf-8")
            relpath = f"{MANUAL_COMPILE_REPAIR_DIR}/snapshot/{path}"
            self.artifact_store.write_text(
                run_id,
                workflow_id,
                relpath,
                content,
                kind=MANUAL_COMPILE_REPAIR_PROJECT_FILE_KIND,
                mime_type=MIME_JAVA,
            )
            manifest_files.append(
                {
                    "path": path,
                    "sha256": sha256(encoded).hexdigest(),
                    "byteSize": len(encoded),
                    "mimeType": MIME_JAVA,
                }
            )
        meta = self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/snapshot-manifest.json",
            {
                "entryClass": entry_class,
                "entryFilePath": entry_file_path,
                "fileCount": len(manifest_files),
                "files": manifest_files,
            },
            kind=MANUAL_COMPILE_REPAIR_SNAPSHOT_KIND,
        )
        return _as_reference_payload(meta)

    def _persist_manual_compile_candidate(
        self,
        run_id: str,
        workflow_id: str,
        java_files: Mapping[str, str],
        *,
        entry_class: str,
        entry_file_path: str,
    ) -> JsonObject:
        manifest_files: list[JsonObject] = []
        for path, content in sorted(java_files.items()):
            encoded = content.encode("utf-8")
            relpath = f"{MANUAL_COMPILE_REPAIR_DIR}/candidate/{path}"
            self.artifact_store.write_text(
                run_id,
                workflow_id,
                relpath,
                content,
                kind=MANUAL_COMPILE_REPAIR_PROJECT_FILE_KIND,
                mime_type=MIME_JAVA,
            )
            manifest_files.append(
                {
                    "path": path,
                    "sha256": sha256(encoded).hexdigest(),
                    "byteSize": len(encoded),
                    "mimeType": MIME_JAVA,
                }
            )
        meta = self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/candidate-project-manifest.json",
            {
                "entryClass": entry_class,
                "entryFilePath": entry_file_path,
                "fileCount": len(manifest_files),
                "files": manifest_files,
            },
            kind=MANUAL_COMPILE_REPAIR_PROJECT_MANIFEST_KIND,
        )
        return _as_reference_payload(meta)

    def _persist_manual_compile_baseline_diff(
        self,
        run_id: str,
        workflow_id: str,
        baseline_files: Mapping[str, str],
        current_files: Mapping[str, str],
    ) -> JsonObject | None:
        diffs: list[str] = []
        for path in sorted(set(baseline_files) | set(current_files)):
            before = baseline_files.get(path, "")
            after = current_files.get(path, "")
            if before == after:
                continue
            diff = _unified_file_diff(path, before, after)
            if diff:
                diffs.append(diff)
        if not diffs:
            return None
        meta = self.artifact_store.write_text(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/baseline.diff",
            "\n".join(diffs),
            kind=MANUAL_COMPILE_REPAIR_BASELINE_DIFF_KIND,
            mime_type=MIME_PLAIN,
        )
        return _as_reference_payload(meta)

    def manual_compile_repair_diagnose(
        self,
        *,
        run_id: str,
        requester: str,
        java_files: Mapping[str, str],
        entry_class: str,
        entry_file_path: str,
        manual_overlay_regions: Sequence[Mapping[str, JsonValue]] = (),
        build_test_context: Mapping[str, JsonValue] | None = None,
    ) -> JsonObject:
        if not self.artifact_store.has_run(run_id):
            raise OrchestratorError("run not found")
        if not java_files:
            raise OrchestratorError("java_files must not be empty")

        summary = self.artifact_store.read_summary(run_id) or {}
        workflow_id = _text(summary.get("workflowId")) or self.config.workflow_id
        baseline_files = self.generated_project_files(run_id)
        if not baseline_files:
            raise OrchestratorError("generated project baseline unavailable for run")

        snapshot_ref = self._persist_manual_compile_snapshot(
            run_id,
            workflow_id,
            java_files,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
        )
        baseline_ref = self.generated_project_manifest_ref(run_id) or snapshot_ref
        baseline_diff_ref = self._persist_manual_compile_baseline_diff(
            run_id,
            workflow_id,
            baseline_files,
            java_files,
        )
        context = W0RunContext(
            run_id=run_id,
            workflow_id=workflow_id,
            requester=requester or self.config.service_name,
            evidence_refs=[],
            manual_overlay_regions=tuple(dict(region) for region in manual_overlay_regions),
        )
        input_ref = DataReference(
            uri=str(snapshot_ref.get("uri") or ""),
            sha256=str(snapshot_ref.get("sha256") or ""),
            byte_size=int(snapshot_ref.get("byteSize") or 0),
        )
        prior_build_payload = self.artifact_store.read_json(run_id, "build-test-result.json")
        prior_build_ref = self.artifact_store.find_metadata(run_id, "build-test-result.json")
        prior_failure_code: str | None = None
        if isinstance(prior_build_payload, Mapping):
            _prior_build_ok, prior_failure_code = build_test_outcome(prior_build_payload)
        requested_failure_code = W0WorkflowRunner._manual_diagnosis_requested_failure_code(
            build_test_context
        )
        use_prior_build_result = (
            build_test_context is None
            and
            java_files == baseline_files
            and prior_failure_code in {
            FAILURE_JAVA_RUNTIME_FAILED,
            FAILURE_ORACLE_MISMATCH,
            }
            and isinstance(prior_build_ref, Mapping)
        )

        if use_prior_build_result:
            build_payload = dict(prior_build_payload)
            build_ref = (
                self._artifact_ref_payload(prior_build_ref)
                or _first_non_empty_mapping(prior_build_ref)
            )
        else:
            build_options: JsonObject = {
                "skipExecution": True,
                "compareOutput": False,
                "timeoutMs": 5000,
            }
            oracle: JsonObject = {}
            if requested_failure_code == FAILURE_JAVA_RUNTIME_FAILED:
                build_options["skipExecution"] = False
            elif requested_failure_code == FAILURE_ORACLE_MISMATCH:
                build_options["skipExecution"] = False
                build_options["compareOutput"] = True
                expected_output = (
                    _text(build_test_context.get("expectedOutput"))
                    if isinstance(build_test_context, Mapping)
                    else ""
                )
                if expected_output:
                    oracle["expectedOutput"] = expected_output
            build_input: JsonObject = {
                "runId": run_id,
                "programId": _text(summary.get("programId")) or run_id,
                "generatedProject": {
                    "files": dict(java_files),
                    "entryClass": entry_class,
                    "entryFilePath": entry_file_path,
                },
                "options": build_options,
                "oracle": oracle,
            }
            build_output = self._invoke_step(
                context,
                STEP_COMPILE_TEST_JAVA,
                self._require_capability(run_id, self.config.build_test_capability_id),
                DATA_CLASS_BUILD_TEST,
                build_input,
                input_ref,
            )
            build_payload = dict(build_output.payload)
            build_ref = _as_reference_payload(build_output.output_ref)
            self.artifact_store.write_json(
                run_id,
                workflow_id,
                f"{MANUAL_COMPILE_REPAIR_DIR}/compile-check-result.json",
                build_payload,
                kind=KIND_BUILD_TEST_RESULT,
            )
        build_ok, failure_code = build_test_outcome(build_payload)
        if build_ok:
            raise OrchestratorError(
                "manual diagnosis requires a deterministic build failure on the current Java snapshot"
            )

        diagnostics = build_payload.get("diagnostics")
        diagnostic_paths: set[str] = set()
        if isinstance(diagnostics, Sequence) and not isinstance(diagnostics, (str, bytes, bytearray)):
            for entry in diagnostics:
                if isinstance(entry, Mapping):
                    file_path = _text(entry.get("filePath"))
                    if file_path and file_path in java_files:
                        diagnostic_paths.add(file_path)
        prompt_files: dict[str, str] = {}
        for path in sorted(diagnostic_paths):
            prompt_files[path] = java_files[path]
        if not prompt_files:
            prompt_files[entry_file_path] = java_files.get(entry_file_path) or next(iter(java_files.values()))
        trimmed_build_payload: JsonObject = {
            "status": _text(build_payload.get("status")) or "failed",
            "summary": _text(build_payload.get("summary")) or "build failed",
            "diagnostics": [
                dict(entry)
                for entry in (diagnostics or [])
                if isinstance(entry, Mapping)
            ][:10],
        }
        if isinstance(build_test_context, Mapping):
            build_context_summary = self._manual_diagnosis_build_payload_from_context(
                build_test_context,
                failure_code=requested_failure_code,
            )
            for key in ("classification", "comparisonPolicy", "expectedOutput"):
                value = build_context_summary.get(key)
                if value not in (None, "") and key not in trimmed_build_payload:
                    trimmed_build_payload[key] = value
        parity_comparison = self._manual_diagnosis_parity_projection(build_payload)
        if not parity_comparison and isinstance(build_test_context, Mapping):
            parity_comparison = self._manual_diagnosis_parity_projection(
                self._manual_diagnosis_build_payload_from_context(
                    build_test_context,
                    failure_code=requested_failure_code,
                )
            )
        if parity_comparison:
            trimmed_build_payload["parityComparison"] = dict(parity_comparison)
        manual_edit_diff_ref = (
            dict(baseline_diff_ref) if baseline_diff_ref is not None else None
        )
        if manual_edit_diff_ref is not None:
            trimmed_build_payload["manualEditDiffRef"] = manual_edit_diff_ref
        compile_error_ref, runtime_error_ref, oracle_diff_ref = self._build_manual_diagnosis_refs(
            build_payload,
            parity_comparison=parity_comparison,
        )
        execution_result_ref = self._manual_diagnosis_execution_result_ref(
            build_payload,
            parity_comparison=parity_comparison,
        )
        if execution_result_ref is None and isinstance(build_test_context, Mapping):
            execution_result_ref = self._manual_diagnosis_execution_result_ref(
                self._manual_diagnosis_build_payload_from_context(
                    build_test_context,
                    failure_code=requested_failure_code,
                ),
                parity_comparison=parity_comparison,
            )
        comparison_result_ref = self._manual_diagnosis_comparison_result_ref(
            build_payload,
            parity_comparison=parity_comparison,
        )
        if comparison_result_ref is None and isinstance(build_test_context, Mapping):
            comparison_result_ref = self._manual_diagnosis_comparison_result_ref(
                self._manual_diagnosis_build_payload_from_context(
                    build_test_context,
                    failure_code=requested_failure_code,
                ),
                parity_comparison=parity_comparison,
            )

        contract = self.workflow_contract(run_id)
        if contract is None:
            contract = new_run_contract(
                run_id=run_id,
                workflow_id=workflow_id,
                requester=requester or self.config.service_name,
                source_ref=dict(snapshot_ref),
                repair_budget_limit=1,
            )
        repair_result = self._invoke_repair_agent(
            context,
            contract,
            attempt_number=1,
            previous_java_candidate_ref=dict(snapshot_ref),
            previous_java_files=prompt_files,
            build_test_result_ref=build_ref,
            build_test_payload=trimmed_build_payload,
            failure_category=failure_code or FAILURE_JAVA_COMPILE_FAILED,
            source_text=None,
            source_cobol_ref=None,
            oracle_payload=None,
            semantic_ir=None,
            semantic_ir_ref=None,
            compile_error_ref=compile_error_ref,
            runtime_error_ref=runtime_error_ref,
            previous_repair_decision_refs=(),
            repair_budget_remaining=1,
            oracle_diff_ref=oracle_diff_ref,
        )

        candidate_files = dict(java_files)
        if repair_result.candidate is not None:
            candidate_files.update(repair_result.candidate.files)
        candidate_ref = self._persist_manual_compile_candidate(
            run_id,
            workflow_id,
            candidate_files,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
        )
        proposal_files: list[JsonObject] = []
        if repair_result.candidate is not None:
            for path, after in sorted(candidate_files.items()):
                before = java_files.get(path, "")
                if before == after:
                    continue
                encoded_after = after.encode("utf-8")
                proposal_files.append(
                    {
                        "path": path,
                        "changeType": "modify" if path in java_files else "add",
                        "beforeSha256": sha256(before.encode("utf-8")).hexdigest() if path in java_files else None,
                        "afterSha256": sha256(encoded_after).hexdigest(),
                        "diff": _unified_file_diff(path, before, after),
                    }
                )

        diagnosis_id = f"{run_id}-compile-diagnosis"
        evidence_refs: list[JsonObject] = [dict(snapshot_ref), dict(build_ref)]
        if execution_result_ref is not None:
            evidence_refs.append(dict(execution_result_ref))
        if comparison_result_ref is not None:
            evidence_refs.append(dict(comparison_result_ref))
        if compile_error_ref is not None:
            evidence_refs.append(dict(compile_error_ref))
        if runtime_error_ref is not None:
            evidence_refs.append(dict(runtime_error_ref))
        if oracle_diff_ref is not None:
            evidence_refs.append(dict(oracle_diff_ref))
        if baseline_diff_ref is not None:
            evidence_refs.append(dict(baseline_diff_ref))
        if repair_result.model_invocation_ref:
            evidence_refs.append(dict(repair_result.model_invocation_ref))
        diagnosis_payload: JsonObject = {
            "schemaVersion": "v0",
            "diagnosisId": diagnosis_id,
            "runId": run_id,
            "workflowId": workflow_id,
            "buildResultRef": dict(build_ref),
            "executionResultRef": dict(execution_result_ref) if execution_result_ref else None,
            "comparisonResultRef": dict(comparison_result_ref) if comparison_result_ref else None,
            "sourceRevisionRef": dict(baseline_ref),
            "currentHeadRef": dict(snapshot_ref),
            "failureClass": W0WorkflowRunner._manual_diagnosis_failure_class(
                failure_code,
                build_payload=build_payload,
                manual_overlay_regions=manual_overlay_regions,
                repair_result=repair_result,
            ),
            "scopeClass": W0WorkflowRunner._manual_diagnosis_scope_class(
                manual_overlay_regions=manual_overlay_regions,
                build_payload=build_payload,
                repair_result=repair_result,
            ),
            "followUpRecommendation": W0WorkflowRunner._manual_diagnosis_follow_up_recommendation(
                repair_result=repair_result,
                failure_code=failure_code,
                evidence_refs=evidence_refs,
            ),
            "likelyRootCause": repair_result.rationale
            or self._manual_diagnosis_root_cause(failure_code),
            "summary": repair_result.candidate.explanation if repair_result.candidate else repair_result.rationale,
            "confidence": {
                "level": _confidence_level(repair_result.confidence),
                "basis": "Deterministic build diagnostics plus the governed verification-repair model output.",
            },
            "recommendedNextAction": "repair_generated_code"
            if proposal_files
            else W0WorkflowRunner._manual_diagnosis_follow_up(
                repair_result,
                build_payload=build_payload,
            ),
            "evidenceRefs": evidence_refs,
            "createdAt": _iso_now(),
        }
        if execution_result_ref is None:
            diagnosis_payload.pop("executionResultRef")
        if comparison_result_ref is None:
            diagnosis_payload.pop("comparisonResultRef")
        if diagnosis_payload["followUpRecommendation"] is None:
            diagnosis_payload.pop("followUpRecommendation")
        diagnosis_meta = self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/diagnosis.json",
            diagnosis_payload,
            kind=MANUAL_COMPILE_REPAIR_DIAGNOSIS_KIND,
        )
        proposal_payload: JsonObject | None = None
        if proposal_files:
            patch_sha = _canonical_patch_sha(proposal_files)
            proposal_id = f"{run_id}-{patch_sha[:12]}"
            proposal_evidence_refs: list[JsonObject] = [
                dict(snapshot_ref),
                dict(candidate_ref),
                _as_reference_payload(diagnosis_meta),
            ]
            proposal_payload = {
                "schemaVersion": "v0",
                "proposalId": proposal_id,
                "runId": run_id,
                "workflowId": workflow_id,
                "diagnosisId": diagnosis_id,
                "proposedBy": "verification-repair",
                "patchSha256": patch_sha,
                "summary": repair_result.candidate.explanation if repair_result.candidate else repair_result.rationale,
                "applicationState": "review_pending",
                "approvalState": "pending",
                "files": proposal_files,
                "sourceRevisionRef": dict(baseline_ref),
                "currentHeadRef": dict(snapshot_ref),
                "evidenceRefs": proposal_evidence_refs,
                "createdAt": _iso_now(),
            }
            self.artifact_store.write_json(
                run_id,
                workflow_id,
                f"{MANUAL_COMPILE_REPAIR_DIR}/proposal-{proposal_id}.json",
                proposal_payload,
                kind=MANUAL_COMPILE_REPAIR_PROPOSAL_KIND,
            )

        return {
            "schemaVersion": "v0",
            "runId": run_id,
            "diagnosis": diagnosis_payload,
            "proposal": proposal_payload,
            "candidateProject": {
                "entryClass": entry_class,
                "entryFilePath": entry_file_path,
                "files": candidate_files,
            },
            "buildTest": dict(build_payload),
        }

    def _manual_compile_repair_proposal_path(self, proposal_id: str) -> str:
        return f"{MANUAL_COMPILE_REPAIR_DIR}/proposal-{proposal_id}.json"

    def _load_manual_compile_repair_proposal(
        self,
        *,
        run_id: str,
        proposal_id: str,
    ) -> JsonObject:
        stored = self.artifact_store.read_json(
            run_id,
            self._manual_compile_repair_proposal_path(proposal_id),
        )
        if not isinstance(stored, Mapping):
            raise OrchestratorError("proposal state not found")
        return dict(stored)

    def manual_compile_repair_apply(
        self,
        *,
        run_id: str,
        requester: str,
        current_java_files: Mapping[str, str],
        entry_class: str,
        entry_file_path: str,
        proposal: Mapping[str, JsonValue],
        candidate_project: Mapping[str, JsonValue],
        expected_output: str | None = None,
        oracle_input: str | None = None,
    ) -> JsonObject:
        if not self.artifact_store.has_run(run_id):
            raise OrchestratorError("run not found")
        workflow_id = _text((self.artifact_store.read_summary(run_id) or {}).get("workflowId")) or self.config.workflow_id
        files = proposal.get("files")
        if not isinstance(files, Sequence) or isinstance(files, (str, bytes, bytearray)):
            raise OrchestratorError("proposal.files must be an array")
        proposal_id = _text(proposal.get("proposalId"))
        if not proposal_id:
            raise OrchestratorError("proposal.proposalId must be a non-empty string")
        persisted_proposal = self._load_manual_compile_repair_proposal(
            run_id=run_id,
            proposal_id=proposal_id,
        )
        if (
            _text(persisted_proposal.get("applicationState")) != "review_pending"
            or _text(persisted_proposal.get("approvalState")) != "pending"
        ):
            raise OrchestratorError("proposal is no longer pending approval")
        expected_patch_sha = _text(proposal.get("patchSha256"))
        if expected_patch_sha != _canonical_patch_sha([entry for entry in files if isinstance(entry, Mapping)]):
            raise OrchestratorError("proposal patch hash does not match proposal file diffs")
        if expected_patch_sha != _text(persisted_proposal.get("patchSha256")):
            raise OrchestratorError("proposal patch hash does not match persisted proposal state")
        persisted_files = persisted_proposal.get("files")
        if not isinstance(persisted_files, Sequence) or isinstance(
            persisted_files, (str, bytes, bytearray)
        ):
            raise OrchestratorError("persisted proposal state is invalid")
        if _canonical_patch_sha([entry for entry in persisted_files if isinstance(entry, Mapping)]) != expected_patch_sha:
            raise OrchestratorError("persisted proposal patch hash does not match stored file diffs")

        candidate_files_raw = candidate_project.get("files")
        if not isinstance(candidate_files_raw, Mapping):
            raise OrchestratorError("candidateProject.files must be an object")
        candidate_files = {str(path): str(content) for path, content in candidate_files_raw.items()}
        expected_candidate_files = dict(current_java_files)
        for entry in persisted_files:
            if not isinstance(entry, Mapping):
                continue
            path = _text(entry.get("path"))
            if not path:
                continue
            before_sha = _text(entry.get("beforeSha256"))
            if before_sha and sha256(str(current_java_files.get(path, "")).encode("utf-8")).hexdigest() != before_sha:
                raise OrchestratorError(f"current Java drift detected for {path}")
            after_sha = _text(entry.get("afterSha256"))
            if after_sha and sha256(str(candidate_files.get(path, "")).encode("utf-8")).hexdigest() != after_sha:
                raise OrchestratorError(f"candidate Java hash mismatch for {path}")
            change_type = _text(entry.get("changeType")) or "modify"
            if change_type == "delete":
                expected_candidate_files.pop(path, None)
                continue
            if path not in candidate_files:
                raise OrchestratorError(f"candidate Java content missing for {path}")
            expected_candidate_files[path] = candidate_files[path]
        if set(candidate_files) != set(expected_candidate_files):
            raise OrchestratorError("candidate project contains unreviewed file changes")
        for path, expected_content in expected_candidate_files.items():
            if candidate_files.get(path) != expected_content:
                raise OrchestratorError(f"candidate Java content does not match the approved proposal for {path}")

        candidate_ref = self._persist_manual_compile_candidate(
            run_id,
            workflow_id,
            candidate_files,
            entry_class=entry_class,
            entry_file_path=entry_file_path,
        )
        approved_at = _iso_now()
        updated_proposal: JsonObject = {
            **persisted_proposal,
            "applicationState": "applied",
            "approvalState": "approved",
            "developerApproval": {
                "approvedBy": requester or self.config.service_name,
                "approvedAt": approved_at,
                "approvedPatchSha256": expected_patch_sha,
            },
            "approvedAt": approved_at,
            "appliedAt": approved_at,
        }
        self.artifact_store.write_json(
            run_id,
            workflow_id,
            self._manual_compile_repair_proposal_path(proposal_id),
            updated_proposal,
            kind=MANUAL_COMPILE_REPAIR_PROPOSAL_KIND,
        )
        self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/approval-{proposal_id}.json",
            {
                "proposalId": proposal_id,
                "runId": run_id,
                "approvedBy": requester or self.config.service_name,
                "approvedAt": approved_at,
                "approvedPatchSha256": expected_patch_sha,
                "candidateProjectRef": candidate_ref,
            },
            kind=MANUAL_COMPILE_REPAIR_APPROVAL_KIND,
        )

        context = W0RunContext(
            run_id=run_id,
            workflow_id=workflow_id,
            requester=requester or self.config.service_name,
            evidence_refs=[],
        )
        input_ref = DataReference(
            uri=str(candidate_ref.get("uri") or ""),
            sha256=str(candidate_ref.get("sha256") or ""),
            byte_size=int(candidate_ref.get("byteSize") or 0),
        )
        oracle: JsonObject = {}
        if expected_output is not None:
            oracle["expectedOutput"] = expected_output
        if oracle_input is not None:
            oracle["oracleInput"] = oracle_input
        build_input: JsonObject = {
            "runId": run_id,
            "programId": _text((self.artifact_store.read_summary(run_id) or {}).get("programId")) or run_id,
            "generatedProject": {
                "files": candidate_files,
                "entryClass": entry_class,
                "entryFilePath": entry_file_path,
            },
            "options": {
                "skipExecution": False,
                "compareOutput": True,
                "timeoutMs": 30000,
            },
            "oracle": oracle,
            "repairAttempt": 1,
        }
        build_output = self._invoke_step(
            context,
            STEP_COMPILE_TEST_JAVA,
            self._require_capability(run_id, self.config.build_test_capability_id),
            DATA_CLASS_BUILD_TEST,
            build_input,
            input_ref,
        )
        self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/apply-build-test-result.json",
            dict(build_output.payload),
            kind=KIND_BUILD_TEST_RESULT,
        )
        return {
            "schemaVersion": "v0",
            "runId": run_id,
            "proposal": updated_proposal,
            "candidateProject": {
                "entryClass": entry_class,
                "entryFilePath": entry_file_path,
                "files": candidate_files,
            },
            "buildTest": dict(build_output.payload),
        }

    def manual_compile_repair_reject(
        self,
        *,
        run_id: str,
        requester: str,
        proposal: Mapping[str, JsonValue],
    ) -> JsonObject:
        if not self.artifact_store.has_run(run_id):
            raise OrchestratorError("run not found")
        workflow_id = _text((self.artifact_store.read_summary(run_id) or {}).get("workflowId")) or self.config.workflow_id
        proposal_id = _text(proposal.get("proposalId"))
        if not proposal_id:
            raise OrchestratorError("proposal.proposalId must be a non-empty string")
        persisted_proposal = self._load_manual_compile_repair_proposal(
            run_id=run_id,
            proposal_id=proposal_id,
        )
        if (
            _text(persisted_proposal.get("applicationState")) != "review_pending"
            or _text(persisted_proposal.get("approvalState")) != "pending"
        ):
            raise OrchestratorError("proposal is no longer pending approval")
        rejected_at = _iso_now()
        updated_proposal: JsonObject = {
            **persisted_proposal,
            "applicationState": "rejected",
            "approvalState": "rejected",
        }
        self.artifact_store.write_json(
            run_id,
            workflow_id,
            self._manual_compile_repair_proposal_path(proposal_id),
            updated_proposal,
            kind=MANUAL_COMPILE_REPAIR_PROPOSAL_KIND,
        )
        self.artifact_store.write_json(
            run_id,
            workflow_id,
            f"{MANUAL_COMPILE_REPAIR_DIR}/approval-{proposal_id}.json",
            {
                "proposalId": proposal_id,
                "runId": run_id,
                "decision": "rejected",
                "rejectedBy": requester or self.config.service_name,
                "rejectedAt": rejected_at,
                "patchSha256": _text(persisted_proposal.get("patchSha256")),
            },
            kind=MANUAL_COMPILE_REPAIR_APPROVAL_KIND,
        )
        return {
            "schemaVersion": "v0",
            "runId": run_id,
            "proposal": updated_proposal,
        }

    def _build_manual_diagnosis_refs(
        self,
        build_payload: Mapping[str, JsonValue],
        *,
        parity_comparison: Mapping[str, JsonValue] | None = None,
    ) -> tuple[JsonObject | None, JsonObject | None, JsonObject | None]:
        compile_error_ref = self._artifact_ref_payload(build_payload.get("compileErrorRef"))
        runtime_error_ref = self._artifact_ref_payload(build_payload.get("runtimeErrorRef"))
        oracle_diff_ref = self._artifact_ref_payload(build_payload.get("oracleDiffRef"))
        if oracle_diff_ref is None:
            payload_parity_comparison = _first_non_empty_mapping(build_payload.get("parityComparison"))
            if isinstance(payload_parity_comparison, Mapping):
                oracle_diff_ref = self._artifact_ref_payload(payload_parity_comparison.get("diffRef"))
        if oracle_diff_ref is None and isinstance(parity_comparison, Mapping):
            oracle_diff_ref = self._artifact_ref_payload(parity_comparison.get("diffRef"))
        return compile_error_ref, runtime_error_ref, oracle_diff_ref

    def _manual_diagnosis_failure_class(
        failure_code: str | None,
        *,
        build_payload: Mapping[str, JsonValue],
        manual_overlay_regions: Sequence[Mapping[str, JsonValue]],
        repair_result: RepairAgentResult,
    ) -> str:
        if repair_result.is_escalation and repair_result.escalation_code == "out_of_scope_for_w0_2":
            return "out_of_scope"
        if repair_result.is_refusal and repair_result.refusal_code == "insufficient_context":
            return "unknown"
        if manual_overlay_regions:
            return "manual_edit_issue"
        if W0WorkflowRunner._manual_diagnosis_is_fixture_issue(build_payload):
            return "fixture_issue"
        if failure_code in {
            FAILURE_JAVA_COMPILE_FAILED,
            FAILURE_JAVA_RUNTIME_FAILED,
            FAILURE_ORACLE_MISMATCH,
        }:
            return "generated_code_defect"
        return "unknown"

    @staticmethod
    def _manual_diagnosis_scope_class(
        *,
        manual_overlay_regions: Sequence[Mapping[str, JsonValue]],
        build_payload: Mapping[str, JsonValue],
        repair_result: RepairAgentResult,
    ) -> str:
        if repair_result.is_escalation and repair_result.escalation_code == "out_of_scope_for_w0_2":
            return "out_of_scope"
        if repair_result.is_refusal and repair_result.refusal_code == "insufficient_context":
            return "unknown"
        if manual_overlay_regions:
            return "manual_edit"
        if W0WorkflowRunner._manual_diagnosis_is_fixture_issue(build_payload):
            return "fixture_reference"
        if W0WorkflowRunner._manual_diagnosis_has_generated_context(build_payload):
            return "generated_code"
        return "unknown"

    @staticmethod
    def _manual_diagnosis_root_cause(failure_code: str | None) -> str:
        if failure_code == FAILURE_JAVA_RUNTIME_FAILED:
            return "The current manual Java snapshot fails at runtime."
        if failure_code == FAILURE_ORACLE_MISMATCH:
            return "The current manual Java snapshot diverges from the parity oracle."
        if failure_code == FAILURE_JAVA_COMPILE_FAILED:
            return "The current manual Java snapshot does not compile."
        return "The current manual Java snapshot failed deterministic verification."

    @staticmethod
    def _manual_diagnosis_follow_up(
        repair_result: RepairAgentResult,
        *,
        build_payload: Mapping[str, JsonValue],
    ) -> str:
        if repair_result.proposed_candidate:
            return "repair_generated_code"
        if repair_result.is_escalation:
            return "escalate"
        if W0WorkflowRunner._manual_diagnosis_is_fixture_issue(build_payload):
            return "repair_fixture"
        return "stop"

    @staticmethod
    def _manual_diagnosis_follow_up_recommendation(
        *,
        repair_result: RepairAgentResult,
        failure_code: str | None,
        evidence_refs: Sequence[Mapping[str, JsonValue]],
    ) -> JsonObject | None:
        if not (repair_result.is_escalation and repair_result.escalation_code == "out_of_scope_for_w0_2"):
            return None
        failure_label = {
            FAILURE_JAVA_RUNTIME_FAILED: "runtime failure",
            FAILURE_ORACLE_MISMATCH: "parity mismatch",
            FAILURE_JAVA_COMPILE_FAILED: "compile failure",
        }.get(failure_code or "", "verification failure")
        return {
            "title": "Create a follow-up issue for out-of-scope repair diagnosis",
            "summary": repair_result.rationale
            or f"The current {failure_label} is valid but outside the W0.2 repair scope.",
            "suggestedIssueType": "follow-up",
            "evidenceRefs": [
                dict(ref)
                for ref in evidence_refs
                if isinstance(ref, Mapping)
            ],
        }

    @staticmethod
    def _manual_diagnosis_is_fixture_issue(
        build_payload: Mapping[str, JsonValue],
    ) -> bool:
        classification = _text(build_payload.get("classification")) or ""
        mismatch = _text(build_payload.get("mismatchClassification")) or ""
        combined = f"{classification} {mismatch}".lower()
        return any(
            marker in combined
            for marker in (
                "oracle-unavailable",
                "oracle_invalid_request",
                "oracle-invalid-request",
                "missing-golden-master",
                "fixture",
                "reference",
            )
        )

    @staticmethod
    def _manual_diagnosis_has_generated_context(
        build_payload: Mapping[str, JsonValue],
    ) -> bool:
        return bool(build_payload)

    @staticmethod
    def _manual_diagnosis_requested_failure_code(
        build_test_context: Mapping[str, JsonValue] | None,
    ) -> str | None:
        if not isinstance(build_test_context, Mapping):
            return None
        status = (_text(build_test_context.get("status")) or "").lower()
        classification = (_text(build_test_context.get("classification")) or "").lower()
        compile_status = (_text(build_test_context.get("compileStatus")) or "").lower()
        execution_status = (_text(build_test_context.get("executionStatus")) or "").lower()
        comparison = _first_non_empty_mapping(build_test_context.get("comparison"))
        comparison_status = (_text(comparison.get("status")) or "").lower()
        if (
            status == "output-divergence"
            or "mismatch" in classification
            or comparison_status == "failed"
        ):
            return FAILURE_ORACLE_MISMATCH
        if (
            status == "run-failed"
            or classification == "run-error"
            or execution_status == "failed"
        ):
            return FAILURE_JAVA_RUNTIME_FAILED
        if (
            status == "compile-failed"
            or classification == "compile-error"
            or compile_status == "failed"
        ):
            return FAILURE_JAVA_COMPILE_FAILED
        return None

    @staticmethod
    def _manual_diagnosis_build_payload_from_context(
        build_test_context: Mapping[str, JsonValue],
        *,
        failure_code: str | None,
    ) -> JsonObject:
        payload: JsonObject = {}
        for key in (
            "status",
            "classification",
            "compileStatus",
            "executionStatus",
            "comparisonPolicy",
            "expectedOutput",
        ):
            value = build_test_context.get(key)
            if value not in (None, ""):
                payload[key] = value
        output_ref = _first_non_empty_mapping(build_test_context.get("outputRef"))
        if output_ref:
            payload["executionResultRef"] = dict(output_ref)
        comparison = _first_non_empty_mapping(build_test_context.get("comparison"))
        parity_projection: JsonObject = {}
        if comparison:
            for key in (
                "status",
                "matched",
                "comparisonPolicyVersion",
                "mismatchClassification",
                "comparisonPolicyRef",
                "comparisonResultRef",
                "diffRef",
                "expectedRef",
                "actualRef",
            ):
                value = comparison.get(key)
                if value not in (None, ""):
                    parity_projection[key] = value
        expected_output_ref = _first_non_empty_mapping(build_test_context.get("expectedOutputRef"))
        if expected_output_ref and "expectedRef" not in parity_projection:
            parity_projection["expectedRef"] = dict(expected_output_ref)
        actual_output_ref = _first_non_empty_mapping(build_test_context.get("actualOutputRef"))
        if actual_output_ref and "actualRef" not in parity_projection:
            parity_projection["actualRef"] = dict(actual_output_ref)
        if output_ref and "executionResultRef" not in parity_projection:
            parity_projection["executionResultRef"] = dict(output_ref)
        comparison_result_ref = _first_non_empty_mapping(
            comparison.get("comparisonResultRef") if comparison else None
        )
        if comparison_result_ref:
            payload["comparisonResultRef"] = dict(comparison_result_ref)
        if parity_projection:
            payload["parityComparison"] = parity_projection
        summary = {
            FAILURE_JAVA_RUNTIME_FAILED: "runtime exception",
            FAILURE_ORACLE_MISMATCH: "parity mismatch",
            FAILURE_JAVA_COMPILE_FAILED: "compile failure",
        }.get(failure_code or "", "deterministic verification failure")
        payload.setdefault("summary", summary)
        payload.setdefault("status", "failed")
        return payload

    def _manual_diagnosis_parity_projection(
        self,
        build_payload: Mapping[str, JsonValue],
    ) -> JsonObject:
        direct_projection = _first_non_empty_mapping(build_payload.get("parityComparison"))
        if direct_projection:
            return direct_projection
        comparison_result = _first_non_empty_mapping(build_payload.get("comparisonResult"))
        if not comparison_result:
            return {}
        projection: JsonObject = {}
        for key in (
            "status",
            "matched",
            "comparisonPolicyVersion",
            "comparisonPolicyRef",
            "executionResultRef",
            "comparisonResultRef",
            "diffRef",
            "expectedRef",
            "actualRef",
            "mismatchClassification",
        ):
            value = comparison_result.get(key)
            if value not in (None, ""):
                projection[key] = value
        return projection

    def _manual_diagnosis_execution_result_ref(
        self,
        build_payload: Mapping[str, JsonValue],
        *,
        parity_comparison: Mapping[str, JsonValue] | None = None,
    ) -> JsonObject | None:
        execution_result = _first_non_empty_mapping(build_payload.get("executionResult"))
        return (
            self._artifact_ref_payload(build_payload.get("executionResultRef"))
            or self._artifact_ref_payload(execution_result.get("outputRef"))
            or (
                self._artifact_ref_payload(parity_comparison.get("executionResultRef"))
                if isinstance(parity_comparison, Mapping)
                else None
            )
        )

    def _manual_diagnosis_comparison_result_ref(
        self,
        build_payload: Mapping[str, JsonValue],
        *,
        parity_comparison: Mapping[str, JsonValue] | None = None,
    ) -> JsonObject | None:
        comparison_result = _first_non_empty_mapping(build_payload.get("comparisonResult"))
        return (
            self._artifact_ref_payload(build_payload.get("comparisonResultRef"))
            or self._artifact_ref_payload(comparison_result.get("outputRef"))
            or (
                self._artifact_ref_payload(parity_comparison.get("comparisonResultRef"))
                if isinstance(parity_comparison, Mapping)
                else None
            )
        )

    def _store_contract(self, contract: W02RunContract) -> None:
        with self._contract_lock:
            self._contracts_by_run[contract.run_id] = contract

    def _init_w02_contract(
        self,
        context: W0RunContext,
        input_reference: DataReference,
    ) -> W02RunContract:
        contract = new_run_contract(
            run_id=context.run_id,
            workflow_id=context.workflow_id,
            requester=context.requester,
            source_ref=_as_reference_payload(input_reference),
            repair_budget_limit=getattr(
                self.config,
                "repair_budget_max",
                w02.DEFAULT_REPAIR_BUDGET,
            ),
            # Issue #216 (W0.3-5): seed the new assist + model-invocation
            # budgets from configuration so consumers (BFF, UI, evidence)
            # see the same values the orchestrator enforces. ``getattr``
            # keeps the runner compatible with older config dataclasses
            # carried through tests that pre-date this issue.
            assist_budget_limit=getattr(
                self.config,
                "assist_budget_max",
                w02.DEFAULT_ASSIST_BUDGET,
            ),
            model_invocation_budget_limit=getattr(
                self.config,
                "model_invocation_budget_max",
                w02.DEFAULT_MODEL_INVOCATION_BUDGET,
            ),
        )
        if isinstance(context.trust_case_resolution, Mapping) and context.trust_case_resolution:
            contract.set_resolved_trust_case(context.trust_case_resolution)
        self._store_contract(contract)
        self._persist_w02_contract(context, contract)
        return contract

    def _advance_w02(
        self,
        context: W0RunContext,
        contract: W02RunContract,
        target: str,
        *,
        active_step: str | None = None,
        message: str = "",
        failure_code: str | None = None,
    ) -> None:
        """Advance the W0.2 state machine and emit a Harness event.

        ``active_step`` is the user-visible step label for ``activeStep`` on the
        run contract. ``failure_code`` is recorded on the transition only when
        the runner already knows the canonical W0.2 reason (e.g.
        ``oracle_mismatch``); otherwise it stays ``None`` and is set by
        :meth:`_finalize_w02` at the end of the run.
        """
        try:
            transition = contract.state_machine.advance(
                target,
                message=message,
                failure_code=failure_code,
            )
        except IllegalTransitionError:
            # Surfacing the illegal transition is more useful for tests than
            # silently swallowing it; the runner only ever calls _advance_w02
            # with valid transitions, so this indicates a programmer error.
            raise
        if active_step is not None:
            contract.set_active_step(active_step)
        contract.touch()
        self._persist_w02_contract(context, contract)
        # Emit a Harness event for every major state change so the Harness
        # event ledger records the W0.2 workflow trace (Issue #166).
        self._emit_w02_state_event(context, transition.state, message=message, failure_code=failure_code)

    def _emit_w02_state_event(
        self,
        context: W0RunContext,
        state: str,
        *,
        message: str = "",
        failure_code: str | None = None,
    ) -> None:
        output_payload: JsonObject = {"state": state}
        if message:
            output_payload["message"] = message
        if failure_code:
            output_payload["failureCode"] = failure_code
        self._post_event(
            context.run_id,
            event_type=f"orchestrator.workflow.state.{state}",
            capability=self.config.service_name,
            actor=self.config.service_name,
            data_class=DATA_CLASS_CONTROL,
            status="updating",
            state_transition=STATE_TRANSITION_FLOW,
            input_payload={"runId": context.run_id, "workflowId": context.workflow_id},
            output_payload=output_payload,
            input_ref=_build_reference(
                f"urn:orchestrator/{context.run_id}/w02/{state}/in",
                {"runId": context.run_id, "state": state},
            ),
            output_ref=_build_reference(
                f"urn:orchestrator/{context.run_id}/w02/{state}/out",
                output_payload,
            ),
            policy_decision=POLICY_ALLOW,
        )

    def _persist_w02_contract(self, context: W0RunContext, contract: W02RunContract) -> ArtifactMetadata:
        return self.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            "w02-run-contract.json",
            contract.to_dict(),
            kind=KIND_W02_RUN_CONTRACT,
        )

    def _trust_case_artifact_ref(self, context: W0RunContext) -> JsonObject | None:
        trust_case_resolution = context.trust_case_resolution
        if not isinstance(trust_case_resolution, Mapping) or not trust_case_resolution:
            return None
        existing = self.artifact_store.find_metadata(context.run_id, "executed-trust-case.json")
        if existing is None:
            metadata = self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                "executed-trust-case.json",
                dict(trust_case_resolution),
                kind="trust-case",
            )
            return {
                "uri": metadata.uri,
                "sha256": metadata.sha256,
                "byteSize": metadata.byteSize,
                "kind": metadata.kind,
            }
        return {
            "uri": str(existing.get("uri") or ""),
            "sha256": str(existing.get("sha256") or ""),
            "byteSize": int(existing.get("byteSize") or 0),
            "kind": str(existing.get("kind") or "trust-case"),
        }

    # ------------------------------------------------------------------
    # Issue #169: Transformation Agent integration helpers
    # ------------------------------------------------------------------

    def _ensure_transformation_agent(self) -> TransformationAgent:
        """Return the transformation agent, building it lazily if needed.

        Lazy construction lets tests inject a stub agent through the
        constructor while production code falls back to the Harness-backed
        Model Gateway invoker.
        """
        if self._transformation_agent is not None:
            return self._transformation_agent
        if isinstance(self.artifact_store, NullArtifactStore):
            raise OrchestratorError(
                "transformation agent requires a real artifact store; refusing to run with NullArtifactStore"
            )
        invoker = self._transformation_agent_invoker
        if invoker is None:
            invoker = HarnessModelGatewayInvoker(
                self.gateway,
                self.config.model_gateway_capability_id,
                expected_capability=self._configured_capability(
                    self.config.model_gateway_capability_id
                ),
            )
            self._transformation_agent_invoker = invoker
        self._transformation_agent = TransformationAgent(
            config=self.config,
            artifact_store=self.artifact_store,
            model_invoker=invoker,
            harness_events=self.gateway,
        )
        return self._transformation_agent

    def _invoke_transformation_agent(
        self,
        context: W0RunContext,
        contract: W02RunContract,
        *,
        source_text: str,
        source_reference: DataReference,
        source_program_id: str | None,
        ir_document: Mapping[str, JsonValue] | None,
        ir_output_ref: DataReference | None,
        baseline_artifact_ref: Mapping[str, JsonValue] | None,
        baseline_files: Mapping[str, str] | None,
        oracle_reference: DataReference | None,
        oracle_payload: Mapping[str, JsonValue] | None,
    ) -> TransformationAgentResult:
        """Run one Transformation Agent attempt and return its structured
        result. Raises :class:`TransformationAgentError` on terminal
        failures (policy denial, gateway unavailability, timeout,
        contract-invalid output).
        """
        agent = self._ensure_transformation_agent()
        # Resolving the model-gateway capability through the Harness
        # guarantees we attach the capabilityResolutionRecord required by
        # the agent-invocation-request contract.
        capability = self._require_capability(
            context.run_id, self.config.model_gateway_capability_id
        )
        capability_resolved_at = _iso_now()
        attempt_number = contract.record_agent_attempt()

        ir_ref_payload: Mapping[str, JsonValue] | None = None
        if ir_output_ref is not None:
            ir_ref_payload = _as_reference_payload(ir_output_ref)

        oracle_ref_payload: Mapping[str, JsonValue] | None = None
        if oracle_reference is not None:
            oracle_ref_payload = _as_reference_payload(oracle_reference)

        request = TransformationAgentRequest(
            run_id=context.run_id,
            workflow_id=context.workflow_id,
            attempt_number=attempt_number,
            requester=context.requester or self.config.service_name,
            source_text=source_text,
            source_ref=_as_reference_payload(source_reference),
            capability_id=str(capability.get("id") or self.config.model_gateway_capability_id),
            capability_version=str(capability.get("version") or "v0"),
            capability_provider=str(capability.get("owner") or "model-gateway-service"),
            capability_resolved_at=capability_resolved_at,
            model_id=getattr(self.config, "model_gateway_model_id", DEFAULT_MODEL_ID)
            or DEFAULT_MODEL_ID,
            policy_version=getattr(self.config, "model_policy_version", None) or "v0",
            source_program_id=source_program_id,
            semantic_ir=dict(ir_document) if isinstance(ir_document, Mapping) and ir_document else None,
            semantic_ir_ref=ir_ref_payload,
            baseline_java_ref=dict(baseline_artifact_ref) if baseline_artifact_ref else None,
            baseline_files=dict(baseline_files) if baseline_files else None,
            oracle_ref=oracle_ref_payload,
            oracle_payload=dict(oracle_payload) if isinstance(oracle_payload, Mapping) and oracle_payload else None,
            deadline_ms=getattr(
                self.config,
                "transformation_agent_deadline_ms",
                DEFAULT_MODEL_TIMEOUT_MS,
            )
            or DEFAULT_MODEL_TIMEOUT_MS,
            trace_ref=f"trace-{context.run_id}",
        )
        return agent.invoke(request)

    # ------------------------------------------------------------------
    # Issue #170: Verification/Repair Agent integration helpers
    # ------------------------------------------------------------------

    def _ensure_repair_agent(self) -> RepairAgent:
        """Return the verification/repair agent, building it lazily.

        Production callers reach the Model Gateway through the Harness
        capability proxy. Tests inject a stub via the constructor. The
        agent shares its model invoker with the transformation agent when
        no dedicated repair invoker was supplied so both productive
        agents go through the same gateway.
        """
        if self._repair_agent is not None:
            return self._repair_agent
        if isinstance(self.artifact_store, NullArtifactStore):
            raise OrchestratorError(
                "verification/repair agent requires a real artifact store; refusing to run with NullArtifactStore"
            )
        invoker = self._repair_agent_invoker or self._transformation_agent_invoker
        if invoker is None:
            invoker = HarnessModelGatewayInvoker(
                self.gateway,
                self.config.model_gateway_capability_id,
                expected_capability=self._configured_capability(
                    self.config.model_gateway_capability_id
                ),
            )
            self._transformation_agent_invoker = invoker
        self._repair_agent_invoker = invoker
        self._repair_agent = RepairAgent(
            config=self.config,
            artifact_store=self.artifact_store,
            model_invoker=invoker,
            harness_events=self.gateway,
        )
        return self._repair_agent

    def _invoke_repair_agent(
        self,
        context: W0RunContext,
        _contract: W02RunContract,
        *,
        attempt_number: int,
        previous_java_candidate_ref: Mapping[str, JsonValue],
        previous_java_files: Mapping[str, str],
        build_test_result_ref: Mapping[str, JsonValue],
        build_test_payload: Mapping[str, JsonValue],
        failure_category: str,
        source_text: str | None,
        source_cobol_ref: Mapping[str, JsonValue] | None,
        oracle_payload: Mapping[str, JsonValue] | None,
        semantic_ir: Mapping[str, JsonValue] | None,
        semantic_ir_ref: Mapping[str, JsonValue] | None,
        compile_error_ref: Mapping[str, JsonValue] | None,
        runtime_error_ref: Mapping[str, JsonValue] | None,
        oracle_diff_ref: Mapping[str, JsonValue] | None,
        previous_repair_decision_refs: Sequence[Mapping[str, JsonValue]],
        repair_budget_remaining: int,
    ) -> RepairAgentResult:
        """Run one Verification/Repair Agent attempt and return its result.

        Raises a typed :class:`RepairAgentError` on terminal failures
        (policy denial, gateway unavailability, timeout, contract-invalid
        output). The caller maps those errors to the canonical W0.2
        failure code and finalises the run.
        """
        agent = self._ensure_repair_agent()
        capability = self._require_capability(
            context.run_id, self.config.model_gateway_capability_id
        )
        capability_resolved_at = _iso_now()
        configured_repair_model = _text(
            getattr(self.config, "repair_agent_model_id", None)
        )
        configured_default_model = _text(
            getattr(self.config, "model_gateway_model_id", None)
        )
        # ADR 0007 §5 / Issue #280: forward the manual-edit overlay (if
        # any) and the run's current ``assistDecision.reasonCode`` so the
        # agent can short-circuit iterations that would touch a manual
        # region without an explicit caller opt-in. ``None`` for the
        # reason code means the gate has not fired on this run yet; the
        # agent treats that as "no opt-in" and blocks repair when manual
        # regions are present.
        assist_reason_code = (
            _contract.assist_decision.reason_code
            if _contract.assist_decision is not None
            else None
        )
        parity_comparison = (
            dict(_contract.parity_comparison)
            if isinstance(_contract.parity_comparison, Mapping)
            else {}
        )
        request = RepairAgentRequest(
            run_id=context.run_id,
            workflow_id=context.workflow_id,
            attempt_number=attempt_number,
            requester=context.requester or self.config.service_name,
            previous_java_candidate_ref=dict(previous_java_candidate_ref),
            previous_java_files=dict(previous_java_files),
            build_test_result_ref=dict(build_test_result_ref),
            build_test_payload=dict(build_test_payload) if build_test_payload else {},
            failure_category=failure_category,
            capability_id=str(capability.get("id") or self.config.model_gateway_capability_id),
            capability_version=str(capability.get("version") or "v0"),
            capability_provider=str(capability.get("owner") or "model-gateway-service"),
            capability_resolved_at=capability_resolved_at,
            model_id=configured_repair_model or configured_default_model or DEFAULT_MODEL_ID,
            policy_version=getattr(self.config, "model_policy_version", None) or "v0",
            repair_budget_remaining=int(repair_budget_remaining),
            source_text=source_text,
            source_cobol_ref=dict(source_cobol_ref) if source_cobol_ref else None,
            compile_error_ref=dict(compile_error_ref) if compile_error_ref else None,
            runtime_error_ref=dict(runtime_error_ref) if runtime_error_ref else None,
            oracle_diff_ref=(
                dict(oracle_diff_ref)
                if oracle_diff_ref
                else (
                    dict(parity_comparison["diffRef"])
                    if isinstance(parity_comparison.get("diffRef"), Mapping)
                    else None
                )
            ),
            oracle_payload=dict(oracle_payload) if isinstance(oracle_payload, Mapping) and oracle_payload else None,
            semantic_ir=dict(semantic_ir) if isinstance(semantic_ir, Mapping) and semantic_ir else None,
            semantic_ir_ref=dict(semantic_ir_ref) if semantic_ir_ref else None,
            previous_repair_decision_refs=tuple(
                dict(ref) for ref in previous_repair_decision_refs
            ),
            deadline_ms=getattr(
                self.config,
                "repair_agent_deadline_ms",
                DEFAULT_MODEL_TIMEOUT_MS,
            )
            or DEFAULT_MODEL_TIMEOUT_MS,
            trace_ref=f"trace-{context.run_id}",
            manual_regions=tuple(
                dict(region) for region in context.manual_overlay_regions
            ),
            assist_reason_code=assist_reason_code,
        )
        return agent.invoke(request)

    @staticmethod
    def _failure_code_for_repair_outcome(result: RepairAgentResult) -> str:
        """Map a non-success repair-agent outcome to a canonical W0.2 code."""
        if result.is_refusal and result.refusal_code is not None:
            return REPAIR_REFUSAL_TO_FAILURE_CODE.get(
                result.refusal_code,
                FAILURE_JAVA_GENERATION_FAILED,
            )
        if result.is_escalation:
            return FAILURE_JAVA_GENERATION_FAILED
        if result.is_no_change:
            return FAILURE_JAVA_GENERATION_FAILED
        return FAILURE_JAVA_GENERATION_FAILED

    @staticmethod
    def _failure_code_for_repair_exception(exc: RepairAgentError) -> str:
        """Map a repair-agent exception to a canonical W0.2 failure code."""
        if isinstance(exc, RepairAgentContractInvalidError):
            return FAILURE_AGENT_CONTRACT_INVALID
        if isinstance(exc, RepairAgentPolicyDeniedError):
            return FAILURE_MODEL_POLICY_DENIED
        if isinstance(exc, RepairAgentTimeoutError):
            return FAILURE_AGENT_TIMEOUT
        if isinstance(exc, RepairAgentGatewayUnavailableError):
            return FAILURE_MODEL_GATEWAY_UNAVAILABLE
        return FAILURE_JAVA_GENERATION_FAILED

    @staticmethod
    def _guard_agent_invocation_payload(
        payload: Any,
    ) -> str | None:
        """Validate an agent invocation response if the payload claims that
        shape. Returns an error description string on failure, otherwise
        ``None``.

        The deterministic W0/W0.2 path never sets ``agentRole`` on its
        generator output, so this guard is a no-op for current production
        flows. Once a productive Transformation or Verification/Repair Agent
        is plugged into the workflow, every contract-shaped payload it returns
        is validated here before the Orchestrator uses it.

        Issue #167.
        """
        if not isinstance(payload, Mapping):
            return None
        if "agentRole" not in payload:
            return None
        try:
            guard_agent_response(payload)
        except AgentContractInvalidError as exc:
            return "; ".join(exc.errors) if exc.errors else str(exc)
        return None

    def _finalize_w02(
        self,
        context: W0RunContext,
        contract: W02RunContract,
        classification: str,
        *,
        failure_code: str | None = None,
        failure_message: str | None = None,
    ) -> None:
        # Studio-IDE-6 (#248): stamp the per-file trust-pillar overlay on
        # the contract *before* finalisation so the persisted contract,
        # the workflow view, and the traceability route all read the
        # same snapshot. Failure here must not block the run from
        # finalising — the overlay is additive metadata.
        try:
            self._stamp_java_region_classification(
                context=context,
                contract=contract,
                final_classification=classification,
                failure_code=failure_code,
            )
        except Exception:  # pragma: no cover - overlay is best-effort
            self.logger.warning(
                "java region classification stamping failed for run=%s",
                context.run_id,
            )
        try:
            contract.finalize(
                classification,
                failure_code=failure_code,
                failure_message=failure_message,
            )
        except IllegalTransitionError:
            # If the run ended without going through evidence/blocked first
            # (extremely defensive), force the contract into a terminal
            # snapshot by recording the failure context and leaving the
            # underlying state machine alone.
            contract.final_classification = classification
            contract.failure_code = failure_code
            contract.failure_message = failure_message
            contract.touch()
        self._persist_w02_contract(context, contract)
        self._emit_w02_state_event(
            context,
            w02.STATE_FINAL_CLASSIFICATION,
            message=failure_message or f"run finalised as {classification}",
            failure_code=failure_code,
        )

    # ------------------------------------------------------------------
    # Studio-IDE-6 (#248): Java region classification stamping
    # ------------------------------------------------------------------

    def _stamp_java_region_classification(
        self,
        *,
        context: W0RunContext,
        contract: W02RunContract,
        final_classification: str,
        failure_code: str | None,
    ) -> None:
        """Compute and attach the per-file trust-pillar overlay.

        Loads the generated Java files from the artifact store, runs the
        pure derivation in :mod:`region_classification`, and stamps the
        result on the run contract via
        :meth:`W02RunContract.set_java_region_classification`. ``None``
        is stamped when the run has no generated Java surface yet (e.g.
        a run blocked before ``STATE_JAVA_CANDIDATE_PERSISTED``).

        ADR 0007 manual overlays are supplied through the run context.
        When present, those regions override the orchestrator-derived
        origin class for the matching generated-Java line range.
        """
        java_files = self._load_generated_java_files(context.run_id)
        if not java_files:
            contract.set_java_region_classification(None)
            return
        classification = region_classification.compute_java_region_classification(
            java_files=java_files,
            assist_decision=contract.assist_decision,
            repair_attempts=contract.repair_attempts,
            final_classification=final_classification,
            failure_code=failure_code,
            manual_overlay=self._manual_overlay_by_file(context),
        )
        contract.set_java_region_classification(classification)

    def _load_generated_java_files(self, run_id: str) -> dict[str, str]:
        """Read the generated Java files for ``run_id`` from the artifact store.

        Keys are paths relative to the generated project root (matching
        the keys used in ``c2c-trace.json``). Returns an empty mapping
        when no generated-project artifacts have been persisted yet.
        """
        prefix = f"{GENERATED_PROJECT_DIR}/"
        result: dict[str, str] = {}
        for entry in self.artifact_store.find_by_kind(
            run_id, KIND_GENERATED_PROJECT_FILE
        ):
            relpath = str(entry.get("path") or "")
            if not relpath.startswith(prefix):
                continue
            mime_type = str(entry.get("mimeType") or "")
            if mime_type and not (mime_type.startswith("text/") or mime_type == MIME_JAVA):
                continue
            content_bytes = self.artifact_store.read_bytes(run_id, relpath)
            if content_bytes is None:
                continue
            try:
                content_text = content_bytes.decode("utf-8")
            except UnicodeDecodeError:
                continue
            short = relpath[len(prefix):]
            if short.endswith(".java"):
                result[short] = content_text
        return result

    @staticmethod
    def _manual_overlay_regions(context: W0RunContext) -> list[JsonObject]:
        regions: list[JsonObject] = []
        for index, raw in enumerate(context.manual_overlay_regions):
            if not isinstance(raw, Mapping):
                raise OrchestratorError(
                    f"manualOverlay.regions[{index}] must be an object"
                )
            regions.append(
                normalise_manual_edit_overlay_region(raw, index=index)
            )
        return regions

    def _manual_overlay_by_file(
        self, context: W0RunContext
    ) -> dict[str, dict[tuple[int, int], str]]:
        overlay: dict[str, dict[tuple[int, int], str]] = {}
        for region in self._manual_overlay_regions(context):
            line_range = region.get("lineRange")
            if not isinstance(line_range, Mapping):
                continue
            file_path = str(region.get("filePath") or "")
            origin_class = str(region.get("originClass") or "")
            start_line = int(line_range.get("startLine") or 0)
            end_line = int(line_range.get("endLine") or 0)
            overlay.setdefault(file_path, {})[
                (start_line, end_line)
            ] = origin_class
        return overlay

    def _manual_edit_region_count(self, context: W0RunContext) -> int:
        return len(self._manual_overlay_regions(context))

    def _stamp_manual_edit_summary(
        self,
        context: W0RunContext,
        contract: W02RunContract,
    ) -> None:
        region_count = self._manual_edit_region_count(context)
        contract.set_manual_edit_summary(
            carried_over=region_count > 0,
            drift_region_count=region_count,
        )

    def _manual_edit_overlay_payload(self, context: W0RunContext) -> JsonObject | None:
        regions = self._manual_overlay_regions(context)
        if not regions:
            return None
        return {
            "schemaVersion": "v0",
            "runId": context.run_id,
            "regions": regions,
        }

    def _manual_edit_overlay_ref(self, context: W0RunContext) -> JsonObject | None:
        payload = self._manual_edit_overlay_payload(context)
        if payload is None:
            return None
        existing = self.artifact_store.find_metadata(
            context.run_id, MANUAL_EDIT_OVERLAY_FILE
        )
        if existing is not None:
            ref = _reference_payload_from_metadata(existing)
        elif isinstance(self.artifact_store, NullArtifactStore):
            ref = None
        else:
            meta = self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                MANUAL_EDIT_OVERLAY_FILE,
                payload,
                kind=KIND_MANUAL_EDIT_OVERLAY,
            )
            ref = (
                _reference_payload_from_metadata(meta.to_dict())
                if meta is not None
                else None
            )
        if ref is not None:
            ref["schemaVersion"] = "v0"
            ref["regionCount"] = len(payload["regions"])
        return ref

    @staticmethod
    def _failure_code_for_step_name(
        step_name: str | None,
        *,
        data_class: str | None = None,
    ) -> str | None:
        if data_class == DATA_CLASS_MODEL or step_name == STEP_MODEL_GUIDANCE:
            return FAILURE_MODEL_GATEWAY_UNAVAILABLE
        if step_name is None:
            return None
        parity_step_map = {
            STEP_SOURCE_REFERENCE: FAILURE_SOURCE_REFERENCE_FAILED,
            STEP_PARITY_COMPARISON: FAILURE_ORACLE_MISMATCH,
            STEP_PARITY_EVIDENCE_CAPTURE: FAILURE_EVIDENCE_INCOMPLETE,
        }
        if step_name in parity_step_map:
            return parity_step_map[step_name]
        return STEP_TO_FAILURE_CODE.get(step_name)

    def _capability_failure_context(self, capability_id: str) -> tuple[str | None, str]:
        step_by_capability = {
            self.config.parse_capability_id: STEP_PARSE_COBOL,
            self.config.ir_capability_id: STEP_GENERATE_IR,
            self.config.generator_capability_id: STEP_GENERATE_JAVA,
            getattr(self.config, "source_reference_capability_id", ""): STEP_SOURCE_REFERENCE,
            self.config.build_test_capability_id: STEP_COMPILE_TEST_JAVA,
            self.config.evidence_capability_id: STEP_WRITE_EVIDENCE,
        }
        if capability_id == self.config.model_gateway_capability_id:
            return STEP_MODEL_GUIDANCE, FAILURE_MODEL_GATEWAY_UNAVAILABLE
        step_name = step_by_capability.get(capability_id)
        failure_code = self._failure_code_for_step_name(step_name)
        return step_name, failure_code or FAILURE_JAVA_GENERATION_FAILED

    def _configured_capability(self, capability_id: str) -> JsonObject | None:
        for capability in getattr(self.config, "w0_capabilities", ()) or ():
            if isinstance(capability, Mapping) and str(capability.get("id") or "") == capability_id:
                return dict(capability)
        return None

    @staticmethod
    def _fallback_failure_code_for_state(current_state: str | None) -> str:
        if current_state in {w02.STATE_RUN_ACCEPTED, STATE_SOURCE_NORMALIZED}:
            return w02.FAILURE_PARSE_FAILED
        if current_state == STATE_COBOL_PARSE_ATTEMPTED:
            return w02.FAILURE_SEMANTIC_IR_FAILED
        if current_state in {
            STATE_SEMANTIC_IR_READY,
            STATE_BASELINE_GENERATION_ATTEMPTED,
            STATE_TRANSFORMATION_AGENT_INVOKED,
            STATE_JAVA_CANDIDATE_PERSISTED,
        }:
            return FAILURE_JAVA_GENERATION_FAILED
        if current_state == STATE_BUILD_TEST_RUNNING:
            return w02.FAILURE_JAVA_COMPILE_FAILED
        if current_state in {
            STATE_FINAL_JAVA_SELECTED,
            STATE_EVIDENCE_MATERIALIZED,
            STATE_EVIDENCE_INCOMPLETE,
        }:
            return FAILURE_EVIDENCE_INCOMPLETE
        return FAILURE_JAVA_GENERATION_FAILED

    @staticmethod
    def _final_classification_for_failure_code(failure_code: str | None) -> str:
        if failure_code in {
            FAILURE_AGENT_CONTRACT_INVALID,
            FAILURE_MODEL_GATEWAY_UNAVAILABLE,
            FAILURE_MODEL_POLICY_DENIED,
            FAILURE_UNSUPPORTED_COBOL,
        }:
            return CLASSIFICATION_BLOCKED
        return CLASSIFICATION_FAILED

    @staticmethod
    def _failure_code_from_exception(
        exc: BaseException,
        *,
        current_state: str | None = None,
        failed_step: str | None = None,
    ) -> str:
        # Issue #216 (W0.3-5): a productive call that fails the pre-flight
        # Model Gateway budget check is, from the consumer's perspective,
        # the gateway being unavailable for this run. Special-case the
        # exhaustion (and any StepExecutionError wrapping it) so the
        # workflow contract terminates as ``blocked`` /
        # ``model_gateway_unavailable`` rather than the generic
        # ``failed`` / ``java_generation_failed`` that the step-name
        # fallback would otherwise produce on the transformation-agent
        # path. The repair-loop path drives the state machine directly
        # and does not rely on this classifier.
        if isinstance(exc, ModelInvocationBudgetExhaustedError) or isinstance(
            exc.__cause__, ModelInvocationBudgetExhaustedError
        ):
            return FAILURE_MODEL_GATEWAY_UNAVAILABLE
        if isinstance(exc, ModelPolicyDeniedStepError):
            return FAILURE_MODEL_POLICY_DENIED
        if isinstance(exc, AgentContractInvalidStepError):
            return FAILURE_AGENT_CONTRACT_INVALID
        if isinstance(exc, CapabilityMissingError):
            if exc.failure_code is not None:
                return exc.failure_code
            step_failure_code = W0WorkflowRunner._failure_code_for_step_name(exc.step_name)
            if step_failure_code is not None:
                return step_failure_code
            text = str(exc).lower()
            if "model" in text:
                return FAILURE_MODEL_GATEWAY_UNAVAILABLE
        if failed_step is not None:
            if (
                failed_step == W02_STEP_PARSE_COBOL
                and _is_unsupported_cobol_diagnostic(exc)
            ):
                return FAILURE_UNSUPPORTED_COBOL
            step_failure_code = W0WorkflowRunner._failure_code_for_step_name(failed_step)
            if step_failure_code is not None:
                return step_failure_code
        failed_step = _failed_step_from_exception(exc)
        if failed_step is not None:
            if (
                failed_step == W02_STEP_PARSE_COBOL
                and _is_unsupported_cobol_diagnostic(exc)
            ):
                return FAILURE_UNSUPPORTED_COBOL
            step_failure_code = W0WorkflowRunner._failure_code_for_step_name(failed_step)
            if step_failure_code is not None:
                return step_failure_code
        return W0WorkflowRunner._fallback_failure_code_for_state(current_state)

    def run(self, context: W0RunContext, input_ref: Mapping[str, JsonValue]) -> JsonObject:
        input_reference = _normalize_input_ref(input_ref, context.run_id)
        source_text = _extract_source(input_ref)
        raw_source_text = _raw_source(input_ref) or source_text
        # Issue #172: lift BFF-forwarded oracle metadata so the build/test
        # runner and verification/repair agent both see expectedOutput /
        # oracleInput. Empty/missing values fall back to the deterministic
        # W0/W0.1 oracle path.
        oracle_metadata = _extract_oracle_metadata(input_ref)
        parity_run = _is_parity_run(context)
        parity_fixture = (
            _load_acceptance_fixture(context.source_reference_fixture_id or "")
            if parity_run and context.source_reference_fixture_id
            else None
        )
        evidence_refs: list[str] = list(context.evidence_refs)
        step_results: list[WorkflowStepResult] = []
        model_output = None
        model_policy_skipped_meta: ArtifactMetadata | None = None
        productive_model_invocations: list[JsonObject] = []
        # noinspection PyUnusedLocal
        model_invocation_input_ref: DataReference | None = None
        # noinspection PyUnusedLocal
        model_invocation_request: JsonObject | None = None
        program_id: str | None = None
        completed_steps: list[str] = []
        artifact_refs: list[JsonObject] = []
        # Issue #166: build the W0.2 run contract before any side-effects.
        # ``_init_w02_contract`` only depends on the input reference; it does
        # not run capability calls or persist source artifacts. The runner
        # advances the state machine at each subsequent boundary so the
        # contract reflects the live workflow.
        w02_contract = self._init_w02_contract(context, input_reference)
        w02_blocked = False
        w02_failure_code: str | None = None
        w02_failure_message: str | None = None

        # noinspection PyShadowingNames
        def _record_artifact(meta: ArtifactMetadata | None) -> None:
            if meta is None:
                return
            try:
                payload = meta.to_dict()
            except AttributeError:
                return
            artifact_refs.append(payload)

        def _record_productive_model_invocation(
            model_invocation_ref: Mapping[str, JsonValue] | None,
            *,
            agent_role: str,
        ) -> None:
            if not isinstance(model_invocation_ref, Mapping):
                return
            normalised = self._normalise_model_invocation_ref(model_invocation_ref)
            if normalised is None:
                return
            normalised["agentRole"] = agent_role
            productive_model_invocations.append(normalised)

        # noinspection PyShadowingNames
        def _write_summary(status: str, *, message: str, failed_step: str | None = None) -> None:
            summary = {
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "requester": context.requester,
                "status": status,
                "message": message,
                "programId": program_id,
                "completedSteps": list(completed_steps),
                "failedStep": failed_step,
                "evidenceRefs": list(evidence_refs),
                "artifactCount": len(artifact_refs),
                "createdBy": self.config.service_name,
                "updatedAt": _iso_now(),
            }
            parity_comparison = getattr(w02_contract, "parity_comparison", None)
            if isinstance(parity_comparison, Mapping) and parity_comparison:
                summary["parityComparison"] = dict(parity_comparison)
            if parity_run:
                summary["executionMode"] = context.execution_mode
                if context.source_reference_fixture_id:
                    summary["fixtureId"] = context.source_reference_fixture_id
                if context.trust_case_id:
                    summary["trustCaseId"] = context.trust_case_id
                if context.source_reference_mode:
                    summary["referenceMode"] = context.source_reference_mode
            _record_artifact(self.artifact_store.update_summary(context.run_id, context.workflow_id, summary))

        def _persist_model_policy_skipped(reason: str) -> ArtifactMetadata:
            nonlocal model_policy_skipped_meta
            if model_policy_skipped_meta is not None:
                return model_policy_skipped_meta
            model_policy_skipped_meta = self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                "model-policy-skipped.json",
                {
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "modelId": _text(getattr(self.config, "model_gateway_model_id", None))
                    or DEFAULT_MODEL_ID,
                    "status": "skipped",
                    "reason": reason,
                    "policyVersion": _text(getattr(self.config, "model_policy_version", None)) or "v0",
                    "timestamp": _iso_now(),
                    "createdBy": self.config.service_name,
                },
                kind=KIND_MODEL_POLICY_SKIPPED,
            )
            _record_artifact(model_policy_skipped_meta)
            return model_policy_skipped_meta

        def _persist_model_invocation_ledger(
            request_payload: Mapping[str, JsonValue],
            request_ref: DataReference,
            response_payload: Mapping[str, JsonValue],
        ) -> ArtifactMetadata:
            # Issue #168: persist the policyId and agentRole returned by the
            # Model Gateway. policyId is required by the v0 ledger schema;
            # agentRole and usage are recorded when present so evidence and
            # learning consumers can read them without a second HTTP round-
            # trip to the gateway.
            policy_version = _text(
                getattr(self.config, "model_policy_version", None)
            ) or "v0"
            ledger_payload = {
                "schemaVersion": "v0",
                "invocationId": _text(response_payload.get("invocationId")) or f"inv-{context.run_id}-00",
                "runId": context.run_id,
                "modelId": _text(response_payload.get("modelId"))
                or _text(request_payload.get("modelId"))
                or DEFAULT_MODEL_ID,
                "provider": _text(response_payload.get("provider")) or "unknown",
                "policyId": _text(response_payload.get("policyId"))
                or f"foundry-development-{policy_version}",
                "dataClass": _text(request_payload.get("dataClass")) or DATA_CLASS_MODEL,
                "promptTemplateVersion": _text(response_payload.get("promptTemplateVersion"))
                or _text(request_payload.get("promptTemplateVersion"))
                or DEFAULT_PROMPT_TEMPLATE_VERSION,
                "policyDecision": _text(response_payload.get("policyDecision")) or POLICY_ALLOW,
                "status": _text(response_payload.get("status")) or "completed",
                "latencyMs": int(response_payload.get("latencyMs") or 0),
                "requestRef": _as_reference_payload(request_ref),
                "outputRef": _as_reference_payload(
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/model-output",
                        _first_non_empty_mapping(response_payload.get("output")),
                    )
                ),
                "parameters": dict(_first_non_empty_mapping(request_payload.get("parameters"))),
                "structuredOutput": bool(request_payload.get("structuredOutput")),
                "createdAt": _iso_now(),
            }
            agent_role = _text(response_payload.get("agentRole")) or _text(
                request_payload.get("agentRole")
            )
            if agent_role:
                ledger_payload["agentRole"] = agent_role
            usage = response_payload.get("usage")
            if isinstance(usage, Mapping) and usage:
                ledger_payload["usage"] = dict(usage)
            error_code = _text(response_payload.get("errorCode"))
            if error_code:
                ledger_payload["errorCode"] = error_code
            return self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                "model-invocation-ledger.json",
                ledger_payload,
                kind=KIND_MODEL_INVOCATION_LEDGER,
            )

        try:
            self.artifact_store.init_run(
                context.run_id,
                context.workflow_id,
                requester=context.requester,
            )
            _record_artifact(
                self.artifact_store.write_text(
                    context.run_id,
                    context.workflow_id,
                    "source.cbl",
                    source_text,
                    kind=KIND_SOURCE,
                    mime_type="text/x-cobol",
                )
            )
            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "source-ref.json",
                    {
                        "runId": context.run_id,
                        "workflowId": context.workflow_id,
                        "inputRef": _as_reference_payload(input_reference),
                        "rawInputRef": dict(input_ref),
                    },
                    kind=KIND_SOURCE_REF,
                )
            )
            _write_summary("starting", message="orchestrator workflow accepted")
            self._record_marker_step(
                context,
                name=STEP_ACCEPTED,
                status=STEP_STATUS_OK,
                run_status="starting",
            )
            if parity_run:
                self._record_step_start(
                    context,
                    name=STEP_TRANSFORM,
                    capability_id=self.config.generator_capability_id,
                    actor=self.config.service_name,
                    input_ref=input_reference,
                )
            self._emit_workflow_decision_event(
                context,
                "orchestrator.workflow.accepted",
                "workflow started",
            )
            # Issue #166: source has been persisted to the artifact store
            # (source.cbl and source-ref.json above). Advance the W0.2 state
            # machine to ``source_normalized`` so consumers can see the run
            # has cleared input intake.
            self._advance_w02(
                context,
                w02_contract,
                STATE_SOURCE_NORMALIZED,
                active_step=W02_STEP_NORMALIZE_SOURCE,
                message="source persisted to artifact store",
            )
            self.gateway.update_run(
                context.run_id,
                "updating",
                updated_by=self.config.service_name,
                message="orchestrator workflow started",
                evidence_refs=evidence_refs,
                policy_decision=POLICY_ALLOW,
            )
            _write_summary("updating", message="orchestrator workflow started")
            if not context.model_prompt:
                _persist_model_policy_skipped(
                    "no modelPrompt provided by requester; deterministic W0 translation completed without model assistance"
                )

            parse_capability = self._require_capability(context.run_id, self.config.parse_capability_id)
            ir_capability = self._require_capability(context.run_id, self.config.ir_capability_id)
            generator_capability = self._require_capability(context.run_id, self.config.generator_capability_id)
            source_reference_capability = (
                self._require_capability(context.run_id, self.config.source_reference_capability_id)
                if parity_run
                else None
            )
            build_test_capability = self._require_capability(
                context.run_id,
                self.config.build_test_capability_id,
            )
            evidence_capability = self._require_capability(context.run_id, self.config.evidence_capability_id)
            w02_contract.set_active_step(W02_STEP_PARSE_COBOL)

            parse_output = self._invoke_step(
                context,
                "parse-cobol",
                parse_capability,
                DATA_CLASS_PARSER,
                {
                    "schemaVersion": "v0",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "capability": self.config.parse_capability_id,
                    "source": source_text,
                    "sourceHash": input_reference.sha256,
                    "sourceRef": _as_reference_payload(input_reference),
                },
                _build_reference(
                    f"urn:orchestrator/{context.run_id}/step/parse/input",
                    input_reference.__dict__,
                ),
            )
            step_results.append(parse_output)
            evidence_refs.append(parse_output.output_ref.uri)
            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "parse-output.json",
                    dict(parse_output.payload),
                    kind=KIND_PARSE_OUTPUT,
                )
            )
            program_id = self._resolve_program_id(parse_output.payload) or program_id
            completed_steps.append("parse-cobol")
            _write_summary("updating", message="parse-cobol completed")
            self._advance_w02(
                context,
                w02_contract,
                STATE_COBOL_PARSE_ATTEMPTED,
                active_step=W02_STEP_GENERATE_IR,
                message="cobol parser returned ok",
            )

            try:
                ir_output = self._invoke_step(
                    context,
                    "generate-ir",
                    ir_capability,
                    DATA_CLASS_PARSER,
                    {
                        "schemaVersion": "v0",
                        "runId": context.run_id,
                        "workflowId": context.workflow_id,
                        "parseOutput": parse_output.payload,
                    },
                    parse_output.output_ref,
                )
            except Exception:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_SEMANTIC_IR_BLOCKED,
                    active_step=W02_STEP_GENERATE_IR,
                    message="semantic IR generation failed",
                    failure_code=w02.FAILURE_SEMANTIC_IR_FAILED,
                )
                raise
            step_results.append(ir_output)
            evidence_refs.append(ir_output.output_ref.uri)

            ir_document = _first_non_empty_mapping(ir_output.payload.get("ir"))
            if not ir_document and "irOutput" in ir_output.payload:
                ir_document = _first_non_empty_mapping(ir_output.payload.get("irOutput", {}).get("ir"))

            source_ref_from_ir = _first_non_empty_mapping(ir_output.payload.get("sourceRef"))
            if not source_ref_from_ir:
                source_ref_from_ir = _as_reference_payload(parse_output.output_ref)

            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "semantic-ir-output.json",
                    dict(ir_output.payload),
                    kind=KIND_SEMANTIC_IR_OUTPUT,
                )
            )
            ir_status = (_text(ir_output.payload.get("status")) or "").strip().lower()
            if not ir_document or ir_status in {"failed", "error", "unsupported", "blocked"}:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_SEMANTIC_IR_BLOCKED,
                    active_step=W02_STEP_GENERATE_IR,
                    message="semantic IR was not produced",
                    failure_code=w02.FAILURE_SEMANTIC_IR_FAILED,
                )
                raise StepExecutionError("step generate-ir failed: semantic IR was not produced")
            if ir_document:
                _record_artifact(
                    self.artifact_store.write_json(
                        context.run_id,
                        context.workflow_id,
                        "semantic-ir.json",
                        dict(ir_document),
                        kind=KIND_SEMANTIC_IR,
                    )
                )
            program_id = self._resolve_program_id(parse_output.payload, ir_output.payload) or program_id
            completed_steps.append("generate-ir")
            _write_summary("updating", message="generate-ir completed")
            self._advance_w02(
                context,
                w02_contract,
                STATE_SEMANTIC_IR_READY,
                active_step=W02_STEP_GENERATE_JAVA,
                message="semantic IR produced",
            )
            self._advance_w02(
                context,
                w02_contract,
                STATE_BASELINE_GENERATION_ATTEMPTED,
                active_step=W02_STEP_GENERATE_JAVA,
                message="deterministic java generator invoked",
            )

            generator_output = self._invoke_step(
                context,
                "generate-java",
                generator_capability,
                DATA_CLASS_GENERATOR,
                {
                    "schemaVersion": "v0",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "sourceRef": source_ref_from_ir,
                    "ir": ir_document,
                },
                ir_output.output_ref,
            )
            # Issue #167: validate any productive-agent-shaped payload before
            # the Orchestrator consumes it. The deterministic generator never
            # sets ``agentRole`` so this is a no-op for the W0/W0.2 default
            # path; the guard becomes load-bearing once a productive
            # Transformation Agent is plugged in here.
            agent_error = self._guard_agent_invocation_payload(generator_output.payload)
            if agent_error is not None:
                raise AgentContractInvalidStepError(
                    f"step generate-java failed: {agent_error}"
                )
            step_results.append(generator_output)
            evidence_refs.append(generator_output.output_ref.uri)

            generated_project = _first_non_empty_mapping(generator_output.payload.get("generatedProject"))
            program_id = (
                self._resolve_program_id(parse_output.payload, ir_output.payload, generator_output.payload)
                or program_id
            )
            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "generation-response.json",
                    dict(generator_output.payload),
                    kind=KIND_GENERATION_RESPONSE,
                )
            )
            persisted_file_metas: list[ArtifactMetadata] = []
            for file_path, file_content in _iter_generated_files(generated_project):
                meta = self.artifact_store.write_text(
                    context.run_id,
                    context.workflow_id,
                    f"{GENERATED_PROJECT_DIR}/{file_path}",
                    file_content,
                    kind=KIND_GENERATED_PROJECT_FILE,
                )
                _record_artifact(meta)
                if meta is not None:
                    persisted_file_metas.append(meta)
            ir_document_id = _text(_first_non_empty_mapping(ir_document).get("irId"))
            project_manifest = _build_generated_project_manifest(
                run_id=context.run_id,
                workflow_id=context.workflow_id,
                generated_project=generated_project,
                persisted_files=[m.to_dict() for m in persisted_file_metas],
                program_id=program_id,
                ir_id=ir_document_id,
                source_sha256=input_reference.sha256,
            )
            manifest_meta = self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                GENERATED_PROJECT_MANIFEST_FILE,
                project_manifest,
                kind=KIND_GENERATED_PROJECT_MANIFEST,
            )
            _record_artifact(manifest_meta)
            generated_artifact_ref: JsonObject | None = None
            if manifest_meta is not None:
                generated_artifact_ref = {
                    "uri": manifest_meta.uri,
                    "sha256": manifest_meta.sha256,
                    "byteSize": manifest_meta.byteSize,
                    "path": manifest_meta.path,
                    "kind": manifest_meta.kind,
                }
            completed_steps.append("generate-java")
            _write_summary("updating", message="generate-java completed")
            if parity_run and generated_artifact_ref is not None:
                self._record_step_finish(
                    context,
                    name=STEP_TRANSFORM,
                    capability_id=self.config.generator_capability_id,
                    actor=self.config.service_name,
                    status=STEP_STATUS_OK,
                    input_ref=input_reference,
                    output_ref=DataReference(
                        uri=str(generated_artifact_ref.get("uri") or ""),
                        sha256=str(generated_artifact_ref.get("sha256") or ""),
                        byte_size=int(generated_artifact_ref.get("byteSize") or 0),
                    ),
                )
            baseline_artifact_ref: JsonObject | None = generated_artifact_ref
            baseline_generated_project: Mapping[str, JsonValue] | None = generated_project
            agent_result: TransformationAgentResult | None = None

            # Issue #214 (W0.3-3): the assist-decision gate. Every productive
            # run that reaches the post-baseline boundary records an explicit
            # Orchestrator-owned decision about whether productive AI assist
            # is required, the reason code, the selected agent role, the
            # affected artifacts, and the relevant repair-budget snapshot.
            # Consumers must read the decision from the contract instead of
            # inferring AI activation from ``agentAttemptCount > 0``.
            #
            # Issue #215 (W0.3-4) extends the closed reason-code set with
            # deterministic uncertainty criteria sourced from the IR and the
            # baseline generator output. The gate picks the most specific
            # marker as the reason code when one is detected; the contract
            # shape is unchanged.
            self._record_assist_decision(
                context,
                w02_contract,
                baseline_artifact_ref=baseline_artifact_ref,
                ir_output_ref=ir_output.output_ref,
                ir_document=ir_document,
                baseline_generated_project=baseline_generated_project,
            )

            # Issue #169: when the requester opted into the productive
            # Transformation Agent, invoke it after the deterministic
            # baseline. On success its Java candidate becomes the artifact
            # fed into build/test; the baseline is preserved as a traceable
            # artifact and as a fallback reference in the run contract.
            #
            # Issue #216 (W0.3-5): the assist-decision gate above is the
            # contract-level authority for productive activation. If the
            # gate decided ``assist_not_required`` (caller opted out, or
            # the assist budget is exhausted), the orchestrator must skip
            # the productive transformation agent and proceed with the
            # deterministic baseline as the final candidate. This prevents
            # the implicit-activation regression that #213 closed and the
            # budget-bypass regression #216 hardens against.
            assist_authorised = (
                w02_contract.assist_decision is not None
                and w02_contract.assist_decision.outcome == ASSIST_OUTCOME_REQUIRED
                and w02_contract.assist_decision.selected_agent_role
                == ASSIST_AGENT_ROLE_TRANSFORMATION
            )
            if context.use_transformation_agent and assist_authorised and not parity_run:
                # Drive the W0.2 state machine through the productive-agent
                # transition before invoking the agent so the run contract
                # accurately reflects what the orchestrator is doing.
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_TRANSFORMATION_AGENT_INVOKED,
                    active_step=W02_STEP_TRANSFORMATION_AGENT,
                    message="productive transformation agent invoked",
                )
                self._record_step_start(
                    context,
                    name=W02_STEP_TRANSFORMATION_AGENT,
                    capability_id=self.config.model_gateway_capability_id,
                    actor="transformation-agent",
                    input_ref=ir_output.output_ref,
                )
                oracle_payload_for_agent = _build_cobol_oracle_payload(
                    raw_source_text,
                    input_reference,
                    getattr(
                        self.config,
                        "build_test_oracle_timeout_ms",
                        DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS,
                    ),
                    expected_output=oracle_metadata["expectedOutput"],
                    oracle_input=oracle_metadata["oracleInput"],
                )
                oracle_reference_for_agent: DataReference | None = None
                if oracle_payload_for_agent is not None:
                    oracle_reference_for_agent = _build_reference(
                        f"urn:orchestrator/{context.run_id}/oracle",
                        oracle_payload_for_agent,
                    )
                # Issue #216 (W0.3-5): consume one Model Gateway unit
                # before the productive transformation call so an
                # exhausted budget hard-terminates *before* the gateway
                # is contacted. The runner's classifier special-cases
                # ``ModelInvocationBudgetExhaustedError`` (raised here
                # or carried as the cause of the StepExecutionError) so
                # the contract finalises as ``blocked`` /
                # ``model_gateway_unavailable`` rather than the generic
                # ``failed`` / ``java_generation_failed`` that the
                # step-name fallback would otherwise produce.
                try:
                    w02_contract.model_invocation_budget.consume()
                except ModelInvocationBudgetExhaustedError as exhausted_exc:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_TRANSFORMATION_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="transformation-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=ir_output.output_ref,
                        diagnostic=str(exhausted_exc),
                        run_status="failed",
                        failed_step=W02_STEP_TRANSFORMATION_AGENT,
                    )
                    raise StepExecutionError(
                        f"transformation agent step {W02_STEP_TRANSFORMATION_AGENT} "
                        f"blocked by model invocation budget exhaustion: "
                        f"{exhausted_exc}"
                    ) from exhausted_exc
                try:
                    agent_result = self._invoke_transformation_agent(
                        context,
                        w02_contract,
                        source_text=source_text,
                        source_reference=input_reference,
                        source_program_id=program_id,
                        ir_document=ir_document,
                        ir_output_ref=ir_output.output_ref,
                        baseline_artifact_ref=baseline_artifact_ref,
                        baseline_files=(
                            {
                                path: content
                                for path, content in _iter_generated_files(baseline_generated_project)
                            }
                            if baseline_generated_project
                            else None
                        ),
                        oracle_reference=oracle_reference_for_agent,
                        oracle_payload=oracle_payload_for_agent,
                    )
                except (
                    AgentContractInvalidAgentError,
                    ModelGatewayUnavailableError,
                    ModelPolicyDeniedAgentError,
                    AgentTimeoutError,
                ) as exc:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_TRANSFORMATION_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="transformation-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=ir_output.output_ref,
                        diagnostic=str(exc),
                        run_status="failed",
                        failed_step=W02_STEP_TRANSFORMATION_AGENT,
                    )
                    if isinstance(exc, ModelPolicyDeniedAgentError):
                        raise ModelPolicyDeniedStepError(
                            f"transformation agent blocked by model gateway policy: {exc}"
                        ) from exc
                    if isinstance(exc, AgentContractInvalidAgentError):
                        raise AgentContractInvalidStepError(
                            f"transformation agent contract violation: {exc}"
                        ) from exc
                    # Gateway unavailable / agent timeout map to canonical
                    # W0.2 failure codes via the runner's exception
                    # classification, but we surface a StepExecutionError so
                    # the existing failure-handling path reports the right
                    # run state.
                    raise StepExecutionError(
                        f"transformation agent step {W02_STEP_TRANSFORMATION_AGENT} failed: {exc}"
                    ) from exc

                _record_productive_model_invocation(
                    agent_result.model_invocation_ref,
                    agent_role="transformation",
                )
                if agent_result.candidate is not None:
                    # The persisted manifest the agent wrote IS the source
                    # of truth for build/test. Replace the baseline manifest
                    # reference with the agent's manifest reference so
                    # downstream consumers point at the agent's output.
                    agent_manifest_ref = dict(agent_result.java_candidate_ref or {})
                    if agent_manifest_ref:
                        generated_artifact_ref = agent_manifest_ref
                    # Build a generatedProject snapshot from the candidate
                    # files so the build-test runner receives the agent's
                    # Java content (mirrors the deterministic generator
                    # payload shape).
                    entry_class_for_build = (
                        f"{agent_result.candidate.entry_package}.{agent_result.candidate.entry_class}"
                        if agent_result.candidate.entry_package
                        else agent_result.candidate.entry_class
                    )
                    generated_project = {
                        "entryClass": entry_class_for_build,
                        "entryPackage": agent_result.candidate.entry_package,
                        "entryFilePath": agent_result.candidate.entry_file_path,
                        "fileCount": len(agent_result.candidate.files),
                        "files": dict(agent_result.candidate.files),
                        "unsupportedConstructs": list(
                            agent_result.candidate.unsupported_constructs
                        ),
                        "generationSource": "transformation-agent",
                    }
                    self._record_step_finish(
                        context,
                        name=W02_STEP_TRANSFORMATION_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="transformation-agent",
                        status=STEP_STATUS_OK,
                        input_ref=ir_output.output_ref,
                        output_ref=DataReference(
                            uri=agent_manifest_ref.get("uri", ""),
                            sha256=str(agent_manifest_ref.get("sha256") or ""),
                            byte_size=int(agent_manifest_ref.get("byteSize") or 0),
                        ),
                    )
                    completed_steps.append(W02_STEP_TRANSFORMATION_AGENT)
                    _write_summary(
                        "updating",
                        message="transformation-agent completed",
                    )
                else:
                    # Agent returned blocked/failed without a candidate.
                    # Map to the canonical W0.2 failure code and finalise
                    # the run as blocked. We still keep the baseline
                    # candidate visible in the run contract for traceability
                    # but do not feed it to build/test because the
                    # requester explicitly asked for the productive agent.
                    self._record_step_finish(
                        context,
                        name=W02_STEP_TRANSFORMATION_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="transformation-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=ir_output.output_ref,
                        diagnostic=agent_result.failure_message or agent_result.status,
                        run_status="failed",
                        failed_step=W02_STEP_TRANSFORMATION_AGENT,
                    )
                    failure_code_for_state = (
                        agent_result.failure_code or "java_generation_failed"
                    )
                    if failure_code_for_state not in (
                        FAILURE_AGENT_CONTRACT_INVALID,
                        FAILURE_MODEL_POLICY_DENIED,
                        FAILURE_MODEL_GATEWAY_UNAVAILABLE,
                        "unsupported_cobol",
                        "agent_timeout",
                        "java_generation_failed",
                    ):
                        failure_code_for_state = "java_generation_failed"
                    w02_blocked = True
                    w02_failure_code = failure_code_for_state
                    w02_failure_message = (
                        agent_result.failure_message
                        or f"transformation agent returned {agent_result.status}"
                    )

            if generated_artifact_ref is not None:
                w02_contract.set_generated_java_ref(generated_artifact_ref)
            self._advance_w02(
                context,
                w02_contract,
                STATE_JAVA_CANDIDATE_PERSISTED,
                active_step=W02_STEP_COMPILE_TEST_JAVA,
                message="java candidate persisted to artifact store",
            )
            # Issue #255 / Studio-IDE-13: ``generate_only`` short-circuit.
            # When the caller invoked /api/v0/generate the orchestrator
            # finishes the generator pipeline and stops; build/test/oracle
            # and evidence-write are deliberately skipped (per the issue
            # spec) and the run finalises as ``incomplete`` with the
            # sentinel failure code ``generate_only_complete``. UI
            # consumers render this as "Java artifacts ready; verification
            # was not requested" rather than as a real failure (see
            # ``W02UiErrorCode`` in the Studio).
            if context.generate_only and not w02_blocked:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_RUN_BLOCKED,
                    active_step=None,
                    message=(
                        "generator-only run completed; verification was not requested"
                    ),
                    failure_code=FAILURE_GENERATE_ONLY_COMPLETE,
                )
                self._finalize_w02(
                    context,
                    w02_contract,
                    CLASSIFICATION_INCOMPLETE,
                    failure_code=FAILURE_GENERATE_ONLY_COMPLETE,
                    failure_message=(
                        "generator-only run completed; verification was not requested"
                    ),
                )
                self._record_marker_step(
                    context,
                    name=STEP_COMPLETED,
                    status=STEP_STATUS_OK,
                    run_status="completed",
                )
                self._emit_workflow_decision_event(
                    context,
                    "orchestrator.workflow.completed",
                    "generator-only run completed",
                )
                _write_summary(
                    "completed", message="generator-only run completed"
                )
                self.gateway.update_run(
                    context.run_id,
                    "completed",
                    updated_by=self.config.service_name,
                    message="generator-only run completed",
                    evidence_refs=evidence_refs,
                    policy_decision=POLICY_ALLOW,
                )
                try:
                    self._flush_to_experience_learning(
                        context.run_id, trajectory_payload
                    )
                except Exception:  # pragma: no cover - best-effort
                    pass
                return {
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "status": CLASSIFICATION_INCOMPLETE,
                    "stepCount": len(step_results),
                    "artifacts": list(artifact_refs),
                    "workflowContract": w02_contract.to_dict(),
                }
            if w02_blocked:
                # When the productive agent failed we record run_blocked
                # immediately and skip build/test so the deterministic
                # gatekeeper does not silently pass an unverified baseline.
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_RUN_BLOCKED,
                    active_step=None,
                    message=w02_failure_message or "transformation agent blocked",
                    failure_code=w02_failure_code,
                )
            else:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_BUILD_TEST_RUNNING,
                    active_step=W02_STEP_COMPILE_TEST_JAVA,
                    message="build-test runner invoked",
                )

            # When the productive Transformation Agent blocked the run we
            # skip build/test entirely so the deterministic gatekeeper does
            # not pass an unverified baseline behind the agent's back.
            source_reference_output: WorkflowStepResult | None = None
            build_test_output: WorkflowStepResult | None = None
            success = False
            build_failure_code: str | None = w02_failure_code
            build_test_input: JsonObject = {}
            if w02_blocked:
                pass
            else:
                if parity_run:
                    if source_reference_capability is None:
                        raise OrchestratorError("parity run requires source-reference capability")
                    fixture_id = _text(context.source_reference_fixture_id)
                    reference_mode = _text(context.source_reference_mode)
                    if fixture_id is None or reference_mode is None:
                        raise OrchestratorError(
                            "parity run requires source reference fixtureId and referenceMode"
                        )
                    self._record_step_start(
                        context,
                        name=STEP_SOURCE_REFERENCE,
                        capability_id=self.config.source_reference_capability_id,
                        actor=self.config.service_name,
                        input_ref=input_reference,
                    )
                    source_reference_output = self._invoke_step(
                        context,
                        STEP_SOURCE_REFERENCE,
                        source_reference_capability,
                        DATA_CLASS_BUILD_TEST,
                        {
                            "schemaVersion": "v0",
                            "runId": context.run_id,
                            "workflowId": context.workflow_id,
                            "fixtureId": fixture_id,
                            "referenceMode": reference_mode,
                        },
                        input_reference,
                    )
                    step_results.append(source_reference_output)
                    evidence_refs.append(source_reference_output.output_ref.uri)
                    _record_artifact(
                        self.artifact_store.write_json(
                            context.run_id,
                            context.workflow_id,
                            SOURCE_REFERENCE_EXECUTION_RESULT_FILE,
                            dict(source_reference_output.payload),
                            kind="parity-execution-result",
                        )
                    )
                    self._record_step_finish(
                        context,
                        name=STEP_SOURCE_REFERENCE,
                        capability_id=self.config.source_reference_capability_id,
                        actor=self.config.service_name,
                        status=(
                            STEP_STATUS_OK
                            if str(source_reference_output.payload.get("status") or "").strip() == "passed"
                            else STEP_STATUS_FAILED
                        ),
                        input_ref=input_reference,
                        output_ref=source_reference_output.output_ref,
                        diagnostic=_text(source_reference_output.payload.get("summary")),
                    )
                    completed_steps.append(STEP_SOURCE_REFERENCE)
                    _write_summary("updating", message="source/reference execution completed")
                    if str(source_reference_output.payload.get("status") or "").strip() != "passed":
                        diagnostics = source_reference_output.payload.get("diagnostics")
                        unsupported = False
                        if isinstance(diagnostics, list):
                            unsupported = any(
                                isinstance(entry, Mapping)
                                and _text(entry.get("code")) == "unsupported-program-shape"
                                for entry in diagnostics
                            )
                        w02_blocked = True
                        w02_failure_code = (
                            FAILURE_UNSUPPORTED_COBOL
                            if unsupported
                            else FAILURE_SOURCE_REFERENCE_FAILED
                        )
                        w02_failure_message = (
                            _text(source_reference_output.payload.get("summary"))
                            or "source/reference execution failed"
                        )
                        self._advance_w02(
                            context,
                            w02_contract,
                            STATE_RUN_BLOCKED,
                            active_step=None,
                            message=w02_failure_message,
                            failure_code=w02_failure_code,
                        )
                build_test_input = {
                    "schemaVersion": "v0",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "programId": program_id or f"{context.run_id}-build",
                    "generatedProject": generated_project,
                    "generationResponse": generator_output.payload,
                    "sourceRef": _as_reference_payload(generator_output.input_ref),
                }
                if generated_artifact_ref is not None:
                    build_test_input["generatedArtifactRef"] = generated_artifact_ref
                oracle_expected_output = oracle_metadata["expectedOutput"]
                if (
                    parity_run
                    and context.source_reference_mode == REFERENCE_MODE_REFERENCE_FIXTURE
                    and parity_fixture is not None
                    and not oracle_expected_output
                ):
                    oracle_expected_output = _load_fixture_expected_output(parity_fixture)
                    if not oracle_expected_output:
                        raise OrchestratorError(
                            f"parity run {context.run_id} requires fixture output for {context.source_reference_fixture_id}"
                        )
                oracle_payload = _build_cobol_oracle_payload(
                    raw_source_text,
                    input_reference,
                    getattr(self.config, "build_test_oracle_timeout_ms", DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS),
                    expected_output=oracle_expected_output,
                    oracle_input=oracle_metadata["oracleInput"],
                )
                if oracle_payload is not None:
                    build_test_input["oracle"] = oracle_payload

                if not w02_blocked:
                    if parity_run:
                        self._record_step_start(
                            context,
                            name=STEP_JAVA_BUILD,
                            capability_id=self.config.build_test_capability_id,
                            actor=self.config.service_name,
                            input_ref=generator_output.output_ref,
                        )
                    build_test_output = self._invoke_step(
                        context,
                        "compile-test-java",
                        build_test_capability,
                        DATA_CLASS_BUILD_TEST,
                        build_test_input,
                        generator_output.output_ref,
                    )
                    step_results.append(build_test_output)
                    evidence_refs.append(build_test_output.output_ref.uri)
                    _record_artifact(
                        self.artifact_store.write_json(
                            context.run_id,
                            context.workflow_id,
                            "build-test-result.json",
                            dict(build_test_output.payload),
                            kind=KIND_BUILD_TEST_RESULT,
                        )
                    )
                    completed_steps.append("compile-test-java")
                    _write_summary("updating", message="compile-test-java completed")
                    w02_contract.set_build_test_result_ref(_as_reference_payload(build_test_output.output_ref))
                    parity_comparison, parity_artifacts = self._project_parity_comparison(
                        context=context,
                        build_test_output=build_test_output,
                        persist=True,
                    )
                    for meta in parity_artifacts:
                        _record_artifact(meta)
                    w02_contract.set_parity_comparison(parity_comparison)
                    if parity_run:
                        self._record_parity_build_steps(
                            context=context,
                            build_test_output=build_test_output,
                            input_ref=generator_output.output_ref,
                        )

            # Issue #166 / Issue #170: W0.2 verification/repair loop. The
            # build-test runner is the deterministic gate; on a failed
            # outcome we invoke the productive Verification/Repair Agent.
            # The agent inspects the failure context and returns one of:
            #   * propose_candidate — re-run build/test on its Java,
            #   * refuse / escalate — terminate the loop as blocked,
            #   * no_change       — terminate the loop (Orchestrator-side
            #                       no-change detection prevents the agent
            #                       from burning budget on identical files).
            # The loop is bounded by the repair budget; when the budget is
            # exhausted with no successful build, the run is blocked with
            # the LAST objective build-test failure code preserved. When
            # the productive Transformation Agent already blocked the run
            # before build/test ran, there is no outcome to classify and
            # the loop is skipped entirely.
            previous_repair_decision_refs: list[JsonObject] = []
            repair_attempt_counter = 0
            if build_test_output is not None:
                success, build_failure_code = build_test_outcome(build_test_output.payload)
            if parity_run and build_test_output is not None and not success:
                w02_blocked = True
                w02_failure_code = build_failure_code or FAILURE_JAVA_COMPILE_FAILED
                w02_failure_message = (
                    _text(build_test_output.payload.get("summary"))
                    or "parity verification failed"
                )
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_RUN_BLOCKED,
                    active_step=None,
                    message=w02_failure_message,
                    failure_code=w02_failure_code,
                )
            while build_test_output is not None and not success and not parity_run:
                if w02_contract.repair_budget.exhausted:
                    w02_blocked = True
                    w02_failure_code = build_failure_code
                    w02_failure_message = (
                        f"build-test verification failed; repair budget "
                        f"({w02_contract.repair_budget.limit}) exhausted"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=build_failure_code,
                    )
                    break
                # Capture the failing candidate's reference and content
                # *before* we consume budget so the repair agent receives
                # a complete failure context. The deterministic baseline
                # files (or the prior agent's files) are the input for
                # no-change detection.
                previous_candidate_files: dict[str, str] = {
                    path: content
                    for path, content in _iter_generated_files(generated_project)
                }
                if not previous_candidate_files:
                    # Defensive: a generator that does not surface its
                    # files map cannot drive a meaningful repair attempt.
                    w02_blocked = True
                    w02_failure_code = build_failure_code
                    w02_failure_message = (
                        "verification/repair agent cannot run without the "
                        "previous candidate's files"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=build_failure_code,
                    )
                    break
                previous_candidate_ref: JsonObject
                if generated_artifact_ref is not None:
                    previous_candidate_ref = dict(generated_artifact_ref)
                else:
                    # Materialise an artifact ref out of the generator
                    # output so the repair agent has a stable reference.
                    previous_candidate_ref = dict(
                        _as_reference_payload(generator_output.output_ref)
                    )
                build_test_result_ref_payload = dict(
                    _as_reference_payload(build_test_output.output_ref)
                )
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_VERIFICATION_REPAIR_INVOKED,
                    active_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    message="verification/repair agent invoked",
                    failure_code=build_failure_code,
                )
                try:
                    w02_contract.repair_budget.consume()
                except RepairBudgetExhaustedError:
                    # Defensive: the ``exhausted`` check above should make
                    # this unreachable, but a concurrent caller could in
                    # principle advance the counter. Treat it as the
                    # blocked path.
                    w02_blocked = True
                    w02_failure_code = build_failure_code
                    w02_failure_message = (
                        f"build-test verification failed; repair budget "
                        f"({w02_contract.repair_budget.limit}) exhausted"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=build_failure_code,
                    )
                    break
                repair_attempt_counter += 1
                attempt = repair_attempt_counter
                # The agent_attempt_count tracks productive-agent
                # invocations across the run; each repair attempt is a
                # distinct productive agent call so we increment here
                # alongside the dedicated repair counter.
                w02_contract.record_agent_attempt()
                # The repair agent produces the next Java candidate. The
                # Transformation-Agent state is reused as the "agent
                # generating Java" marker on the state machine because the
                # state-machine contract (Issue #166) only knows about
                # those two productive-agent transitions.
                self._record_step_start(
                    context,
                    name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    capability_id=self.config.model_gateway_capability_id,
                    actor="verification-repair-agent",
                    input_ref=build_test_output.output_ref,
                )
                # ADR 0007 §5 / Issue #280: when the manual-edit
                # assist-interaction rule blocks the iteration, skip the
                # Model Gateway budget consume so the manual-region guard
                # never burns productive-assist budget. The repair agent
                # short-circuits to ``no_change`` without invoking the
                # gateway, and the orchestrator records the attempt on
                # the trajectory below.
                _manual_block_pending = should_manual_region_block_repair(
                    context.manual_overlay_regions,
                    w02_contract.assist_decision.reason_code
                    if w02_contract.assist_decision is not None
                    else None,
                )
                # Issue #216 (W0.3-5): consume one Model Gateway unit
                # before each repair-iteration call so an exhausted
                # budget terminates the loop *before* the gateway is
                # contacted. Records the exhaustion as a refused repair
                # attempt on the trajectory and blocks the run with the
                # last objective build-test failure code so consumers can
                # distinguish budget exhaustion from agent-side failures.
                try:
                    if not _manual_block_pending:
                        w02_contract.model_invocation_budget.consume()
                except ModelInvocationBudgetExhaustedError as exhausted_exc:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="verification-repair-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=build_test_output.output_ref,
                        diagnostic=str(exhausted_exc),
                        run_status="failed",
                        failed_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    )
                    w02_contract.record_repair_attempt(
                        {
                            "attemptNumber": attempt,
                            "repairDecision": "refuse",
                            "failureCategory": build_failure_code,
                            "refusalCode": "model_invocation_budget_exhausted",
                            "rationale": str(exhausted_exc),
                            "buildTestResultRef": build_test_result_ref_payload,
                        }
                    )
                    w02_blocked = True
                    w02_failure_code = build_failure_code
                    w02_failure_message = (
                        f"verification/repair agent blocked by model "
                        f"invocation budget exhaustion: {exhausted_exc}"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=build_failure_code,
                    )
                    break
                try:
                    compile_error_ref, runtime_error_ref, oracle_diff_ref = self._build_manual_diagnosis_refs(
                        build_test_output.payload,
                        parity_comparison=parity_comparison,
                    )
                    repair_result = self._invoke_repair_agent(
                        context,
                        w02_contract,
                        attempt_number=attempt,
                        previous_java_candidate_ref=previous_candidate_ref,
                        previous_java_files=previous_candidate_files,
                        build_test_result_ref=build_test_result_ref_payload,
                        build_test_payload=dict(build_test_output.payload),
                        failure_category=build_failure_code or "java_compile_failed",
                        source_text=source_text,
                        source_cobol_ref=_as_reference_payload(input_reference),
                        oracle_payload=(
                            dict(build_test_input["oracle"])
                            if isinstance(build_test_input.get("oracle"), Mapping)
                            else None
                        ),
                        semantic_ir=ir_document,
                        semantic_ir_ref=_as_reference_payload(ir_output.output_ref),
                        compile_error_ref=compile_error_ref,
                        runtime_error_ref=runtime_error_ref,
                        oracle_diff_ref=oracle_diff_ref,
                        previous_repair_decision_refs=list(previous_repair_decision_refs),
                        repair_budget_remaining=w02_contract.repair_budget.remaining,
                    )
                except RepairAgentError as repair_exc:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="verification-repair-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=build_test_output.output_ref,
                        diagnostic=str(repair_exc),
                        run_status="failed",
                        failed_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    )
                    repair_failure_code = self._failure_code_for_repair_exception(
                        repair_exc
                    )
                    failed_attempt: JsonObject = {
                        "attemptNumber": attempt,
                        "repairDecision": "refuse",
                        "failureCategory": build_failure_code,
                        "refusalCode": "no_safe_repair",
                        "rationale": str(repair_exc),
                        "buildTestResultRef": build_test_result_ref_payload,
                    }
                    if repair_exc.model_invocation_ref:
                        _record_productive_model_invocation(
                            repair_exc.model_invocation_ref,
                            agent_role="verification-repair",
                        )
                        failed_attempt["modelInvocationRef"] = dict(
                            repair_exc.model_invocation_ref
                        )
                    if repair_exc.repair_input_artifact_ref:
                        failed_attempt["repairInputRef"] = dict(
                            repair_exc.repair_input_artifact_ref
                        )
                    if repair_exc.repair_decision_artifact_ref:
                        failed_attempt["repairDecisionRef"] = dict(
                            repair_exc.repair_decision_artifact_ref
                        )
                    w02_contract.record_repair_attempt(failed_attempt)
                    w02_blocked = True
                    w02_failure_code = repair_failure_code
                    w02_failure_message = (
                        f"verification/repair agent failed: {repair_exc}"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=repair_failure_code,
                    )
                    break
                # Persist the agent's decision reference for any subsequent
                # attempt's previousRepairDecisionRefs array. Skip when the
                # manual-region guard short-circuited the iteration: no
                # decision artifact was written (ADR 0007 §5 / Issue #280).
                if repair_result.repair_decision_artifact_ref:
                    previous_repair_decision_refs.append(
                        dict(repair_result.repair_decision_artifact_ref)
                    )
                # Manual-region-guarded iterations never invoke the Model
                # Gateway, so there is no model invocation to record on the
                # productive-invocation ledger (Issue #280).
                if repair_result.model_invocation_ref:
                    _record_productive_model_invocation(
                        repair_result.model_invocation_ref,
                        agent_role="verification-repair",
                    )
                # Record the trajectory entry for this attempt regardless
                # of outcome — every attempt must be visible in the run
                # contract for Experience Learning. ``affectedRegions`` and
                # ``manualRegionBlock`` are populated when the manual-region
                # guard fires; ``record_repair_attempt`` filters ``None``
                # values so the entry stays compact for unaffected attempts.
                trajectory_entry: JsonObject = {
                    "attemptNumber": attempt,
                    "repairDecision": repair_result.decision,
                    "failureCategory": build_failure_code,
                    "refusalCode": repair_result.refusal_code,
                    "escalationCode": repair_result.escalation_code,
                    "rationale": repair_result.rationale,
                    "modelInvocationRef": (
                        dict(repair_result.model_invocation_ref)
                        if repair_result.model_invocation_ref
                        else None
                    ),
                    "repairInputRef": (
                        dict(repair_result.repair_input_artifact_ref)
                        if repair_result.repair_input_artifact_ref
                        else None
                    ),
                    "repairDecisionRef": (
                        dict(repair_result.repair_decision_artifact_ref)
                        if repair_result.repair_decision_artifact_ref
                        else None
                    ),
                    "buildTestResultRef": build_test_result_ref_payload,
                    "javaCandidateRef": (
                        dict(repair_result.new_java_candidate_ref)
                        if repair_result.new_java_candidate_ref
                        else None
                    ),
                }
                if repair_result.manual_region_block:
                    trajectory_entry["manualRegionBlock"] = True
                    trajectory_entry["affectedRegions"] = [
                        dict(region) for region in repair_result.affected_regions
                    ]
                w02_contract.record_repair_attempt(trajectory_entry)
                if repair_result.is_refusal or repair_result.is_escalation:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="verification-repair-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=build_test_output.output_ref,
                        diagnostic=repair_result.failure_message
                        or repair_result.rationale,
                        run_status="failed",
                        failed_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    )
                    w02_blocked = True
                    w02_failure_code = (
                        repair_result.failure_code
                        or self._failure_code_for_repair_outcome(repair_result)
                    )
                    w02_failure_message = (
                        repair_result.failure_message
                        or repair_result.rationale
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=w02_failure_code,
                    )
                    break
                if repair_result.is_no_change:
                    self._record_step_finish(
                        context,
                        name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="verification-repair-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=build_test_output.output_ref,
                        diagnostic=repair_result.failure_message
                        or "no-change repair detected",
                        run_status="failed",
                        failed_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    )
                    w02_blocked = True
                    w02_failure_code = (
                        repair_result.failure_code
                        or FAILURE_JAVA_GENERATION_FAILED
                    )
                    w02_failure_message = (
                        repair_result.failure_message
                        or f"no-change repair detected after attempt {attempt}; terminating loop"
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=w02_failure_code,
                    )
                    break
                # propose_candidate path: the persisted manifest IS the
                # new generated Java artifact. Replace the generated
                # project + manifest reference and re-run build/test.
                if repair_result.candidate is None or repair_result.new_java_candidate_ref is None:
                    # Defensive: the contract guarantees these are set when
                    # decision == propose_candidate. If the schema layer
                    # ever mutates we still terminate cleanly.
                    w02_blocked = True
                    w02_failure_code = FAILURE_AGENT_CONTRACT_INVALID
                    w02_failure_message = (
                        "verification/repair agent returned propose_candidate "
                        "without a Java candidate"
                    )
                    self._record_step_finish(
                        context,
                        name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                        capability_id=self.config.model_gateway_capability_id,
                        actor="verification-repair-agent",
                        status=STEP_STATUS_FAILED,
                        input_ref=build_test_output.output_ref,
                        diagnostic=w02_failure_message,
                        run_status="failed",
                        failed_step=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    )
                    self._advance_w02(
                        context,
                        w02_contract,
                        STATE_RUN_BLOCKED,
                        active_step=None,
                        message=w02_failure_message,
                        failure_code=w02_failure_code,
                    )
                    break
                generated_artifact_ref = dict(repair_result.new_java_candidate_ref)
                w02_contract.set_generated_java_ref(generated_artifact_ref)
                generated_project = {
                    "entryClass": repair_result.candidate.entry_class,
                    "entryFilePath": repair_result.candidate.entry_file_path,
                    "fileCount": len(repair_result.candidate.files),
                    "files": dict(repair_result.candidate.files),
                    "unsupportedConstructs": list(
                        repair_result.candidate.unsupported_constructs
                    ),
                    "generationSource": "verification-repair-agent",
                }
                self._record_step_finish(
                    context,
                    name=W02_STEP_VERIFICATION_REPAIR_AGENT,
                    capability_id=self.config.model_gateway_capability_id,
                    actor="verification-repair-agent",
                    status=STEP_STATUS_OK,
                    input_ref=build_test_output.output_ref,
                    output_ref=DataReference(
                        uri=str(generated_artifact_ref.get("uri") or ""),
                        sha256=str(generated_artifact_ref.get("sha256") or ""),
                        byte_size=int(generated_artifact_ref.get("byteSize") or 0),
                    ),
                )
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_JAVA_CANDIDATE_PERSISTED,
                    active_step=W02_STEP_COMPILE_TEST_JAVA,
                    message=f"repair attempt {attempt} produced candidate java",
                )
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_BUILD_TEST_RUNNING,
                    active_step=W02_STEP_COMPILE_TEST_JAVA,
                    message=f"repair attempt {attempt} build-test invoked",
                )
                # Re-run build/test on the agent's candidate. We pass the
                # repaired generatedProject content explicitly so the build
                # runner does not see the prior failing files.
                build_test_input_for_repair = {
                    **build_test_input,
                    "generatedProject": generated_project,
                    "generatedArtifactRef": generated_artifact_ref,
                    "repairAttempt": attempt,
                }
                build_test_output = self._invoke_step(
                    context,
                    "compile-test-java",
                    build_test_capability,
                    DATA_CLASS_BUILD_TEST,
                    build_test_input_for_repair,
                    DataReference(
                        uri=str(generated_artifact_ref.get("uri") or ""),
                        sha256=str(generated_artifact_ref.get("sha256") or ""),
                        byte_size=int(generated_artifact_ref.get("byteSize") or 0),
                    ),
                )
                step_results.append(build_test_output)
                evidence_refs.append(build_test_output.output_ref.uri)
                w02_contract.set_build_test_result_ref(
                    _as_reference_payload(build_test_output.output_ref)
                )
                _record_artifact(
                    self.artifact_store.write_json(
                        context.run_id,
                        context.workflow_id,
                        f"build-test-result-repair-{attempt:02d}.json",
                        dict(build_test_output.payload),
                        kind=KIND_BUILD_TEST_RESULT,
                    )
                )
                parity_comparison, parity_artifacts = self._project_parity_comparison(
                    context=context,
                    build_test_output=build_test_output,
                    persist=True,
                )
                for meta in parity_artifacts:
                    _record_artifact(meta)
                w02_contract.set_parity_comparison(parity_comparison)
                success, build_failure_code = build_test_outcome(build_test_output.payload)

            if success:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_FINAL_JAVA_SELECTED,
                    active_step=W02_STEP_WRITE_EVIDENCE,
                    message="build-test verified java candidate",
                )

            if context.model_prompt and not w02_blocked and not parity_run:
                model_capability = self._require_capability(
                    context.run_id,
                    self.config.model_gateway_capability_id,
                )
                model_id = _text(getattr(self.config, "model_gateway_model_id", None)) or DEFAULT_MODEL_ID
                # Issue #168: tag the invocation with the W0.2 agent role so
                # the Model Gateway applies the role-to-model policy and
                # records the role on the Model Invocation Ledger. The
                # productive transformation agent is the caller in product
                # mode; in the deterministic W0 path the orchestrator stands
                # in for it.
                model_invocation_request = {
                    "schemaVersion": "v0",
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "actor": self.config.service_name,
                    "agentRole": "transformation",
                    "modelId": model_id,
                    "dataClass": DATA_CLASS_MODEL,
                    "promptTemplateVersion": DEFAULT_PROMPT_TEMPLATE_VERSION,
                    "prompt": context.model_prompt,
                    "structuredOutput": False,
                    "parameters": {
                        "inputRef": _as_reference_payload(input_reference),
                        "runId": context.run_id,
                    },
                    "timeoutMs": DEFAULT_MODEL_TIMEOUT_MS,
                }
                model_invocation_input_ref = _build_reference(
                    f"urn:orchestrator/{context.run_id}/model-input",
                    {
                        "modelPrompt": context.model_prompt,
                        "runId": context.run_id,
                        "workflowId": context.workflow_id,
                    },
                )
                model_output_step = self._invoke_step(
                    context,
                    "model-guidance",
                    model_capability,
                    DATA_CLASS_MODEL,
                    model_invocation_request,
                    model_invocation_input_ref,
                )
                step_results.append(model_output_step)
                model_output = model_output_step.payload
                _record_artifact(
                    _persist_model_invocation_ledger(
                        model_invocation_request,
                        model_invocation_input_ref,
                        model_output,
                    )
                )
                completed_steps.append("model-guidance")
                _write_summary("updating", message="model-guidance completed")
            else:
                # Issue #166: when the run is blocked we skip model-guidance
                # entirely so a degraded model gateway cannot mask a blocked
                # build-test outcome.
                skip_reason = (
                    "run blocked before model invocation; deterministic verification failed"
                    if w02_blocked
                    else "no modelPrompt provided by requester; deterministic W0 translation completed without model assistance"
                )
                _persist_model_policy_skipped(skip_reason)
                # Issue #96: surface the policy skip as a discrete step so the
                # UI/EL timeline can distinguish it from `model-guidance`
                # actually running.
                self._record_marker_step(
                    context,
                    name=STEP_MODEL_POLICY_SKIPPED,
                    status=STEP_STATUS_SKIPPED,
                    run_status="updating",
                    diagnostic=skip_reason,
                )

            trajectory_payload = self._fetch_trajectory_ledger(context.run_id)
            trajectory_ref = _coerce_output_ref(trajectory_payload, f"urn:orchestrator/{context.run_id}/trajectory", {})
            evidence_refs.append(trajectory_ref.uri)
            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "trajectory-ledger.json",
                    dict(trajectory_payload),
                    kind=KIND_TRAJECTORY_LEDGER,
                )
            )
            self._stamp_manual_edit_summary(context, w02_contract)
            manual_overlay_ref = self._manual_edit_overlay_ref(context)
            if manual_overlay_ref is not None:
                manual_overlay_meta = self.artifact_store.find_metadata(
                    context.run_id, MANUAL_EDIT_OVERLAY_FILE
                )
                if manual_overlay_meta is not None:
                    _record_artifact(ArtifactMetadata(**manual_overlay_meta))

            if parity_run:
                self._record_marker_step(
                    context,
                    name=STEP_PARITY_EVIDENCE_CAPTURE,
                    status=STEP_STATUS_RUNNING,
                    run_status="updating",
                    diagnostic="capturing parity evidence",
                )
            evidence_payload = self._build_evidence_payload(
                context=context,
                input_ref=input_reference,
                parse_output=parse_output,
                ir_output=ir_output,
                generator_output=generator_output,
                source_reference_output=source_reference_output,
                build_test_output=build_test_output,
                model_output=model_output,
                model_policy_skipped_meta=model_policy_skipped_meta,
                trajectory_payload=trajectory_payload,
                generated_artifact_ref=generated_artifact_ref,
                w02_contract=w02_contract,
                w02_blocked=w02_blocked,
                baseline_generated_artifact_ref=baseline_artifact_ref,
                productive_model_invocations=productive_model_invocations,
            )
            evidence_output = self._invoke_step(
                context,
                "write-evidence",
                evidence_capability,
                DATA_CLASS_EVIDENCE,
                evidence_payload,
                _build_reference(
                    f"urn:orchestrator/{context.run_id}/evidence-input",
                    {
                        "runId": context.run_id,
                        "workflowId": context.workflow_id,
                        "artifacts": evidence_payload.get("artifacts", {}),
                    },
                ),
            )
            step_results.append(evidence_output)
            evidence_refs.append(evidence_output.output_ref.uri)
            if parity_run:
                self._record_marker_step(
                    context,
                    name=STEP_PARITY_EVIDENCE_CAPTURE,
                    status=STEP_STATUS_OK,
                    run_status="updating",
                    diagnostic="parity evidence captured",
                )
            evidence_manifest_meta = self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                "evidence-pack-manifest.json",
                dict(evidence_output.payload),
                kind=KIND_EVIDENCE_PACK_MANIFEST,
            )
            _record_artifact(evidence_manifest_meta)
            completed_steps.append("write-evidence")

            # Issue #166: classify evidence outcome for the W0.2 contract.
            # ``evidence_output.payload`` may carry a ``missingArtifacts``
            # list or a ``status`` of "incomplete" — both indicate the
            # evidence pack could not be fully materialised.
            evidence_status_text = _text(evidence_output.payload.get("status")) or ""
            evidence_missing = evidence_output.payload.get("missingArtifacts") or []
            evidence_materialized = (
                evidence_status_text.lower() in {"", "ok", "complete", "completed", "passed"}
                and not evidence_missing
            )
            evidence_ref_payload = _as_reference_payload(evidence_output.output_ref)
            w02_contract.set_evidence_pack_ref(evidence_ref_payload)
            if not evidence_materialized:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_EVIDENCE_INCOMPLETE,
                    active_step=W02_STEP_FINALIZE,
                    message="evidence pack incomplete",
                    failure_code=(
                        w02_failure_code
                        if w02_blocked and w02_failure_code is not None
                        else FAILURE_EVIDENCE_INCOMPLETE
                    ),
                )
                if not w02_blocked:
                    # Evidence-write succeeded as a step but produced an
                    # incomplete pack — surface as an incomplete run rather
                    # than promoting it to success.
                    w02_blocked = True
                    w02_failure_code = FAILURE_EVIDENCE_INCOMPLETE
                    w02_failure_message = "evidence pack incomplete"
            else:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_EVIDENCE_MATERIALIZED,
                    active_step=W02_STEP_FINALIZE,
                    message=(
                        "blocked-run evidence pack materialised"
                        if w02_blocked
                        else "evidence pack materialised"
                    ),
                )

            final_classification = (
                CLASSIFICATION_BLOCKED
                if w02_blocked and w02_failure_code != FAILURE_EVIDENCE_INCOMPLETE
                else CLASSIFICATION_INCOMPLETE
                if w02_blocked
                else CLASSIFICATION_SUCCESS
            )
            w02_contract.set_trust_summary(
                self._build_trust_summary(
                    context=context,
                    contract=w02_contract,
                    build_test_output=build_test_output,
                    evidence_pack_meta=evidence_manifest_meta,
                    final_classification=final_classification,
                    failure_code=w02_failure_code,
                    evidence_materialized=evidence_materialized,
                )
            )
            if w02_blocked:
                self._finalize_w02(
                    context,
                    w02_contract,
                    final_classification,
                    failure_code=w02_failure_code,
                    failure_message=w02_failure_message,
                )
                blocked_message = (
                    w02_failure_message
                    or f"W0.2 workflow blocked: {w02_failure_code}"
                )
                self._record_marker_step(
                    context,
                    name=STEP_FAILED,
                    status=STEP_STATUS_FAILED,
                    run_status="failed",
                    diagnostic=blocked_message,
                    failed_step=W02_STEP_COMPILE_TEST_JAVA,
                )
                self._emit_workflow_decision_event(
                    context,
                    "orchestrator.workflow.failed",
                    blocked_message,
                )
                _write_summary("blocked", message=blocked_message, failed_step=W02_STEP_COMPILE_TEST_JAVA)
                self.gateway.update_run(
                    context.run_id,
                    "failed",
                    updated_by=self.config.service_name,
                    message=blocked_message,
                    evidence_refs=evidence_refs,
                    policy_decision=POLICY_ALLOW,
                )
                try:
                    self._flush_to_experience_learning(context.run_id, trajectory_payload)
                except Exception:
                    pass
                return {
                    "runId": context.run_id,
                    "workflowId": context.workflow_id,
                    "status": final_classification,
                    "evidencePack": evidence_output.payload,
                    "stepCount": len(step_results),
                    "artifacts": list(artifact_refs),
                    "workflowContract": w02_contract.to_dict(),
                }

            self._finalize_w02(
                context,
                w02_contract,
                CLASSIFICATION_SUCCESS,
                failure_message="workflow completed",
            )
            self._record_marker_step(
                context,
                name=STEP_COMPLETED,
                status=STEP_STATUS_OK,
                run_status="completed",
            )
            self._emit_workflow_decision_event(
                context,
                "orchestrator.workflow.completed",
                "workflow completed",
            )
            _write_summary("completed", message="W0 migration workflow completed")
            self.gateway.update_run(
                context.run_id,
                "completed",
                updated_by=self.config.service_name,
                message="W0 migration workflow completed",
                evidence_refs=evidence_refs,
                policy_decision=POLICY_ALLOW,
            )
            # Issue #96: forward Harness events + trajectory ledger to the
            # experience-learning-service so the EL system can analyze runs
            # started from the UI. Best-effort; failures must not break the
            # successful run reported above. Wrapped defensively so a
            # gateway implementation that surfaces unexpected exceptions
            # cannot regress the success path.
            try:
                self._flush_to_experience_learning(context.run_id, trajectory_payload)
            except Exception:
                pass
            return {
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "status": "completed",
                "evidencePack": evidence_output.payload,
                "stepCount": len(step_results),
                "artifacts": list(artifact_refs),
                "workflowContract": w02_contract.to_dict(),
            }
        except Exception as exc:
            terminal_run_status = "failed"
            summary_status = "failed"
            try:
                if model_output is None:
                    if context.model_prompt:
                        _persist_model_policy_skipped(
                            f"workflow failed before required model invocation: {exc}"
                        )
                    else:
                        _persist_model_policy_skipped(
                            "no modelPrompt provided by requester; deterministic W0 translation completed without model assistance"
                        )
            except Exception:
                pass
            self._emit_workflow_decision_event(
                context,
                "orchestrator.workflow.failed",
                str(exc),
            )
            failure_message = f"W0 migration workflow failed: {exc}"
            failed_step = (
                "missing-capability"
                if isinstance(exc, CapabilityMissingError)
                else _failed_step_from_exception(exc)
            )
            # Issue #166: finalise the W0.2 contract on the failure path so
            # consumers can read the classification and failure code from
            # ``GET /v0/runs/{runId}/workflow``.
            try:
                exc_failure_code = self._failure_code_from_exception(
                    exc,
                    current_state=w02_contract.state_machine.current,
                    failed_step=failed_step,
                )
                # Drive the contract into ``run_blocked`` before finalising
                # so the state-history reflects the workflow ordering. Evidence
                # states are only recorded when the evidence step was actually
                # reached or attempted.
                current_state = w02_contract.state_machine.current
                if current_state != w02.STATE_FINAL_CLASSIFICATION:
                    if failed_step == STEP_WRITE_EVIDENCE or current_state == w02.STATE_FINAL_JAVA_SELECTED:
                        try:
                            self._advance_w02(
                                context,
                                w02_contract,
                                STATE_EVIDENCE_INCOMPLETE,
                                active_step=None,
                                message="evidence pack incomplete after workflow failure",
                                failure_code=exc_failure_code,
                            )
                        except IllegalTransitionError:
                            pass
                    elif current_state not in {
                        w02.STATE_RUN_BLOCKED,
                        w02.STATE_EVIDENCE_INCOMPLETE,
                        w02.STATE_EVIDENCE_MATERIALIZED,
                    }:
                        try:
                            self._advance_w02(
                                context,
                                w02_contract,
                                STATE_RUN_BLOCKED,
                                active_step=None,
                                message=failure_message,
                                failure_code=exc_failure_code,
                            )
                        except IllegalTransitionError:
                            pass
                    final_classification = (
                        self._final_classification_for_failure_code(exc_failure_code)
                    )
                    summary_status = final_classification
                    try:
                        self._finalize_w02(
                            context,
                            w02_contract,
                            final_classification,
                            failure_code=exc_failure_code,
                            failure_message=failure_message,
                        )
                    except IllegalTransitionError:
                        pass
            except Exception:
                pass
            try:
                self._record_marker_step(
                    context,
                    name=STEP_FAILED,
                    status=STEP_STATUS_FAILED,
                    run_status=terminal_run_status,
                    diagnostic=failure_message,
                    failed_step=failed_step,
                )
            except Exception:
                pass
            try:
                self.gateway.update_run(
                    context.run_id,
                    terminal_run_status,
                    updated_by=self.config.service_name,
                    message=failure_message,
                    evidence_refs=evidence_refs,
                    policy_decision=POLICY_ALLOW,
                )
            except Exception:
                pass
            try:
                _write_summary(summary_status, message=failure_message, failed_step=failed_step)
            except Exception:
                pass
            # Issue #96: even on failure, surface what we observed to EL so
            # pattern detection sees the failure trail. Trajectory ledger may
            # be unavailable if the failure happened before we fetched it.
            try:
                self._flush_to_experience_learning(context.run_id, None)
            except Exception:
                pass
            if isinstance(exc, StepExecutionError):
                raise
            raise

    def _fetch_trajectory_ledger(self, run_id: str) -> Mapping[str, JsonValue]:
        try:
            return self.gateway.get_trajectory_ledger(run_id)
        except Exception as exc:
            raise OrchestratorError(f"trajectory ledger unavailable: {exc}") from exc

    @staticmethod
    def _artifact_ref_payload(raw: Any) -> JsonObject | None:
        if not isinstance(raw, Mapping):
            return None
        ref = _reference_payload_from_metadata(raw)
        if ref is None:
            return None
        return dict(ref)

    @staticmethod
    def _parity_result_dir(build_test_output: WorkflowStepResult) -> str:
        digest = build_test_output.output_ref.sha256 or sha256(
            build_test_output.output_ref.uri.encode("utf-8")
        ).hexdigest()
        return f"{PARITY_RESULT_DIR}/{digest[:16]}"

    @staticmethod
    def _repository_root() -> Path:
        current = Path(__file__).resolve()
        for parent in current.parents:
            if (parent / "fixtures" / "acceptance" / "index.json").is_file():
                return parent
        return current.parents[4]

    def _resolve_parity_fixture(self, fixture_id: str) -> JsonObject:
        fixture_key = fixture_id.strip()
        if not fixture_key:
            raise OrchestratorError("fixtureId is required for parity runs")
        index_path = self._repository_root() / "fixtures" / "acceptance" / "index.json"
        try:
            index_payload = json.loads(index_path.read_text("utf-8"))
        except FileNotFoundError as exc:
            raise OrchestratorError(f"acceptance fixture index unavailable: {index_path}") from exc
        except json.JSONDecodeError as exc:
            raise OrchestratorError(f"acceptance fixture index is invalid: {index_path}") from exc
        fixtures = index_payload.get("fixtures")
        if not isinstance(fixtures, list):
            raise OrchestratorError("acceptance fixture index must declare a fixtures array")
        matched: Mapping[str, JsonValue] | None = None
        for entry in fixtures:
            if not isinstance(entry, Mapping):
                continue
            if str(entry.get("fixtureId") or "").strip() == fixture_key:
                matched = entry
                break
        if matched is None:
            raise OrchestratorError(f"acceptance fixture {fixture_key} not found")
        expected_ref = _reference_payload_from_metadata(matched.get("expectedOutputArtifactRef"))
        if expected_ref is None:
            raise OrchestratorError(
                f"acceptance fixture {fixture_key} does not declare an expectedOutputArtifactRef"
            )
        expected_path_raw = str(matched.get("expectedOutputArtifactRef", {}).get("path") or "").strip() if isinstance(matched.get("expectedOutputArtifactRef"), Mapping) else ""
        if not expected_path_raw:
            raise OrchestratorError(
                f"acceptance fixture {fixture_key} expectedOutputArtifactRef.path is required"
            )
        expected_path = (self._repository_root() / expected_path_raw).resolve()
        if not expected_path.is_file():
            raise OrchestratorError(
                f"acceptance fixture {fixture_key} expected output file missing: {expected_path_raw}"
            )
        expected_output = expected_path.read_text("utf-8")
        expected_sha = sha256(expected_output.encode("utf-8")).hexdigest()
        if expected_ref.get("sha256") and str(expected_ref["sha256"]).lower() != expected_sha:
            raise OrchestratorError(
                f"acceptance fixture {fixture_key} expected output sha256 mismatch"
            )
        if expected_ref.get("byteSize") is not None and int(expected_ref["byteSize"]) != len(expected_output.encode("utf-8")):
            raise OrchestratorError(
                f"acceptance fixture {fixture_key} expected output byteSize mismatch"
            )
        source_ref = _reference_payload_from_metadata(matched.get("sourceCobolArtifactRef"))
        payload: JsonObject = {
            "fixtureId": fixture_key,
            "expectedOutput": expected_output,
            "expectedOutputArtifactRef": {
                **expected_ref,
                "path": expected_path_raw,
            },
        }
        if source_ref is not None:
            payload["sourceCobolArtifactRef"] = source_ref
        return payload

    def _materialise_parity_json_ref(
        self,
        context: W0RunContext,
        *,
        relative_path: str,
        payload: Mapping[str, JsonValue],
        kind: str,
        persist: bool,
    ) -> tuple[JsonObject, ArtifactMetadata | None]:
        if not persist or isinstance(self.artifact_store, NullArtifactStore):
            ref = dict(
                _as_reference_payload(
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/{relative_path}",
                        dict(payload),
                    )
                )
            )
            ref["mimeType"] = "application/json"
            ref["kind"] = kind
            return ref, None
        meta = self.artifact_store.write_json(
            context.run_id,
            context.workflow_id,
            relative_path,
            dict(payload),
            kind=kind,
        )
        ref = _reference_payload_from_metadata(
            meta.to_dict() if meta is not None else None
        )
        if ref is None:
            raise OrchestratorError(
                f"failed to materialise parity json ref for {relative_path}"
            )
        return ref, meta

    def _materialise_parity_text_ref(
        self,
        context: W0RunContext,
        *,
        relative_path: str,
        content: str,
        kind: str,
        persist: bool,
    ) -> tuple[JsonObject, ArtifactMetadata | None]:
        if not persist or isinstance(self.artifact_store, NullArtifactStore):
            ref = dict(
                _as_reference_payload(
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/{relative_path}",
                        content,
                    )
                )
            )
            ref["mimeType"] = "text/plain"
            ref["kind"] = kind
            return ref, None
        meta = self.artifact_store.write_text(
            context.run_id,
            context.workflow_id,
            relative_path,
            content,
            kind=kind,
            mime_type="text/plain",
        )
        ref = _reference_payload_from_metadata(
            meta.to_dict() if meta is not None else None
        )
        if ref is None:
            raise OrchestratorError(
                f"failed to materialise parity text ref for {relative_path}"
            )
        return ref, meta

    @staticmethod
    def _comparison_status_from_payload(
        payload: Mapping[str, JsonValue],
        *,
        matched: bool | None,
        explicit_status: str | None,
    ) -> str:
        success_statuses = frozenset({"ok", "passed", "success", "complete", "verified"})
        status = (explicit_status or "").strip().lower()
        if status in {"passed", "failed", "blocked"}:
            return status
        runner_status = str(payload.get("status") or "").strip().lower()
        if matched is True or runner_status in success_statuses:
            return "passed"
        if matched is False and runner_status in {
            "output-divergence",
            "failed",
            "mismatch",
        }:
            return "failed"
        if matched is False and runner_status:
            return "failed" if "divergence" in runner_status else "blocked"
        return "blocked"

    @staticmethod
    def _comparison_mismatch_classification(
        payload: Mapping[str, JsonValue],
        *,
        matched: bool | None,
        explicit_mismatch: str | None,
        diff_summary: str | None,
    ) -> str:
        mismatch = (explicit_mismatch or "").strip()
        if mismatch:
            return mismatch
        if matched is True:
            return "none"
        classification = str(payload.get("classification") or "").strip().lower()
        if classification in {
            "compile-error",
            "run-error",
            "oracle-unavailable",
            "oracle-invalid-request",
            "missing-golden-master",
            "true-golden-master-reproduction-error",
        }:
            return "unknown"
        if classification == "divergence-known-w0-coverage-gap":
            return "known_coverage_gap"
        if classification in {"intentional-divergence", "intentional_divergence"}:
            return "intentional"
        if diff_summary and "line ending" in diff_summary.lower():
            return "line_endings"
        return "content"

    def _project_parity_comparison(
        self,
        *,
        context: W0RunContext,
        build_test_output: WorkflowStepResult | None,
        persist: bool,
    ) -> tuple[JsonObject | None, list[ArtifactMetadata]]:
        if build_test_output is None:
            return None, []
        payload = build_test_output.payload or {}
        comparison_result = _first_non_empty_mapping(payload.get("comparisonResult"))
        comparison = (
            _first_non_empty_mapping(comparison_result.get("comparison"))
            or _first_non_empty_mapping(payload.get("comparison"))
            or _first_non_empty_mapping(payload.get("oracleComparison"))
        )
        execution_payload = (
            _first_non_empty_mapping(comparison_result.get("executionResult"))
            or _first_non_empty_mapping(payload.get("executionResult"))
            or _first_non_empty_mapping(payload.get("execution"))
        )
        explicit_execution_ref = self._artifact_ref_payload(
            comparison_result.get("executionResultRef") or payload.get("executionResultRef")
        )
        matched_raw = comparison_result.get("matched")
        if matched_raw is None:
            matched_raw = comparison.get("matched")
        matched = bool(matched_raw) if isinstance(matched_raw, bool) else None
        policy_version = (
            _text(comparison_result.get("comparisonPolicyVersion"))
            or _text(comparison.get("comparisonPolicyVersion"))
            or _text(payload.get("comparisonPolicyVersion"))
            or _text(comparison.get("normalisation"))
        )
        diff_summary = (
            _text(comparison_result.get("diffSummary"))
            or _text(comparison.get("diffSummary"))
            or _text(comparison.get("diff"))
            or _text(payload.get("summary"))
        )
        mismatch = self._comparison_mismatch_classification(
            payload,
            matched=matched,
            explicit_mismatch=(
                _text(comparison_result.get("mismatchClassification"))
                or _text(comparison.get("mismatchClassification"))
                or _text(payload.get("mismatchClassification"))
            ),
            diff_summary=diff_summary,
        )
        comparison_status = self._comparison_status_from_payload(
            payload,
            matched=matched,
            explicit_status=(
                _text(comparison_result.get("status"))
                or _text(payload.get("comparisonStatus"))
            ),
        )
        if policy_version is None:
            return None, []

        source_normalized_ref = (
            self._artifact_ref_payload(comparison_result.get("sourceNormalizedRef"))
            or self._artifact_ref_payload(comparison.get("sourceNormalizedRef"))
            or self._artifact_ref_payload(comparison.get("expectedNormalizedRef"))
            or self._artifact_ref_payload(comparison.get("expectedRef"))
        )
        target_normalized_ref = (
            self._artifact_ref_payload(comparison_result.get("targetNormalizedRef"))
            or self._artifact_ref_payload(comparison.get("targetNormalizedRef"))
            or self._artifact_ref_payload(comparison.get("actualNormalizedRef"))
            or self._artifact_ref_payload(execution_payload.get("normalizedOutputRef"))
            or self._artifact_ref_payload(comparison.get("actualRef"))
        )
        if source_normalized_ref is None or target_normalized_ref is None:
            return None, []

        projection_dir = self._parity_result_dir(build_test_output)
        persisted: list[ArtifactMetadata] = []

        execution_result_ref = explicit_execution_ref
        if execution_result_ref is None and execution_payload:
            execution_result_ref, execution_meta = self._materialise_parity_json_ref(
                context,
                relative_path=f"{projection_dir}/{PARITY_EXECUTION_RESULT_FILE}",
                payload=execution_payload,
                kind="parity-execution-result",
                persist=persist,
            )
            if execution_meta is not None:
                persisted.append(execution_meta)

        comparison_policy_ref = (
            self._artifact_ref_payload(comparison_result.get("comparisonPolicyRef"))
            or self._artifact_ref_payload(comparison.get("comparisonPolicyRef"))
            or self._artifact_ref_payload(payload.get("comparisonPolicyRef"))
        )
        diff_ref = (
            self._artifact_ref_payload(comparison_result.get("diffRef"))
            or self._artifact_ref_payload(comparison.get("diffRef"))
            or self._artifact_ref_payload(payload.get("diffRef"))
        )
        if diff_ref is None and diff_summary and _text(comparison.get("diff")):
            diff_ref, diff_meta = self._materialise_parity_text_ref(
                context,
                relative_path=f"{projection_dir}/{PARITY_COMPARISON_DIFF_FILE}",
                content=str(comparison.get("diff") or ""),
                kind="parity-comparison-diff",
                persist=persist,
            )
            if diff_meta is not None:
                persisted.append(diff_meta)

        canonical_comparison = comparison_result or {
            "schemaVersion": "v0",
            "comparisonId": f"{context.run_id}-{build_test_output.output_ref.sha256[:12]}",
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "status": comparison_status,
            "comparisonPolicyVersion": policy_version,
            "sourceNormalizedRef": source_normalized_ref,
            "targetNormalizedRef": target_normalized_ref,
            "diffSummary": (
                diff_summary
                or "Deterministic comparison completed without a diff summary."
            ),
            "mismatchClassification": mismatch,
            "createdAt": _iso_now(),
        }
        if "status" not in canonical_comparison:
            canonical_comparison["status"] = comparison_status
        if "comparisonPolicyVersion" not in canonical_comparison:
            canonical_comparison["comparisonPolicyVersion"] = policy_version
        if "sourceNormalizedRef" not in canonical_comparison:
            canonical_comparison["sourceNormalizedRef"] = source_normalized_ref
        if "targetNormalizedRef" not in canonical_comparison:
            canonical_comparison["targetNormalizedRef"] = target_normalized_ref
        if "diffSummary" not in canonical_comparison:
            canonical_comparison["diffSummary"] = (
                diff_summary
                or "Deterministic comparison completed without a diff summary."
            )
        if "mismatchClassification" not in canonical_comparison:
            canonical_comparison["mismatchClassification"] = mismatch
        if comparison_policy_ref is not None:
            canonical_comparison["comparisonPolicyRef"] = comparison_policy_ref
        if diff_ref is not None:
            canonical_comparison["diffRef"] = diff_ref

        comparison_result_ref = self._artifact_ref_payload(
            comparison_result.get("comparisonResultRef") or payload.get("comparisonResultRef")
        )
        if comparison_result_ref is None:
            comparison_result_ref, comparison_meta = self._materialise_parity_json_ref(
                context,
                relative_path=f"{projection_dir}/{PARITY_COMPARISON_RESULT_FILE}",
                payload=canonical_comparison,
                kind="parity-comparison-result",
                persist=persist,
            )
            if comparison_meta is not None:
                persisted.append(comparison_meta)

        if execution_result_ref is None or comparison_result_ref is None:
            return None, persisted

        projection: JsonObject = {
            "status": canonical_comparison["status"],
            "matched": matched if matched is not None else comparison_status == "passed",
            "comparisonPolicyVersion": policy_version,
            "executionResultRef": execution_result_ref,
            "comparisonResultRef": comparison_result_ref,
            "mismatchClassification": canonical_comparison["mismatchClassification"],
            "sourceNormalizedRef": source_normalized_ref,
            "targetNormalizedRef": target_normalized_ref,
            "completedAt": _text(canonical_comparison.get("createdAt")) or _iso_now(),
        }
        if comparison_policy_ref is not None:
            projection["comparisonPolicyRef"] = comparison_policy_ref
        if diff_ref is not None:
            projection["diffRef"] = diff_ref
        decision_record_ref = (
            self._artifact_ref_payload(comparison_result.get("decisionRecordRef"))
            or self._artifact_ref_payload(comparison.get("decisionRecordRef"))
            or self._artifact_ref_payload(comparison_result.get("documentedDecisionRef"))
            or self._artifact_ref_payload(comparison.get("documentedDecisionRef"))
            or self._artifact_ref_payload(comparison_result.get("dispositionRef"))
            or self._artifact_ref_payload(comparison.get("dispositionRef"))
        )
        if decision_record_ref is not None:
            projection["decisionRecordRef"] = decision_record_ref
        return projection, persisted

    # noinspection PyTypeHints
    def _build_evidence_payload(
        self,
        *,
        context: W0RunContext,
        input_ref: DataReference,
        parse_output: WorkflowStepResult,
        ir_output: WorkflowStepResult,
        generator_output: WorkflowStepResult,
        source_reference_output: WorkflowStepResult | None = None,
        build_test_output: WorkflowStepResult | None,
        model_output: Mapping[str, JsonValue] | None,
        model_policy_skipped_meta: ArtifactMetadata | None,
        trajectory_payload: Mapping[str, JsonValue],
        generated_artifact_ref: Mapping[str, JsonValue] | None = None,
        w02_contract: W02RunContract | None = None,
        w02_blocked: bool = False,
        baseline_generated_artifact_ref: Mapping[str, JsonValue] | None = None,
        productive_model_invocations: Sequence[Mapping[str, JsonValue]] | None = None,
    ) -> JsonObject:
        trajectory_ref = _build_reference(
            f"urn:orchestrator/{context.run_id}/trajectory",
            trajectory_payload,
        )
        # Issue #170: W0.2 evidence must point at the productive agent model
        # invocations that produced Java, not only the optional model-guidance
        # call. Deterministic W0 still emits the policy-skipped ledger entry.
        is_w02 = bool(
            _is_parity_run(context)
            or
            getattr(context, "use_transformation_agent", False)
            or (w02_contract is not None and (
                getattr(w02_contract, "agent_attempt_count", 0) > 0
                or getattr(w02_contract, "repair_attempts", None)
            ))
        )
        fallback_model_invocation = self._build_model_invocation_ref(
            context,
            model_output,
            model_policy_skipped_meta=model_policy_skipped_meta,
        )
        model_invocations = self._build_model_invocation_refs(
            productive_model_invocations=productive_model_invocations,
            fallback_model_invocation=fallback_model_invocation,
            include_fallback=(not is_w02 or model_output is not None),
        )
        if generated_artifact_ref:
            generated_java_payload: Mapping[str, JsonValue] = {
                "uri": str(generated_artifact_ref.get("uri") or ""),
                "sha256": str(generated_artifact_ref.get("sha256") or ""),
                "byteSize": int(generated_artifact_ref.get("byteSize") or 0),
                "kind": str(generated_artifact_ref.get("kind") or KIND_GENERATED_PROJECT_MANIFEST),
            }
        else:
            generated_java_payload = _as_reference_payload(generator_output.output_ref)
        build_test_refs: list[JsonObject] = []
        if build_test_output is not None:
            build_test_refs.append(_as_reference_payload(build_test_output.output_ref))

        artifacts: JsonObject = {
            "sourceCobol": [_as_reference_payload(input_ref)],
            "semanticIr": _as_reference_payload(_coerce_output_ref(ir_output.payload, generator_output.output_ref.uri, ir_output.payload)),
            "buildTestResults": build_test_refs,
            "harnessEvents": _as_reference_payload(trajectory_ref),
            "modelInvocations": model_invocations,
            "trajectoryLedger": _as_reference_payload(trajectory_ref),
        }
        if source_reference_output is not None:
            artifacts["sourceReferenceExecution"] = _as_reference_payload(
                source_reference_output.output_ref
            )
        if _is_parity_run(context):
            trust_case_payload: JsonObject | None = None
            if isinstance(context.trust_case_resolution, Mapping) and context.trust_case_resolution:
                trust_case_payload = dict(context.trust_case_resolution)
            if trust_case_payload is None and context.trust_case_id:
                trust_case_payload = {
                    "trustCaseId": context.trust_case_id,
                }
            if trust_case_payload is not None:
                trust_case_payload.setdefault(
                    "id",
                    context.trust_case_id or context.source_reference_fixture_id or "",
                )
                trust_case_payload.setdefault(
                    "trustCaseId",
                    context.trust_case_id or context.source_reference_fixture_id or "",
                )
                trust_case_payload.setdefault(
                    "sourceReferenceFixtureId",
                    context.source_reference_fixture_id or "",
                )
                trust_case_payload.setdefault(
                    "sourceReferenceMode",
                    context.source_reference_mode or "",
                )
                trust_case_artifact_ref = self._trust_case_artifact_ref(context)
                if trust_case_artifact_ref is not None:
                    trust_case_payload["artifactRef"] = trust_case_artifact_ref
                artifacts["trustCase"] = trust_case_payload
        if not (is_w02 and w02_blocked and not _is_parity_run(context)):
            artifacts["generatedJava"] = generated_java_payload
        # Issue #96: when experience-learning is configured, reference its
        # run summary endpoint so the Evidence Pack carries a verifiable
        # pointer back to the EL system that observed the run.
        learning_uri = ""
        if isinstance(self.experience_learning, ExperienceLearningGateway):
            learning_uri = self.experience_learning.summary_uri(context.run_id)
        if learning_uri:
            learning_ref = _build_reference(
                learning_uri,
                {"runId": context.run_id, "endpoint": "experience-learning.summary"},
            )
            artifacts["experienceEvents"] = [
                _as_reference_payload(learning_ref)
            ]

        # Issue #171: when the run used the productive W0.2 path
        # (transformation agent and/or verification-repair loop), emit the
        # extended evidence fields so reviewers can reconstruct every Java
        # candidate, repair attempt, agent trajectory, and oracle comparison.
        wave = "w0.2" if is_w02 else "w0"
        if is_w02:
            source_metadata_ref = _reference_payload_from_metadata(
                self.artifact_store.find_metadata(context.run_id, "source-ref.json")
            )
            parse_output_ref = _reference_payload_from_metadata(
                self.artifact_store.find_metadata(context.run_id, "parse-output.json")
            )
            if source_metadata_ref is not None:
                artifacts["sourceMetadata"] = source_metadata_ref
            if parse_output_ref is not None:
                artifacts["parseOutput"] = parse_output_ref
            (
                generated_java_artifacts,
                final_java_artifact,
                repair_attempts_payload,
            ) = self._build_w02_java_history(
                w02_contract=w02_contract,
                baseline_artifact_ref=baseline_generated_artifact_ref or generated_artifact_ref,
                final_artifact_ref=None if w02_blocked else generated_artifact_ref,
                generator_output=generator_output,
                blocked=w02_blocked,
            )
            if generated_java_artifacts:
                artifacts["generatedJavaArtifacts"] = generated_java_artifacts
            if final_java_artifact is not None:
                artifacts["finalJavaArtifact"] = final_java_artifact
            if repair_attempts_payload:
                artifacts["repairAttempts"] = repair_attempts_payload

            artifacts["agentTrajectories"] = self._build_agent_trajectory_refs(
                context=context,
                trajectory_ref=trajectory_ref,
                w02_contract=w02_contract,
            )

            oracle = self._build_oracle_comparison(
                build_test_output=build_test_output,
            )
            if oracle is not None:
                artifacts["oracleComparison"] = oracle
            parity_comparison = (
                dict(w02_contract.parity_comparison)
                if w02_contract is not None
                and isinstance(w02_contract.parity_comparison, Mapping)
                else None
            )
            if parity_comparison is None:
                parity_comparison, _ = self._project_parity_comparison(
                    context=context,
                    build_test_output=build_test_output,
                    persist=False,
                )
            if parity_comparison is not None:
                artifacts["parityComparison"] = parity_comparison
            if build_test_output is not None:
                build_result = _first_non_empty_mapping(build_test_output.payload.get("buildResult"))
                execution_result = _first_non_empty_mapping(build_test_output.payload.get("executionResult"))
                build_ref = _reference_payload_from_metadata(build_result.get("outputRef")) or _reference_payload_from_metadata(
                    build_result.get("buildOutputRef")
                )
                execution_ref = _reference_payload_from_metadata(execution_result.get("outputRef")) or _reference_payload_from_metadata(
                    execution_result.get("logRef")
                )
                if build_ref is not None:
                    artifacts["generatedJavaBuild"] = build_ref
                if execution_ref is not None:
                    artifacts["generatedJavaExecution"] = execution_ref
            artifacts["runtimeVersion"] = {
                "id": f"{self.config.transformation_agent_runtime_library}:{self.config.transformation_agent_java_version}",
                "ref": _as_reference_payload(
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/runtime-version",
                        {
                            "runtimeLibrary": self.config.transformation_agent_runtime_library,
                            "javaVersion": self.config.transformation_agent_java_version,
                        },
                    )
                ),
            }

            # Issue #217 (W0.3-6): the W0.2 evidence pack records the
            # Orchestrator-owned assist-decision and the final consumption of
            # the three bounded run budgets so reviewers can audit, from the
            # pack alone, "was AI required? why? against which budgets?".
            #
            # - assistDecision is emitted whenever the contract reached the
            #   gate. A run that was blocked before the gate fires (parse or
            #   IR failure) legitimately has no decision; the evidence-service
            #   relaxes the requirement for blocked packs in that case.
            # - budgetSummary is emitted for every W0.2 run, blocked or not,
            #   so the bounded-budget posture is always visible.
            assist_decision_payload: JsonObject | None = None
            if w02_contract is not None:
                assist_decision_payload = self._build_assist_decision_lineage(
                    w02_contract
                )
                if assist_decision_payload is not None:
                    artifacts["assistDecision"] = assist_decision_payload
                artifacts["budgetSummary"] = self._build_budget_summary(
                    w02_contract
                )
            manual_overlay_ref = self._manual_edit_overlay_ref(context)
            if manual_overlay_ref is not None:
                artifacts["manualEditOverlay"] = manual_overlay_ref

        payload: JsonObject = {
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "wave": wave,
            "createdBy": self.config.service_name,
            "artifacts": artifacts,
            "openAssumptions": [
                {
                    "id": "OA-W0-01",
                    "description": "Synthetic assumptions captured by orchestrator control-plane.",
                }
            ],
            "unsupportedFeatures": [],
            "summary": self._build_summary(context, parse_output, ir_output, generator_output, build_test_output),
        }
        if is_w02:
            payload["blocked"] = bool(w02_blocked)
            manual_count = 0
            manual_carried_over = False
            if w02_contract is not None:
                manual_count = int(
                    getattr(w02_contract, "manual_drift_region_count", 0) or 0
                )
                manual_carried_over = bool(
                    getattr(w02_contract, "manual_edits_carried_over", False)
                )
            if manual_overlay_ref is not None:
                manual_count = int(
                    manual_overlay_ref.get("regionCount") or manual_count
                )
                manual_carried_over = manual_count > 0
            if manual_carried_over and manual_overlay_ref is None:
                raise OrchestratorError(
                    "manual edit provenance requires artifacts.manualEditOverlay"
                )
            payload["manualEditsCarriedOver"] = manual_carried_over
            payload["manualDriftRegionCount"] = manual_count
        return payload

    @staticmethod
    def _java_candidate_ref(
        *,
        ref: Mapping[str, JsonValue] | None,
        origin: str,
        attempt_number: int,
        selected: bool = False,
    ) -> JsonObject | None:
        if not ref:
            return None
        uri = str(ref.get("uri") or "").strip()
        sha = str(ref.get("sha256") or "").strip()
        if not uri or not sha:
            return None
        candidate: JsonObject = {
            "uri": uri,
            "sha256": sha,
            "byteSize": int(ref.get("byteSize") or 0),
            "origin": origin,
            "attemptNumber": int(attempt_number),
        }
        kind = str(ref.get("kind") or "").strip()
        if kind:
            candidate["kind"] = kind
        mime = str(ref.get("mimeType") or "").strip()
        if mime:
            candidate["mimeType"] = mime
        if selected:
            candidate["selected"] = True
        return candidate

    def _build_w02_java_history(
        self,
        *,
        w02_contract: W02RunContract | None,
        baseline_artifact_ref: Mapping[str, JsonValue] | None,
        final_artifact_ref: Mapping[str, JsonValue] | None,
        generator_output: WorkflowStepResult,
        blocked: bool,
    ) -> tuple[list[JsonObject], JsonObject | None, list[JsonObject]]:
        """Assemble the Java candidate history and repair-attempt envelope
        for the W0.2 evidence pack.

        The deterministic baseline (or the productive Transformation Agent's
        candidate, which replaces the baseline as generated_artifact_ref
        when present) is attempt 0. Each repair attempt that proposed a new
        candidate adds an entry with the attempt number recorded on the
        run contract. The selected candidate is the final_artifact_ref on a
        successful run, or — when the run is blocked — the last propose
        candidate emitted before the loop terminated.
        """
        history: list[JsonObject] = []
        repair_attempts: list[JsonObject] = []

        # Attempt 0 is the deterministic baseline. Productive transformation
        # candidates are added below when they are the selected final artifact
        # and no repair attempt already accounts for that final ref.
        baseline_ref: Mapping[str, JsonValue]
        if baseline_artifact_ref:
            baseline_ref = baseline_artifact_ref
        else:
            baseline_ref = _as_reference_payload(generator_output.output_ref)

        baseline_origin = (
            "transformation-agent"
            if getattr(generator_output, "step_name", "") == "transformation-agent"
            else "deterministic-baseline"
        )
        baseline_entry = self._java_candidate_ref(
            ref=baseline_ref,
            origin=baseline_origin,
            attempt_number=0,
        )
        if baseline_entry is not None:
            history.append(baseline_entry)

        final_uri = str((final_artifact_ref or {}).get("uri") or "").strip()
        final_sha = str((final_artifact_ref or {}).get("sha256") or "").strip()

        repair_attempts_have_required_refs = True
        if w02_contract is not None:
            for entry in getattr(w02_contract, "repair_attempts", []) or []:
                attempt_number = int(entry.get("attemptNumber") or 0)
                decision = str(entry.get("repairDecision") or "")
                candidate_ref = entry.get("javaCandidateRef")
                decision_ref = entry.get("repairDecisionRef")
                model_invocation_ref = entry.get("modelInvocationRef")
                build_test_ref = entry.get("buildTestResultRef") or {}
                refusal = entry.get("refusalCode") or entry.get("escalationCode")

                # Build the candidate ref for this attempt, if propose
                candidate_entry: JsonObject | None = None
                if candidate_ref:
                    candidate_entry = self._java_candidate_ref(
                        ref=candidate_ref,
                        origin="verification-repair-agent",
                        attempt_number=attempt_number,
                    )
                if candidate_entry is not None:
                    history.append(candidate_entry)

                # Every repair attempt must point at the concrete build/test
                # result that triggered it. Do not substitute another run-level
                # reference; evidence-service will mark the pack incomplete if
                # repair ran but no attempt evidence can be emitted.
                btr = build_test_ref if isinstance(build_test_ref, Mapping) else {}
                btr_uri = str((btr or {}).get("uri") or "").strip()
                btr_sha = str((btr or {}).get("sha256") or "").strip()
                if not btr_uri or not btr_sha:
                    repair_attempts_have_required_refs = False
                    continue
                btr_payload = {
                    "uri": btr_uri,
                    "sha256": btr_sha,
                    "byteSize": int((btr or {}).get("byteSize") or 0),
                }

                attempt_payload: JsonObject = {
                    "attemptNumber": attempt_number,
                    "decision": decision,
                    "buildTestResultRef": btr_payload,
                }
                if isinstance(decision_ref, Mapping) and decision_ref.get("uri"):
                    attempt_payload["decisionRef"] = {
                        "uri": str(decision_ref.get("uri") or ""),
                        "sha256": str(decision_ref.get("sha256") or ""),
                        "byteSize": int(decision_ref.get("byteSize") or 0),
                    }
                model_invocation_payload = self._normalise_model_invocation_ref(
                    model_invocation_ref if isinstance(model_invocation_ref, Mapping) else None
                )
                if model_invocation_payload is not None:
                    attempt_payload["modelInvocationRef"] = model_invocation_payload
                if candidate_entry is not None and decision == "propose_candidate":
                    attempt_payload["newJavaCandidateRef"] = dict(candidate_entry)
                if refusal:
                    attempt_payload["refusalCode"] = str(refusal)
                if decision == "no_change":
                    attempt_payload["noChange"] = True
                repair_attempts.append(attempt_payload)
            if not repair_attempts_have_required_refs:
                repair_attempts = []

        selected_entry: JsonObject | None = None
        if final_uri and final_sha and not blocked:
            final_is_already_in_history = any(
                entry.get("uri") == final_uri and entry.get("sha256") == final_sha
                for entry in history
            )
            if not final_is_already_in_history:
                transformation_attempt = 1
                if w02_contract is not None:
                    transformation_attempt = max(
                        1,
                        int(getattr(w02_contract, "agent_attempt_count", 0) or 1),
                    )
                transformation_entry = self._java_candidate_ref(
                    ref=final_artifact_ref,
                    origin="transformation-agent",
                    attempt_number=transformation_attempt,
                )
                if transformation_entry is not None:
                    history.append(transformation_entry)

        # Mark the selected candidate inside history (if it matches).
        if final_uri and final_sha:
            for entry in history:
                if entry.get("uri") == final_uri and entry.get("sha256") == final_sha:
                    entry["selected"] = True
                    selected_entry = dict(entry)
                    break
        return history, selected_entry, repair_attempts

    @staticmethod
    def _build_agent_trajectory_refs(
        *,
        context: W0RunContext,
        trajectory_ref: DataReference,
        w02_contract: W02RunContract | None,
    ) -> list[JsonObject]:
        """Build the agentTrajectories[] array for the W0.2 evidence pack.

        The orchestrator's full trajectory ledger is always referenced under
        agentRole=orchestrator. When the productive Transformation Agent
        ran (use_transformation_agent=True) we also expose a
        transformation entry; when one or more repair attempts were
        recorded we expose a verification-repair entry. Both per-agent
        entries currently reference the same ledger URI because the v0
        ledger is run-scoped (per-agent partitioning ships with the
        Experience Learning extensions); the agentRole disambiguates them
        so downstream consumers can route the records correctly.
        """
        entries: list[JsonObject] = [
            {
                "agentRole": "orchestrator",
                "ledgerRef": _as_reference_payload(trajectory_ref),
            }
        ]
        if getattr(context, "use_transformation_agent", False):
            entries.append({
                "agentRole": "transformation",
                "ledgerRef": _as_reference_payload(trajectory_ref),
            })
        if w02_contract is not None and getattr(w02_contract, "repair_attempts", None):
            entries.append({
                "agentRole": "verification-repair",
                "ledgerRef": _as_reference_payload(trajectory_ref),
            })
        return entries

    @staticmethod
    def _build_oracle_comparison(
        *,
        build_test_output: WorkflowStepResult | None,
    ) -> JsonObject | None:
        """Project build-test-runner output into the evidence-pack oracle-
        comparison envelope (Issue #171).

        The runner returns rich golden-master / comparison detail; we
        flatten it into a content-hash-only structure that reviewers can
        inspect without re-fetching service internals. When no oracle was
        present the runner classifies as missing-golden-master; we still
        emit an envelope with oracleKind=absent so the evidence pack
        always carries an explicit signal.
        """
        if build_test_output is None:
            return None
        payload = build_test_output.payload or {}
        comparison_result = (
            payload.get("comparisonResult")
            if isinstance(payload.get("comparisonResult"), Mapping)
            else {}
        )
        comparison = payload.get("comparison") or {}
        oracle = payload.get("oracleComparison") or {}
        golden = payload.get("goldenMaster") or {}

        matched = comparison_result.get("matched")
        if matched is None:
            matched = comparison.get("matched")
        if matched is None:
            matched = oracle.get("matched")
        if matched is None:
            classification = str(payload.get("classification") or "")
            matched = classification == "match"

        expected_sha = (
            comparison_result.get("expectedSha256")
            or comparison_result.get("sourceSha256")
            or comparison.get("expectedSha256")
            or oracle.get("expectedSha256")
            or ""
        )
        actual_sha = (
            comparison_result.get("actualSha256")
            or comparison_result.get("targetSha256")
            or comparison.get("actualSha256")
            or oracle.get("actualSha256")
            or ""
        )
        status = str(payload.get("status") or "")
        raw_oracle_payload = payload.get("oracle")
        oracle_payload = raw_oracle_payload if isinstance(raw_oracle_payload, Mapping) else {}
        comparison_source = str(comparison.get("source") or "")
        if status == "missing-golden-master":
            oracle_kind = "absent"
        elif comparison_source == "oracle.user-provided":
            oracle_kind = "user-provided"
        elif golden.get("classification") == "true":
            oracle_kind = "true-golden-master"
        elif golden.get("classification") == "synthetic":
            oracle_kind = "synthetic"
        elif (golden.get("cobolRuntime") or {}).get("attempted"):
            oracle_kind = "cobol-runtime"
        elif (oracle_payload.get("mode") == "cobol-runtime" and oracle_payload.get("attempted")):
            oracle_kind = "cobol-runtime"
        else:
            oracle_kind = "synthetic"

        envelope: JsonObject = {
            "matched": bool(matched),
            "oracleKind": oracle_kind,
            "buildTestResultRef": _as_reference_payload(build_test_output.output_ref),
            "classification": str(payload.get("classification") or ""),
        }
        if comparison_result:
            for key in (
                "status",
                "comparisonPolicyVersion",
                "mismatchClassification",
                "diffSummary",
            ):
                value = _text(comparison_result.get(key))
                if value is not None:
                    envelope[key] = value
            for key in (
                "comparisonPolicyRef",
                "comparisonResultRef",
                "diffRef",
                "normalizedDiffRef",
                "sourceStdoutRef",
                "sourceStderrRef",
                "targetStdoutRef",
                "targetStderrRef",
                "sourceNormalizedRef",
                "sourceNormalizedStderrRef",
                "targetNormalizedRef",
                "targetNormalizedStderrRef",
                "sourceOutputRef",
                "sourceNormalizedOutputRef",
                "javaOutputRef",
                "javaNormalizedOutputRef",
            ):
                ref = _reference_payload_from_metadata(comparison_result.get(key))
                if ref is not None:
                    envelope[key] = ref
            for key in ("sourceExitCode", "targetExitCode"):
                value = comparison_result.get(key)
                if isinstance(value, int):
                    envelope[key] = value
        if expected_sha:
            envelope["expectedSha256"] = str(expected_sha)
        if actual_sha:
            envelope["actualSha256"] = str(actual_sha)
        expected_ref = (
            _reference_payload_from_metadata(comparison_result.get("sourceStdoutRef"))
            or _reference_payload_from_metadata(comparison_result.get("sourceOutputRef"))
            or _reference_payload_from_metadata(comparison.get("expectedRef"))
            or _reference_payload_from_metadata(oracle.get("expectedRef"))
        )
        actual_ref = (
            _reference_payload_from_metadata(comparison_result.get("targetStdoutRef"))
            or _reference_payload_from_metadata(comparison_result.get("javaOutputRef"))
            or _reference_payload_from_metadata(comparison.get("actualRef"))
            or _reference_payload_from_metadata(oracle.get("actualRef"))
        )
        if expected_ref is not None:
            envelope["expectedRef"] = expected_ref
        if actual_ref is not None:
            envelope["actualRef"] = actual_ref
        summary = str(
            comparison_result.get("diffSummary")
            or payload.get("summary")
            or ""
        )
        if summary:
            envelope["summary"] = summary
        return envelope

    @staticmethod
    def _build_budget_summary(contract: W02RunContract) -> JsonObject:
        """Project the three bounded W0.3 run budgets into a single audit-
        ready summary for the evidence pack (Issue #217).

        Each entry reports the configured ``limit``, the ``used`` count at
        evidence-write time, and the derived ``remaining``. Budgets only
        grow during a run, so the summary is monotonic with the
        gate-time snapshots recorded on the assist-decision.
        """
        return {
            "repair": contract.repair_budget.to_dict(),
            "assist": contract.assist_budget.to_dict(),
            "modelInvocation": contract.model_invocation_budget.to_dict(),
        }

    @staticmethod
    def _build_trust_summary(
        *,
        context: W0RunContext,
        contract: W02RunContract,
        build_test_output: WorkflowStepResult | None,
        evidence_pack_meta: ArtifactMetadata | None,
        final_classification: str,
        failure_code: str | None,
        evidence_materialized: bool,
    ) -> JsonObject:
        """Derive the immutable trust summary from contract and evidence state."""
        def artifact_ref(raw: Mapping[str, JsonValue] | None) -> JsonObject | None:
            if not isinstance(raw, Mapping):
                return None
            sha256 = str(raw.get("sha256") or "").strip()
            if not sha256:
                return None
            ref: JsonObject = {"sha256": sha256}
            byte_size = raw.get("byteSize")
            if isinstance(byte_size, int) and byte_size >= 0:
                ref["byteSize"] = byte_size
            for key in (
                "uri",
                "kind",
                "path",
                "name",
                "mimeType",
                "createdBy",
                "createdAt",
            ):
                value = _text(raw.get(key))
                if value:
                    ref[key] = value
            return ref

        build_payload = build_test_output.payload if build_test_output is not None else {}
        parity_comparison = (
            dict(contract.parity_comparison)
            if isinstance(contract.parity_comparison, Mapping)
            else {}
        )
        trust_case = (
            dict(contract.resolved_trust_case)
            if isinstance(contract.resolved_trust_case, Mapping)
            else {}
        )
        matched = parity_comparison.get("matched")
        parity_passed = bool(matched) if isinstance(matched, bool) else None

        build_classification = (_text(build_payload.get("classification")) or "").lower()
        mismatch_classification = (
            _text(parity_comparison.get("mismatchClassification"))
            or _text(build_payload.get("mismatchClassification"))
            or build_classification
            or "none"
        ).lower()
        build_failed = failure_code == FAILURE_JAVA_COMPILE_FAILED
        runtime_failed = failure_code == FAILURE_JAVA_RUNTIME_FAILED
        evidence_incomplete = (
            not evidence_materialized
            or final_classification == CLASSIFICATION_INCOMPLETE
            or failure_code == FAILURE_EVIDENCE_INCOMPLETE
        )
        evidence_recorded_at = (
            evidence_pack_meta.createdAt if evidence_pack_meta is not None else None
        )
        comparison_completed_at = (
            _text(parity_comparison.get("completedAt"))
            or _text(parity_comparison.get("createdAt"))
            or contract.updated_at
        )

        source_normalized_ref = artifact_ref(
            parity_comparison.get("sourceNormalizedRef")
            if isinstance(parity_comparison.get("sourceNormalizedRef"), Mapping)
            else None
        )
        target_normalized_ref = artifact_ref(
            parity_comparison.get("targetNormalizedRef")
            if isinstance(parity_comparison.get("targetNormalizedRef"), Mapping)
            else None
        )
        execution_result_ref = artifact_ref(
            parity_comparison.get("executionResultRef")
            if isinstance(parity_comparison.get("executionResultRef"), Mapping)
            else None
        )
        comparison_policy_ref = artifact_ref(
            parity_comparison.get("comparisonPolicyRef")
            if isinstance(parity_comparison.get("comparisonPolicyRef"), Mapping)
            else None
        )
        comparison_result_ref = artifact_ref(
            parity_comparison.get("comparisonResultRef")
            if isinstance(parity_comparison.get("comparisonResultRef"), Mapping)
            else None
        )
        diff_ref = artifact_ref(
            parity_comparison.get("diffRef")
            if isinstance(parity_comparison.get("diffRef"), Mapping)
            else None
        )
        decision_record_ref = artifact_ref(
            parity_comparison.get("decisionRecordRef")
            if isinstance(parity_comparison.get("decisionRecordRef"), Mapping)
            else None
        )
        evidence_pack_ref = artifact_ref(contract.evidence_pack_ref)

        propose_candidate_attempts = [
            entry
            for entry in contract.repair_attempts
            if isinstance(entry, Mapping)
            and str(entry.get("repairDecision") or "").strip() == "propose_candidate"
        ]
        blocked_repair_attempt = any(
            isinstance(entry, Mapping)
            and str(entry.get("repairDecision") or "").strip() in {"refuse", "escalate"}
            for entry in contract.repair_attempts
        )
        winning_attempt = propose_candidate_attempts[-1] if propose_candidate_attempts else None
        if winning_attempt is not None and final_classification == CLASSIFICATION_SUCCESS:
            repair_status = "repair_verified"
        elif winning_attempt is not None:
            repair_status = "repair_failed"
        elif blocked_repair_attempt:
            repair_status = "repair_blocked"
        else:
            repair_status = "not_attempted"

        repair_decision_ref = artifact_ref(
            winning_attempt if isinstance(winning_attempt, Mapping) else None
        )
        if repair_decision_ref is not None and "repairDecisionRef" in repair_decision_ref:
            repair_decision_ref = artifact_ref(
                winning_attempt.get("repairDecisionRef")
                if isinstance(winning_attempt, Mapping)
                and isinstance(winning_attempt.get("repairDecisionRef"), Mapping)
                else None
            )
        else:
            repair_decision_ref = artifact_ref(
                winning_attempt.get("repairDecisionRef")
                if isinstance(winning_attempt, Mapping)
                and isinstance(winning_attempt.get("repairDecisionRef"), Mapping)
                else None
            )
        repaired_build_test_ref = artifact_ref(
            winning_attempt.get("buildTestResultRef")
            if isinstance(winning_attempt, Mapping)
            and isinstance(winning_attempt.get("buildTestResultRef"), Mapping)
            else None
        )
        repaired_java_candidate_ref = artifact_ref(
            winning_attempt.get("javaCandidateRef")
            if isinstance(winning_attempt, Mapping)
            and isinstance(winning_attempt.get("javaCandidateRef"), Mapping)
            else None
        )
        repair_verified_at = (
            _text(winning_attempt.get("createdAt"))
            if isinstance(winning_attempt, Mapping)
            else None
        )

        evidence_status = "current"
        if evidence_incomplete or evidence_pack_ref is None:
            evidence_status = "incomplete"
        elif (
            evidence_recorded_at
            and comparison_completed_at
            and evidence_recorded_at < comparison_completed_at
        ):
            evidence_status = "stale"

        divergence_disposition = "none"
        coverage_gap_detected = (
            mismatch_classification == "known_coverage_gap"
            or "coverage-gap" in mismatch_classification
            or "coverage-gap" in build_classification
        )

        if coverage_gap_detected:
            divergence_disposition = "known_coverage_gap"
        elif mismatch_classification == "intentional" and decision_record_ref is not None:
            divergence_disposition = "intentional"
        elif mismatch_classification not in {"", "none"} and parity_passed is False:
            divergence_disposition = "unknown"

        warning_codes: list[str] = []
        if coverage_gap_detected:
            warning_codes.extend(["known_coverage_gap", "limited_coverage"])
        if contract.manual_edits_carried_over:
            warning_codes.append("manual_edits_carried_over")

        coverage_status = "limited" if "limited_coverage" in warning_codes else "full"

        if divergence_disposition == "intentional":
            trust_state = "intentional_divergence"
        elif build_failed:
            trust_state = "build_failed"
        elif runtime_failed:
            trust_state = "runtime_failed"
        elif parity_passed is True and not evidence_incomplete:
            trust_state = "parity_passed"
        elif parity_passed is False:
            trust_state = "parity_failed"
        else:
            trust_state = "blocked"

        cobol_status = "completed" if source_normalized_ref is not None else "not_available"
        java_status = "not_available"
        if build_failed:
            java_status = "build_failed"
        elif runtime_failed:
            java_status = "runtime_failed"
        elif execution_result_ref is not None or target_normalized_ref is not None:
            java_status = "completed"

        comparison_status = "not_available"
        if parity_passed is True:
            comparison_status = "matched"
        elif parity_passed is False:
            comparison_status = "mismatched"

        return {
            "schemaVersion": SCHEMA_VERSION,
            "trustState": trust_state,
            "repairStatus": repair_status,
            "coverageStatus": coverage_status,
            "divergenceDisposition": divergence_disposition,
            "warningCodes": warning_codes,
            "trustCase": {
                "trustCaseId": _text(trust_case.get("trustCaseId")) or context.trust_case_id or "",
                "version": _text(trust_case.get("version")) or "",
                "catalogVersion": _text(trust_case.get("catalogVersion")) or "",
                "catalogHash": _text(trust_case.get("catalogHash")) or "",
                "configurationDigest": _text(trust_case.get("configurationDigest")) or "",
            },
            "cobolResult": {
                "status": cobol_status,
                "normalizedOutputRef": source_normalized_ref,
            },
            "javaResult": {
                "status": java_status,
                "executionResultRef": execution_result_ref,
                "normalizedOutputRef": target_normalized_ref,
            },
            "comparisonResult": {
                "status": comparison_status,
                "mismatchClassification": mismatch_classification,
                "comparisonPolicyRef": comparison_policy_ref,
                "comparisonResultRef": comparison_result_ref,
                "diffRef": diff_ref,
                "decisionRecordRef": decision_record_ref,
            },
            "repair": {
                "status": repair_status,
                "repairDecisionRef": repair_decision_ref,
                "repairedBuildTestResultRef": repaired_build_test_ref,
                "repairedJavaCandidateRef": repaired_java_candidate_ref,
            },
            "evidence": {
                "status": evidence_status,
                "recordedAt": evidence_recorded_at,
                "packRef": evidence_pack_ref,
            },
            "comparisonCompletedAt": comparison_completed_at,
            "summaryDerivedAt": _iso_now(),
            "repairVerifiedAt": repair_verified_at,
        }

    @staticmethod
    def _build_assist_decision_lineage(
        contract: W02RunContract,
    ) -> JsonObject | None:
        """Project the run contract's assist-decision (Issue #214/#215/#216)
        into the evidence-pack lineage envelope defined by Issue #217.

        Returns ``None`` when the run never reached the gate (e.g., it was
        blocked before semantic-IR-ready). Evidence-service relaxes the
        ``assistDecision`` requirement for blocked packs in that case.
        """
        decision = contract.assist_decision
        if decision is None:
            return None
        return decision.to_dict()

    @staticmethod
    def _normalise_model_invocation_ref(
        raw: Mapping[str, JsonValue] | None,
    ) -> JsonObject | None:
        if not isinstance(raw, Mapping):
            return None
        invocation_id = _text(raw.get("invocationId"))
        model_id = _text(raw.get("modelId"))
        ledger_ref = _data_reference_from_mapping(raw.get("ledgerRef"))
        if invocation_id is None or model_id is None or ledger_ref is None:
            return None
        payload: JsonObject = {
            "invocationId": invocation_id,
            "modelId": model_id,
            "ledgerRef": _as_reference_payload(ledger_ref),
        }
        for key in (
            "provider",
            "promptTemplateVersion",
            "promptTemplateId",
            "policyDecision",
            "status",
            "reason",
            "policyVersion",
            "policyId",
            "agentRole",
            "errorCode",
            "errorClass",
            "timestamp",
        ):
            value = _text(raw.get(key))
            if value is not None:
                payload[key] = value
        try:
            latency_ms = int(raw.get("latencyMs"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            latency_ms = None
        if latency_ms is not None and latency_ms >= 0:
            payload["latencyMs"] = latency_ms
        return payload

    def _build_model_invocation_refs(
        self,
        *,
        productive_model_invocations: Sequence[Mapping[str, JsonValue]] | None,
        fallback_model_invocation: Mapping[str, JsonValue],
        include_fallback: bool,
    ) -> list[JsonObject]:
        refs: list[JsonObject] = []
        seen: set[tuple[str, str, str]] = set()

        def add_ref(raw: Mapping[str, JsonValue] | None) -> None:
            normalised = self._normalise_model_invocation_ref(raw)
            if normalised is None:
                return
            ledger = normalised["ledgerRef"]
            ledger_uri = str(ledger.get("uri") or "") if isinstance(ledger, Mapping) else ""
            ledger_sha = str(ledger.get("sha256") or "") if isinstance(ledger, Mapping) else ""
            key = (str(normalised["invocationId"]), ledger_uri, ledger_sha)
            if key in seen:
                return
            seen.add(key)
            refs.append(normalised)

        for ref in productive_model_invocations or ():
            add_ref(ref)
        if include_fallback or not refs:
            add_ref(fallback_model_invocation)
        return refs

    # noinspection PyTypeHints
    def _build_model_invocation_ref(
        self,
        context: W0RunContext,
        model_output: Mapping[str, JsonValue] | None,
        *,
        model_policy_skipped_meta: ArtifactMetadata | None = None,
    ) -> JsonObject:
        configured_model_id = _text(getattr(self.config, "model_gateway_model_id", None)) or DEFAULT_MODEL_ID
        if model_output is None:
            payload = {
                "runId": context.run_id,
                "modelId": configured_model_id,
                "status": "skipped",
                "reason": "no modelPrompt provided by requester; deterministic W0 translation completed without model assistance",
                "policyVersion": _text(getattr(self.config, "model_policy_version", None)) or "v0",
            }
            ledger_ref = (
                DataReference(
                    uri=model_policy_skipped_meta.uri,
                    sha256=model_policy_skipped_meta.sha256,
                    byte_size=model_policy_skipped_meta.byteSize,
                )
                if model_policy_skipped_meta is not None
                else _build_reference(
                    f"urn:orchestrator/{context.run_id}/model-invocation",
                    payload,
                )
            )
            return {
                "invocationId": f"inv-{context.run_id}-00",
                "modelId": configured_model_id,
                "provider": "policy-skipped",
                "promptTemplateVersion": DEFAULT_PROMPT_TEMPLATE_VERSION,
                "policyDecision": POLICY_ALLOW,
                "status": "skipped",
                "reason": payload["reason"],
                "policyVersion": payload["policyVersion"],
                "timestamp": (
                    model_policy_skipped_meta.createdAt
                    if model_policy_skipped_meta is not None
                    else _iso_now()
                ),
                "ledgerRef": _as_reference_payload(ledger_ref),
            }

        payload = dict(model_output)
        invocation_id = _text(payload.get("invocationId")) or f"inv-{context.run_id}-00"
        model_id = _text(payload.get("modelId")) or DEFAULT_MODEL_ID
        provider = _text(payload.get("provider"))
        template = _text(payload.get("promptTemplateVersion")) or DEFAULT_PROMPT_TEMPLATE_VERSION
        policy_decision = _text(payload.get("policyDecision"))
        status = _text(payload.get("status")) or "completed"
        ledger_ref = _data_reference_from_mapping(payload.get("ledgerRef"))
        if ledger_ref is None:
            ledger_payload = {
                "invocationId": invocation_id,
                "modelId": model_id,
                "provider": provider,
                "promptTemplateVersion": template,
                "policyDecision": policy_decision,
                "status": status,
            }
            ledger_ref = _build_reference(
                f"urn:orchestrator/{context.run_id}/model-invocation",
                ledger_payload,
            )
        return {
            "invocationId": invocation_id,
            "modelId": model_id,
            "provider": provider,
            "promptTemplateVersion": template,
            "policyDecision": policy_decision,
            "status": status,
            "ledgerRef": _as_reference_payload(ledger_ref),
        }

    @staticmethod
    def _resolve_program_id(*payloads: Mapping[str, JsonValue]) -> str:
        for payload in payloads:
            program_id = _text(_first_non_empty_mapping(payload).get("programId"))
            if program_id:
                return program_id
            program = _first_non_empty_mapping(payload.get("program"))
            if not program:
                continue
            program_id = _text(program.get("programId"))
            if program_id:
                return program_id
            program_id = _text(program.get("id"))
            if program_id:
                return program_id
        return "unknown"

    def _emit_workflow_decision_event(
        self,
        context: W0RunContext,
        event_type: str,
        message: str,
    ) -> None:
        self._post_event(
            context.run_id,
            event_type=event_type,
            capability=self.config.service_name,
            actor=self.config.service_name,
            data_class=DATA_CLASS_CONTROL,
            status="updating",
            state_transition=STATE_TRANSITION_FLOW,
            input_payload={"runId": context.run_id, "workflowId": context.workflow_id},
            output_payload={"message": message},
            input_ref=_build_reference(
                f"urn:orchestrator/{context.run_id}/workflow-in",
                {"runId": context.run_id, "workflowId": context.workflow_id},
            ),
            output_ref=_build_reference(
                f"urn:orchestrator/{context.run_id}/workflow-out",
                {"message": message},
            ),
            policy_decision=POLICY_ALLOW,
        )

    def _record_assist_decision(
        self,
        context: W0RunContext,
        contract: W02RunContract,
        *,
        baseline_artifact_ref: JsonObject | None,
        ir_output_ref: DataReference,
        ir_document: Mapping[str, JsonValue] | None = None,
        baseline_generated_project: Mapping[str, JsonValue] | None = None,
    ) -> AssistDecision:
        """Evaluate, record, persist, and emit the W0.3 assist-decision gate.

        Issue #214 introduced the gate with the caller-opt-in baseline.
        Issue #215 (W0.3-4) extends the closed reason-code set with
        deterministic uncertainty criteria so the gate records the most
        specific reason for productive assist rather than always falling
        back to ``caller_explicit_opt_in``. The contract shape, the
        outcomes, and the event semantics are unchanged.

        When the caller opted in and the deterministic baseline produced
        uncertainty markers (IR bounded ambiguity, unsupported-but-repairable
        constructs, open assumptions, or explicit low-confidence markers),
        the gate records the highest-priority marker as the reason code.
        Without markers the gate falls back to ``caller_explicit_opt_in``.

        When the caller did not opt in the gate records
        ``caller_did_not_opt_in`` regardless of markers: the deterministic
        baseline remains the final candidate. The Orchestrator still
        attaches the detected uncertainty markers to the decision rationale
        so the Evidence Pack consumer can see what was observed.
        """
        contract.set_active_step(W02_STEP_ASSIST_DECISION)
        affected_refs: tuple[JsonObject, ...] = ()
        if baseline_artifact_ref is not None:
            baseline_ref = _data_reference_from_mapping(baseline_artifact_ref)
            if baseline_ref is not None:
                affected_refs = (
                    _as_reference_payload(baseline_ref),
                )

        detected_reason, detected_markers = self._detect_deterministic_uncertainty(
            ir_document=ir_document,
            generated_project=baseline_generated_project,
        )

        if context.use_transformation_agent:
            # Issue #216 (W0.3-5): the gate is the contract-level point at
            # which the orchestrator commits to a productive assist
            # activation. Consume one unit of the per-run assist budget
            # here so the contract enforces the cap *before* any model
            # gateway call. On exhaustion, hard-degrade to
            # ``assist_not_required`` with the dedicated reason code so
            # the deterministic baseline becomes the final candidate
            # without a hidden continuation.
            try:
                contract.assist_budget.consume()
            except w02.AssistBudgetExhaustedError:
                outcome = ASSIST_OUTCOME_NOT_REQUIRED
                reason_code = ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED
                selected_role: str | None = None
                rationale = (
                    "caller opted into productive Transformation Agent but the "
                    f"per-run assist budget (limit={contract.assist_budget.limit}, "
                    f"used={contract.assist_budget.used}) is exhausted; "
                    "deterministic baseline is the final candidate"
                )
                if detected_markers:
                    rationale += (
                        f" (detected markers ignored: {', '.join(detected_markers)})"
                    )
            else:
                outcome = ASSIST_OUTCOME_REQUIRED
                selected_role = ASSIST_AGENT_ROLE_TRANSFORMATION
                if detected_reason is not None:
                    reason_code = detected_reason
                    rationale = (
                        f"caller opted into productive Transformation Agent and the "
                        f"deterministic baseline produced uncertainty markers "
                        f"({', '.join(detected_markers)})"
                    )
                else:
                    reason_code = ASSIST_REASON_CALLER_EXPLICIT_OPT_IN
                    rationale = (
                        "caller opted into productive Transformation Agent via "
                        "useTransformationAgent=true; no deterministic uncertainty "
                        "markers detected on the baseline"
                    )
        else:
            outcome = ASSIST_OUTCOME_NOT_REQUIRED
            reason_code = ASSIST_REASON_CALLER_DID_NOT_OPT_IN
            selected_role = None
            if detected_markers:
                rationale = (
                    f"productive Transformation Agent is disabled for this run; "
                    f"deterministic baseline is the final candidate "
                    f"(detected markers ignored: {', '.join(detected_markers)})"
                )
            else:
                rationale = (
                    "productive Transformation Agent is disabled for this run; "
                    "deterministic baseline is the final candidate"
                )

        decision = AssistDecision(
            outcome=outcome,
            reason_code=reason_code,
            decided_at=_iso_now(),
            selected_agent_role=selected_role,
            affected_artifact_refs=affected_refs,
            repair_budget_snapshot=contract.repair_budget.to_dict(),
            # Issue #216 (W0.3-5): snapshot the assist and model invocation
            # budgets at gate time so consumers can audit the budget state
            # the orchestrator observed when the assist decision was made.
            assist_budget_snapshot=contract.assist_budget.to_dict(),
            model_invocation_budget_snapshot=(
                contract.model_invocation_budget.to_dict()
            ),
            rationale=rationale,
        )
        contract.record_assist_decision(decision)
        self._persist_w02_contract(context, contract)
        self._emit_assist_decision_event(context, decision, ir_output_ref)
        return decision

    @staticmethod
    def _detect_deterministic_uncertainty(
        *,
        ir_document: Mapping[str, JsonValue] | None,
        generated_project: Mapping[str, JsonValue] | None,
    ) -> tuple[str | None, tuple[str, ...]]:
        """Inspect baseline outputs for deterministic uncertainty markers.

        Returns ``(primary_reason_code, detected_markers)`` where
        ``primary_reason_code`` is the highest-priority match from
        :data:`run_contract.ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES`
        and ``detected_markers`` is the ordered tuple of every reason code
        that fired (so the rationale and downstream evidence can name them
        all without changing the contract shape).

        The marker conventions:

        * ``ir_document.ambiguityMarkers`` (non-empty list): the Semantic IR
          carries a bounded-ambiguity marker — the deterministic baseline
          committed to one of several valid interpretations.
        * ``generated_project.unsupportedFeatures`` (non-empty list): the
          deterministic generator could not lower one or more constructs.
        * ``generated_project.openAssumptions`` (non-empty list): the
          baseline emitted an explicit assumption it had to make to
          produce the candidate.
        * ``generated_project.lowConfidenceMarkers`` (non-empty list): the
          baseline annotated regions of its candidate as low-confidence.

        Markers that are not non-empty lists are ignored. The orchestrator
        never invents a marker on behalf of an upstream capability — every
        recorded reason code must be backed by a real payload value.
        """
        markers: list[str] = []
        if _has_non_empty_list(ir_document, "ambiguityMarkers"):
            markers.append(ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY)
        if _has_non_empty_list(generated_project, "unsupportedFeatures"):
            markers.append(ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE)
        if _has_non_empty_list(generated_project, "openAssumptions"):
            markers.append(ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS)
        if _has_non_empty_list(generated_project, "lowConfidenceMarkers"):
            markers.append(ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE)
        primary = markers[0] if markers else None
        return primary, tuple(markers)

    def _emit_assist_decision_event(
        self,
        context: W0RunContext,
        decision: AssistDecision,
        input_ref: DataReference,
    ) -> None:
        """Emit the Harness event recording the assist-decision gate.

        Event type: ``orchestrator.workflow.assist_decision.<outcome>`` where
        ``<outcome>`` is one of the closed-set
        :data:`run_contract.ASSIST_OUTCOMES` values.
        """
        payload = decision.to_dict()
        self._post_event(
            context.run_id,
            event_type=f"orchestrator.workflow.assist_decision.{decision.outcome}",
            capability=self.config.service_name,
            actor=self.config.service_name,
            data_class=DATA_CLASS_CONTROL,
            status="updating",
            state_transition=STATE_TRANSITION_FLOW,
            input_payload={
                "runId": context.run_id,
                "workflowId": context.workflow_id,
            },
            output_payload=payload,
            input_ref=input_ref,
            output_ref=_build_reference(
                f"urn:orchestrator/{context.run_id}/assist-decision",
                payload,
            ),
            policy_decision=POLICY_ALLOW,
        )

    def _invoke_step(
        self,
        context: W0RunContext,
        step_name: str,
        capability: JsonObject,
        data_class: str,
        payload: Mapping[str, JsonValue],
        input_ref: DataReference,
    ) -> WorkflowStepResult:
        capability_id = str(capability.get("id", "")).strip()
        actor = str(capability.get("owner", self.config.service_name)).strip()
        endpoint = str(capability.get("endpoint", "")).strip()
        failure_code = self._failure_code_for_step_name(
            step_name,
            data_class=data_class,
        ) or FAILURE_JAVA_GENERATION_FAILED
        if not capability_id:
            raise CapabilityMissingError(
                f"{step_name} capability id is invalid",
                step_name=step_name,
                failure_code=failure_code,
            )
        if not endpoint:
            raise CapabilityMissingError(
                f"{step_name} capability endpoint is missing",
                step_name=step_name,
                failure_code=failure_code,
            )

        event_input_payload = self._event_input_payload(data_class, payload)

        # Issue #96: record the step as `running` before the upstream call so
        # /v0/runs/{runId}/progress can show in-flight state to the UI.
        self._record_step_start(
            context,
            name=step_name,
            capability_id=capability_id,
            actor=actor,
            input_ref=input_ref,
        )

        for attempt in range(0, self.config.max_retries + 1):
            attempt_number = attempt + 1
            try:
                started_at = time.time()
                output_payload = self.gateway.invoke_capability(capability, dict(payload))
                latency_ms = int((time.time() - started_at) * 1000)
                output_payload = dict(output_payload)
                output_ref = self._coerce_step_output_ref(output_payload, step_name, context.run_id)
                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.executed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="ok",
                    state_transition=STATE_TRANSITION_STEP_COMPLETED,
                    input_payload=event_input_payload,
                    output_payload=output_payload,
                    input_ref=input_ref,
                    output_ref=output_ref,
                    latency_ms=latency_ms,
                    policy_decision=POLICY_ALLOW,
                )
                self._record_step_finish(
                    context,
                    name=step_name,
                    capability_id=capability_id,
                    actor=actor,
                    status=STEP_STATUS_OK,
                    input_ref=input_ref,
                    output_ref=output_ref,
                    latency_ms=latency_ms,
                )
                return WorkflowStepResult(
                    capability_id=capability_id,
                    step_name=step_name,
                    payload=output_payload,
                    status="ok",
                    input_ref=input_ref,
                    output_ref=output_ref,
                )
            except HarnessFailure as exc:
                if attempt < self.config.max_retries:
                    self._post_event(
                        context.run_id,
                        event_type=f"{step_name}.retry",
                        capability=capability_id,
                        actor=actor,
                        data_class=data_class,
                        status="updating",
                        state_transition=STATE_TRANSITION_STEP_RETRY,
                        input_payload={"attempt": attempt_number, "step": step_name},
                        output_payload={"error": str(exc), "result": "retrying"},
                        input_ref=input_ref,
                        output_ref=_build_reference(
                            f"urn:orchestrator/{context.run_id}/step/{step_name}/retry",
                            {"attempt": attempt_number, "step": step_name},
                        ),
                        policy_decision=POLICY_ALLOW,
                    )
                    time.sleep(self.config.retry_delay_ms / 1000)
                    continue

                failure_ref = _build_reference(
                    f"urn:orchestrator/{context.run_id}/step/{step_name}/failure",
                    {"error": str(exc), "attempts": attempt_number},
                )
                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.failed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="failed",
                    state_transition=STATE_TRANSITION_STEP_FAILED,
                    input_payload=event_input_payload,
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=failure_ref,
                    policy_decision=POLICY_ALLOW,
                )
                self._record_step_finish(
                    context,
                    name=step_name,
                    capability_id=capability_id,
                    actor=actor,
                    status=STEP_STATUS_FAILED,
                    input_ref=input_ref,
                    output_ref=failure_ref,
                    diagnostic=str(exc),
                    run_status="failed",
                    failed_step=step_name,
                )
                if data_class == DATA_CLASS_MODEL and _is_model_policy_denial(exc):
                    raise ModelPolicyDeniedStepError(
                        f"step {step_name} blocked by model gateway policy: {exc}"
                    ) from exc
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc
            except Exception as exc:
                failure_ref = _build_reference(
                    f"urn:orchestrator/{context.run_id}/step/{step_name}/failure",
                    {"error": str(exc), "attempts": attempt_number},
                )
                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.failed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="failed",
                    state_transition=STATE_TRANSITION_STEP_FAILED,
                    input_payload=event_input_payload,
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=failure_ref,
                    policy_decision=POLICY_ALLOW,
                )
                self._record_step_finish(
                    context,
                    name=step_name,
                    capability_id=capability_id,
                    actor=actor,
                    status=STEP_STATUS_FAILED,
                    input_ref=input_ref,
                    output_ref=failure_ref,
                    diagnostic=str(exc),
                    run_status="failed",
                    failed_step=step_name,
                )
                if data_class == DATA_CLASS_MODEL and _is_model_policy_denial(exc):
                    raise ModelPolicyDeniedStepError(
                        f"step {step_name} blocked by model gateway policy: {exc}"
                    ) from exc
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc

        raise StepExecutionError(f"step {step_name} retry loop exited without resolution")

    @staticmethod
    def _event_input_payload(data_class: str, payload: Mapping[str, JsonValue]) -> JsonObject:
        event_payload = dict(payload)
        if data_class != DATA_CLASS_MODEL:
            return event_payload
        if "prompt" in event_payload:
            event_payload.pop("prompt", None)
            event_payload["promptRedacted"] = True
        return event_payload

    @staticmethod
    def _coerce_step_output_ref(output_payload: Mapping[str, JsonValue], step_name: str, run_id: str) -> DataReference:
        output_ref_raw = _first_non_empty_mapping(output_payload.get("outputRef"))
        if output_ref_raw:
            return DataReference(
                uri=_text(output_ref_raw.get("uri")) or f"urn:orchestrator/{run_id}/step/{step_name}",
                sha256=_text(output_ref_raw.get("sha256")) or _build_reference(
                    f"urn:orchestrator/{run_id}/step/{step_name}",
                    output_payload,
                ).sha256,
                byte_size=_to_non_negative_int(output_ref_raw.get("byteSize", output_ref_raw.get("byte_size", 0))),
            )
        if _text(output_payload.get("status")) in {"failed", "error"}:
            message = _text(output_payload.get("error")) or _text(output_payload.get("message")) or f"{step_name} failed"
            return _build_reference(f"urn:orchestrator/{run_id}/step/{step_name}/failed", message)
        return _build_reference(f"urn:orchestrator/{run_id}/step/{step_name}", output_payload)

    def _require_capability(self, run_id: str, capability_id: str) -> JsonObject:
        step_name, failure_code = self._capability_failure_context(capability_id)
        if not capability_id:
            raise CapabilityMissingError(
                "capability id is required",
                failure_code=FAILURE_JAVA_GENERATION_FAILED,
            )
        cached = self._capability_cache.get(capability_id)
        if cached is not None:
            return cached
        try:
            capability = self.gateway.get_capability(capability_id)
        except Exception as exc:
            raise CapabilityMissingError(
                f"required capability {capability_id} unavailable",
                step_name=step_name,
                failure_code=failure_code,
            ) from exc
        capability_name = capability.get("id")
        if not isinstance(capability_name, str) or not capability_name.strip():
            raise CapabilityMissingError(
                f"invalid capability payload for {capability_id}",
                step_name=step_name,
                failure_code=failure_code,
            )
        if capability_id == self.config.model_gateway_capability_id:
            try:
                _validate_model_gateway_capability(
                    capability,
                    capability_id,
                    expected_capability=self._configured_capability(capability_id),
                )
            except ModelGatewayUnavailableError as exc:
                raise CapabilityMissingError(
                    "model gateway capability failed allowlist validation",
                    step_name=step_name,
                    failure_code=FAILURE_MODEL_GATEWAY_UNAVAILABLE,
                ) from exc
        self._capability_cache[capability_id] = capability
        self._post_event(
            run_id,
            event_type="orchestrator.capability.resolved",
            capability=capability_id,
            actor=self.config.service_name,
            data_class=DATA_CLASS_CONTROL,
            status="ok",
            state_transition=STATE_TRANSITION_CAPABILITY,
            input_payload={"capabilityId": capability_id},
            output_payload={"resolved": True},
            input_ref=_build_reference(
                f"urn:orchestrator/{run_id}/capability/{capability_id}/request",
                {"capabilityId": capability_id},
            ),
            output_ref=_build_reference(
                f"urn:orchestrator/{run_id}/capability/{capability_id}/response",
                {"resolved": True},
            ),
            policy_decision=POLICY_ALLOW,
        )
        return capability

    def _post_event(
        self,
        run_id: str,
        *,
        event_type: str,
        capability: str,
        actor: str,
        data_class: str,
        status: str,
        state_transition: str,
        input_payload: Mapping[str, JsonValue],
        output_payload: Mapping[str, JsonValue],
        input_ref: DataReference,
        output_ref: DataReference,
        policy_decision: str = POLICY_ALLOW,
        latency_ms: int | None = None,
    ) -> None:
        step_id = self._next_step_id(run_id)
        event: JsonObject = {
            "eventType": event_type,
            "schemaVersion": "v0",
            "service": self.config.service_name,
            "runId": run_id,
            "stepId": step_id,
            "eventId": f"orch-{run_id}-{step_id}",
            "actor": actor,
            "capability": capability,
            "dataClass": data_class,
            "redactionProfile": PROFILE_CONTROLLED_BY_HARNESS,
            "policyDecision": policy_decision,
            "status": status,
            "stateTransition": state_transition,
            "createdAt": _iso_now(),
            "inputRef": _as_reference_payload(input_ref),
            "outputRef": _as_reference_payload(output_ref),
            "payload": {
                "input": _redact_event_payload(dict(input_payload)),
                "output": _redact_event_payload(dict(output_payload)),
            },
        }
        if latency_ms is not None:
            event["latencyMs"] = latency_ms
        # Buffer for the experience-learning-service flush (Issue #96).
        self._buffer_event_for_learning(run_id, event)
        try:
            self.gateway.post_event(event)
        except Exception:
            # Eventing is best-effort and must not break control-plane execution.
            return

    def _buffer_event_for_learning(self, run_id: str, event: Mapping[str, JsonValue]) -> None:
        with self._event_buffer_lock:
            buffer = self._event_buffer_by_run.setdefault(run_id, [])
            buffer.append(dict(event))

    def _drain_event_buffer(self, run_id: str) -> list[JsonObject]:
        with self._event_buffer_lock:
            buffer = self._event_buffer_by_run.pop(run_id, [])
        return buffer

    def _flush_to_experience_learning(
        self,
        run_id: str,
        trajectory_payload: Mapping[str, JsonValue] | None = None,
    ) -> None:
        """Forward buffered Harness events and the trajectory ledger to EL.

        Best-effort: failures are swallowed by the gateway implementation.
        Issue #96 requires UI-started runs to feed Experience Learning so the
        Harness/EL system can observe and learn from each pipeline run.
        """
        events = self._drain_event_buffer(run_id)
        if events:
            self.experience_learning.post_harness_events(events)
        if trajectory_payload:
            self.experience_learning.post_trajectory_ledger(trajectory_payload)

    def _next_step_id(self, run_id: str) -> int:
        with self._step_lock:
            current = self._step_id_by_run.get(run_id, 0) + 1
            self._step_id_by_run[run_id] = current
        return current

    def _progress_for(self, run_id: str) -> RunProgressLog:
        with self._progress_lock:
            log = self._progress_by_run.get(run_id)
            if log is None:
                log = RunProgressLog()
                self._progress_by_run[run_id] = log
        return log

    def progress_payload(self, run_id: str) -> list[JsonObject]:
        """Return the in-memory step list for `run_id`, empty if unknown."""
        with self._progress_lock:
            log = self._progress_by_run.get(run_id)
        if log is None:
            return []
        return log.to_payload()

    def _persist_progress(
        self,
        context: W0RunContext,
        log: RunProgressLog,
        *,
        current_step: str | None,
        run_status: str,
        failed_step: str | None = None,
    ) -> None:
        steps = log.to_payload()
        completed = [step["name"] for step in steps if step.get("status") == STEP_STATUS_OK]
        payload = {
            "schemaVersion": "v0",
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "requester": context.requester,
            "runStatus": run_status,
            "currentStep": current_step,
            "failedStep": failed_step,
            "completedSteps": completed,
            "stepCount": len(steps),
            "steps": steps,
            "updatedAt": _iso_now(),
        }
        try:
            self.artifact_store.write_json(
                context.run_id,
                context.workflow_id,
                "run-progress.json",
                payload,
                kind=KIND_RUN_PROGRESS,
            )
        except Exception:  # pragma: no cover - persistence is best-effort
            return

    def _record_step_start(
        self,
        context: W0RunContext,
        *,
        name: str,
        capability_id: str,
        actor: str,
        input_ref: DataReference | None,
    ) -> StepRecord:
        log = self._progress_for(context.run_id)
        record = log.upsert(
            name=name,
            capability_id=capability_id,
            service=self.config.service_name,
            actor=actor,
            status=STEP_STATUS_RUNNING,
            started_at=_iso_now(),
            input_ref=_as_reference_payload(input_ref) if input_ref is not None else None,
        )
        self._persist_progress(context, log, current_step=name, run_status="updating")
        return record

    def _record_step_finish(
        self,
        context: W0RunContext,
        *,
        name: str,
        capability_id: str,
        actor: str,
        status: str,
        input_ref: DataReference | None = None,
        output_ref: DataReference | None = None,
        diagnostic: str | None = None,
        latency_ms: int | None = None,
        run_status: str = "updating",
        failed_step: str | None = None,
    ) -> None:
        log = self._progress_for(context.run_id)
        log.upsert(
            name=name,
            capability_id=capability_id,
            service=self.config.service_name,
            actor=actor,
            status=status,
            finished_at=_iso_now(),
            input_ref=_as_reference_payload(input_ref) if input_ref is not None else None,
            output_ref=_as_reference_payload(output_ref) if output_ref is not None else None,
            diagnostic=diagnostic,
            latency_ms=latency_ms,
        )
        current = name if status == STEP_STATUS_RUNNING else None
        self._persist_progress(
            context,
            log,
            current_step=current,
            run_status=run_status,
            failed_step=failed_step,
        )

    def _record_parity_build_steps(
        self,
        *,
        context: W0RunContext,
        build_test_output: WorkflowStepResult,
        input_ref: DataReference,
    ) -> None:
        payload = build_test_output.payload or {}
        build_result = _first_non_empty_mapping(payload.get("buildResult")) or _first_non_empty_mapping(
            payload.get("build")
        )
        execution_result = _first_non_empty_mapping(payload.get("executionResult")) or _first_non_empty_mapping(
            payload.get("execution")
        )
        comparison_result = _first_non_empty_mapping(payload.get("comparisonResult")) or _first_non_empty_mapping(
            payload.get("comparison")
        )

        build_ref = (
            _data_reference_from_mapping(build_result.get("outputRef"))
            or _data_reference_from_mapping(build_result.get("buildOutputRef"))
            or build_test_output.output_ref
        )
        build_status_value = _text(build_result.get("status")) or _text(payload.get("status")) or ""
        build_ok = build_status_value in {"passed", "ok", "success", "complete", "verified"}
        self._record_step_finish(
            context,
            name=STEP_JAVA_BUILD,
            capability_id=self.config.build_test_capability_id,
            actor=self.config.service_name,
            status=STEP_STATUS_OK if build_ok else STEP_STATUS_FAILED,
            input_ref=input_ref,
            output_ref=build_ref,
            diagnostic=_text(build_result.get("summary")) or _text(payload.get("summary")),
        )

        execution_ref = _data_reference_from_mapping(execution_result.get("outputRef")) or _data_reference_from_mapping(
            execution_result.get("logRef")
        )
        if build_ok:
            self._record_step_start(
                context,
                name=STEP_JAVA_EXECUTION,
                capability_id=self.config.build_test_capability_id,
                actor=self.config.service_name,
                input_ref=build_ref,
            )
            execution_status_value = _text(execution_result.get("status")) or ""
            execution_ok = execution_status_value == "passed"
            self._record_step_finish(
                context,
                name=STEP_JAVA_EXECUTION,
                capability_id=self.config.build_test_capability_id,
                actor=self.config.service_name,
                status=STEP_STATUS_OK if execution_ok else STEP_STATUS_FAILED,
                input_ref=build_ref,
                output_ref=execution_ref,
                diagnostic=_text(execution_result.get("summary")) or _text(payload.get("summary")),
            )
            self._record_step_start(
                context,
                name=STEP_PARITY_COMPARISON,
                capability_id=self.config.build_test_capability_id,
                actor=self.config.service_name,
                input_ref=execution_ref or build_ref,
            )
            comparison_status_value = _text(comparison_result.get("status")) or ""
            comparison_ok = comparison_status_value == "passed"
            comparison_ref = _data_reference_from_mapping(comparison_result.get("outputRef")) or _data_reference_from_mapping(
                payload.get("comparisonResultRef")
            )
            self._record_step_finish(
                context,
                name=STEP_PARITY_COMPARISON,
                capability_id=self.config.build_test_capability_id,
                actor=self.config.service_name,
                status=STEP_STATUS_OK if comparison_ok else STEP_STATUS_FAILED,
                input_ref=execution_ref or build_ref,
                output_ref=comparison_ref,
                diagnostic=_text(comparison_result.get("diffSummary")) or _text(payload.get("summary")),
            )
        else:
            self._record_marker_step(
                context,
                name=STEP_JAVA_EXECUTION,
                status=STEP_STATUS_SKIPPED,
                run_status="updating",
                diagnostic="java build failed; execution not attempted",
            )
            self._record_marker_step(
                context,
                name=STEP_PARITY_COMPARISON,
                status=STEP_STATUS_SKIPPED,
                run_status="updating",
                diagnostic="java build failed; comparison not attempted",
            )

    def _record_marker_step(
        self,
        context: W0RunContext,
        *,
        name: str,
        status: str,
        run_status: str,
        diagnostic: str | None = None,
        failed_step: str | None = None,
    ) -> None:
        log = self._progress_for(context.run_id)
        timestamp = _iso_now()
        log.upsert(
            name=name,
            capability_id=self.config.service_name,
            service=self.config.service_name,
            actor=self.config.service_name,
            status=status,
            started_at=timestamp,
            finished_at=timestamp if status != STEP_STATUS_RUNNING else None,
            diagnostic=diagnostic,
        )
        self._persist_progress(
            context,
            log,
            current_step=name if status == STEP_STATUS_RUNNING else None,
            run_status=run_status,
            failed_step=failed_step,
        )

    @staticmethod
    def _build_summary(
        context: W0RunContext,
        parse_output: WorkflowStepResult,
        ir_output: WorkflowStepResult,
        generator_output: WorkflowStepResult,
        build_output: WorkflowStepResult | None,
    ) -> str:
        summary: JsonObject = {
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "requester": context.requester,
            "capturedAt": int(time.time()),
            "parseRef": parse_output.output_ref.uri,
            "irRef": ir_output.output_ref.uri,
            "javaRef": generator_output.output_ref.uri,
            "buildRef": build_output.output_ref.uri if build_output is not None else "",
        }
        if context.execution_mode == EXECUTION_MODE_PARITY:
            summary["executionMode"] = context.execution_mode
            if context.source_reference_fixture_id:
                summary["fixtureId"] = context.source_reference_fixture_id
            if context.trust_case_id:
                summary["trustCaseId"] = context.trust_case_id
            if context.source_reference_mode:
                summary["referenceMode"] = context.source_reference_mode
        return json.dumps(summary)
