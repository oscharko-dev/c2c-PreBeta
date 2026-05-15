"""Workflow orchestration for the first W0 Harness consumer."""

from __future__ import annotations

import datetime
import json
import threading
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import PurePosixPath
from typing import Any, Dict, Mapping, Optional, Sequence


def _iso_now() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")

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
    ArtifactMetadata,
    NullArtifactStore,
    RunArtifactStore,
)
from .config import OrchestratorConfig
from .experience import ExperienceLearningGateway, NullExperienceLearningGateway
from .harness import DataReference, HarnessFailure, HarnessGateway


class OrchestratorError(Exception):
    """Base class for orchestrator execution failures."""


class CapabilityMissingError(OrchestratorError):
    """Raised when a required capability is unavailable."""


class StepExecutionError(OrchestratorError):
    """Raised when a workflow step cannot be completed."""


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
    model_prompt: Optional[str] = None


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class WorkflowStepResult:
    capability_id: str
    step_name: str
    payload: Mapping[str, Any]
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
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    input_ref: Optional[Dict[str, Any]] = None
    output_ref: Optional[Dict[str, Any]] = None
    diagnostic: Optional[str] = None
    latency_ms: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
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
        self._index: Dict[str, int] = {}
        self._lock = threading.Lock()

    def upsert(
        self,
        name: str,
        *,
        capability_id: str,
        service: str,
        actor: str,
        status: str,
        started_at: Optional[str] = None,
        finished_at: Optional[str] = None,
        input_ref: Optional[Mapping[str, Any]] = None,
        output_ref: Optional[Mapping[str, Any]] = None,
        diagnostic: Optional[str] = None,
        latency_ms: Optional[int] = None,
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
                return record
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
            return name in self._index

    def to_payload(self) -> list[Dict[str, Any]]:
        with self._lock:
            return [record.to_dict() for record in self._steps]


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text_value = str(value).strip()
    return text_value or None


def _first_non_empty_text(*values: Any) -> Optional[str]:
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


def _normalize_input_ref(raw: Mapping[str, Any], run_id: str) -> DataReference:
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


def _extract_source(raw: Mapping[str, Any]) -> str:
    source = _first_non_empty_text(raw.get("source"), raw.get("sourceText"), raw.get("code"))
    if not source:
        raise OrchestratorError("inputRef must include source, sourceText, or code")
    return source


def _raw_source(raw: Mapping[str, Any]) -> Optional[str]:
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


def _as_reference_payload(ref: DataReference) -> Mapping[str, Any]:
    return {
        "uri": ref.uri,
        "sha256": ref.sha256,
        "byteSize": ref.byte_size,
        "byte_size": ref.byte_size,
    }


def _data_reference_from_mapping(raw: Any) -> Optional[DataReference]:
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


def _first_non_empty_mapping(value: Any) -> Dict[str, Any]:
    if isinstance(value, Mapping) and value:
        return dict(value)
    return {}


GENERATED_PROJECT_DIR = "generated-project"
GENERATED_PROJECT_MANIFEST_FILE = "generated-project-manifest.json"


def _build_generated_project_manifest(
    *,
    run_id: str,
    workflow_id: str,
    generated_project: Mapping[str, Any],
    persisted_files: Sequence[Mapping[str, Any]],
    program_id: Optional[str],
    ir_id: Optional[str],
    source_sha256: Optional[str],
) -> Dict[str, Any]:
    """Build the deterministic manifest describing the persisted Java project.

    The manifest pairs every persisted file with its on-disk sha256 and byte
    size, then sorts the entries by path so the canonical JSON encoding is
    stable. The orchestrator hashes this manifest to produce the single
    ``artifactRef`` referenced by `/generated`, build-test, and Evidence Pack,
    which is how Issue #97 guarantees those three consumers point at byte-for-
    byte identical generated Java.
    """
    files: list[Dict[str, Any]] = []
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


def _iter_generated_files(generated_project: Mapping[str, Any]):
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


def _failed_step_from_exception(exc: BaseException) -> Optional[str]:
    text = str(exc).lower()
    for marker in (
        ("parse-cobol", "parse-cobol"),
        ("generate-ir", "generate-ir"),
        ("generate-java", "generate-java"),
        ("compile-test-java", "compile-test-java"),
        ("model-guidance", "model-guidance"),
        ("write-evidence", "write-evidence"),
    ):
        if marker[0] in text:
            return marker[1]
    return None


def _build_cobol_oracle_payload(
    source_text: Optional[str],
    input_reference: DataReference,
    timeout_ms: int,
) -> Optional[Dict[str, Any]]:
    """Construct the executable COBOL oracle payload for build-test-runner.

    The oracle lets the runner execute the UI-provided COBOL source with
    GnuCOBOL and compare its stdout against generated Java stdout (Issue
    #92). Returns ``None`` when no source text is available, so the runner
    falls back to registry Golden Master behaviour.
    """
    if not source_text or not source_text.strip():
        return None
    safe_timeout = timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else DEFAULT_BUILD_TEST_ORACLE_TIMEOUT_MS
    return {
        "mode": ORACLE_MODE_COBOL_RUNTIME,
        "sourceText": source_text,
        "sourceRef": _as_reference_payload(input_reference),
        "timeoutMs": safe_timeout,
    }


def _coerce_output_ref(payload: Mapping[str, Any], fallback_uri: str, fallback_payload: Any) -> DataReference:
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
        artifact_store: Optional[RunArtifactStore] = None,
        experience_learning: Optional[Any] = None,
    ):
        self.config = config
        self.gateway = gateway
        self.artifact_store = artifact_store if artifact_store is not None else NullArtifactStore()
        # Issue #96: experience_learning is duck-typed against the
        # ExperienceLearningGateway protocol so a NullExperienceLearningGateway
        # can no-op when the service is unconfigured.
        self.experience_learning = experience_learning if experience_learning is not None else NullExperienceLearningGateway()
        self._step_lock = threading.Lock()
        self._step_id_by_run: Dict[str, int] = {}
        self._capability_cache: Dict[str, Dict[str, Any]] = {}
        self._progress_lock = threading.Lock()
        self._progress_by_run: Dict[str, RunProgressLog] = {}
        self._event_buffer_lock = threading.Lock()
        self._event_buffer_by_run: Dict[str, list[Dict[str, Any]]] = {}

    def run(self, context: W0RunContext, input_ref: Mapping[str, Any]) -> Dict[str, Any]:
        input_reference = _normalize_input_ref(input_ref, context.run_id)
        source_text = _extract_source(input_ref)
        raw_source_text = _raw_source(input_ref) or source_text
        evidence_refs: list[str] = list(context.evidence_refs)
        step_results: list[WorkflowStepResult] = []
        model_output = None
        program_id: Optional[str] = None
        completed_steps: list[str] = []
        artifact_refs: list[Dict[str, Any]] = []

        def _record_artifact(meta: Any) -> None:
            if meta is None:
                return
            try:
                payload = meta.to_dict()
            except AttributeError:
                return
            artifact_refs.append(payload)

        def _write_summary(status: str, *, message: str, failed_step: Optional[str] = None) -> None:
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
            self.gateway.update_run(
                context.run_id,
                "updating",
                updated_by=self.config.service_name,
                message="orchestrator workflow started",
                evidence_refs=evidence_refs,
                policy_decision=POLICY_ALLOW,
            )
            _write_summary("updating", message="orchestrator workflow started")

            parse_capability = self._require_capability(context.run_id, self.config.parse_capability_id)
            ir_capability = self._require_capability(context.run_id, self.config.ir_capability_id)
            generator_capability = self._require_capability(context.run_id, self.config.generator_capability_id)
            build_test_capability = self._require_capability(
                context.run_id,
                self.config.build_test_capability_id,
            )
            evidence_capability = self._require_capability(context.run_id, self.config.evidence_capability_id)

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
            generated_artifact_ref: Optional[Dict[str, Any]] = None
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

            if context.model_prompt:
                model_capability = self._require_capability(
                    context.run_id,
                    self.config.model_gateway_capability_id,
                )
                model_id = _text(getattr(self.config, "model_gateway_model_id", None)) or DEFAULT_MODEL_ID
                model_output_step = self._invoke_step(
                    context,
                    "model-guidance",
                    model_capability,
                    DATA_CLASS_MODEL,
                    {
                        "schemaVersion": "v0",
                        "runId": context.run_id,
                        "workflowId": context.workflow_id,
                        "actor": self.config.service_name,
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
                    },
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/model-input",
                        {
                            "modelPrompt": context.model_prompt,
                            "runId": context.run_id,
                            "workflowId": context.workflow_id,
                        },
                    ),
                )
                step_results.append(model_output_step)
                model_output = model_output_step.payload
                _record_artifact(
                    self.artifact_store.write_json(
                        context.run_id,
                        context.workflow_id,
                        "model-invocation-ledger.json",
                        dict(model_output),
                        kind=KIND_MODEL_INVOCATION_LEDGER,
                    )
                )
                completed_steps.append("model-guidance")
                _write_summary("updating", message="model-guidance completed")
            else:
                _record_artifact(
                    self.artifact_store.write_json(
                        context.run_id,
                        context.workflow_id,
                        "model-policy-skipped.json",
                        {
                            "runId": context.run_id,
                            "workflowId": context.workflow_id,
                            "modelId": _text(getattr(self.config, "model_gateway_model_id", None))
                            or DEFAULT_MODEL_ID,
                            "status": "skipped",
                            "reason": "no modelPrompt provided by requester",
                            "createdBy": self.config.service_name,
                            "createdAt": _iso_now(),
                        },
                        kind=KIND_MODEL_POLICY_SKIPPED,
                    )
                )
                # Issue #96: surface the policy skip as a discrete step so the
                # UI/EL timeline can distinguish it from `model-guidance`
                # actually running.
                self._record_marker_step(
                    context,
                    name=STEP_MODEL_POLICY_SKIPPED,
                    status=STEP_STATUS_SKIPPED,
                    run_status="updating",
                    diagnostic="no modelPrompt provided by requester",
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
                trajectory_payload=trajectory_payload,
                generated_artifact_ref=generated_artifact_ref,
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
            self.gateway.update_run(
                context.run_id,
                "completed",
                updated_by=self.config.service_name,
                message="W0 migration workflow completed",
                evidence_refs=evidence_refs,
                policy_decision=POLICY_ALLOW,
            )
            _write_summary("completed", message="W0 migration workflow completed")
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
            }
        except Exception as exc:
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
            try:
                self._record_marker_step(
                    context,
                    name=STEP_FAILED,
                    status=STEP_STATUS_FAILED,
                    run_status="failed",
                    diagnostic=failure_message,
                    failed_step=failed_step,
                )
            except Exception:
                pass
            try:
                self.gateway.update_run(
                    context.run_id,
                    "failed",
                    updated_by=self.config.service_name,
                    message=failure_message,
                    evidence_refs=evidence_refs,
                    policy_decision=POLICY_ALLOW,
                )
            except Exception:
                pass
            try:
                _write_summary("failed", message=failure_message, failed_step=failed_step)
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

    def _fetch_trajectory_ledger(self, run_id: str) -> Mapping[str, Any]:
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
        build_test_output: WorkflowStepResult,
        model_output: Optional[Mapping[str, Any]],
        trajectory_payload: Mapping[str, Any],
        generated_artifact_ref: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        trajectory_ref = _build_reference(
            f"urn:orchestrator/{context.run_id}/trajectory",
            trajectory_payload,
        )
        model_invocation = self._build_model_invocation_ref(context, model_output)
        if generated_artifact_ref:
            generated_java_payload: Mapping[str, Any] = {
                "uri": str(generated_artifact_ref.get("uri") or ""),
                "sha256": str(generated_artifact_ref.get("sha256") or ""),
                "byteSize": int(generated_artifact_ref.get("byteSize") or 0),
                "kind": str(generated_artifact_ref.get("kind") or KIND_GENERATED_PROJECT_MANIFEST),
            }
        else:
            generated_java_payload = _as_reference_payload(generator_output.output_ref)
        artifacts = {
            "sourceCobol": [_as_reference_payload(input_ref)],
            "semanticIr": _as_reference_payload(_coerce_output_ref(ir_output.payload, generator_output.output_ref.uri, ir_output.payload)),
            "generatedJava": generated_java_payload,
            "buildTestResults": [_as_reference_payload(build_test_output.output_ref)],
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
            artifacts["experienceLearningSummary"] = {
                **_as_reference_payload(learning_ref),
                "endpoint": learning_uri,
            }

        return {
            "runId": context.run_id,
            "workflowId": context.workflow_id,
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

    # noinspection PyTypeHints
    def _build_model_invocation_ref(self, context: W0RunContext, model_output: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
        configured_model_id = _text(getattr(self.config, "model_gateway_model_id", None)) or DEFAULT_MODEL_ID
        if model_output is None:
            payload = {
                "runId": context.run_id,
                "modelId": configured_model_id,
                "status": "skipped",
                "actor": self.config.service_name,
            }
            return {
                "invocationId": f"inv-{context.run_id}-00",
                "modelId": configured_model_id,
                "provider": "orchestrator",
                "promptTemplateVersion": DEFAULT_PROMPT_TEMPLATE_VERSION,
                "status": "skipped",
                "ledgerRef": _as_reference_payload(
                    _build_reference(
                        f"urn:orchestrator/{context.run_id}/model-invocation",
                        payload,
                    )
                ),
            }

        payload = dict(model_output)
        invocation_id = _text(payload.get("invocationId")) or f"inv-{context.run_id}-00"
        model_id = _text(payload.get("modelId")) or DEFAULT_MODEL_ID
        provider = _text(payload.get("provider"))
        template = _text(payload.get("promptTemplateVersion")) or DEFAULT_PROMPT_TEMPLATE_VERSION
        status = _text(payload.get("status")) or "completed"
        ledger_ref = _data_reference_from_mapping(payload.get("ledgerRef"))
        if ledger_ref is None:
            ledger_payload = {
                "invocationId": invocation_id,
                "modelId": model_id,
                "provider": provider,
                "promptTemplateVersion": template,
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
            "status": status,
            "ledgerRef": _as_reference_payload(ledger_ref),
        }

    @staticmethod
    def _resolve_program_id(*payloads: Mapping[str, Any]) -> str:
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
        capability: Dict[str, Any],
        data_class: str,
        payload: Mapping[str, Any],
        input_ref: DataReference,
    ) -> WorkflowStepResult:
        capability_id = str(capability.get("id", "")).strip()
        actor = str(capability.get("owner", self.config.service_name)).strip()
        endpoint = str(capability.get("endpoint", "")).strip()
        if not capability_id:
            raise CapabilityMissingError(f"{step_name} capability id is invalid")
        if not endpoint:
            raise CapabilityMissingError(f"{step_name} capability endpoint is missing")

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
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc

        raise StepExecutionError(f"step {step_name} retry loop exited without resolution")

    @staticmethod
    def _event_input_payload(data_class: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
        event_payload = dict(payload)
        if data_class != DATA_CLASS_MODEL:
            return event_payload
        if "prompt" in event_payload:
            event_payload.pop("prompt", None)
            event_payload["promptRedacted"] = True
        return event_payload

    @staticmethod
    def _coerce_step_output_ref(output_payload: Mapping[str, Any], step_name: str, run_id: str) -> DataReference:
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

    def _require_capability(self, run_id: str, capability_id: str) -> Dict[str, Any]:
        if not capability_id:
            raise CapabilityMissingError("capability id is required")
        cached = self._capability_cache.get(capability_id)
        if cached is not None:
            return cached
        try:
            capability = self.gateway.get_capability(capability_id)
        except Exception as exc:
            raise CapabilityMissingError(f"required capability {capability_id} unavailable") from exc
        capability_name = capability.get("id")
        if not isinstance(capability_name, str) or not capability_name.strip():
            raise CapabilityMissingError(f"invalid capability payload for {capability_id}")
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
        input_payload: Mapping[str, Any],
        output_payload: Mapping[str, Any],
        input_ref: DataReference,
        output_ref: DataReference,
        policy_decision: str = POLICY_ALLOW,
        latency_ms: Optional[int] = None,
    ) -> None:
        step_id = self._next_step_id(run_id)
        event: Dict[str, Any] = {
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

    def _buffer_event_for_learning(self, run_id: str, event: Mapping[str, Any]) -> None:
        with self._event_buffer_lock:
            buffer = self._event_buffer_by_run.setdefault(run_id, [])
            buffer.append(dict(event))

    def _drain_event_buffer(self, run_id: str) -> list[Dict[str, Any]]:
        with self._event_buffer_lock:
            buffer = self._event_buffer_by_run.pop(run_id, [])
        return buffer

    def _flush_to_experience_learning(
        self,
        run_id: str,
        trajectory_payload: Optional[Mapping[str, Any]] = None,
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

    def progress_payload(self, run_id: str) -> list[Dict[str, Any]]:
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
        current_step: Optional[str],
        run_status: str,
        failed_step: Optional[str] = None,
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
        input_ref: Optional[DataReference],
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
        input_ref: Optional[DataReference] = None,
        output_ref: Optional[DataReference] = None,
        diagnostic: Optional[str] = None,
        latency_ms: Optional[int] = None,
        run_status: str = "updating",
        failed_step: Optional[str] = None,
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
        diagnostic: Optional[str] = None,
        failed_step: Optional[str] = None,
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
        build_output: WorkflowStepResult,
    ) -> Mapping[str, Any]:
        return {
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "requester": context.requester,
            "capturedAt": int(time.time()),
            "parseRef": parse_output.output_ref.uri,
            "irRef": ir_output.output_ref.uri,
            "javaRef": generator_output.output_ref.uri,
            "buildRef": build_output.output_ref.uri,
        }
