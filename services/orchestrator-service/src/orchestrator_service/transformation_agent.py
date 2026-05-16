"""Productive Transformation Agent adapter (Issue #169).

The Transformation Agent is the first productive AI capability the W0.2
Orchestrator can invoke. It receives COBOL source plus all verified upstream
artifacts (Semantic IR, deterministic Java baseline, target Java conventions,
oracle reference), calls an approved model through the Model Gateway, and
returns a structured response that the Orchestrator can persist, build, and
test.

Hard rules enforced by this module:

* Models are reached **only** through the Model Gateway capability. The agent
  does not import any provider SDK and does not make raw HTTP calls outside
  the gateway abstraction handed to it at construction time.
* Every model call is policy-controlled. ``agentRole`` is stamped on the
  Model Gateway request as ``"transformation"`` so the gateway role policy
  introduced in Issue #168 applies.
* Both the request the Orchestrator sends to the agent and the response the
  agent returns are validated against the W0.2 Agent I/O contracts from
  Issue #167 (``agent-invocation-request-v0`` / ``agent-invocation-response-v0``).
* The Java candidate is **always persisted as a real run artifact**. Inline
  text in the response is a convenience view; the artifact in the run
  artifact store is the source of truth and is the value referenced by
  ``javaCandidateRef`` on the response.
* Invalid model output (non-Java content, missing class metadata, oversized
  output, unsupported COBOL without ``status="blocked"``) is rejected. The
  Orchestrator surfaces ``agent_contract_invalid`` for the resulting run
  contract.
* The agent does not perform verification. It does not claim behavioural
  correctness. Build, test, and oracle comparison happen downstream.
* Harness events are emitted for invocation start/completion. They observe
  the call but do not control the workflow.
"""

from __future__ import annotations

import datetime
import json
import re
import time
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import PurePosixPath
from typing import Any, Protocol

from .agent_contracts import (
    AgentContractInvalidError,
    assert_no_secret_leak,
    guard_agent_response,
    validate_invocation_request,
)
from .artifacts import (
    KIND_TRANSFORMATION_AGENT_JAVA_FILE,
    KIND_TRANSFORMATION_AGENT_PROJECT_MANIFEST,
    KIND_TRANSFORMATION_AGENT_REQUEST,
    KIND_TRANSFORMATION_AGENT_RESPONSE,
    MIME_JAVA,
    ArtifactMetadata,
    JsonObject,
    JsonValue,
    RunArtifactStore,
)
from .config import OrchestratorConfig
from .harness import HarnessFailure


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TransformationAgentError(Exception):
    """Base class for Transformation Agent failures.

    Carries a canonical W0.2 failure code so the Orchestrator can route the
    resulting run contract without re-classifying the error string.
    """

    failure_code: str = "java_generation_failed"

    def __init__(self, message: str, *, failure_code: str | None = None) -> None:
        super().__init__(message)
        if failure_code is not None:
            self.failure_code = failure_code


class AgentContractInvalidAgentError(TransformationAgentError):
    """Raised when the agent's response does not satisfy the W0.2 agent I/O
    contract or the inner Java-candidate contract."""

    failure_code = "agent_contract_invalid"


class ModelGatewayUnavailableError(TransformationAgentError):
    """Raised when the Model Gateway is unreachable or returns a 5xx error
    that is not a policy denial."""

    failure_code = "model_gateway_unavailable"


class ModelPolicyDeniedAgentError(TransformationAgentError):
    """Raised when the Model Gateway rejects the invocation on policy
    grounds (e.g. ``forbidden_role``)."""

    failure_code = "model_policy_denied"


class AgentTimeoutError(TransformationAgentError):
    """Raised when the model gateway call exceeds the configured deadline."""

    failure_code = "agent_timeout"


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


AGENT_ROLE = "transformation-agent"
DATA_CLASS_GENERATOR = "generator"
DATA_CLASS_MODEL_GATEWAY = "model-gateway"
MODEL_GATEWAY_AGENT_ROLE = "transformation"
TRANSFORMATION_AGENT_DIR = "transformation-agent"

# Minimum heuristics for "looks like Java" applied to each generated file.
# These are intentionally conservative: the build-test runner is the
# behavioural gatekeeper; the agent only rejects obviously-not-Java payloads
# (raw COBOL, prose, base64 blobs).
_JAVA_SHAPE_HINTS = re.compile(
    r"\b(class|interface|enum|record)\s+[A-Za-z_$][A-Za-z0-9_$]*",
    re.MULTILINE,
)
_JAVA_PACKAGE_LINE = re.compile(r"^\s*package\s+([A-Za-z_$][\w$.]*)\s*;", re.MULTILINE)
_JAVA_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_JAVA_PACKAGE_PATTERN = re.compile(
    r"^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$"
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class ArtifactRef:
    """Content-addressed artifact reference shared by every contract."""

    uri: str
    sha256: str
    byte_size: int
    mime_type: str | None = None
    kind: str | None = None

    def to_payload(self) -> JsonObject:
        payload: JsonObject = {
            "uri": self.uri,
            "sha256": self.sha256,
            "byteSize": int(self.byte_size),
        }
        if self.mime_type:
            payload["mimeType"] = self.mime_type
        if self.kind:
            payload["kind"] = self.kind
        return payload


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class TransformationAgentRequest:
    """Structured input to :meth:`TransformationAgent.invoke`.

    The Orchestrator constructs this dataclass from its in-memory workflow
    state. The dataclass is the boundary; the agent does not read run state
    from any other channel.
    """

    run_id: str
    workflow_id: str
    attempt_number: int
    requester: str
    source_text: str
    source_ref: Mapping[str, JsonValue]
    capability_id: str
    capability_version: str
    capability_provider: str
    capability_resolved_at: str
    model_id: str
    policy_version: str
    source_program_id: str | None = None
    semantic_ir: Mapping[str, JsonValue] | None = None
    semantic_ir_ref: Mapping[str, JsonValue] | None = None
    baseline_java_ref: Mapping[str, JsonValue] | None = None
    baseline_files: Mapping[str, str] | None = None
    oracle_ref: Mapping[str, JsonValue] | None = None
    deadline_ms: int = 30000
    trace_ref: str | None = None

    def __post_init__(self) -> None:
        if not self.run_id:
            raise ValueError("run_id is required")
        if not self.workflow_id:
            raise ValueError("workflow_id is required")
        if self.attempt_number < 1:
            raise ValueError("attempt_number must be >= 1")
        if not self.source_text or not self.source_text.strip():
            raise ValueError("source_text is required")
        if not _looks_like_artifact_ref(self.source_ref):
            raise ValueError("source_ref must include uri, sha256, byteSize")
        if not self.capability_id:
            raise ValueError("capability_id is required")
        if not self.model_id:
            raise ValueError("model_id is required")
        if self.deadline_ms <= 0:
            raise ValueError("deadline_ms must be positive")


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class GeneratedJavaCandidate:
    """Decoded Java candidate the agent returns.

    ``files`` is a path → content mapping. Paths are validated as relative
    POSIX paths so persistence cannot escape the run directory.
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
class TransformationAgentResult:
    """Outcome the Orchestrator consumes after an agent invocation.

    ``response_payload`` is the validated ``agent-invocation-response-v0``
    document. ``request_payload`` is the validated
    ``agent-invocation-request-v0`` document. Both are also persisted as run
    artifacts.
    """

    status: str
    candidate: GeneratedJavaCandidate | None
    failure_code: str | None
    failure_message: str | None
    model_invocation_ref: JsonObject
    java_candidate_ref: JsonObject | None
    output_artifact_refs: list[JsonObject]
    trajectory_record: JsonObject
    response_payload: JsonObject
    request_payload: JsonObject
    request_artifact_ref: JsonObject
    response_artifact_ref: JsonObject
    persisted_artifacts: list[JsonObject] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return self.status == "success"

    @property
    def is_terminal_failure(self) -> bool:
        return self.status in {"failed", "policy_denied"}


# ---------------------------------------------------------------------------
# Protocols
# ---------------------------------------------------------------------------


class ModelGatewayInvoker(Protocol):
    """Thin abstraction over the Model Gateway capability.

    The agent calls ``invoke`` with the Model Gateway request payload. The
    implementation is responsible for routing the call through the Harness
    capability registry (or a test stub) and returning the gateway's parsed
    JSON response. Errors must surface as :class:`HarnessFailure` so the
    agent can classify them.
    """

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:  # pragma: no cover - protocol
        ...


class HarnessEventSink(Protocol):
    """Subset of :class:`HarnessGateway` the agent needs for event emission."""

    def post_event(self, event: JsonObject) -> JsonObject:  # pragma: no cover - protocol
        ...


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso_now(clock: Callable[[], datetime.datetime] | None = None) -> str:
    fn = clock or (lambda: datetime.datetime.now(tz=datetime.timezone.utc))
    now = fn()
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    return now.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _looks_like_artifact_ref(ref: Any) -> bool:
    if not isinstance(ref, Mapping):
        return False
    if not isinstance(ref.get("uri"), str) or not ref.get("uri"):
        return False
    sha = ref.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        return False
    if not all(ch in "0123456789abcdefABCDEF" for ch in sha):
        return False
    byte_size = ref.get("byteSize")
    if not isinstance(byte_size, int) or byte_size < 0:
        return False
    return True


def _coerce_artifact_ref(ref: Mapping[str, JsonValue]) -> JsonObject:
    payload: JsonObject = {
        "uri": str(ref["uri"]),
        "sha256": str(ref["sha256"]).lower(),
        "byteSize": int(ref["byteSize"]),
    }
    mime = ref.get("mimeType")
    if isinstance(mime, str) and mime:
        payload["mimeType"] = mime
    kind = ref.get("kind")
    if isinstance(kind, str) and kind:
        payload["kind"] = kind
    return payload


def _safe_relpath(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    if "\x00" in raw:
        return None
    normalized = raw.replace("\\", "/").strip()
    if not normalized or normalized.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:/", normalized):
        return None
    parts = PurePosixPath(normalized).parts
    for segment in parts:
        if segment in ("", ".", ".."):
            return None
    return "/".join(parts)


def _source_program_id(request: TransformationAgentRequest) -> str:
    explicit = str(request.source_program_id or "").strip()
    if explicit:
        return explicit
    if isinstance(request.semantic_ir, Mapping):
        for key in ("programId", "program_id"):
            value = request.semantic_ir.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


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


def _classify_gateway_failure(exc: BaseException) -> TransformationAgentError:
    """Map a Model Gateway failure to a typed Transformation Agent error.

    The gateway signals policy denial with HTTP 403 plus one of the markers
    in :data:`_MODEL_POLICY_DENY_MARKERS`. Provider timeout is HTTP 504 with
    ``model_provider_timeout``. Other 5xx are treated as unavailability.
    Anything else falls through to :class:`ModelGatewayUnavailableError` so
    the Orchestrator can finalise the run as ``model_gateway_unavailable``.
    """
    text = str(exc).lower()
    if "model_provider_timeout" in text or "deadline exceeded" in text or "timed out" in text:
        return AgentTimeoutError("model gateway timed out")
    if "policy deny" in text:
        return ModelPolicyDeniedAgentError("model gateway policy denied")
    for marker in _MODEL_POLICY_DENY_MARKERS:
        if marker in text:
            return ModelPolicyDeniedAgentError("model gateway policy denied")
    return ModelGatewayUnavailableError("model gateway unavailable")


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")


def _tool_status_for_agent_status(status: str) -> str:
    if status == "success":
        return "success"
    if status == "timeout":
        return "timeout"
    if status == "policy_denied":
        return "denied"
    return "failed"


def _require_gateway_invocation_id(gateway_response: Mapping[str, JsonValue]) -> str:
    invocation_id = str(gateway_response.get("invocationId") or "").strip()
    if not invocation_id:
        raise AgentContractInvalidAgentError(
            "model gateway response missing invocationId; cannot build modelInvocationRef"
        )
    return invocation_id


def _model_invocation_ref_from_gateway(
    request: TransformationAgentRequest,
    gateway_response: Mapping[str, JsonValue],
) -> JsonObject:
    invocation_id = _require_gateway_invocation_id(gateway_response)
    model_id = str(gateway_response.get("modelId") or request.model_id)
    provider_raw = str(gateway_response.get("provider") or "foundry-development")
    provider = (
        provider_raw
        if provider_raw in {"foundry-development", "customer-internal-mock"}
        else "foundry-development"
    )
    model_invocation_ref: JsonObject = {
        "invocationId": invocation_id,
        "modelId": model_id,
        "provider": provider,
    }
    for key in (
        "promptTemplateVersion",
        "promptTemplateId",
        "policyDecision",
        "policyVersion",
        "policyId",
        "status",
        "agentRole",
        "errorCode",
        "errorClass",
        "timestamp",
    ):
        value = str(gateway_response.get(key) or "").strip()
        if value:
            model_invocation_ref[key] = value
    try:
        latency_ms = int(gateway_response.get("latencyMs"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        latency_ms = None
    if latency_ms is not None and latency_ms >= 0:
        model_invocation_ref["latencyMs"] = latency_ms
    ledger_ref_raw = gateway_response.get("ledgerRef")
    if not isinstance(ledger_ref_raw, Mapping) or not _looks_like_artifact_ref(ledger_ref_raw):
        raise AgentContractInvalidAgentError(
            "model gateway response missing ledgerRef; cannot reference model invocation ledger"
        )
    model_invocation_ref["ledgerRef"] = _coerce_artifact_ref(ledger_ref_raw)
    return model_invocation_ref


# ---------------------------------------------------------------------------
# Harness-gateway-backed invoker
# ---------------------------------------------------------------------------


class HarnessModelGatewayInvoker:
    """:class:`ModelGatewayInvoker` backed by the Harness capability proxy.

    The agent never embeds direct provider HTTP calls. This invoker fetches
    the model-gateway capability through the supplied harness gateway and
    calls :meth:`invoke_capability` so policy enforcement and audit happen at
    the gateway, not at the agent boundary.
    """

    def __init__(
        self,
        harness_gateway: Any,
        capability_id: str,
        *,
        expected_capability: Mapping[str, JsonValue] | None = None,
    ) -> None:
        if not capability_id:
            raise ValueError("capability_id is required")
        self._harness_gateway = harness_gateway
        self._capability_id = capability_id
        self._expected_capability = dict(expected_capability or {}) or None
        self._cached_capability: Mapping[str, JsonValue] | None = None

    def _capability(self) -> Mapping[str, JsonValue]:
        if self._cached_capability is None:
            capability = self._harness_gateway.get_capability(self._capability_id)
            if not isinstance(capability, Mapping) or not capability.get("endpoint"):
                raise ModelGatewayUnavailableError(
                    f"model gateway capability {self._capability_id!r} unavailable"
                )
            _validate_model_gateway_capability(
                capability,
                self._capability_id,
                expected_capability=self._expected_capability,
            )
            self._cached_capability = capability
        return self._cached_capability

    def invoke(self, payload: Mapping[str, JsonValue]) -> JsonObject:
        capability = dict(self._capability())
        self._ensure_role_available(capability, payload)
        try:
            response = self._harness_gateway.invoke_capability(capability, dict(payload))
        except HarnessFailure as exc:
            raise _classify_gateway_failure(exc) from exc
        except Exception as exc:  # noqa: BLE001 — any transport failure is unavailability.
            raise _classify_gateway_failure(exc) from exc
        if not isinstance(response, Mapping):
            raise ModelGatewayUnavailableError("model gateway returned non-object response")
        return dict(response)

    def _ensure_role_available(
        self,
        capability: Mapping[str, JsonValue],
        payload: Mapping[str, JsonValue],
    ) -> None:
        """Fail before POST /v0/invoke when the gateway reports no role model.

        The check is intentionally best-effort for test doubles and legacy
        harnesses that only expose the capability proxy. In production the
        HarnessGateway carries a JSONHTTPClient, so the invoker can consult the
        Model Gateway's role-specific `/v0/capabilities` view before sending
        prompt-bearing invocation content.
        """
        agent_role = str(payload.get("agentRole") or "").strip()
        model_id = str(payload.get("modelId") or "").strip()
        if not agent_role:
            return
        capabilities_url = _model_gateway_capabilities_url(
            str(capability.get("endpoint") or "")
        )
        if capabilities_url is None:
            return
        http = getattr(self._harness_gateway, "http", None)
        get_json = getattr(http, "get_json", None)
        if not callable(get_json):
            return
        try:
            response = get_json(capabilities_url)
        except Exception as exc:  # noqa: BLE001 — transport failure blocks model access.
            raise ModelGatewayUnavailableError(
                f"model gateway capabilities unavailable for agentRole {agent_role!r}"
            ) from exc
        if getattr(response, "status", None) != 200:
            raise ModelGatewayUnavailableError(
                f"model gateway capabilities unavailable for agentRole {agent_role!r}"
            )
        capabilities = getattr(response, "payload", None)
        if not isinstance(capabilities, Mapping):
            raise ModelGatewayUnavailableError("model gateway capabilities returned non-object response")
        roles = capabilities.get("roles")
        if not isinstance(roles, Sequence) or isinstance(roles, (str, bytes, bytearray)):
            raise ModelGatewayUnavailableError("model gateway capabilities missing role availability")
        for raw_role in roles:
            if not isinstance(raw_role, Mapping):
                continue
            if str(raw_role.get("role") or "").strip() != agent_role:
                continue
            status = str(raw_role.get("status") or "").strip().lower()
            available_raw = raw_role.get("availableModels")
            available_models = {
                str(item).strip()
                for item in available_raw
                if str(item).strip()
            } if isinstance(available_raw, Sequence) and not isinstance(available_raw, (str, bytes, bytearray)) else set()
            if status != "ok" or not available_models:
                reason = str(raw_role.get("reason") or "no approved active model for role").strip()
                raise ModelGatewayUnavailableError(
                    f"no approved model available for agentRole {agent_role!r}: {reason}"
                )
            if model_id and model_id not in available_models:
                raise ModelPolicyDeniedAgentError(
                    f"modelId {model_id!r} is not available for agentRole {agent_role!r}"
                )
            return
        raise ModelGatewayUnavailableError(
            f"model gateway capabilities missing agentRole {agent_role!r}"
        )


def _model_gateway_capabilities_url(endpoint: str) -> str | None:
    parsed = urllib.parse.urlparse(endpoint.strip())
    if not parsed.scheme or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/")
    if not path.endswith("/v0/invoke"):
        return None
    capabilities_path = f"{path[:-len('/v0/invoke')]}/v0/capabilities"
    return urllib.parse.urlunparse(
        parsed._replace(path=capabilities_path, query="", fragment="")
    )


def _normalised_model_gateway_endpoint(endpoint: str) -> str | None:
    parsed = urllib.parse.urlparse(endpoint.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/")
    if path != "/v0/invoke":
        return None
    return urllib.parse.urlunparse(
        parsed._replace(path=path, params="", query="", fragment="")
    )


def _validate_model_gateway_capability(
    capability: Mapping[str, JsonValue],
    capability_id: str,
    *,
    expected_capability: Mapping[str, JsonValue] | None = None,
) -> None:
    """Fail closed before prompt-bearing agent traffic leaves the orchestrator."""
    resolved_id = str(capability.get("id") or "").strip()
    if resolved_id != capability_id:
        raise ModelGatewayUnavailableError("model gateway capability id mismatch")

    resolved_endpoint = _normalised_model_gateway_endpoint(
        str(capability.get("endpoint") or "")
    )
    if resolved_endpoint is None:
        raise ModelGatewayUnavailableError("model gateway capability endpoint is not approved")

    if not expected_capability:
        return

    expected_id = str(expected_capability.get("id") or "").strip()
    if expected_id and expected_id != resolved_id:
        raise ModelGatewayUnavailableError("model gateway capability id does not match configured allowlist")

    expected_owner = str(expected_capability.get("owner") or "").strip()
    resolved_owner = str(capability.get("owner") or "").strip()
    if expected_owner and resolved_owner != expected_owner:
        raise ModelGatewayUnavailableError("model gateway capability owner is not approved")

    expected_data_class = str(expected_capability.get("dataClass") or "").strip()
    resolved_data_class = str(capability.get("dataClass") or "").strip()
    if expected_data_class and resolved_data_class != expected_data_class:
        raise ModelGatewayUnavailableError("model gateway capability dataClass is not approved")

    expected_endpoint = _normalised_model_gateway_endpoint(
        str(expected_capability.get("endpoint") or "")
    )
    if expected_endpoint is None or resolved_endpoint != expected_endpoint:
        raise ModelGatewayUnavailableError("model gateway capability endpoint does not match configured allowlist")


# ---------------------------------------------------------------------------
# Inner Java-candidate contract
# ---------------------------------------------------------------------------


def _parse_model_output_envelope(raw_output: Any) -> Mapping[str, JsonValue]:
    """Extract the Java-candidate JSON object from the model output.

    The Model Gateway returns an ``output`` field that is either already a
    JSON object (when ``structuredOutput=true``) or a string carrying JSON.
    The agent accepts both forms. Anything else fails validation.
    """
    if isinstance(raw_output, Mapping):
        return raw_output
    if isinstance(raw_output, str):
        text = raw_output.strip()
        if not text:
            raise AgentContractInvalidAgentError(
                "model output is empty; expected structured JSON"
            )
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise AgentContractInvalidAgentError(
                f"model output is not valid JSON: {exc}"
            ) from exc
        if not isinstance(parsed, Mapping):
            raise AgentContractInvalidAgentError(
                "model output JSON must be an object"
            )
        return parsed
    raise AgentContractInvalidAgentError(
        f"model output has unexpected type: {type(raw_output).__name__}"
    )


def _validate_inner_status(status: Any) -> str:
    if not isinstance(status, str):
        raise AgentContractInvalidAgentError("inner status must be a string")
    if status not in {"success", "blocked", "failed"}:
        raise AgentContractInvalidAgentError(
            f"inner status must be one of 'success'/'blocked'/'failed', got {status!r}"
        )
    return status


def _validate_inner_failure(envelope: Mapping[str, JsonValue], status: str) -> tuple[str, str]:
    if status == "blocked":
        unsupported_raw = envelope.get("unsupportedConstructs") or envelope.get("unsupported_constructs")
        if isinstance(unsupported_raw, str):
            has_unsupported = bool(unsupported_raw.strip())
        elif isinstance(unsupported_raw, Sequence):
            has_unsupported = any(str(item).strip() for item in unsupported_raw)
        else:
            has_unsupported = False
        if not has_unsupported:
            raise AgentContractInvalidAgentError(
                "status=blocked must include non-empty unsupportedConstructs"
            )
    failure_code = envelope.get("failureCode") or envelope.get("failure_code")
    failure_message = envelope.get("failureMessage") or envelope.get("failure_message")
    if status == "blocked":
        default_code = "unsupported_cobol"
    else:
        default_code = "java_generation_failed"
    if not isinstance(failure_code, str) or not failure_code.strip():
        failure_code = default_code
    if not isinstance(failure_message, str) or not failure_message.strip():
        failure_message = envelope.get("explanation") or envelope.get("reason") or status
        failure_message = str(failure_message)
    return failure_code, failure_message


def _decode_candidate(
    envelope: Mapping[str, JsonValue],
    *,
    max_output_bytes: int,
    default_package: str,
) -> GeneratedJavaCandidate:
    files_raw = envelope.get("files")
    if not isinstance(files_raw, Mapping) or not files_raw:
        raise AgentContractInvalidAgentError(
            "success response must include non-empty 'files' map"
        )
    files: dict[str, str] = {}
    total_bytes = 0
    has_java_shape = False
    for raw_path, raw_content in files_raw.items():
        path = _safe_relpath(raw_path)
        if path is None:
            raise AgentContractInvalidAgentError(
                f"invalid generated file path: {raw_path!r}"
            )
        if not path.lower().endswith(".java"):
            raise AgentContractInvalidAgentError(
                f"generated file {path!r} does not end in .java; non-Java output rejected"
            )
        if not isinstance(raw_content, str):
            raise AgentContractInvalidAgentError(
                f"generated file {path!r} content must be a string"
            )
        encoded_bytes = raw_content.encode("utf-8")
        total_bytes += len(encoded_bytes)
        if total_bytes > max_output_bytes:
            raise AgentContractInvalidAgentError(
                f"generated Java exceeds size limit ({total_bytes} > {max_output_bytes} bytes)"
            )
        if _JAVA_SHAPE_HINTS.search(raw_content):
            has_java_shape = True
        files[path] = raw_content
    if not has_java_shape:
        raise AgentContractInvalidAgentError(
            "no generated file contains a Java type declaration (class/interface/enum/record); non-Java content rejected"
        )

    entry_class = envelope.get("entryClass") or envelope.get("entry_class")
    if not isinstance(entry_class, str) or not _JAVA_IDENTIFIER.match(entry_class):
        raise AgentContractInvalidAgentError(
            f"missing or invalid entryClass identifier: {entry_class!r}"
        )
    entry_package_raw = envelope.get("entryPackage") or envelope.get("entry_package")
    if entry_package_raw is None or (isinstance(entry_package_raw, str) and not entry_package_raw.strip()):
        entry_package = default_package
    elif isinstance(entry_package_raw, str) and _JAVA_PACKAGE_PATTERN.match(entry_package_raw.strip()):
        entry_package = entry_package_raw.strip()
    else:
        raise AgentContractInvalidAgentError(
            f"invalid entryPackage identifier: {entry_package_raw!r}"
        )
    entry_file_path_raw = envelope.get("entryFilePath") or envelope.get("entry_file_path")
    entry_file_path: str | None
    if isinstance(entry_file_path_raw, str) and entry_file_path_raw.strip():
        entry_file_path = _safe_relpath(entry_file_path_raw)
        if entry_file_path is None:
            raise AgentContractInvalidAgentError(
                f"invalid entryFilePath: {entry_file_path_raw!r}"
            )
        if entry_file_path not in files:
            raise AgentContractInvalidAgentError(
                f"entryFilePath {entry_file_path!r} is not present in generated files"
            )
    else:
        # Try to derive the entry file path from package + class.
        derived_parts = entry_package.split(".") + [f"{entry_class}.java"]
        derived = "/".join(derived_parts)
        for candidate_prefix in ("src/main/java/", "src/", ""):
            candidate = candidate_prefix + derived
            if candidate in files:
                entry_file_path = candidate
                break
        else:
            raise AgentContractInvalidAgentError(
                "missing entryFilePath and no file matches the entryClass naming convention"
            )

    # The entry file must carry a package declaration that matches the
    # declared entry package. This catches cases where the model wrapped
    # COBOL prose in a Java filename or emitted inconsistent metadata.
    entry_content = files[entry_file_path]
    package_match = _JAVA_PACKAGE_LINE.search(entry_content)
    if package_match is None:
        raise AgentContractInvalidAgentError(
            f"entry file {entry_file_path!r} is missing a 'package' declaration"
        )
    declared_package = package_match.group(1)
    if declared_package != entry_package:
        raise AgentContractInvalidAgentError(
            f"entryPackage {entry_package!r} does not match package declaration {declared_package!r}"
        )

    unsupported_raw = envelope.get("unsupportedConstructs") or envelope.get("unsupported_constructs") or ()
    if isinstance(unsupported_raw, str):
        unsupported = (unsupported_raw,)
    elif isinstance(unsupported_raw, Sequence):
        unsupported = tuple(str(item) for item in unsupported_raw if str(item).strip())
    else:
        raise AgentContractInvalidAgentError(
            "unsupportedConstructs must be an array of strings"
        )

    explanation_raw = envelope.get("explanation") or envelope.get("notes") or ""
    explanation = str(explanation_raw) if explanation_raw is not None else ""

    return GeneratedJavaCandidate(
        files=files,
        entry_class=entry_class,
        entry_package=entry_package,
        entry_file_path=entry_file_path,
        unsupported_constructs=unsupported,
        explanation=explanation,
    )


# ---------------------------------------------------------------------------
# Transformation Agent
# ---------------------------------------------------------------------------


class TransformationAgent:
    """Orchestrator-invoked productive Transformation Agent.

    The agent's contract is exposed through one method: :meth:`invoke`.
    Construction wires the agent to the run artifact store, the Model
    Gateway invoker, and (optionally) the Harness event sink. None of those
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

    def invoke(self, request: TransformationAgentRequest) -> TransformationAgentResult:
        """Run one agent attempt and return a structured result.

        Raises :class:`TransformationAgentError` subclasses for failure
        modes that block the run (policy denial, gateway unavailability,
        timeout, contract-invalid). On success and on agent-driven
        ``blocked`` / ``failed`` outcomes, the method returns the structured
        result and never raises.
        """
        started_at = self._iso_now()
        attempt_dir = self._attempt_dir(request.attempt_number)

        # 1. Build, validate, persist the agent-invocation-request artifact.
        request_payload = self._build_invocation_request_payload(request, started_at)
        try:
            assert_no_secret_leak(request_payload)
            validate_invocation_request(request_payload)
        except AgentContractInvalidError as exc:
            raise AgentContractInvalidAgentError(
                f"agent-invocation-request failed contract validation: {'; '.join(exc.errors) or exc}"
            ) from exc
        request_meta = self._artifact_store.write_json(
            request.run_id,
            request.workflow_id,
            f"{attempt_dir}/agent-request.json",
            request_payload,
            kind=KIND_TRANSFORMATION_AGENT_REQUEST,
        )
        request_artifact_ref = self._meta_to_ref(request_meta)
        self._emit_event(
            request,
            event_type="orchestrator.agent.transformation.invoked",
            state_transition="agent.transformation.invoked",
            status="updating",
            input_payload={
                "runId": request.run_id,
                "attemptNumber": request.attempt_number,
                "promptTemplateId": self._config.transformation_agent_prompt_template_id,
            },
            output_payload={
                "requestRef": request_artifact_ref,
            },
        )

        # 2. Call the Model Gateway. Failures map to typed exceptions so the
        # Orchestrator can finalise the run with the right failure code.
        invoke_started = time.monotonic()
        try:
            gateway_response = self._call_model_gateway(request)
        except TransformationAgentError as exc:
            # Persist a synthetic failure response so the run timeline
            # always carries a structured artifact for the attempt.
            ended_at = self._iso_now()
            failed_response = self._build_contract_safe_failure_response(
                request,
                status="failed" if isinstance(exc, ModelGatewayUnavailableError)
                else ("policy_denied" if isinstance(exc, ModelPolicyDeniedAgentError)
                      else ("timeout" if isinstance(exc, AgentTimeoutError)
                            else "failed")),
                failure_code=exc.failure_code,
                failure_message=str(exc),
                started_at=started_at,
                ended_at=ended_at,
                model_invocation_id=f"inv-{request.run_id}-{request.attempt_number:02d}-failed",
                model_provider="foundry-development",
            )
            response_meta = self._artifact_store.write_json(
                request.run_id,
                request.workflow_id,
                f"{attempt_dir}/agent-response.json",
                failed_response,
                kind=KIND_TRANSFORMATION_AGENT_RESPONSE,
            )
            self._emit_event(
                request,
                event_type="orchestrator.agent.transformation.failed",
                state_transition="agent.transformation.failed",
                status="failed",
                input_payload={"runId": request.run_id},
                output_payload={
                    "failureCode": exc.failure_code,
                    "failureMessage": str(failed_response["failureMessage"]),
                    "responseRef": self._meta_to_ref(response_meta),
                    "trajectoryRecord": dict(failed_response["trajectoryRecord"]),
                },
            )
            raise

        latency_ms = max(0, int((time.monotonic() - invoke_started) * 1000))
        ended_at = self._iso_now()

        # 3. Parse and validate the model output. Errors here are surfaced
        # as AgentContractInvalidAgentError so the Orchestrator records
        # ``agent_contract_invalid``.
        try:
            model_invocation_ref = _model_invocation_ref_from_gateway(request, gateway_response)
            inner_envelope = _parse_model_output_envelope(gateway_response.get("output"))
            inner_status = _validate_inner_status(inner_envelope.get("status"))
            candidate: GeneratedJavaCandidate | None = None
            failure_code: str | None = None
            failure_message: str | None = None
            unsupported_constructs_raw = inner_envelope.get(
                "unsupportedConstructs"
            ) or inner_envelope.get("unsupported_constructs") or ()
            if inner_status == "success":
                if isinstance(unsupported_constructs_raw, Sequence) and not isinstance(
                    unsupported_constructs_raw, str
                ):
                    has_unsupported = any(
                        bool(str(item).strip()) for item in unsupported_constructs_raw
                    )
                else:
                    has_unsupported = bool(str(unsupported_constructs_raw).strip())
                if has_unsupported:
                    # Unsupported COBOL must be reported as blocked, never
                    # success. Build/test cannot verify a candidate that the
                    # model itself says came from unsupported source semantics.
                    raise AgentContractInvalidAgentError(
                        "status=success but unsupportedConstructs present; must be blocked"
                    )
                candidate = _decode_candidate(
                    inner_envelope,
                    max_output_bytes=self._config.transformation_agent_max_output_bytes,
                    default_package=self._config.transformation_agent_package_base,
                )
            else:
                failure_code, failure_message = _validate_inner_failure(
                    inner_envelope, inner_status
                )
        except AgentContractInvalidAgentError as exc:
            failed_response = self._build_contract_safe_failure_response(
                request,
                status="failed",
                failure_code=exc.failure_code,
                failure_message=str(exc),
                started_at=started_at,
                ended_at=ended_at,
                model_invocation_id=str(gateway_response.get("invocationId") or "")
                or f"inv-{request.run_id}-{request.attempt_number:02d}-invalid",
                model_provider=str(gateway_response.get("provider") or "foundry-development"),
                _latency_ms=latency_ms,
            )
            response_meta = self._artifact_store.write_json(
                request.run_id,
                request.workflow_id,
                f"{attempt_dir}/agent-response.json",
                failed_response,
                kind=KIND_TRANSFORMATION_AGENT_RESPONSE,
            )
            self._emit_event(
                request,
                event_type="orchestrator.agent.transformation.invalid",
                state_transition="agent.transformation.failed",
                status="failed",
                input_payload={"runId": request.run_id},
                output_payload={
                    "failureCode": exc.failure_code,
                    "failureMessage": str(failed_response["failureMessage"]),
                    "responseRef": self._meta_to_ref(response_meta),
                    "trajectoryRecord": dict(failed_response["trajectoryRecord"]),
                },
            )
            raise

        # 4. Persist the Java candidate as run artifacts. The persisted
        # manifest is the source of truth for downstream consumers.
        output_artifact_refs: list[JsonObject] = []
        persisted_artifacts: list[JsonObject] = []
        java_candidate_ref: JsonObject | None = None
        if candidate is not None:
            for relpath, content in sorted(candidate.files.items()):
                file_meta = self._artifact_store.write_text(
                    request.run_id,
                    request.workflow_id,
                    f"{attempt_dir}/java/{relpath}",
                    content,
                    kind=KIND_TRANSFORMATION_AGENT_JAVA_FILE,
                    mime_type=MIME_JAVA,
                )
                persisted_artifacts.append(file_meta.to_dict())
            manifest_payload = {
                "runId": request.run_id,
                "workflowId": request.workflow_id,
                "attemptNumber": request.attempt_number,
                "sourceProgramId": _source_program_id(request),
                "generationSource": "agent",
                "targetLanguage": "java",
                "modelInvocationRef": model_invocation_ref,
                "semanticIrRef": (
                    _coerce_artifact_ref(request.semantic_ir_ref)
                    if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref)
                    else None
                ),
                "baselineJavaRef": (
                    _coerce_artifact_ref(request.baseline_java_ref)
                    if request.baseline_java_ref and _looks_like_artifact_ref(request.baseline_java_ref)
                    else None
                ),
                "sourceProgramRef": _coerce_artifact_ref(request.source_ref),
                **candidate.to_manifest(),
            }
            manifest_meta = self._artifact_store.write_json(
                request.run_id,
                request.workflow_id,
                f"{attempt_dir}/generated-project-manifest.json",
                manifest_payload,
                kind=KIND_TRANSFORMATION_AGENT_PROJECT_MANIFEST,
            )
            persisted_artifacts.append(manifest_meta.to_dict())
            java_candidate_ref = self._meta_to_ref(manifest_meta)
            output_artifact_refs.append(java_candidate_ref)

        # 5. Build, validate, persist the agent-invocation-response artifact.
        response_payload = self._build_invocation_response_payload(
            request,
            inner_status=inner_status,
            gateway_response=gateway_response,
            started_at=started_at,
            ended_at=ended_at,
            _latency_ms=latency_ms,
            output_artifact_refs=output_artifact_refs,
            java_candidate_ref=java_candidate_ref,
            failure_code=failure_code,
            failure_message=failure_message,
            _unsupported_constructs=(
                candidate.unsupported_constructs
                if candidate is not None
                else tuple(
                    str(item)
                    for item in (
                        inner_envelope.get("unsupportedConstructs")
                        or inner_envelope.get("unsupported_constructs")
                        or ()
                    )
                    if isinstance(item, str) and item.strip()
                )
            ),
        )
        try:
            guard_agent_response(response_payload)
        except AgentContractInvalidError as exc:
            raise AgentContractInvalidAgentError(
                f"agent invocation response failed schema validation: {'; '.join(exc.errors) or exc}"
            ) from exc

        response_meta = self._artifact_store.write_json(
            request.run_id,
            request.workflow_id,
            f"{attempt_dir}/agent-response.json",
            response_payload,
            kind=KIND_TRANSFORMATION_AGENT_RESPONSE,
        )
        persisted_artifacts.append(response_meta.to_dict())

        self._emit_event(
            request,
            event_type=(
                "orchestrator.agent.transformation.completed"
                if inner_status == "success"
                else f"orchestrator.agent.transformation.{inner_status}"
            ),
            state_transition=f"agent.transformation.{inner_status}",
            status="ok" if inner_status == "success" else inner_status,
            input_payload={"runId": request.run_id, "attemptNumber": request.attempt_number},
            output_payload={
                "status": inner_status,
                "responseRef": self._meta_to_ref(response_meta),
                "javaCandidateRef": java_candidate_ref,
                "failureCode": failure_code,
                "trajectoryRecord": dict(response_payload["trajectoryRecord"]),
            },
            latency_ms=latency_ms,
        )

        model_invocation_ref = response_payload["modelInvocationRef"]
        return TransformationAgentResult(
            status=inner_status,
            candidate=candidate,
            failure_code=failure_code,
            failure_message=failure_message,
            model_invocation_ref=dict(model_invocation_ref),
            java_candidate_ref=java_candidate_ref,
            output_artifact_refs=list(output_artifact_refs),
            trajectory_record=dict(response_payload["trajectoryRecord"]),
            response_payload=dict(response_payload),
            request_payload=dict(request_payload),
            request_artifact_ref=request_artifact_ref,
            response_artifact_ref=self._meta_to_ref(response_meta),
            persisted_artifacts=list(persisted_artifacts),
        )

    # ----- helpers ---------------------------------------------------------

    def _iso_now(self) -> str:
        return _iso_now(self._clock)

    @staticmethod
    def _attempt_dir(attempt_number: int) -> str:
        return f"{TRANSFORMATION_AGENT_DIR}/attempt-{attempt_number:02d}"

    @staticmethod
    def _meta_to_ref(meta: ArtifactMetadata) -> JsonObject:
        return {
            "uri": meta.uri,
            "sha256": meta.sha256,
            "byteSize": meta.byteSize,
            "mimeType": meta.mimeType,
            "kind": meta.kind,
        }

    def _build_invocation_request_payload(
        self,
        request: TransformationAgentRequest,
        requested_at: str,
    ) -> JsonObject:
        """Materialise the ``agent-invocation-request-v0`` payload."""
        input_artifact_refs: list[JsonObject] = [_coerce_artifact_ref(request.source_ref)]
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            input_artifact_refs.append(_coerce_artifact_ref(request.semantic_ir_ref))
        if request.baseline_java_ref and _looks_like_artifact_ref(request.baseline_java_ref):
            input_artifact_refs.append(_coerce_artifact_ref(request.baseline_java_ref))
        if request.oracle_ref and _looks_like_artifact_ref(request.oracle_ref):
            input_artifact_refs.append(_coerce_artifact_ref(request.oracle_ref))

        # Issue #167: the request schema embeds a model-invocation reference
        # to bind the invocation to a specific policy decision. Because the
        # actual model invocation happens later, the orchestrator pre-stamps
        # a deterministic invocation id that the gateway can reuse via the
        # ``invocationId`` parameter, or overwrite. The reference points
        # forward to the audit record the gateway will produce.
        provisional_invocation_id = (
            f"inv-{request.run_id}-{request.attempt_number:02d}-transformation"
        )

        payload: JsonObject = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "agentRole": AGENT_ROLE,
            "capabilityRef": {
                "capabilityId": request.capability_id,
                "capabilityVersion": request.capability_version or "v0",
                "providerService": request.capability_provider or "model-gateway-service",
                "resolvedAt": request.capability_resolved_at or requested_at,
            },
            "promptTemplateId": self._config.transformation_agent_prompt_template_id,
            "promptTemplateVersion": self._config.transformation_agent_prompt_template_version,
            "inputArtifactRefs": input_artifact_refs,
            "policyDecisionRef": {
                "policyVersion": request.policy_version or "v0",
                "decision": "policy allow",
                "decidedAt": requested_at,
            },
            "modelInvocationRef": {
                "invocationId": provisional_invocation_id,
                "modelId": request.model_id,
                "provider": "foundry-development",
            },
            "deadlineMs": int(request.deadline_ms),
            "requestedAt": requested_at,
        }
        if request.trace_ref:
            payload["traceRef"] = request.trace_ref
        return payload

    def _build_invocation_response_payload(
        self,
        request: TransformationAgentRequest,
        *,
        inner_status: str,
        gateway_response: Mapping[str, JsonValue],
        started_at: str,
        ended_at: str,
        _latency_ms: int,
        output_artifact_refs: Sequence[Mapping[str, JsonValue]],
        java_candidate_ref: Mapping[str, JsonValue] | None,
        failure_code: str | None,
        failure_message: str | None,
        _unsupported_constructs: Sequence[str],
    ) -> JsonObject:
        model_invocation_ref = _model_invocation_ref_from_gateway(request, gateway_response)
        invocation_id = str(model_invocation_ref["invocationId"])

        trajectory_record = {
            "ledgerEntryId": f"traj-{request.run_id}-{request.attempt_number:02d}-transformation",
            "actor": AGENT_ROLE,
            "dataClass": "generator",
            "stateTransition": f"agent.transformation.{inner_status}",
            "createdAt": ended_at,
            "relatedRecords": [invocation_id],
        }

        payload: JsonObject = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "agentRole": AGENT_ROLE,
            "status": inner_status,
            "modelInvocationRef": model_invocation_ref,
            "promptTemplateId": self._config.transformation_agent_prompt_template_id,
            "promptTemplateVersion": self._config.transformation_agent_prompt_template_version,
            "startedAt": started_at,
            "endedAt": ended_at,
            "trajectoryRecord": trajectory_record,
            "outputArtifactRefs": [dict(ref) for ref in output_artifact_refs],
            "toolUseRecords": [
                {
                    "toolId": "model-gateway",
                    "toolVersion": request.capability_version or "v0",
                    "surface": "model-gateway",
                    "invokedAt": started_at,
                    "endedAt": ended_at,
                    "status": _tool_status_for_agent_status(inner_status),
                }
            ],
            "capabilityRef": {
                "capabilityId": request.capability_id,
                "capabilityVersion": request.capability_version or "v0",
                "providerService": request.capability_provider or "model-gateway-service",
                "resolvedAt": request.capability_resolved_at or started_at,
            },
        }
        if java_candidate_ref is not None:
            payload["javaCandidateRef"] = dict(java_candidate_ref)
        if inner_status != "success":
            payload["failureCode"] = failure_code or "java_generation_failed"
            payload["failureMessage"] = failure_message or inner_status
            # The schema requires outputArtifactRefs for success but it's
            # an array regardless; clamp non-success to an empty list when
            # the agent produced no artifacts.
            if not payload["outputArtifactRefs"]:
                payload["outputArtifactRefs"] = []
        if request.trace_ref:
            payload["traceRef"] = request.trace_ref
        return payload

    def _build_failure_response(
        self,
        request: TransformationAgentRequest,
        *,
        status: str,
        failure_code: str,
        failure_message: str,
        started_at: str,
        ended_at: str,
        model_invocation_id: str,
        model_provider: str,
        _latency_ms: int = 0,
    ) -> JsonObject:
        """Materialise a contract-shaped failure response for persistence.

        Used on early-failure paths (gateway unavailability, policy denial,
        contract-invalid output) so the run timeline always carries a
        structured response artifact for the attempt.
        """
        provider = (
            model_provider
            if model_provider in {"foundry-development", "customer-internal-mock"}
            else "foundry-development"
        )
        trajectory_record = {
            "ledgerEntryId": f"traj-{request.run_id}-{request.attempt_number:02d}-transformation-failed",
            "actor": AGENT_ROLE,
            "dataClass": "generator",
            "stateTransition": f"agent.transformation.{status}",
            "createdAt": ended_at,
            "relatedRecords": [model_invocation_id],
        }
        payload: JsonObject = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "attemptNumber": int(request.attempt_number),
            "agentRole": AGENT_ROLE,
            "status": status,
            "failureCode": failure_code,
            "failureMessage": failure_message,
            "modelInvocationRef": {
                "invocationId": model_invocation_id,
                "modelId": request.model_id,
                "provider": provider,
            },
            "promptTemplateId": self._config.transformation_agent_prompt_template_id,
            "promptTemplateVersion": self._config.transformation_agent_prompt_template_version,
            "startedAt": started_at,
            "endedAt": ended_at,
            "trajectoryRecord": trajectory_record,
            "outputArtifactRefs": [],
            "toolUseRecords": [
                {
                    "toolId": "model-gateway",
                    "toolVersion": request.capability_version or "v0",
                    "surface": "model-gateway",
                    "invokedAt": started_at,
                    "endedAt": ended_at,
                    "status": _tool_status_for_agent_status(status),
                    "errorClass": failure_code,
                }
            ],
            "capabilityRef": {
                "capabilityId": request.capability_id,
                "capabilityVersion": request.capability_version or "v0",
                "providerService": request.capability_provider or "model-gateway-service",
                "resolvedAt": request.capability_resolved_at or started_at,
            },
        }
        if request.trace_ref:
            payload["traceRef"] = request.trace_ref
        return payload

    def _build_contract_safe_failure_response(
        self,
        request: TransformationAgentRequest,
        *,
        status: str,
        failure_code: str,
        failure_message: str,
        started_at: str,
        ended_at: str,
        model_invocation_id: str,
        model_provider: str,
        _latency_ms: int = 0,
    ) -> JsonObject:
        """Build a failure response, redacting only if the contract guard trips."""
        response = self._build_failure_response(
            request,
            status=status,
            failure_code=failure_code,
            failure_message=failure_message,
            started_at=started_at,
            ended_at=ended_at,
            model_invocation_id=model_invocation_id,
            model_provider=model_provider,
            _latency_ms=_latency_ms,
        )
        try:
            guard_agent_response(response)
            return response
        except AgentContractInvalidError:
            redacted = self._build_failure_response(
                request,
                status=status,
                failure_code=failure_code,
                failure_message=(
                    f"{failure_code}: failure details redacted by agent contract guard"
                ),
                started_at=started_at,
                ended_at=ended_at,
                model_invocation_id=model_invocation_id,
                model_provider=model_provider,
                _latency_ms=_latency_ms,
            )
            guard_agent_response(redacted)
            return redacted

    def _call_model_gateway(
        self, request: TransformationAgentRequest
    ) -> JsonObject:
        """Build the Model Gateway request and call the configured invoker.

        The agent does not embed direct provider HTTP calls. The invoker is
        expected to talk to the Harness-registered ``model-gateway``
        capability so policy enforcement, audit, and the model invocation
        ledger happen at the gateway, not at the agent boundary.
        """
        prompt_payload = self._build_model_prompt(request)
        invoke_payload = {
            "schemaVersion": "v0",
            "runId": request.run_id,
            "workflowId": request.workflow_id,
            "actor": "orchestrator-service",
            "agentRole": MODEL_GATEWAY_AGENT_ROLE,
            "modelId": request.model_id,
            "dataClass": "model-gateway",
            "promptTemplateVersion": self._config.transformation_agent_prompt_template_version,
            "prompt": prompt_payload,
            "structuredOutput": True,
            "structuredOutputSchema": _TRANSFORMATION_INNER_OUTPUT_SCHEMA,
            "parameters": {
                "runId": request.run_id,
                "attemptNumber": int(request.attempt_number),
                "promptTemplateId": self._config.transformation_agent_prompt_template_id,
                "sourceRef": _coerce_artifact_ref(request.source_ref),
            },
            "timeoutMs": int(request.deadline_ms),
        }
        if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref):
            invoke_payload["parameters"]["semanticIrRef"] = _coerce_artifact_ref(request.semantic_ir_ref)
        if request.baseline_java_ref and _looks_like_artifact_ref(request.baseline_java_ref):
            invoke_payload["parameters"]["baselineJavaRef"] = _coerce_artifact_ref(request.baseline_java_ref)
        if request.oracle_ref and _looks_like_artifact_ref(request.oracle_ref):
            invoke_payload["parameters"]["oracleRef"] = _coerce_artifact_ref(request.oracle_ref)

        try:
            response = self._model_invoker.invoke(invoke_payload)
        except TransformationAgentError:
            raise
        except HarnessFailure as exc:
            raise _classify_gateway_failure(exc) from exc
        except Exception as exc:  # noqa: BLE001 — any transport error is unavailability.
            raise _classify_gateway_failure(exc) from exc
        if not isinstance(response, Mapping):
            raise ModelGatewayUnavailableError("model gateway returned non-object response")
        return dict(response)

    def _build_model_prompt(self, request: TransformationAgentRequest) -> str:
        """Compose the policy-controlled prompt body sent to the gateway.

        The prompt is *not* a chat user turn. It is the structured task
        envelope identified by ``promptTemplateId``. The actual prompt
        template lives outside the agent (in the Model Gateway prompt
        registry); the agent fills in the structured slots and references
        the template by id so the registry author and the gateway both
        agree on what is being asked.

        The returned string is JSON for forward compatibility — the model
        gateway accepts it as the ``prompt`` field and forwards a rendered
        template body. The orchestrator does not embed COBOL source in
        free-form text; the source artifact reference plus the source text
        are both available so the gateway can decide which to forward.
        """
        envelope = {
            "promptTemplateId": self._config.transformation_agent_prompt_template_id,
            "promptTemplateVersion": self._config.transformation_agent_prompt_template_version,
            "task": "cobol-to-java-transformation",
            "targetLanguage": "java",
            "targetJavaVersion": self._config.transformation_agent_java_version,
            "targetPackageBase": self._config.transformation_agent_package_base,
            "targetRuntimeLibrary": self._config.transformation_agent_runtime_library,
            "supportedW0Subset": list(self._config.transformation_agent_w0_subset),
            "sourceProgramId": _source_program_id(request),
            "sourceText": request.source_text,
            "sourceRef": _coerce_artifact_ref(request.source_ref),
            "semanticIrRef": (
                _coerce_artifact_ref(request.semantic_ir_ref)
                if request.semantic_ir_ref and _looks_like_artifact_ref(request.semantic_ir_ref)
                else None
            ),
            "baselineJavaRef": (
                _coerce_artifact_ref(request.baseline_java_ref)
                if request.baseline_java_ref and _looks_like_artifact_ref(request.baseline_java_ref)
                else None
            ),
            "baselineFiles": dict(request.baseline_files or {}) or None,
            "oracleRef": (
                _coerce_artifact_ref(request.oracle_ref)
                if request.oracle_ref and _looks_like_artifact_ref(request.oracle_ref)
                else None
            ),
            "outputContract": {
                "shape": "transformation-agent-inner-v0",
                "schemaRef": _TRANSFORMATION_INNER_OUTPUT_SCHEMA_ID,
            },
        }
        return json.dumps(envelope, sort_keys=True, ensure_ascii=False)

    def _emit_event(
        self,
        request: TransformationAgentRequest,
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
        input_canonical = _canonical_json_bytes(dict(input_payload))
        output_canonical = _canonical_json_bytes(dict(output_payload))
        event: JsonObject = {
            "eventType": event_type,
            "schemaVersion": "v0",
            "service": "orchestrator-service",
            "runId": request.run_id,
            "actor": AGENT_ROLE,
            "capability": request.capability_id,
            "dataClass": DATA_CLASS_GENERATOR,
            "redactionProfile": "harness-control-plane",
            "policyDecision": "policy allow",
            "status": status,
            "stateTransition": state_transition,
            "createdAt": now,
            "inputRef": {
                "uri": f"urn:orchestrator/{request.run_id}/transformation-agent/{request.attempt_number}/in",
                "sha256": sha256(input_canonical).hexdigest(),
                "byteSize": len(input_canonical),
            },
            "outputRef": {
                "uri": f"urn:orchestrator/{request.run_id}/transformation-agent/{request.attempt_number}/out",
                "sha256": sha256(output_canonical).hexdigest(),
                "byteSize": len(output_canonical),
            },
            "payload": {
                "input": dict(input_payload),
                "output": dict(output_payload),
            },
        }
        if latency_ms is not None:
            event["latencyMs"] = int(latency_ms)
        try:
            self._harness_events.post_event(event)
        except Exception:  # pragma: no cover — event emission is best-effort
            return


# ---------------------------------------------------------------------------
# Inner structured-output schema published to the Model Gateway
# ---------------------------------------------------------------------------


_TRANSFORMATION_INNER_OUTPUT_SCHEMA_ID = (
    "https://oscharko.dev/c2c/schemas/transformation-agent-inner-v0.json"
)


_TRANSFORMATION_INNER_OUTPUT_SCHEMA: JsonObject = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": _TRANSFORMATION_INNER_OUTPUT_SCHEMA_ID,
    "title": "Transformation Agent Inner Output v0",
    "description": (
        "Schema the Model Gateway uses to constrain the structured output "
        "returned by the Transformation Agent's model invocation. The "
        "orchestrator validates the returned object against this shape "
        "in agent_contracts and rejects anything outside it."
    ),
    "type": "object",
    "required": ["status"],
    "properties": {
        "status": {"type": "string", "enum": ["success", "blocked", "failed"]},
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
        "failureCode": {"type": "string"},
        "failureMessage": {"type": "string"},
    },
    "additionalProperties": False,
}


__all__ = [
    "AGENT_ROLE",
    "AgentContractInvalidAgentError",
    "AgentTimeoutError",
    "ArtifactRef",
    "GeneratedJavaCandidate",
    "HarnessEventSink",
    "HarnessModelGatewayInvoker",
    "ModelGatewayInvoker",
    "ModelGatewayUnavailableError",
    "ModelPolicyDeniedAgentError",
    "TRANSFORMATION_AGENT_DIR",
    "TransformationAgent",
    "TransformationAgentError",
    "TransformationAgentRequest",
    "TransformationAgentResult",
]
