"""Configuration helpers for the orchestrator service."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .artifacts import DEFAULT_RUN_ARTIFACT_ROOT


DEFAULT_LISTEN_ADDR = "0.0.0.0:8084"
DEFAULT_HARNESS_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_EXPERIENCE_LEARNING_BASE_URL = ""
DEFAULT_WORKFLOW_ID = "w0-migration-v0"
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_DELAY_MS = 200
DEFAULT_REQUEST_TIMEOUT_SECONDS = 5
DEFAULT_PARSE_CAPABILITY = "cobol.parse"
DEFAULT_IR_CAPABILITY = "cobol.ir"
DEFAULT_GENERATOR_CAPABILITY = "target.java.generate"
DEFAULT_BUILD_TEST_CAPABILITY = "build-test.run"
DEFAULT_EVIDENCE_CAPABILITY = "evidence.writer"
DEFAULT_MODEL_GATEWAY_CAPABILITY = "model-gateway"
DEFAULT_MODEL_GATEWAY_MODEL_ID = "gpt-oss-120b"
DEFAULT_MODEL_POLICY_VERSION = "v0"
DEFAULT_CAPABILITY_POLICY_PROFILE = "harness-control-plane"
DEFAULT_CAPABILITY_VERSION = "v0.1.0"

# Issue #166: hard W0.2 bounds for the bounded repair loop. The default is two
# attempts; the limit is clamped to [1, 3] so configuration cannot escape the
# W0.2 contract.
DEFAULT_REPAIR_BUDGET_MAX = 2
REPAIR_BUDGET_MIN = 1
REPAIR_BUDGET_MAX = 3

# Issue #169: defaults for the productive Transformation Agent.
DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID = "c2c.transformation-agent.cobol-to-java.v0"
DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION = "v0"
DEFAULT_TRANSFORMATION_AGENT_DEADLINE_MS = 30000
DEFAULT_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES = 1024 * 1024
DEFAULT_TRANSFORMATION_AGENT_PACKAGE_BASE = "com.c2c.generated"
DEFAULT_TRANSFORMATION_AGENT_JAVA_VERSION = "21"
DEFAULT_TRANSFORMATION_AGENT_RUNTIME_LIBRARY = "c2c-target-java-runtime"
DEFAULT_TRANSFORMATION_AGENT_W0_SUBSET: tuple[str, ...] = (
    "IDENTIFICATION DIVISION",
    "DATA DIVISION",
    "PROCEDURE DIVISION",
    "DISPLAY",
    "STOP RUN",
    "MOVE",
    "ADD",
    "SUBTRACT",
    "COMPUTE",
    "IF",
    "PERFORM",
)

DEFAULT_PARSER_SERVICE_HOST = "127.0.0.1"
DEFAULT_PARSER_SERVICE_PORT = 8081
DEFAULT_IR_SERVICE_HOST = "127.0.0.1"
DEFAULT_IR_SERVICE_PORT = 8082
DEFAULT_GENERATOR_SERVICE_HOST = "127.0.0.1"
DEFAULT_GENERATOR_SERVICE_PORT = 8083
DEFAULT_BUILD_TEST_SERVICE_HOST = "127.0.0.1"
DEFAULT_BUILD_TEST_SERVICE_PORT = 8084
DEFAULT_EVIDENCE_SERVICE_HOST = "127.0.0.1"
DEFAULT_EVIDENCE_SERVICE_PORT = 8080
DEFAULT_MODEL_GATEWAY_SERVICE_HOST = "127.0.0.1"
DEFAULT_MODEL_GATEWAY_SERVICE_PORT = 8085


DEFAULT_W0_CAPABILITIES = [
    {
        "id": DEFAULT_PARSE_CAPABILITY,
        "name": "COBOL Parser",
        "owner": "cobol-parser-service",
        "endpoint": f"http://{DEFAULT_PARSER_SERVICE_HOST}:{DEFAULT_PARSER_SERVICE_PORT}/v0/parse",
        "dataClass": "parser",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Parses COBOL source and returns a normalized program model.",
    },
    {
        "id": DEFAULT_IR_CAPABILITY,
        "name": "Semantic IR Generator",
        "owner": "semantic-ir-service",
        "endpoint": f"http://{DEFAULT_IR_SERVICE_HOST}:{DEFAULT_IR_SERVICE_PORT}/v0/ir",
        "dataClass": "parser",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Builds Semantic IR from parser output.",
    },
    {
        "id": DEFAULT_GENERATOR_CAPABILITY,
        "name": "Target Java Generator",
        "owner": "target-java-generation-service",
        "endpoint": f"http://{DEFAULT_GENERATOR_SERVICE_HOST}:{DEFAULT_GENERATOR_SERVICE_PORT}/v0/generate",
        "dataClass": "generator",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Generates Java projects from Semantic IR.",
    },
    {
        "id": DEFAULT_BUILD_TEST_CAPABILITY,
        "name": "Build/Test Runner",
        "owner": "build-test-runner-service",
        "endpoint": f"http://{DEFAULT_BUILD_TEST_SERVICE_HOST}:{DEFAULT_BUILD_TEST_SERVICE_PORT}/v0/run-verification",
        "dataClass": "build-test",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Builds and executes generated Java projects.",
    },
    {
        "id": DEFAULT_EVIDENCE_CAPABILITY,
        "name": "Evidence Pack Writer",
        "owner": "evidence-service",
        "endpoint": f"http://{DEFAULT_EVIDENCE_SERVICE_HOST}:{DEFAULT_EVIDENCE_SERVICE_PORT}/v0/packs",
        "dataClass": "evidence",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Writes Evidence Pack manifests for W0 migration runs.",
    },
    {
        "id": DEFAULT_MODEL_GATEWAY_CAPABILITY,
        "name": "Model Gateway",
        "owner": "model-gateway-service",
        "endpoint": f"http://{DEFAULT_MODEL_GATEWAY_SERVICE_HOST}:{DEFAULT_MODEL_GATEWAY_SERVICE_PORT}/v0/invoke",
        "dataClass": "model-gateway",
        "policyProfile": DEFAULT_CAPABILITY_POLICY_PROFILE,
        "version": DEFAULT_CAPABILITY_VERSION,
        "description": "Routes optional model guidance through the governed model gateway.",
    },
]


# noinspection PyClassHasNoInitInspection
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
    w0_capabilities: tuple[dict[str, Any], ...]
    harness_token: str = ""
    service_name: str = "orchestrator-service"
    model_gateway_model_id: str = DEFAULT_MODEL_GATEWAY_MODEL_ID
    model_policy_version: str = DEFAULT_MODEL_POLICY_VERSION
    run_artifact_root: str = DEFAULT_RUN_ARTIFACT_ROOT
    experience_learning_base_url: str = DEFAULT_EXPERIENCE_LEARNING_BASE_URL
    repair_budget_max: int = DEFAULT_REPAIR_BUDGET_MAX
    # Issue #169: productive Transformation Agent defaults. The orchestrator
    # treats these as in-process configuration; values are stamped on the
    # agent invocation request and used to bound the model output.
    transformation_agent_prompt_template_id: str = DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID
    transformation_agent_prompt_template_version: str = DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION
    transformation_agent_deadline_ms: int = DEFAULT_TRANSFORMATION_AGENT_DEADLINE_MS
    transformation_agent_max_output_bytes: int = DEFAULT_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES
    transformation_agent_package_base: str = DEFAULT_TRANSFORMATION_AGENT_PACKAGE_BASE
    transformation_agent_java_version: str = DEFAULT_TRANSFORMATION_AGENT_JAVA_VERSION
    transformation_agent_runtime_library: str = DEFAULT_TRANSFORMATION_AGENT_RUNTIME_LIBRARY
    transformation_agent_w0_subset: tuple[str, ...] = DEFAULT_TRANSFORMATION_AGENT_W0_SUBSET


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
    model_gateway_model_id = os.environ.get(
        "ORCHESTRATOR_MODEL_GATEWAY_MODEL_ID",
        DEFAULT_MODEL_GATEWAY_MODEL_ID,
    ).strip()
    if not model_gateway_model_id:
        model_gateway_model_id = DEFAULT_MODEL_GATEWAY_MODEL_ID
    model_policy_version = os.environ.get(
        "ORCHESTRATOR_MODEL_POLICY_VERSION",
        DEFAULT_MODEL_POLICY_VERSION,
    ).strip()
    if not model_policy_version:
        model_policy_version = DEFAULT_MODEL_POLICY_VERSION
    harness_token = os.environ.get("ORCHESTRATOR_HARNESS_TOKEN", "").strip()

    experience_learning_base_url = os.environ.get(
        "ORCHESTRATOR_EXPERIENCE_LEARNING_BASE_URL",
        os.environ.get("C2C_EXPERIENCE_LEARNING_URL", DEFAULT_EXPERIENCE_LEARNING_BASE_URL),
    ).strip()

    # Issue #166: the W0.2 repair loop is bounded by a small, configurable
    # iteration limit. The environment variable is clamped to [1, 3] so a
    # mis-configured value cannot push the contract outside the W0.2 range.
    repair_budget_max_raw = _read_env_int(
        "ORCHESTRATOR_REPAIR_BUDGET_MAX",
        DEFAULT_REPAIR_BUDGET_MAX,
    )
    repair_budget_max = max(REPAIR_BUDGET_MIN, min(REPAIR_BUDGET_MAX, repair_budget_max_raw))

    run_artifact_root_raw = os.environ.get(
        "C2C_RUN_ARTIFACT_ROOT",
        os.environ.get("ORCHESTRATOR_RUN_ARTIFACT_ROOT", DEFAULT_RUN_ARTIFACT_ROOT),
    ).strip()
    if not run_artifact_root_raw:
        run_artifact_root_raw = DEFAULT_RUN_ARTIFACT_ROOT
    run_artifact_root = str(Path(run_artifact_root_raw).expanduser())

    if not parse_capability_id or not ir_capability_id or not generator_capability_id or not build_test_capability_id or not evidence_capability_id or not model_gateway_capability_id:
        raise ValueError("capability ids are required")

    w0_capabilities = _load_w0_capabilities(
        (
            parse_capability_id,
            ir_capability_id,
            generator_capability_id,
            build_test_capability_id,
            evidence_capability_id,
            model_gateway_capability_id,
        )
    )

    # Issue #169: optional environment overrides for the Transformation
    # Agent defaults. Empty strings fall back to the dataclass defaults.
    transformation_agent_prompt_template_id = (
        os.environ.get(
            "ORCHESTRATOR_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID",
            DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID,
        ).strip()
        or DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_ID
    )
    transformation_agent_prompt_template_version = (
        os.environ.get(
            "ORCHESTRATOR_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION",
            DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION,
        ).strip()
        or DEFAULT_TRANSFORMATION_AGENT_PROMPT_TEMPLATE_VERSION
    )
    transformation_agent_deadline_ms = _read_env_int(
        "ORCHESTRATOR_TRANSFORMATION_AGENT_DEADLINE_MS",
        DEFAULT_TRANSFORMATION_AGENT_DEADLINE_MS,
    )
    if transformation_agent_deadline_ms <= 0:
        transformation_agent_deadline_ms = DEFAULT_TRANSFORMATION_AGENT_DEADLINE_MS
    transformation_agent_max_output_bytes = _read_env_int(
        "ORCHESTRATOR_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES",
        DEFAULT_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES,
    )
    if transformation_agent_max_output_bytes <= 0:
        transformation_agent_max_output_bytes = DEFAULT_TRANSFORMATION_AGENT_MAX_OUTPUT_BYTES
    transformation_agent_package_base = (
        os.environ.get(
            "ORCHESTRATOR_TRANSFORMATION_AGENT_PACKAGE_BASE",
            DEFAULT_TRANSFORMATION_AGENT_PACKAGE_BASE,
        ).strip()
        or DEFAULT_TRANSFORMATION_AGENT_PACKAGE_BASE
    )
    transformation_agent_java_version = (
        os.environ.get(
            "ORCHESTRATOR_TRANSFORMATION_AGENT_JAVA_VERSION",
            DEFAULT_TRANSFORMATION_AGENT_JAVA_VERSION,
        ).strip()
        or DEFAULT_TRANSFORMATION_AGENT_JAVA_VERSION
    )
    transformation_agent_runtime_library = (
        os.environ.get(
            "ORCHESTRATOR_TRANSFORMATION_AGENT_RUNTIME_LIBRARY",
            DEFAULT_TRANSFORMATION_AGENT_RUNTIME_LIBRARY,
        ).strip()
        or DEFAULT_TRANSFORMATION_AGENT_RUNTIME_LIBRARY
    )

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
        w0_capabilities=w0_capabilities,
        harness_token=harness_token,
        model_gateway_model_id=model_gateway_model_id,
        model_policy_version=model_policy_version,
        run_artifact_root=run_artifact_root,
        experience_learning_base_url=experience_learning_base_url,
        repair_budget_max=repair_budget_max,
        transformation_agent_prompt_template_id=transformation_agent_prompt_template_id,
        transformation_agent_prompt_template_version=transformation_agent_prompt_template_version,
        transformation_agent_deadline_ms=transformation_agent_deadline_ms,
        transformation_agent_max_output_bytes=transformation_agent_max_output_bytes,
        transformation_agent_package_base=transformation_agent_package_base,
        transformation_agent_java_version=transformation_agent_java_version,
        transformation_agent_runtime_library=transformation_agent_runtime_library,
    )


def _load_w0_capabilities(required_ids: tuple[str, ...]) -> tuple[dict[str, Any], ...]:
    manifest = os.environ.get("ORCHESTRATOR_W0_CAPABILITIES")
    if manifest:
        return tuple(_parse_w0_capability_manifest(manifest))

    return _default_w0_capabilities_from_env(required_ids)


def _parse_w0_capability_manifest(raw: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("ORCHESTRATOR_W0_CAPABILITIES must be valid JSON") from exc
    if not isinstance(parsed, list):
        raise ValueError("ORCHESTRATOR_W0_CAPABILITIES must be a JSON array")
    manifest: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, Mapping):
            raise ValueError("ORCHESTRATOR_W0_CAPABILITIES entries must be objects")
        parsed_item = dict(item)
        if not isinstance(parsed_item.get("id"), str) or not parsed_item["id"].strip():
            raise ValueError("ORCHESTRATOR_W0_CAPABILITIES items require a non-empty id")
        manifest.append(parsed_item)
    if not manifest:
        raise ValueError("ORCHESTRATOR_W0_CAPABILITIES must include at least one capability")
    return manifest


def _default_w0_capabilities_from_env(required_ids: Iterable[str]) -> tuple[dict[str, Any], ...]:
    defaults = list(DEFAULT_W0_CAPABILITIES)
    endpoint_map = {
        DEFAULT_PARSE_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_PARSE_CAPABILITY_ENDPOINT",
            DEFAULT_W0_CAPABILITIES[0]["endpoint"],
        ).strip(),
        DEFAULT_IR_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_IR_CAPABILITY_ENDPOINT",
            DEFAULT_W0_CAPABILITIES[1]["endpoint"],
        ).strip(),
        DEFAULT_GENERATOR_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_GENERATOR_CAPABILITY_ENDPOINT",
            DEFAULT_W0_CAPABILITIES[2]["endpoint"],
        ).strip(),
        DEFAULT_BUILD_TEST_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_BUILD_TEST_CAPABILITY_ENDPOINT",
            DEFAULT_W0_CAPABILITIES[3]["endpoint"],
        ).strip(),
        DEFAULT_EVIDENCE_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_EVIDENCE_CAPABILITY_ENDPOINT",
            DEFAULT_W0_CAPABILITIES[4]["endpoint"],
        ).strip(),
        DEFAULT_MODEL_GATEWAY_CAPABILITY: os.environ.get(
            "ORCHESTRATOR_MODEL_GATEWAY_CAPABILITY_ENDPOINT",
            os.environ.get("ORCHESTRATOR_MODEL_GATEWAY_ENDPOINT", DEFAULT_W0_CAPABILITIES[5]["endpoint"]),
        ).strip(),
    }

    required_ids = set(id_value.strip() for id_value in required_ids if id_value)
    if not required_ids:
        return tuple(defaults)

    configured: list[dict[str, Any]] = []
    for capability in defaults:
        if capability["id"] not in required_ids:
            continue
        entry = dict(capability)
        entry["endpoint"] = endpoint_map.get(capability["id"], entry["endpoint"])
        entry["name"] = os.environ.get(
            f"ORCHESTRATOR_{entry['id'].replace('.', '_').replace('-', '_').upper()}_NAME",
            entry["name"],
        )
        entry["owner"] = os.environ.get(
            f"ORCHESTRATOR_{entry['id'].replace('.', '_').replace('-', '_').upper()}_OWNER",
            entry["owner"],
        )
        entry["policyProfile"] = os.environ.get(
            f"ORCHESTRATOR_{entry['id'].replace('.', '_').replace('-', '_').upper()}_POLICY_PROFILE",
            entry["policyProfile"],
        )
        entry["version"] = os.environ.get(
            f"ORCHESTRATOR_{entry['id'].replace('.', '_').replace('-', '_').upper()}_VERSION",
            entry["version"],
        )
        entry["description"] = os.environ.get(
            f"ORCHESTRATOR_{entry['id'].replace('.', '_').replace('-', '_').upper()}_DESCRIPTION",
            entry["description"],
        )
        configured.append(entry)
    return tuple(configured)
