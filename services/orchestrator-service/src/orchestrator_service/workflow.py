"""Workflow orchestration for the first W0 Harness consumer."""

from __future__ import annotations

import datetime
import json
import threading
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import PurePosixPath
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
    ArtifactMetadata,
    JsonObject,
    JsonValue,
    NullArtifactStore,
    RunArtifactStore,
)
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
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_MODEL_GATEWAY_UNAVAILABLE,
    FAILURE_MODEL_POLICY_DENIED,
    IllegalTransitionError,
    RepairBudgetExhaustedError,
    STEP_COMPILE_TEST_JAVA as W02_STEP_COMPILE_TEST_JAVA,
    STEP_FINALIZE as W02_STEP_FINALIZE,
    STEP_GENERATE_IR as W02_STEP_GENERATE_IR,
    STEP_GENERATE_JAVA as W02_STEP_GENERATE_JAVA,
    STEP_NORMALIZE_SOURCE as W02_STEP_NORMALIZE_SOURCE,
    STEP_PARSE_COBOL as W02_STEP_PARSE_COBOL,
    STEP_TRANSFORMATION_AGENT as W02_STEP_TRANSFORMATION_AGENT,
    STEP_VERIFICATION_REPAIR_AGENT as W02_STEP_VERIFICATION_REPAIR_AGENT,
    STEP_WRITE_EVIDENCE as W02_STEP_WRITE_EVIDENCE,
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


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class W0RunContext:
    run_id: str
    workflow_id: str
    requester: str
    evidence_refs: Sequence[str]
    model_prompt: str | None = None
    # Issue #169: when ``True``, the orchestrator invokes the productive
    # Transformation Agent after the deterministic baseline succeeds, uses
    # the agent's Java candidate as the artifact fed into build/test, and
    # records the agent attempt in the W0.2 contract. When ``False`` (the
    # default) the orchestrator preserves the W0/W0.2 deterministic-only
    # path.
    use_transformation_agent: bool = False


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
STEP_MODEL_GUIDANCE = "model-guidance"
STEP_MODEL_POLICY_SKIPPED = "model-policy-skipped"
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


GENERATED_PROJECT_DIR = "generated-project"
GENERATED_PROJECT_MANIFEST_FILE = "generated-project-manifest.json"


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


def _build_cobol_oracle_payload(
    source_text: str | None,
    input_reference: DataReference,
    timeout_ms: int,
    *,
    expected_output: str | None = None,
    oracle_input: str | None = None,
) -> JsonObject | None:
    """Construct the executable COBOL oracle payload for build-test-runner.

    The oracle lets the runner execute the UI-provided COBOL source with
    GnuCOBOL and compare its stdout against generated Java stdout (Issue
    #92). Returns ``None`` when no source text is available, so the runner
    falls back to registry Golden Master behaviour.

    Issue #172: when the BFF forwards an ``expectedOutput`` (golden master
    text) or an ``oracleInput`` (stdin fed to the oracle) on the inputRef,
    they are attached to the oracle payload so the build/test runner and
    the verification/repair agent can use them directly instead of
    re-deriving from defaults.
    """
    if not source_text or not source_text.strip():
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
        )
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
        semantic_ir: Mapping[str, JsonValue] | None,
        semantic_ir_ref: Mapping[str, JsonValue] | None,
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
        return STEP_TO_FAILURE_CODE.get(step_name)

    def _capability_failure_context(self, capability_id: str) -> tuple[str | None, str]:
        step_by_capability = {
            self.config.parse_capability_id: STEP_PARSE_COBOL,
            self.config.ir_capability_id: STEP_GENERATE_IR,
            self.config.generator_capability_id: STEP_GENERATE_JAVA,
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
            step_failure_code = W0WorkflowRunner._failure_code_for_step_name(failed_step)
            if step_failure_code is not None:
                return step_failure_code
        failed_step = _failed_step_from_exception(exc)
        if failed_step is not None:
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
        evidence_refs: list[str] = list(context.evidence_refs)
        step_results: list[WorkflowStepResult] = []
        model_output = None
        model_policy_skipped_meta: ArtifactMetadata | None = None
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
            baseline_artifact_ref: JsonObject | None = generated_artifact_ref
            baseline_generated_project: Mapping[str, JsonValue] | None = generated_project
            agent_result: TransformationAgentResult | None = None

            # Issue #169: when the requester opted into the productive
            # Transformation Agent, invoke it after the deterministic
            # baseline. On success its Java candidate becomes the artifact
            # fed into build/test; the baseline is preserved as a traceable
            # artifact and as a fallback reference in the run contract.
            if context.use_transformation_agent:
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
                    generated_project = {
                        "entryClass": agent_result.candidate.entry_class,
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
            build_test_output: WorkflowStepResult | None = None
            success = False
            build_failure_code: str | None = w02_failure_code
            build_test_input: JsonObject = {}
            if w02_blocked:
                pass
            else:
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
                oracle_payload = _build_cobol_oracle_payload(
                    raw_source_text,
                    input_reference,
                    getattr(self.config, "build_test_oracle_timeout_ms", DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS),
                    expected_output=oracle_metadata["expectedOutput"],
                    oracle_input=oracle_metadata["oracleInput"],
                )
                if oracle_payload is not None:
                    build_test_input["oracle"] = oracle_payload

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
            while build_test_output is not None and not success:
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
                try:
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
                        semantic_ir=ir_document,
                        semantic_ir_ref=_as_reference_payload(ir_output.output_ref),
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
                    w02_contract.record_repair_attempt(
                        {
                            "attemptNumber": attempt,
                            "repairDecision": "refuse",
                            "failureCategory": build_failure_code,
                            "rationale": str(repair_exc),
                            "buildTestResultRef": build_test_result_ref_payload,
                            "modelInvocationRef": {
                                "invocationId": (
                                    f"inv-{context.run_id}-{attempt:02d}-repair-failed"
                                ),
                            },
                        }
                    )
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
                # attempt's previousRepairDecisionRefs array.
                previous_repair_decision_refs.append(
                    dict(repair_result.repair_decision_artifact_ref)
                )
                # Record the trajectory entry for this attempt regardless
                # of outcome — every attempt must be visible in the run
                # contract for Experience Learning.
                w02_contract.record_repair_attempt(
                    {
                        "attemptNumber": attempt,
                        "repairDecision": repair_result.decision,
                        "failureCategory": build_failure_code,
                        "refusalCode": repair_result.refusal_code,
                        "escalationCode": repair_result.escalation_code,
                        "rationale": repair_result.rationale,
                        "modelInvocationRef": dict(repair_result.model_invocation_ref),
                        "repairInputRef": dict(repair_result.repair_input_artifact_ref),
                        "repairDecisionRef": dict(
                            repair_result.repair_decision_artifact_ref
                        ),
                        "buildTestResultRef": build_test_result_ref_payload,
                        "javaCandidateRef": (
                            dict(repair_result.new_java_candidate_ref)
                            if repair_result.new_java_candidate_ref
                            else None
                        ),
                    }
                )
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
                success, build_failure_code = build_test_outcome(build_test_output.payload)

            if success:
                self._advance_w02(
                    context,
                    w02_contract,
                    STATE_FINAL_JAVA_SELECTED,
                    active_step=W02_STEP_WRITE_EVIDENCE,
                    message="build-test verified java candidate",
                )

            if context.model_prompt and not w02_blocked:
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

            evidence_payload = self._build_evidence_payload(
                context=context,
                input_ref=input_reference,
                parse_output=parse_output,
                ir_output=ir_output,
                generator_output=generator_output,
                build_test_output=build_test_output,
                model_output=model_output,
                model_policy_skipped_meta=model_policy_skipped_meta,
                trajectory_payload=trajectory_payload,
                generated_artifact_ref=generated_artifact_ref,
                w02_contract=w02_contract,
                w02_blocked=w02_blocked,
                baseline_generated_artifact_ref=baseline_artifact_ref,
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
            _record_artifact(
                self.artifact_store.write_json(
                    context.run_id,
                    context.workflow_id,
                    "evidence-pack-manifest.json",
                    dict(evidence_output.payload),
                    kind=KIND_EVIDENCE_PACK_MANIFEST,
                )
            )
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

            if w02_blocked:
                final_classification = CLASSIFICATION_BLOCKED if w02_failure_code != FAILURE_EVIDENCE_INCOMPLETE else (
                    CLASSIFICATION_INCOMPLETE
                )
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

    # noinspection PyTypeHints
    def _build_evidence_payload(
        self,
        *,
        context: W0RunContext,
        input_ref: DataReference,
        parse_output: WorkflowStepResult,
        ir_output: WorkflowStepResult,
        generator_output: WorkflowStepResult,
        build_test_output: WorkflowStepResult | None,
        model_output: Mapping[str, JsonValue] | None,
        model_policy_skipped_meta: ArtifactMetadata | None,
        trajectory_payload: Mapping[str, JsonValue],
        generated_artifact_ref: Mapping[str, JsonValue] | None = None,
        w02_contract: W02RunContract | None = None,
        w02_blocked: bool = False,
        baseline_generated_artifact_ref: Mapping[str, JsonValue] | None = None,
    ) -> JsonObject:
        trajectory_ref = _build_reference(
            f"urn:orchestrator/{context.run_id}/trajectory",
            trajectory_payload,
        )
        model_invocation = self._build_model_invocation_ref(
            context,
            model_output,
            model_policy_skipped_meta=model_policy_skipped_meta,
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
            "generatedJava": generated_java_payload,
            "buildTestResults": build_test_refs,
            "harnessEvents": _as_reference_payload(trajectory_ref),
            "modelInvocations": [model_invocation],
            "trajectoryLedger": _as_reference_payload(trajectory_ref),
        }
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
        is_w02 = bool(
            getattr(context, "use_transformation_agent", False)
            or (w02_contract is not None and (
                getattr(w02_contract, "agent_attempt_count", 0) > 0
                or getattr(w02_contract, "repair_attempts", None)
            ))
        )

        wave = "w0.2" if is_w02 else "w0"
        if is_w02:
            (
                generated_java_artifacts,
                final_java_artifact,
                repair_attempts_payload,
            ) = self._build_w02_java_history(
                w02_contract=w02_contract,
                baseline_artifact_ref=baseline_generated_artifact_ref or generated_artifact_ref,
                final_artifact_ref=generated_artifact_ref,
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

        # Attempt 0 is the deterministic baseline OR the productive
        # transformation agent's candidate. If we have an explicit baseline
        # ref, use it; otherwise fall back to the generator step's output.
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
                if candidate_entry is not None and decision == "propose_candidate":
                    attempt_payload["newJavaCandidateRef"] = dict(candidate_entry)
                if refusal:
                    attempt_payload["refusalCode"] = str(refusal)
                if decision == "no_change":
                    attempt_payload["noChange"] = True
                repair_attempts.append(attempt_payload)
            if not repair_attempts_have_required_refs:
                repair_attempts = []

        # Mark the selected candidate inside history (if it matches).
        selected_entry: JsonObject | None = None
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
        comparison = payload.get("comparison") or {}
        oracle = payload.get("oracleComparison") or {}
        golden = payload.get("goldenMaster") or {}

        matched = comparison.get("matched")
        if matched is None:
            matched = oracle.get("matched")
        if matched is None:
            classification = str(payload.get("classification") or "")
            matched = classification == "match"

        expected_sha = (
            comparison.get("expectedSha256")
            or oracle.get("expectedSha256")
            or ""
        )
        actual_sha = (
            comparison.get("actualSha256")
            or oracle.get("actualSha256")
            or ""
        )
        status = str(payload.get("status") or "")
        if status == "missing-golden-master":
            oracle_kind = "absent"
        elif golden.get("classification") == "true":
            oracle_kind = "true-golden-master"
        elif golden.get("classification") == "synthetic":
            oracle_kind = "synthetic"
        elif (golden.get("cobolRuntime") or {}).get("attempted"):
            oracle_kind = "cobol-runtime"
        else:
            oracle_kind = "synthetic"

        envelope: JsonObject = {
            "matched": bool(matched),
            "oracleKind": oracle_kind,
            "buildTestResultRef": _as_reference_payload(build_test_output.output_ref),
            "classification": str(payload.get("classification") or ""),
        }
        if expected_sha:
            envelope["expectedSha256"] = str(expected_sha)
        if actual_sha:
            envelope["actualSha256"] = str(actual_sha)
        summary = str(payload.get("summary") or "")
        if summary:
            envelope["summary"] = summary
        return envelope

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
                "input": dict(input_payload),
                "output": dict(output_payload),
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
        return json.dumps({
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "requester": context.requester,
            "capturedAt": int(time.time()),
            "parseRef": parse_output.output_ref.uri,
            "irRef": ir_output.output_ref.uri,
            "javaRef": generator_output.output_ref.uri,
            "buildRef": build_output.output_ref.uri if build_output is not None else "",
        })
