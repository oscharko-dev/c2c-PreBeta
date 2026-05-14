"""Configuration helpers for the orchestrator service."""

from dataclasses import dataclass
import os


DEFAULT_LISTEN_ADDR = "0.0.0.0:8084"
DEFAULT_HARNESS_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_WORKFLOW_ID = "w0-migration-v0"
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_DELAY_MS = 200
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5
DEFAULT_PARSE_CAPABILITY = "cobol.parse"
DEFAULT_IR_CAPABILITY = "cobol.ir"
DEFAULT_GENERATOR_CAPABILITY = "java.generator"
DEFAULT_BUILD_TEST_CAPABILITY = "java.build-test"
DEFAULT_EVIDENCE_CAPABILITY = "evidence.writer"
DEFAULT_MODEL_GATEWAY_CAPABILITY = "model-gateway"


@dataclass(frozen=True)
class OrchestratorConfig:
    listen_addr: str
    harness_base_url: str
    workflow_id: str
    max_retries: int
    retry_delay_ms: int
    request_timeout_seconds: int
    parse_capability_id: str
    ir_capability_id: str
    generator_capability_id: str
    build_test_capability_id: str
    evidence_capability_id: str
    model_gateway_capability_id: str
    service_name: str = "orchestrator-service"


def _read_env_int(name: str, default: int) -> int:
    value = os.environ.get(name, str(default)).strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative")
    return parsed


def load_config() -> OrchestratorConfig:
    listen_addr = os.environ.get("ORCHESTRATOR_LISTEN_ADDR", DEFAULT_LISTEN_ADDR).strip()
    if not listen_addr:
        listen_addr = DEFAULT_LISTEN_ADDR

    if not listen_addr.startswith(":") and ":" not in listen_addr:
        # compatibility with service snippets that set only a port number
        listen_addr = f"0.0.0.0:{listen_addr}"

    harness_base_url = os.environ.get("ORCHESTRATOR_HARNESS_BASE_URL", DEFAULT_HARNESS_BASE_URL).strip()
    if not harness_base_url:
        raise ValueError("ORCHESTRATOR_HARNESS_BASE_URL is required")

    workflow_id = os.environ.get("ORCHESTRATOR_WORKFLOW_ID", DEFAULT_WORKFLOW_ID).strip()
    if not workflow_id:
        raise ValueError("ORCHESTRATOR_WORKFLOW_ID is required")

    max_retries = _read_env_int("ORCHESTRATOR_MAX_RETRIES", DEFAULT_MAX_RETRIES)
    retry_delay_ms = _read_env_int("ORCHESTRATOR_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS)
    request_timeout_seconds = _read_env_int(
        "ORCHESTRATOR_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_REQUEST_TIMEOUT_SECONDS,
    )
    parse_capability_id = os.environ.get("ORCHESTRATOR_PARSE_CAPABILITY_ID", DEFAULT_PARSE_CAPABILITY).strip()
    ir_capability_id = os.environ.get("ORCHESTRATOR_IR_CAPABILITY_ID", DEFAULT_IR_CAPABILITY).strip()
    generator_capability_id = os.environ.get("ORCHESTRATOR_GENERATOR_CAPABILITY_ID", DEFAULT_GENERATOR_CAPABILITY).strip()
    build_test_capability_id = os.environ.get("ORCHESTRATOR_BUILD_TEST_CAPABILITY_ID", DEFAULT_BUILD_TEST_CAPABILITY).strip()
    evidence_capability_id = os.environ.get("ORCHESTRATOR_EVIDENCE_CAPABILITY_ID", DEFAULT_EVIDENCE_CAPABILITY).strip()
    model_gateway_capability_id = os.environ.get(
        "ORCHESTRATOR_MODEL_GATEWAY_CAPABILITY_ID",
        DEFAULT_MODEL_GATEWAY_CAPABILITY,
    ).strip()

    if not parse_capability_id or not ir_capability_id or not generator_capability_id or not build_test_capability_id or not evidence_capability_id:
        raise ValueError("capability ids are required")

    return OrchestratorConfig(
        listen_addr=listen_addr,
        harness_base_url=harness_base_url,
        workflow_id=workflow_id,
        max_retries=max_retries,
        retry_delay_ms=retry_delay_ms,
        request_timeout_seconds=request_timeout_seconds,
        parse_capability_id=parse_capability_id,
        ir_capability_id=ir_capability_id,
        generator_capability_id=generator_capability_id,
        build_test_capability_id=build_test_capability_id,
        evidence_capability_id=evidence_capability_id,
        model_gateway_capability_id=model_gateway_capability_id,
    )
