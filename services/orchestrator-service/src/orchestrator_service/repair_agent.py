"""Productive Verification/Repair Agent adapter (Issue #170).

The Verification/Repair Agent is the second productive AI capability the
W0.2 Orchestrator can invoke. After the deterministic build/test gate
fails on a generated Java candidate, the Orchestrator hands the failure
context to the agent, which inspects the prior candidate, the structured
build/test result, and the COBOL source, and emits one of three outcomes:

* ``propose_candidate``  — a corrected Java candidate the Orchestrator can
  re-run through the build/test gate.
* ``refuse``             — the agent cannot safely repair this failure;
  the run terminates as blocked with a precise refusal code.
* ``escalate``           — the failure is out of scope for the agent;
  the run terminates with an escalation code so the operator can route
  the case to human review or capability expansion.

Hard rules enforced by this module:

* The agent only reaches the model through the Model Gateway abstraction
  handed to it at construction time. It does not import any provider SDK
  or open raw HTTP connections.
* Every model call is policy-controlled. ``agentRole`` is stamped on the
  Model Gateway request as ``"verification-repair"`` so the gateway
  role-to-model policy from Issue #168 applies.
* Both the input the Orchestrator hands to the agent and the decision
  the agent returns are validated against the W0.2 agent-repair I/O
  contracts from Issue #167 (``agent-repair-input-v0`` /
  ``agent-repair-decision-v0``).
* Every Java candidate the agent proposes is persisted to the run
  artifact store as a real artifact. The persisted manifest — not the
  inline file map — is what ``newJavaCandidateRef`` on the decision
  references, so downstream consumers (build/test, Evidence Pack) point
  at byte-identical content.
* No-change repairs are detected at the agent boundary: if the proposed
  candidate hashes byte-for-byte to the previous candidate, the agent
  returns ``no_change`` so the Orchestrator can break out of the loop
  rather than burning the rest of the budget on identical attempts.
* Invalid model output (non-Java content, missing class metadata, malformed
  envelope, oversized output, refuse without ``refusalCode``, etc.) is
  rejected as ``agent_contract_invalid`` and the failure is persisted as
  a synthetic decision artifact so the run timeline is complete.
* The agent does not perform verification. It does not claim behavioural
  correctness. The build/test runner is the authority; the Orchestrator
  re-invokes it on the proposed candidate.
"""

from __future__ import annotations

import datetime
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any

from .agent_contracts import (
    AgentContractInvalidError,
    assert_no_secret_leak,
    guard_repair_decision,
    validate_repair_input,
)
from .artifacts import (
    KIND_REPAIR_AGENT_DECISION,
    KIND_REPAIR_AGENT_INPUT,
    KIND_REPAIR_AGENT_JAVA_FILE,
    KIND_REPAIR_AGENT_PROJECT_MANIFEST,
    MIME_JAVA,
    ArtifactMetadata,
    JsonObject,
    JsonValue,
    RunArtifactStore,
)
from .config import OrchestratorConfig
from .harness import HarnessFailure
# noinspection PyProtectedMemberInspection
from .transformation_agent import (
    AgentContractInvalidAgentError,
    GeneratedJavaCandidate,
    HarnessEventSink,
    ModelGatewayInvoker,
    _canonical_json_bytes,
    _classify_gateway_failure,
    _coerce_artifact_ref,
    _decode_candidate,
    _iso_now,
    _looks_like_artifact_ref,
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class RepairAgentError(Exception):
    """Base class for Verification/Repair Agent failures.

    Carries a canonical W0.2 failure code so the Orchestrator can route the
    resulting run contract without re-classifying the error string.
    """

    failure_code: str = "java_generation_failed"

    def __init__(
        self,
        message: str,
        *,
        failure_code: str | None = None,
        model_invocation_ref: Mapping[str, JsonValue] | None = None,
        repair_input_artifact_ref: Mapping[str, JsonValue] | None = None,
        repair_decision_artifact_ref: Mapping[str, JsonValue] | None = None,
    ) -> None:
        super().__init__(message)
        if failure_code is not None:
            self.failure_code = failure_code
        self.model_invocation_ref = (
            dict(model_invocation_ref) if isinstance(model_invocation_ref, Mapping) else None
        )
        self.repair_input_artifact_ref = (
            dict(repair_input_artifact_ref)
            if isinstance(repair_input_artifact_ref, Mapping)
            else None
        )
        self.repair_decision_artifact_ref = (
            dict(repair_decision_artifact_ref)
            if isinstance(repair_decision_artifact_ref, Mapping)
            else None
        )


class RepairAgentContractInvalidError(RepairAgentError):
    """Raised when the agent's decision (or its inner Java candidate) does
    not satisfy the W0.2 agent-repair contracts."""

    failure_code = "agent_contract_invalid"


class RepairAgentGatewayUnavailableError(RepairAgentError):
    """Raised when the Model Gateway is unreachable or returns a 5xx error
    that is not a policy denial."""

    failure_code = "model_gateway_unavailable"


class RepairAgentPolicyDeniedError(RepairAgentError):
    """Raised when the Model Gateway rejects the invocation on policy
    grounds (e.g. ``forbidden_role``)."""

    failure_code = "model_policy_denied"


class RepairAgentTimeoutError(RepairAgentError):
    """Raised when the model gateway call exceeds the configured deadline."""

    failure_code = "agent_timeout"


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


REPAIR_AGENT_ROLE = "verification-repair-agent"
DATA_CLASS_GENERATOR = "generator"
DATA_CLASS_MODEL_GATEWAY = "model-gateway"
MODEL_GATEWAY_AGENT_ROLE = "verification-repair"
REPAIR_AGENT_DIR = "repair-agent"

VALID_FAILURE_CATEGORIES: tuple[str, ...] = (
    "java_compile_failed",
    "java_runtime_failed",
    "oracle_mismatch",
)

VALID_REFUSAL_CODES: tuple[str, ...] = (
    "no_safe_repair",
    "unsupported_construct",
    "policy_denied",
    "insufficient_context",
)

VALID_ESCALATION_CODES: tuple[str, ...] = (
    "needs_human_review",
    "needs_capability_expansion",
    "out_of_scope_for_w0_2",
)

DECISION_PROPOSE = "propose_candidate"
DECISION_REFUSE = "refuse"
DECISION_ESCALATE = "escalate"
DECISION_NO_CHANGE = "no_change"

# Mapping from refusal codes to the canonical W0.2 failure code the
# Orchestrator should record on the run contract when the agent refuses.
REFUSAL_TO_FAILURE_CODE: dict[str, str] = {
    "no_safe_repair": "java_generation_failed",
    "unsupported_construct": "unsupported_cobol",
    "policy_denied": "model_policy_denied",
    "insufficient_context": "java_generation_failed",
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class RepairAgentRequest:
    """Structured input to :meth:`RepairAgent.invoke`.

    The Orchestrator builds this dataclass after the build/test gate has
    rejected the previous candidate. Every reference is content-addressed
    so the agent's decision can be replayed against the same evidence.
    """

    run_id: str
    workflow_id: str
    attempt_number: int
    requester: str
    previous_java_candidate_ref: Mapping[str, JsonValue]
    previous_java_files: Mapping[str, str]
    build_test_result_ref: Mapping[str, JsonValue]
    build_test_payload: Mapping[str, JsonValue]
    failure_category: str
    capability_id: str
    capability_version: str
    capability_provider: str
    capability_resolved_at: str
    model_id: str
    policy_version: str
    repair_budget_remaining: int
    compile_error_ref: Mapping[str, JsonValue] | None = None
    runtime_error_ref: Mapping[str, JsonValue] | None = None
    oracle_diff_ref: Mapping[str, JsonValue] | None = None
    source_cobol_ref: Mapping[str, JsonValue] | None = None
    source_text: str | None = None
    oracle_payload: Mapping[str, JsonValue] | None = None
    semantic_ir_ref: Mapping[str, JsonValue] | None = None
    semantic_ir: Mapping[str, JsonValue] | None = None
    previous_repair_decision_refs: tuple[Mapping[str, JsonValue], ...] = ()
    deadline_ms: int = 60000
    trace_ref: str | None = None

    def __post_init__(self) -> None:
        if not self.run_id:
            raise ValueError("run_id is required")
        if not self.workflow_id:
            raise ValueError("workflow_id is required")
        if self.attempt_number < 1:
            raise ValueError("attempt_number must be >= 1")
        if self.failure_category not in VALID_FAILURE_CATEGORIES:
            raise ValueError(
                f"failure_category must be one of {VALID_FAILURE_CATEGORIES}, "
                f"got {self.failure_category!r}"
            )
        if not _looks_like_artifact_ref(self.previous_java_candidate_ref):
            raise ValueError("previous_java_candidate_ref must be an artifact ref")
        if not _looks_like_artifact_ref(self.build_test_result_ref):
            raise ValueError("build_test_result_ref must be an artifact ref")
        if not isinstance(self.previous_java_files, Mapping):
            raise ValueError("previous_java_files must be a mapping")
        if not self.capability_id:
            raise ValueError("capability_id is required")
        if not self.model_id:
            raise ValueError("model_id is required")
        if self.deadline_ms <= 0:
            raise ValueError("deadline_ms must be positive")
        if self.repair_budget_remaining < 0:
            raise ValueError("repair_budget_remaining must be non-negative")


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class RepairedJavaCandidate:
    """Decoded Java candidate the agent proposes as a repair.

    Mirrors :class:`GeneratedJavaCandidate` from ``transformation_agent.py``.
    Kept as a separate class so callers can identify the source by type.
    """

    files: dict[str, str]
    entry_class: str
    entry_package: str
    entry_file_path: str
    unsupported_constructs: tuple[str, ...]
    explanation: str

    def to_manifest(self) -> JsonObject:
        manifest_files: list[JsonObject] = []
        for path, content in sorted(self.files.items()):
            encoded = content.encode("utf-8")
            manifest_files.append(
                {
                    "path": path,
                    "sha256": sha256(encoded).hexdigest(),
                    "byteSize": len(encoded),
                    "mimeType": MIME_JAVA,
                }
            )
        return {
            "entryClass": self.entry_class,
            "entryPackage": self.entry_package,
            "entryFilePath": self.entry_file_path,
            "fileCount": len(manifest_files),
            "files": manifest_files,
            "unsupportedConstructs": list(self.unsupported_constructs),
        }


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class RepairAgentResult:
    """Outcome the Orchestrator consumes after a repair-agent invocation.

    The decision is one of ``propose_candidate``, ``refuse``, ``escalate``,
    or ``no_change``. ``no_change`` is a synthetic outcome added by the
    Orchestrator-side adapter when the agent proposed a candidate whose
    canonical content equals the previous candidate's; in that case the
    Orchestrator must terminate the loop rather than burn the rest of the
    repair budget on identical attempts.
    """

    decision: str
    candidate: RepairedJavaCandidate | None
    refusal_code: str | None
    escalation_code: str | None
    rationale: str
    confidence: float | None
    failure_code: str | None
    failure_message: str | None
    model_invocation_ref: JsonObject
    new_java_candidate_ref: JsonObject | None
    diff_from_previous_ref: JsonObject | None
    repair_input_payload: JsonObject
    repair_decision_payload: JsonObject
    repair_input_artifact_ref: JsonObject
    repair_decision_artifact_ref: JsonObject
    persisted_artifacts: list[JsonObject] = field(default_factory=list)

    @property
    def proposed_candidate(self) -> bool:
        return self.decision == DECISION_PROPOSE

    @property
    def is_refusal(self) -> bool:
        return self.decision == DECISION_REFUSE

    @property
    def is_escalation(self) -> bool:
        return self.decision == DECISION_ESCALATE

    @property
    def is_no_change(self) -> bool:
        return self.decision == DECISION_NO_CHANGE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _meta_to_ref(meta: ArtifactMetadata) -> JsonObject:
    return {
        "uri": meta.uri,
        "sha256": meta.sha256,
        "byteSize": meta.byteSize,
        "mimeType": meta.mimeType,
        "kind": meta.kind,
    }


def _attempt_dir(attempt_number: int) -> str:
    return f"{REPAIR_AGENT_DIR}/attempt-{attempt_number:02d}"


def _files_canonical_sha256(files: Mapping[str, str]) -> str:
    """Return a stable sha256 over the path/content map.

    The hash is computed from a canonical JSON encoding of the sorted file
    map so two candidates with the same files in different iteration order
    hash identically. This is the basis for no-change detection.
    """
    canonical = {"files": {str(k): str(v) for k, v in sorted(files.items())}}
    return sha256(_canonical_json_bytes(canonical)).hexdigest()


# ---------------------------------------------------------------------------
# Inner-envelope decoding
# ---------------------------------------------------------------------------


def _parse_model_output_envelope(raw_output: Any) -> Mapping[str, JsonValue]:
    """Extract the repair-agent decision JSON object from the model output.

    Mirrors the transformation agent's helper. The Model Gateway returns
    ``output`` either as a JSON object (when ``structuredOutput=true``) or
    as a string carrying JSON. Anything else fails validation.
    """
    if isinstance(raw_output, Mapping):
        return raw_output
    if isinstance(raw_output, str):
        text = raw_output.strip()
        if not text:
            raise RepairAgentContractInvalidError(
                "model output is empty; expected structured JSON"
            )
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RepairAgentContractInvalidError(
                f"model output is not valid JSON: {exc}"
            ) from exc
        if not isinstance(parsed, Mapping):
            raise RepairAgentContractInvalidError(
                "model output JSON must be an object"
            )
        return parsed
    raise RepairAgentContractInvalidError(
        f"model output has unexpected type: {type(raw_output).__name__}"
    )


def _validate_inner_decision(value: Any) -> str:
    if not isinstance(value, str):
        raise RepairAgentContractInvalidError("inner decision must be a string")
    if value not in {DECISION_PROPOSE, DECISION_REFUSE, DECISION_ESCALATE}:
        raise RepairAgentContractInvalidError(
            f"inner decision must be one of "
            f"'propose_candidate'/'refuse'/'escalate', got {value!r}"
        )
    return value


def _validate_refusal_code(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RepairAgentContractInvalidError(
            "refuse decision requires a non-empty refusalCode"
        )
    if value not in VALID_REFUSAL_CODES:
        raise RepairAgentContractInvalidError(
            f"refusalCode must be one of {VALID_REFUSAL_CODES}, got {value!r}"
        )
    return value


def _validate_escalation_code(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RepairAgentContractInvalidError(
            "escalate decision requires a non-empty escalationCode"
        )
    if value not in VALID_ESCALATION_CODES:
        raise RepairAgentContractInvalidError(
            f"escalationCode must be one of {VALID_ESCALATION_CODES}, got {value!r}"
        )
    return value


def _coerce_confidence(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise RepairAgentContractInvalidError("confidence must be numeric, not boolean")
    if not isinstance(value, (int, float)):
        raise RepairAgentContractInvalidError("confidence must be a number")
    coerced = float(value)
    if coerced < 0.0 or coerced > 1.0:
        raise RepairAgentContractInvalidError(
            f"confidence must be in [0, 1], got {coerced}"
        )
    return coerced


def _model_invocation_ref_from_gateway(
    request: RepairAgentRequest,
    gateway_response: Mapping[str, JsonValue],
) -> JsonObject:
    invocation_id = str(gateway_response.get("invocationId") or "").strip()
    if not invocation_id:
        raise RepairAgentContractInvalidError(
            "model gateway response missing invocationId; cannot build modelInvocationRef"
        )
    ledger_ref_raw = gateway_response.get("ledgerRef")
    if not isinstance(ledger_ref_raw, Mapping) or not _looks_like_artifact_ref(ledger_ref_raw):
        raise RepairAgentContractInvalidError(
            "model gateway response missing ledgerRef; cannot reference model invocation ledger"
        )
    provider_raw = str(gateway_response.get("provider") or "foundry-development")
    provider = (
        provider_raw
        if provider_raw in {"foundry-development", "customer-internal-mock"}
        else "foundry-development"
    )
    model_invocation_ref: JsonObject = {
        "invocationId": invocation_id,
        "modelId": str(gateway_response.get("modelId") or request.model_id),
        "provider": provider,
        "ledgerRef": _coerce_artifact_ref(ledger_ref_raw),
        "agentRole": MODEL_GATEWAY_AGENT_ROLE,
    }
    for key in (
        "promptTemplateVersion",
        "policyDecision",
        "status",
        "policyVersion",
        "policyId",
        "promptTemplateId",
    ):
        value = gateway_response.get(key)
        if isinstance(value, str) and value.strip():
            model_invocation_ref[key] = value.strip()
    return model_invocation_ref


# ---------------------------------------------------------------------------
# Verification/Repair Agent
# ---------------------------------------------------------------------------


class RepairAgent:
    """Orchestrator-invoked productive Verification/Repair Agent.

    The agent's contract is exposed through one method: :meth:`invoke`.
    Construction wires it to the run artifact store, the Model Gateway
    invoker, and (optionally) the Harness event sink. None of those
    collaborators decide what the workflow does next — they only persist
    or observe.
    """

    def __init__(
        self,
        *,
        config: OrchestratorConfig,
        artifact_store: RunArtifactStore,
        model_invoker: ModelGatewayInvoker,
        harness_events: HarnessEventSink | None = None,
        clock: Callable[[], datetime.datetime] | None = None,
    ) -> None:
        self._config = config
        self._artifact_store = artifact_store
        self._model_invoker = model_invoker
        self._harness_events = harness_events
        self._clock = clock or (lambda: datetime.datetime.now(tz=datetime.timezone.utc))

    # ----- public API ------------------------------------------------------

    def invoke(self, request: RepairAgentRequest) -> RepairAgentResult:
        """Run one repair-agent attempt and return a structured result.

        Raises a :class:`RepairAgentError` subclass for failure modes that
        block the run (policy denial, gateway unavailability, timeout,
        contract-invalid). For agent-driven outcomes (propose / refuse /
        escalate / no_change) the method returns the structured result and
        never raises.
        """
        started_at = self._iso_now()
        attempt_dir = _attempt_dir(request.attempt_number)

        # 1. Build, validate, persist the agent-repair-input artifact. Doing
        # this before the gateway call guarantees the run timeline carries
        # an input artifact for the attempt even if the gateway fails.
        repair_input_payload = self._build_repair_input_payload(request, started_at)
        try:
            assert_no_secret_leak(repair_input_payload)
            validate_repair_input(repair_input_payload)
        except AgentContractInvalidError as exc:
            raise RepairAgentContractInvalidError(
                f"agent-repair-input failed contract validation: {'; '.join(exc.errors) or exc}"
            ) from exc
        request_meta = self._artifact_store.write_json(
            request.run_id,
            request.workflow_id,
            f"{attempt_dir}/agent-repair-input.json",
            repair_input_payload,
            kind=KIND_REPAIR_AGENT_INPUT,
        )
        request_artifact_ref = _meta_to_ref(request_meta)
        self._emit_event(
            request,
            event_type="orchestrator.agent.repair.invoked",
            state_transition="agent.repair.invoked",
            status="updating",
            input_payload={
                "runId": request.run_id,
                "attemptNumber": request.attempt_number,
                "failureCategory": request.failure_category,
                "promptTemplateId": self._config.repair_agent_prompt_template_id,
            },
            output_payload={"requestRef": request_artifact_ref},
        )

        # 2. Call the Model Gateway. Failures map to typed exceptions so
        # the Orchestrator can finalise the run with the right failure code.
        invoke_started = time.monotonic()
        try:
            gateway_response = self._call_model_gateway(request)
        except RepairAgentError as exc:
            decision_ref = self._persist_failure_decision(
                request,
                attempt_dir=attempt_dir,
                _started_at=started_at,
                exc=exc,
                request_artifact_ref=request_artifact_ref,
            )
            exc.repair_input_artifact_ref = dict(request_artifact_ref)
            exc.repair_decision_artifact_ref = dict(decision_ref)
            raise

        latency_ms = max(0, int((time.monotonic() - invoke_started) * 1000))
        ended_at = self._iso_now()

        # 3. Parse the gateway envelope and decode the agent's decision.
        model_invocation_ref: JsonObject | None = None
        try:
            model_invocation_ref = _model_invocation_ref_from_gateway(
                request,
                gateway_response,
            )
            inner_envelope = _parse_model_output_envelope(gateway_response.get("output"))
            decision = _validate_inner_decision(inner_envelope.get("decision"))
            rationale = inner_envelope.get("rationale")
            if not isinstance(rationale, str) or not rationale.strip():
                rationale = (
                    inner_envelope.get("explanation")
                    or inner_envelope.get("reason")
                    or f"Model returned {decision} without rationale; decoder derived a bounded audit rationale."
                )
                rationale = str(rationale).strip()
            confidence = _coerce_confidence(inner_envelope.get("confidence"))

            candidate: RepairedJavaCandidate | None = None
            refusal_code: str | None = None
            escalation_code: str | None = None

            if decision == DECISION_PROPOSE:
                candidate = self._decode_repair_candidate(inner_envelope)
            elif decision == DECISION_REFUSE:
                refusal_code = _validate_refusal_code(inner_envelope.get("refusalCode"))
            else:
                escalation_code = _validate_escalation_code(
                    inner_envelope.get("escalationCode")
                )
        except RepairAgentContractInvalidError as exc:
            decision_ref = self._persist_failure_decision(
                request,
                attempt_dir=attempt_dir,
                _started_at=started_at,
                exc=exc,
                request_artifact_ref=request_artifact_ref,
                latency_ms=latency_ms,
            )
            exc.model_invocation_ref = (
                dict(model_invocation_ref)
                if isinstance(model_invocation_ref, Mapping)
                else None
            )
            exc.repair_input_artifact_ref = dict(request_artifact_ref)
            exc.repair_decision_artifact_ref = dict(decision_ref)
            raise

        # 4. When the agent proposes a candidate, persist the Java files +
        # generated-project manifest. The persisted manifest is the source
        # of truth for newJavaCandidateRef.
        persisted_artifacts: list[JsonObject] = []
        new_java_candidate_ref: JsonObject | None = None
        is_no_change = False
        if candidate is not None:
            for relpath, content in sorted(candidate.files.items()):
                file_meta = self._artifact_store.write_text(
                    request.run_id,
                    request.workflow_id,
                    f"{attempt_dir}/java/{relpath}",
                    content,
                    kind=KIND_REPAIR_AGENT_JAVA_FILE,
                    mime_type=MIME_JAVA,
                )
                persisted_artifacts.append(file_meta.to_dict())
            manifest_payload = self._build_manifest_payload(
                request,
                candidate,
                model_invocation_ref,
            )
            manifest_meta = self._artifact_store.write_json(
                request.run_id,
                request.workflow_id,
                f"{attempt_dir}/generated-project-manifest.json",
                manifest_payload,
                kind=KIND_REPAIR_AGENT_PROJECT_MANIFEST,
            )
            persisted_artifacts.append(manifest_meta.to_dict())
            new_java_candidate_ref = _meta_to_ref(manifest_meta)
            # No-change detection: compute a stable content hash over the
            # candidate file map. If it matches the previous candidate's
            # content hash the orchestrator must not consume more budget
            # on identical attempts.
            if request.previous_java_files:
                previous_hash = _files_canonical_sha256(request.previous_java_files)
                new_hash = _files_canonical_sha256(candidate.files)
                if previous_hash == new_hash:
                    is_no_change = True

        # 5. Build, validate, persist the agent-repair-decision artifact.
        effective_decision = (
            DECISION_NO_CHANGE
            if is_no_change
            else decision
        )
        # The persisted decision payload always uses the agent's own
        # decision label (propose_candidate). The synthetic no_change
        # outcome is reflected on the result object only — the on-disk
        # contract artifact remains conformant to agent-repair-decision-v0.
        decision_payload = self._build_repair_decision_payload(
            request,
            decision=decision,
            rationale=rationale,
            refusal_code=refusal_code,
            escalation_code=escalation_code,
            new_java_candidate_ref=new_java_candidate_ref,
            confidence=confidence,
            ended_at=ended_at,
        )
        try:
            guard_repair_decision(decision_payload)
        except AgentContractInvalidError as exc:
            wrapped = RepairAgentContractInvalidError(
                f"agent-repair-decision failed schema validation: {'; '.join(exc.errors) or exc}"
            )
            decision_ref = self._persist_failure_decision(
                request,
                attempt_dir=attempt_dir,
                _started_at=started_at,
                exc=wrapped,
                request_artifact_ref=request_artifact_ref,
                latency_ms=latency_ms,
            )
            wrapped.model_invocation_ref = dict(model_invocation_ref)
            wrapped.repair_input_artifact_ref = dict(request_artifact_ref)
            wrapped.repair_decision_artifact_ref = dict(decision_ref)
            raise wrapped from exc

        decision_meta = self._artifact_store.write_json(
            request.run_id,
            request.workflow_id,
            f"{attempt_dir}/agent-repair-decision.json",
            decision_payload,
            kind=KIND_REPAIR_AGENT_DECISION,
        )
        persisted_artifacts.append(decision_meta.to_dict())

        # 6. Emit a Harness event keyed on the effective outcome so EL can
        # observe no-change patterns directly.
        event_suffix = effective_decision.replace("_", ".") if effective_decision == DECISION_NO_CHANGE else effective_decision
        self._emit_event(
            request,
            event_type=f"orchestrator.agent.repair.{event_suffix}",
            state_transition=f"agent.repair.{event_suffix}",
            status="ok" if effective_decision == DECISION_PROPOSE else effective_decision,
            input_payload={
                "runId": request.run_id,
                "attemptNumber": request.attempt_number,
                "failureCategory": request.failure_category,
            },
            output_payload={
                "decision": effective_decision,
                "decisionRef": _meta_to_ref(decision_meta),
                "newJavaCandidateRef": new_java_candidate_ref,
                "refusalCode": refusal_code,
                "escalationCode": escalation_code,
            },
            latency_ms=latency_ms,
        )

        # 7. Map the agent-driven outcome to a canonical W0.2 failure code
        # for non-success decisions. The Orchestrator uses this to finalise
        # the run when the loop terminates.
        failure_code: str | None = None
        failure_message: str | None = None
        if effective_decision == DECISION_REFUSE and refusal_code is not None:
            failure_code = REFUSAL_TO_FAILURE_CODE.get(refusal_code, "java_generation_failed")
            failure_message = f"repair refused: {refusal_code}; {rationale}"
        elif effective_decision == DECISION_ESCALATE and escalation_code is not None:
            failure_code = "java_generation_failed"
            failure_message = f"repair escalated: {escalation_code}; {rationale}"
        elif effective_decision == DECISION_NO_CHANGE:
            failure_code = "java_generation_failed"
            failure_message = (
                f"no-change repair detected after attempt {request.attempt_number}; "
                f"terminating loop"
            )

        return RepairAgentResult(
            decision=effective_decision,
            candidate=candidate,
            refusal_code=refusal_code,
            escalation_code=escalation_code,
            rationale=rationale,
            confidence=confidence,
            failure_code=failure_code,
            failure_message=failure_message,
            model_invocation_ref=model_invocation_ref,
            new_java_candidate_ref=new_java_candidate_ref,
            diff_from_previous_ref=None,
            repair_input_payload=dict(repair_input_payload),
            repair_decision_payload=dict(decision_payload),
            repair_input_artifact_ref=request_artifact_ref,
            repair_decision_artifact_ref=_meta_to_ref(decision_meta),
            persisted_artifacts=list(persisted_artifacts),
        )

    # ----- helpers ---------------------------------------------------------

    def _iso_now(self) -> str:
        return _iso_now(self._clock)

    def _decode_repair_candidate(
        self, inner_envelope: Mapping[str, JsonValue]
    ) -> RepairedJavaCandidate:
        """Decode the proposed Java candidate using the shared validator.

        The repair agent's candidate envelope has the same shape as the
        transformation agent's: ``files``, ``entryClass``, ``entryPackage``,
        ``entryFilePath``, ``unsupportedConstructs``, ``explanation``. We
        reuse the transformation agent's decoder to get identical
        validation behaviour and re-wrap the typed error so the repair-loop
        finalisation surfaces ``agent_contract_invalid``.
        """
        try:
            decoded: GeneratedJavaCandidate = _decode_candidate(
                inner_envelope,
                max_output_bytes=self._config.repair_agent_max_output_bytes,
                default_package=self._config.repair_agent_package_base,
            )
        except AgentContractInvalidAgentError as exc:
            raise RepairAgentContractInvalidError(str(exc)) from exc
        return RepairedJavaCandidate(
            files=dict(decoded.files),
            entry_class=decoded.entry_class,
            entry_package=decoded.entry_package,
            entry_file_path=decoded.entry_file_path,
            unsupported_constructs=tuple(decoded.unsupported_constructs),
            explanation=decoded.explanation,
        )

    @staticmethod
    def _build_repair_input_payload(
        request: RepairAgentRequest,
        created_at: str,
    ) -> JsonObject:
        """Materialise the ``agent-repair-input-v0`` payload."""
        payload: JsonObject = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "previousJavaCandidateRef": _coerce_artifact_ref(
                request.previous_java_candidate_ref
            ),
            "buildTestResultRef": _coerce_artifact_ref(request.build_test_result_ref),
            "failureCategory": request.failure_category,
            "repairBudgetRemaining": int(request.repair_budget_remaining),
            "createdAt": created_at,
        }
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            payload["semanticIrRef"] = _coerce_artifact_ref(request.semantic_ir_ref)
        if request.source_cobol_ref and _looks_like_artifact_ref(request.source_cobol_ref):
            payload["sourceCobolRef"] = _coerce_artifact_ref(request.source_cobol_ref)
        if request.compile_error_ref and _looks_like_artifact_ref(request.compile_error_ref):
            payload["compileErrorRef"] = _coerce_artifact_ref(request.compile_error_ref)
        if request.runtime_error_ref and _looks_like_artifact_ref(request.runtime_error_ref):
            payload["runtimeErrorRef"] = _coerce_artifact_ref(request.runtime_error_ref)
        if request.oracle_diff_ref and _looks_like_artifact_ref(request.oracle_diff_ref):
            payload["oracleDiffRef"] = _coerce_artifact_ref(request.oracle_diff_ref)
        if request.previous_repair_decision_refs:
            previous_refs: list[JsonObject] = []
            for ref in request.previous_repair_decision_refs:
                if _looks_like_artifact_ref(ref):
                    previous_refs.append(_coerce_artifact_ref(ref))
            if previous_refs:
                payload["previousRepairDecisionRefs"] = previous_refs
        return payload

    @staticmethod
    def _build_repair_decision_payload(
        request: RepairAgentRequest,
        *,
        decision: str,
        rationale: str,
        refusal_code: str | None,
        escalation_code: str | None,
        new_java_candidate_ref: Mapping[str, JsonValue] | None,
        confidence: float | None,
        ended_at: str,
    ) -> JsonObject:
        """Materialise the ``agent-repair-decision-v0`` payload."""
        truncated_rationale = rationale.strip()
        if len(truncated_rationale) > 4000:
            truncated_rationale = truncated_rationale[:4000]
        payload: JsonObject = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "decision": decision,
            "rationale": truncated_rationale,
            "createdAt": ended_at,
        }
        if confidence is not None:
            payload["confidence"] = float(confidence)
        if decision == DECISION_PROPOSE and new_java_candidate_ref is not None:
            payload["newJavaCandidateRef"] = _coerce_artifact_ref(new_java_candidate_ref)
        if decision == DECISION_REFUSE and refusal_code is not None:
            payload["refusalCode"] = refusal_code
        if decision == DECISION_ESCALATE and escalation_code is not None:
            payload["escalationCode"] = escalation_code
        return payload

    @staticmethod
    def _build_manifest_payload(
        request: RepairAgentRequest,
        candidate: RepairedJavaCandidate,
        model_invocation_ref: Mapping[str, JsonValue],
    ) -> JsonObject:
        manifest_payload: JsonObject = {
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": request.attempt_number,
            "generationSource": "verification-repair-agent",
            "targetLanguage": "java",
            "modelInvocationRef": dict(model_invocation_ref),
            "previousJavaCandidateRef": _coerce_artifact_ref(
                request.previous_java_candidate_ref
            ),
            "buildTestResultRef": _coerce_artifact_ref(request.build_test_result_ref),
            "failureCategory": request.failure_category,
            **candidate.to_manifest(),
        }
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            manifest_payload["semanticIrRef"] = _coerce_artifact_ref(request.semantic_ir_ref)
        if request.source_cobol_ref and _looks_like_artifact_ref(request.source_cobol_ref):
            manifest_payload["sourceProgramRef"] = _coerce_artifact_ref(request.source_cobol_ref)
        return manifest_payload

    @staticmethod
    def _build_failure_decision_payload(
        request: RepairAgentRequest,
        *,
        failure_code: str,
        failure_message: str,
        ended_at: str,
    ) -> JsonObject:
        """Build a contract-shaped synthetic decision used when the gateway
        fails or returns invalid output. The synthetic decision is always
        ``refuse`` with a reason that maps cleanly to ``no_safe_repair`` so
        the artifact still satisfies the W0.2 schema.
        """
        rationale = (
            f"repair-agent invocation failed: {failure_code}; {failure_message}"
        )
        if len(rationale) > 4000:
            rationale = rationale[:4000]
        return {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "decision": DECISION_REFUSE,
            "rationale": rationale,
            "refusalCode": "no_safe_repair",
            "createdAt": ended_at,
        }

    def _persist_failure_decision(
        self,
        request: RepairAgentRequest,
        *,
        attempt_dir: str,
        _started_at: str,
        exc: RepairAgentError,
        request_artifact_ref: Mapping[str, JsonValue],
        latency_ms: int = 0,
    ) -> JsonObject:
        """Persist a synthetic decision artifact and emit a failure event."""
        ended_at = self._iso_now()
        synthetic = self._build_failure_decision_payload(
            request,
            failure_code=exc.failure_code,
            failure_message=str(exc),
            ended_at=ended_at,
        )
        # The synthetic payload is a valid agent-repair-decision-v0 because
        # the failure-mode rationale uses the ``refuse`` outcome with
        # ``no_safe_repair``. Validate to guarantee the on-disk artifact
        # always conforms.
        try:
            guard_repair_decision(synthetic)
        except AgentContractInvalidError:
            # Defensive: ``_build_failure_decision_payload`` is the only
            # producer and is guaranteed by construction to satisfy the
            # schema. Fall back to a minimally-shaped payload so the
            # artifact still exists for the trajectory ledger.
            synthetic = {
                "schemaVersion": "v0",
                "runId": request.run_id,
                "workflowId": request.workflow_id,
                "attemptNumber": int(request.attempt_number),
                "decision": DECISION_REFUSE,
                "rationale": "repair-agent invocation failed",
                "refusalCode": "no_safe_repair",
                "createdAt": ended_at,
            }
        decision_meta = self._artifact_store.write_json(
            request.run_id,
            request.workflow_id,
            f"{attempt_dir}/agent-repair-decision.json",
            synthetic,
            kind=KIND_REPAIR_AGENT_DECISION,
        )
        self._emit_event(
            request,
            event_type="orchestrator.agent.repair.failed",
            state_transition="agent.repair.failed",
            status="failed",
            input_payload={
                "runId": request.run_id,
                "attemptNumber": request.attempt_number,
                "failureCategory": request.failure_category,
            },
            output_payload={
                "failureCode": exc.failure_code,
                "failureMessage": str(synthetic["rationale"]),
                "decisionRef": _meta_to_ref(decision_meta),
                "requestRef": dict(request_artifact_ref),
            },
            latency_ms=latency_ms,
        )
        return _meta_to_ref(decision_meta)

    def _call_model_gateway(
        self, request: RepairAgentRequest
    ) -> JsonObject:
        """Build the Model Gateway request and call the configured invoker.

        The agent never embeds direct provider HTTP calls. The invoker is
        expected to talk to the Harness-registered ``model-gateway``
        capability so policy enforcement and audit happen at the gateway,
        not at the agent boundary.
        """
        prompt_payload = self._build_model_prompt(request)
        invoke_payload: JsonObject = {
            "runId": request.run_id,
            "actor": "orchestrator-service",
            "agentRole": MODEL_GATEWAY_AGENT_ROLE,
            "modelId": request.model_id,
            "dataClass": DATA_CLASS_MODEL_GATEWAY,
            "promptTemplateVersion": self._config.repair_agent_prompt_template_version,
            "prompt": prompt_payload,
            "structuredOutput": True,
            "structuredOutputSchema": _REPAIR_INNER_OUTPUT_SCHEMA,
            "parameters": {
                "runId": request.run_id,
                "attemptNumber": int(request.attempt_number),
                "promptTemplateId": self._config.repair_agent_prompt_template_id,
                "failureCategory": request.failure_category,
                "previousJavaCandidateRef": _coerce_artifact_ref(
                    request.previous_java_candidate_ref
                ),
                "buildTestResultRef": _coerce_artifact_ref(request.build_test_result_ref),
                "repairBudgetRemaining": int(request.repair_budget_remaining),
                "temperature": 0,
                "max_tokens": 8192,
            },
            "timeoutMs": int(request.deadline_ms),
        }
        if request.source_cobol_ref and _looks_like_artifact_ref(request.source_cobol_ref):
            invoke_payload["parameters"]["sourceCobolRef"] = _coerce_artifact_ref(
                request.source_cobol_ref
            )
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            invoke_payload["parameters"]["semanticIrRef"] = _coerce_artifact_ref(
                request.semantic_ir_ref
            )
        if request.compile_error_ref and _looks_like_artifact_ref(request.compile_error_ref):
            invoke_payload["parameters"]["compileErrorRef"] = _coerce_artifact_ref(
                request.compile_error_ref
            )
        if request.runtime_error_ref and _looks_like_artifact_ref(request.runtime_error_ref):
            invoke_payload["parameters"]["runtimeErrorRef"] = _coerce_artifact_ref(
                request.runtime_error_ref
            )
        if request.oracle_diff_ref and _looks_like_artifact_ref(request.oracle_diff_ref):
            invoke_payload["parameters"]["oracleDiffRef"] = _coerce_artifact_ref(
                request.oracle_diff_ref
            )

        try:
            response = self._model_invoker.invoke(invoke_payload)
        except RepairAgentError:
            raise
        except HarnessFailure as exc:
            raise self._classify_failure(exc) from exc
        except Exception as exc:  # noqa: BLE001 — any transport failure is unavailability.
            raise self._classify_failure(exc) from exc
        if not isinstance(response, Mapping):
            raise RepairAgentGatewayUnavailableError(
                "model gateway returned non-object response"
            )
        return dict(response)

    @staticmethod
    def _classify_failure(exc: BaseException) -> RepairAgentError:
        """Map a Model Gateway failure to a typed Repair Agent error.

        We delegate the classification heuristics to the shared
        ``_classify_gateway_failure`` so policy/timeout/unavailable strings
        stay aligned with the transformation agent, then re-wrap into the
        repair-agent error hierarchy so the orchestrator can match on the
        repair-agent type.
        """
        classified = _classify_gateway_failure(exc)
        message = str(classified)
        if classified.failure_code == "model_policy_denied":
            return RepairAgentPolicyDeniedError(message)
        if classified.failure_code == "agent_timeout":
            return RepairAgentTimeoutError(message)
        if classified.failure_code == "model_gateway_unavailable":
            return RepairAgentGatewayUnavailableError(message)
        return RepairAgentGatewayUnavailableError(message)

    def _build_model_prompt(self, request: RepairAgentRequest) -> str:
        """Compose the policy-controlled prompt body sent to the gateway.

        The prompt is structured JSON identified by ``promptTemplateId``;
        the actual prompt template lives in the Model Gateway prompt
        registry. The agent fills in structured slots and references the
        template by id so the registry author and the gateway agree on
        what is being asked.
        """
        envelope: JsonObject = {
            "promptTemplateId": self._config.repair_agent_prompt_template_id,
            "promptTemplateVersion": self._config.repair_agent_prompt_template_version,
            "task": "java-verification-repair",
            "targetLanguage": "java",
            "targetPackageBase": self._config.repair_agent_package_base,
            "failureCategory": request.failure_category,
            "repairBudgetRemaining": int(request.repair_budget_remaining),
            "previousJavaCandidateRef": _coerce_artifact_ref(
                request.previous_java_candidate_ref
            ),
            "previousJavaFiles": dict(request.previous_java_files),
            "buildTestResultRef": _coerce_artifact_ref(request.build_test_result_ref),
            "buildTestPayload": dict(request.build_test_payload) if request.build_test_payload else None,
            "oraclePayload": dict(request.oracle_payload or {}) or None,
            "instructions": [
                "Return only JSON matching agent-repair-decision-inner-v0.",
                "Allowed decision values are exactly propose_candidate, refuse, or escalate.",
                "Never return adjust_expected_output and never modify the oracle or expected output.",
                "For output-divergence failures, prefer propose_candidate when a Java-only fix can make stdout match the oracle.",
                "For numeric COBOL DISPLAY fields, preserve PIC formatting including leading zeroes; when using the c2c runtime, call CobolField.displayValue().",
            ],
            "outputContract": {
                "shape": "agent-repair-decision-inner-v0",
                "schemaRef": _REPAIR_INNER_OUTPUT_SCHEMA_ID,
            },
        }
        if request.source_text:
            envelope["sourceText"] = request.source_text
        if request.source_cobol_ref and _looks_like_artifact_ref(request.source_cobol_ref):
            envelope["sourceCobolRef"] = _coerce_artifact_ref(request.source_cobol_ref)
        if request.semantic_ir is not None:
            envelope["semanticIr"] = dict(request.semantic_ir)
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            envelope["semanticIrRef"] = _coerce_artifact_ref(request.semantic_ir_ref)
        if request.compile_error_ref and _looks_like_artifact_ref(request.compile_error_ref):
            envelope["compileErrorRef"] = _coerce_artifact_ref(request.compile_error_ref)
        if request.runtime_error_ref and _looks_like_artifact_ref(request.runtime_error_ref):
            envelope["runtimeErrorRef"] = _coerce_artifact_ref(request.runtime_error_ref)
        if request.oracle_diff_ref and _looks_like_artifact_ref(request.oracle_diff_ref):
            envelope["oracleDiffRef"] = _coerce_artifact_ref(request.oracle_diff_ref)
        if request.previous_repair_decision_refs:
            envelope["previousRepairDecisionRefs"] = [
                _coerce_artifact_ref(ref)
                for ref in request.previous_repair_decision_refs
                if _looks_like_artifact_ref(ref)
            ]
        try:
            assert_no_secret_leak(envelope)
        except AgentContractInvalidError as exc:
            raise RepairAgentContractInvalidError(
                f"repair prompt failed secret-leak guard: {'; '.join(exc.errors) or exc}"
            ) from exc
        return json.dumps(envelope, sort_keys=True, ensure_ascii=False)

    def _emit_event(
        self,
        request: RepairAgentRequest,
        *,
        event_type: str,
        state_transition: str,
        status: str,
        input_payload: Mapping[str, JsonValue],
        output_payload: Mapping[str, JsonValue],
        latency_ms: int | None = None,
    ) -> None:
        """Best-effort Harness event emission. Failures must not break the
        agent invocation; the Harness is observational, not controlling."""
        if self._harness_events is None:
            return
        now = self._iso_now()
        # Drop None-valued keys from the output payload so the event
        # serialisation is stable regardless of which optional refs were
        # populated by the caller.
        output_clean = {k: v for k, v in output_payload.items() if v is not None}
        input_canonical = _canonical_json_bytes(dict(input_payload))
        output_canonical = _canonical_json_bytes(output_clean)
        event: JsonObject = {
            "eventType": event_type,
            "schemaVersion": "v0",
            "service": "orchestrator-service",
            "runId": request.run_id,
            "actor": REPAIR_AGENT_ROLE,
            "capability": request.capability_id,
            "dataClass": DATA_CLASS_GENERATOR,
            "redactionProfile": "harness-control-plane",
            "policyDecision": "policy allow",
            "status": status,
            "stateTransition": state_transition,
            "createdAt": now,
            "inputRef": {
                "uri": f"urn:orchestrator/{request.run_id}/repair-agent/{request.attempt_number}/in",
                "sha256": sha256(input_canonical).hexdigest(),
                "byteSize": len(input_canonical),
            },
            "outputRef": {
                "uri": f"urn:orchestrator/{request.run_id}/repair-agent/{request.attempt_number}/out",
                "sha256": sha256(output_canonical).hexdigest(),
                "byteSize": len(output_canonical),
            },
            "payload": {
                "input": dict(input_payload),
                "output": output_clean,
            },
        }
        if latency_ms is not None:
            event["latencyMs"] = int(latency_ms)
        try:
            self._harness_events.post_event(event)
        except Exception:  # pragma: no cover — emission is best-effort
            return


# ---------------------------------------------------------------------------
# Inner structured-output schema published to the Model Gateway
# ---------------------------------------------------------------------------


_REPAIR_INNER_OUTPUT_SCHEMA_ID = (
    "https://oscharko.dev/c2c/schemas/repair-agent-inner-v0.json"
)


_REPAIR_INNER_OUTPUT_SCHEMA: JsonObject = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": _REPAIR_INNER_OUTPUT_SCHEMA_ID,
    "title": "Verification/Repair Agent Inner Output v0",
    "description": (
        "Schema the Model Gateway uses to constrain the structured output "
        "returned by the Verification/Repair Agent's model invocation. The "
        "orchestrator validates the returned object via the agent-repair "
        "decoder and the agent-repair-decision-v0 contract before using it."
    ),
    "type": "object",
    "required": ["decision", "rationale"],
    "properties": {
        "decision": {
            "type": "string",
            "enum": ["propose_candidate", "refuse", "escalate"],
        },
        "rationale": {"type": "string"},
        "confidence": {"type": "number"},
        "refusalCode": {
            "type": "string",
            "enum": list(VALID_REFUSAL_CODES),
        },
        "escalationCode": {
            "type": "string",
            "enum": list(VALID_ESCALATION_CODES),
        },
        "files": {
            "type": "object",
            "additionalProperties": {"type": "string"},
        },
        "entryClass": {"type": "string"},
        "entryPackage": {"type": "string"},
        "entryFilePath": {"type": "string"},
        "unsupportedConstructs": {
            "type": "array",
            "items": {"type": "string"},
        },
        "explanation": {"type": "string"},
    },
    "additionalProperties": False,
}


__all__ = [
    "DECISION_ESCALATE",
    "DECISION_NO_CHANGE",
    "DECISION_PROPOSE",
    "DECISION_REFUSE",
    "MODEL_GATEWAY_AGENT_ROLE",
    "REFUSAL_TO_FAILURE_CODE",
    "REPAIR_AGENT_DIR",
    "REPAIR_AGENT_ROLE",
    "RepairAgent",
    "RepairAgentContractInvalidError",
    "RepairAgentError",
    "RepairAgentGatewayUnavailableError",
    "RepairAgentPolicyDeniedError",
    "RepairAgentRequest",
    "RepairAgentResult",
    "RepairAgentTimeoutError",
    "RepairedJavaCandidate",
    "VALID_ESCALATION_CODES",
    "VALID_FAILURE_CATEGORIES",
    "VALID_REFUSAL_CODES",
]
