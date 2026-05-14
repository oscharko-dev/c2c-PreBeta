"""Workflow orchestration for the first W0 Harness consumer."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, List, Mapping, Optional, Sequence

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


def _normalize_input_ref(raw: Mapping[str, Any], run_id: str) -> DataReference:
    if not isinstance(raw, Mapping):
        raise OrchestratorError("inputRef must be an object")
    uri = str(raw.get("uri", "")).strip()
    if not uri:
        uri = f"urn:orchestrator/{run_id}/input"
    provided_sha = str(raw.get("sha256", raw.get("hash", ""))).strip()
    byte_size = int(raw.get("byteSize", raw.get("byte_size", 0) or 0))
    if not provided_sha:
        provided_sha = _build_ref(uri, raw).__dict__["sha256"]
    return DataReference(uri=uri, sha256=provided_sha, byte_size=byte_size)


def _build_ref(uri: str, payload: Any) -> DataReference:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return DataReference(uri=uri, sha256=sha256(canonical).hexdigest(), byte_size=len(canonical))


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
        evidence_refs: list[str] = list(context.evidence_refs)
        step_results: list[WorkflowStepResult] = []

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
                    "workflowId": context.workflow_id,
                    "runId": context.run_id,
                    "inputRef": input_reference.__dict__,
                },
                _build_ref(f"urn:orchestrator/{context.run_id}/input", input_reference.__dict__),
            )
            step_results.append(parse_output)
            evidence_refs.append(parse_output.output_ref.uri)

            ir_output = self._invoke_step(
                context,
                "generate-ir",
                ir_capability,
                DATA_CLASS_PARSER,
                {
                    "workflowId": context.workflow_id,
                    "runId": context.run_id,
                    "parseOutput": parse_output.payload,
                },
                parse_output.output_ref,
            )
            step_results.append(ir_output)
            evidence_refs.append(ir_output.output_ref.uri)

            generator_output = self._invoke_step(
                context,
                "generate-java",
                generator_capability,
                DATA_CLASS_GENERATOR,
                {
                    "workflowId": context.workflow_id,
                    "runId": context.run_id,
                    "intermediateIR": ir_output.payload,
                },
                ir_output.output_ref,
            )
            step_results.append(generator_output)
            evidence_refs.append(generator_output.output_ref.uri)

            build_test_output = self._invoke_step(
                context,
                "compile-test-java",
                build_test_capability,
                DATA_CLASS_BUILD_TEST,
                {
                    "workflowId": context.workflow_id,
                    "runId": context.run_id,
                    "javaCode": generator_output.payload,
                },
                generator_output.output_ref,
            )
            step_results.append(build_test_output)
            evidence_refs.append(build_test_output.output_ref.uri)

            model_output = None
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
                        "workflowId": context.workflow_id,
                        "runId": context.run_id,
                        "prompt": context.model_prompt,
                        "runArtifacts": evidence_refs,
                    },
                    _build_ref(
                        f"urn:orchestrator/{context.run_id}/model-input",
                        {"prompt": context.model_prompt},
                    ),
                )
                step_results.append(model_output_step)
                model_output = model_output_step.payload

            summary = self._build_summary(
                context,
                {
                    "inputRef": input_reference.__dict__,
                    "steps": [step.step_name for step in step_results],
                    "modelGuidance": model_output,
                    "parse": parse_output.payload,
                    "ir": ir_output.payload,
                    "generator": generator_output.payload,
                    "buildTest": build_test_output.payload,
                },
            )
            summary_ref = _build_ref(f"urn:orchestrator/{context.run_id}/summary", summary)

            evidence_output = self._invoke_step(
                context,
                "write-evidence",
                evidence_capability,
                DATA_CLASS_EVIDENCE,
                {
                    "workflowId": context.workflow_id,
                    "runId": context.run_id,
                    "summaryRef": summary_ref.__dict__,
                    "stepRefs": [step.output_ref.__dict__ for step in step_results],
                    "evidenceRefs": evidence_refs,
                },
                _build_ref(
                    f"urn:orchestrator/{context.run_id}/evidence-input",
                    {
                        "summaryRef": summary_ref.__dict__,
                        "stepRefs": [step.output_ref.__dict__ for step in step_results],
                    },
                ),
            )
            step_results.append(evidence_output)
            evidence_refs.append(evidence_output.output_ref.uri)
            evidence_refs.append(summary_ref.uri)

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
                "summaryRef": summary_ref.__dict__,
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
            input_ref=_build_ref(
                f"urn:orchestrator/{context.run_id}/workflow-in",
                {"runId": context.run_id, "workflowId": context.workflow_id},
            ),
            output_ref=_build_ref(
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
                output_ref = _build_ref(f"urn:orchestrator/{context.run_id}/step/{step_name}", output_payload)
                self._post_event(
                    context.run_id,
                    event_type=f"{step_name}.executed",
                    capability=capability_id,
                    actor=actor,
                    data_class=data_class,
                    status="ok",
                    state_transition=STATE_TRANSITION_STEP_COMPLETED,
                    input_payload=payload,
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
                        output_ref=_build_ref(
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
                    input_payload=payload,
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=_build_ref(
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
                    input_payload=payload,
                    output_payload={"error": str(exc), "attempts": attempt_number},
                    input_ref=input_ref,
                    output_ref=_build_ref(
                        f"urn:orchestrator/{context.run_id}/step/{step_name}/failure",
                        {"error": str(exc), "attempts": attempt_number},
                    ),
                    policy_decision=POLICY_ALLOW,
                )
                raise StepExecutionError(f"step {step_name} failed: {exc}") from exc

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
            input_ref=_build_ref(
                f"urn:orchestrator/{run_id}/capability/{capability_id}/request",
                {"capabilityId": capability_id},
            ),
            output_ref=_build_ref(
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
            "inputRef": input_ref.__dict__,
            "outputRef": output_ref.__dict__,
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
    def _build_summary(context: W0RunContext, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        return {
            "runId": context.run_id,
            "workflowId": context.workflow_id,
            "requester": context.requester,
            "payload": dict(payload),
            "capturedAt": int(time.time()),
        }
