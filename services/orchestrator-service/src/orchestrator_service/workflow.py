"""Workflow orchestration for the first W0 Harness consumer."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, Mapping, Optional, Sequence

from .config import OrchestratorConfig
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

DEFAULT_MODEL_ID = "orchestrator"
DEFAULT_PROMPT_TEMPLATE_VERSION = "v0"
DEFAULT_MODEL_TIMEOUT_MS = 30000


@dataclass(frozen=True)
class W0RunContext:
    run_id: str
    workflow_id: str
    requester: str
    evidence_refs: Sequence[str]
    model_prompt: Optional[str] = None


@dataclass(frozen=True)
class WorkflowStepResult:
    capability_id: str
    step_name: str
    payload: Mapping[str, Any]
    status: str
    input_ref: DataReference
    output_ref: DataReference


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


def _first_non_empty_mapping(value: Any) -> Dict[str, Any]:
    if isinstance(value, Mapping) and value:
        return dict(value)
    return {}


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

    def __init__(self, config: OrchestratorConfig, gateway: HarnessGateway):
        self.config = config
        self.gateway = gateway
        self._step_lock = threading.Lock()
        self._step_id_by_run: Dict[str, int] = {}
        self._capability_cache: Dict[str, Dict[str, Any]] = {}

    def run(self, context: W0RunContext, input_ref: Mapping[str, Any]) -> Dict[str, Any]:
        input_reference = _normalize_input_ref(input_ref, context.run_id)
        source_text = _extract_source(input_ref)
        evidence_refs: list[str] = list(context.evidence_refs)
        step_results: list[WorkflowStepResult] = []
        model_output = None

        try:
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
            program_id = self._resolve_program_id(parse_output.payload, ir_output.payload, generator_output.payload)

            build_test_input = {
                "schemaVersion": "v0",
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "programId": program_id or f"{context.run_id}-build",
                "generatedProject": generated_project,
                "generationResponse": generator_output.payload,
                "sourceRef": _as_reference_payload(generator_output.input_ref),
            }

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

            if context.model_prompt:
                model_capability = self._require_capability(
                    context.run_id,
                    self.config.model_gateway_capability_id,
                )
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
                        "modelId": DEFAULT_MODEL_ID,
                        "dataClass": "model",
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

            trajectory_payload = self._fetch_trajectory_ledger(context.run_id)
            trajectory_ref = _coerce_output_ref(trajectory_payload, f"urn:orchestrator/{context.run_id}/trajectory", {})
            evidence_refs.append(trajectory_ref.uri)

            evidence_payload = self._build_evidence_payload(
                context=context,
                input_ref=input_reference,
                parse_output=parse_output,
                ir_output=ir_output,
                generator_output=generator_output,
                build_test_output=build_test_output,
                model_output=model_output,
                trajectory_payload=trajectory_payload,
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
            return {
                "runId": context.run_id,
                "workflowId": context.workflow_id,
                "status": "completed",
                "evidencePack": evidence_output.payload,
                "stepCount": len(step_results),
            }
        except Exception as exc:
            self._emit_workflow_decision_event(
                context,
                "orchestrator.workflow.failed",
                str(exc),
            )
            try:
                self.gateway.update_run(
                    context.run_id,
                    "failed",
                    updated_by=self.config.service_name,
                    message=f"W0 migration workflow failed: {exc}",
                    evidence_refs=evidence_refs,
                    policy_decision=POLICY_ALLOW,
                )
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
    ) -> Dict[str, Any]:
        trajectory_ref = _build_reference(
            f"urn:orchestrator/{context.run_id}/trajectory",
            trajectory_payload,
        )
        model_invocation = self._build_model_invocation_ref(context, model_output)
        artifacts = {
            "sourceCobol": [_as_reference_payload(input_ref)],
            "semanticIr": _as_reference_payload(_coerce_output_ref(ir_output.payload, generator_output.output_ref.uri, ir_output.payload)),
            "generatedJava": _as_reference_payload(generator_output.output_ref),
            "buildTestResults": [_as_reference_payload(build_test_output.output_ref)],
            "harnessEvents": _as_reference_payload(trajectory_ref),
            "modelInvocations": [model_invocation],
            "trajectoryLedger": _as_reference_payload(trajectory_ref),
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

    def _build_model_invocation_ref(self, context: W0RunContext, model_output: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
        if model_output is None:
            payload = {
                "runId": context.run_id,
                "modelId": DEFAULT_MODEL_ID,
                "status": "skipped",
                "actor": self.config.service_name,
            }
            return {
                "invocationId": f"inv-{context.run_id}-00",
                "modelId": DEFAULT_MODEL_ID,
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
        ledger_payload = {
            "invocationId": invocation_id,
            "modelId": model_id,
            "status": status,
        }
        return {
            "invocationId": invocation_id,
            "modelId": model_id,
            "provider": provider,
            "promptTemplateVersion": template,
            "status": status,
            "ledgerRef": _as_reference_payload(
                _build_reference(
                    f"urn:orchestrator/{context.run_id}/model-invocation",
                    ledger_payload,
                )
            ),
        }

    def _resolve_program_id(self, *payloads: Mapping[str, Any]) -> str:
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
                    input_payload=dict(payload),
                    output_payload=output_payload,
                    input_ref=input_ref,
                    output_ref=output_ref,
                    latency_ms=latency_ms,
                    policy_decision=POLICY_ALLOW,
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

                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.failed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="failed",
                    state_transition=STATE_TRANSITION_STEP_FAILED,
                    input_payload=dict(payload),
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=_build_reference(
                        f"urn:orchestrator/{context.run_id}/step/{step_name}/failure",
                        {"error": str(exc), "attempts": attempt_number},
                    ),
                    policy_decision=POLICY_ALLOW,
                )
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc
            except Exception as exc:
                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.failed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="failed",
                    state_transition=STATE_TRANSITION_STEP_FAILED,
                    input_payload=dict(payload),
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=_build_reference(
                        f"urn:orchestrator/{context.run_id}/step/{step_name}/failure",
                        {"error": str(exc), "attempts": attempt_number},
                    ),
                    policy_decision=POLICY_ALLOW,
                )
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc

    def _coerce_step_output_ref(self, output_payload: Mapping[str, Any], step_name: str, run_id: str) -> DataReference:
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
            "actor": actor,
            "capability": capability,
            "dataClass": data_class,
            "redactionProfile": PROFILE_CONTROLLED_BY_HARNESS,
            "policyDecision": policy_decision,
            "status": status,
            "stateTransition": state_transition,
            "inputRef": _as_reference_payload(input_ref),
            "outputRef": _as_reference_payload(output_ref),
            "payload": {
                "input": dict(input_payload),
                "output": dict(output_payload),
            },
        }
        if latency_ms is not None:
            event["latencyMs"] = latency_ms
        try:
            self.gateway.post_event(event)
        except Exception:
            # Eventing is best-effort and must not break control-plane execution.
            return

    def _next_step_id(self, run_id: str) -> int:
        with self._step_lock:
            current = self._step_id_by_run.get(run_id, 0) + 1
            self._step_id_by_run[run_id] = current
            return current

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
